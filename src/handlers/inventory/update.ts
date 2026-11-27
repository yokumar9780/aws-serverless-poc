import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { validate, updateInventorySchema, ValidationError } from '../../shared/validator';
import { success, badRequest, serverError } from '../../shared/response';
import type { Inventory } from '../../types/inventory';

const logger = createLogger('inventory-service');
const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;

/**
 * PUT /inventory/{productId}
 * Creates or updates an inventory item (upsert).
 * Used to seed inventory data and adjust stock/price.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const productId = event.pathParameters?.productId;
    if (!productId) {
      return badRequest('productId path parameter is required', requestId);
    }

    const body = JSON.parse(event.body || '{}');
    const input = validate(updateInventorySchema, body);

    const now = new Date().toISOString();
    const item: Inventory = {
      productId,
      productName: input.productName,
      quantity: input.quantity,
      price: input.price,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: INVENTORY_TABLE,
        Item: item,
      }),
    );

    logger.info('Inventory item updated', { productId, productName: input.productName });
    return success(item as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ValidationError) {
      return badRequest(err.message, requestId);
    }
    if (err instanceof SyntaxError) {
      return badRequest('Invalid JSON in request body', requestId);
    }
    logger.error('Failed to update inventory item', err as Error);
    return serverError(undefined, requestId);
  }
}
