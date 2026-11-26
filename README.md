# AWS Serverless POC — Order Management System

Step-by-step guide to build a serverless Order Management System on AWS using CDK (TypeScript).  
Each phase is a self-contained set of instructions you can follow manually.

**Prerequisites:**
- Node.js 20+
- pnpm (`npm install -g pnpm`)
- AWS CLI configured with credentials (`aws configure`) — region: `eu-west-1`
- AWS CDK CLI (`pnpm add -g aws-cdk`)
- CDK bootstrapped in your account (see Step 1.10)

---

## Phase 1 — Project Setup, CDK Foundation & DynamoDB

**Goal:** Initialize CDK project, deploy 3 DynamoDB tables (Orders, Inventory, Payments) with GSIs, create shared utility code.

### Step 1.1 — Initialize the project

```bash
mkdir aws-serverless-poc && cd aws-serverless-poc
pnpm init
```

### Step 1.2 — Install dependencies

```bash
# CDK & constructs
pnpm add aws-cdk-lib constructs

# Lambda runtime dependencies
pnpm add @aws-lambda-powertools/logger @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb uuid zod

# Dev dependencies
pnpm add -D typescript ts-node ts-jest jest @types/jest @types/node @types/uuid aws-cdk esbuild
```

### Step 1.3 — Create configuration files

**tsconfig.json** — TypeScript compiler config for CDK code (not Lambda handlers — esbuild handles those):
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitReturns": true,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "outDir": "./cdk.out/ts",
    "rootDir": ".",
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "cdk.out", "src/**/*.ts"]
}
```
> `src/` is excluded because Lambda code is bundled by esbuild at deploy time, not compiled by tsc.

**cdk.json** — CDK entry point and feature flags:
```jsonc
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/core:target-partitions": ["aws"],
    "@aws-cdk/aws-iam:minimizePolicies": true,
    "@aws-cdk/core:validateSnapshotRemovalPolicy": true,
    "@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy": true,
    "@aws-cdk/core:bootstrapQualifier": "poc2026"
  }
}
```

**jest.config.ts** — Test runner config:
```ts
import type { Config } from 'jest';
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
};
export default config;
```

**package.json scripts** — Add these scripts:
```jsonc
{
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "cdk": "cdk"
  }
}
```

**.gitignore:**
```
node_modules/
cdk.out/
*.js
*.d.ts
*.js.map
!jest.config.ts
.env
.env.local
```

### Step 1.4 — Create the folder structure

```bash
mkdir -p bin lib/stacks lib/constructs
mkdir -p src/handlers/orders src/handlers/inventory src/handlers/payments
mkdir -p src/handlers/async src/handlers/streams src/handlers/import src/handlers/scheduled
mkdir -p src/shared src/types
mkdir -p test/unit test/infra
```

### Step 1.5 — Create TypeScript type definitions

**src/types/order.ts:**
```ts
export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: [],
  CANCELLED: [],
};

export interface Order {
  orderId: string;
  customerId: string;
  productId: string;
  quantity: number;
  status: OrderStatus;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderInput {
  productId: string;
  quantity: number;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus;
}
```

**src/types/inventory.ts:**
```ts
export interface Inventory {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  updatedAt: string;
}

export interface UpdateInventoryInput {
  productName: string;
  quantity: number;
  price: number;
}
```

**src/types/payment.ts:**
```ts
export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Payment {
  paymentId: string;
  orderId: string;
  amount: number;
  status: PaymentStatus;
  createdAt: string;
}
```

### Step 1.6 — Create shared utility modules

**src/shared/dynamo-client.ts** — Singleton DynamoDB Document Client (initialized once per cold start, reused across invocations):
```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

export const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});
```

**src/shared/logger.ts** — Powertools structured logger factory:
```ts
import { Logger } from '@aws-lambda-powertools/logger';

export function createLogger(serviceName: string): Logger {
  return new Logger({
    serviceName,
    logLevel: process.env.LOG_LEVEL || 'INFO',
    persistentLogAttributes: {
      environment: process.env.ENVIRONMENT || 'dev',
    },
  });
}
```

**src/shared/response.ts** — Consistent API Gateway response builder:
```ts
import type { APIGatewayProxyResult } from 'aws-lambda';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function success(body: Record<string, unknown> | unknown[], statusCode = 200): APIGatewayProxyResult {
  return { statusCode, headers: DEFAULT_HEADERS, body: JSON.stringify(body) };
}

export function created(body: Record<string, unknown>): APIGatewayProxyResult {
  return success(body, 201);
}

export function error(statusCode: number, message: string, requestId?: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ statusCode, message, ...(requestId && { requestId }) }),
  };
}

export function badRequest(message: string, requestId?: string): APIGatewayProxyResult {
  return error(400, message, requestId);
}

export function notFound(message: string, requestId?: string): APIGatewayProxyResult {
  return error(404, message, requestId);
}

export function serverError(message = 'Internal server error', requestId?: string): APIGatewayProxyResult {
  return error(500, message, requestId);
}
```

**src/shared/validator.ts** — Zod schemas for input validation:
```ts
import { z } from 'zod';
import { ORDER_STATUSES } from '../types/order';

export const createOrderSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  quantity: z.number().int().positive('quantity must be a positive integer'),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, {
    errorMap: () => ({ message: `status must be one of: ${ORDER_STATUSES.join(', ')}` }),
  }),
});

export const updateInventorySchema = z.object({
  productName: z.string().min(1, 'productName is required'),
  quantity: z.number().int().min(0, 'quantity must be non-negative'),
  price: z.number().positive('price must be positive'),
});

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw new ValidationError(messages.join('; '));
  }
  return result.data;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
