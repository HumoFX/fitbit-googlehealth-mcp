import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { FitbitProvider } from './providers/fitbit';
import { GoogleHealthProvider } from './providers/google-health';
import type { HealthProvider } from './providers/types';
import { registerAllTools } from './tools';

/**
 * Pick the HealthProvider backend from HEALTH_PROVIDER (default: fitbit).
 * When `userId` is given the request came through a multi-user OAuth grant,
 * which only ever exists for Google Health — the env setting is bypassed.
 */
export function selectProvider(env: Env, userId?: string): HealthProvider {
  if (userId) {
    return new GoogleHealthProvider(env, userId);
  }
  const name = env.HEALTH_PROVIDER ?? 'fitbit';
  switch (name) {
    case 'fitbit':
      return new FitbitProvider(env);
    case 'google_health':
      return new GoogleHealthProvider(env);
    default:
      throw new Error(`Unknown HEALTH_PROVIDER "${name}" — expected "fitbit" or "google_health".`);
  }
}

export function buildServer(env: Env, userId?: string): McpServer {
  const server = new McpServer({
    name: 'fitbit-googlehealth-mcp',
    version: '0.1.0',
  });
  const provider = selectProvider(env, userId);
  // Cache entries are scoped to the user so no grant ever reads another's data.
  const scopedEnv: Env = userId ? { ...env, CACHE_USER_NS: userId } : env;
  registerAllTools(server, provider, scopedEnv);
  return server;
}
