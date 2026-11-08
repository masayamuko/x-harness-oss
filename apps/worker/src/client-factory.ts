import { XClient } from '@x-harness/x-sdk';
import { updateXAccount } from '@x-harness/db';
import type { DbXAccount } from '@x-harness/db';
import type { Env } from './index.js';

export function buildXClientForAccount(account: DbXAccount, env: Env['Bindings']): XClient {
  // OAuth 1.0a: use consumer key/secret + access token/secret
  if (account.consumer_key && account.consumer_secret && account.access_token_secret) {
    return new XClient({
      type: 'oauth1',
      consumerKey: account.consumer_key,
      consumerSecret: account.consumer_secret,
      accessToken: account.access_token,
      accessTokenSecret: account.access_token_secret,
    });
  }
  // OAuth 2.0: use access token + refresh token with auto-refresh
  if (account.refresh_token && env.OAUTH2_CLIENT_ID && env.OAUTH2_CLIENT_SECRET) {
    return new XClient({
      type: 'oauth2',
      accessToken: account.access_token,
      refreshToken: account.refresh_token,
      clientId: env.OAUTH2_CLIENT_ID,
      clientSecret: env.OAUTH2_CLIENT_SECRET,
      onTokenRefresh: async (newAccessToken, newRefreshToken) => {
        await updateXAccount(env.DB, account.id, {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        });
      },
    });
  }
  // Fallback: plain bearer token
  return new XClient(account.access_token);
}
