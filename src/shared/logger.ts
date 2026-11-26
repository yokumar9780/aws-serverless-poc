import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Create a Powertools Logger instance for a given service name.
 *
 * Usage in handlers:
 *   const logger = createLogger('order-service');
 *   logger.info('Order created', { orderId, customerId });
 *
 * Outputs structured JSON logs with:
 * - Correlation IDs (X-Ray trace ID)
 * - Lambda context (function name, memory, cold start)
 * - Custom attributes you append
 */
export function createLogger(serviceName: string): Logger {
  return new Logger({
    serviceName,
    logLevel: process.env.LOG_LEVEL || 'INFO',
    persistentLogAttributes: {
      environment: process.env.ENVIRONMENT || 'dev',
    },
  });
}
