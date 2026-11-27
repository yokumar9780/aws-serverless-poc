# Frontend Plan — Next.js on AWS Lambda Web Functions

## Overview

A Next.js (TypeScript) web application that serves as the frontend for the Order Management System POC. The app evolves alongside each backend phase, providing a visual way to test and validate every serverless concept as it's built.

**Hosting:** AWS Lambda Web Functions (not Amplify, not EC2, not ECS)
**Framework:** Next.js 15 (App Router) with TypeScript
**Runtime:** Node.js 24 (Lambda Web Functions `nodejs24.x`)
**UI Library:** MUI (Material UI) 6
**Region:** eu-west-1

---

## Why Lambda Web Functions

Lambda Web Functions are a new Lambda capability purpose-built for running web applications serverlessly. Unlike the traditional Lambda + API Gateway approach (which requires adapters like `@sls-next/serverless-component` or Lambda@Edge), Web Functions run a standard Node.js HTTP server directly — no adapters, no event-to-HTTP translation.

| Consideration | Lambda Web Functions | Amplify Hosting | Traditional Lambda + API GW |
|---|---|---|---|
| Next.js SSR support | Native (standalone server) | Native | Requires adapter (complex) |
| Scale to zero | Yes | No (always-on tier) | Yes |
| Deployment model | ZIP → revision → endpoint | Git push | Complex (Lambda@Edge + S3) |
| Cost at POC scale | ~$0 (free tier) | ~$0 (free tier) | ~$0 but complex setup |
| Learning value | High (new AWS capability) | Low (managed black box) | Low (solved problem) |
| Multi-concurrent requests | Yes (per environment) | Yes | No (1 request per invocation) |
| Streaming SSR | Native | Yes | No |

**Decision:** Lambda Web Functions align with the POC's goal of learning AWS serverless services hands-on, and they're the simplest path for running Next.js on Lambda.

---

## Architecture

```
Browser
   │
   ▼ HTTPS
Lambda Web Function Endpoint
   │  (TLS terminated by Lambda)
   ▼
Next.js Standalone Server (nodejs24.x)
   │
   ├── Server Components / SSR pages
   │      │
   │      ▼ fetch()
   │   API Gateway (backend REST API)
   │      │
   │      ▼
   │   Lambda handlers → DynamoDB
   │
   ├── API Routes (/api/auth/*)
   │      │
   │      ▼
   │   Cognito (sign-up, sign-in, token refresh)
   │
   └── Static assets (/_next/static/*)
          served by Next.js from the same function
```

For production, you'd put CloudFront in front of the Lambda Web Function endpoint for caching static assets and global distribution. For this POC, the direct endpoint is sufficient.

---

## Project Structure

The frontend lives in its own directory within the monorepo, with its own `package.json` and build pipeline.

```
aws-serverless-poc/
├── frontend/                          # Next.js application
│   ├── src/
│   │   ├── app/                       # App Router pages
│   │   │   ├── layout.tsx             # Root layout (nav, providers)
│   │   │   ├── page.tsx               # Home / dashboard
│   │   │   ├── login/
│   │   │   │   └── page.tsx           # Login page (Phase 3+)
│   │   │   ├── signup/
│   │   │   │   └── page.tsx           # Sign-up page (Phase 3+)
│   │   │   ├── orders/
│   │   │   │   ├── page.tsx           # Order list
│   │   │   │   ├── [orderId]/
│   │   │   │   │   └── page.tsx       # Order detail + status timeline
│   │   │   │   └── new/
│   │   │   │       └── page.tsx       # Create order form
│   │   │   ├── inventory/
│   │   │   │   ├── page.tsx           # Inventory list
│   │   │   │   └── [productId]/
│   │   │   │       └── page.tsx       # Edit inventory item
│   │   │   ├── import/
│   │   │   │   └── page.tsx           # Bulk import UI (Phase 8)
│   │   │   └── dashboard/
│   │   │       └── page.tsx           # Observability dashboard (Phase 10)
│   │   ├── components/
│   │   │   ├── theme/
│   │   │   │   ├── theme.ts           # MUI theme customization (palette, typography)
│   │   │   │   └── ThemeRegistry.tsx   # App Router MUI + Emotion SSR provider
│   │   │   ├── layout/
│   │   │   │   ├── navbar.tsx         # AppBar with navigation
│   │   │   │   ├── sidebar.tsx        # Drawer with nav links
│   │   │   │   └── footer.tsx
│   │   │   ├── orders/
│   │   │   │   ├── order-table.tsx
│   │   │   │   ├── order-form.tsx
│   │   │   │   ├── order-status-badge.tsx
│   │   │   │   ├── order-timeline.tsx
│   │   │   │   └── status-update-modal.tsx
│   │   │   ├── inventory/
│   │   │   │   ├── inventory-table.tsx
│   │   │   │   └── inventory-form.tsx
│   │   │   ├── auth/
│   │   │   │   ├── login-form.tsx
│   │   │   │   ├── signup-form.tsx
│   │   │   │   └── auth-guard.tsx
│   │   │   └── import/
│   │   │       ├── file-upload.tsx
│   │   │       └── import-status.tsx
│   │   ├── lib/
│   │   │   ├── api-client.ts          # Typed fetch wrapper for backend API
│   │   │   ├── auth.ts                # Cognito auth helpers (token management)
│   │   │   └── constants.ts           # API URLs, config
│   │   └── types/
│   │       └── index.ts               # Shared types (mirrors backend types)
│   ├── public/
│   │   └── favicon.ico
│   ├── index.js                       # Lambda Web Function entry point
│   ├── next.config.ts                 # Next.js config (standalone output)
│   ├── tsconfig.json
│   ├── package.json
│   └── .env.local                     # Local dev environment variables
├── lib/
│   └── stacks/
│       └── frontend-stack.ts          # CDK stack for Lambda Web Function
├── ... (existing backend code)
```