```

### Step 1.7 — Create the SharedStack (DynamoDB tables)

**lib/stacks/shared-stack.ts:**
```ts
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class SharedStack extends cdk.Stack {
  public readonly orderTable: dynamodb.Table;
  public readonly inventoryTable: dynamodb.Table;
  public readonly paymentTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Order Table ──
    this.orderTable = new dynamodb.Table(this, 'OrderTable', {
      tableName: 'Orders',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES, // For Phase 5
    });

    this.orderTable.addGlobalSecondaryIndex({
      indexName: 'customerId-index',
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.orderTable.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Inventory Table ──
    this.inventoryTable = new dynamodb.Table(this, 'InventoryTable', {
      tableName: 'Inventory',
      partitionKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    // ── Payment Table ──
    this.paymentTable = new dynamodb.Table(this, 'PaymentTable', {
      tableName: 'Payments',
      partitionKey: { name: 'paymentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
    });

    this.paymentTable.addGlobalSecondaryIndex({
      indexName: 'orderId-index',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Cross-stack exports (ApplicationStack imports these in Phase 2) ──
    new cdk.CfnOutput(this, 'OrderTableName', { value: this.orderTable.tableName, exportName: 'OrderTableName' });
    new cdk.CfnOutput(this, 'OrderTableArn', { value: this.orderTable.tableArn, exportName: 'OrderTableArn' });
    new cdk.CfnOutput(this, 'InventoryTableName', { value: this.inventoryTable.tableName, exportName: 'InventoryTableName' });
    new cdk.CfnOutput(this, 'InventoryTableArn', { value: this.inventoryTable.tableArn, exportName: 'InventoryTableArn' });
    new cdk.CfnOutput(this, 'PaymentTableName', { value: this.paymentTable.tableName, exportName: 'PaymentTableName' });
    new cdk.CfnOutput(this, 'PaymentTableArn', { value: this.paymentTable.tableArn, exportName: 'PaymentTableArn' });
  }
}
```

### Step 1.8 — Create the CDK app entry point

**bin/app.ts:**
```ts
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedStack } from '../lib/stacks/shared-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-west-1',
};

new SharedStack(app, 'SharedStack', {
  env,
  description: 'Order Management System — DynamoDB tables and shared stateful resources',
});
```

### Step 1.9 — Write CDK assertion tests

**test/infra/shared-stack.test.ts:**
```ts
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SharedStack } from '../../lib/stacks/shared-stack';

describe('SharedStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new SharedStack(app, 'TestSharedStack');
    template = Template.fromStack(stack);
  });

  test('creates exactly 3 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
  });

  test('Order table has correct key schema and billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('Order table has customerId-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'customerId-index',
          KeySchema: [
            { AttributeName: 'customerId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('Order table has status-createdAt-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'status-createdAt-index',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('Order table has DynamoDB Streams enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  test('Inventory table has correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Inventory',
      KeySchema: [{ AttributeName: 'productId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('Payment table has correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Payments',
      KeySchema: [{ AttributeName: 'paymentId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('Payment table has orderId-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Payments',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'orderId-index',
          KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  test('all tables have DeletionPolicy Delete (POC)', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const name of Object.keys(tables)) {
      expect(tables[name].DeletionPolicy).toBe('Delete');
    }
  });

  test('exports table names and ARNs', () => {
    template.hasOutput('OrderTableName', { Export: { Name: 'OrderTableName' } });
    template.hasOutput('OrderTableArn', { Export: { Name: 'OrderTableArn' } });
    template.hasOutput('InventoryTableName', { Export: { Name: 'InventoryTableName' } });
    template.hasOutput('InventoryTableArn', { Export: { Name: 'InventoryTableArn' } });
    template.hasOutput('PaymentTableName', { Export: { Name: 'PaymentTableName' } });
    template.hasOutput('PaymentTableArn', { Export: { Name: 'PaymentTableArn' } });
  });
});
```

### Step 1.10 — Bootstrap CDK (one-time setup per account/region)

CDK requires a one-time bootstrap to provision resources it needs for deployments (S3 bucket, IAM roles, SSM parameters, etc.).

This project uses a custom bootstrap qualifier (`poc2026`) to avoid conflicts with existing bootstrap resources in the account. The qualifier is configured in `cdk.json` under `@aws-cdk/core:bootstrapQualifier`.

```bash
pnpm cdk bootstrap aws://ACCOUNT_ID/eu-west-1 --qualifier poc2026
```
Replace `ACCOUNT_ID` with your AWS account number. You can find it with `aws sts get-caller-identity --query Account --output text`.

> This only needs to be run once per account/region combination. If already bootstrapped, it will update to the latest bootstrap template.

### Step 1.11 — Build, test, synthesize, deploy

```bash
# Build CDK code
pnpm run build

# Run tests
pnpm test

# Synthesize CloudFormation template (verify no errors)
pnpm cdk synth

# Review what will be created
pnpm cdk diff SharedStack

# CDK deploys your infrastructure using CloudFormation, but it needs some supporting resources in your AWS accoun
pnpm cdk bootstrap 

# Deploy to AWS
pnpm cdk deploy SharedStack

# Verify in AWS Console
aws dynamodb list-tables --region eu-west-1
# Expected output: Orders, Inventory, Payments
```

### Phase 1 — Verification checklist

- [ ] `pnpm test` — all tests pass
- [ ] `pnpm cdk synth` — generates cdk.out/SharedStack.template.json without errors
- [ ] `pnpm cdk deploy SharedStack` — deploys successfully
- [ ] `aws dynamodb describe-table --table-name Orders --region eu-west-1` — table exists with 2 GSIs
- [ ] `aws dynamodb describe-table --table-name Inventory --region eu-west-1` — table exists
- [ ] `aws dynamodb describe-table --table-name Payments --region eu-west-1` — table exists with 1 GSI

---

## Phase 2 — API Gateway + Lambda + DynamoDB (Sync CRUD)

**Goal:** Build REST API with 6 Lambda handlers for Order and Inventory CRUD. Proper validation, error handling, structured logging.

### Step 2.1 — Install additional dev dependency

```bash
pnpm add -D @types/aws-lambda
```

### Step 2.2 — Create Lambda handlers

**src/handlers/orders/create.ts** — `POST /orders`:
- Parse and validate body with `createOrderSchema`
- Look up product in Inventory table to get price
- Generate UUID for orderId, set status = `PENDING`, calculate totalAmount = price × quantity
- Write to Orders table
- Return 201 with the created order

**src/handlers/orders/get.ts** — `GET /orders/{orderId}`:
- Read `orderId` from `event.pathParameters`
- GetItem from Orders table
- Return 404 if not found, 200 with order if found

**src/handlers/orders/list.ts** — `GET /orders?customerId=X`:
- Read `customerId` from `event.queryStringParameters`
- Query `customerId-index` GSI (not a table scan)
- Return 200 with array of orders

**src/handlers/orders/update-status.ts** — `PUT /orders/{orderId}/status`:
- Validate body with `updateOrderStatusSchema`
- GetItem to fetch current order
- Validate status transition using `STATUS_TRANSITIONS` map
- UpdateItem with new status and updatedAt
- Return 200 with updated order

**src/handlers/inventory/get.ts** — `GET /inventory/{productId}`:
- GetItem from Inventory table
- Return 404 if not found

**src/handlers/inventory/update.ts** — `PUT /inventory/{productId}`:
- Validate body with `updateInventorySchema`
- PutItem to Inventory table (upsert)
- Return 200 with the inventory item

**Pattern for every handler:**
```ts
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createLogger } from '../../shared/logger';
import { success, badRequest, notFound, serverError } from '../../shared/response';
import { docClient } from '../../shared/dynamo-client';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

const logger = createLogger('order-service');      // Outside handler = cold start init
const TABLE_NAME = process.env.ORDER_TABLE_NAME!;  // Set by CDK

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  logger.addContext(event);  // Adds requestId, path, etc.
  try {
    // ... business logic
    return success({ ... });
  } catch (err) {
    logger.error('Unexpected error', err as Error);
    return serverError();
  }
}
```

### Step 2.3 — Create the ApplicationStack

**lib/stacks/application-stack.ts:**
- Accept SharedStack's tables as props (cross-stack reference)
- Create REST API Gateway with `defaultCorsPreflightOptions`
- Create a `NodejsFunction` for each handler with:
  - `runtime: Runtime.NODEJS_20_X`
  - `handler: 'handler'`
  - `entry: path.join(__dirname, '../../src/handlers/orders/create.ts')`
  - `environment: { ORDER_TABLE_NAME: props.orderTable.tableName, ... }`
  - `bundling: { minify: true, sourceMap: true }` (esbuild)
- Wire routes: `api.root.addResource('orders').addMethod('POST', new LambdaIntegration(createOrderFn))`
- Grant permissions: `orderTable.grantReadWriteData(createOrderFn)` / `grantReadData(getOrderFn)`
- Set stage throttling: `deployOptions: { throttlingRateLimit: 100, throttlingBurstLimit: 200 }`

### Step 2.4 — Update bin/app.ts

```ts
import { ApplicationStack } from '../lib/stacks/application-stack';

const sharedStack = new SharedStack(app, 'SharedStack', { env, ... });

new ApplicationStack(app, 'ApplicationStack', {
  env,
  orderTable: sharedStack.orderTable,
  inventoryTable: sharedStack.inventoryTable,
  paymentTable: sharedStack.paymentTable,
});
```

### Step 2.5 — Write tests

- **test/unit/\*.test.ts** — Unit tests for each handler. Mock DynamoDB with `jest.mock`.
- **test/infra/application-stack.test.ts** — CDK assertion tests: API resource count, Lambda count, IAM policies.

### Step 2.6 — Deploy and test

```bash
pnpm run build
pnpm test
pnpm cdk deploy --all

# Test with curl
API_URL=$(aws cloudformation describe-stacks --stack-name ApplicationStack --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text --region eu-west-1)

# Seed inventory
curl -X PUT "$API_URL/inventory/prod-1" \
  -H "Content-Type: application/json" \
  -d '{"productName":"Widget","quantity":100,"price":9.99}'

# Create order
curl -X POST "$API_URL/orders" \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","quantity":2}'

# Get order
curl "$API_URL/orders/{orderId-from-above}"

# List orders by customer
curl "$API_URL/orders?customerId={customerId}"

# Update status
curl -X PUT "$API_URL/orders/{orderId}/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"CONFIRMED"}'
```

### Phase 2 — Verification checklist

- [ ] All 6 endpoints return expected responses
- [ ] Invalid input returns 400 with descriptive message
- [ ] Invalid status transition returns 400
- [ ] Non-existent orderId returns 404
- [ ] CloudWatch Logs show structured JSON (Powertools format)
- [ ] `pnpm test` passes for unit tests and CDK tests

### Viewing Lambda logs in CloudWatch

Each Lambda function writes structured JSON logs (via Powertools Logger) to its own CloudWatch Log Group. Here's how to find and read them.

**Log group naming convention:**

| Log group | Handler |
|---|---|
| `/aws/lambda/CreateOrder` | POST /orders |
| `/aws/lambda/GetOrder` | GET /orders/{orderId} |
| `/aws/lambda/ListOrders` | GET /orders?customerId=X |
| `/aws/lambda/UpdateOrderStatus` | PUT /orders/{orderId}/status |
| `/aws/lambda/GetInventory` | GET /inventory/{productId} |
| `/aws/lambda/UpdateInventory` | PUT /inventory/{productId} |

**Via AWS Console:**
1. Go to **CloudWatch** → **Logs** → **Log groups** (make sure you're in `eu-west-1`)
2. Search for `/aws/lambda/CreateOrder` (or whichever handler)
3. Click the **latest log stream** — most recent invocations are at the top
4. Each log entry is structured JSON from Powertools with fields like `service`, `message`, `requestId`, `orderId`, `customerId`, `cold_start`, etc.

**Filtering across all streams in a log group:**

Click **Search all log streams** and use CloudWatch filter patterns:
```
{ $.message = "Order created" }
{ $.orderId = "a1cf9b1e-b8fb-433a-b63f-0411ce7403f7" }
{ $.level = "ERROR" }
```

**Via CLI (real-time tail):**
```bash
aws logs tail /aws/lambda/ListOrders --region eu-west-1 --follow
```
The `--follow` flag streams new logs as they arrive — useful while testing endpoints in another terminal.

**Understanding log stream names:**

Log streams are named like:
```
2026/11/26/[$LATEST]29ac3c0e85b94ebb9010e5795a1a4ac3
```

The format is `YYYY/MM/DD/[version]/random-id`:
- **`[$LATEST]`** — the current deployed code (unpublished version). This is the default when deploying with CDK and is expected for this POC.
- **`[1]`, `[2]`, etc.** — would appear if you publish numbered Lambda versions (used for canary deployments, weighted traffic shifting, rollbacks). Not needed until production deployment strategies.

Each execution environment (container) gets its own log stream. If Lambda scales to 3 concurrent instances, you'll see 3 streams for the same date. This is normal — Lambda creates a new execution environment for each concurrent invocation.

### Testing endpoints on Windows (PowerShell)

The curl examples in this README use bash syntax. On Windows PowerShell, use `curl.exe` (not `curl`, which is an alias for `Invoke-WebRequest`) and backtick for line continuation:

```powershell
$API_URL = "https://<api-id>.execute-api.eu-west-1.amazonaws.com/dev"

# Seed inventory
curl.exe -X PUT "$API_URL/inventory/prod-1" `
  -H "Content-Type: application/json" `
  -d "{""productName"":""Widget"",""quantity"":100,""price"":9.99}"

# Create order
curl.exe -X POST "$API_URL/orders" `
  -H "Content-Type: application/json" `
  -d "{""productId"":""prod-1"",""quantity"":2}"

# List orders
curl.exe "$API_URL/orders?customerId=anonymous"
```

Or use `Invoke-RestMethod` which handles JSON more naturally:
```powershell
Invoke-RestMethod -Method PUT -Uri "$API_URL/inventory/prod-1" `
  -ContentType "application/json" `
  -Body '{"productName":"Widget","quantity":100,"price":9.99}'
```

> **Tip:** Postman works well on Windows and avoids all PowerShell quoting issues. Import the API URL and test endpoints with a GUI.

---

## Phase 3 — Cognito Authentication & Authorization

**Goal:** Add Cognito User Pool, protect API with JWT authorizer, extract user identity from token.

### Step 3.1 — Add Cognito User Pool to SharedStack

In `lib/stacks/shared-stack.ts`, add:
```ts
import * as cognito from 'aws-cdk-lib/aws-cognito';

this.userPool = new cognito.UserPool(this, 'UserPool', {
  userPoolName: 'order-management-users',
  selfSignUpEnabled: true,
  signInAliases: { email: true },
  autoVerify: { email: true },
  passwordPolicy: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireDigits: true,
  },
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

this.userPoolClient = this.userPool.addClient('AppClient', {
  authFlows: { userPassword: true, userSrp: true },
  generateSecret: false,
});
```

Export the User Pool ID and Client ID as `CfnOutput`.

### Step 3.2 — Add JWT authorizer to ApplicationStack

```ts
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', {
  cognitoUserPools: [props.userPool],
});

// Add to each method (except health check):
ordersResource.addMethod('POST', new LambdaIntegration(createOrderFn), {
  authorizer,
  authorizationType: apigateway.AuthorizationType.COGNITO,
});
```

### Step 3.3 — Update Lambda handlers

- Extract `customerId` from `event.requestContext.authorizer?.claims?.sub` instead of request body
- `POST /orders` ignores any `customerId` in body — always uses JWT `sub`
- `GET /orders` filters by the authenticated user's `sub` claim
- Add `GET /health` endpoint with no auth (health check)

### Step 3.4 — Test the auth flow

```bash
USER_POOL_ID="<from stack output>"
CLIENT_ID="<from stack output>"

# Sign up
aws cognito-idp sign-up \
  --client-id $CLIENT_ID \
  --username user@example.com \
  --password "MyP@ssw0rd" \
  --region eu-west-1

# Confirm (check email for code, or use admin-confirm for testing)
aws cognito-idp admin-confirm-sign-up \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --region eu-west-1

# Sign in
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id $CLIENT_ID \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=user@example.com,PASSWORD="MyP@ssw0rd" \
  --region eu-west-1 \
  --query 'AuthenticationResult.AccessToken' --output text)

# Call API with token
curl -H "Authorization: Bearer $TOKEN" "$API_URL/orders"

# Call API without token → expect 401
curl "$API_URL/orders"
```

### Phase 3 — Verification checklist

- [ ] Sign up, confirm, sign in flow works via CLI
- [ ] API calls with valid token return 200
- [ ] API calls without token return 401
- [ ] `POST /orders` uses JWT `sub` as customerId (not from body)
- [ ] `GET /orders` only returns the authenticated user's orders
- [ ] `GET /health` works without auth

---

## Phase 4 — SQS Async Processing (Notification Delivery)

**Goal:** When order status changes, send a message to SQS. A consumer Lambda processes notifications asynchronously with idempotency.

### Step 4.1 — Install Powertools idempotency

```bash
pnpm add @aws-lambda-powertools/idempotency
```

### Step 4.2 — Create SQS queues in ApplicationStack

```ts
import * as sqs from 'aws-cdk-lib/aws-sqs';

// Dead letter queue
const notificationDlq = new sqs.Queue(this, 'NotificationDLQ', {
  queueName: 'order-notification-dlq',
  retentionPeriod: cdk.Duration.days(14),
});

// Main queue
const notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
  queueName: 'order-notification-queue',
  visibilityTimeout: cdk.Duration.seconds(180), // 6× Lambda timeout (30s)
  deadLetterQueue: { queue: notificationDlq, maxReceiveCount: 3 },
});
```

### Step 4.3 — Create notification-sender Lambda

**src/handlers/async/notification-sender.ts:**
- Triggered by SQS event source mapping
- For each record: parse message, check idempotency key (`notificationId`), log notification details
- For now, just log — SES integration comes in Phase 6
- Use `reportBatchItemFailures` to handle partial batch failures

CDK wiring:
```ts
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

