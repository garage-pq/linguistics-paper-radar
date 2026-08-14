
  WITH target_papers AS (
    SELECT w.id, w.title, w.abstract, w.publication_date
    FROM works w
    WHERE w.created_at >= now() - make_interval(days => lookback_days)
      AND (w.publication_date >= CURRENT_DATE - lookback_days
           OR w.publication_date IS NULL)
      -- 少なくとも 1 つの未評価トピックが存在する論文のみ
      AND EXISTS (
        SELECT 1 FROM topics t
        WHERE t.llm_notify = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM llm_topic_relevance r
            WHERE r.work_id = w.id AND r.topic_id = t.id
          )
      )
    ORDER BY w.publication_date DESC NULLS LAST
    LIMIT max_papers
  )
  SELECT p.id       AS work_id,
         t.id       AS topic_id,
         p.title,
         p.abstract,
         t.keyword,
         t.llm_description
  FROM target_papers p
  CROSS JOIN topics t
  LEFT JOIN llm_topic_relevance r
         ON r.work_id = p.id AND r.topic_id = t.id
  WHERE t.llm_notify = TRUE
    AND r.work_id IS NULL
  ORDER BY p.publication_date DESC NULLS LAST, t.id;