---

## Lambda Web Function Entry Point

The key to running Next.js on Lambda Web Functions is the `index.js` entry file. It reads `AWS_LAMBDA_HTTP_ENDPOINT` and starts the Next.js standalone server on that address.

**frontend/index.js:**
```js
const { parse } = require('url');
const path = require('path');

// Lambda Web Functions provide the listen address via this env var
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000';
const [host, port] = endpoint.split(':');

// Set hostname/port before requiring Next.js (standalone server reads these)
process.env.HOSTNAME = host;
process.env.PORT = port;

// Next.js standalone server
require('./.next/standalone/server.js');
```

**frontend/next.config.ts:**
```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',  // Required for Lambda Web Functions
  // ... other config
};

export default nextConfig;
```

---

## CDK Stack — FrontendStack

A new CDK stack deploys the Next.js app as a Lambda Web Function. Since CDK doesn't have L2 constructs for Lambda Web Functions yet (they're new), we use the AWS CLI `aws lambda-web deploy` in a custom deployment script, or use `CfnResource` for L1 CloudFormation if CFN support is available.

**Deployment approach (CLI-based, simplest for POC):**

```bash
# Build Next.js
cd frontend
pnpm install
pnpm build

# Package standalone output + static assets + entry point
cp index.js .next/standalone/
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd .next/standalone
zip -r ../../frontend.zip .

# Deploy to Lambda Web Function
cd ../..
aws lambda-web deploy \
  --name order-management-frontend \
  --code .next/standalone \
  --endpoint-name dev \
  --region eu-west-1
```

We'll wrap this in a `deploy:frontend` script in the root `package.json`.

---

## Phase-by-Phase Frontend Evolution

The frontend grows incrementally with each backend phase. Each section below describes what pages/features are added and what you can test.

---

### Frontend for Phase 1 — Health Check & Project Setup

**What exists in the backend:** DynamoDB tables only (no API yet).

**Frontend work:**
- Initialize Next.js project with TypeScript, MUI (Material UI), App Router
- Set up MUI theme (`ThemeRegistry` + custom palette/typography)
- Create root layout with MUI AppBar + Drawer navigation shell
- Home page with project overview / status card (MUI `Card`, `Typography`)
- Health check page that displays the frontend's own status
- Deploy to Lambda Web Function for the first time

**What you can test:**
- Next.js running on Lambda Web Functions (cold start, page navigation)
- Static and SSR page rendering
- Deployment workflow (build → zip → `aws lambda-web deploy`)

**Pages:**
| Route | Description |
|---|---|
| `/` | Home — project overview, links to each section |
| `/health` | Frontend health check (confirms the app is running) |

---

### Frontend for Phase 2 — CRUD Operations

**What exists in the backend:** REST API with 6 endpoints (orders + inventory CRUD).