notificationFn.addEventSource(new SqsEventSource(notificationQueue, {
  batchSize: 5,
  reportBatchItemFailures: true,
}));
```

Set `reservedConcurrentExecutions: 5` on the Lambda.

### Step 4.4 — Modify update-status handler

After updating order status in DynamoDB, send SQS message:
```ts
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

await sqsClient.send(new SendMessageCommand({
  QueueUrl: process.env.NOTIFICATION_QUEUE_URL,
  MessageBody: JSON.stringify({
    notificationId: uuid(),
    orderId, oldStatus, newStatus, customerId,
    timestamp: new Date().toISOString(),
  }),
}));
```

### Step 4.5 — Add CloudWatch alarm for DLQ

```ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

new cloudwatch.Alarm(this, 'DLQAlarm', {
  metric: notificationDlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 0,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  evaluationPeriods: 1,
  alarmDescription: 'Notification DLQ has messages — investigate failed notifications',
});
```

### Step 4.6 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Update an order status → check CloudWatch Logs for notification-sender Lambda
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  "$API_URL/orders/{orderId}/status" \
  -H "Content-Type: application/json" -d '{"status":"CONFIRMED"}'

# Verify in CloudWatch Logs that notification-sender was invoked
aws logs tail /aws/lambda/NotificationSender --region eu-west-1 --follow
```

