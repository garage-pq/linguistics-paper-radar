DECLARE
  v_new_ids BIGINT[] := '{}';
  v_record JSONB;
  v_id BIGINT;
  v_is_new BOOLEAN;
BEGIN
  FOR v_record IN SELECT * FROM jsonb_array_elements(p_works)
  LOOP
    INSERT INTO works (
      paper_key, doi, title, abstract, authors,
      journal_name, publication_date, source_url, language,
      collection_sources
    )
    VALUES (
      v_record->>'paper_key',
      v_record->>'doi',
      v_record->>'title',
      v_record->>'abstract',
      v_record->>'authors',
      v_record->>'journal_name',
      (v_record->>'publication_date')::DATE,
      v_record->>'source_url',
      COALESCE(v_record->>'language', 'en'),
      ARRAY[v_record->>'source']
    )
    ON CONFLICT (paper_key) DO UPDATE SET
      -- collection_sources: 既存配列にソースを追加（重複なし）
      --  NULL 対応
      collection_sources = CASE
        WHEN (v_record->>'source') IS NULL
          THEN COALESCE(works.collection_sources, '{}')
        WHEN (v_record->>'source') = ANY(COALESCE(works.collection_sources, '{}'))
          THEN COALESCE(works.collection_sources, '{}')
        ELSE array_append(COALESCE(works.collection_sources, '{}'), v_record->>'source')
      END,
      -- abstract: 既存が NULL なら新しい値で上書き（後から取得できた場合に対応）
      abstract = COALESCE(works.abstract, EXCLUDED.abstract),
      -- doi: 既存が NULL なら新しい値で上書き（DOI 後付けに対応）
      doi = COALESCE(works.doi, EXCLUDED.doi),
      -- source_url: 既存が NULL なら新しい値で上書き
      source_url = COALESCE(works.source_url, EXCLUDED.source_url)
      -- updated_at は BEFORE UPDATE トリガーで自動更新される
      -- created_at は触らない（INSERT 時の DEFAULT のまま）
    RETURNING id, (xmax = 0) INTO v_id, v_is_new;
    -- xmax = 0 は INSERT された行（新規）を意味する。
    -- xmax != 0 は UPDATE された行（既存）を意味する。

    IF v_is_new THEN
      v_new_ids := array_append(v_new_ids, v_id);
    END IF;
  END LOOP;

  RETURN v_new_ids;
END;
