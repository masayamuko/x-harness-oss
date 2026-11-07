# X Harness OSS — SPEC

## Overview
Open-source X (Twitter) account CRM/marketing automation tool.
Xステップの完全オープンソース代替。Cloudflare 無料枠で動く。サーバー代 0 円。
LINE Harness OSS と同じアーキテクチャ。将来 "The Harness" として統合。

## Tech Stack
- **API/Webhook**: Cloudflare Workers (Hono framework)
- **Database**: Cloudflare D1 (SQLite)
- **Cron**: Workers Cron Triggers (5分毎)
- **Frontend**: Next.js 15 (App Router) — 管理画面
- **SDK**: TypeScript (@x-harness/sdk)
- **MCP**: Claude Code / OpenClaw ネイティブ統合

## Architecture
```
X Platform (API v2) ←→ CF Workers (Hono) → D1
                              ↑
                        Cron (*/5 * * * *)
                              ↓
                        X API v2 (OAuth 2.0)

Next.js 15 (管理画面) → Workers API → D1
TypeScript SDK → Workers API → D1
Claude Code / 🦞 → Workers API / MCP → D1
```

## Monorepo Structure
```
x-harness-oss/
├── apps/
│   ├── worker/           # Cloudflare Workers API
│   │   ├── src/
│   │   │   ├── index.ts          # Hono app + Cron handler
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts       # Bearer token auth
│   │   │   ├── routes/
│   │   │   │   ├── followers.ts      # フォロワー管理
│   │   │   │   ├── posts.ts         # ポスト管理・予約投稿
│   │   │   │   ├── engagement-gates.ts # シークレットリプライ ★MVP
│   │   │   │   ├── auto-replies.ts   # オートリプライ
│   │   │   │   ├── tags.ts          # タグ管理
│   │   │   │   ├── scenarios.ts     # DMステップ配信
│   │   │   │   ├── users.ts        # UUID管理（The Harness統合用）
│   │   │   │   ├── x-accounts.ts   # Xアカウント管理
│   │   │   │   ├── analytics.ts    # 分析
│   │   │   │   ├── automations.ts  # IF-THENルール
│   │   │   │   ├── templates.ts    # テンプレート
│   │   │   │   └── health.ts       # ヘルスチェック
│   │   │   └── services/
│   │   │       ├── engagement-gate.ts  # いいね検知→リプ送信
│   │   │       ├── auto-reply.ts       # メンション監視→自動返信
│   │   │       ├── post-scheduler.ts   # 予約投稿処理
│   │   │       ├── scenario-delivery.ts # DMステップ配信
│   │   │       ├── follower-sync.ts    # フォロワー同期
│   │   │       ├── stealth.ts          # ジッター・レート制御
│   │   │       └── event-bus.ts        # イベントバス
│   │   └── wrangler.toml
│   └── web/              # Next.js 15 管理画面
├── packages/
│   ├── db/               # D1 スキーマ & クエリ
│   ├── x-sdk/            # X API v2 型付きラッパー
│   ├── sdk/              # @x-harness/sdk クライアントSDK
│   ├── mcp-server/       # MCP Server
│   └── shared/           # 共有型定義
└── docs/
```

## X API v2 認証
- **OAuth 2.0 with PKCE** (ユーザーコンテキスト)
  - ポスト投稿、DM送信、フォロー操作
- **OAuth 2.0 App-Only** (アプリコンテキスト)
  - ユーザー検索、ポスト検索