**Frontend work:**
- API client module (`lib/api-client.ts`) with typed fetch wrapper
- Shared TypeScript types mirroring backend types
- Inventory management pages (MUI `Table` for list, `TextField` + `Button` for create/edit form)
- Order management pages (list with MUI `Table`, create form, detail with status)
- Status update with MUI `Dialog` and allowed transitions
- MUI `Snackbar` + `Alert` for success/error feedback
- MUI `Skeleton` loading states and error handling

**What you can test:**
- Full CRUD cycle through the browser
- API Gateway integration (CORS, request/response format)
- Input validation feedback (Zod errors from backend displayed in forms)
- Order status transitions (valid and invalid)
- Empty states, 404 handling

**Pages:**
| Route | Description |
|---|---|
| `/inventory` | List all inventory items in a table |
| `/inventory/[productId]` | Edit/create inventory item form |
| `/orders` | List orders (initially all, filtered by customerId later) |
| `/orders/new` | Create order form (select product, enter quantity) |
| `/orders/[orderId]` | Order detail — status badge, timeline, update status button |

**API client pattern:**
```ts
// lib/api-client.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export async function createOrder(input: CreateOrderInput, token?: string) {
  const res = await fetch(`${API_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new ApiError(err.statusCode, err.message);
  }
  return res.json() as Promise<Order>;
}
```

---

### Frontend for Phase 3 — Authentication

**What exists in the backend:** Cognito User Pool, JWT authorizer on all API routes.

**Frontend work:**
- Login page with email/password form
- Sign-up page with email/password + confirmation code flow
- Auth context/provider (store tokens in memory, refresh flow)
- Auth guard component (redirect to login if not authenticated)
- Update API client to attach JWT token to all requests
- Display logged-in user's email in navbar
- Logout functionality
- Update order list to only show current user's orders

**What you can test:**
- Full sign-up → confirm → login flow in the browser
- Protected pages redirect to login
- API calls with valid token succeed
- API calls without token show 401 and redirect to login
- Token refresh when access token expires
- Orders filtered by authenticated user (can't see other users' orders)

**Pages:**
| Route | Description |
|---|---|
| `/login` | Email + password login form |
| `/signup` | Sign-up form + confirmation code step |

**Auth flow in the app:**
```
User visits /orders → AuthGuard checks token
  ├── No token → redirect to /login
  └── Has token → render page
        └── API call with Bearer token
              ├── 200 → show data
              └── 401 → clear token, redirect to /login
