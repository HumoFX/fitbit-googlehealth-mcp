import type { ZodType } from 'zod';
import type { Env } from '../../env';
import { GoogleHealthApiError, GoogleHealthRateLimitError } from '../../lib/errors';
import { parseRetryAfter, sleep } from '../../lib/rate-limit';
import { getGoogleAccessToken, invalidateGoogleAccessToken } from './oauth';

const GH_API_BASE = 'https://health.googleapis.com/v4';

export type GoogleHealthRequest = {
  /** Path relative to the v4 base, starting with `/`, e.g. `/users/me/dataTypes/sleep/dataPoints:reconcile`. */
  path: string;
  method?: 'GET' | 'POST';
  /** Query parameters appended to the URL (filter, pageSize, pageToken, dataSourceFamily). */
  query?: Record<string, string | number | undefined>;
  /** JSON body for POST custom methods (`:rollUp`, `:dailyRollUp`). */
  json?: unknown;
};

export class GoogleHealthClient {
  constructor(private readonly env: Env) {}

  async requestJson<T>(schema: ZodType<T>, req: GoogleHealthRequest): Promise<T> {
    const body = await this.requestText(req);
    const parsed = schema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      // Include a slice of the raw body so schema mismatches are diagnosable
      // from the MCP tool error alone (mirrors FitbitClient behaviour).
      const rawPreview = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      throw new GoogleHealthApiError(
        200,
        `Schema validation failed at ${req.path}: ${parsed.error.message}\nRaw body preview: ${rawPreview}`,
        req.path,
      );
    }
    return parsed.data;
  }

  async requestText(req: GoogleHealthRequest): Promise<string> {
    const url = new URL(`${GH_API_BASE}${req.path}`);
    if (req.query) {
      for (const [k, v] of Object.entries(req.query)) {
        if (v !== undefined && v !== null && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }

    let attempt = 0;
    const MAX_ATTEMPTS = 3; // original + one refresh retry + one rate-limit retry
    while (true) {
      attempt++;
      const token = await getGoogleAccessToken(this.env);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };

      let body: BodyInit | undefined;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers['Content-Type'] = 'application/json';
      }

      const t0 = Date.now();
      const res = await fetch(url, { method: req.method ?? 'GET', headers, body });
      const ms = Date.now() - t0;
      const method = req.method ?? 'GET';

      if (res.status === 401 && attempt === 1) {
        // token was rejected — force refresh and try once
        console.log(`[google-health] ${method} ${req.path} → 401 after ${ms}ms, refreshing token`);
        await invalidateGoogleAccessToken(this.env);
        continue;
      }

      if (res.status === 429) {
        // Google documents no Retry-After for this API; parseRetryAfter falls
        // back to a short clamped delay when the header is absent.
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'));
        if (attempt < MAX_ATTEMPTS) {
          console.log(
            `[google-health] ${method} ${req.path} → 429, sleeping ${waitSec}s before retry`,
          );
          await sleep(waitSec * 1000);
          continue;
        }
        throw new GoogleHealthRateLimitError(waitSec, req.path);
      }

      const text = await res.text();
      if (!res.ok) {
        console.log(
          `[google-health] ${method} ${req.path} → ${res.status} after ${ms}ms: ${text.slice(0, 300)}`,
        );
        throw new GoogleHealthApiError(res.status, text, req.path);
      }
      return text;
    }
  }
}

/**
 * Follow `nextPageToken` pagination until exhausted, concatenating page items.
 * `maxPages` bounds the loop — sleep/exercise pages are capped at 25 items by
 * the API, so long ranges can span many pages.
 */
export async function paginate<T>(
  fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string }>,
  opts: { maxPages?: number } = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 20;
  const all: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items, nextPageToken } = await fetchPage(pageToken);
    all.push(...items);
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return all;
}
