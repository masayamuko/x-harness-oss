import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XClient } from '@x-harness/x-sdk';

// --- mocks ---
const baseAccount = {
  id: 'acc1',
  x_user_id: '12345',
  username: 'me',
  display_name: 'Me',
  access_token: 'oauth2-access-token-SECRET',
  refresh_token: 'refresh-token-SECRET',
  consumer_key: null as string | null,
  consumer_secret: null as string | null,
  access_token_secret: null as string | null,
  is_active: 1,
  created_at: '2026-11-08 00:00:00',
  updated_at: '2026-11-08 00:00:00',
};

const getXAccountByIdMock = vi.fn(async (_db: any, id: string): Promise<any> => (id === 'acc1' ? { ...baseAccount } : null));

const updateXAccountMock = vi.fn(async (..._a: any[]) => null);

vi.mock('@x-harness/db', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getXAccountById: (...a: any[]) => getXAccountByIdMock(...(a as [any, string])),
  updateXAccount: (...a: any[]) => updateXAccountMock(...a),
}));

import { xAccountTimelines, parseTimelineQuery } from '../x-account-timelines.js';

const env = { DB: {} } as any;

const xBody = {
  data: [{ id: 't1', text: 'hello', author_id: 'u1', created_at: '2026-11-01T00:00:00.000Z' }],
  includes: {
    users: [{ id: 'u1', username: 'alice', name: 'Alice' }],
    media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/x.jpg' }],
  },
  meta: { result_count: 1, next_token: 'NEXT123' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(xBody), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(path: string) {
  return xAccountTimelines.request(new Request(`http://local${path}`), undefined, env);
}

describe('parseTimelineQuery', () => {
  it('defaults max_results to 100', () => {
    expect(parseTimelineQuery(undefined, undefined)).toEqual({ ok: true, maxResults: 100, paginationToken: undefined });
  });
  it('accepts 1 and 100', () => {
    expect(parseTimelineQuery('1', undefined)).toMatchObject({ ok: true, maxResults: 1 });
    expect(parseTimelineQuery('100', undefined)).toMatchObject({ ok: true, maxResults: 100 });
  });
  it('rejects out-of-range or non-integer max_results', () => {
    for (const v of ['0', '101', '-1', '5.5', 'abc']) {
      expect(parseTimelineQuery(v, undefined).ok).toBe(false);
    }
  });
  it('enforces a per-endpoint minimum (liked_tweets: 5)', () => {
    expect(parseTimelineQuery('4', undefined, 5).ok).toBe(false);
    expect(parseTimelineQuery('5', undefined, 5)).toMatchObject({ ok: true, maxResults: 5 });
  });
  it('rejects pagination_token with unsafe characters', () => {
    expect(parseTimelineQuery(undefined, 'abc&expansions=x').ok).toBe(false);
    expect(parseTimelineQuery(undefined, '7140dibdnow9c7btw3w29grvxfcgvpb9n9coehpk7xz5i').ok).toBe(true);
  });
});

describe('GET /api/x-accounts/:id/bookmarks', () => {
  it('returns { data, includes, meta } from X and calls the bookmarks endpoint with fields/expansions', async () => {
    const res = await get('/api/x-accounts/acc1/bookmarks?max_results=10&pagination_token=PAGE1');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data).toEqual(xBody.data);
    expect(body.includes).toEqual(xBody.includes);
    expect(body.meta).toEqual(xBody.meta);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(urlArg);
    expect(url.pathname).toBe('/2/users/12345/bookmarks');
    expect(url.searchParams.get('max_results')).toBe('10');
    expect(url.searchParams.get('pagination_token')).toBe('PAGE1');
    expect(url.searchParams.get('tweet.fields')).toBe('created_at,public_metrics,note_tweet,article,entities,conversation_id,referenced_tweets,attachments');
    expect(url.searchParams.get('expansions')).toBe('author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys');
    expect(url.searchParams.get('user.fields')).toBe('username,name');
    expect(url.searchParams.get('media.fields')).toBe('url,preview_image_url,type');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer oauth2-access-token-SECRET');
    expect(init.method).toBe('GET');
  });

  it('rejects bookmarks for OAuth1-configured accounts without calling X (bookmarks need OAuth 2.0)', async () => {
    getXAccountByIdMock.mockResolvedValueOnce({ ...baseAccount, consumer_key: 'ck', consumer_secret: 'cs', access_token_secret: 'ats' });
    const res = await get('/api/x-accounts/acc1/bookmarks');
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.title).toBe('OAuth 2.0 user token required');
    expect(text).not.toContain('SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown account without calling X', async () => {
    const res = await get('/api/x-accounts/nope/bookmarks');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid max_results without calling X', async () => {
    const res = await get('/api/x-accounts/acc1/bookmarks?max_results=500');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getXAccountByIdMock).not.toHaveBeenCalled();
  });

  it('passes through X error status/title/detail and never leaks tokens', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      title: 'Unsupported Authentication',
      detail: 'Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint.',
      type: 'https://api.twitter.com/2/problems/unsupported-authentication',
      status: 403,
    }), { status: 403 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('/api/x-accounts/acc1/bookmarks');
    expect(res.status).toBe(403);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.success).toBe(false);
    expect(body.error.status).toBe(403);
    expect(body.error.title).toBe('Unsupported Authentication');
    expect(body.error.detail).toContain('forbidden');
    expect(text).not.toContain('SECRET');
    for (const call of errSpy.mock.calls) expect(call.map(String).join(' ')).not.toContain('SECRET');
    errSpy.mockRestore();
  });

  it('returns 429 with resetAt on rate limit', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'x-rate-limit-reset': '1800000000' } }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('/api/x-accounts/acc1/bookmarks');
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.resetAt).toBe(1800000000);
    errSpy.mockRestore();
  });

  it('clips long X error detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Bad', detail: 'x'.repeat(1000) }), { status: 400 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('/api/x-accounts/acc1/bookmarks');
    const body = await res.json() as any;
    expect(body.error.detail.length).toBeLessThanOrEqual(301);
    errSpy.mockRestore();
  });

  it('does not echo non-JSON X error bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>oops token=SECRET</html>', { status: 502 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get('/api/x-accounts/acc1/bookmarks');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('SECRET');
    errSpy.mockRestore();
  });
});

