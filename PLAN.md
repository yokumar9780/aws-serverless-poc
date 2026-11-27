# AWS Serverless POC — Order Management System

## Overview

A step-by-step learning project that implements a simple Order Management System using AWS serverless services, deployed with CDK (TypeScript). Each phase introduces a new serverless concept, building on the previous one. By the end, you'll have hands-on experience with every major AWS serverless service and production-grade patterns.

**Region:** eu-west-1  
**Language:** TypeScript (Lambda + CDK)  
**Domain:** Order Management (Order, Inventory, Payment)  
**Tech Decisions:** See [TECH-DECISIONS.md](./TECH-DECISIONS.md) for all selected technologies, patterns, and their alternatives with cost comparison.

---

## Architecture Diagram (Target State)

```
                                    ┌─────────────┐
                                    │   Cognito    │
                                    │  User Pool   │
                                    └──────┬───────┘
                                           │ Auth (JWT)
┌──────────┐    ┌──────────────┐    ┌──────▼───────┐    ┌──────────────┐
│  Client   │───▶  API Gateway │───▶│   Lambda     │───▶│  DynamoDB    │
│           │    │  (REST+WAF)  │    │  (CRUD)      │    │  (Tables)    │
└──────────┘    └──────────────┘    └──────┬───────┘    └──────┬───────┘
                                           │                    │
                              ┌────────────┼────────────┐       │ DynamoDB Streams
                              │            │            │       │
                        ┌─────▼─────┐ ┌────▼────┐ ┌────▼────┐ ┌▼────────────┐
                        │   SQS     │ │  Step   │ │   S3    │ │   Lambda    │
                        │  Queue    │ │Functions│ │ (Bulk)  │ │ (Stream     │
                        │  + DLQ    │ │(Saga)   │ └────┬────┘ │  Processor) │
                        └─────┬─────┘ └────┬────┘      │      └──────┬──────┘
                              │            │      ┌────▼────┐         │
                        ┌─────▼─────┐      │      │ Lambda  │   ┌─────▼──────┐
                        │  Lambda   │      │      │ (Import)│   │EventBridge │
                        │ (Notif.)  │      │      └─────────┘   │ (Custom    │
                        └───────────┘      │                     │  Bus)      │
                                           │                     └─────┬──────┘
                                     ┌─────▼──────┐           ┌───────┼───────┐
                                     │ EventBridge│           │       │       │
                                     │ (Schedule) │         ┌─▼─┐  ┌─▼─┐  ┌─▼──┐
                                     └────────────┘         │SNS│  │CW │  │Log │
                                                            │   │  │Alm│  │   │
                                                            └─┬─┘  └───┘  └────┘
                                                              │
                                                        ┌─────▼──────┐
                                                        │ Lambda→SES │
                                                        │  (Email)   │
                                                        └────────────┘
```

---

## Data Model (Basic Fields)

### Order Table

| Field       | Type   | Key      | Description                                          |
|-------------|--------|----------|------------------------------------------------------|
| orderId     | String | PK       | Partition key (UUID)                                 |
| customerId  | String | GSI1-PK  | Who placed the order — GSI for "get orders by customer" |
| productId   | String |          | What was ordered                                     |
| quantity    | Number |          | How many                                             |
| status      | String | GSI2-PK  | PENDING / CONFIRMED / SHIPPED / CANCELLED            |
| totalAmount | Number |          | Price × quantity                                     |
| createdAt   | String | GSI2-SK  | ISO timestamp — sort key on status GSI               |
| updatedAt   | String |          | ISO timestamp                                        |

**GSIs (defined upfront, used incrementally):**
- `customerId-index` — PK: customerId, SK: createdAt → used from Phase 2 for `GET /orders?customerId=X`
- `status-createdAt-index` — PK: status, SK: createdAt → used from Phase 9 for stale order cleanup

> **Design note:** Define GSIs in Phase 1 even if used later. Adding GSIs later requires backfill and can be slow on large tables. In production, plan your access patterns upfront.

### Inventory Table

| Field       | Type   | Key | Description     |
|-------------|--------|-----|-----------------|
| productId   | String | PK  | Partition key   |
| productName | String |     | Display name    |
| quantity    | Number |     | Available stock |
| price       | Number |     | Unit price      |
| updatedAt   | String |     | ISO timestamp   |

### Payment Table

| Field       | Type   | Key     | Description                                 |
|-------------|--------|---------|---------------------------------------------|
| paymentId   | String | PK      | Partition key (UUID)                        |
| orderId     | String | GSI-PK  | Links to order — GSI for lookup by order    |
| amount      | Number |         | Payment amount                              |
| status      | String |         | PENDING / SUCCESS / FAILED                  |
| createdAt   | String |         | ISO timestamp                               |

**GSI:**
- `orderId-index` — PK: orderId → used in Phase 7 Step Functions to check if payment exists for an order

> **Design note:** The relationship is 1:1 (one payment per order). We could use orderId as the PK directly, but keeping a separate paymentId allows extending to multiple payment attempts per order later.

---

## Project Structure

```
aws-serverless-poc/
├── bin/
│   └── app.ts                        # CDK app entry point — instantiates stacks
├── lib/
│   ├── stacks/
│   │   ├── shared-stack.ts           # DynamoDB, Cognito (evolves across phases)
│   │   └── application-stack.ts      # API GW, Lambdas, SQS, EventBridge, SNS, Step Functions, S3
│   └── constructs/                   # Reusable L3 constructs if needed
├── src/
│   ├── handlers/                     # Lambda function code
│   │   ├── orders/
│   │   │   ├── create.ts
│   │   │   ├── get.ts
│   │   │   ├── list.ts
│   │   │   └── update-status.ts
│   │   ├── inventory/
│   │   │   ├── get.ts
│   │   │   └── update.ts
│   │   ├── payments/
│   │   │   └── process.ts
│   │   ├── async/
│   │   │   ├── notification-sender.ts    # SQS → format + send via SES
│   │   │   └── inventory-reserver.ts     # Step Function task
│   │   ├── streams/
│   │   │   └── order-stream-processor.ts # DynamoDB Streams → EventBridge
│   │   ├── import/
│   │   │   └── bulk-import.ts            # S3 trigger
│   │   └── scheduled/
│   │       └── stale-order-cleanup.ts    # EventBridge cron
│   ├── shared/                       # Shared code (bundled via esbuild, not a Layer)
│   │   ├── response.ts              # Consistent API response builder
│   │   ├── validator.ts             # Zod schemas for input validation
│   │   ├── dynamo-client.ts         # DynamoDB DocumentClient singleton
│   │   └── logger.ts                # Powertools logger config
│   └── types/                        # Shared TypeScript interfaces
│       ├── order.ts
│       ├── inventory.ts
│       └── payment.ts
├── test/
│   ├── unit/                         # Handler unit tests
│   └── infra/                        # CDK snapshot/assertion tests
├── .github/
│   └── workflows/
│       ├── deploy.yml                # Main branch → deploy
│       └── pr-check.yml             # PR → build + test + cdk diff
├── cdk.json
├── tsconfig.json
├── jest.config.ts
└── package.json
```

> **Review fix — Layers vs bundling:** The original plan used a Lambda Layer for shared code. For TypeScript projects, CDK's `NodejsFunction` with esbuild bundling is simpler and more maintainable. Regular TypeScript imports get bundled into each Lambda automatically. Layers are better for binary dependencies or cross-runtime sharing. We use bundling here.

---

## Stack Strategy

**Two stacks** (not three — reduced from original plan based on review):

| Stack | Contains | Why separate |
|-------|----------|-------------|
| **SharedStack** | DynamoDB tables, Cognito User Pool, shared config | Stateful resources with `RETAIN` semantics in production. Separate lifecycle from compute. |
| **ApplicationStack** | API Gateway, all Lambdas, SQS, EventBridge, SNS, Step Functions, S3 | Stateless compute and integration resources. Deploy frequently without risking data stores. |

