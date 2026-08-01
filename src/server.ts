import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env';
import { FitbitProvider } from './providers/fitbit';
import { GoogleHealthProvider } from './providers/google-health';
import type { HealthProvider } from './providers/types';
import { registerAllTools } from './tools';

/** Pick the HealthProvider backend from HEALTH_PROVIDER (default: fitbit). */
export function selectProvider(env: Env): HealthProvider {
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

export function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'fitbit-googlehealth-mcp',
    version: '0.1.0',
  });
  const provider = selectProvider(env);
  registerAllTools(server, provider, env);
  return server;
}
