#!/usr/bin/env tsx
/**
 * One-shot Google Health OAuth bootstrap CLI.
 *
 *   export GOOGLE_CLIENT_ID=...
 *   export GOOGLE_CLIENT_SECRET=...
 *   pnpm run setup:google-health
 *
 * Starts a tiny localhost callback server, walks the user through the
 * Authorization Code + PKCE flow in their system browser, exchanges the
 * code for tokens, and prints the exact `wrangler` commands needed to
 * move those tokens into Workers KV / Secrets.
 *
 * Prerequisites (Google Cloud Console):
 *   1. Enable the Google Health API:
 *      https://console.developers.google.com/apis/library/health.googleapis.com
 *   2. Create an OAuth client (type "Web application") and add
 *      http://127.0.0.1:8788/google-health/callback to its
 *      Authorized redirect URIs.
 *   3. On the Data Access page, add the three googlehealth *.readonly
 *      scopes requested below.
 *   4. Publish the consent screen ("In production"): while it stays in
 *      "Testing", refresh tokens expire after 7 days and the unattended
 *      Worker refresh will break. Unverified production clients are fine
 *      for up to 100 users.
 *
 * The MCP Worker itself never runs this code path — Claude mobile /
 * claude.ai never sees the Google OAuth screen. This avoids Google's
 * `disallowed_useragent` policy that blocks embedded WebViews.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALLBACK_HOST = '127.0.0.1';
// 8788 so the callback can run alongside `wrangler dev` (which owns 8787).
const CALLBACK_PORT = 8788;
const CALLBACK_PATH = '/google-health/callback';

// Read scopes for the MVP tools. heart-rate's owning scope is documented
// inconsistently (activity_and_fitness vs health_metrics_and_measurements),
// and the MVP needs both scopes anyway, so both are requested.
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  // Writes are a separate scope family; without these the log_* tools 403.
  'https://www.googleapis.com/auth/googlehealth.nutrition.writeonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.writeonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.writeonly',
];

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function mask(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  // execFile (no shell) so nothing in the URL is ever shell-interpreted.
  const [cmd, args]: [string, string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => {
    // best effort; user can copy the URL from stdout
  });
}

function waitForCallback(opts: { expectedState: string }): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? '';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Google authorization error</h1><pre>${error}\n${desc}</pre>`);
        server.close();
        reject(new Error(`Google OAuth error: ${error} ${desc}`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }
      if (state !== opts.expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch — possible CSRF'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 24px}</style></head>
<body>
<h1>✓ Authorized</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`);
      server.close();
      resolve({ code });
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
  });
}

async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponseT> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const json = JSON.parse(text);
  return TokenResponse.parse(json);
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
    console.error('');
    console.error('  1. Enable the Google Health API in your Cloud project:');
    console.error('     https://console.developers.google.com/apis/library/health.googleapis.com');
    console.error('  2. Create an OAuth client (type "Web application") with this redirect URI:');
    console.error(`     http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`);
    console.error('  3. Add the googlehealth read + write scopes on the Data Access page.');
    console.error('  4. Export the values:');
    console.error('     export GOOGLE_CLIENT_ID=...');
    console.error('     export GOOGLE_CLIENT_SECRET=...');
    console.error('  5. Run again: pnpm run setup:google-health');
    process.exit(1);
  }

  const state = base64url(randomBytes(16));
  const { verifier, challenge } = generatePkce();
  const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  // offline + consent → Google issues a refresh_token for unattended use.
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('');
  console.log('Google Health OAuth bootstrap');
  console.log('─────────────────────────────');
  console.log('');
  console.log("Callback URL (must be in the OAuth client's Authorized redirect URIs):");
  console.log(`  ${redirectUri}`);
  console.log('');
  console.log('Opening authorization URL in your default browser…');
  console.log('(If it does not open automatically, copy-paste this URL:)');
  console.log('');
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(`Waiting for callback on ${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH} …`);
  console.log('');

  openInBrowser(authUrl.toString());

  const { code } = await waitForCallback({ expectedState: state });

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. This usually means the client was already ' +
        'authorized without `prompt=consent`. Revoke access at ' +
        'https://myaccount.google.com/permissions and run the setup again.',
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;

  console.log('✓ Got tokens');
  console.log('');
  console.log(`  scope:         ${tokens.scope ?? '(not echoed)'}`);
  console.log(`  token_type:    ${tokens.token_type}`);
  console.log(`  access_token:  ${mask(tokens.access_token)}`);
  console.log(`  refresh_token: ${mask(tokens.refresh_token)}`);
  console.log(`  expires_in:    ${tokens.expires_in}s (unix epoch: ${expiresAt})`);
  console.log('');
  console.log('Next: store these on Cloudflare Workers.');
  console.log('──────────────────────────────────────────');
  console.log('');
  console.log('⚠ The commands below contain the RAW tokens (they are meant to be');
  console.log('  copy-pasted). Clear your terminal scrollback and shell history');
  console.log('  afterwards, and never paste them anywhere else.');
  console.log('');
  console.log('1) Secrets (skip any that are already set):');
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_ID');
  console.log(`     ↳ value: ${clientId}`);
  console.log('   pnpm wrangler secret put GOOGLE_CLIENT_SECRET');
  console.log('     ↳ value: <your OAuth client secret>');
  console.log('');
  console.log('2) Google tokens into the TOKENS KV namespace (gh_* keys):');
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS gh_refresh_token '${tokens.refresh_token}'`,
  );
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS gh_access_token  '${tokens.access_token}'`,
  );
  console.log(
    `   pnpm wrangler kv key put --remote --binding=TOKENS gh_expires_at    '${expiresAt}'`,
  );
  console.log('');
  console.log('3) Switch the provider in wrangler.toml:');
  console.log('   HEALTH_PROVIDER = "google_health"');
  console.log('');
  console.log('4) Deploy: pnpm deploy');
  console.log('');
  console.log('⚠ Reminder: keep the OAuth consent screen published ("In production").');
  console.log('  In "Testing" status this refresh token dies after 7 days.');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
