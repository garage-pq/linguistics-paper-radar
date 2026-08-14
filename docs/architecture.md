# アーキテクチャ

**要注意（信頼性）**: 
LLMの出力の一部分を確認・修正しましたが，全部見てはいません．
大まかな構成の参考として載せておきます．


## システム全体像

```mermaid
graph LR
    subgraph データソース
        OA[OpenAlex<br>分野指定 + KW横断]
        JS[J-STAGE]
        CN[CiNii Research]
        LB[LingBuzz]
        SS[Semantic Scholar<br>現在無効]
    end

    subgraph GAS
        DC[dailyCollect<br>日次]
        WN[weeklyNotify<br>週次]
        CL[coreLogic<br>検索・要約・フォーマット]
        DP[doPost<br>Bot受信]
    end

    subgraph Supabase
        DB[(works<br>topics<br>works_topics<br>llm_topic_relevance<br>subscriptions<br>llm_subscriptions)]
        RPC[RPC関数]
    end

    subgraph Cloudflare Workers
        BW[discord-bot<br>Worker]
        LW[llm-eval<br>Worker]
    end

    subgraph Discord
        WH[Webhook<br>Push通知]
        BOT[Bot<br>スラッシュコマンド]
    end

    GROQ[Groq API]

    OA --> DC
    JS --> DC
    CN --> DC
    LB --> DC
    SS -.-> DC

    DC --> RPC --> DB
    LW --> DB
    LW --> GROQ

    DB --> WN --> WH
    DB --> CL
    CL --> DP

    BOT --> BW --> DP
    DP --> BOT
    WN --> CL
    CL --> GROQ
```


## 処理フロー

### 1. 日次収集（dailyCollect）

`dailyCollect` はファイル名（`dailyCollect.gs`）かつエントリポイントの関数名．各データソースの取得は専用関数に分離されている．

```mermaid
sequenceDiagram
    participant Trigger as GAS Trigger<br>(日次)
    participant DC as dailyCollect.gs
    participant Sources as データソース
    participant SB as Supabase

    Trigger->>DC: 起動
    DC->>Sources: OpenAlex (field指定, type:article)
    Sources-->>DC: 論文データ
    DC->>Sources: OpenAlex (KW横断, type:article)
    Sources-->>DC: 論文データ
    DC->>Sources: J-STAGE
    Sources-->>DC: 論文データ
    DC->>Sources: CiNii
    Sources-->>DC: 論文データ
    DC->>Sources: LingBuzz
    Sources-->>DC: 論文データ
    DC->>SB: bulk_upsert_works (RPC)
    alt RPC失敗
        DC->>SB: fallbackUpsert (1件ずつREST)
    end
```

各ソースから取得した論文は `paper_key`（DOI or md5）で重複排除される．同一論文が複数ソースから来た場合，`collection_sources` 配列に追加される．

収集時にキーワードマッチングで `works_topics` への紐づけも行う．


#### 妥協点