```
SharedStack (DynamoDB tables + GSIs, Cognito)
    │
    └──▶ ApplicationStack (everything else) — depends on SharedStack via cross-stack references
```

> **Cross-stack references:** SharedStack exports table ARNs, table names, Cognito pool ID. ApplicationStack imports them. CDK handles this via CloudFormation exports. Be aware: once exported, you can't rename or remove an export without updating all consumers first.

> **Stack evolution:** SharedStack is created in Phase 1 with just DynamoDB tables. Cognito is added in Phase 3. The ApplicationStack grows with each phase. This is normal — stacks evolve.

---

## Phase Breakdown

---

### Phase 1 — Project Setup, CDK Foundation & DynamoDB

**Goal:** Initialize CDK project, deploy DynamoDB tables with proper access patterns, set up shared code structure.

**Serverless concepts:**
- Infrastructure as Code (IaC) with CDK
- DynamoDB table design, partition keys, GSIs, on-demand billing
- CDK Stacks, Constructs (L1/L2/L3), synthesis, deployment

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| Single-table-per-entity design | Simpler for learning; single-table design is advanced and not needed here |
| On-demand billing (PAY_PER_REQUEST) | No capacity planning, pay only for what you use, perfect for variable/unknown workloads |
| GSIs defined upfront | Avoid costly backfills on large tables later |
| `RemovalPolicy.DESTROY` on all stateful resources | POC only — allows clean `cdk destroy`. **Never do this in production** |
| `autoDeleteObjects: true` on S3 | POC only — same reason |
| Environment-prefixed resource names | Avoid collisions if deploying multiple environments |

**What you'll learn:**
- How CDK works — you define AWS resources in TypeScript, CDK synthesizes it into CloudFormation, then deploys it. Think of it as "infrastructure as code" with real programming constructs (loops, conditions, classes) instead of YAML/JSON.
- CDK Stacks = unit of deployment. Each stack = one CloudFormation stack. Resources in the same stack deploy/destroy together.
- CDK Constructs = reusable building blocks. L1 = raw CloudFormation (CfnTable), L2 = opinionated defaults with helpers (Table), L3 = patterns combining multiple resources.
- DynamoDB is NoSQL, fully managed, serverless. No servers to provision. On-demand billing = pay per request.
- Partition key determines how DynamoDB distributes and retrieves data. High-cardinality keys (UUIDs) give even distribution.
- GSIs let you query by alternative key patterns without scanning the whole table.

**Tasks:**
- [ ] `npx cdk init app --language typescript` — initialize project
- [ ] Install dependencies (via pnpm): `aws-cdk-lib`, `constructs`, `@aws-lambda-powertools/*`, `zod`, `uuid`
- [ ] Set up folder structure as defined above
- [ ] Create SharedStack with:
  - Order table (PK: orderId, GSI1: customerId-index, GSI2: status-createdAt-index)
  - Inventory table (PK: productId)
  - Payment table (PK: paymentId, GSI: orderId-index)
  - All tables: on-demand billing, `RemovalPolicy.DESTROY` (POC only)
- [ ] Create shared code modules: response builder, DynamoDB client singleton, TypeScript interfaces
- [ ] Set up Powertools logger in shared code (used from first Lambda onwards)
- [ ] `cdk synth` — verify CloudFormation template is generated
- [ ] `cdk deploy SharedStack` — deploy and verify tables in AWS Console
- [ ] Write CDK assertion test for SharedStack (table count, key schema)

**Key concept — How CDK deployment works:**
```
TypeScript Code (lib/stacks/*.ts)
    │
    ▼  cdk synth
CloudFormation Template (cdk.out/*.json)
    │
    ▼  cdk deploy
CloudFormation Service (creates/updates AWS resources)
    │
    ▼
AWS Resources (DynamoDB tables, etc.)
```

**Key concept — Resource naming and environment variables:**
CDK generates unique physical names for resources (e.g., `SharedStack-OrderTable4A2B1C3D-XYZ`). Your Lambda code doesn't hardcode these names. Instead, CDK passes them as environment variables:
```typescript
// In CDK stack
const orderLambda = new NodejsFunction(this, 'CreateOrder', { ... });
orderTable.grantReadWriteData(orderLambda);  // IAM permission
orderLambda.addEnvironment('ORDER_TABLE_NAME', orderTable.tableName);  // Pass name

// In Lambda handler
const tableName = process.env.ORDER_TABLE_NAME;  // Read at runtime
```

---

### Phase 2 — API Gateway + Lambda + DynamoDB (Sync CRUD)

**Goal:** Build REST API for Order and Inventory CRUD with proper validation, error handling, and observability from day one.

**Serverless concepts:**
- API Gateway REST API, resources, methods, proxy integration
- Lambda execution model, cold starts, execution context reuse
- Lambda IAM execution roles and least-privilege permissions
- Input validation (API Gateway models + runtime Zod validation)
- Structured logging with Powertools

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| Least-privilege IAM via CDK `grant*` methods | Each Lambda gets only the permissions it needs. `table.grantReadData()` vs `grantReadWriteData()` based on the operation |
| `NodejsFunction` with esbuild bundling | Tree-shakes and bundles only used code. Faster cold starts, smaller packages |
| Input validation at two layers | API Gateway validates structure (required fields, types). Zod validates business rules (quantity > 0, valid status values) in Lambda |
| Consistent error response format | All errors return `{ statusCode, message, requestId }` — makes debugging and client integration predictable |
| Powertools Logger from day one | Structured JSON logs with correlation IDs. Every subsequent phase benefits from searchable, filterable logs |
| Environment variables for config | Lambda discovers table names, region, etc. via environment variables set by CDK — no hardcoded ARNs |
| API Gateway throttling | Set stage-level rate limit (100 req/s) to prevent runaway costs and demonstrate the capability |
| CORS configuration | Configured at API Gateway level — required for browser-based clients |

**What you'll learn:**
- API Gateway is the "front door." It handles routing, throttling, request validation, CORS, and usage plans. No servers to manage.
- Lambda runs your code in response to events. AWS handles scaling (0 to thousands of concurrent executions), patching, and availability. You pay only when code runs.
- Cold starts: First invocation takes longer (~200-500ms for Node.js) because AWS provisions the execution environment. Subsequent invocations reuse the warm container. Code outside the handler function (DynamoDB client init, imports) runs once during cold start and is reused.
- Lambda Proxy Integration: API Gateway passes the full HTTP request as an event object. Your function returns `{ statusCode, headers, body }`. Simplest integration.
- IAM execution role: Every Lambda has a role that defines what AWS services it can access. CDK's `grant*` methods create scoped policies automatically:
  ```typescript
  orderTable.grantReadWriteData(createOrderFn);  // Can read+write Order table
  orderTable.grantReadData(getOrderFn);           // Can only read Order table
  inventoryTable.grantReadData(getOrderFn);       // Cannot access Inventory table at all
  ```

**Tasks:**
- [ ] Create Lambda handlers with Powertools logger:
  - `POST /orders` — Create order (validate with Zod, status = PENDING, generate UUID)
  - `GET /orders/{orderId}` — Get order by ID
  - `GET /orders?customerId=X` — List orders by customer using customerId GSI (not a table scan)
  - `PUT /orders/{orderId}/status` — Update order status (validate allowed transitions)
  - `GET /inventory/{productId}` — Get inventory item
  - `PUT /inventory/{productId}` — Update/seed inventory
