import { createHash, timingSafeEqual } from 'node:crypto';

import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

/**
 * Shared company token. This is not an OAuth authorization server.
 * AuthInfo.expiresAt is a per-request assertion window required by the SDK.
 * The secret itself stays valid until MCP_AUTH_TOKEN is rotated.
 */
export function sharedTokenVerifier(expectedToken: string): OAuthTokenVerifier {
  const expectedHash = createHash('sha256').update(expectedToken).digest();
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const givenHash = createHash('sha256').update(token).digest();
      if (!timingSafeEqual(expectedHash, givenHash)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
      }
      return {
        token,
        clientId: 'company-shared',
        scopes: ['mcp'],
        expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
      };
    },
  };
}
