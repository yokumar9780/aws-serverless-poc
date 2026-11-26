import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { validate, createOrderSchema, ValidationError } from '../../shared/validator';
import { success, created, badRequest, notFound, serverError } from '../../shared/response';
import type { Order } from '../../types/order';
import type { Inventory } from '../../types/inventory';

const logger = createLogger('order-service');
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!;
const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;

/**
 * POST /orders
 * Creates a new order with status PENDING.
 * Validates input with Zod, looks up product price from Inventory table.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const body = JSON.parse(event.body || '{}');
    const input = validate(createOrderSchema, body);

    // Look up product to get price and verify it exists
    const inventoryResult = await docClient.send(
      new GetCommand({
        TableName: INVENTORY_TABLE,
        Key: { productId: input.productId },
      }),
    );

    if (!inventoryResult.Item) {
      return notFound(`Product ${input.productId} not found`, requestId);
    }

    const product = inventoryResult.Item as Inventory;
    const now = new Date().toISOString();
    const order: Order = {
      orderId: uuidv4(),
      customerId: body.customerId || 'anonymous', // Phase 3 replaces with JWT subclaim
      productId: input.productId,
      quantity: input.quantity,
      status: 'PENDING',
      totalAmount: product.price * input.quantity,
      createdAt: now,
      updatedAt: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: ORDER_TABLE,
        Item: order,
      }),
    );

    logger.info('Order created', { orderId: order.orderId, customerId: order.customerId });
    return created(order as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ValidationError) {
      return badRequest(err.message, requestId);
    }
    if (err instanceof SyntaxError) {
      return badRequest('Invalid JSON in request body', requestId);
    }
    logger.error('Failed to create order', err as Error);
    return serverError(undefined, requestId);
  }
}
