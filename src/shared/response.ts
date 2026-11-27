import type { APIGatewayProxyResult } from 'aws-lambda';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*', // Tightened in production to specific domain
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

/**
 * Build a consistent API Gateway proxy response.
 * Every handler uses this — keeps response shape predictable for clients.
 */
export function success(body: Record<string, unknown> | unknown[], statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

export function created(body: Record<string, unknown>): APIGatewayProxyResult {
  return success(body, 201);
}

export function error(
  statusCode: number,
  message: string,
  requestId?: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({
      statusCode,
      message,
      ...(requestId && { requestId }),
    }),
  };
}

export function badRequest(message: string, requestId?: string): APIGatewayProxyResult {
  return error(400, message, requestId);
}

export function notFound(message: string, requestId?: string): APIGatewayProxyResult {
  return error(404, message, requestId);
}

export function serverError(message = 'Internal server error', requestId?: string): APIGatewayProxyResult {
  return error(500, message, requestId);
}

export function unauthorized(message = 'Unauthorized', requestId?: string): APIGatewayProxyResult {
  return error(401, message, requestId);
}

export function forbidden(message = 'Forbidden', requestId?: string): APIGatewayProxyResult {
  return error(403, message, requestId);
}
