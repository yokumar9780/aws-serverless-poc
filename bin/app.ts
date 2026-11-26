#!/usr/bin/env node

// source-map-support gives readable TypeScript stack traces in error messages
// during cdk synth / deploy, instead of pointing at compiled JS line numbers.
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedStack } from '../lib/stacks/shared-stack';
import { ApplicationStack } from '../lib/stacks/application-stack';

/**
 * CDK App entry point.
 *
 * This file is the starting point for `cdk synth` and `cdk deploy`. It:
 *   1. Creates the CDK App (the root of the construct tree)
 *   2. Instantiates each stack with its configuration
 *   3. Wires cross-stack dependencies (SharedStack → ApplicationStack)
 *
 * CDK synthesizes each stack into a CloudFormation template, then deploys
 * them in dependency order. SharedStack deploys first (tables must exist
 * before Lambdas can reference them).
 */
const app = new cdk.App();

// All stacks deploy to the same AWS account and region.
// CDK_DEFAULT_ACCOUNT is set automatically by the CDK CLI from your
// configured AWS credentials. Region is pinned to eu-west-1 (Ireland).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-west-1',
};

// ──────────────────────────────────────────────────────────────────────
// SharedStack — stateful resources (DynamoDB tables, Cognito in Phase 3)
//
// This stack has a separate lifecycle from compute. Tables use
// RemovalPolicy.DESTROY (POC only) so `cdk destroy` cleans up everything.
// In production you'd use RETAIN to protect data from accidental deletion.
//
// SharedStack exposes table references (orderTable, inventoryTable,
// paymentTable) as public properties for other stacks to consume.
// ──────────────────────────────────────────────────────────────────────
const sharedStack = new SharedStack(app, 'SharedStack', {
  env,
  description: 'Order Management System — DynamoDB tables and shared stateful resources',
});

// ──────────────────────────────────────────────────────────────────────
// ApplicationStack — stateless compute and integrations
//
// Contains the REST API, Lambda handlers, and all integration resources
// added in later phases (SQS, EventBridge, Step Functions, S3, SNS).
//
// It receives DynamoDB table references from SharedStack. CDK turns these
// into CloudFormation cross-stack imports (Fn::ImportValue) so the tables'
// names and ARNs flow through without hard-coding.
// ──────────────────────────────────────────────────────────────────────
const appStack = new ApplicationStack(app, 'ApplicationStack', {
  env,
  description: 'Order Management System — API Gateway, Lambda handlers, integrations',
  orderTable: sharedStack.orderTable,
  inventoryTable: sharedStack.inventoryTable,
  paymentTable: sharedStack.paymentTable,
});

// Explicit dependency ensures CDK deploys SharedStack before ApplicationStack.
// Without this, CDK might attempt parallel deployment, which fails because
// ApplicationStack's Lambdas reference table names exported by SharedStack.
appStack.addDependency(sharedStack);
