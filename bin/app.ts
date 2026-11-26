#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedStack } from '../lib/stacks/shared-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-west-1',
};

const sharedStack = new SharedStack(app, 'SharedStack', {
  env,
  description: 'Order Management System — DynamoDB tables and shared stateful resources',
});

// ApplicationStack will be added in Phase 2
// const appStack = new ApplicationStack(app, 'ApplicationStack', {
//   env,
//   orderTable: sharedStack.orderTable,
//   inventoryTable: sharedStack.inventoryTable,
//   paymentTable: sharedStack.paymentTable,
// });
