# セットアップガイド

このドキュメントでは，プロジェクトを構築する手順と，既存環境のバックアップ手順を説明する．

---

## 前提条件

以下のアカウントが必要（全て無料プランで動作する）．

- Supabase（データベース）
- Google アカウント（GAS 実行用）
- Cloudflare（Workers デプロイ用）
- Discord（通知先．Bot 系を使う場合は Developer Portal も必要）
- Groq（LLM 要約・評価用，カード登録不要）
- CiNii Research（アプリケーション ID 取得用）
- OpenAlex（API Key 取得用）


## 構成の概要

このシステムは以下の3つの部分で構成される．

1. **共通基盤**（Supabase + GAS）— 論文の収集・蓄積・検索・要約
2. **通知系（Push 型）** — 週次で Discord チャンネルに論文を配信．LLM 関連度評価を含む
3. **Bot 系（Pull 型，任意）** — Discord のスラッシュコマンドで検索・一覧を取得

通知系だけで運用する場合，Bot 系のセクションはスキップできる．

---

## Part 1: 共通基盤

### 1. Supabase のセットアップ

#### 1-1. プロジェクト作成

Supabase Dashboard で新規プロジェクトを作成する．リージョンは任意（東京推奨）．

#### 1-2. 関数の作成

SQL Editor で，以下のファイルをこの順序で実行する．

1. `supabase/functions/update_updated_at.sql`
2. `supabase/functions/bulk_upsert_works.sql`
3. `supabase/functions/get_unevaluated_pairs.sql`

関数定義をテーブル定義より先に実行する（`schema.sql` 内のトリガーが `update_updated_at` を参照するため）．

#### 1-3. テーブルの作成

SQL Editor で `supabase/schema.sql` を実行する．

#### 1-4. 初期データの投入（任意）

`supabase/seed.sql` がある場合はこれも実行する（トピックの初期セットなど）．

#### 1-5. API キーの取得

Settings → API から以下を控える．

- **Project URL** → 環境変数 `SUPABASE_URL` として使用
- **Secret key**（service_role） → 環境変数 `SUPABASE_KEY` として使用

Publishable key（anon）ではなく Secret key を使う．理由は `docs/design-decisions.md` に記載．

#### 1-6. RLS の確認

Secret key を使用する前提で RLS を有効にしている．テーブル作成後，Dashboard の Authentication → Policies で各テーブルの RLS が有効であることを確認する．


### 2. GAS のセットアップ

#### 2-1. プロジェクト作成とコード配置

Google Drive から「Google Apps Script」で新規プロジェクトを作成し，以下の3ファイルをそれぞれ別のスクリプトファイルとして作成する．

- `dailyCollect.gs`
- `coreLogic.gs`
- `weeklyNotify.gs`

リポジトリの `gas/` ディレクトリ内のファイルの内容をコピー＆ペーストで反映する．

#### 2-2. スクリプトプロパティの設定

GAS エディタの「プロジェクトの設定」→「スクリプト プロパティ」で以下を設定する．

通知系のみで運用する場合，`DISCORD_APPLICATION_ID` は不要．

| プロパティ名 | 取得元 | 備考 |
|---|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Settings → API | |
| `SUPABASE_KEY` | Supabase Dashboard → Settings → API | Secret key（service_role） |
| `GROQ_API_KEY` | Groq Console | 未設定の場合，要約はスキップされアブストラクト先頭を返す |
| `GROQ_MODEL` | — | 任意．デフォルト `llama-3.3-70b-versatile` |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → Application → General Information | Bot 系でのみ使用 |
| `OPENALEX_APIKEY` | OpenAlex | |
| `CINII_APPID` | CiNii Research アプリケーション登録 | |
| `SEMANTIC_SCHOLAR_KEY` | Semantic Scholar | 任意．現在未使用 |
| `DISCORD_WEBHOOK_URL` | Discord チャンネル設定 → 連携サービス → ウェブフック | デフォルト通知先 |
| `LLM_SCORE_THRESHOLD` | — | 任意．デフォルト 5 |

#### 2-3. デプロイ

メニュー「デプロイ」→「新しいデプロイ」でウェブアプリとしてデプロイする．アクセスできるユーザーは「全員」にする．

デプロイ後に表示される URL（`/exec` で終わるもの）を控えておく．これが `GAS_ENDPOINT_URL` になる（Bot 系で使用）．

2回目以降のコード更新時は「新しいデプロイ」ではなく「デプロイを管理」→ 既存デプロイの編集で新バージョンを指定する．これにより URL が変わらない．

#### 2-4. テスト

