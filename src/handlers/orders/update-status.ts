import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../../shared/dynamo-client';
import { createLogger } from '../../shared/logger';
import { validate, updateOrderStatusSchema, ValidationError } from '../../shared/validator';
import { success, badRequest, notFound, serverError } from '../../shared/response';
import { STATUS_TRANSITIONS } from '../../types/order';
import type { Order, OrderStatus } from '../../types/order';

const logger = createLogger('order-service');
const ORDER_TABLE = process.env.ORDER_TABLE_NAME!;

/**
 * PUT /orders/{orderId}/status
 * Updates an order's status after validating the transition is allowed.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  logger.appendKeys({ requestId });

  try {
    const orderId = event.pathParameters?.orderId;
    if (!orderId) {
      return badRequest('orderId path parameter is required', requestId);
    }

    const body = JSON.parse(event.body || '{}');
    const input = validate(updateOrderStatusSchema, body);

    // Fetch current order to check transition validity
    const getResult = await docClient.send(
      new GetCommand({
        TableName: ORDER_TABLE,
        Key: { orderId },
      }),
    );

    if (!getResult.Item) {
      return notFound(`Order ${orderId} not found`, requestId);
    }

    const order = getResult.Item as Order;
    const currentStatus = order.status;
    const newStatus = input.status as OrderStatus;

    // Validate status transition
    const allowedTransitions = STATUS_TRANSITIONS[currentStatus];
    if (!allowedTransitions.includes(newStatus)) {
      return badRequest(
        `Cannot transition from ${currentStatus} to ${newStatus}. Allowed: ${allowedTransitions.join(', ') || 'none (terminal state)'}`,
        requestId,
      );
    }

    const now = new Date().toISOString();
    const updateResult = await docClient.send(
      new UpdateCommand({
        TableName: ORDER_TABLE,
        Key: { orderId },
        UpdateExpression: 'SET #status = :newStatus, updatedAt = :now',
        // Conditional write prevents race conditions: only update if status hasn't changed
        ConditionExpression: '#status = :currentStatus',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':newStatus': newStatus,
          ':currentStatus': currentStatus,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    logger.info('Order status updated', { orderId, from: currentStatus, to: newStatus });
    return success(updateResult.Attributes as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ValidationError) {
      return badRequest(err.message, requestId);
    }
    if (err instanceof SyntaxError) {
      return badRequest('Invalid JSON in request body', requestId);
    }
    // DynamoDB ConditionalCheckFailedException — race condition
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      return badRequest('Order status was modified concurrently. Please retry.', requestId);
    }
    logger.error('Failed to update order status', err as Error);
    return serverError(undefined, requestId);
  }
}
