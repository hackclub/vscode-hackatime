import * as crypto from 'crypto';

// one login attempt: `state` ties the browser callback to the attempt this window started,
// and the PKCE verifier proves to the server that the code is being redeemed by that same
// attempt. desktop only (node crypto), the web build doesn't log in through a browser.
export interface OAuthAttempt {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export function newOAuthAttempt(): OAuthAttempt {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  return {
    state: crypto.randomBytes(16).toString('base64url'),
    codeVerifier,
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
  };
}

export function authorizeUrl(
  baseUrl: string,
  clientId: string,
  redirectUri: string,
  attempt: OAuthAttempt,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: attempt.state,
    code_challenge: attempt.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${baseUrl}/oauth/authorize?${params.toString()}`;
}

export function stateMatches(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