- [ ] Create ApplicationStack with REST API Gateway
- [ ] Configure `NodejsFunction` with esbuild bundling for each handler
- [ ] Wire routes to Lambda functions using proxy integration
- [ ] Add API Gateway request models for POST/PUT endpoints
- [ ] Add Zod validation schemas in shared/validator.ts
- [ ] Set least-privilege IAM: use `grantReadData` for GET handlers, `grantReadWriteData` for write handlers
- [ ] Set API Gateway stage throttling: 100 requests/second, burst 200
- [ ] Configure CORS on API Gateway
- [ ] Add environment variables: table names, region
- [ ] Test all endpoints with curl/Postman
- [ ] Write unit tests for handlers (mock DynamoDB)
- [ ] Write CDK assertion test for ApplicationStack (API, Lambda count, IAM policies)

**Key concept — Lambda execution model:**
```
Client Request
    │
    ▼
API Gateway (validates request against model, checks throttle limits)
    │
    ▼
Lambda Service (finds or creates execution environment)
    │
    ├─ Cold start? → Download code → Init runtime → Run INIT code → Run handler
    │                                                  ▲
    │                                     DynamoDB client, imports,
    │                                     Powertools setup (runs ONCE,
    │                                     reused across invocations)
    │
    └─ Warm? → Run handler directly (reuses init code from previous invocation)
    │
    ▼
Response back through API Gateway → Client
```

**Key concept — Why validate twice?**
```
API Gateway Model Validation          Lambda Zod Validation
─────────────────────────             ──────────────────────
✓ Required fields exist               ✓ quantity > 0
✓ Field types (string, number)        ✓ productId exists in inventory
✓ Rejects before Lambda runs          ✓ Status transition is valid
  (saves cost — no invocation)          (PENDING→CONFIRMED ok, SHIPPED→PENDING not)
✗ Can't check business rules          ✓ String length limits, enums
✗ Limited to JSON Schema              ✓ Full programmatic validation
```

---

### Phase 3 — Cognito Authentication & Authorization

**Goal:** Protect API endpoints with Cognito User Pool + JWT authorizer. Extract user identity in Lambda.