- **J-STAGEのでの妥協**
  - `abst` の欠損 - J-STAGEのデータ取得で使ったAPIでは，「抄録」が[マニュアル](https://www.jstage.jst.go.jp/static/files/ja/manual_api.pdf)上のレスポンスフォーマットには見当たらなかった．個別の書誌情報では獲得できるが，今回は，工数等を考え，空欄を許容した．
  - `publication_date` での妥協 - J-STAGEのデータ取得で使ったAPIでは，`pubyear` で出版年は取得できるものの，月・日はマニュアル上のレスポンスフォーマットに見当たらなかった．個別の書誌情報では獲得できるが，今回は，工数等を考え，代用として `updated` を用いることとした．実際の出版日と異なることに注意．
  



### 2. LLM 関連度評価（llm-eval Worker）

```mermaid
sequenceDiagram
    participant Cron as Cron Trigger
    participant W as llm-eval Worker
    participant SB as Supabase
    participant G as Groq API

    Cron->>W: 起動
    W->>SB: get_unevaluated_pairs(lookback_days, max_papers)
    SB-->>W: 未評価の (work_id, topic_id) リスト
    loop 1論文 × 1トピック
        W->>G: アブストラクト + トピック説明 → スコア要求
        G-->>W: score (0-10), reason
        W->>SB: llm_topic_relevance に INSERT
        Note over W: sleep (Rate Limit対策)
    end
```

1論文×1トピック=1呼び出しとしている理由は `docs/design-decisions.md` §3 に記載．


### 3. 週次通知（weeklyNotify）

```mermaid
sequenceDiagram
    participant Trigger as GAS Trigger<br>(週次)
    participant WN as weeklyNotify.gs
    participant CL as coreLogic.gs
    participant SB as Supabase
    participant G as Groq API
    participant DH as Discord Webhook

    Trigger->>WN: weeklyNotify()

    Note over WN: 1. デフォルト Webhook 通知
    WN->>CL: listTopics(), getWeeklyHits()
    CL->>SB: クエリ
    SB-->>CL: トピック別論文
    CL-->>WN: 結果
    WN->>DH: postToWebhook — トピック別セクション

    Note over WN: 1.5. LLM 推薦セクション
    WN->>WN: getWeeklyLlmHits()
    WN->>SB: llm_topic_relevance 取得
    SB-->>WN: スコア閾値以上の論文
    Note over WN: formatLlmSection() 内で:
    WN->>CL: summarizeArticle(useLlm=true)
    CL->>G: callGroqSummary
    G-->>CL: 要約
    CL-->>WN: 要約テキスト
    WN->>DH: postToWebhook — LLM 推薦セクション

    Note over WN: 2. subscriptions 別通知
    WN->>SB: subscriptions テーブル取得
    SB-->>WN: チャンネル×トピック一覧
    loop チャンネル × トピック
        Note over WN: sendTopicDigest() 内で:
        WN->>CL: summarizeArticle(opts)
        alt useLlm=true かつ GROQ_API_KEY あり
            CL->>G: callGroqSummary
            G-->>CL: 要約
        else useLlm=false or APIキー未設定
            Note over CL: アブストラクト先頭を<br>maxChars分切り出し
        end
        CL-->>WN: 要約テキスト
        WN->>DH: postToWebhook
        Note over WN: sleep(5000) — 429対策
    end

    Note over WN: 3. llm_subscriptions 別通知
    WN->>SB: llm_subscriptions テーブル取得
    SB-->>WN: チャンネル×トピック一覧
    loop チャンネル × トピック (スコア >= min_score)
        Note over WN: sendTopicDigest() 内で:
        WN->>CL: summarizeArticle(useLlm=true)
        CL->>G: callGroqSummary
        G-->>CL: 要約
        CL-->>WN: 要約テキスト
        WN->>DH: postToWebhook
        Note over WN: sleep(5000) — 429対策
    end
```

通知は3段階で行われる．デフォルト Webhook（全トピック + LLM 推薦），`subscriptions`（キーワード部分一致ベース，チャンネル別），`llm_subscriptions`（LLM スコアベース，チャンネル別）．


### 4. Bot 系（Pull 型，任意）

```mermaid
sequenceDiagram
    participant U as ユーザー
    participant D as Discord
    participant W as discord-bot Worker
    participant GAS as coreLogic.gs<br>(doPost)
    participant SB as Supabase

    U->>D: /paperbot search theme:X
    D->>W: Interaction (Ed25519署名付き)
    W->>W: 署名検証
    W->>D: ACK (Deferred Response)
    W->>GAS: POST {command, param, token}
    GAS->>SB: searchWorks / getWeeklyHits / ...
    SB-->>GAS: 結果
    GAS->>D: PATCH (書き戻し)
    D-->>U: 結果表示
```

Worker は署名検証と GAS への転送のみを担い，ロジックは GAS 側に集約されている．`token` が `"dummy"` の場合は Discord への書き戻しをスキップする（テスト用）．
`topic add` はDMだと動いても通常のチャンネルへのbot導入だと動かないかもしれない（権限周りによるかも？）．


## データモデル

```mermaid
erDiagram
    works ||--o{ works_topics : ""
    topics ||--o{ works_topics : ""
    works ||--o{ llm_topic_relevance : ""
    topics ||--o{ llm_topic_relevance : ""
    topics ||--o{ subscriptions : "keyword"
    topics ||--o{ llm_subscriptions : "keyword"

    works {
        bigserial id PK
        text paper_key UK
        text doi
        text title
        text abstract
        text authors
        text journal_name
        date publication_date
        text source_url
        text language
        text_array collection_sources
        tsvector fts_en
        timestamptz created_at
        timestamptz updated_at
    }

    topics {
        serial id PK
        text keyword UK
        text scope
        boolean notify
        boolean llm_notify
        text llm_description
    }

    works_topics {
        bigint work_id PK, FK "FK→works"
        integer topic_id PK, FK "FK→topics"
    }

    llm_topic_relevance {
        bigint work_id PK, FK "FK→works"
        bigint topic_id PK, FK "FK→topics"
        smallint score
        text reason
        text model
        timestamptz evaluated_at
    }

    subscriptions {
        text webhook_url PK
        text topic_keyword PK, FK "FK→topics.keyword"
        text description
    }

    llm_subscriptions {
        text webhook_url PK
        text topic_keyword PK, FK "FK→topics.keyword"
        smallint min_score
        text description
    }
```

`subscriptions` と `llm_subscriptions` は `topics.keyword` を FK としており，`topics.id` ではない点に注意．これにより keyword の変更時に CASCADE で追従する．


## コンポーネント間のデータ形式

| 経路 | 形式 |
|---|---|
| Workers → GAS | `{ command, param, mode, token, userId }` |
| GAS → Discord（Bot 書き戻し） | `PATCH /api/v10/webhooks/{app_id}/{token}/messages/@original` |
| GAS → Discord（Push 通知） | `POST` to Webhook URL |
| GAS → Supabase | PostgREST（REST API） / RPC |
| llm-eval Worker → Supabase | PostgREST（REST API） / RPC |
| llm-eval Worker → Groq | OpenAI 互換 API |
| GAS → Groq | OpenAI 互換 API |


## GAS ファイル構成と関数の所在

| ファイル | 主要関数 | 役割 |
|---|---|---|
| `dailyCollect.gs` | `dailyCollect`, `fetchOpenAlexPages`, `collectJstage`, `collectCinii`, `collectLingbuzz`, `fetchFromSupabase`, `postToSupabase`, `patchToSupabase`, `test_*`  | 収集 + DB操作インフラ + テスト |
| `coreLogic.gs` | `doPost`, `searchWorks`, `getWeeklyHits`, `fetchWeeklyByTopicId`, `listTopics`, `addTopic`, `removeTopic`, `backfillTopic`, `summarizeArticle`, `callGroqSummary`, `test_*` | コアロジック + テスト |
| `weeklyNotify.gs` | `weeklyNotify`, `sendTopicDigest`, `postToWebhook`, `getWeeklyLlmHits`, `formatLlmSection`, `test_*`  | 通知 + テスト |

`fetchFromSupabase`, `postToSupabase`, `patchToSupabase` は DB 操作の共通インフラ関数であり，`dailyCollect.gs` に定義されているが `coreLogic.gs` および `weeklyNotify.gs` からも呼び出される．将来的にはインフラ層として別ファイル（例: `infra.gs`）に分離することも検討できる．
