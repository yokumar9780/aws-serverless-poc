import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Authenticated user identity extracted from Cognito JWT claims.
 *
 * When API Gateway validates a Cognito JWT, it decodes the token and passes
 * the claims in event.requestContext.authorizer.claims. This interface
 * provides typed access to the claims we care about.
 */
export interface AuthenticatedUser {
  /** Cognito user pool subject — unique, immutable user identifier (UUID). Used as customerId. */
  userId: string;
  /** User's email address from the token claims */
  email: string;
}

/**
 * Extract the authenticated user's identity from the API Gateway event.
 *
 * The Cognito authorizer on API Gateway validates the JWT before Lambda is
 * invoked. By the time this function runs, the token is guaranteed valid.
 * We extract the `sub` claim (unique user ID) and use it as the customerId
 * throughout the system — never trusting a client-supplied customerId.
 *
 * @throws Error if claims are missing (should never happen behind the authorizer)
 */
export function getAuthenticatedUser(event: APIGatewayProxyEvent): AuthenticatedUser {
  const claims = event.requestContext.authorizer?.claims;

  if (!claims || !claims.sub) {
    throw new Error('Missing authentication claims — is the Cognito authorizer configured?');
  }

  return {
    userId: claims.sub,
    email: claims.email || '',
  };
}