```

**Token management approach:**
- Use Cognito's `initiateAuth` / `signUp` / `confirmSignUp` via `@aws-sdk/client-cognito-identity-provider` directly (no Amplify dependency)
- Store tokens in a React context (memory only — not localStorage for security)
- Refresh token flow: when API returns 401, attempt token refresh before redirecting to login

---

### Frontend for Phase 4 — Async Notifications

**What exists in the backend:** SQS queue for notifications, DLQ, idempotent consumer.

**Frontend work:**
- Add a "Notifications" section to the order detail page
- After status update, show a "Notification queued" indicator
- Add a simple polling mechanism to check if notification was processed
- Display notification status (queued → processing → sent)

**What you can test:**
- Update order status → see "notification sent" feedback
- Verify the async nature: status update returns immediately, notification arrives later
- Check DLQ behavior by watching the notification status not transition (simulated failure)

**UI additions:**
| Component | Description |
|---|---|
| Order detail — notification card | Shows notification status after a status change |
| Toast | "Order status updated. Notification queued." |

> Note: This phase is primarily backend-focused. The frontend changes are small — mainly showing that notifications are being processed asynchronously.

---

### Frontend for Phase 5 — Event-Driven (DynamoDB Streams + EventBridge)

**What exists in the backend:** DynamoDB Streams → EventBridge events on order changes.

**Frontend work:**
- Add an "Events" tab to the order detail page
- Display event history for an order (fetched from CloudWatch Logs or a new API endpoint)
- Show event flow visualization: "Order Created → EventBridge → ..."
- Add a live event log panel (optional — polling-based)

**What you can test:**
- Create order → see `OrderCreated` event appear in the events tab
- Update status → see `OrderStatusChanged` event
- Verify events are flowing through EventBridge (not direct SQS anymore)

**UI additions:**
| Component | Description |
|---|---|
| Order detail — events tab | List of events with timestamp, type, and payload preview |
| Event detail modal | Full event payload (JSON viewer) |

> Note: To show events in the UI, we'll need a small backend addition — either a Lambda that queries CloudWatch Logs for the order's events, or a DynamoDB table that stores event history. The simplest approach is an `/orders/{orderId}/events` endpoint that queries the debug CloudWatch Log group.

---

### Frontend for Phase 6 — Email Notifications

**What exists in the backend:** SNS → SQS → Lambda → SES email sending.

**Frontend work:**
- Add email notification status to order detail page
- Show which emails were sent (confirmed, shipped, cancelled)
- Display the email template preview for each status
- Add a "Notification Preferences" section (email address from Cognito)

**What you can test:**
- Update order to CONFIRMED → see "Confirmation email sent" in the UI
- Check your actual email inbox for the formatted email
- Verify the full chain: UI → API → DynamoDB → Stream → EventBridge → SNS → SQS → Lambda → SES

**UI additions:**
| Component | Description |
|---|---|
| Order detail — emails card | List of sent emails with status and timestamp |
| Email preview modal | Shows what the email looked like |

---

### Frontend for Phase 7 — Step Functions Workflow

**What exists in the backend:** Step Functions state machine for order orchestration (validate → reserve → pay → confirm).

**Frontend work:**
- Replace simple order creation with workflow-aware creation
- Add workflow status tracking to order detail page
- Visual workflow progress indicator using MUI `Stepper` (Validate → Reserve → Pay → Confirm)
- Show workflow execution status (running, succeeded, failed)
- Display compensation actions when workflow fails (inventory released, order cancelled)
- Add a "Retry" button for failed orders

**What you can test:**
- Create order → watch workflow progress through each step in real-time (polling)
- Successful flow: all steps complete, order confirmed
- Payment failure: see compensation (inventory released) reflected in the UI
- Out of stock: see early failure with appropriate message
- Verify inventory changes in the inventory page (reserved → released on failure)

**UI additions:**
| Component | Description |
|---|---|
| Order detail — workflow stepper | MUI `Stepper`: ✓ Validated → ✓ Reserved → ⏳ Processing Payment → ... |
| Order detail — workflow history | List of Step Function execution events with timestamps |
| Order detail — failure card | Shows what went wrong + compensation actions taken |

**Polling approach:**
```ts
// Poll order status every 2 seconds while workflow is running
useEffect(() => {
  if (order.status === 'PENDING') {
    const interval = setInterval(async () => {
      const updated = await getOrder(orderId, token);
      setOrder(updated);
      if (updated.status !== 'PENDING') clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }
}, [order.status]);
```

---

### Frontend for Phase 8 — Bulk Import

**What exists in the backend:** S3 trigger → Lambda → Step Functions for bulk order creation.

**Frontend work:**
- Bulk import page with MUI `Button` file upload (drag-and-drop zone)
- JSON file format documentation / example download
- Upload progress indicator
- Import status tracking (processing → complete with results)
- Display import results: successful orders, failed records with errors
- Link to created orders from the results page

**What you can test:**
- Upload a valid JSON file → see orders being created
- Upload a file with mixed valid/invalid records → see partial success report
- Download and review error file
- Navigate to created orders and verify they went through the Step Function workflow

**Pages:**
| Route | Description |
|---|---|
| `/import` | File upload form + import history |

**UI flow:**
```
User drops JSON file → Upload to S3 (via presigned URL from new API endpoint)
  → Show progress bar
  → Poll import status
  → Display results table (✓ created / ✗ failed with error)
  → Link to each created order
```

> Note: The frontend needs a presigned URL endpoint to upload directly to S3. We'll add a small `GET /import/presigned-url` endpoint that returns a presigned S3 PUT URL for the `imports/` prefix.

---

### Frontend for Phase 9 — Scheduled Cleanup

**What exists in the backend:** EventBridge scheduled rule → Lambda cleans up stale PENDING orders.

**Frontend work:**
- Add "stale order" indicator to order list (highlight PENDING orders older than 30 min)
- Add cleanup history section to the dashboard
- Show countdown timer on PENDING orders ("will be cancelled in X minutes")
- After cleanup runs, orders transition to CANCELLED in the order list

**What you can test:**
- Create a PENDING order and wait (or manually trigger cleanup)
- Watch it get cancelled in the order list
- Verify inventory was released
- See the cleanup log in the dashboard

**UI additions:**
| Component | Description |
|---|---|
| Order table — stale badge | MUI `Chip` with warning color: "⚠ Stale" on PENDING orders older than 25 min |
| Order table — countdown | "Auto-cancel in 5m" on stale PENDING orders |
| Dashboard — cleanup log | Last cleanup run: X orders cancelled |

---

### Frontend for Phase 10 — Observability Dashboard

**What exists in the backend:** X-Ray tracing, CloudWatch metrics, dashboards, alarms.

**Frontend work:**
- Operational dashboard page with key metrics
- API latency chart (p50, p90, p99)
- Order volume chart (orders/hour)
- Error rate indicator
- Active alarms list
- Link to AWS Console for X-Ray traces and full CloudWatch dashboard
- Embed CloudWatch dashboard (via iframe with temporary credentials, or recreate charts with custom metrics API)

**What you can test:**
- Generate traffic → see metrics update in the dashboard
- Trigger an error → see alarm fire and appear in the UI
- View end-to-end latency for order operations

**Pages:**
| Route | Description |
|---|---|
| `/dashboard` | Operational metrics and alarm status |

> Note: For a POC, displaying live CloudWatch metrics in a custom UI is complex. The pragmatic approach is to show key metrics via a backend endpoint that queries CloudWatch Metrics API, plus direct links to the AWS Console dashboards.

---

### Frontend for Phase 11 — CI/CD

**What exists in the backend:** GitHub Actions deploy pipeline.

**Frontend work:**
- Add frontend build + deploy to the GitHub Actions workflows
- PR workflow: build frontend, run lint
- Main branch workflow: build → deploy frontend to Lambda Web Function
- Add a "Build Info" footer showing git commit, deploy timestamp

**CI/CD additions to `.github/workflows/deploy.yml`:**
```yaml
- name: Build frontend
  run: |
    cd frontend
    pnpm install --frozen-lockfile
    pnpm build
    
- name: Deploy frontend
  run: |
    cd frontend
    node scripts/package.js   # Creates deployment ZIP
    aws lambda-web deploy \
      --name order-management-frontend \
      --code .next/standalone \
      --endpoint-name dev \
      --region eu-west-1 \
      --create
```

---

## Deployment Script

**frontend/scripts/package.js** — Packages the Next.js standalone build for Lambda Web Functions:

```js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const standaloneDir = path.join(__dirname, '..', '.next', 'standalone');

// Copy entry point
fs.copyFileSync(
  path.join(__dirname, '..', 'index.js'),
  path.join(standaloneDir, 'index.js')
);

// Copy static assets
execSync(`cp -r ${path.join(__dirname, '..', '.next', 'static')} ${path.join(standaloneDir, '.next', 'static')}`);

// Copy public assets
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  execSync(`cp -r ${publicDir} ${path.join(standaloneDir, 'public')}`);
}

console.log('Frontend packaged for Lambda Web Functions');
```

---

## Environment Variables

| Variable | Description | Set by |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Backend API Gateway URL | Build-time (from CDK stack output) |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | Cognito User Pool ID | Build-time (from CDK stack output) |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Cognito App Client ID | Build-time (from CDK stack output) |
| `NEXT_PUBLIC_REGION` | AWS region | Build-time (`eu-west-1`) |
| `AWS_LAMBDA_HTTP_ENDPOINT` | Lambda Web Function listen address | Runtime (set by Lambda) |

> `NEXT_PUBLIC_*` variables are embedded at build time by Next.js and available in the browser. The backend API URL must be known at build time.

---

## Dependencies

```json
{
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19",
    "@mui/material": "^6",
    "@mui/icons-material": "^6",
    "@emotion/react": "^11",
    "@emotion/styled": "^11",
    "@emotion/cache": "^11",
    "@aws-sdk/client-cognito-identity-provider": "^3"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "^15"
  }
}
```

**MUI + Next.js App Router setup note:** MUI uses Emotion for CSS-in-JS, which requires a `ThemeRegistry` wrapper to handle SSR correctly with the App Router. This provider flushes Emotion styles into the SSR HTML so there's no flash of unstyled content. The `@emotion/cache` package is needed for this.

No Amplify, no NextAuth. MUI provides all UI primitives (Button, TextField, DataGrid, Dialog, Snackbar, Stepper, Chip, etc.) out of the box — no need to build custom components.

---

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Lambda Web Functions | Aligns with POC goals, serverless, scale to zero, learning value |
| Next.js output mode | `standalone` | Required for Lambda Web Functions — produces a self-contained server |
| Auth library | Direct `@aws-sdk/client-cognito-identity-provider` | No Amplify dependency, full control, smaller bundle |
| UI library | MUI (Material UI) 6 | Complete component library — DataGrid, Stepper, Dialog, Snackbar, etc. Accelerates development, consistent design language, good accessibility defaults |
| State management | React Context + `useState` | Simple enough for this POC, no need for Redux/Zustand |
| Data fetching | Native `fetch` in Server Components + client `fetch` | No SWR/React Query needed at POC scale |
| Token storage | Memory (React context) | More secure than localStorage for JWT tokens |
| Real-time updates | Polling (setInterval) | Simple, no WebSocket infrastructure needed for POC |

---

## Cold Start Considerations

Lambda Web Functions have cold starts when scaling from zero. For Next.js with MUI:

- **Standalone output** produces a self-contained server (~30-45 MB with MUI + Emotion)
- **MUI adds bundle size** compared to utility-CSS approaches, but the trade-off is worth it for development speed and a polished UI. MUI supports tree-shaking — only imported components are bundled
- **Emotion SSR overhead** — the `ThemeRegistry` flushes styles during SSR, adding a small per-request cost. Negligible for a POC
- **Minimal server-side dependencies** — `@aws-sdk/client-cognito-identity-provider` for auth, MUI/Emotion for rendering
- **Expected cold start:** ~3-5 seconds for first request (MUI adds ~1s vs a no-library setup), then warm for subsequent requests
- **`maxConcurrencyPerEnvironment`:** Default 64 — a single environment handles many concurrent requests

For the POC, cold starts are acceptable. For production, you'd use CloudFront caching for static pages, provisioned concurrency for critical routes, and consider selective dynamic imports for heavy MUI components (e.g., DataGrid).

---

## Implementation Order

The frontend implementation follows the backend phases. Start with Phase 1 frontend setup alongside or immediately after the backend phase.

| Backend Phase | Frontend Work | Effort |
|---|---|---|
| Phase 1 — DynamoDB Setup | Init Next.js, layout, deploy to Lambda Web Functions | 2-3 hours |
| Phase 2 — API CRUD | Inventory + order pages, API client, forms, tables | 3-4 hours |
| Phase 3 — Cognito Auth | Login, signup, auth guard, token management | 2-3 hours |
| Phase 4 — SQS Async | Notification status indicator on order detail | 1 hour |
| Phase 5 — Streams + EventBridge | Events tab on order detail | 1-2 hours |
| Phase 6 — SNS + SES Email | Email status on order detail | 1 hour |
| Phase 7 — Step Functions | Workflow stepper, failure visualization | 2-3 hours |
| Phase 8 — S3 Bulk Import | File upload page, import results | 2-3 hours |
| Phase 9 — Scheduled Cleanup | Stale order indicators, countdown | 1 hour |
| Phase 10 — Observability | Metrics dashboard page | 2-3 hours |
| Phase 11 — CI/CD | Add frontend to deploy pipeline | 1 hour |
| **Total** | | **~19-27 hours** |

---

## Notes

- The frontend always deploys as a separate Lambda Web Function, independent of the backend stacks.
- Backend API URL is injected at build time via `NEXT_PUBLIC_API_URL`. When the backend redeploys and the API URL changes, rebuild and redeploy the frontend.
- Lambda Web Functions are a new AWS capability. CDK L2 constructs may not exist yet — use the AWS CLI `aws lambda-web deploy` command for deployments.
- The `aws lambda-web` CLI commands require a recent AWS CLI v2 release. Run `aws lambda-web help` to verify availability.
- CORS: The backend API already has `Access-Control-Allow-Origin: *`. For production, restrict this to the Lambda Web Function endpoint domain.
- Each frontend phase is optional — the backend works independently via curl/Postman. The frontend just makes testing more visual and interactive.
- **Deployment limitation:** Backend (CDK) and frontend (AWS CLI) use separate deployment tools. See [ADR-001](./docs/adr/adr-001-frontend-deployment.md) for the rationale, limitations, and action plan for future unification when CDK L2 constructs for Lambda Web Functions become available.