### Phase 4 — Verification checklist

- [ ] Status update triggers SQS message
- [ ] Notification-sender Lambda processes the message
- [ ] DLQ receives messages after 3 failed attempts (test by throwing error in handler)
- [ ] DLQ CloudWatch alarm fires when messages land in DLQ
- [ ] Duplicate messages are handled idempotently

---

## Phase 5 — DynamoDB Streams + EventBridge (Event-Driven Architecture)

**Goal:** Replace direct SQS sends with event-driven flow: DynamoDB Streams → Lambda → EventBridge custom bus.

### Step 5.1 — Create EventBridge custom bus in ApplicationStack

```ts
import * as events from 'aws-cdk-lib/aws-events';

const orderEventBus = new events.EventBus(this, 'OrderEventBus', {
  eventBusName: 'order-events',
});
```

### Step 5.2 — Create stream processor Lambda

**src/handlers/streams/order-stream-processor.ts:**
- Triggered by DynamoDB Stream on the Order table
- For each record: compare `NewImage` and `OldImage`
  - INSERT → publish `OrderCreated` event
  - MODIFY where status changed → publish `OrderStatusChanged` event
- Publish to EventBridge:
  ```ts
  import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

  await ebClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'order-management.orders',
      DetailType: 'OrderStatusChanged',
      EventBusName: 'order-events',
      Detail: JSON.stringify({
        version: '1.0',
        orderId, oldStatus, newStatus, customerId, productId, updatedAt,
      }),
    }],
  }));
  ```

