import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class SharedStack extends cdk.Stack {
  public readonly orderTable: dynamodb.Table;
  public readonly inventoryTable: dynamodb.Table;
  public readonly paymentTable: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

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
    // Cognito User Pool (Phase 3)
    //
    // Managed user directory that handles signup, signin, password policy,
    // email verification, and JWT token issuance. API Gateway validates
    // tokens at the edge — invalid/expired tokens are rejected before
    // Lambda is invoked (saves compute cost).
    //
    // Self-signup is enabled for the POC so you can create test users
    // via the AWS CLI without needing an admin flow.
    // ──────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'order-management-user-pool',
      selfSignUpEnabled: true,
      // Email verification is required — users must confirm their email
      // before they can sign in. Cognito sends a verification code automatically.
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      // Password policy: 8+ chars with uppercase, lowercase, and numbers.
      // Cognito enforces this at signup — no custom validation code needed.
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false, // Keep it simple for a POC
      },
      // Standard attributes collected at signup
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      // Account recovery via verified email
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // POC only — allow clean `cdk destroy`
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cognito Hosted UI domain — required for OAuth 2.0 browser-based flows
    // (Postman, frontend apps, etc.). The prefix must be globally unique.
    // This creates: https://order-mgmt-poc.auth.eu-west-1.amazoncognito.com
    this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: 'order-mgmt-poc',
      },
    });

    // App client — public client with no secret.
    // Public clients are used by browser/mobile apps where a client secret
    // cannot be kept confidential. Cognito uses SRP (Secure Remote Password)
    // protocol instead, which never sends the password over the wire.
    this.userPoolClient = this.userPool.addClient('UserPoolClient', {
      userPoolClientName: 'order-management-client',
      authFlows: {
        userPassword: true,  // USER_PASSWORD_AUTH — simple flow for CLI/Postman testing
        userSrp: true,       // USER_SRP_AUTH — secure flow for production clients
      },
      // OAuth 2.0 configuration — enables browser-based auth flows (Postman, frontend apps)
      oAuth: {
        flows: {
          authorizationCodeGrant: true, // Recommended for public clients (PKCE)
          implicitCodeGrant: true,      // Simpler flow for quick Postman testing
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          'https://oauth.pstmn.io/v1/callback', // Postman OAuth callback
          'http://localhost:3000/callback',       // Local frontend dev
        ],
        logoutUrls: [
          'http://localhost:3000/',
        ],
      },
      // Token validity configuration
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      // No client secret — this is a public client
      generateSecret: false,
    });

    // ──────────────────────────────────────────────
    // Cross-stack exports
    // ApplicationStack will import these
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

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'UserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'UserPoolClientId',
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: 'UserPoolArn',
    });

    new cdk.CfnOutput(this, 'CognitoHostedUIDomain', {
      value: `https://order-mgmt-poc.auth.${this.region}.amazoncognito.com`,
      exportName: 'CognitoHostedUIDomain',
    });
  }
}
