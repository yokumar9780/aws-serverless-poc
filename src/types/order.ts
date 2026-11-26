/** Valid order statuses and their allowed transitions */
export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed status transitions — key can transition to any value in the array */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: [], // terminal state
  CANCELLED: [], // terminal state
};

export interface Order {
  orderId: string;
  customerId: string;
  productId: string;
  quantity: number;
  status: OrderStatus;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderInput {
  productId: string;
  quantity: number;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus;
}
