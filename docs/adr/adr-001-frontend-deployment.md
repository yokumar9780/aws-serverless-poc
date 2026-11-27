# ADR-001: Separate Deployment Process for Frontend (Lambda Web Functions)

**Date:** 2025-07-15
**Status:** Accepted
**Deciders:** Project team
**Category:** Infrastructure & Deployment

---

## Context

The Order Management System POC has two deployment targets:

1. **Backend** — CDK stacks (SharedStack + ApplicationStack) deployed via `cdk deploy`. Manages DynamoDB, API Gateway, Lambda event functions, SQS, EventBridge, SNS, Step Functions, S3, Cognito, and CloudWatch resources.
2. **Frontend** — A Next.js application running on AWS Lambda Web Functions, a new AWS capability for hosting web applications serverlessly.

Lambda Web Functions are a recently launched AWS service. As of this writing:
- There are **no CDK L2 constructs** for Lambda Web Functions.
- **CloudFormation support** for Web Functions may be incomplete or unstable (the resources are `AWS::LambdaWeb::WebFunction`, `AWS::LambdaWeb::WebFunctionRevision`, `AWS::LambdaWeb::WebFunctionEndpoint` — but availability and stability are not confirmed).
- The **officially documented deployment path** is the `aws lambda-web deploy` CLI command.

## Decision

We use **two separate deployment mechanisms**:

| Component | Tool | Command |
|---|---|---|
| Backend (CDK stacks) | AWS CDK | `pnpm cdk deploy --all` |
| Frontend (Lambda Web Function) | AWS CLI | `pnpm run deploy:frontend` (wraps `aws lambda-web deploy`) |

The frontend deployment is wrapped in a script (`deploy:frontend` in root `package.json`) to keep the developer experience simple. In CI/CD (Phase 11), both steps run sequentially — CDK deploy first (so the API URL is known), then frontend build and deploy.

## Consequences

### Benefits
- Uses the officially supported and documented deployment path for Lambda Web Functions
- No risk of hitting undocumented CloudFormation behavior
- Simpler to debug — `aws lambda-web deploy` provides clear error messages and status output
- Decoupled deployment lifecycles — backend and frontend can be deployed independently

### Limitations
- **Two deployment tools** — developers must remember to run both `cdk deploy` and `deploy:frontend`
- **No single `cdk deploy --all`** — cannot deploy the entire system with one CDK command
- **No cross-stack references** — the frontend cannot directly import CDK stack outputs (API URL, Cognito IDs). These must be passed as build-time environment variables, fetched from CloudFormation outputs via CLI, or hardcoded in a `.env` file
- **No CDK drift detection** — CDK doesn't know about the Lambda Web Function resource, so `cdk diff` won't show frontend changes
- **CI/CD sequencing** — the pipeline must explicitly orchestrate: deploy backend → read stack outputs → build frontend with outputs → deploy frontend

### Risks
- If the backend API URL changes (e.g., after a stack recreate), the frontend must be rebuilt and redeployed with the new URL
- Lambda Web Functions are new — the CLI interface or deployment model could change in future AWS releases

## Alternatives Considered

### Alternative 1: CDK L1 Constructs (CfnResource)

Use low-level CloudFormation resources in CDK to define the Web Function inline with the backend stacks.

```ts
new cdk.CfnResource(this, 'FrontendWebFunction', {
  type: 'AWS::LambdaWeb::WebFunction',
  properties: { ... }
});
```

**Rejected because:**
- CloudFormation resource types for Lambda Web Functions may not be stable or fully supported yet
- L1 constructs are verbose and provide no helper methods
- Debugging CFN deployment failures for a new resource type is painful
- The code upload flow (S3 bucket, versioning, revision creation) would need manual orchestration

### Alternative 2: CDK Custom Resource (Lambda-backed)

Write a CDK custom resource that calls the Lambda Web Functions API during deployment.

**Rejected because:**
- Significant engineering effort for a POC
- Custom resource Lambdas have their own failure modes and debugging complexity
- The `aws lambda-web deploy` CLI already does this correctly

### Alternative 3: Amplify Hosting

Deploy the Next.js frontend to AWS Amplify Hosting instead of Lambda Web Functions.

**Rejected because:**
- Amplify is a managed black box — doesn't align with the POC's goal of learning AWS services hands-on
- Amplify doesn't scale to zero (always-on tier)
- Less learning value compared to Lambda Web Functions

### Alternative 4: SST (Serverless Stack)

Use SST which has built-in Next.js support and deploys to Lambda.

**Rejected because:**
- Adds another framework layer on top of CDK
- Different deployment model than what we've established
- The POC is specifically about learning CDK and AWS services directly

---

## Action Plan for Unification

This section defines the conditions and steps for migrating the frontend into CDK, eliminating the two-tool deployment.