CDK wiring:
```ts
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

streamProcessorFn.addEventSource(new DynamoEventSource(props.orderTable, {
  startingPosition: lambda.StartingPosition.LATEST,
  batchSize: 10,
  bisectBatchOnFunctionError: true,
  retryAttempts: 3,
  onFailure: new SqsDlqDestination(streamDlq),
}));
```

### Step 5.3 — Create debug EventBridge rule

Route all events on the custom bus to CloudWatch Logs for verification:
```ts
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';

const debugLogGroup = new logs.LogGroup(this, 'EventBridgeDebugLogs', {
  logGroupName: '/aws/events/order-events-debug',
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  retention: logs.RetentionDays.ONE_WEEK,
});

new events.Rule(this, 'DebugAllEventsRule', {
  eventBus: orderEventBus,
  eventPattern: { source: [{ prefix: 'order-management' }] as any },
  targets: [new targets.CloudWatchLogGroup(debugLogGroup)],
});
```

### Step 5.4 — Remove direct SQS send from update-status handler

The notification flow now goes: DynamoDB update → Stream → EventBridge. Remove the `SQS SendMessage` call from `update-status.ts`. (The SQS queue from Phase 4 stays — it will be wired via SNS in Phase 6.)

### Step 5.5 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Create an order → check debug log group for OrderCreated event
curl -X POST -H "Authorization: Bearer $TOKEN" "$API_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":"prod-1","quantity":2}'

# Check CloudWatch for the event
aws logs tail /aws/events/order-events-debug --region eu-west-1 --follow

# Update status → check for OrderStatusChanged event
curl -X PUT -H "Authorization: Bearer $TOKEN" "$API_URL/orders/{orderId}/status" \
  -H "Content-Type: application/json" -d '{"status":"CONFIRMED"}'
```

### Phase 5 — Verification checklist

- [ ] Creating an order produces `OrderCreated` event in CloudWatch Logs
- [ ] Updating order status produces `OrderStatusChanged` event
- [ ] Stream processor DLQ catches poison records after 3 retries
- [ ] Events contain version field, orderId, customerId, timestamps

---

## Phase 6 — SNS Fan-out + SES Email Notifications

**Goal:** EventBridge routes status change events to SNS, which fans out to SQS → Lambda → SES for formatted emails.

### Step 6.1 — Verify email in SES

```bash
# SES sandbox: must verify both sender and recipient
aws ses verify-email-identity --email-address your-email@example.com --region eu-west-1
# Check your inbox and click the verification link
```

### Step 6.2 — Install SES client

```bash
pnpm add @aws-sdk/client-ses
```

### Step 6.3 — Create SNS topic and EventBridge rules

In ApplicationStack:
```ts
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

const orderNotificationTopic = new sns.Topic(this, 'OrderNotificationTopic', {
  topicName: 'order-notifications',
});

// Subscribe the existing notification SQS queue to the SNS topic
orderNotificationTopic.addSubscription(
  new snsSubscriptions.SqsSubscription(notificationQueue)
);

// EventBridge rules: route specific status changes to SNS
for (const status of ['CONFIRMED', 'SHIPPED', 'CANCELLED']) {
  new events.Rule(this, `OrderStatus${status}Rule`, {
    eventBus: orderEventBus,
    eventPattern: {
      source: ['order-management.orders'],
      detailType: ['OrderStatusChanged'],
      detail: { newStatus: [status] },
    },
    targets: [new targets.SnsTopic(orderNotificationTopic)],
  });
}
```

### Step 6.4 — Update notification-sender Lambda

- Parse SNS message envelope from SQS record body (SNS wraps the original message)
- Format email HTML based on status (different template per status)
- Send via SES:
  ```ts
  import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

  await sesClient.send(new SendEmailCommand({
    Source: 'noreply@your-domain.com', // Must be verified in SES
    Destination: { ToAddresses: [customerEmail] },
    Message: {
      Subject: { Data: `Order ${orderId} — ${newStatus}` },
      Body: { Html: { Data: htmlTemplate } },
    },
  }));
  ```
- Grant SES permission: `notificationFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }))`

### Step 6.5 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Update order to CONFIRMED → check email inbox
curl -X PUT -H "Authorization: Bearer $TOKEN" "$API_URL/orders/{orderId}/status" \
  -H "Content-Type: application/json" -d '{"status":"CONFIRMED"}'

# Full flow trace in CloudWatch:
# 1. DynamoDB update → 2. Stream processor → 3. EventBridge → 4. SNS → 5. SQS → 6. Lambda → 7. SES
```

### Phase 6 — Verification checklist

- [ ] Email received for CONFIRMED status change
- [ ] Email received for SHIPPED status change
- [ ] Email received for CANCELLED status change
- [ ] Email content is HTML-formatted (not raw JSON)
- [ ] End-to-end flow visible across CloudWatch log groups

---

## Phase 7 — Step Functions (Order Workflow Orchestration + Saga Pattern)

**Goal:** Orchestrate order processing as a state machine with compensation on failure.

### Step 7.1 — Create workflow Lambda handlers

Create these in `src/handlers/`:

