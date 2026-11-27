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

  // ─── Order Table ───

  test('Order table has correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      KeySchema: [
        { AttributeName: 'orderId', KeyType: 'HASH' },
      ],
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
          Projection: { ProjectionType: 'ALL' },
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
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('Order table has DynamoDB Streams enabled with NEW_AND_OLD_IMAGES', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    });
  });

  test('Order table has point-in-time recovery enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Orders',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  // ─── Inventory Table ───

  test('Inventory table has correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Inventory',
      KeySchema: [
        { AttributeName: 'productId', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  // ─── Payment Table ───

  test('Payment table has correct key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Payments',
      KeySchema: [
        { AttributeName: 'paymentId', KeyType: 'HASH' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('Payment table has orderId-index GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'Payments',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'orderId-index',
          KeySchema: [
            { AttributeName: 'orderId', KeyType: 'HASH' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  // ─── Removal Policy ───

  test('all tables have DeletionPolicy set to Delete (POC)', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const tableNames = Object.keys(tables);
    expect(tableNames).toHaveLength(3);

    for (const name of tableNames) {
      expect(tables[name].DeletionPolicy).toBe('Delete');
    }
  });

  // ─── Cognito User Pool (Phase 3) ───

  test('creates a Cognito User Pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('User Pool has correct configuration', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'order-management-user-pool',
      // Self-signup enabled (no AdminCreateUserConfig restriction)
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: false,
      },
      // Email verification required
      AutoVerifiedAttributes: ['email'],
      // Password policy: 8+ chars, upper, lower, digits, no symbols required
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        },
      },
      // Email as sign-in alias
      UsernameAttributes: ['email'],
      // Email is required
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: 'email',
          Required: true,
          Mutable: true,
        }),
      ]),
      // Account recovery via email
      AccountRecoverySetting: {
        RecoveryMechanisms: Match.arrayWith([
          Match.objectLike({
            Name: 'verified_email',
            Priority: 1,
          }),
        ]),
      },
    });
  });

  test('User Pool has DeletionPolicy set to Delete (POC)', () => {
    const pools = template.findResources('AWS::Cognito::UserPool');
    const poolIds = Object.keys(pools);
    expect(poolIds).toHaveLength(1);
    expect(pools[poolIds[0]].DeletionPolicy).toBe('Delete');
  });

  // ─── Cognito User Pool Client ───

  test('creates a User Pool Client', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  test('User Pool Client has correct configuration', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'order-management-client',
      // Public client — no secret generated
      GenerateSecret: false,
      // Auth flows: USER_PASSWORD_AUTH for CLI testing, USER_SRP_AUTH for secure flow
      ExplicitAuthFlows: Match.arrayWith([
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH',
      ]),
      // Token validity
      AccessTokenValidity: 1,   // 1 hour
      IdTokenValidity: 1,       // 1 hour
      RefreshTokenValidity: 30, // 30 days
    });
  });

  // ─── Cross-stack Exports ───

  test('exports table names and ARNs', () => {
    template.hasOutput('OrderTableName', {
      Export: { Name: 'OrderTableName' },
    });
    template.hasOutput('OrderTableArn', {
      Export: { Name: 'OrderTableArn' },
    });
    template.hasOutput('InventoryTableName', {
      Export: { Name: 'InventoryTableName' },
    });
    template.hasOutput('InventoryTableArn', {
      Export: { Name: 'InventoryTableArn' },
    });
    template.hasOutput('PaymentTableName', {
      Export: { Name: 'PaymentTableName' },
    });
    template.hasOutput('PaymentTableArn', {
      Export: { Name: 'PaymentTableArn' },
    });
  });

  test('exports Cognito User Pool ID, Client ID, and ARN', () => {
    template.hasOutput('UserPoolId', {
      Export: { Name: 'UserPoolId' },
    });
    template.hasOutput('UserPoolClientId', {
      Export: { Name: 'UserPoolClientId' },
    });
    template.hasOutput('UserPoolArn', {
      Export: { Name: 'UserPoolArn' },
    });
  });
});
