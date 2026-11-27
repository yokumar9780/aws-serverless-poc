# Technology & Pattern Decisions

This document lists every technology, service, pattern, and tool selected for the AWS Serverless POC, with alternatives and cost comparison. Use this as a reference to understand **why** we chose what we chose and **what else** could achieve the same goal.

---

## Table of Contents

1. [Infrastructure & Deployment](#1-infrastructure--deployment)
2. [Compute](#2-compute)
3. [API Layer](#3-api-layer)
4. [Database](#4-database)
5. [Authentication](#5-authentication)
6. [Messaging & Queuing](#6-messaging--queuing)
7. [Event Bus](#7-event-bus)
8. [Notifications](#8-notifications)
9. [Workflow Orchestration](#9-workflow-orchestration)
10. [File Storage & Processing](#10-file-storage--processing)
11. [Scheduling](#11-scheduling)
12. [Observability](#12-observability)
13. [CI/CD](#13-cicd)
14. [Code Patterns & Libraries](#14-code-patterns--libraries)
15. [Cost Summary](#15-cost-summary)

---

## 1. Infrastructure & Deployment

### Selected: AWS CDK (TypeScript)

**What it does:** Define AWS infrastructure in TypeScript. CDK synthesizes it into CloudFormation templates and deploys.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **AWS CDK (TypeScript)** ✅ | IaC | Real programming language (loops, conditions, classes). L2 constructs have smart defaults. Same language as Lambda code. Strong typing catches errors at compile time | Tied to AWS. Steeper learning curve than SAM. CloudFormation limits apply | Free (open-source) |
| AWS SAM | IaC (YAML) | Simpler for basic serverless apps. `sam local` for local testing. Smaller template files | YAML only. Limited abstractions. No real programming constructs. Hard for complex infra | Free |
| Terraform | IaC (HCL) | Multi-cloud. Huge provider ecosystem. State management. Mature tooling | HCL is another language to learn. No AWS-native abstractions. State file management | Free (open-source), Terraform Cloud: $20/user/mo |
| Pulumi | IaC | Multi-cloud. Real programming languages. Similar to CDK concept | Smaller community. State management. Less AWS-native than CDK | Free (open-source), Team: $50/user/mo |
| AWS Console (manual) | Manual | Quick for one-off resources | Not reproducible. No version control. Error-prone. Doesn't scale | Free |
| CloudFormation (raw) | IaC (YAML/JSON) | Native AWS. No extra tooling needed | Verbose. No abstractions. YAML/JSON only. Painful for complex infra | Free |
| SST (Serverless Stack) | IaC | Built on CDK. Live Lambda development. Great DX | Smaller community. Extra abstraction layer. Opinionated | Free (open-source) |

**Why CDK:** Same language (TypeScript) for infrastructure and Lambda code. L2 constructs handle IAM, networking, and configuration automatically. Best balance of power and AWS-native integration.

---

## 2. Compute

### Selected: AWS Lambda (Node.js 20, TypeScript + esbuild)

**What it does:** Run code without provisioning servers. Pay per invocation and duration.

| Option | Type | Pros | Cons | Cost (eu-west-1) |
|--------|------|------|------|-------------------|
| **AWS Lambda** ✅ | Serverless function | Zero server management. Scales to thousands. Pay per use. Sub-second billing | 15-min max timeout. Cold starts. 256MB-10GB memory. Stateless | First 1M requests free, then $0.20/1M. $0.0000166667/GB-second |
| AWS Fargate (ECS) | Serverless container | No timeout limit. Full Docker support. More memory/CPU options | Minimum charge per task (~$0.01). Slower scaling. More config | $0.04048/vCPU/hr + $0.004445/GB/hr |
| AWS App Runner | Managed container | Simplest container deployment. Auto-scaling. Built-in HTTPS | Less flexible. Limited VPC options. Fewer event sources | $0.064/vCPU/hr + $0.007/GB/hr |
| EC2 | Server | Full control. Any runtime. No cold starts | Server management. Patching. Over-provisioning waste. Always-on cost | t3.micro: ~$8.50/mo (on-demand) |
| EKS (Kubernetes) | Container orchestration | Full Kubernetes. Multi-cloud portable. Rich ecosystem | Complex. Expensive control plane ($73/mo). Overkill for POC | $0.10/hr control plane + node costs |

**Why Lambda:** True serverless — zero cost at zero traffic. Perfect for event-driven workloads (API calls, SQS messages, S3 events, scheduled jobs). Cold starts are acceptable for this use case (~200ms Node.js).

### Bundling: esbuild via NodejsFunction

| Option | Pros | Cons |
|--------|------|------|
| **esbuild (CDK NodejsFunction)** ✅ | Blazing fast builds. Tree-shaking. TypeScript compilation built-in. Smallest bundles → fastest cold starts | Doesn't support all TypeScript decorators |
| webpack | Mature. Plugin ecosystem. Highly configurable | Slower builds. Complex config. Overkill for Lambda |
| Lambda Layer | Share code across functions. Separate deployment lifecycle | Complex packaging. Can't tree-shake. Layer limits (5 per function, 250MB unzipped) |
| Docker image (Lambda container) | Full control. Up to 10GB. Any dependencies | Slower cold starts. More complex build. ECR cost |

**Why esbuild:** CDK's `NodejsFunction` uses esbuild by default. Fast builds, small bundles, tree-shaking, TypeScript out of the box. No config needed.

---

## 3. API Layer

### Selected: API Gateway REST API

**What it does:** Managed API endpoint with routing, throttling, validation, auth, and CORS.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **API Gateway REST API** ✅ | Managed API | Request validation, usage plans, API keys, WAF integration, caching, request/response transformation | Higher latency (~15-30ms overhead). More expensive than HTTP API | $3.50/million requests + data transfer |
| API Gateway HTTP API | Managed API | Lower latency (~10ms). Cheaper. JWT authorizer built-in. Simpler | No request validation models. No usage plans. No caching. Fewer integrations | $1.00/million requests |
| Application Load Balancer | Load balancer | Lower per-request cost at high volume. WebSocket support. gRPC | No request validation. No throttling. No API key management. Need Fargate/EC2 behind it | $0.0225/hr + $0.008/LCU-hr |
| Lambda Function URLs | Direct Lambda | Simplest setup. No API Gateway needed. Free (Lambda cost only) | No throttling. No request validation. No auth integration. No custom domain built-in | Free (Lambda cost only) |
| AppSync (GraphQL) | Managed GraphQL | Real-time subscriptions. Automatic DynamoDB resolvers. Schema-first | GraphQL learning curve. Not REST. More complex for simple CRUD | $4.00/million queries + real-time connection fees |

**Why REST API (not HTTP API):** REST API has request validation models, usage plans, caching, and WAF integration. These are important concepts for learning and production. HTTP API is cheaper but lacks these features. For a POC with low traffic, the cost difference is negligible (<$1/month).

---

## 4. Database

### Selected: DynamoDB (On-Demand)

**What it does:** Fully managed NoSQL database. Single-digit millisecond latency at any scale.

| Option | Type | Pros | Cons | Cost (on-demand) |
|--------|------|------|------|-------------------|
| **DynamoDB (On-Demand)** ✅ | NoSQL | Zero management. Millisecond latency. Auto-scaling. Streams. TTL. Global tables | No joins. Access pattern design required upfront. Query flexibility limited vs SQL | $1.25/million writes, $0.25/million reads. Storage: $0.25/GB/mo |
| DynamoDB (Provisioned) | NoSQL | Cheaper at steady, predictable workloads. Reserved capacity discounts | Must predict capacity. Auto-scaling has lag. Under-provision → throttling | From $0.00065/WCU/hr |
| Aurora Serverless v2 | Relational | SQL. Joins. ACID transactions. Scales to zero. Familiar model | Minimum ~$43/mo (0.5 ACU). Cold starts. VPC required. More complex IAM | $0.12/ACU-hour (min 0.5 ACU) |
| RDS (Postgres/MySQL) | Relational | Full SQL. Mature ecosystem. Tools available | Always-on instance cost. Server management. Not truly serverless | t3.micro: ~$15/mo + storage |
| ElastiCache (Redis) | In-memory | Sub-millisecond latency. Caching. Pub/sub | Not a primary database. Always-on cost. VPC required | t3.micro: ~$13/mo |
| S3 + Athena | Data lake | Cheap storage. SQL queries on files. Good for analytics | High query latency. Not for transactional workloads | S3: $0.023/GB/mo. Athena: $5/TB scanned |

**Why DynamoDB On-Demand:** True serverless — pay per request, scales to zero. Perfect for POC with unpredictable traffic. No capacity planning needed. Streams built-in for CDC.

### Table Design: Single-Table-Per-Entity (not Single-Table Design)

| Approach | Pros | Cons |
|----------|------|------|
| **One table per entity** ✅ | Intuitive. Easy to learn. Clear IAM boundaries per table. Easier to monitor | More tables to manage. Can't do cross-entity transactions in one table |
| Single-table design | Fewer tables. Cross-entity transactions. Efficient for related queries | Complex. Hard to learn. PK/SK overloading. Hard to evolve. IAM less granular |

**Why per-entity:** This is a learning project. Single-table design is powerful but advanced — it requires knowing ALL access patterns upfront. Per-entity tables are easier to understand, modify, and debug.

---

## 5. Authentication

### Selected: Cognito User Pool + JWT Authorizer

**What it does:** Managed user sign-up/sign-in with JWT token-based API authentication.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **Cognito User Pool** ✅ | Managed auth | Zero server. Handles signup, signin, MFA, password policy, tokens. JWT validation at API Gateway level | Limited customization. Migration pain. Vendor lock-in | First 50,000 MAU free, then $0.0055/MAU |
| Auth0 | Third-party auth | Better UX. More customization. Universal login. M2M tokens | External dependency. Cost at scale. Additional latency | Free up to 7,500 MAU, then $23/mo+ |
| AWS IAM + SigV4 | AWS-native | Fine-grained AWS permissions. No separate auth service | Only for AWS SDK clients. Not for browser/mobile apps. Complex for external users | Free |
| Custom JWT (Lambda authorizer) | Custom | Full control. Any identity provider. Custom claims | Build and maintain yourself. Security risk if done wrong. Token management | Lambda cost only |
| API Keys (API Gateway) | Simple | Easy setup. Per-key throttling and usage plans | Not secure for user authentication. Keys in client = leaked. No user identity | Free (API Gateway feature) |

**Why Cognito:** AWS-native. Free tier covers POC. JWT authorizer rejects bad tokens before Lambda runs (cost saving). No infrastructure to manage. Handles the full auth lifecycle.

---

## 6. Messaging & Queuing

### Selected: SQS (Standard Queue) + DLQ

**What it does:** Fully managed message queue. Decouples producers from consumers. Buffering and retry.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **SQS Standard** ✅ | Message queue | At-least-once delivery. Unlimited throughput. DLQ support. Batching. 14-day retention | At-least-once (need idempotency). No ordering guarantee. No message replay | First 1M requests/mo free, then $0.40/million |
| SQS FIFO | Ordered queue | Exactly-once processing. Ordered delivery. Message groups | 300 messages/sec (3,000 with batching). Higher cost. More complex | $0.50/million requests |
| Amazon MQ (RabbitMQ) | Managed broker | AMQP protocol. Complex routing. Topic exchanges. Compatible with existing RabbitMQ apps | Server-based (not serverless). Always-on cost. Management overhead | mq.m5.large: ~$180/mo |
| Amazon MSK (Kafka) | Event streaming | High throughput. Replay. Ordering. Consumer groups. Event sourcing | Not serverless (MSK Serverless exists but limited). Complex. Expensive at small scale | Serverless: $0.10/hr + data |
| Amazon Kinesis Data Streams | Event streaming | Real-time streaming. Replay (up to 365 days). Ordering per shard | Shard management. Minimum cost even at zero traffic. More complex than SQS | $0.015/shard/hr + $0.014/million PUT |
| EventBridge Pipes | Managed routing | Connects sources to targets with filtering and enrichment. No code needed | Limited sources/targets. Newer service. Less community knowledge | $0.40/million invocations |

**Why SQS Standard:** Simplest queue service. Free tier covers POC. At-least-once delivery teaches idempotency pattern. DLQ support built-in. Perfect for fire-and-forget async workloads.

**When to use FIFO instead:** When message ordering matters (e.g., process events for the same order in sequence) and you need exactly-once processing. For notifications, ordering doesn't matter — Standard is fine.

---

## 7. Event Bus

### Selected: Amazon EventBridge (Custom Event Bus)

**What it does:** Serverless event bus. Publish events, rules route them to targets based on patterns.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **EventBridge (Custom Bus)** ✅ | Serverless event bus | Content-based filtering. Schema registry. Archive & replay. 200+ AWS targets. Cron scheduling | 256KB max event size. ~500ms latency. $1/million events | $1.00/million custom events |
| SNS (as event bus) | Pub/sub | Lower latency (~30ms). Simpler. Fan-out built-in. Filter policies | No schema registry. No archive/replay. Limited filtering (attribute-based only) | First 1M publishes free, then $0.50/million |
| Amazon MSK / Kafka | Event streaming | Full replay. Ordering. Consumer groups. High throughput. Event sourcing | Not serverless at small scale. Complex. High minimum cost | Serverless: $0.10/hr+ |
| Kinesis Data Streams | Event streaming | Ordering. Replay. Real-time. Good for high-volume continuous data | Shard management. Always-on cost. Limited integrations | $0.015/shard/hr |
| Direct Lambda-to-Lambda | Direct call | Simplest. No intermediate service | Tight coupling. Caller pays for wait time. No retry/filter. No fan-out | Lambda cost only |

**Why EventBridge:** Best-fit for event-driven serverless architecture. Content-based filtering lets us route different status changes to different targets. Archive & replay is invaluable for debugging. Schema registry documents your event contracts. Custom bus isolates from AWS system events.

---

## 8. Notifications

### Selected: SNS (Fan-out) + SES (Email Delivery)

**What it does:** SNS distributes messages to multiple subscribers. SES sends formatted transactional emails.

### SNS

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **SNS** ✅ | Pub/sub | Fan-out to multiple subscribers. Email, SQS, Lambda, HTTP targets. Filter policies | Raw email format (unless routed through Lambda). No complex routing | First 1M publishes free, then $0.50/million |
| Direct EventBridge → Lambda | Direct | Fewer hops. Simpler. Lower latency | No fan-out. One target per rule (or use multiple rules). No buffering | EventBridge cost + Lambda cost |
| SQS fan-out (multiple queues) | Queue-based | Each consumer has its own buffer and retry. Consumer-paced | Manual wiring. Each new consumer = new queue. No filter policies | SQS cost per queue |

### SES (Email)

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **SES** ✅ | Email service | HTML templates. Delivery tracking. Bounce handling. Highest deliverability | Sandbox mode (verify recipients). Production access requires AWS approval | $0.10/1,000 emails |
| SNS Email (direct) | Simple notification | Zero code. Just subscribe email to topic | Raw JSON/text format. No HTML. No templates. No tracking | $0 (included in SNS) |
| SendGrid | Third-party | Better templates. Analytics. Marketing features. Developer friendly | External dependency. API key management. Cost at scale | Free up to 100/day, then $19.95/mo |
| Amazon Pinpoint | AWS marketing | Campaigns. Segmentation. Analytics. Multi-channel | Complex. Overkill for transactional email. Marketing-focused | $0/email + $0.0012/endpoint/mo |

**Why SNS + SES:** SNS handles fan-out (one event → many subscribers). SES handles formatted email delivery. Together they cover the full notification pipeline. SES is 10× cheaper than third-party alternatives at scale.

---

## 9. Workflow Orchestration

### Selected: Step Functions (Standard Workflow)

**What it does:** Visual workflow orchestrator. Define state machines with retry, error handling, parallel execution, and compensation.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **Step Functions Standard** ✅ | Workflow orchestrator | Visual execution history. Exactly-once. Retry/catch built-in. Up to 1 year execution. IAM per step | $0.025/1,000 state transitions. Can get expensive at high volume | $0.025/1,000 state transitions |
| Step Functions Express | Workflow orchestrator | Cheap ($1/million + duration). Fast (sub-second). Good for high-volume | 5-min max. At-least-once (need idempotency). No visual history | $0.00001667/second of duration |
| Lambda chaining (Lambda calls Lambda) | Custom | Simple. No extra service | Caller pays for idle time. No built-in retry. Tight coupling. Hard to debug | Lambda cost (double for caller) |
| SQS choreography | Event-driven | Loose coupling. Each step independent. Buffering | Hard to track overall flow. Compensation is complex. No visual monitoring | SQS cost per message |
| EventBridge choreography | Event-driven | Loosest coupling. Easy to add steps. Content filtering | Same as SQS + no guaranteed ordering. Harder to implement Saga | EventBridge cost per event |
| AWS Batch | Batch processing | For long-running jobs. Docker containers. Spot pricing | Not real-time. Overkill for lightweight workflows. Minutes to start | Underlying compute cost only |

**Why Standard (not Express):** The order workflow needs exactly-once processing (don't charge a customer twice). Visual execution history is invaluable for debugging. The POC volume is low — cost difference is negligible. In production with high volume, evaluate Express + idempotency.

---

## 10. File Storage & Processing

### Selected: S3 + Lambda Event Notification

**What it does:** Upload file to S3 → triggers Lambda automatically.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **S3 + Lambda notification** ✅ | Event-driven | Instant trigger. No polling. Simple setup. CDK native | One-to-one (one notification config per prefix). Lambda limits apply | S3: $0.023/GB/mo. Lambda: per invocation |
| S3 + EventBridge | Event-driven | Multiple targets per event. Content filtering. Archive | Slightly more complex setup. EventBridge cost added | S3 + $1/million events |
| S3 + SQS + Lambda | Buffered | Buffering. Retry. DLQ. Multiple files queue up | Extra hop. More complex. SQS cost | S3 + SQS + Lambda costs |
| API upload → Lambda → S3 | Synchronous | Client gets immediate response. Can validate before storing | 6MB API Gateway limit. 10MB Lambda limit. Client waits | API Gateway + Lambda cost |
| S3 Transfer Acceleration | Enhanced upload | Faster uploads over long distances. Uses CloudFront edge | Extra cost. Only for upload speed, not processing | $0.04/GB transferred |

**Why S3 + Lambda notification:** Simplest event-driven file processing. Instant, no polling, CDK sets it up with one line. Good enough for a POC. For production with high volume, add SQS between S3 and Lambda for buffering.

---

## 11. Scheduling

### Selected: EventBridge Scheduler

**What it does:** Serverless cron. Invoke Lambda (or other targets) on a schedule.

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **EventBridge Scheduler** ✅ | Managed scheduler | Rate and cron expressions. One-time schedules. DLQ on failure. Flexible time windows | 1-minute minimum granularity. Eventual consistency on schedule changes | Free (target invocation cost only) |
| EventBridge Rules (scheduled) | Managed scheduler | Same cron/rate. CDK L2 support. Simpler for recurring | No one-time schedules. No DLQ. No flexible time windows | Free |
| CloudWatch Events (legacy) | Managed scheduler | Same as EventBridge Rules (old name). Still works | Deprecated in favor of EventBridge. No new features | Free |
| Lambda + DynamoDB TTL | TTL-driven | Item-level scheduling. Per-order timeout | TTL is not precise (can delay up to 48 hours). Not reliable for time-critical cleanup | DynamoDB cost only |
| EC2 cron job | Server-based | Full cron flexibility. Any script | Always-on server cost. Management overhead. Not serverless | EC2 instance cost |
| Step Functions Wait state | Workflow-based | Per-execution delay. Good for workflows | Overkill for cron. Standard workflow cost during wait | $0.025/1,000 transitions |

**Why EventBridge Scheduler:** Native serverless cron. No server cost. DLQ catches missed executions. Free (you only pay for the Lambda invocation). Recommended replacement for CloudWatch Events.

---

## 12. Observability

### Selected: CloudWatch + X-Ray + Lambda Powertools

**What it does:** Structured logging, distributed tracing, custom metrics, dashboards, alarms.

### Logging

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **Powertools Logger → CloudWatch Logs** ✅ | Structured logging | JSON structured logs. Correlation IDs. Cold start tracking. Zero infra | CloudWatch log costs at high volume. Query limited vs Elasticsearch | Ingestion: $0.50/GB. Storage: $0.03/GB/mo |
| Datadog | Third-party | Superior UX. APM. Log management. Dashboards | Expensive. External dependency. Data leaves AWS | From $15/host/mo |
| Elastic (OpenSearch) | Search-based | Full-text search. Kibana dashboards. Powerful queries | Cluster management. Always-on cost. Complex | t3.small: ~$36/mo + storage |
| Splunk | Enterprise | Enterprise-grade. Powerful search. Compliance features | Very expensive. Complex setup. Overkill for POC | $150+/GB ingested |

### Tracing

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **X-Ray + Powertools Tracer** ✅ | Distributed tracing | Native AWS integration. Auto-traces SDK calls. Service map visualization | Less powerful than Jaeger/Zipkin. Limited custom analysis. 30-day retention | First 100K traces/mo free, then $5/million traces |
| Datadog APM | Third-party | Auto-instrumentation. Flame graphs. Powerful analysis | External dependency. Cost. Data egress | From $31/host/mo |
| Jaeger (self-hosted) | Open-source | Full control. Open standard (OpenTelemetry). Free | Self-hosted infrastructure. Management overhead | Infrastructure cost |

### Metrics

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **Powertools Metrics (EMF)** ✅ | Embedded metrics | Emits metrics inside logs (zero API calls). Custom dimensions. Automatic extraction | CloudWatch custom metric cost. Limited to CW dashboards | $0.30/metric/mo (first 10K), $0.10 after |
| CloudWatch PutMetricData API | Direct API | Fine-grained control. High-resolution (1-second) | API call per emission. Throttling possible. Code overhead | Same as above + API cost |
| Prometheus + Grafana | Open-source | Powerful querying (PromQL). Beautiful dashboards. Free | Self-hosted. Infrastructure cost. Not serverless-native | Infrastructure cost |

**Why this stack:** All AWS-native. Powertools is the AWS-recommended library for Lambda observability. Zero additional infrastructure. Free tier covers POC. EMF is the most cost-efficient way to emit custom metrics.

---

## 13. CI/CD

### Selected: GitHub Actions + OIDC

**What it does:** Automated build, test, and deploy on push/PR. Secure authentication via OIDC (no stored credentials).

| Option | Type | Pros | Cons | Cost |
|--------|------|------|------|------|
| **GitHub Actions** ✅ | CI/CD | Native GitHub integration. OIDC support. Marketplace actions. YAML config. PR comments | Vendor lock-in to GitHub. Minutes-based billing. Linux runners only (mostly) | 2,000 min/mo free, then $0.008/min |
| AWS CodePipeline + CodeBuild | AWS-native | Deep AWS integration. IAM native. No external dependency | Worse UX than GitHub Actions. YAML complexity. Slower iteration. Less community | CodeBuild: $0.005/min. CodePipeline: $1/pipeline/mo |
| CDK Pipelines | AWS-native + CDK | Self-mutating pipeline. CDK-native. Multi-stage deployments | Ties pipeline to CDK. Complex. CodePipeline underneath (same cost/UX issues) | CodePipeline + CodeBuild costs |
| GitLab CI | CI/CD | Good UX. Built-in container registry. Auto DevOps | Different platform than GitHub. Migration effort | 400 min/mo free, then $10/1,000 min |
| Jenkins | Self-hosted | Full control. Plugin ecosystem. Any integration | Self-hosted. Management overhead. Security patching. Not serverless | Infrastructure cost |
| CircleCI | CI/CD | Fast. Good caching. Docker layer caching. Orbs (reusable config) | External service. Cost at scale | 6,000 min/mo free, then $15/mo+ |

### Authentication: OIDC vs Access Keys

| Option | Security | Pros | Cons |
|--------|----------|------|------|
| **OIDC federation** ✅ | High | No stored secrets. Temporary credentials. Auto-rotating. If leaked, expires in minutes | Setup complexity. OIDC provider configuration in AWS |
| IAM access keys in GitHub Secrets | Medium | Simple setup. Quick start | Long-lived credentials. If leaked, permanent access until rotated. Manual rotation |

**Why GitHub Actions + OIDC:** We're already using GitHub. Native integration, good UX, generous free tier. OIDC is the security best practice — no long-lived credentials to leak.

---

## 14. Code Patterns & Libraries

### Input Validation: Zod

| Option | Pros | Cons |
|--------|------|------|
| **Zod** ✅ | TypeScript-first. Infers types from schemas. Small bundle. Great error messages | Runtime validation only (not compile-time) |
| Joi | Mature. Widely used. Detailed validation | Larger bundle. No TypeScript type inference |
| class-validator | Decorator-based. Works with class-transformer | Requires classes (not interfaces). Larger bundle. Decorators complexity |
| ajv (JSON Schema) | Standard-based. Shared with API Gateway models. Fast | Verbose schemas. Poor TypeScript integration |
| Manual validation | Zero dependency | Error-prone. Verbose. No type inference. Easy to miss edge cases |

### Idempotency: Powertools Idempotency

| Option | Pros | Cons |
|--------|------|------|
| **Powertools Idempotency** ✅ | DynamoDB-backed. TTL cleanup. Decorator/middleware. AWS official | Requires a DynamoDB table for idempotency records |
| Manual conditional writes | No dependency. Full control | More code. Easy to get wrong. Must handle TTL yourself |
| Redis-based (ElastiCache) | Fast. TTL built-in | Additional infrastructure. VPC required. Always-on cost |
| Database unique constraints | Simple. Works with existing DB | Only prevents duplicate inserts. Doesn't handle duplicate processing |

### Response Helpers: Custom (shared/response.ts)

| Option | Pros | Cons |
|--------|------|------|
| **Custom helper** ✅ | Tailored to our API format. Tiny. No dependency | Must maintain |
| Middy middleware | Popular. Plugin ecosystem. Middleware pattern | Extra dependency. Learning curve. Might be overkill |
| Lambda Powertools (parser) | AWS official. Zod integration | Heavier. Might not match custom response format |

---

## 15. Cost Summary

### Estimated Monthly Cost (POC with ~1,000 requests/day)

| Service | Free Tier | Estimated Monthly Cost |
|---------|-----------|----------------------|
| Lambda | 1M requests + 400K GB-seconds | $0.00 (within free tier) |
| API Gateway (REST) | 1M requests (12 months) | $0.00 (within free tier) |
| DynamoDB (On-Demand) | 25 GB storage + 25 WCU/RCU | $0.00 (within free tier) |
| SQS | 1M requests | $0.00 (within free tier) |
| SNS | 1M publishes | $0.00 (within free tier) |
| SES | 62,000 emails/mo (from Lambda) | $0.00 (within free tier) |
| EventBridge | First 14M custom events (free trial) | $0.00 |
| Step Functions | 4,000 state transitions | $0.00 (within free tier) |
| S3 | 5GB storage | $0.00 (within free tier) |
| CloudWatch Logs | 5GB ingestion | $0.00 (within free tier) |
| X-Ray | 100K traces | $0.00 (within free tier) |
| Cognito | 50,000 MAU | $0.00 (within free tier) |
| **Total** | | **~$0-2/month** |

> **Note:** Most services have a 12-month free tier from account creation. After that, this POC workload would cost approximately $5-15/month.

### Cost at Scale (100,000 requests/day)

| Service | Estimated Monthly Cost |
|---------|----------------------|
| Lambda | ~$6 |
| API Gateway (REST) | ~$10.50 |
| DynamoDB (On-Demand) | ~$15 |
| SQS | ~$1.20 |
| SNS | ~$1.50 |
| SES | ~$10 |
| EventBridge | ~$3 |
| Step Functions (Standard) | ~$15 |
| S3 | ~$1 |
| CloudWatch | ~$10 |
| X-Ray | ~$5 |
| Cognito | ~$0 (under 50K MAU) |
| **Total** | **~$75-80/month** |

### Cost Optimization Tips (Beyond POC)

| Optimization | Saving | When to apply |
|-------------|--------|---------------|
| DynamoDB Provisioned + Auto-scaling | 40-70% vs on-demand | Predictable, steady workload |
| DynamoDB Reserved Capacity | Up to 77% | 1-year commitment, known baseline |
| Lambda Provisioned Concurrency | Eliminate cold starts | Latency-sensitive APIs (adds base cost) |
| Lambda ARM64 (Graviton) | 20% cheaper, 34% better perf | Almost always (check library compatibility) |
| API Gateway HTTP API | 70% cheaper than REST | Don't need validation models, usage plans, or caching |
| Step Functions Express | 80-90% cheaper than Standard | High volume, can tolerate at-least-once |
| S3 Intelligent Tiering | Auto-optimize storage class | Objects accessed unpredictably |
| CloudWatch log retention | Reduce storage cost | Set 30/90 day retention instead of infinite |
| Lambda memory tuning | Right-size cost/performance | Use Lambda Power Tuning tool to find optimal setting |
| Savings Plans (Compute) | Up to 66% | 1-year commitment across Lambda + Fargate |

---

## Decision Matrix Summary

| Decision | Selected | Runner-up | Why Selected Over Runner-up |
|----------|----------|-----------|---------------------------|
| IaC | CDK (TypeScript) | SAM | Same language as Lambda. Real programming constructs. L2 abstractions |
| Compute | Lambda | Fargate | True serverless. Event-driven. Zero idle cost |
| Bundling | esbuild | Lambda Layer | Faster builds. Tree-shaking. Simpler packaging |
| API | REST API | HTTP API | Request validation, usage plans, caching — better for learning |
| Database | DynamoDB On-Demand | Aurora Serverless | Zero idle cost. Simpler. Streams built-in. Per-entity tables for learning |
| Auth | Cognito | Auth0 | AWS-native. Free tier. JWT authorizer integration |
| Queue | SQS Standard | SQS FIFO | Simpler. Higher throughput. Ordering not needed for notifications |
| Event bus | EventBridge | SNS | Content filtering. Schema registry. Archive/replay |
| Notifications | SNS + SES | SendGrid | AWS-native. Cheaper. Fan-out built-in |
| Orchestration | Step Functions Standard | Express | Exactly-once. Visual history. Correctness over cost |
| File processing | S3 + Lambda notification | S3 + EventBridge | Simpler. Direct trigger. Good enough for POC |
| Scheduling | EventBridge Scheduler | EventBridge Rules | DLQ support. One-time schedules. Recommended replacement |
| Logging | Powertools Logger | Datadog | AWS-native. Free. Structured JSON. Zero infra |
| Tracing | X-Ray + Powertools | Datadog APM | AWS-native. Free tier. Auto-instrumentation |
| Metrics | Powertools EMF | PutMetricData API | Zero API calls. Emits in logs. Cheaper |
| CI/CD | GitHub Actions | CDK Pipelines | Better UX. Faster iteration. Already using GitHub |
| Auth (CI/CD) | OIDC | Access keys | No stored secrets. Temporary credentials. Security best practice |
| Validation | Zod | Joi | TypeScript-first. Type inference. Smaller bundle |
| Idempotency | Powertools | Manual conditional writes | Battle-tested. TTL cleanup. Less code |
| Frontend framework | Next.js 15 (App Router) | Remix / plain React | SSR + API routes. Standalone output for Lambda. Largest ecosystem |
| Frontend hosting | Lambda Web Functions | Amplify Hosting | Serverless, scale to zero, learning value, new AWS capability |
| Frontend UI library | MUI (Material UI) 6 | Tailwind CSS | Complete component set (DataGrid, Stepper, Dialog). Faster development. Consistent design |
| Frontend deploy tool | `aws lambda-web` CLI | CDK (CfnResource) | Officially documented path. CDK L2 constructs not available yet. See [ADR-001](./docs/adr/adr-001-frontend-deployment.md) |