| Handler | File | Logic |
|---------|------|-------|
| validate-order | `orders/validate.ts` | Check order exists, status is PENDING, product exists in Inventory |
| reserve-inventory | `inventory/reserve.ts` | Decrement stock with conditional expression `quantity >= orderQuantity` |
| process-payment | `payments/process.ts` | Simulated: 80% success / 20% failure (random). Write to Payments table |
| confirm-order | `orders/confirm.ts` | Update order status to CONFIRMED |
| release-inventory | `inventory/release.ts` | Increment stock back (compensation for failed payment) |
| cancel-order | `orders/cancel.ts` | Update order status to CANCELLED |

**Key DynamoDB pattern for reserve-inventory (conditional expression):**
```ts
await docClient.send(new UpdateCommand({
  TableName: INVENTORY_TABLE,
  Key: { productId },
  UpdateExpression: 'SET quantity = quantity - :qty, updatedAt = :now',
  ConditionExpression: 'quantity >= :qty',
  ExpressionAttributeValues: { ':qty': orderQuantity, ':now': new Date().toISOString() },
}));
```

### Step 7.2 — Define the Step Function state machine

In ApplicationStack:
```ts
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

const validateTask = new tasks.LambdaInvoke(this, 'ValidateOrder', {
  lambdaFunction: validateOrderFn,
  resultPath: '$.validation',
  payloadResponseOnly: true,
});

const reserveTask = new tasks.LambdaInvoke(this, 'ReserveInventory', {
  lambdaFunction: reserveInventoryFn,
  resultPath: '$.reservation',
  payloadResponseOnly: true,
  retryOnServiceExceptions: true,
}).addRetry({ maxAttempts: 2, interval: cdk.Duration.seconds(1) });

const paymentTask = new tasks.LambdaInvoke(this, 'ProcessPayment', {
  lambdaFunction: processPaymentFn,
  resultPath: '$.payment',
  payloadResponseOnly: true,
}).addRetry({ maxAttempts: 3, interval: cdk.Duration.seconds(2), backoffRate: 2 });

const confirmTask = new tasks.LambdaInvoke(this, 'ConfirmOrder', { ... });
const releaseTask = new tasks.LambdaInvoke(this, 'ReleaseInventory', { ... });
const cancelTask = new tasks.LambdaInvoke(this, 'CancelOrder', { ... });

// Wire the saga
const definition = validateTask
  .addCatch(cancelTask, { resultPath: '$.error' })
  .next(reserveTask
    .addCatch(cancelTask, { resultPath: '$.error' })
    .next(paymentTask
      .addCatch(releaseTask.next(cancelTask), { resultPath: '$.error' })
      .next(confirmTask)));

const orderWorkflow = new sfn.StateMachine(this, 'OrderWorkflow', {
  definitionBody: sfn.DefinitionBody.fromChainable(definition),
  stateMachineType: sfn.StateMachineType.STANDARD,
  timeout: cdk.Duration.minutes(5),
});
```

### Step 7.3 — Modify POST /orders to start Step Function

```ts
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

// After creating order in DynamoDB:
await sfnClient.send(new StartExecutionCommand({
  stateMachineArn: process.env.ORDER_WORKFLOW_ARN,
  name: `order-${orderId}`,
  input: JSON.stringify({ orderId, productId, quantity, customerId }),
}));
```

Grant: `orderWorkflow.grantStartExecution(createOrderFn)`

### Step 7.4 — Deploy and test all paths

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Seed inventory
curl -X PUT -H "Authorization: Bearer $TOKEN" "$API_URL/inventory/prod-1" \
  -H "Content-Type: application/json" -d '{"productName":"Widget","quantity":100,"price":9.99}'

# Create order → triggers Step Function
curl -X POST -H "Authorization: Bearer $TOKEN" "$API_URL/orders" \
  -H "Content-Type: application/json" -d '{"productId":"prod-1","quantity":2}'

# Poll order status (will transition PENDING → CONFIRMED or CANCELLED)
curl -H "Authorization: Bearer $TOKEN" "$API_URL/orders/{orderId}"

# Check Step Functions Console for visual execution graph
aws stepfunctions list-executions --state-machine-arn $WORKFLOW_ARN --region eu-west-1
```

**Test the saga compensation:**
- Set inventory quantity to 0 → create order → should cancel (no stock)
- Create order with non-existent product → should cancel (validation fails)
- Run several orders → ~20% should fail payment and trigger compensation

### Phase 7 — Verification checklist

- [ ] Happy path: order goes from PENDING → CONFIRMED
- [ ] No stock: order cancelled, inventory untouched
- [ ] Payment failure: inventory released, order cancelled
- [ ] Invalid product: order cancelled immediately
- [ ] Step Functions Console shows green/red execution paths
- [ ] Each Catch block routes to correct compensation

---

## Phase 8 — S3 Event Trigger (Bulk Order Import)

**Goal:** Upload a JSON file to S3 → triggers Lambda → creates multiple orders via Step Functions.

### Step 8.1 — Install S3 client

```bash
pnpm add @aws-sdk/client-s3
```

### Step 8.2 — Create S3 bucket in ApplicationStack

```ts
import * as s3 from 'aws-cdk-lib/aws-s3';