**Serverless concepts:**
- Cognito User Pool (managed user directory)
- JWT authorizer on API Gateway
- Token-based authentication flow
- Claims-based identity in Lambda

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| JWT authorizer at API Gateway level | Rejects invalid tokens before Lambda runs — saves compute cost and centralizes auth |
| Cognito User Pool (not Identity Pool) | User Pool = authentication (who are you). Identity Pool = authorization for AWS resources (we don't need this) |
| Extract customerId from JWT claims | Don't trust client-sent customerId in request body — derive it from the verified token |
| Password policy enforcement | Cognito handles complexity rules, rotation, brute-force protection — don't build this yourself |
| ID token for REST API CognitoUserPoolsAuthorizer | REST API's COGNITO_USER_POOLS authorizer validates the `aud` claim, which only exists on ID tokens. Access tokens have `client_id` instead and get rejected with 401. For HTTP API JWT authorizers, access tokens work |

**What you'll learn:**
- Cognito User Pool is a managed user directory. Handles signup, signin, MFA, password policies, token issuance. Zero server management.
- JWT (JSON Web Token) authorizer on API Gateway validates the token BEFORE your Lambda executes. Invalid/expired tokens → 401 response. Lambda never runs, no cost incurred.
- Token types: **ID token** (user profile info for the client), **Access token** (API authorization), **Refresh token** (get new tokens without re-login).
- Auth flow: Sign up → confirm email → sign in → receive tokens → pass access token in `Authorization: Bearer <token>` header → API Gateway validates → Lambda gets verified claims.

**Tasks:**
- [ ] Add Cognito User Pool to SharedStack:
  - Self-signup enabled
  - Email verification required
  - Password policy: 8+ chars, uppercase, lowercase, number
- [ ] Add Cognito User Pool Client (app client, no secret for public client)
- [ ] Add JWT authorizer to API Gateway in ApplicationStack
- [ ] Protect all routes except `GET /health` (health check)
- [ ] Modify Lambda handlers to extract `customerId` from `event.requestContext.authorizer.claims.sub`
- [ ] Modify `POST /orders` to use JWT `sub` claim as `customerId` (ignore any customerId in body)
- [ ] Modify `GET /orders` to filter by the authenticated user's customerId
- [ ] Test flow:
  - Sign up: `aws cognito-idp sign-up ...`
  - Confirm: `aws cognito-idp confirm-sign-up ...`
  - Sign in: `aws cognito-idp initiate-auth ...`
  - Call API with token → 200
  - Call API without token → 401
  - Call API with expired token → 401
- [ ] Update CDK tests

**Key concept — Token flow:**
```
1. User → Sign Up → Cognito (creates user, sends verification email)
2. User → Confirm Email → Cognito (activates account)
3. User → Sign In → Cognito → Returns { IdToken, AccessToken, RefreshToken }

4. User → GET /orders + "Authorization: Bearer <IdToken>"
       → API Gateway
       → JWT Authorizer validates token signature using Cognito public keys (JWKS)
           ├── Invalid/Expired → 401 Unauthorized (Lambda NEVER called, $0 cost)
           └── Valid → Forwards to Lambda
                       event.requestContext.authorizer.claims = {
                         sub: "user-uuid-123",    ← use this as customerId
                         email: "user@example.com",
                         token_use: "access",
                         ...
                       }
```

**Key concept — Why extract customerId from token?**
If you let the client send `customerId` in the request body, any authenticated user could create orders as another user. By extracting it from the verified JWT `sub` claim, you guarantee the identity is authentic. The token is cryptographically signed by Cognito — it cannot be tampered with.

---

### Phase 4 — SQS Async Processing (Notification Delivery)

**Goal:** Decouple notification sending from the main flow using SQS. When order status changes, send a notification message to SQS → a consumer Lambda picks it up and delivers the notification.

> **Review fix — Phase 4/7 conflict resolved:** The original plan used SQS for inventory reservation here, then Phase 7 replaced it with Step Functions doing the same thing. Now Phase 4 teaches SQS with **notification delivery** (a naturally async, fire-and-forget use case), and Phase 7 teaches Step Functions with **order orchestration** (a workflow that needs coordination). No conflict — both patterns coexist in the final architecture.

**Serverless concepts:**
- SQS (Simple Queue Service) — message queuing
- Async decoupling (producer doesn't wait for consumer)
- Dead Letter Queue (DLQ) — capturing failed messages
- Lambda event source mapping (SQS → Lambda)
- At-least-once delivery and idempotency

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| SQS for fire-and-forget async work | Producer returns immediately. Consumer processes at its own pace. If consumer is down, messages wait in the queue |
| Dead Letter Queue (DLQ) | After N failed attempts, message moves to DLQ instead of being lost. Inspect and replay later |
| Idempotency via conditional writes | SQS delivers at-least-once — your consumer MIGHT process the same message twice. Use DynamoDB `attribute_not_exists` condition to prevent duplicate processing |
| Visibility timeout = 6× Lambda timeout | AWS recommendation. If Lambda takes 30s, set visibility to 180s. Prevents another consumer from picking up the message while Lambda is still processing |
| Reserved concurrency on consumer Lambda | Prevents the SQS consumer from using all available Lambda concurrency, starving API-facing Lambdas |
| Batch size configuration | Process up to 10 messages per Lambda invocation to reduce cost. Use `batchItemFailures` to report partial failures |

**What you'll learn:**
- SQS decouples producers from consumers. The API Lambda drops a message and returns immediately — the client doesn't wait for notification delivery.
- At-least-once delivery: SQS guarantees the message is delivered at least once, but it might deliver it twice (network issues, timeout, etc.). Your consumer must be idempotent — processing the same message twice should have the same result as processing it once.
- Visibility timeout: When a consumer picks up a message, SQS hides it from other consumers for a set duration. If the consumer doesn't delete it (crashed/failed), SQS makes it visible again for retry.
- DLQ: After `maxReceiveCount` retries (e.g., 3), the message moves to a separate DLQ. You can inspect it, fix the issue, and replay.
- Reserved concurrency: Lambda has a default account limit of 1000 concurrent executions (all functions combined). Setting `reservedConcurrentExecutions: 5` on the SQS consumer ensures it uses at most 5 concurrent instances — leaving capacity for API Lambdas.

**Tasks:**
- [ ] Create SQS queue (`order-notification-queue`) + Dead Letter Queue in ApplicationStack
  - Visibility timeout: 180s (6× Lambda timeout of 30s)
  - DLQ: `maxReceiveCount: 3`
- [ ] Create `notification-sender` Lambda triggered by SQS
  - Set `reservedConcurrentExecutions: 5`
  - Set `batchSize: 5`, `reportBatchItemFailures: true`
  - Process notification messages (for now, just log — SES integration comes in Phase 6)
  - Use idempotency: check a `notificationId` in DynamoDB before processing
- [ ] For testing: Modify `PUT /orders/{orderId}/status` to send SQS message after status update
  - Message: `{ notificationId, orderId, oldStatus, newStatus, customerId, timestamp }`
- [ ] Add Powertools idempotency utility (`@aws-lambda-powertools/idempotency`) to prevent duplicate notifications
- [ ] Configure SQS retry policy
- [ ] Test:
  - Happy path: update order status → verify notification-sender Lambda invoked
  - Failure path: throw error in consumer → verify message retries → ends up in DLQ
  - Idempotency: process same message twice → verify only one notification record created
- [ ] Add CloudWatch alarm: DLQ message count > 0

**Key concept — Async flow with idempotency:**
```
PUT /orders/{orderId}/status
    │
    ▼
Order Lambda: Update order status → Send SQS message → Return 200 to client
                                         │
                                         ▼  (async, seconds later)
                                   SQS Queue
                                         │
                                         ▼
                              Notification Lambda:
                                  1. Check idempotency key (notificationId)
                                     ├── Already processed? → Skip (return success)
                                     └── New? → Continue
                                  2. Process notification (log for now, SES in Phase 6)
                                  3. Mark as processed
                                         │
                                   (on failure, up to 3 retries)
                                         ▼
                                   DLQ (inspect & replay)
```

**Key concept — Why idempotency matters:**
```
Without idempotency:                    With idempotency:
Message delivered twice →               Message delivered twice →
  ├── Process #1: Send email ✓            ├── Process #1: Send email ✓ (save notificationId)
  └── Process #2: Send DUPLICATE email     └── Process #2: notificationId exists → skip
Customer gets 2 emails 😡                Customer gets 1 email ✓
```

**Key concept — Reserved concurrency protects the account:**
```
Account Lambda concurrency limit: 1000

Without reserved concurrency:           With reserved concurrency:
Bulk import creates 500 orders →        Bulk import creates 500 orders →
  500 SQS messages →                      500 SQS messages →
  500 notification Lambdas scale up →     5 notification Lambdas (max) →
  API Lambdas can't start (no capacity)   API Lambdas unaffected ✓
  API returns 429 😡                      SQS messages process gradually ✓
```

---

### Phase 5 — DynamoDB Streams + EventBridge (Event-Driven Architecture)

**Goal:** Capture order changes from DynamoDB Streams, publish structured events to EventBridge. Build the event backbone for the system.

**Serverless concepts:**
- DynamoDB Streams (Change Data Capture)
- EventBridge custom event bus
- Event-driven architecture (services react to events, not commands)
- Stream processing error handling

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| DynamoDB Streams with NEW_AND_OLD_IMAGES | Capture both before and after state — needed to detect what changed (e.g., status went from PENDING to CONFIRMED) |
| Custom EventBridge bus (not default) | Isolates your events from AWS service events. Easier to manage rules, archive, and replay |
| Event schema versioning | Include a `version` field in events. When event structure changes, consumers can handle multiple versions |
| `bisectBatchOnError: true` | On failure, splits the batch in half and retries each half. Isolates the failing record instead of blocking the entire stream |
| `maxRetryAttempts` + `onFailure` destination | Prevents infinite retries on a poison message. After max retries, sends to SQS DLQ for inspection |
| `maxBatchingWindow` | Waits up to N seconds to accumulate records before invoking Lambda. Reduces invocations for high-throughput tables |
| Source and detail-type naming convention | Use reverse-DNS-style source (`order-management.orders`) and descriptive detail-type (`OrderStatusChanged`). Makes filtering precise |

**What you'll learn:**
- DynamoDB Streams captures every INSERT, MODIFY, REMOVE as a time-ordered sequence of records. You don't poll — DynamoDB pushes to your Lambda.
- NEW_AND_OLD_IMAGES gives you both the before and after state of each item. You compare them to detect specific changes (e.g., status changed, quantity updated).
- EventBridge is a serverless event bus. You publish events, rules route them to targets based on patterns. The publisher doesn't know (or care) who consumes the events.
- This is event-driven architecture: the Order table doesn't know about notifications. The stream processor doesn't know who cares about status changes. EventBridge handles routing. Adding a new consumer means adding a new rule — zero changes to existing code.
- Stream processing pitfall: If your Lambda throws an error, DynamoDB Streams retries the same batch INDEFINITELY by default. This blocks all newer events behind it. The fix is `bisectBatchOnError` + `maxRetryAttempts` + DLQ.

**Tasks:**
- [ ] Enable DynamoDB Streams on Order table (StreamViewType: NEW_AND_OLD_IMAGES)
- [ ] Create custom EventBridge event bus (`order-events`) in ApplicationStack
- [ ] Create `order-stream-processor` Lambda triggered by DynamoDB Stream
  - Compare new and old images
  - If status changed → publish `OrderStatusChanged` event
  - If new order created → publish `OrderCreated` event
  - Include event version field
- [ ] Configure stream event source mapping:
  - `bisectBatchOnError: true`
  - `maxRetryAttempts: 3`
  - `onFailure: SQS DLQ` (reuse or create a stream-specific DLQ)
  - `batchSize: 10`
  - `startingPosition: LATEST`
- [ ] Create a debug EventBridge rule: match all events on the custom bus → CloudWatch Logs target (for verification)
- [ ] Remove the direct SQS send from `PUT /orders/{orderId}/status` (Phase 4). The notification will now flow through: DynamoDB update → Stream → EventBridge → (Phase 6) SNS → SQS → notification Lambda. This is the proper event-driven approach.
- [ ] Test:
  - Create an order → verify `OrderCreated` event in CloudWatch Logs
  - Update order status → verify `OrderStatusChanged` event in CloudWatch Logs
  - Force a stream processing error → verify retry + DLQ behavior
- [ ] Update CDK tests

**Key concept — Event structure (versioned):**
```json
{
  "source": "order-management.orders",
  "detail-type": "OrderStatusChanged",
  "detail": {
    "version": "1.0",
    "orderId": "abc-123",
    "oldStatus": "PENDING",
    "newStatus": "CONFIRMED",
    "customerId": "user-456",
    "productId": "prod-789",
    "updatedAt": "2025-01-15T10:30:00Z"
  }
}
```

**Key concept — Why EventBridge over direct SNS?**
```
EventBridge                                    SNS
──────────                                     ───
✓ Content-based filtering on any field         ✓ Simple topic-subscription model
  (route SHIPPED differently from CANCELLED)
✓ Multiple rules per event, multiple targets   ✓ Fan-out to many subscribers
✓ Schema registry — discover event shapes      ✗ No schema registry
✓ Archive & replay — debug by replaying        ✗ No replay
  past events
✓ 200+ AWS service integrations as targets     ✓ Fewer native targets
✓ Cron/rate scheduling built-in                ✗ No scheduling
✗ Higher latency (~500ms)                      ✓ Lower latency (~30ms)
✗ 256KB max event size                         ✓ 256KB max message size

Verdict: EventBridge is the right backbone for event-driven systems. Use SNS for
fan-out delivery where you need multiple subscribers for the same event.
```

**Key concept — Stream error handling (critical for production):**
```
Without error handling:                With proper error handling:
Poison record arrives →                Poison record arrives →
  Lambda throws error →                  Lambda throws error →
  DynamoDB retries same batch →          Retry 1: bisect batch (5+5)
  Lambda throws again →                  Retry 2: bisect again (2+3)
  Retries FOREVER →                      Retry 3: isolate failing record
  All newer events BLOCKED 🔥            → Send to DLQ, continue processing ✓
  Hours of lost events                   Newer events flow normally ✓
```

---

### Phase 6 — SNS Fan-out + SES Email Notifications

**Goal:** Route EventBridge order events to SNS topics, fan out to email via SES. Connect Phase 4's notification sender Lambda to actually send emails.

> **SES Sandbox Warning:** New AWS accounts are in SES sandbox mode. You can ONLY send emails to verified email addresses. You must verify your recipient email in SES before testing. Production SES requires requesting production access from AWS (takes ~24 hours approval).

**Serverless concepts:**
- SNS (pub/sub, fan-out pattern)
- SES (transactional email)
- EventBridge rules with content-based filtering
- Multi-subscriber fan-out

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| EventBridge → SNS → SQS → Lambda (not EventBridge → Lambda directly) | SNS provides fan-out. SQS provides buffering, retry, and DLQ. Direct EventBridge → Lambda loses the message if Lambda fails |
| Content-based filtering in EventBridge rules | Different rules for CONFIRMED vs SHIPPED vs CANCELLED — each can have different targets or formats |
| SNS message filtering | Subscribers can filter messages — e.g., only receive SHIPPED notifications. Reduces unnecessary Lambda invocations |
| SES for formatted email (not raw SNS email) | SNS email subscription sends raw JSON. SES supports HTML templates, tracking, and delivery metrics |
| Verified sender identity in SES | Required by SES. Use a verified email or domain |

**What you'll learn:**
- SNS is pub/sub. One publish → multiple subscribers receive simultaneously (fan-out). Subscribers: email, SQS, Lambda, HTTP, SMS.
- Fan-out pattern: order confirmed → email customer + update analytics + notify warehouse. Each subscriber is independent. If email fails, analytics still works.
- EventBridge rules do content-based filtering: match events where `detail.newStatus = "CONFIRMED"` and route only those to a specific target.
- The full event chain in this architecture: DynamoDB change → Stream → Lambda → EventBridge → Rule → SNS → SQS → Lambda → SES → Email. This seems like a lot of hops, but each service adds value: decoupling, filtering, fan-out, buffering, retry.

**Cost awareness:** Every status change triggers ~2 Lambda invocations + 1 EventBridge event + 1 SNS publish + 1 SQS message + 1 SES send. For a POC this is pennies. At scale (millions of orders/day), evaluate whether you can simplify — e.g., stream processor publishes directly to SNS if you don't need EventBridge's routing flexibility.

**Tasks:**
- [ ] Verify recipient email address in SES (AWS Console → SES → Verified identities)
- [ ] Create SNS topic (`order-notifications`) in ApplicationStack
- [ ] Create EventBridge rules on the custom bus:
  - `OrderStatusChanged` where `detail.newStatus = "CONFIRMED"` → SNS
  - `OrderStatusChanged` where `detail.newStatus = "SHIPPED"` → SNS
  - `OrderStatusChanged` where `detail.newStatus = "CANCELLED"` → SNS
- [ ] Create SQS queue subscribed to SNS topic (SNS → SQS → Lambda pattern)
- [ ] Update Phase 4's `notification-sender` Lambda:
  - Now triggered via: EventBridge → SNS → SQS → Lambda (instead of direct SQS send)
  - Parse SNS message envelope from SQS
  - Format email based on status (different template per status)
  - Send via SES (`@aws-sdk/client-ses`)
  - Idempotency still applies (same notificationId check)
- [ ] Grant SES `SendEmail` permission to the notification Lambda
- [ ] Test:
  - Update order to CONFIRMED → receive formatted email
  - Update order to SHIPPED → receive different email
  - Update order to CANCELLED → receive cancellation email
  - Check end-to-end flow in X-Ray (Phase 10 will add tracing, but CloudWatch Logs work for now)

**Key concept — Fan-out architecture:**
```
DynamoDB Order Table
    │ (status changed)
    ▼
DynamoDB Stream → Stream Processor Lambda → EventBridge (order-events bus)
                                                │
                              ┌─────────────────┼─────────────────┐
                              │                 │                 │
                    ┌─────────▼──────┐  ┌───────▼────────┐  ┌────▼──────────┐
                    │ Rule: CONFIRMED │  │ Rule: SHIPPED  │  │Rule: CANCELLED│
                    └─────────┬──────┘  └───────┬────────┘  └────┬──────────┘
                              │                 │                 │
                              └────────┬────────┘─────────┬──────┘
                                       │                  │
                                 ┌─────▼─────┐    ┌──────▼──────┐
                                 │ SNS Topic │    │ (Future:    │
                                 │ order-    │    │  Analytics  │
                                 │ notifs)   │    │  queue)     │
                                 └─────┬─────┘    └─────────────┘
                                       │
                              ┌────────┼────────┐
                              │        │        │
                        ┌─────▼──┐  ┌──▼───┐  ┌─▼────────┐
                        │  SQS   │  │Email │  │ (Future:  │
                        │  Queue │  │(raw) │  │  Webhook) │
                        └───┬────┘  └──────┘  └──────────┘
                            │
                      ┌─────▼──────┐
                      │ Notif.     │
                      │ Lambda→SES │
                      │(formatted) │
                      └────────────┘
```

---

### Phase 7 — Step Functions (Order Workflow Orchestration + Saga Pattern)

**Goal:** Orchestrate the full order lifecycle as a state machine: validate → reserve inventory → process payment → confirm order. Implement the Saga pattern with compensating transactions on failure.

> **Relationship with Phase 4:** Phase 4 uses SQS for async notification delivery (fire-and-forget). Phase 7 uses Step Functions for order processing orchestration (workflow with coordination, error handling, and compensation). These are complementary patterns solving different problems. SQS is for decoupled messaging. Step Functions is for coordinated workflows.

**Serverless concepts:**
- Step Functions state machine (Standard workflow)
- Saga pattern with compensating transactions
- Task states, Choice states, Catch/Retry
- Workflow orchestration vs choreography

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| Saga pattern with compensation | If payment fails after inventory was reserved, automatically release inventory. Without compensation, you leak reserved stock |
| Standard workflow (not Express) | Exactly-once execution. Order processing must not run twice. Standard also gives visual execution history |
| CDK `stepfunctions-tasks.LambdaInvoke` | CDK automatically creates IAM permissions for each task. No manual role configuration |
| ResultPath to pass data between steps | Each step adds its result to the state without overwriting previous data |
| Task-level retry with exponential backoff | Payment gateway might be temporarily down. Retry 3 times before giving up |
| Input validation as first step | Fail fast — don't reserve inventory for an invalid order |

**What you'll learn:**
- Step Functions is a serverless orchestrator. Define a workflow as a state machine — AWS manages execution, retry, error handling, and visual monitoring.
- Why not chain Lambdas? Lambda A calling B calling C: you pay for A's idle time while waiting for B and C. Step Functions calls each independently — pay only for compute. Plus: built-in retry, visual history, timeout management.
- Saga pattern: When a multi-step process fails midway, you need to undo the completed steps. This is called a "compensating transaction." Example: payment fails → release the inventory that was already reserved.
- Standard vs Express: Standard = long-running (up to 1 year), exactly-once, visual history, $0.025 per 1000 state transitions. Express = short-running (up to 5 min), at-least-once, no visual history, $0.00001667 per second. Use Standard when correctness matters.

**Tasks:**
- [ ] Create Step Function state machine in ApplicationStack:
  ```
  ValidateOrder → ReserveInventory → ProcessPayment → ConfirmOrder → Success
       │                │                  │
       ▼                ▼                  ▼
   InvalidOrder    NoStockAvail.     PaymentFailed
       │                │                  │
       ▼                ▼                  ▼
   CancelOrder     CancelOrder    ReleaseInventory → CancelOrder
  ```
- [ ] Create/update Lambda handlers:
  - `validate-order` — Check order exists, status is PENDING, product exists
  - `reserve-inventory` — Decrement stock with DynamoDB conditional expression (`quantity >= orderQuantity`)
  - `payment-processor` — Simulated: 80% success, 20% failure (random)
  - `confirm-order` — Update order status to CONFIRMED
  - `release-inventory` — Increment stock back (compensation)
  - `cancel-order` — Update order status to CANCELLED
- [ ] Modify `POST /orders`:
  1. Create order in DynamoDB (status = PENDING)
  2. Start Step Function execution (pass orderId)
  3. Return 201 with orderId (client polls `GET /orders/{orderId}` for status updates)
- [ ] Configure task-level retries:
  - `ProcessPayment`: retry 3 times, exponential backoff, 2s interval
  - `ReserveInventory`: retry 2 times (might be a transient DynamoDB throttle)
- [ ] Add `ResultPath` to accumulate state through the workflow
- [ ] Test all paths:
  - ✅ Happy path: valid order → inventory reserved → payment success → CONFIRMED
  - ❌ Invalid order: bad orderId or missing product → CANCELLED (no inventory touched)
  - ❌ No stock: inventory check fails → CANCELLED (no payment attempted)
  - ❌ Payment failed: payment declined → inventory released → CANCELLED
- [ ] Verify in Step Functions Console: visual execution graph for each path
- [ ] Update CDK tests

**Key concept — Saga pattern (compensating transactions):**
```
Happy Path:                              Payment Failure (Saga compensation):
─────────                                ──────────────────────────────────
1. Validate Order ✓                      1. Validate Order ✓
2. Reserve Inventory ✓ (stock: 10→8)     2. Reserve Inventory ✓ (stock: 10→8)
3. Process Payment ✓                     3. Process Payment ✗ (declined!)
4. Confirm Order ✓ (CONFIRMED)              │
   DONE                                     ▼ Compensation:
                                          4. Release Inventory (stock: 8→10) ← UNDO step 2
                                          5. Cancel Order (CANCELLED)
                                             DONE

Without Saga: stock stays at 8 forever. Customer can't reorder. Stock leaked. 🔥
With Saga: stock restored to 10. Order cancelled cleanly. Customer can retry. ✓
```

**Key concept — Orchestration vs Choreography:**
```
Orchestration (Step Functions):              Choreography (Events):
────────────────────────────                 ─────────────────────
Central coordinator knows the                Each service reacts to events
full workflow and drives each step.          independently. No central controller.

✓ Clear workflow visualization               ✓ Loose coupling
✓ Built-in error handling & compensation     ✓ Easy to add new consumers
✓ Easy to understand the full flow           ✗ Hard to trace the full flow
✗ Single point of coordination               ✗ Compensation is complex
✗ Tighter coupling to coordinator            ✗ Debugging requires correlation IDs

We use BOTH: Step Functions orchestrates the order workflow (Phases 7),
EventBridge choreographs reactions to events (Phases 5-6).
```

---

### Phase 8 — S3 Event Trigger (Bulk Order Import)

**Goal:** Upload a JSON file to S3 → triggers Lambda → creates multiple orders via Step Functions.

**Serverless concepts:**
- S3 event notifications → Lambda trigger
- File processing with Lambda
- Batch operations with error handling

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| S3 prefix filtering (`imports/`) | Only trigger on files in the right folder. Avoids triggering on error reports or other files |
| `BlockPublicAccess.BLOCK_ALL` | Prevent accidental public exposure. CDK default since 2023, but be explicit |
| `BucketEncryption.S3_MANAGED` | Encryption at rest. Free and automatic |
| Lifecycle rule (expire after 30 days) | Don't accumulate import files forever. Keeps costs down |
| Error records written to `errors/` prefix | Failed records aren't lost — write them to S3 for review and re-import |
| Deduplication via import file name | Use the S3 object key as an idempotency key — processing the same file twice doesn't create duplicate orders |
| Lambda reserved concurrency: 1 | Bulk import shouldn't consume all Lambda capacity. Process one file at a time |

**What you'll learn:**
- S3 event notifications fire when objects are created, deleted, or modified in a bucket. Lambda subscribes to these events — no polling, no cron, instant and reactive.
- S3 → Lambda is the standard pattern for file processing: image resizing, CSV parsing, data import, log analysis.
- Lambda limits to consider: 15-minute max timeout, /tmp has 512MB (configurable to 10GB), 6MB response payload. For very large files, use S3 → SQS → Lambda to process in chunks.
- Setting reserved concurrency to 1 means only one import can run at a time. If multiple files are uploaded simultaneously, they queue up. This protects downstream services from burst load.

**Tasks:**
- [ ] Create S3 bucket in ApplicationStack:
  - `blockPublicAccess: BlockPublicAccess.BLOCK_ALL`
  - `encryption: BucketEncryption.S3_MANAGED`
  - `lifecycleRules: [{ expiration: Duration.days(30), prefix: 'imports/' }]`
  - `removalPolicy: RemovalPolicy.DESTROY` (POC only)
  - `autoDeleteObjects: true` (POC only)
- [ ] Create `bulk-import` Lambda triggered by S3 `ObjectCreated` events on `imports/` prefix
  - `reservedConcurrentExecutions: 1`
  - `timeout: Duration.minutes(5)`
- [ ] Lambda implementation:
  1. Read JSON file from S3
  2. Validate structure (Zod schema for the import file)
  3. For each order: start a Step Function execution (reuse Phase 7 workflow)
  4. Collect results: track success/failure per order
  5. Write summary to `results/` prefix
  6. Write failed records to `errors/` prefix with error details
- [ ] Test:
  - Upload valid JSON with 5 orders → verify 5 Step Function executions start
  - Upload JSON with mix of valid/invalid orders → verify error file created
  - Upload same file twice → verify idempotency (no duplicate orders)
  - Upload to wrong prefix → verify Lambda NOT triggered
- [ ] Update CDK tests

**Input file format:**
```json
{
  "importId": "import-2025-01-15-001",
  "orders": [
    { "customerId": "user-1", "productId": "prod-1", "quantity": 2 },
    { "customerId": "user-2", "productId": "prod-2", "quantity": 1 },
    { "customerId": "user-3", "productId": "prod-999", "quantity": 1 }
  ]
}
```

**Result file (written to `results/`):**
```json
{
  "importId": "import-2025-01-15-001",
  "totalOrders": 3,
  "successful": 2,
  "failed": 1,
  "failures": [
    { "index": 2, "customerId": "user-3", "error": "Product prod-999 not found" }
  ]
}
```

---

### Phase 9 — Scheduled Events (Stale Order Cleanup)

**Goal:** EventBridge scheduled rule triggers Lambda every 30 minutes to cancel stale PENDING orders.

**Serverless concepts:**
- EventBridge Scheduler (cron/rate expressions)
- DynamoDB GSI query vs table scan
- Batch processing with DynamoDB BatchWriteItem

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| GSI query instead of table scan | `status = PENDING AND createdAt < threshold` is a fast, efficient Query on the GSI. A Scan reads every item in the table — slow and expensive at scale |
| EventBridge Scheduler (not CloudWatch Events) | Newer service, supports one-time schedules, flexible time windows, dead-letter queues for failed invocations |
| Paginated query | GSI query might return more items than can be processed in one Lambda invocation. Use `LastEvaluatedKey` to paginate |
| Batch write for updates | Use `BatchWriteItem` or parallel `UpdateItem` calls to update multiple orders efficiently |
| Compensation: release reserved inventory | Don't just cancel orders — release the inventory that was reserved in Phase 7 |

**What you'll learn:**
- EventBridge Scheduler is the serverless cron. No server to keep running — define a schedule, it invokes your target. Rate expressions (`rate(30 minutes)`) or full cron (`cron(0/30 * * * ? *)`).
- GSI (Global Secondary Index) lets you query DynamoDB by an alternative key pattern. The `status-createdAt-index` lets us efficiently find all PENDING orders older than 30 minutes. Without it, you'd Scan the entire table — reading every item and filtering client-side.
- GSIs are eventually consistent (slight delay, usually <1 second). Fine for cleanup jobs. If you need strong consistency, query the main table.

**Tasks:**
- [ ] Create `stale-order-cleanup` Lambda:
  1. Query `status-createdAt-index` where `status = PENDING AND createdAt < (now - 30 min)`
  2. Paginate results (handle `LastEvaluatedKey`)
  3. For each stale order:
     - Release reserved inventory (increment stock)
     - Update order status to CANCELLED
  4. Log summary: how many orders cancelled
- [ ] Create EventBridge scheduled rule: `rate(30 minutes)`
- [ ] Grant Lambda: read on Order GSI, write on Order table, write on Inventory table
- [ ] Test:
  - Create PENDING order with old timestamp (or lower the threshold temporarily)
  - Trigger Lambda manually (`aws lambda invoke ...`)
  - Verify order cancelled and inventory released
  - Verify scheduled rule exists and is enabled
- [ ] Update CDK tests

**Key concept — GSI query vs Scan:**
```
Table Scan (without GSI):                 GSI Query:
─────────────────────                     ──────────
Read ALL items in table                   Read ONLY matching items
Filter client-side                        DynamoDB filters server-side
100,000 items → reads 100,000             100,000 items → reads 50 (if 50 match)
Cost: 100,000 RCU                         Cost: 50 RCU
Time: seconds                             Time: milliseconds

GSI trade-off: extra storage cost and write capacity (DynamoDB replicates data to GSI).
But query savings dwarf the GSI cost for any non-trivial table size.
```

---

### Phase 10 — Observability (CloudWatch + X-Ray + Powertools)

**Goal:** Add distributed tracing, custom metrics, CloudWatch dashboards, and alarms across all services. Powertools Logger was added in Phase 2 — now we complete the observability picture.

**Serverless concepts:**
- X-Ray distributed tracing
- CloudWatch custom metrics and dashboards
- CloudWatch alarms and anomaly detection
- Lambda Powertools (tracer + metrics)

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| Powertools Tracer (X-Ray) | Automatically traces DynamoDB, SQS, HTTP calls. See latency at each hop across the entire request path |
| Powertools Metrics (EMF) | Embedded Metric Format — emit metrics inside log entries. CloudWatch extracts them automatically. No separate PutMetric API calls needed |
| Active tracing on API Gateway | Trace the full path: Client → API GW → Lambda → DynamoDB. See where time is spent |
| Custom metrics for business KPIs | Track orders created, payments failed, inventory reserved — not just Lambda errors |
| Dashboard with operational AND business metrics | Ops: error rate, latency, throttles. Business: orders/min, payment success rate, DLQ depth |
| Composite alarms | Combine multiple alarms: "Lambda errors > 5 AND DLQ depth > 0" = likely systemic issue |

**What you'll learn:**
- X-Ray provides distributed tracing. A single request flows through API Gateway → Lambda → DynamoDB → SQS → Lambda → SES. X-Ray shows the full path as a service map, with latency at each hop and error details.
- Powertools Tracer wraps the AWS SDK and adds X-Ray segments automatically. One decorator/middleware setup and all DynamoDB, SQS, EventBridge calls are traced.
- Powertools Metrics uses Embedded Metric Format (EMF). You emit metrics inside structured log entries — CloudWatch extracts them as custom metrics. No extra API calls, no cost for PutMetricData.
- CloudWatch Alarms trigger when a metric breaches a threshold. Use them for operational alerts (errors, throttles, DLQ depth) and business alerts (payment failure rate).
- CloudWatch Dashboard gives a single-pane view of your system. Build it with the metrics that matter.

**Tasks:**
- [ ] Add `@aws-lambda-powertools/tracer` to all Lambda handlers
  - Annotate segments with orderId, customerId for searchability
  - Capture responses and errors
- [ ] Add `@aws-lambda-powertools/metrics` to key handlers
  - Custom metrics: `OrderCreated`, `OrderConfirmed`, `OrderCancelled`, `PaymentSuccess`, `PaymentFailed`, `InventoryReserved`, `NotificationSent`
  - Dimensions: `service`, `environment`
- [ ] Enable X-Ray active tracing on:
  - API Gateway stage
  - All Lambda functions (`tracing: Tracing.ACTIVE`)
  - DynamoDB tables (auto-traced via SDK)
- [ ] Create CloudWatch Dashboard:
  - API Gateway: request count, latency (p50, p90, p99), 4xx/5xx error rate
  - Lambda: invocations, errors, duration, throttles (per function)
  - DynamoDB: consumed RCU/WCU, throttled requests
  - SQS: messages sent, messages in flight, DLQ depth
  - Step Functions: executions started, succeeded, failed
  - Business: orders created/min, payment success rate
- [ ] Create CloudWatch Alarms:
  - Lambda errors > 5 in 5 minutes → SNS notification
  - DLQ message count > 0 → SNS notification
  - API Gateway 5xx > 10 in 5 minutes → SNS notification
  - Step Functions failed executions > 3 in 5 minutes → SNS notification
- [ ] Test:
  - Trigger a failure → verify alarm fires
  - Create several orders → verify custom metrics appear in CloudWatch
  - Trace a full order flow in X-Ray Console (API GW → Lambda → DynamoDB → Stream → EventBridge → SNS → SQS → Lambda → SES)
- [ ] Update CDK tests

**Key concept — Structured log entry with Powertools:**
```json
{
  "level": "INFO",
  "message": "Order created successfully",
  "service": "order-service",
  "environment": "dev",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "xray_trace_id": "1-67890abc-def0123456789",
  "function_name": "CreateOrder",
  "function_memory_size": 256,
  "cold_start": true,
  "orderId": "ord-abc-123",
  "customerId": "user-456",
  "totalAmount": 49.98
}
```

**Key concept — X-Ray service map (what you'll see):**
```
Client → API Gateway (12ms) → CreateOrder Lambda (45ms) → DynamoDB (8ms)
                                    │
                                    └→ Step Functions (started)
                                           │
                                    ValidateOrder Lambda (15ms) → DynamoDB (5ms)
                                           │
                                    ReserveInventory Lambda (22ms) → DynamoDB (7ms)
                                           │
                                    ProcessPayment Lambda (120ms)
                                           │
                                    ConfirmOrder Lambda (18ms) → DynamoDB (6ms)
                                           │
                                    DynamoDB Stream → StreamProcessor Lambda (25ms)
                                           │                              │
                                           └→ EventBridge (3ms) → SNS (8ms) → SQS → NotifLambda (35ms) → SES
```

---

### Phase 11 — CI/CD with GitHub Actions

**Goal:** Automate build, test, and deploy on push to main. Diff on PR. OIDC authentication (no long-lived secrets).

**Serverless concepts:**
- Infrastructure as Code deployment pipeline
- OIDC federation (GitHub → AWS)
- Automated testing and deployment

**Best practices & patterns used:**
| Pattern | Why |
|---------|-----|
| OIDC federation (not IAM access keys) | No long-lived credentials stored in GitHub Secrets. GitHub gets temporary credentials by assuming an IAM role. If leaked, they expire quickly |
| `cdk diff` on PR | Show what infrastructure changes a PR will make BEFORE merging. Reviewers can catch risky changes (e.g., table deletion) |
| `cdk diff` before `cdk deploy` | Safety check — see exactly what will change before applying |
| Separate workflows for PR vs main | PR: build + test + diff (don't deploy). Main: build + test + diff + deploy |
| `pnpm install --frozen-lockfile` (not `pnpm install`) | Deterministic installs from lock file. Prevents "works on my machine" issues |
| CDK synth as a validation step | Synthesizing CloudFormation templates catches CDK errors before deployment |
| Concurrency control | Prevent parallel deployments to the same stack. Use GitHub Actions concurrency groups |

**What you'll learn:**
- GitHub Actions runs workflows in response to events (push, PR, manual trigger). Each workflow has jobs → steps.
- OIDC: Instead of storing AWS access keys as GitHub Secrets (long-lived, risky), you create a trust relationship. GitHub proves its identity to AWS using a signed token, AWS issues temporary credentials. If the token leaks, it expires in minutes.
- `cdk diff` shows exactly what CloudFormation changes will be applied — new resources, modified properties, deleted resources. This is your safety net.
- Pipeline stages: install → build → test → synth → diff → deploy. Each stage gates the next. Failed tests = no deploy.

**Tasks:**
- [ ] Create IAM OIDC Identity Provider for GitHub in AWS:
  - Provider URL: `https://token.actions.githubusercontent.com`
  - Audience: `sts.amazonaws.com`
- [ ] Create IAM Role for GitHub Actions:
  - Trust policy: allow GitHub OIDC provider, restrict to your repo
  - Permissions: CDK deployment permissions (CloudFormation, S3, IAM, Lambda, etc.)
- [ ] Create `.github/workflows/deploy.yml`:
  ```yaml
  on:
    push:
      branches: [main]
  jobs:
    deploy:
      runs-on: ubuntu-latest
      permissions:
        id-token: write
        contents: read
      concurrency:
        group: deploy-${{ github.ref }}
        cancel-in-progress: false
      steps:
        - Checkout
        - Setup Node.js 20
        - Setup pnpm
        - pnpm install --frozen-lockfile
        - pnpm run build
        - pnpm test
        - Configure AWS credentials (OIDC)
        - pnpm cdk synth
        - pnpm cdk diff
        - pnpm cdk deploy --all --require-approval never
  ```
- [ ] Create `.github/workflows/pr-check.yml`:
  ```yaml
  on:
    pull_request:
      branches: [main]
  jobs:
    check:
      steps:
        - Checkout
        - Setup Node.js 20
        - Setup pnpm
        - pnpm install --frozen-lockfile
        - pnpm run build
        - pnpm test
        - Configure AWS credentials (OIDC)
        - pnpm cdk synth
        - pnpm cdk diff (comment on PR)
  ```
- [ ] Add GitHub repository secrets:
  - `AWS_ACCOUNT_ID`
  - `AWS_DEPLOY_ROLE_ARN`
- [ ] Test:
  - Create a PR → verify build + test + diff runs, diff appears as PR comment
  - Merge to main → verify deploy runs successfully
  - Introduce a build error → verify pipeline fails and doesn't deploy
- [ ] (Optional) Add manual approval step using GitHub Environments

**Pipeline flow:**
```
Pull Request:
─────────────
PR opened/updated → GitHub Actions
    ├── pnpm install --frozen-lockfile
    ├── pnpm run build (tsc)
    ├── pnpm test (jest)
    ├── cdk synth (validate templates)
    └── cdk diff → Post as PR comment
        (reviewer sees: "Will create 2 Lambdas, modify 1 IAM role")

Merge to main:
──────────────
Push to main → GitHub Actions
    ├── pnpm install --frozen-lockfile
    ├── pnpm run build
    ├── pnpm test
    ├── cdk synth
    ├── cdk diff (logged for audit)
    └── cdk deploy --all
        ├── SharedStack (if changed)
        └── ApplicationStack (if changed)
```

---

## Execution Order Summary

| Phase | Concept | Key Patterns | Estimated Effort |
|-------|---------|-------------|------------------|
| 1 | CDK Setup + DynamoDB | IaC, table design, GSIs, on-demand billing | 1-2 hours |
| 2 | API Gateway + Lambda CRUD | Proxy integration, least-privilege IAM, input validation, Powertools Logger, esbuild bundling | 2-3 hours |
| 3 | Cognito Authentication | JWT authorizer, token-based auth, claims extraction | 1-2 hours |
| 4 | SQS Async Processing | Async decoupling, DLQ, idempotency, reserved concurrency, at-least-once delivery | 2-3 hours |
| 5 | DynamoDB Streams + EventBridge | CDC, event-driven architecture, stream error handling, custom event bus | 2-3 hours |
| 6 | SNS Fan-out + SES Email | Pub/sub, fan-out, content-based filtering, SES sandbox | 1-2 hours |
| 7 | Step Functions Orchestration | Saga pattern, compensation, state machine, orchestration vs choreography | 3-4 hours |
| 8 | S3 Bulk Import | Event-driven file processing, batch operations, deduplication | 1-2 hours |
| 9 | Scheduled Events | Serverless cron, GSI queries, batch cleanup | 1-2 hours |
| 10 | Observability | X-Ray tracing, custom metrics (EMF), dashboards, alarms | 2-3 hours |
| 11 | CI/CD GitHub Actions | OIDC federation, automated deploy, PR diff | 1-2 hours |
| **Total** | | | **~17-28 hours** |

---

## Serverless Concepts Covered (Checklist)

By the end of this project, you'll have hands-on experience with:

| Concept | Phase | Service/Tool |
|---------|-------|-------------|
| Infrastructure as Code | 1 | CDK (TypeScript) |
| NoSQL database design | 1 | DynamoDB (tables, GSIs, streams) |
| REST API | 2 | API Gateway |
| Serverless compute | 2 | Lambda (Node.js 20) |
| Input validation | 2 | Zod + API Gateway models |
| Least-privilege IAM | 2 | CDK grant methods |
| Authentication & authorization | 3 | Cognito User Pool + JWT |
| Async messaging | 4 | SQS + DLQ |
| Idempotency | 4 | Powertools Idempotency |
| Concurrency management | 4 | Reserved concurrency |
| Change data capture | 5 | DynamoDB Streams |
| Event-driven architecture | 5 | EventBridge custom bus |
| Pub/sub fan-out | 6 | SNS |
| Transactional email | 6 | SES |
| Workflow orchestration | 7 | Step Functions |
| Saga / compensation | 7 | Step Functions Catch/Retry |
| File-driven processing | 8 | S3 event notifications |
| Scheduled jobs | 9 | EventBridge Scheduler |
| Distributed tracing | 10 | X-Ray + Powertools Tracer |
| Custom metrics | 10 | Powertools Metrics (EMF) |
| Dashboards & alarms | 10 | CloudWatch |
| CI/CD pipeline | 11 | GitHub Actions |
| Secure credential federation | 11 | OIDC (GitHub ↔ AWS) |

---

## Notes

- Each phase builds on the previous one. Complete them in order.
- After each phase, deploy (`cdk deploy`) and test before moving to the next.
- SharedStack evolves across phases: tables in Phase 1, Cognito in Phase 3.
- ApplicationStack grows with each phase from Phase 2 onward.
- All resources use serverless/on-demand pricing — minimal cost for a POC.
- **POC cleanup:** `cdk destroy --all` removes everything. This works because we set `RemovalPolicy.DESTROY` and `autoDeleteObjects: true`. **Never use these settings in production.**
- See [TECH-DECISIONS.md](./TECH-DECISIONS.md) for detailed comparison of every technology and pattern choice with alternatives.