`coreLogic.gs` 内のテストハーネス（`test_searchWorks`, `test_listTopics` 等）を GAS エディタから直接実行し，Supabase との接続を確認する．Discord は不要．


---

## Part 2: 通知系（Push 型）

### 3. 通知系のセットアップ

#### 3-1. Discord Webhook の作成

通知先の Discord チャンネルで，チャンネル設定 → 連携サービス → ウェブフック から受信 Webhook を作成する．URL を控え，GAS スクリプトプロパティの `DISCORD_WEBHOOK_URL` に設定する．

チャンネル別・トピック別の通知が必要な場合は，追加の Webhook を作成し，Supabase の `subscriptions` / `llm_subscriptions` テーブルに設定する（§3-5）．

#### 3-2. LLM 評価 Worker のデプロイ

1. Cloudflare Dashboard で新しい Worker を作成する（インラインエディタ使用，CLI 不要）
2. `cloudflare-workers/llm-eval/worker.js` の内容を貼り付ける
3. Settings → Variables で環境変数を設定する

| 変数名 | 取得元 | 備考 |
|---|---|---|
| `SUPABASE_URL` | Supabase Dashboard | |
| `SUPABASE_KEY` | Supabase Dashboard | Secret key |
| `GROQ_API_KEY` | Groq Console | |
| `GROQ_MODEL` | — | 任意 |
| `LLM_EVAL_LOOKBACK_DAYS` | — | 任意 |
| `LLM_EVAL_MAX_PAPERS` | — | 任意 |
| `LLM_EVAL_SLEEP_MS` | — | 任意 |

4. Triggers → Cron で定期実行を設定する（`dailyCollect` の1時間後を推奨）

注意: Cron 専用 Worker でも（空でいい） `fetch` ハンドラが必要（ないとデプロイエラーになる）．

#### 3-3. GAS トリガーの設定

GAS エディタの「トリガー」画面から以下を設定する．

| 関数 | 実行頻度 |
|---|---|
| `dailyCollect` | 日次（時間は任意） |
| `weeklyNotify` | 週次（例: 毎週月曜） |

#### 3-4. 動作確認

GAS エディタから `weeklyNotify` を手動実行し，Discord チャンネルに通知が届くことを確認する．

#### 3-5. subscriptions データの設定（任意）

チャンネル別・トピック別に通知を分けたい場合，Supabase Dashboard の Table Editor から以下のテーブルにデータを挿入する．

- `subscriptions` — キーワード部分一致ベースの通知
- `llm_subscriptions` — LLM スコアベースの通知（`min_score` でチャンネルごとの閾値を設定可能）


---

## Part 3: Bot 系（Pull 型，任意）

通知系だけで運用する場合，このセクションは不要．

### 4. Bot 系のセットアップ

#### 4-1. Discord Application と Bot の作成

1. Discord Developer Portal で Application を作成する
2. Bot を有効化する
3. General Information から `APPLICATION_ID` と `PUBLIC_KEY` を控える

#### 4-2. Discord Bot Worker のデプロイ

1. Cloudflare Dashboard で新しい Worker を作成する（インラインエディタ使用，CLI 不要）
2. `cloudflare-workers/discord-bot/worker.js` の内容を貼り付ける
3. Settings → Variables で環境変数を設定する

| 変数名 | 取得元 |
|---|---|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → Application → General Information |
| `GAS_ENDPOINT_URL` | §2-3 で取得したデプロイ URL |

4. `compatibility_date` を `2024-01-01` 以降に設定し，`nodejs_compat` を有効にする（Ed25519 署名検証に必要）

#### 4-3. Interactions Endpoint URL の設定

Discord Developer Portal → General Information → Interactions Endpoint URL に，§4-2 で作成した Worker の URL を入力して保存する．

保存時に Discord が PING リクエストを送り，Worker の Ed25519 検証が通れば成功する．「Webhooks Endpoint URL」ではないので注意．

#### 4-4. Bot の招待

OAuth2 → URL Generator で以下のスコープを選択し，生成された URL でサーバーに招待する．

- `bot`
- `applications.commands`

#### 4-5. スラッシュコマンドの登録

`scripts/register-commands.sh` を実行する．`curl` が使える環境が必要．

```sh
# 実行前にスクリプト内の APPLICATION_ID と BOT_TOKEN を設定する
bash scripts/register-commands.sh
```

詳細は `scripts/register-commands.sh` 内のコメントを参照．

#### 4-6. GAS スクリプトプロパティの追加

§2-2 で未設定の場合，以下を追加する．

| プロパティ名 | 取得元 |
|---|---|
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → Application → General Information |


