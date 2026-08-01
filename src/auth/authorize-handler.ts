import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { Env } from '../env';
import { persistGoogleTokens } from '../providers/google-health/oauth';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './google-login';

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';
// The pending MCP authorization request is parked in KV while the user is
// away at Google's consent screen; ten minutes is well past a normal login.
const PENDING_TTL_SEC = 600;

function pendingKey(state: string): string {
  return `oauth_pending_${state}`;
}

/**
 * The OAuthProvider's `defaultHandler`: everything that is not the MCP API.
 * Serves the connector's /authorize by delegating identity to Google, then
 * completes the MCP-side authorization once Google hands the user back.
 */
export function buildAuthorizeApp(): Hono<{ Bindings: OAuthEnv }> {
  const app = new Hono<{ Bindings: OAuthEnv }>();

  app.get('/', (c) =>
    c.text('fitbit-googlehealth-mcp — connect this URL as a custom connector in claude.ai'),
  );

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'fitbit-googlehealth-mcp',
      mcpProtocolVersion: '2025-06-18',
      mode: 'multi-user',
    }),
  );

  // Step 1 — claude.ai sends the user here. Park the MCP auth request and
  // bounce to Google so the user grants access to their own health data.
  app.get('/authorize', async (c) => {
    let oauthReq: AuthRequest;
    try {
      oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (err) {
      // Someone opened /authorize directly instead of arriving from an MCP
      // client — answer with guidance rather than a stack trace.
      const message = err instanceof Error ? err.message : String(err);
      return c.text(
        `Not a valid OAuth authorization request (${message}). ` +
          'Add this server as a custom connector in claude.ai instead of opening this URL directly.',
        400,
      );
    }
    if (!c.env.GOOGLE_CLIENT_ID) {
      return c.text('Server misconfigured: GOOGLE_CLIENT_ID is not set.', 500);
    }

    const state = crypto.randomUUID();
    await c.env.TOKENS.put(pendingKey(state), JSON.stringify(oauthReq), {
      expirationTtl: PENDING_TTL_SEC,
    });

    const redirectUri = new URL(GOOGLE_CALLBACK_PATH, c.req.url).toString();
    return c.redirect(buildGoogleAuthUrl({ clientId: c.env.GOOGLE_CLIENT_ID, redirectUri, state }));
  });

  // Step 2 — Google redirects back. Exchange the code, store the user's
  // Google tokens under their `sub`, and hand claude.ai its grant.
  app.get(GOOGLE_CALLBACK_PATH, async (c) => {
    const error = c.req.query('error');
    if (error) {
      return c.text(`Google authorization failed: ${error}`, 400);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.text('Missing code or state in the Google callback.', 400);
    }

    const pending = await c.env.TOKENS.get(pendingKey(state));
    if (!pending) {
      return c.text('This authorization link has expired. Reconnect the connector.', 400);
    }
    await c.env.TOKENS.delete(pendingKey(state));
    const oauthReq = JSON.parse(pending) as AuthRequest;

    const redirectUri = new URL(GOOGLE_CALLBACK_PATH, c.req.url).toString();
    let login: Awaited<ReturnType<typeof exchangeGoogleCode>>;
    try {
      login = await exchangeGoogleCode(c.env, { code, redirectUri });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.text(`Could not complete Google sign-in: ${message}`, 400);
    }

    // Google tokens live in KV under the user's `sub`, refreshed by the
    // provider's own machinery; the MCP grant only carries the identity.
    await persistGoogleTokens(c.env, login.userId, login.tokens);

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      userId: login.userId,
      metadata: { email: login.email },
      scope: oauthReq.scope,
      props: { userId: login.userId, email: login.email },
    });
    return c.redirect(redirectTo);
  });

  return app;
}
