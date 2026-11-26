import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { success, badRequest, serverError } from '../../shared/response';

const logger = createLogger('order-service');
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!;
const CUSTOMER_ID_INDEX = 'customerId-index';

/**
 * GET /orders?customerId=X
 * Lists orders for a customer using the customerId GSI (not a table scan).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const customerId = event.queryStringParameters?.customerId;
    if (!customerId) {
      return badRequest('customerId query parameter is required', requestId);
    }

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
