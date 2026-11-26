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
});
