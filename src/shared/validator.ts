import { z } from 'zod';
import { ORDER_STATUSES } from '../types/order';

/**
 * Zod schemas for input validation.
 * API Gateway models handle structural validation (required fields, types).
 * Zod handles business-rule validation (quantity > 0, valid enum values, etc.).
 */

export const createOrderSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  quantity: z.number().int().positive('quantity must be a positive integer'),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, {
    errorMap: () => ({ message: `status must be one of: ${ORDER_STATUSES.join(', ')}` }),
  }),
});

export const updateInventorySchema = z.object({
  productName: z.string().min(1, 'productName is required'),
  quantity: z.number().int().min(0, 'quantity must be non-negative'),
  price: z.number().positive('price must be positive'),
});

/** Parse and return validated data, or throw a formatted error string */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
    throw new ValidationError(messages.join('; '));
  }
  return result.data;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
