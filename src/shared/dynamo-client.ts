import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Singleton DynamoDB Document Client.
 *
 * Defined outside the Lambda handler so it's initialized once during cold start
 * and reused across warm invocations. The SDK reuses TCP connections automatically.
 */
const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
});

export const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true, // Strip undefined fields instead of throwing
  },
});