- **Secrets**: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_ACCESS_TOKEN`, `X_REFRESH_TOKEN`

## Core Features

### 1. Engagement Gate（シークレットリプライ）★ MVP最優先
Xステップの「シークレットリプライ」相当。キラー機能。

**仕組み（v2 — リプライトリガー）:**
1. 監視対象ポストを登録（trigger_type: reply + require_like/repost/follow）
2. Cron でリプライを `since_id` 差分取得（低コスト）
3. リプライしたユーザーに対して追加条件（いいね/RT/フォロー）をキャッシュから照合
4. 全条件クリアしたユーザーに @メンション or DM 自動送信
5. LINE Harness の verify API で外部からも条件判定可能

**仕組み（v1 — レガシー、後方互換）:**
1. 監視対象ポストを登録（trigger_type: like/repost）
2. Cron で liking_users / retweeted_by を全件取得
3. 未配信ユーザーに自動送信

**テーブル: `engagement_gates`**
```sql
CREATE TABLE engagement_gates (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  post_id TEXT NOT NULL,           -- 監視対象ポストID
  trigger_type TEXT NOT NULL,      -- 'like' | 'repost' | 'reply' | 'follow'
  action_type TEXT NOT NULL,       -- 'mention_post' | 'dm'
  template TEXT NOT NULL,          -- "@{username} 特典はこちら→ {link}"
  link TEXT,                       -- テンプレート内 {link} の値
  is_active INTEGER DEFAULT 1,
  -- LINE Harness 連携
  line_harness_url TEXT,           -- LINE Harness API URL
  line_harness_api_key TEXT,       -- LINE Harness API Key
  line_harness_tag TEXT,           -- 付与するタグ名
  line_harness_scenario_id TEXT,   -- 開始するシナリオID
  -- リプライトリガー条件
  require_like INTEGER DEFAULT 0,
  require_repost INTEGER DEFAULT 0,
  require_follow INTEGER DEFAULT 0,
  last_reply_since_id TEXT,
  -- メタ
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**テーブル: `engagement_gate_deliveries`**
```sql
CREATE TABLE engagement_gate_deliveries (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  x_user_id TEXT NOT NULL,         -- いいねしたユーザー
  x_username TEXT,
  delivered_post_id TEXT,          -- 送信したポストのID
  status TEXT DEFAULT 'delivered', -- 'delivered' | 'failed' | 'pending'
  created_at TEXT NOT NULL,
  UNIQUE(gate_id, x_user_id)      -- 重複防止
);
```

**ステルス設計:**
- 1件送信ごとにランダム遅延（30秒〜3分）
- 1時間あたり最大30件（自主制限）
- テンプレートに微小バリエーション（ゼロ幅文字 or 句読点揺らぎ）

### 2. オートリプライ
メンション/リプライのキーワードマッチで自動返信。

**テーブル: `auto_replies`**
```sql
CREATE TABLE auto_replies (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  keyword TEXT NOT NULL,           -- マッチキーワード
  match_type TEXT DEFAULT 'contains', -- 'exact' | 'contains' | 'regex'
  reply_template TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 3. フォロワー管理
X APIでフォロワー情報を同期・タグ管理。

**テーブル: `followers`**
```sql
CREATE TABLE followers (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  x_user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  profile_image_url TEXT,
  follower_count INTEGER,
  following_count INTEGER,
  is_following INTEGER DEFAULT 1,  -- こちらをフォロー中
  is_followed INTEGER DEFAULT 0,   -- こちらがフォロー中
  user_id TEXT,                    -- UUID (The Harness統合用)
  metadata TEXT DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  unfollowed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(x_account_id, x_user_id)
);
```

### 4. タグ
LINE Harness と同じタグシステム。

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(x_account_id, name)
);

CREATE TABLE follower_tags (
  follower_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, tag_id)
);
```

### 5. 予約投稿

```sql
CREATE TABLE scheduled_posts (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  text TEXT NOT NULL,
  media_ids TEXT,                  -- JSON array
  scheduled_at TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled', -- 'scheduled' | 'posted' | 'failed'
  posted_tweet_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 6. UUID統合（The Harness準備）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,             -- UUID
  email TEXT,
  phone TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- followers.user_id → users.id でリンク
-- LINE Harness の users テーブルと同じ UUID 体系
```

### 7. IF-THENオートメーション

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  x_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,        -- 'new_follower' | 'engagement_gate_delivered' | 'keyword_reply'
  conditions TEXT DEFAULT '{}',    -- JSON: タグ条件等
  actions TEXT NOT NULL,           -- JSON array: [{type: 'add_tag', params: {...}}]
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 8. DMステップ配信（将来）
DM APIの従量課金が現実的になったら実装。

## Cron 処理フロー (*/5 * * * *)

```
scheduled() — 並列実行:

  1. processEngagementGates()
     ├─ アクティブな gate を取得
     ├─ 各 gate の post_id に対して liking_users / retweeted_by 取得
     ├─ 未配信ユーザーをフィルタ
     ├─ ステルス: addJitter(30000, 180000)ms
     ├─ @メンション付きポスト投稿
     ├─ deliveries テーブルに記録
     └─ LINE Harness API 連携（タグ付与 / シナリオ開始）

  2. processAutoReplies()
     ├─ 最新メンション取得 (GET /2/users/:id/mentions)
     ├─ キーワードマッチ
     └─ 自動返信投稿

  3. processScheduledPosts()
     ├─ scheduled_at <= now のポストを取得
     └─ 投稿実行

  4. syncFollowers()
     ├─ フォロワー差分同期（15分ごと）
     └─ 新規フォロワー → イベント発火
```

## API エンドポイント

```
# Engagement Gates（シークレットリプライ）
POST   /api/engagement-gates          # ゲート作成
GET    /api/engagement-gates          # 一覧
GET    /api/engagement-gates/:id      # 詳細
PUT    /api/engagement-gates/:id      # 更新
DELETE /api/engagement-gates/:id      # 削除
GET    /api/engagement-gates/:id/deliveries  # 配信履歴
GET    /api/engagement-gates/:id/verify?username=xxx  # LINE Harness 条件判定

# フォロワー
GET    /api/followers                 # 一覧
GET    /api/followers/:id             # 詳細
POST   /api/followers/:id/tags        # タグ付与
DELETE /api/followers/:id/tags/:tagId # タグ削除

# タグ
POST   /api/tags                      # 作成
GET    /api/tags                      # 一覧
PUT    /api/tags/:id                  # 更新
DELETE /api/tags/:id                  # 削除

# ポスト
POST   /api/posts                     # 即時投稿
POST   /api/posts/schedule            # 予約投稿
GET    /api/posts/scheduled           # 予約一覧
DELETE /api/posts/scheduled/:id       # 予約取消

# オートリプライ
POST   /api/auto-replies              # 作成
GET    /api/auto-replies              # 一覧
PUT    /api/auto-replies/:id          # 更新
DELETE /api/auto-replies/:id          # 削除

# オートメーション
POST   /api/automations               # 作成
GET    /api/automations               # 一覧
PUT    /api/automations/:id           # 更新
DELETE /api/automations/:id           # 削除

# UUID
POST   /api/users                     # UUID作成
GET    /api/users/:id                 # UUID詳細
POST   /api/users/:id/link            # チャネルリンク

# Xアカウント
POST   /api/x-accounts                # アカウント追加
GET    /api/x-accounts                # 一覧
PUT    /api/x-accounts/:id            # 更新
GET    /api/x-accounts/:id/bookmarks    # ログイン中アカウントのブックマーク（読み取り専用・?max_results=1-100&pagination_token=。OAuth 2.0 ユーザートークン＋bookmark.read が必要。OAuth 1.0a 設定のアカウントは 400）
GET    /api/x-accounts/:id/liked-tweets # ログイン中アカウントのいいね（読み取り専用・?max_results=5-100&pagination_token=。like.read が必要）

# 分析
GET    /api/analytics/followers       # フォロワー推移
GET    /api/analytics/engagement-gates # ゲート成績
GET    /api/analytics/posts           # ポスト分析
```

## ステルス設計

LINE Harness と同じ思想:
1. **ジッター配信**: @メンション送信に30秒〜3分のランダム遅延
2. **レート自主制限**: 1時間30件、1日300件
3. **テンプレート揺らぎ**: ゼロ幅文字/句読点バリエーション
4. **エラーハンドリング**: 429 は即停止、指数バックオフ
5. **1デプロイ=1アカウント**: マルチアカウント時は独立Worker

## MVP スコープ（Phase 1）

最小限で動くものを最速で:

1. ✅ Engagement Gate（シークレットリプライ）
2. ✅ フォロワー管理 + タグ
3. ✅ 予約投稿
4. ✅ REST API（全機能）
5. ✅ TypeScript SDK

**Phase 2:**
- オートリプライ
- IF-THENオートメーション
- 管理画面（Next.js）
- MCP Server

**Phase 3:**
- DMステップ配信
- LINE Harness 連携API
- アフィリエイト/CV計測
- The Harness 統合準備

## コスト

| 規模 | 月額コスト |
|------|-----------|
| リプライトリガー（通常） | **$3-5** |
| リプライトリガー（バズ時） | $20-45 |
| レガシーモード（like/repost全件走査） | $86+ |
| インフラ（CF無料枠） | **$0** |

## ライセンス
MIT
