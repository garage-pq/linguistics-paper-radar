
# バックアップガイド

## 付録A: CLI なしでのスキーマ検証・取得

Supabase CLI を使わずに，Dashboard の SQL Editor だけでスキーマの定義を取得・検証する手順を示す．

### 概要

Schema Visualizer の出力（Dashboard → Database → Schema Visualizer → Markdown output）をベースとし，Visualizer が正しく出力しない箇所を個別クエリで補完する方針が効率的であるかもしれない．

Visualizer の出力で確認された既知の問題点は以下の通り（2026年7月時点）．

- `GENERATED ALWAYS AS ... STORED` カラムが通常の `DEFAULT` として出力される
- 外部キーの `ON DELETE CASCADE` が省略される
- `text[]` 型が `ARRAY` と表記される
- `nextval(...)` がそのまま出力される（`serial` / `bigserial` への読み替えが必要）


### Step 1: Visualizer 出力の取得

Dashboard → Database → Schema Visualizer から Markdown output をコピーする．これがベースになる．


### Step 2: 外部キーの CASCADE 有無を確認

```sql
SELECT conrelid::regclass AS table_name,
       conname,
       pg_get_constraintdef(oid, true)
FROM pg_constraint
WHERE contype = 'f'
  AND connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, conname;
```

`pg_get_constraintdef` の出力に `ON DELETE CASCADE` が含まれていれば，Visualizer 出力の該当 FK に追記する．


### Step 3: GENERATED カラムの確認

```sql
SELECT table_name, column_name, is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
  AND is_generated = 'ALWAYS';
```

結果があれば，Visualizer 出力の該当カラムを `DEFAULT ...` から `GENERATED ALWAYS AS (...) STORED` に書き換える．


### Step 4: 全カラム定義の照合

Visualizer 出力と実際の定義を照合する場合に使う．

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;
```

特に注意すべき点は以下の通り．

- `data_type` が `ARRAY` と表示される場合，`udt_name` を確認する（例: `_text` なら `text[]`）
- `column_default` が `null` のカラムが Visualizer では `DEFAULT ...` を持っている場合，GENERATED カラムの可能性がある（Step 3 で確認）
- 型の不一致（例: FK の参照元が `bigint` で参照先が `integer`）を検出できる


### Step 5: 外部キーの関係確認（任意）

テーブル間の参照関係を一覧する場合に使う．CASCADE の有無は含まれないため，それは Step 2 で確認する．

```sql
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name  AS foreign_table,
  ccu.column_name AS foreign_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public';
```


### Step 6: トリガーの確認（任意）

```sql
SELECT tgname, pg_get_triggerdef(oid, true)
FROM pg_trigger
WHERE tgrelid IN (
  SELECT c.oid FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
) AND NOT tgisinternal;
```


### 注意: 一括 DDL 生成クエリについて

LLMによると: 

> `pg_attribute` と `pg_constraint` を同時に JOIN して `CREATE TABLE` 文を一括生成するクエリは，カラム数 × 制約数の直積が生じるため，制約の重複や欠落が発生する構造的な問題がある．Visualizer 出力 + 個別検証クエリの方が信頼性が高い．


---

## 付録B: Supabase CLI によるスキーマのバックアップ

日常の編集はブラウザ（GAS エディタ，Supabase Dashboard，Cloudflare Dashboard）で行うとしても，スキーマのバックアップ時には CLI を使う運用が推奨されると思われる．

### CLI のインストール

```sh
npm install -g supabase
```

### ログインとプロジェクトのリンク

```sh
supabase login
supabase link --project-ref <project-ref>
```

`<project-ref>` は Supabase Dashboard の Settings → General → Reference ID で確認できる．

### スキーマの dump

```sh
supabase db dump --file supabase/schema_dump.sql
```

このコマンドで，テーブル定義・制約（CASCADE 含む）・GENERATED カラム・トリガー・関数が全て正確に出力される．出力を `supabase/schema.sql` と比較し，差異があれば `schema.sql` を更新して Git に反映する．

### dump に含まれないもの

- `subscriptions` / `llm_subscriptions` のデータ（Webhook URL 等）
- `topics` テーブルの登録済みデータ
- RLS ポリシーの定義（別途 `supabase db dump --role-only` や Dashboard で確認）

これらは手動管理か，`seed.sql` への記録で対応する．