const importBucket = new s3.Bucket(this, 'ImportBucket', {
  bucketName: `order-imports-${this.account}-${this.region}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  lifecycleRules: [{ expiration: cdk.Duration.days(30), prefix: 'imports/' }],
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
```

### Step 8.3 — Create bulk-import Lambda

**src/handlers/import/bulk-import.ts:**
1. Read the S3 object (triggered by `ObjectCreated` on `imports/` prefix)
2. Parse JSON, validate with Zod schema
3. For each order: start a Step Function execution
4. Write results to `results/` prefix
5. Write failures to `errors/` prefix

CDK wiring:
```ts
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

bulkImportFn.addEventSource(new S3EventSource(importBucket, {
  events: [s3.EventType.OBJECT_CREATED],
  filters: [{ prefix: 'imports/' }],
}));
```

Set `reservedConcurrentExecutions: 1` and `timeout: Duration.minutes(5)`.

Grant: `importBucket.grantRead(bulkImportFn)`, `importBucket.grantPut(bulkImportFn)`, `orderWorkflow.grantStartExecution(bulkImportFn)`.

### Step 8.4 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Upload import file
aws s3 cp test-import.json s3://order-imports-ACCOUNT-eu-west-1/imports/batch-001.json

# Check Lambda logs
aws logs tail /aws/lambda/BulkImport --region eu-west-1 --follow

# Check results
aws s3 ls s3://order-imports-ACCOUNT-eu-west-1/results/

# Check Step Functions for new executions
aws stepfunctions list-executions --state-machine-arn $WORKFLOW_ARN --region eu-west-1
```

**test-import.json:**
```json
{
  "importId": "import-001",
  "orders": [
    { "customerId": "user-1", "productId": "prod-1", "quantity": 2 },
    { "customerId": "user-2", "productId": "prod-1", "quantity": 1 }
  ]
}
```

### Phase 8 — Verification checklist

- [ ] Upload to `imports/` triggers Lambda
- [ ] Upload to other prefix does NOT trigger Lambda
- [ ] Each order in the file starts a Step Function execution
- [ ] Results file written to `results/` prefix with success/failure counts
- [ ] Invalid orders produce entries in `errors/` prefix
- [ ] Same file uploaded twice doesn't create duplicate orders (idempotency)

---

## Phase 9 — Scheduled Events (Stale Order Cleanup)

**Goal:** EventBridge scheduled rule triggers Lambda every 30 minutes to cancel stale PENDING orders and release reserved inventory.

### Step 9.1 — Create stale-order-cleanup Lambda

**src/handlers/scheduled/stale-order-cleanup.ts:**
1. Query `status-createdAt-index` GSI: `status = "PENDING" AND createdAt < (now - 30 min)`
2. Paginate results (handle `LastEvaluatedKey`)
3. For each stale order:
   - Release reserved inventory (increment stock via UpdateCommand)
   - Update order status to CANCELLED
4. Log summary

```ts
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Query GSI
const result = await docClient.send(new QueryCommand({
  TableName: ORDER_TABLE,
  IndexName: 'status-createdAt-index',
  KeyConditionExpression: '#status = :pending AND createdAt < :threshold',
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: {
    ':pending': 'PENDING',
    ':threshold': new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  },
}));
```

### Step 9.2 — Create EventBridge scheduled rule

```ts
import * as events from 'aws-cdk-lib/aws-events';

new events.Rule(this, 'StaleOrderCleanupRule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
  targets: [new targets.LambdaFunction(staleOrderCleanupFn)],
});
```

Grant: `orderTable.grantReadWriteData(staleOrderCleanupFn)`, `inventoryTable.grantReadWriteData(staleOrderCleanupFn)`.

### Step 9.3 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Create a PENDING order manually with old timestamp for testing
# Or temporarily lower the threshold to 1 minute

# Trigger Lambda manually
aws lambda invoke --function-name StaleOrderCleanup --region eu-west-1 /dev/stdout

# Verify order status changed to CANCELLED
aws dynamodb get-item --table-name Orders --key '{"orderId":{"S":"your-order-id"}}' --region eu-west-1

# Verify scheduled rule exists
aws events list-rules --region eu-west-1
```

### Phase 9 — Verification checklist

- [ ] Lambda correctly queries the GSI (not a full table scan)
- [ ] Stale PENDING orders are cancelled
- [ ] Inventory is released for cancelled orders
- [ ] Scheduled rule is enabled and targets the Lambda
- [ ] Non-stale PENDING orders are untouched
- [ ] Lambda logs show summary of cancelled orders

---

## Phase 10 — Observability (CloudWatch + X-Ray + Powertools)

**Goal:** Add distributed tracing, custom business metrics, CloudWatch dashboard, and alarms across all services.

### Step 10.1 — Install Powertools tracer and metrics

```bash
pnpm add @aws-lambda-powertools/tracer @aws-lambda-powertools/metrics
```

### Step 10.2 — Add Tracer to all Lambda handlers

```ts
import { Tracer } from '@aws-lambda-powertools/tracer';

const tracer = new Tracer({ serviceName: 'order-service' });

// In handler:
const segment = tracer.getSegment();
const subsegment = segment?.addNewSubsegment('## handler');
tracer.setSegment(subsegment!);
tracer.putAnnotation('orderId', orderId);  // Searchable in X-Ray

// ... business logic

subsegment?.close();
tracer.setSegment(segment!);
```

Or use the middleware pattern:
```ts
import middy from '@middy/core';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';

export const handler = middy(lambdaHandler).use(captureLambdaHandler(tracer));
```

### Step 10.3 — Add Metrics to key handlers

```ts
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';

const metrics = new Metrics({ namespace: 'OrderManagement', serviceName: 'order-service' });

// In handler:
metrics.addMetric('OrderCreated', MetricUnit.Count, 1);
metrics.addDimension('environment', 'dev');
metrics.publishStoredMetrics();
```

### Step 10.4 — Enable X-Ray tracing on all Lambda functions

In CDK, for every `NodejsFunction`:
```ts
tracing: lambda.Tracing.ACTIVE,
```

Enable on API Gateway:
```ts
deployOptions: {
  tracingEnabled: true,
  // ... existing throttling config
},
```

### Step 10.5 — Create CloudWatch Dashboard

```ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new cloudwatch.Dashboard(this, 'OrderManagementDashboard', {
  dashboardName: 'OrderManagement',
});

dashboard.addWidgets(
  new cloudwatch.GraphWidget({
    title: 'API Gateway Requests',
    left: [api.metricCount(), api.metricLatency()],
  }),
  new cloudwatch.GraphWidget({
    title: 'Lambda Errors',
    left: [createOrderFn.metricErrors(), getOrderFn.metricErrors()],
  }),
  new cloudwatch.GraphWidget({
    title: 'DLQ Depth',
    left: [notificationDlq.metricApproximateNumberOfMessagesVisible()],
  }),
  // Add more widgets for DynamoDB, Step Functions, SQS, custom business metrics
);
```

### Step 10.6 — Create CloudWatch Alarms

```ts
// Lambda errors
createOrderFn.metricErrors().createAlarm(this, 'CreateOrderErrorAlarm', {
  threshold: 5,
  evaluationPeriods: 1,
  datapointsToAlarm: 1,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});

// API Gateway 5xx
api.metricServerError().createAlarm(this, 'Api5xxAlarm', {
  threshold: 10,
  evaluationPeriods: 1,
});

// Step Functions failures
orderWorkflow.metricFailed().createAlarm(this, 'WorkflowFailedAlarm', {
  threshold: 3,
  evaluationPeriods: 1,
});
```

### Step 10.7 — Deploy and test

```bash
pnpm run build && pnpm test
pnpm cdk deploy --all

# Create several orders to generate traces and metrics
for i in {1..5}; do
  curl -X POST -H "Authorization: Bearer $TOKEN" "$API_URL/orders" \
    -H "Content-Type: application/json" -d '{"productId":"prod-1","quantity":1}'
done

# Check X-Ray Console → Service Map (shows full request path with latency)
# Check CloudWatch → Dashboards → OrderManagement
# Check CloudWatch → Metrics → OrderManagement namespace → OrderCreated, etc.
```

### Phase 10 — Verification checklist

- [ ] X-Ray service map shows API GW → Lambda → DynamoDB path
- [ ] X-Ray traces contain orderId, customerId annotations (searchable)
- [ ] Custom metrics (OrderCreated, PaymentFailed, etc.) appear in CloudWatch
- [ ] Dashboard shows all widget graphs with data
- [ ] Triggering a failure causes an alarm to fire
- [ ] Powertools structured logs include X-Ray trace ID

---

## Phase 11 — CI/CD with GitHub Actions

**Goal:** Automate build, test, deploy on push to main. Show CDK diff on PRs. Use OIDC — no long-lived AWS credentials.

### Step 11.1 — Create OIDC Identity Provider in AWS

```bash
# One-time setup in your AWS account
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --region eu-west-1
```

### Step 11.2 — Create IAM Role for GitHub Actions

Create a role with a trust policy that allows your specific GitHub repo:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/aws-serverless-poc:*" }
    }
  }]
}
```

Attach permissions: `AdministratorAccess` for POC (scope down for production).

### Step 11.3 — Create deploy workflow

**.github/workflows/deploy.yml:**
```yaml
name: Deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm test

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-west-1

      - run: pnpm cdk synth
      - run: pnpm cdk diff
      - run: pnpm cdk deploy --all --require-approval never