describe('GET /api/x-accounts/:id/liked-tweets', () => {
  it('calls the liked_tweets endpoint and returns the X payload', async () => {
    const res = await get('/api/x-accounts/acc1/liked-tweets?max_results=50');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual(xBody.data);
    expect(body.meta.next_token).toBe('NEXT123');
    const [urlArg] = fetchMock.mock.calls[0] as [string];
    const url = new URL(urlArg);
    expect(url.pathname).toBe('/2/users/12345/liked_tweets');
    expect(url.searchParams.get('max_results')).toBe('50');
    expect(url.searchParams.get('expansions')).toContain('attachments.media_keys');
  });

  it('returns 400 for max_results below 5 without calling X', async () => {
    const res = await get('/api/x-accounts/acc1/liked-tweets?max_results=3');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses OAuth1 when the account has 1.0a credentials (same as existing routes)', async () => {
    getXAccountByIdMock.mockResolvedValueOnce({ ...baseAccount, consumer_key: 'ck', consumer_secret: 'cs', access_token_secret: 'ats' });
    await get('/api/x-accounts/acc1/liked-tweets');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^OAuth /);
  });
});

describe('OAuth2 auto-refresh (same client-factory as the other routes)', () => {
  const oauth2Env = { DB: {}, OAUTH2_CLIENT_ID: 'cid', OAUTH2_CLIENT_SECRET: 'csecret-SECRET' } as any;

  it('on 401, refreshes once, saves the rotated tokens, and retries with the new access token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"title":"Unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }), { status: 200 }));
    const res = await xAccountTimelines.request(new Request('http://local/api/x-accounts/acc1/bookmarks'), undefined, oauth2Env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(tokenUrl).toBe('https://api.x.com/2/oauth2/token');
    expect(String(tokenInit.body)).toContain('grant_type=refresh_token');
    expect(String(tokenInit.body)).toContain('refresh_token=refresh-token-SECRET');

    expect(updateXAccountMock).toHaveBeenCalledWith(oauth2Env.DB, 'acc1', { accessToken: 'new-access', refreshToken: 'new-refresh' });
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
  });

  it('does not retry again when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"title":"Unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 400 }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await xAccountTimelines.request(new Request('http://local/api/x-accounts/acc1/liked-tweets'), undefined, oauth2Env);
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updateXAccountMock).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain('SECRET');
    errSpy.mockRestore();
  });
});

describe('XClient backward compatibility', () => {
  it('getBookmarks/getLikedTweets without options keep the old default query', async () => {
    const client = new XClient('tok');
    await client.getBookmarks('42');
    await client.getLikedTweets('42', 'P');
    const u1 = new URL((fetchMock.mock.calls[0] as [string])[0]);
    const u2 = new URL((fetchMock.mock.calls[1] as [string])[0]);
    expect(u1.searchParams.get('tweet.fields')).toBe('author_id,created_at,public_metrics');
    expect(u1.searchParams.get('max_results')).toBe('100');
    expect(u1.searchParams.has('expansions')).toBe(false);
    expect(u2.pathname).toBe('/2/users/42/liked_tweets');
    expect(u2.searchParams.get('pagination_token')).toBe('P');
  });
});
