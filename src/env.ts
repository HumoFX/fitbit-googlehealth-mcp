export type Env = {
  TOKENS: KVNamespace;
  CACHE: KVNamespace;
  /**
   * Bound only on multi-user deployments; its presence switches the Worker
   * from the shared-secret single-user surface to the OAuth server.
   */
  OAUTH_KV?: KVNamespace;
  FITBIT_CLIENT_ID: string;
  FITBIT_CLIENT_SECRET: string;
  MCP_SHARED_SECRET: string;
  ALLOWED_CIDRS: string;
  /** Which HealthProvider backs the tools. Defaults to 'fitbit' when unset. */
  HEALTH_PROVIDER?: 'fitbit' | 'google_health';
  /** Google Cloud OAuth client for the Google Health API provider. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Set per request (never in wrangler.toml) to scope cache keys to the
   * authenticated user in multi-user mode. Absent in single-user mode.
   */
  CACHE_USER_NS?: string;
};
