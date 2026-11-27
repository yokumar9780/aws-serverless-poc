import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { getAuthenticatedUser } from '../../shared/auth';
import { success, serverError } from '../../shared/response';

const logger = createLogger('order-service');
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!;
const CUSTOMER_ID_INDEX = 'customerId-index';

/**
 * GET /orders
 * Lists orders for the authenticated user using the customerId GSI.
 *
 * The customerId is extracted from the JWT `sub` claim — the user can only
 * see their own orders. No query parameter needed; identity comes from the
 * verified token.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    // Extract authenticated user from Cognito JWT claims
    const user = getAuthenticatedUser(event);
    const customerId = user.userId;
    logger.appendKeys({ customerId });

    const result = await docClient.send(
      new QueryCommand({
        TableName: ORDER_TABLE,
        IndexName: CUSTOMER_ID_INDEX,
        KeyConditionExpression: 'customerId = :cid',
        ExpressionAttributeValues: { ':cid': customerId },
        ScanIndexForward: false, // newest first (descending createdAt)
      }),
    );

    logger.info('Orders listed', { customerId, count: result.Items?.length ?? 0 });
    return success(result.Items as Record<string, unknown>[]);
  } catch (err) {
    logger.error('Failed to list orders', err as Error);
    return serverError(undefined, requestId);
  }
}
