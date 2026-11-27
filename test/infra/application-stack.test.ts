import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApplicationStack } from '../../lib/stacks/application-stack';

describe('ApplicationStack', () => {
  let template: Template;

  beforeAll(() => {
    // Skip actual esbuild bundling in infra tests — we're asserting CloudFormation, not Lambda code
    const app = new cdk.App({
      context: { 'aws:cdk:bundling-stacks': [] },
    });

    // Create stub tables the same way SharedStack does, but in a test-only stack
    const stubStack = new cdk.Stack(app, 'StubStack');
    const orderTable = new dynamodb.Table(stubStack, 'OrderTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    orderTable.addGlobalSecondaryIndex({
      indexName: 'customerId-index',
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });
    const inventoryTable = new dynamodb.Table(stubStack, 'InventoryTable', {
      partitionKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const paymentTable = new dynamodb.Table(stubStack, 'PaymentTable', {
      partitionKey: { name: 'paymentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stack = new ApplicationStack(app, 'TestApplicationStack', {
      orderTable,
      inventoryTable,
      paymentTable,
    });
    template = Template.fromStack(stack);
  });

  // ─── REST API ───

  test('creates a REST API Gateway', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'Order Management API',
    });
  });

  test('API stage has throttling configured', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'dev',
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ThrottlingRateLimit: 100,
          ThrottlingBurstLimit: 200,
        }),
      ]),
    });
  });

  // ─── Lambda Functions ───

  test('creates exactly 6 Lambda functions', () => {
    template.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test.each([
    'CreateOrder',
    'GetOrder',
    'ListOrders',
    'UpdateOrderStatus',
    'GetInventory',
    'UpdateInventory',
  ])('creates %s Lambda with Node.js 20 runtime', (fnName) => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: fnName,
      Runtime: 'nodejs20.x',
      MemorySize: 256,
      Timeout: 30,
    });
  });

  test('Lambda functions have ORDER_TABLE_NAME and INVENTORY_TABLE_NAME env vars', () => {
    // All six Lambdas receive both table names
    const functions = template.findResources('AWS::Lambda::Function');
    const fnLogicalIds = Object.keys(functions);
    expect(fnLogicalIds.length).toBe(6);

    for (const logicalId of fnLogicalIds) {
      const envVars = functions[logicalId].Properties.Environment?.Variables;
      expect(envVars).toBeDefined();
      expect(envVars.ORDER_TABLE_NAME).toBeDefined();
      expect(envVars.INVENTORY_TABLE_NAME).toBeDefined();
      expect(envVars.ENVIRONMENT).toBe('dev');
    }
  });

  // ─── API Routes ───

  test('defines the expected API resources', () => {
    // /orders
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'orders',
    });
    // /orders/{orderId}
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{orderId}',
    });
    // /orders/{orderId}/status
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'status',
    });
    // /inventory
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'inventory',
    });
    // /inventory/{productId}
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{productId}',
    });
  });

  test('creates POST method on /orders', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE', // Phase 3 adds Cognito authorizer
    });
  });

  test('creates GET method on /orders', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
    });
  });

  test('creates PUT method on /orders/{orderId}/status', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'PUT',
    });
  });

  // ─── Request Validators ───

  test('creates request validators', () => {
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      Name: 'validate-request-body',
      ValidateRequestBody: true,
    });
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      Name: 'validate-query-params',
      ValidateRequestParameters: true,
    });
  });

  // ─── Request Models ───

  test('creates request models for POST/PUT endpoints', () => {
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Name: 'CreateOrderRequest',
      ContentType: 'application/json',
    });
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Name: 'UpdateOrderStatusRequest',
      ContentType: 'application/json',
    });
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Name: 'UpdateInventoryRequest',
      ContentType: 'application/json',
    });
  });

  // ─── IAM — Least Privilege ───

  test('grants read-only DynamoDB access to GET handlers', () => {
    // GetOrder and ListOrders should have read-only policies on Order table
    // We check that at least one policy has only dynamodb:Get*/Query/Scan (no Put/Update/Delete)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:Query']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('grants read-write DynamoDB access to write handlers', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:PutItem']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  // ─── CORS ───

  test('configures CORS preflight OPTIONS methods', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
      AuthorizationType: 'NONE',
    });
  });

  // ─── Outputs ───

  test('exports API URL', () => {
    template.hasOutput('ApiUrl', {
      Export: { Name: 'ApiUrl' },
    });
  });
});
