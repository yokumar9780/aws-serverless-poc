import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { success, badRequest, notFound, serverError } from '../../shared/response';

const logger = createLogger('order-service');
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!;

/**
 * GET /orders/{orderId}
 * Retrieves a single order by its partition key.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const orderId = event.pathParameters?.orderId;
    if (!orderId) {
      return badRequest('orderId path parameter is required', requestId);
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: ORDER_TABLE,
        Key: { orderId },
      }),
    );

    if (!result.Item) {
      return notFound(`Order ${orderId} not found`, requestId);
    }

    logger.info('Order retrieved', { orderId });
    return success(result.Item as Record<string, unknown>);
  } catch (err) {
    logger.error('Failed to get order', err as Error);
    return serverError(undefined, requestId);
  }
}
