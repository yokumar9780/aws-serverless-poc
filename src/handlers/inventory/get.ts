import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { success, badRequest, notFound, serverError } from '../../shared/response';

const logger = createLogger('inventory-service');
const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;

/**
 * GET /inventory/{productId}
 * Retrieves a single inventory item by product ID.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const productId = event.pathParameters?.productId;
    if (!productId) {
      return badRequest('productId path parameter is required', requestId);
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: INVENTORY_TABLE,
        Key: { productId },
      }),
    );

    if (!result.Item) {
      return notFound(`Product ${productId} not found`, requestId);
    }

    logger.info('Inventory item retrieved', { productId });
    return success(result.Item as Record<string, unknown>);
  } catch (err) {
    logger.error('Failed to get inventory item', err as Error);
    return serverError(undefined, requestId);
  }
}
