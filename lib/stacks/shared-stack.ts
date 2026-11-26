import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class SharedStack extends cdk.Stack {
  public readonly orderTable: dynamodb.Table;
  public readonly inventoryTable: dynamodb.Table;
  public readonly paymentTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ──────────────────────────────────────────────
    // Order Table
    // PK: orderId (UUID — high cardinality, even distribution)
    // GSI1: customerId-index — query orders by customer
    // GSI2: status-createdAt-index — query orders by status, sorted by creation date
    // ──────────────────────────────────────────────
    this.orderTable = new dynamodb.Table(this, 'OrderTable', {
      tableName: 'Orders',
      partitionKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only — never in production
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES, // Needed for Phase 5 (DynamoDB Streams)
    });

    // GSI1: Get orders by customerId, sorted by createdAt
    this.orderTable.addGlobalSecondaryIndex({
      indexName: 'customerId-index',
      partitionKey: {
        name: 'customerId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Get orders by status, sorted by createdAt (used for stale order cleanup in Phase 9)
    this.orderTable.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ──────────────────────────────────────────────
    // Inventory Table
    // PK: productId — simple key-value lookup
    // ──────────────────────────────────────────────
    this.inventoryTable = new dynamodb.Table(this, 'InventoryTable', {
      tableName: 'Inventory',
      partitionKey: {
        name: 'productId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ──────────────────────────────────────────────
    // Payment Table
    // PK: paymentId (UUID)
    // GSI: orderId-index — lookup payment by orderId (used in Phase 7 Step Functions)
    // ──────────────────────────────────────────────
    this.paymentTable = new dynamodb.Table(this, 'PaymentTable', {
      tableName: 'Payments',
      partitionKey: {
        name: 'paymentId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI: Look up payment by orderId
    this.paymentTable.addGlobalSecondaryIndex({
      indexName: 'orderId-index',
      partitionKey: {
        name: 'orderId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ──────────────────────────────────────────────
    // Cross-stack exports
    // ApplicationStack will import these in Phase 2
    // ──────────────────────────────────────────────
    new cdk.CfnOutput(this, 'OrderTableName', {
      value: this.orderTable.tableName,
      exportName: 'OrderTableName',
    });

    new cdk.CfnOutput(this, 'OrderTableArn', {
      value: this.orderTable.tableArn,
      exportName: 'OrderTableArn',
    });

    new cdk.CfnOutput(this, 'InventoryTableName', {
      value: this.inventoryTable.tableName,
      exportName: 'InventoryTableName',
    });

    new cdk.CfnOutput(this, 'InventoryTableArn', {
      value: this.inventoryTable.tableArn,
      exportName: 'InventoryTableArn',
    });

    new cdk.CfnOutput(this, 'PaymentTableName', {
      value: this.paymentTable.tableName,
      exportName: 'PaymentTableName',
    });

    new cdk.CfnOutput(this, 'PaymentTableArn', {
      value: this.paymentTable.tableArn,
      exportName: 'PaymentTableArn',
    });
  }
}
