import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getXAccountById } from '@x-harness/db';
import type { DbXAccount } from '@x-harness/db';
import { XClient, XApiError, XApiRateLimitError } from '@x-harness/x-sdk';
import type { Env } from '../index.js';

/**
 * Read-only endpoints for the logged-in account's own bookmarks / liked tweets.
 *
 *   GET /api/x-accounts/:id/bookmarks?max_results=1-100&pagination_token=...
 *   GET /api/x-accounts/:id/liked-tweets?max_results=1-100&pagination_token=...
 *
 * Both are behind the global API-key authMiddleware (not in its public allow-list).
 * The X API response is returned almost as-is: { data, includes, meta }.
 * X API usage is billed per post read, so callers should page deliberately.
 */

export const TIMELINE_QUERY_PARAMS: Record<string, string> = {
  'tweet.fields': 'created_at,public_metrics,note_tweet,article,entities,conversation_id,referenced_tweets,attachments',
  expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name',
  'media.fields': 'url,preview_image_url,type',
};

const DEFAULT_MAX_RESULTS = 100;
const PAGINATION_TOKEN_RE = /^[A-Za-z0-9_-]{1,512}$/;

export type ParsedTimelineQuery =
  | { ok: true; maxResults: number; paginationToken?: string }
  | { ok: false; error: string };

/**
 * @param minResults X API minimum for the endpoint (bookmarks: 1, liked_tweets: 5).
 */
export function parseTimelineQuery(maxResultsRaw: string | undefined, paginationTokenRaw: string | undefined, minResults = 1): ParsedTimelineQuery {
  let maxResults = DEFAULT_MAX_RESULTS;
  if (maxResultsRaw !== undefined && maxResultsRaw !== '') {
    const msg = `max_results must be an integer between ${minResults} and 100`;
    if (!/^\d+$/.test(maxResultsRaw)) return { ok: false, error: msg };
    maxResults = Number(maxResultsRaw);
    if (maxResults < minResults || maxResults > 100) return { ok: false, error: msg };
  }
  let paginationToken: string | undefined;
  if (paginationTokenRaw !== undefined && paginationTokenRaw !== '') {
    if (!PAGINATION_TOKEN_RE.test(paginationTokenRaw)) return { ok: false, error: 'invalid pagination_token' };
    paginationToken = paginationTokenRaw;
  }
  return { ok: true, maxResults, paginationToken };
}

/** Same construction as the existing x-accounts routes (OAuth1 when all 1.0a creds exist, else bearer access_token). */
function buildClient(account: DbXAccount): XClient {
  return account.consumer_key && account.consumer_secret && account.access_token_secret
    ? new XClient({
        type: 'oauth1',
        consumerKey: account.consumer_key,
        consumerSecret: account.consumer_secret,
        accessToken: account.access_token,
        accessTokenSecret: account.access_token_secret,
      })
    : new XClient(account.access_token);
}

/**
 * Bookmarks only accept OAuth 2.0 user context (X API spec). When an account has
 * OAuth 1.0a credentials, the existing routes treat access_token as the 1.0a token,
 * so a bookmarks call could never succeed — reject before calling X (no API cost).
 */
function hasOAuth1Credentials(account: DbXAccount): boolean {
  return !!(account.consumer_key && account.consumer_secret && account.access_token_secret);
}

const MAX_ERROR_TEXT = 300;
function clip(v: string): string {
  return v.length > MAX_ERROR_TEXT ? `${v.slice(0, MAX_ERROR_TEXT)}…` : v;
}

/** Extract only safe, user-facing fields from an X API error. Never echoes tokens or headers. */
export function toSafeXError(err: unknown): { status: number; title: string; detail?: string; resetAt?: number } {
  if (err instanceof XApiRateLimitError) {
    return { status: 429, title: 'Too Many Requests', detail: 'Rate limited by X API', resetAt: err.resetAtEpoch };
  }
  if (err instanceof XApiError) {
    let title = 'X API error';
    let detail: string | undefined;
    if (err.responseBody) {
      try {
        const parsed = JSON.parse(err.responseBody) as Record<string, unknown>;
        if (typeof parsed.title === 'string') title = clip(parsed.title);
        if (typeof parsed.detail === 'string') detail = clip(parsed.detail);
        else if (Array.isArray(parsed.errors) && parsed.errors[0] && typeof (parsed.errors[0] as any).message === 'string') {
          detail = clip((parsed.errors[0] as any).message);
        }
      } catch {
        // non-JSON body: do not echo raw text
      }
    }
    const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
    return { status, title, detail };
  }
  return { status: 500, title: 'Internal error' };
}

type Kind = 'bookmarks' | 'liked-tweets';

async function handleTimeline(c: Context<Env>, kind: Kind): Promise<Response> {
  const parsed = parseTimelineQuery(c.req.query('max_results'), c.req.query('pagination_token'), kind === 'liked-tweets' ? 5 : 1);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

  const id = c.req.param('id');
  if (!id) return c.json({ success: false, error: 'Not found' }, 404);
  const account = await getXAccountById(c.env.DB, id);
  if (!account) return c.json({ success: false, error: 'Not found' }, 404);

  if (kind === 'bookmarks' && hasOAuth1Credentials(account)) {
    return c.json({
      success: false,
      error: { status: 400, title: 'OAuth 2.0 user token required', detail: 'X bookmarks API only supports OAuth 2.0 user context (scope bookmark.read). This account is configured with OAuth 1.0a credentials.' },
    }, 400);
  }

  const options = { maxResults: parsed.maxResults, params: TIMELINE_QUERY_PARAMS };
  try {
    const res = kind === 'bookmarks'
      ? await new XClient(account.access_token).getBookmarks(account.x_user_id, parsed.paginationToken, options)
      : await buildClient(account).getLikedTweets(account.x_user_id, parsed.paginationToken, options);
    return c.json({
      success: true,
      data: res.data ?? [],
      includes: res.includes ?? {},
      meta: res.meta ?? {},
      ...(res.errors ? { errors: res.errors } : {}),
    });
  } catch (err) {
    const safe = toSafeXError(err);
    // Log status/title only — never the request headers or tokens.
    console.error(`[x-accounts/${kind}] X API error status=${safe.status} title=${safe.title}`);
    return c.json({ success: false, error: { status: safe.status, title: safe.title, detail: safe.detail, resetAt: safe.resetAt } }, safe.status as ContentfulStatusCode);
  }
}

const xAccountTimelines = new Hono<Env>();

xAccountTimelines.get('/api/x-accounts/:id/bookmarks', (c) => handleTimeline(c, 'bookmarks'));
xAccountTimelines.get('/api/x-accounts/:id/liked-tweets', (c) => handleTimeline(c, 'liked-tweets'));

export { xAccountTimelines };
