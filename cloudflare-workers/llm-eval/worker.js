

// =============================================================
// LLM トピック関連性評価 — Cloudflare Worker scheduled ハンドラ
//
// 既存の worker.js の export default { ... } 内に
// scheduled ハンドラを追記し，ヘルパー関数群を末尾に追加する。
//
// 必要な環境変数（Cloudflare Dashboard → Settings → Variables）:
//   SUPABASE_URL           — Supabase プロジェクト URL
//   SUPABASE_KEY           — Supabase service_role キー
//   GROQ_API_KEY           — Groq API キー
//   GROQ_MODEL             — (任意) デフォルト: llama-3.3-70b-versatile
//   LLM_EVAL_LOOKBACK_DAYS — (任意) デフォルト: 14
//   LLM_EVAL_MAX_PAPERS    — (任意) デフォルト: 5
//   LLM_EVAL_SLEEP_MS      — (任意) 呼び出し間隔 ms。デフォルト: 2000
// =============================================================

export default {
  async fetch(request, env, ctx) {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processLlmEvaluations(env));
  },
};


// =============================================================
// メイン処理
// =============================================================

async function processLlmEvaluations(env) {
  const lookbackDays = parseInt(env.LLM_EVAL_LOOKBACK_DAYS || "14", 10);
  const maxPapers    = parseInt(env.LLM_EVAL_MAX_PAPERS    || "5",  10);
  const sleepMs      = parseInt(env.LLM_EVAL_SLEEP_MS      || "2000", 10);
  const groqModel    = env.GROQ_MODEL || "llama-3.3-70b-versatile";

  // 1. 未評価ペアを取得
  const pairs = await getUnevaluatedPairs(env, lookbackDays, maxPapers);
  if (pairs.length === 0) {
    console.log("[llm-eval] No unevaluated pairs found. Done.");
    return;
  }
  console.log(`[llm-eval] Processing ${pairs.length} pairs (model: ${groqModel})`);

  // 2. 1 ペアずつ評価 → INSERT
  let ok = 0;
  let ng = 0;

  for (const pair of pairs) {
    try {
      const result = await evaluateRelevance(env, groqModel, pair);
      await insertEvaluation(env, {
        work_id:  pair.work_id,
        topic_id: pair.topic_id,
        score:    result.score,
        reason:   result.reason,
        model:    groqModel,
      });
      ok++;
      console.log(
        `[llm-eval] OK  work=${pair.work_id} topic=${pair.topic_id} score=${result.score}`
      );
    } catch (e) {
      ng++;
      console.error(
        `[llm-eval] ERR work=${pair.work_id} topic=${pair.topic_id}: ${e.message}`
      );
    }

    // TPM 制限回避のためスリープ
    if (sleepMs > 0) await sleep(sleepMs);
  }

  console.log(`[llm-eval] Finished. success=${ok} error=${ng}`);
}

// =============================================================
// Supabase: 未評価ペア取得 (RPC)
// =============================================================

async function getUnevaluatedPairs(env, lookbackDays, maxPapers) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/get_unevaluated_pairs`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      apikey:          env.SUPABASE_KEY,
      Authorization:   `Bearer ${env.SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      lookback_days: lookbackDays,
      max_papers:    maxPapers,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase RPC get_unevaluated_pairs failed: ${res.status} ${body}`);
  }
  return res.json();
}

// =============================================================
// Groq: 関連性評価
// =============================================================

const SYSTEM_PROMPT = `You are an evaluator that assesses how relevant an academic paper is to a given research topic.
You will receive one topic (keyword + description) and one paper (title + abstract).
Respond ONLY with a JSON object in this exact format:
{"score": <integer 0-10>, "reason": "<1-2 sentence explanation>"}

Scoring guide:
  0    : Completely irrelevant
  1-3  : Tangentially related at best
  4-6  : Shares the broader field but not directly about the topic
  7-8  : Highly relevant; directly addresses aspects of the topic
  9-10 : Core contribution to this exact topic

Keep the reason concise. If the abstract is missing or empty, evaluate based on the title only and note the limitation.`;

function buildUserPrompt(pair) {
  const abstract = pair.abstract
    ? pair.abstract
    : "(abstract not available)";

  return `## Research Topic
Keyword: ${pair.keyword}
Description: ${pair.llm_description}

## Paper
Title: ${pair.title}
Abstract: ${abstract}`;
}

async function evaluateRelevance(env, model, pair) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: buildUserPrompt(pair) },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error: ${res.status} ${body}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("Groq returned empty content");
  }

  return parseEvaluation(raw);
}

/**
 * Groq レスポンスの JSON をパース・バリデーション
 */
function parseEvaluation(raw) {
  let parsed;
  try {
    // response_format: json_object でも稀にコードフェンスが付くことがある
    const cleaned = raw.replace(/```json\s*|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse Groq response as JSON: ${raw.slice(0, 200)}`);
  }

  const score = Number(parsed.score);
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new Error(`Invalid score: ${parsed.score} (raw: ${raw.slice(0, 200)})`);
  }

  return {
    score,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : null,
  };
}

// =============================================================
// Supabase: 評価結果 INSERT
// =============================================================

async function insertEvaluation(env, evaluation) {
  const url = `${env.SUPABASE_URL}/rest/v1/llm_topic_relevance`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      apikey:          env.SUPABASE_KEY,
      Authorization:   `Bearer ${env.SUPABASE_KEY}`,
      Prefer:          "return=minimal",
    },
    body: JSON.stringify(evaluation),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase INSERT failed: ${res.status} ${body}`);
  }
}

// =============================================================
// ユーティリティ
// =============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
