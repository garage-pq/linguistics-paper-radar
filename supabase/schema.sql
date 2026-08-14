-- schema.sql
-- Supabase テーブル定義（visualizer 出力ベース + 修正適用）
--
-- 適用順序:
--   1. functions/update_updated_at.sql  (トリガー関数)
--   2. functions/bulk_upsert_works.sql  (RPC)
--   3. functions/get_unevaluated_pairs.sql (RPC)
--   4. このファイル
--   5. seed.sql (任意)

-- ============================================================
-- 独立テーブル（他から参照される側を先に定義）
-- ============================================================

CREATE TABLE public.topics (
  id serial NOT NULL,
  keyword text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'keyword',
  added_by text,
  notify boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  llm_notify boolean NOT NULL DEFAULT false,
  llm_description text NOT NULL DEFAULT '',
  CONSTRAINT topics_pkey PRIMARY KEY (id)
);

CREATE TABLE public.works (
  id bigserial NOT NULL,
  paper_key text NOT NULL UNIQUE,
  doi text,
  title text NOT NULL,
  abstract text,
  authors text,
  journal_name text,
  publication_date date,
  source_url text,
  language text DEFAULT 'en',
  collection_sources text[] NOT NULL DEFAULT '{}',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  fts_en tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(abstract, ''))
  ) STORED,
  CONSTRAINT works_pkey PRIMARY KEY (id)
);

-- ============================================================
-- ジャンクション・関連テーブル
-- ============================================================

CREATE TABLE public.works_topics (
  work_id bigint NOT NULL,
  topic_id integer NOT NULL,
  CONSTRAINT works_topics_pkey PRIMARY KEY (work_id, topic_id),
  CONSTRAINT works_topics_work_id_fkey
    FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE CASCADE,
  CONSTRAINT works_topics_topic_id_fkey
    FOREIGN KEY (topic_id) REFERENCES public.topics(id) ON DELETE CASCADE
);

CREATE TABLE public.subscriptions (
  webhook_url text NOT NULL,
  topic_keyword text NOT NULL,
  description text,
  CONSTRAINT subscriptions_pkey PRIMARY KEY (webhook_url, topic_keyword),
  CONSTRAINT subscriptions_topic_keyword_fkey
    FOREIGN KEY (topic_keyword) REFERENCES public.topics(keyword) ON DELETE CASCADE
);

-- NOTE: topic_id は bigint だが参照先 topics.id は integer.
--       DB 上で FK 制約は成立しており，既存の動作に問題はない．
CREATE TABLE public.llm_topic_relevance (
  work_id bigint NOT NULL,
  topic_id bigint NOT NULL,
  score smallint NOT NULL CHECK (score >= 0 AND score <= 10),
  reason text,
  model text,
  evaluated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT llm_topic_relevance_pkey PRIMARY KEY (work_id, topic_id),
  CONSTRAINT llm_topic_relevance_work_id_fkey
    FOREIGN KEY (work_id) REFERENCES public.works(id) ON DELETE CASCADE,
  CONSTRAINT llm_topic_relevance_topic_id_fkey
    FOREIGN KEY (topic_id) REFERENCES public.topics(id) ON DELETE CASCADE
);

CREATE TABLE public.llm_subscriptions (
  webhook_url text NOT NULL,
  topic_keyword text NOT NULL,
  min_score smallint NOT NULL DEFAULT 5 CHECK (min_score >= 0 AND min_score <= 10),
  description text,
  CONSTRAINT llm_subscriptions_pkey PRIMARY KEY (webhook_url, topic_keyword),
  CONSTRAINT llm_subscriptions_topic_keyword_fkey
    FOREIGN KEY (topic_keyword) REFERENCES public.topics(keyword) ON DELETE CASCADE
);

-- ============================================================
-- トリガー（update_updated_at 関数が定義済みであることを前提）
-- ============================================================

CREATE TRIGGER trg_works_updated_at
  BEFORE UPDATE ON public.works
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