```

### Step 11.4 — Create PR check workflow

**.github/workflows/pr-check.yml:**
```yaml
name: PR Check
on:
  pull_request:
    branches: [main]

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm test

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-west-1

      - run: pnpm cdk synth

      - name: CDK Diff
        id: diff
        run: pnpm cdk diff 2>&1 | tee diff-output.txt

      - name: Post diff as PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const diff = fs.readFileSync('diff-output.txt', 'utf8');
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## CDK Diff\n\`\`\`\n${diff}\n\`\`\``
            });
```

### Step 11.5 — Add GitHub repository secrets

Go to GitHub → Settings → Secrets and variables → Actions:
- `AWS_DEPLOY_ROLE_ARN`: `arn:aws:iam::ACCOUNT:role/GitHubActionsDeployRole`

### Step 11.6 — Test the pipeline

```bash
# Initialize git and push
git init
git add .
git commit -m "Initial commit — all 11 phases"
git remote add origin git@github.com:YOUR_ORG/aws-serverless-poc.git
git push -u origin main

# Create a branch, make a change, open a PR → verify diff appears as comment
git checkout -b test-pr
# Make a small change
git add . && git commit -m "Test PR" && git push -u origin test-pr
# Open PR on GitHub → verify workflow runs and posts CDK diff

# Merge PR → verify deploy workflow runs successfully
```

### Phase 11 — Verification checklist

- [ ] Push to main triggers deploy workflow
- [ ] PR triggers check workflow with CDK diff as comment
- [ ] OIDC auth works (no long-lived credentials in secrets)
- [ ] Failed tests prevent deployment
- [ ] `cdk synth` catches CDK errors before deploy

---

## Troubleshooting

### CDK Bootstrap fails with `AWS::EarlyValidation::ResourceExistenceCheck`

This happens when CloudFormation detects that resources the bootstrap template wants to create (S3 bucket, IAM roles) already exist — typically from a previous bootstrap that was deleted without cleaning up its resources, or from another bootstrap in the same account using the same qualifier.

**Fix — use a custom qualifier to avoid conflicts:**

This project uses `--qualifier poc2026` (configured in `cdk.json`) to namespace all bootstrap resources separately:

```bash
# 1. Delete any stuck CDKToolkit stack
aws cloudformation delete-stack --stack-name CDKToolkit --region eu-west-1
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region eu-west-1

# 2. Bootstrap with the custom qualifier
pnpm cdk bootstrap aws://ACCOUNT_ID/eu-west-1 --qualifier poc2026
```

If the error persists, your CDK CLI version may be too old. Upgrade it:

```bash
pnpm add -D aws-cdk@latest
```

Then retry the bootstrap command.

**Alternative — clean up orphaned resources manually:**

If you prefer to use the default qualifier, delete the leftover resources first:

1. Go to AWS Console → S3 → find bucket starting with `cdk-hnb659fds-assets-` → Empty → Delete
2. Go to CloudFormation → delete any `CDKToolkit` stack in a failed state
3. Run `pnpm cdk bootstrap aws://ACCOUNT_ID/eu-west-1`

### `current credentials could not be used to assume deploy role`

CDK tries to assume an IAM role created by the bootstrap. If your credentials don't have `sts:AssumeRole` permission for that role, CDK falls back to your direct credentials with a warning. This is usually fine for a POC — the deploy will still work if your IAM user/role has sufficient permissions.

If the deploy actually fails with an access denied error, ensure your AWS credentials have `AdministratorAccess` or at minimum CloudFormation, S3, IAM, and DynamoDB permissions.

### Node version warning (`has not been tested with node vXX`)

CDK regularly lags behind the latest Node releases. The warning is cosmetic and doesn't affect functionality. Silence it by setting:

```bash
# Windows (permanent, requires terminal restart)
[System.Environment]::SetEnvironmentVariable('JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION', '1', 'User')

# Or per-session
$env:JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION = "1"
```

### CDK CLI notices (telemetry, version divergence)

These are informational and can be dismissed permanently:

```bash
pnpm cdk acknowledge 34892
pnpm cdk acknowledge 32775
```

---

## Cleanup

When done with the POC, tear down all AWS resources:

```bash
# Destroy all stacks (order matters — ApplicationStack first, then SharedStack)
pnpm cdk destroy --all

# Verify nothing remains
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --region eu-west-1

# Remove the OIDC provider and IAM role if created
aws iam delete-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com
aws iam delete-role --role-name GitHubActionsDeployRole
```

> This cleanup works because all resources use `RemovalPolicy.DESTROY` and `autoDeleteObjects: true`. In production, you'd use `RETAIN` on data stores to prevent accidental data loss.
