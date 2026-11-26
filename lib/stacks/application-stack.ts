import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * Props accepted by ApplicationStack.
 *
 * SharedStack owns the stateful DynamoDB tables. It exposes them as ITable
 * references so this stack can grant permissions and read table names without
 * hard-coding ARNs. CDK resolves these as CloudFormation cross-stack imports.
 */
export interface ApplicationStackProps extends cdk.StackProps {
  orderTable: dynamodb.ITable;
  inventoryTable: dynamodb.ITable;
  paymentTable: dynamodb.ITable;
}

/**
 * ApplicationStack — stateless compute and integration layer.
 *
 * Contains the REST API, all Lambda handlers, and their wiring. This stack
 * can be torn down and redeployed without affecting the data in SharedStack.
 * It grows with each phase: Phase 2 adds API + CRUD Lambdas; later phases
 * add SQS, EventBridge, Step Functions, S3, SNS, etc.
 */
export class ApplicationStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    // paymentTable is accepted for future phases (Phase 7 — Step Functions).
    // Destructure only what Phase 2 needs right now.
    const { orderTable, inventoryTable } = props;

    // ──────────────────────────────────────────────────────────────────────
    // Shared Lambda configuration
    //
    // Every Lambda in this stack shares the same runtime, memory, timeout,
    // and environment variables. We define them once and spread into each
    // NodejsFunction. Individual handlers can override if needed.
    // ──────────────────────────────────────────────────────────────────────

    const handlersDir = path.join(__dirname, '..', '..', 'src', 'handlers');

    // Environment variables injected into every Lambda at deploy time.
    // Handlers read these at runtime (e.g. process.env.ORDER_TABLE_NAME)
    // so they never hard-code table names or ARNs.
    const sharedLambdaEnv: Record<string, string> = {
      ORDER_TABLE_NAME: orderTable.tableName,
      INVENTORY_TABLE_NAME: inventoryTable.tableName,
      ENVIRONMENT: 'dev',
      LOG_LEVEL: 'INFO',
    };

    // NodejsFunction uses esbuild under the hood to bundle each handler's
    // TypeScript source into a single minified JS file. This gives us:
    //   • Tree-shaking — only code the handler imports ends up in the bundle
    //   • Smaller package → faster cold starts
    //   • Source maps for readable stack traces in CloudWatch
    //
    // We externalize @aws-sdk/* because Lambda's Node.js 20 runtime already
    // ships AWS SDK v3 — bundling it again would waste package size.
    const sharedNodejsFnProps: Partial<lambda.FunctionProps> & { bundling: object } = {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,       // 256 MB — good balance for CRUD handlers
      timeout: cdk.Duration.seconds(30),
      environment: sharedLambdaEnv,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
    };

    // ──────────────────────────────────────────────────────────────────────
    // Order Lambda handlers
    //
    // Each handler is a separate NodejsFunction so it gets its own IAM role,
    // independent scaling, and isolated failure blast radius. CDK's
    // NodejsFunction automatically creates the IAM execution role, bundles
    // the TypeScript entry file, and uploads the asset to S3.
    // ──────────────────────────────────────────────────────────────────────

    // POST /orders — validates input (Zod), looks up product price from
    // Inventory table, creates the order in DynamoDB with status PENDING.
    const createOrderFn = new NodejsFunction(this, 'CreateOrderFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'orders', 'create.ts'),
      handler: 'handler',
      functionName: 'CreateOrder',
      description: 'POST /orders — create a new order',
    });

    // GET /orders/{orderId} — simple GetItem by partition key (orderId).
    const getOrderFn = new NodejsFunction(this, 'GetOrderFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'orders', 'get.ts'),
      handler: 'handler',
      functionName: 'GetOrder',
      description: 'GET /orders/{orderId} — retrieve an order',
    });

    // GET /orders?customerId=X — queries the customerId-index GSI to list
    // orders for a customer. Uses Query (not Scan) so it only reads
    // matching items — efficient even with millions of orders in the table.
    const listOrdersFn = new NodejsFunction(this, 'ListOrdersFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'orders', 'list.ts'),
      handler: 'handler',
      functionName: 'ListOrders',
      description: 'GET /orders?customerId=X — list orders by customer',
    });

    // PUT /orders/{orderId}/status — validates that the status transition
    // is allowed (e.g. PENDING→CONFIRMED ok, SHIPPED→PENDING not ok) and
    // uses a DynamoDB conditional write to prevent race conditions.
    const updateOrderStatusFn = new NodejsFunction(this, 'UpdateOrderStatusFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'orders', 'update-status.ts'),
      handler: 'handler',
      functionName: 'UpdateOrderStatus',
      description: 'PUT /orders/{orderId}/status — update order status',
    });

    // ──────────────────────────────────────────────────────────────────────
    // Inventory Lambda handlers
    // ──────────────────────────────────────────────────────────────────────

    // GET /inventory/{productId} — simple GetItem by partition key.
    const getInventoryFn = new NodejsFunction(this, 'GetInventoryFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'inventory', 'get.ts'),
      handler: 'handler',
      functionName: 'GetInventory',
      description: 'GET /inventory/{productId} — retrieve inventory item',
    });

    // PUT /inventory/{productId} — upsert (create or overwrite) an inventory
    // item. Used to seed test data and adjust stock/price.
    const updateInventoryFn = new NodejsFunction(this, 'UpdateInventoryFn', {
      ...sharedNodejsFnProps,
      entry: path.join(handlersDir, 'inventory', 'update.ts'),
      handler: 'handler',
      functionName: 'UpdateInventory',
      description: 'PUT /inventory/{productId} — upsert inventory item',
    });

    // ──────────────────────────────────────────────────────────────────────
    // Least-privilege IAM permissions
    //
    // CDK's grant* helpers generate scoped IAM policy statements under the
    // hood. Each Lambda gets only the DynamoDB actions it actually needs:
    //
    //   grantReadData     → dynamodb:GetItem, Query, Scan, BatchGetItem, etc.
    //   grantReadWriteData→ above + PutItem, UpdateItem, DeleteItem, BatchWriteItem
    //
    // This follows the principle of least privilege: if the GetOrder Lambda
    // is compromised, it cannot write to or delete from any table.
    // ──────────────────────────────────────────────────────────────────────

    // CreateOrder needs to write the new order AND read inventory for price lookup
    orderTable.grantReadWriteData(createOrderFn);
    inventoryTable.grantReadData(createOrderFn);

    // Read-only access — these handlers never write
    orderTable.grantReadData(getOrderFn);
    orderTable.grantReadData(listOrdersFn);

    // UpdateOrderStatus reads the current status (to validate transition)
    // then writes the new status
    orderTable.grantReadWriteData(updateOrderStatusFn);

    // Inventory read vs read-write
    inventoryTable.grantReadData(getInventoryFn);
    inventoryTable.grantReadWriteData(updateInventoryFn);

    // ──────────────────────────────────────────────────────────────────────
    // REST API Gateway
    //
    // API Gateway is the "front door" for all HTTP traffic. It handles:
    //   • Routing (path + method → Lambda)
    //   • Request validation (reject malformed bodies before Lambda runs)
    //   • Throttling (protect downstream services and control costs)
    //   • CORS (required for browser-based clients)
    //
    // We use proxy integration: API Gateway passes the full HTTP request
    // as the Lambda event and returns the Lambda response as-is. The Lambda
    // handler is responsible for the response shape ({ statusCode, body }).
    // ──────────────────────────────────────────────────────────────────────

    this.api = new apigateway.RestApi(this, 'OrderManagementApi', {
      restApiName: 'Order Management API',
      description: 'REST API for Order Management System (Phase 2)',
      deployOptions: {
        stageName: 'dev',
        // Stage-level throttling prevents runaway costs and protects Lambdas.
        // 100 sustained req/s with burst to 200 is generous for a POC.
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
      // CORS preflight: API Gateway auto-creates OPTIONS methods on every
      // resource that respond with the allowed origins/methods/headers.
      // Required for any browser-based client (React, Vue, etc.).
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,   // Tighten in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // ──────────────────────────────────────────────────────────────────────
    // Request validation — two-layer strategy
    //
    // Layer 1 (here): API Gateway JSON Schema models validate structure
    //   before the Lambda is invoked. If the body is malformed, API Gateway
    //   returns 400 immediately — no Lambda invocation, no cost.
    //
    // Layer 2 (in handlers): Zod schemas validate business rules that JSON
    //   Schema can't express (e.g. "productId must exist in inventory",
    //   "status transition must be allowed").
    //
    // Together they give fast rejection of junk requests + deep business
    // validation where it matters.
    // ──────────────────────────────────────────────────────────────────────

    // This validator checks the request body against the model schema.
    // Reused by all POST/PUT methods that accept a JSON body.
    const requestValidator = new apigateway.RequestValidator(this, 'BodyValidator', {
      restApi: this.api,
      requestValidatorName: 'validate-request-body',
      validateRequestBody: true,
      validateRequestParameters: false,
    });

    // CreateOrder model: productId (non-empty string) and quantity (integer >= 1) are required.
    // customerId is optional here — Phase 3 (Cognito) will extract it from the JWT token instead.
    const createOrderModel = new apigateway.Model(this, 'CreateOrderModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'CreateOrderRequest',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['productId', 'quantity'],
        properties: {
          productId: { type: apigateway.JsonSchemaType.STRING, minLength: 1 },
          quantity: { type: apigateway.JsonSchemaType.INTEGER, minimum: 1 },
          customerId: { type: apigateway.JsonSchemaType.STRING },
        },
      },
    });

    // UpdateOrderStatus model: status must be one of the four valid values.
    // The handler further validates that the transition is allowed (e.g. SHIPPED → PENDING is rejected).
    const updateOrderStatusModel = new apigateway.Model(this, 'UpdateOrderStatusModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'UpdateOrderStatusRequest',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['status'],
        properties: {
          status: {
            type: apigateway.JsonSchemaType.STRING,
            enum: ['PENDING', 'CONFIRMED', 'SHIPPED', 'CANCELLED'],
          },
        },
      },
    });

    // UpdateInventory model: all three fields required for a complete upsert.
    // price must be > 0 (exclusiveMinimum: true with minimum: 0 means "greater than zero").
    const updateInventoryModel = new apigateway.Model(this, 'UpdateInventoryModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'UpdateInventoryRequest',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['productName', 'quantity', 'price'],
        properties: {
          productName: { type: apigateway.JsonSchemaType.STRING, minLength: 1 },
          quantity: { type: apigateway.JsonSchemaType.INTEGER, minimum: 0 },
          price: { type: apigateway.JsonSchemaType.NUMBER, minimum: 0, exclusiveMinimum: true },
        },
      },
    });

    // ──────────────────────────────────────────────────────────────────────
    // API routes
    //
    // Each addMethod() call wires an HTTP method on a resource path to a
    // Lambda function via LambdaIntegration (proxy mode). API Gateway
    // passes the entire HTTP request as the event object and returns the
    // Lambda's { statusCode, headers, body } response directly to the client.
    //
    // Route structure:
    //   POST   /orders                    → CreateOrder
    //   GET    /orders?customerId=X       → ListOrders
    //   GET    /orders/{orderId}          → GetOrder
    //   PUT    /orders/{orderId}/status   → UpdateOrderStatus
    //   GET    /inventory/{productId}     → GetInventory
    //   PUT    /inventory/{productId}     → UpdateInventory
    // ──────────────────────────────────────────────────────────────────────

    // /orders — collection resource
    const ordersResource = this.api.root.addResource('orders');

    // POST /orders — body validated by createOrderModel before Lambda runs
    ordersResource.addMethod('POST', new apigateway.LambdaIntegration(createOrderFn), {
      requestValidator,
      requestModels: { 'application/json': createOrderModel },
    });

    // GET /orders?customerId=X — requires customerId query parameter.
    // A separate validator checks query params (not body) so API Gateway
    // returns 400 if customerId is missing, before Lambda is invoked.
    ordersResource.addMethod('GET', new apigateway.LambdaIntegration(listOrdersFn), {
      requestParameters: { 'method.request.querystring.customerId': true },
      requestValidator: new apigateway.RequestValidator(this, 'QueryStringValidator', {
        restApi: this.api,
        requestValidatorName: 'validate-query-params',
        validateRequestParameters: true,
        validateRequestBody: false,
      }),
    });

    // /orders/{orderId} — single-order resource; {orderId} is a path parameter
    // that API Gateway extracts and passes in event.pathParameters.orderId
    const orderIdResource = ordersResource.addResource('{orderId}');

    // GET /orders/{orderId} — no body validation needed for GET
    orderIdResource.addMethod('GET', new apigateway.LambdaIntegration(getOrderFn));

    // /orders/{orderId}/status — sub-resource for status updates.
    // Using a sub-resource (not PATCH on the order) makes the intent explicit
    // and lets us apply a specific request model just for status changes.
    const orderStatusResource = orderIdResource.addResource('status');

    // PUT /orders/{orderId}/status — body validated by updateOrderStatusModel
    orderStatusResource.addMethod('PUT', new apigateway.LambdaIntegration(updateOrderStatusFn), {
      requestValidator,
      requestModels: { 'application/json': updateOrderStatusModel },
    });

    // /inventory — collection resource (no GET on collection; we only support per-product access)
    const inventoryResource = this.api.root.addResource('inventory');

    // /inventory/{productId} — single-product resource
    const productIdResource = inventoryResource.addResource('{productId}');

    // GET /inventory/{productId} — no body validation needed
    productIdResource.addMethod('GET', new apigateway.LambdaIntegration(getInventoryFn));

    // PUT /inventory/{productId} — body validated by updateInventoryModel
    productIdResource.addMethod('PUT', new apigateway.LambdaIntegration(updateInventoryFn), {
      requestValidator,
      requestModels: { 'application/json': updateInventoryModel },
    });

    // ──────────────────────────────────────────────────────────────────────
    // Outputs
    //
    // The API URL is exported so it can be:
    //   • Used by the CI/CD pipeline for integration tests
    //   • Referenced by other stacks or scripts
    //   • Printed after `cdk deploy` for quick manual testing with curl
    // ──────────────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'REST API base URL',
      exportName: 'ApiUrl',
    });
  }
}