### Trigger Conditions (revisit when ANY of these occur)

1. **CDK L2 construct released** — AWS publishes an `@aws-cdk/aws-lambdaweb` or equivalent module with `WebFunction`, `Revision`, and `Endpoint` constructs
2. **CloudFormation resources stabilized** — The `AWS::LambdaWeb::*` resource types are documented in the CloudFormation Resource Specification and confirmed stable
3. **Community CDK construct available** — A well-maintained third-party construct (e.g., from `cdk-constructs` or similar) wraps Lambda Web Functions with a usable API
4. **Project moves beyond POC** — If this becomes a production system, unifying deployment tools reduces operational risk and simplifies CI/CD

### Migration Steps (when triggered)

**Step 1 — Create FrontendStack in CDK**

```ts
// lib/stacks/frontend-stack.ts
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

interface FrontendStackProps extends cdk.StackProps {
  apiUrl: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // When L2 constructs are available:
    // const webFunction = new lambdaweb.WebFunction(this, 'Frontend', {
    //   functionName: 'order-management-frontend',
    //   code: lambdaweb.Code.fromAsset('./frontend/.next/standalone'),
    //   runtime: lambdaweb.Runtime.NODEJS_24_X,
    //   environment: {
    //     NEXT_PUBLIC_API_URL: props.apiUrl,
    //     NEXT_PUBLIC_COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
    //     NEXT_PUBLIC_COGNITO_CLIENT_ID: props.cognitoClientId,
    //   },
    // });
    //
    // const endpoint = webFunction.addEndpoint('dev', {
    //   endpointType: lambdaweb.EndpointType.HOME_REGION,
    //   authType: lambdaweb.AuthType.APPLICATION_MANAGED,
    //   autoDeploymentMode: lambdaweb.AutoDeploymentMode.LATEST_REVISION,
    // });
    //
    // new cdk.CfnOutput(this, 'FrontendUrl', {
    //   value: endpoint.domainName,
    // });
  }
}
```

**Step 2 — Wire into bin/app.ts**

```ts
const appStack = new ApplicationStack(app, 'ApplicationStack', { ... });

new FrontendStack(app, 'FrontendStack', {
  env,
  apiUrl: appStack.apiUrl,           // Cross-stack reference
  cognitoUserPoolId: sharedStack.userPoolId,
  cognitoClientId: sharedStack.userPoolClientId,
});
```

**Step 3 — Update CI/CD**

Replace the separate `aws lambda-web deploy` step with `cdk deploy --all`, which now includes FrontendStack.

**Step 4 — Remove legacy deployment**

- Remove `deploy:frontend` script from `package.json`
- Remove `frontend/scripts/package.js`
- Delete the manually created Lambda Web Function: `aws lambda-web delete-web-function --function-name order-management-frontend`
- Update this ADR status to **Superseded**

### Interim Improvements (before full migration)

Even before CDK support arrives, we can reduce friction:

1. **Automate output passing** — Add a script that reads CDK stack outputs and writes them to `frontend/.env.local`:
   ```bash
   # scripts/sync-env.sh
   API_URL=$(aws cloudformation describe-stacks --stack-name ApplicationStack \
     --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text --region eu-west-1)
   POOL_ID=$(aws cloudformation describe-stacks --stack-name SharedStack \
     --query "Stacks[0].Outputs[?ExportName=='UserPoolId'].OutputValue" --output text --region eu-west-1)
   CLIENT_ID=$(aws cloudformation describe-stacks --stack-name SharedStack \
     --query "Stacks[0].Outputs[?ExportName=='UserPoolClientId'].OutputValue" --output text --region eu-west-1)

   cat > frontend/.env.local <<EOF
   NEXT_PUBLIC_API_URL=$API_URL
   NEXT_PUBLIC_COGNITO_USER_POOL_ID=$POOL_ID
   NEXT_PUBLIC_COGNITO_CLIENT_ID=$CLIENT_ID
   NEXT_PUBLIC_REGION=eu-west-1
   EOF
   ```

2. **Single deploy command** — Add a root-level script that runs both deployments:
   ```json
   {
     "scripts": {
       "deploy:all": "pnpm cdk deploy --all && pnpm run sync-env && pnpm run deploy:frontend"
     }
   }
   ```

3. **Deployment status check** — Add a post-deploy verification script that curls both the API health endpoint and the frontend endpoint to confirm both are live.

---

## References

- [AWS Lambda Web Functions documentation](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
- [Creating a Lambda Web Function](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-create.md)
- [Lambda Web Function runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.md)
- [FRONTEND-PLAN.md](../../FRONTEND-PLAN.md) — Full frontend implementation plan
- [TECH-DECISIONS.md](../../TECH-DECISIONS.md) — Decision matrix summary
