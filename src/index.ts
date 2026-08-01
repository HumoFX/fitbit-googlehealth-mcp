import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { buildAuthorizeApp } from './auth/authorize-handler';
import { guardMiddleware } from './auth/guard';
import type { Env } from './env';
import { buildServer } from './server';

/**
 * Single-user surface (kept for existing personal deployments): the MCP
 * endpoint is protected by a shared secret in the path plus the Anthropic
 * CIDR allowlist, and reads whichever provider HEALTH_PROVIDER selects.
 */
const legacyApp = new Hono<{ Bindings: Env }>();

legacyApp.get('/', (c) => c.text('fitbit-googlehealth-mcp — see /health and POST /mcp/:secret'));

legacyApp.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'fitbit-googlehealth-mcp',
    mcpProtocolVersion: '2025-06-18',
  }),
);

legacyApp.post('/mcp/:secret', guardMiddleware(), async (c) => {
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(c);
  return response ?? c.text('', 200);
});

export { legacyApp };

/**
 * Multi-user surface: the Worker is an OAuth 2.1 authorization server that
 * claude.ai registers with dynamically; each user grants access to their own
 * Google Health data. `/mcp` requests carry an access token whose props
 * identify the user, and every read is scoped to them.
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: { userId?: string } }).props;
    const userId = props?.userId;
    if (!userId) {
      return new Response('Unauthorized: no user bound to this token.', { status: 401 });
    }

    const app = new Hono<{ Bindings: Env }>();
    app.all('/mcp', async (c) => {
      const server = buildServer(c.env, userId);
      const transport = new StreamableHTTPTransport();
      await server.connect(transport);
      const response = await transport.handleRequest(c);
      return response ?? c.text('', 200);
    });
    return app.fetch(request, env, ctx);
  },
};

/**
 * Multi-user mode activates when the OAUTH_KV namespace is bound; without
 * it the Worker keeps serving the single-user routes unchanged.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.OAUTH_KV) {
      return legacyApp.fetch(request, env, ctx);
    }

    const url = new URL(request.url);
    // The shared-secret route stays available on multi-user deployments so
    // an existing personal connector keeps working after the upgrade.
    if (url.pathname.startsWith('/mcp/')) {
      return legacyApp.fetch(request, env, ctx);
    }

    const provider = new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler as never,
      defaultHandler: buildAuthorizeApp() as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['health.read'],
    });
    return provider.fetch(request, env as never, ctx);
  },
};
