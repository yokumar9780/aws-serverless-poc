export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Payment {
  paymentId: string;
  orderId: string;
  amount: number;
  status: PaymentStatus;
  createdAt: string;
}
