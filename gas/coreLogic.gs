// ============================================================
// coreLogic.js — Stage 2 コアロジック層 + グルーコード層
// ============================================================
//
// 【依存】
//   dailyCollect.js の以下の関数を共有:
//     fetchFromSupabase, postToSupabase, patchToSupabase,
//     SUPABASE_URL, SUPABASE_KEY, PROPS
//
// 【スクリプトプロパティ（追加分）】
//   GROQ_API_KEY          — (任意) Groq API Key。未設定なら要約スキップ
//   GROQ_MODEL            — (任意) デフォルト: llama-3.3-70b-versatile
//   DISCORD_APPLICATION_ID — Discord Bot の Application ID
//
// ============================================================

// -----------------------------------------------------------
// 0. 追加の定数
// -----------------------------------------------------------

var DISCORD_APPLICATION_ID = PROPS.getProperty("DISCORD_APPLICATION_ID");
var GROQ_API_KEY = PROPS.getProperty("GROQ_API_KEY");
var GROQ_MODEL = PROPS.getProperty("GROQ_MODEL") || "llama-3.3-70b-versatile";

// -----------------------------------------------------------
// 1. コアロジック層（Discord に依存しない）
// -----------------------------------------------------------

/**
 * works テーブルをキーワード検索する。
 * @param {string} keyword - 検索キーワード
 * @param {string} mode - "added"（created_at 基準）or "published"（publication_date 基準）
 * @param {number} limitDays - 遡る日数（デフォルト: 30）
 * @param {number} maxResults - 最大件数（デフォルト: 5）
 * @returns {Array} ヒットした論文の配列
 */
function searchWorks(keyword, mode, limitDays, maxResults) {
  mode = mode || "added";
  limitDays = limitDays || 30;
  maxResults = maxResults || 5;

  var dateCol = (mode === "published") ? "publication_date" : "created_at";
  var cutoff = getISODate(-limitDays);

  // ILIKE で日本語・英語どちらも検索（pgroonga 不要で十分な規模）
  var path = "/rest/v1/works"
    + "?or=(title.ilike.*" + encodeURIComponent(keyword) + "*"
    + ",abstract.ilike.*" + encodeURIComponent(keyword) + "*)"
    + "&" + dateCol + "=gte." + cutoff
    + "&order=publication_date.desc"
    + "&limit=" + maxResults
    + "&select=id,paper_key,doi,title,abstract,authors,journal_name,publication_date,source_url,language,collection_sources,created_at";

  return fetchFromSupabase(path);
}

/**
 * 今週の論文を取得する。トピック指定あり/なし両対応。
 * @param {string|null} topicKeyword - トピックで絞り込み（null なら全登録トピック）
 * @param {string} mode - "added" or "published"
 * @returns {Object} { topic: string, articles: Array } or { topics: [{topic, articles}] }
 */
function getWeeklyHits(topicKeyword, mode) {
  mode = mode || "added";
  var cutoff = getISODate(-7);

  if (topicKeyword) {
    // 特定トピック指定
    var topic = fetchFromSupabase(
      "/rest/v1/topics?keyword=eq." + encodeURIComponent(topicKeyword) + "&limit=1"
    );
    if (topic.length === 0) {
      return { topic: topicKeyword, articles: [], hitLimit: false, error: "トピック未登録" };
    }
    var result = fetchWeeklyByTopicId(topic[0].id, mode, cutoff);
    return { topic: topicKeyword, articles: result.articles, hitLimit: result.hitLimit };
  }

  // トピック未指定：全登録トピックのヒットをまとめて返す
  var allTopics = fetchFromSupabase("/rest/v1/topics?select=id,keyword&order=keyword.asc");
  var results = [];

  allTopics.forEach(function(t) {
    var result = fetchWeeklyByTopicId(t.id, mode, cutoff);
    if (result.articles.length > 0) {
      results.push({ topic: t.keyword, articles: result.articles, hitLimit: result.hitLimit });
    }
  });

  // トピック紐づけなしの全件も取得（トピック未登録の場合のフォールバック）
  if (allTopics.length === 0) {
    var dateCol = (mode === "published") ? "publication_date" : "created_at";
    var allArticles = fetchFromSupabase(
      "/rest/v1/works?" + dateCol + "=gte." + cutoff
      + "&order=publication_date.desc&limit=20"
      + "&select=id,title,authors,journal_name,abstract,publication_date,source_url,language"
    );
    results.push({ topic: "(全件)", articles: allArticles });
  }

  return { topics: results };
}

/**
 * 特定トピックIDの週次ヒットを取得する。
 * works_topics → work_id 取得 → works を個別取得の2段階方式。
 */
function fetchWeeklyByTopicId(topicId, mode, cutoff) {
  var dateCol = (mode === "published") ? "publication_date" : "created_at";
  var DB_LIMIT_PER_TOPIC = 10; // DB から取得する上限

  // Step 1: works_topics から work_id を取得（上限付き）
  var pairs = fetchFromSupabase(
    "/rest/v1/works_topics?topic_id=eq." + topicId
    + "&select=work_id&limit=" + DB_LIMIT_PER_TOPIC
  );

  if (pairs.length === 0) return { articles: [], hitLimit: false };

  var hitLimit = (pairs.length >= DB_LIMIT_PER_TOPIC);

  // Step 2: work_id リストで works を検索（日付フィルタ付き）
  var workIds = pairs.map(function(p) { return p.work_id; });

  var articles = fetchFromSupabase(
    "/rest/v1/works?id=in.(" + workIds.join(",") + ")"
    + "&" + dateCol + "=gte." + cutoff
    + "&order=publication_date.desc"
    + "&select=id,title,authors,journal_name,abstract,publication_date,source_url,language,created_at"
  );

  return { articles: articles, hitLimit: hitLimit };
}

/**
 * トピックを追加し，既存 works に対してバックフィルする。
 * @param {string} keyword - 追加するキーワード
 * @param {string} addedBy - 追加したユーザーの Discord ID（任意）
 * @returns {Object} { id, keyword, backfillCount }
 */
function addTopic(keyword, addedBy) {
  // topics に INSERT
  var inserted = postToSupabase("/rest/v1/topics", [{
    keyword: keyword,
    scope: "keyword",
    added_by: addedBy || null
  }], "return=representation,resolution=ignore-duplicates");

  if (!inserted || inserted.length === 0) {
    // 既に存在する場合
    var existing = fetchFromSupabase(
      "/rest/v1/topics?keyword=eq." + encodeURIComponent(keyword)
    );
    if (existing.length > 0) {
      return { id: existing[0].id, keyword: keyword, backfillCount: 0, message: "既に登録済み" };
    }
    return { id: null, keyword: keyword, backfillCount: 0, message: "追加失敗" };
  }

  var topicId = inserted[0].id;

  // 既存 works に対してバックフィル
  var backfillCount = backfillTopic(topicId, keyword);

  return { id: topicId, keyword: keyword, backfillCount: backfillCount };
}

/**
 * 既存 works に対してトピック紐づけをバックフィルする。
 */
function backfillTopic(topicId, keyword) {
  // works 全件から ILIKE マッチを検索
  var matches = fetchFromSupabase(
    "/rest/v1/works?select=id"
    + "&or=(title.ilike.*" + encodeURIComponent(keyword) + "*"
    + ",abstract.ilike.*" + encodeURIComponent(keyword) + "*)"
  );

  if (matches.length === 0) return 0;

  var pairs = matches.map(function(w) {
    return { work_id: w.id, topic_id: topicId };
  });

  postToSupabase("/rest/v1/works_topics", pairs, "resolution=ignore-duplicates");
  return pairs.length;
}

/**
 * トピックを削除する。works_topics は CASCADE で自動削除される。
 * @param {string} keyword
 * @returns {Object} { deleted: boolean, keyword }
 */
function removeTopic(keyword) {
  var response = UrlFetchApp.fetch(
    SUPABASE_URL + "/rest/v1/topics?keyword=eq." + encodeURIComponent(keyword),
    {
      method: "delete",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      },
      muteHttpExceptions: true
    }
  );
  return { deleted: response.getResponseCode() < 300, keyword: keyword };
}

/**
 * 登録中の全トピックを返す。
 * @returns {Array} [{id, keyword, scope, notify, created_at}]
 */
function listTopics() {
  return fetchFromSupabase("/rest/v1/topics?select=id,keyword,scope,notify,created_at&order=keyword.asc");
}

// -----------------------------------------------------------
// 2. 要約モジュール（Groq プラグイン）
//    GROQ_API_KEY が未設定なら要約をスキップし，
//    タイトル + リンクのみの一覧を返す。
//    設定すれば自動的に要約が有効になる。
// -----------------------------------------------------------

/**
 * @param {string} title
 * @param {string} abstract
 * @param {Object} [opts] - オプション
 * @param {boolean} [opts.useLlm=true] - LLM要約を使うか（falseならアブスト先頭切り出し）
 * @param {number}  [opts.maxChars=100] - 要約の目標文字数（LLM使用時のプロンプトに反映）
 * @returns {string}
 */
function summarizeArticle(title, abstract, opts) {
  
  opts = opts || {};
  var useLlm = (opts.useLlm !== undefined) ? opts.useLlm : true;
  var maxChars = opts.maxChars || 150;
  // アブストラクトがない場合
  if (!abstract || abstract.trim() === "") {
    // 【抄録未登録のため要約不可】
    return "";
  }

  // LLM不使用 or APIキー未設定 → フォールバック（先頭切り出し）
  if (!useLlm || !GROQ_API_KEY) {
    var cutLen = Math.min(maxChars, abstract.length);
    var truncated = abstract.substring(0, cutLen);
    if (abstract.length > cutLen) truncated += "…";
    return truncated;
  }
  return callGroqSummary(title, abstract, maxChars);
}

/**
 * Groq API で学術要約を生成する。
 * GROQ_API_KEY 設定時のみ呼ばれる。
 */
function callGroqSummary(title, abstract, maxChars) {
  maxChars = maxChars || 150;
  var url = "https://api.groq.com/openai/v1/chat/completions";

  var systemPrompt =
    "You are a strict academic summarization bot. " +
    "Rule 1: Use ONLY the provided title and abstract. NEVER use external knowledge.\n" +
    "Rule 2: If the abstract is empty or missing, respond exactly empty str." +
    "Rule 3: Use neutral, third-person academic tone（〜である，〜が示された）.\n" +
    "Rule 4: Do NOT speculate or add conclusions not in the source.\n" +
    "Rule 5: Output in Japanese regardless of input language.\n" +
    "Rule 6: Keep the summary within approximately " + maxChars + " characters.";

  // max_tokens を文字数から概算（日本語1文字≒1.5〜2トークン、余裕をもたせる）
  var estimatedTokens = Math.ceil(maxChars * 2);

  var payload = {
    "model": GROQ_MODEL,
    "messages": [
      { "role": "system", "content": systemPrompt },
      { "role": "user", "content": "Title: " + title + "\nAbstract: " + abstract }
    ],
    "temperature": 0.1,
    "max_tokens": Math.max(estimatedTokens, 200)
  };

  var response = UrlFetchApp.fetch(url, {
    "method": "post",
    "headers": {
      "Authorization": "Bearer " + GROQ_API_KEY,
      "Content-Type": "application/json"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  });

  if (response.getResponseCode() === 200) {
    var json = JSON.parse(response.getContentText());
    return json.choices[0].message.content;
  }

  if (response.getResponseCode() === 429) {
    return "【レートリミットのため要約一時停止】";
  }

  return "【要約エラー: HTTP " + response.getResponseCode() + "】";
}

/**
 * 要約機能が有効かどうかを返す。
 */
function isGroqConfigured() {
  return !!GROQ_API_KEY;
}

// -----------------------------------------------------------
// 3. フォーマッタ（出力整形）
//    Discord 向けだが，Discord API には依存しない。
//    文字列を返すだけ。
// -----------------------------------------------------------

/**
 * 検索結果を Discord メッセージ用にフォーマットする。
 * @param {string} keyword
 * @param {Array} articles
 * @param {boolean} withSummary - 要約を含めるか
 * @returns {string}
 */
function formatSearchResult(keyword, articles, withSummary) {
  if (articles.length === 0) {
    return "キーワード「" + keyword + "」に一致する論文は見つかりませんでした。";
  }

  var lines = ["🔍 **検索結果：「" + keyword + "」** (" + articles.length + "件)\n"];

  articles.forEach(function(a, idx) {
    lines.push("**[" + (idx + 1) + "] " + a.title + "**");
    lines.push("  📖 " + (a.journal_name || "ジャーナル未特定") + " / " + (a.publication_date || "日付不明"));
    if (a.source_url) lines.push("  🔗 " + a.source_url);

  if (withSummary) {
      var summary = summarizeArticle(a.title, a.abstract, { useLlm: true, maxChars: 100 });
      lines.push("  📝 " + summary);
    }

    lines.push("");
  });

  return truncateForDiscord(lines.join("\n"));
}

/**
 * 週次ヒットを Discord メッセージ用にフォーマットする。
 * @param {Object} result - getWeeklyHits の戻り値
 * @param {string} mode
 * @returns {string}
 */
function formatWeeklyResult(result, mode) {
  var modeLabel = (mode === "published") ? "出版" : "追加";

  // 単一トピック指定の場合：2000文字フルに使える
  if (result.topic) {
    if (result.error) return "⚠️ トピック「" + result.topic + "」: " + result.error;
    if (result.articles.length === 0) {
      return "📚 **週次：「" + result.topic + "」** — 今週" + modeLabel + "された論文はありません。";
    }
    return truncateForDiscord(formatTopicSection(result.topic, result.articles, modeLabel, 1900, result.hitLimit));
  }

  // 全トピックの場合：トピック数で文字数を分配
  if (!result.topics || result.topics.length === 0) {
    return "📚 今週" + modeLabel + "された論文はありません。\nトピック未登録の場合は `/add_topic` でキーワードを追加してください。";
  }

  var budgetPerTopic = Math.floor(1800 / result.topics.length);
  budgetPerTopic = Math.max(budgetPerTopic, 200);  // 最低200文字は確保

  var sections = result.topics.map(function(t) {
    return formatTopicSection(t.topic, t.articles, modeLabel, budgetPerTopic, t.hitLimit);
  });

  return truncateForDiscord(sections.join("\n\n"));
}

function formatTopicSection(topicKeyword, articles, modeLabel, charBudget, hitLimit) {
  var DISPLAY_LIMIT = (charBudget >= 1000) ? 10 : 5;
  charBudget = charBudget || 400;

  var countLabel = articles.length + (hitLimit ? "件以上" : "件");
  var header = "📚 **「" + topicKeyword + "」** (今週" + modeLabel + ": " + countLabel + ")";
  var lines = [header];
  var charCount = header.length;
  var displayed = 0;

  for (var i = 0; i < Math.min(articles.length, DISPLAY_LIMIT); i++) {
    var a = articles[i];
    var line = "  " + (i + 1) + ". " + a.title
      + " — " + (a.journal_name || "")
      + " (" + (a.publication_date || "") + ")"
      + (a.source_url ? "\n     " + a.source_url : "");

    if (charCount + line.length > charBudget && displayed > 0) {
      lines.push("  …他 " + (articles.length - displayed) + "件");
      break;
    }

    lines.push(line);
    charCount += line.length;
    displayed++;
  }

  if (displayed === DISPLAY_LIMIT && articles.length > DISPLAY_LIMIT) {
    lines.push("  …他 " + (articles.length - DISPLAY_LIMIT) + "件");
  }

  return lines.join("\n");
}

/**
 * トピック一覧を Discord メッセージ用にフォーマットする。
 */
function formatTopicList(topics) {
  if (topics.length === 0) {
    return "登録されているトピックはありません。`/add_topic` で追加してください。";
  }

  var lines = ["📋 **登録トピック一覧** (" + topics.length + "件)\n"];
  topics.forEach(function(t) {
    lines.push("• **" + t.keyword + "** (" + t.scope + ")" + (t.notify ? " 🔔" : ""));
  });

  return lines.join("\n");
}

/**
 * Discord の2000文字制限に収まるように切り詰める。
 */
function truncateForDiscord(text) {
  if (text.length <= 1900) return text;
  return text.substring(0, 1900) + "\n…（以降省略。件数を絞って再検索してください）";
}

// -----------------------------------------------------------
// 4. グルーコード層（Discord ↔ コアロジックの橋渡し）
// -----------------------------------------------------------

/**
 * Cloudflare Workers から呼ばれるエントリポイント。
 * コア関数を呼び出し，結果を Discord に書き戻す。
 */
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var command = data.command;
  var param = data.param || null;
  var mode = data.mode || "added";
  var token = data.token;
  var userId = data.userId || null;

  Logger.log("doPost: command=" + command + " param=" + param + " mode=" + mode);

  var output = "";

  try {
    switch (command) {
      case "search":
        var articles = searchWorks(param, mode);
        var withSummary = isGroqConfigured();
        output = formatSearchResult(param, articles, withSummary);
        break;

      case "weekly":
        var weeklyResult = getWeeklyHits(param, mode);
        output = formatWeeklyResult(weeklyResult, mode);
        break;

      case "add_topic":
        var addResult = addTopic(param, userId);
        if (addResult.message === "既に登録済み") {
          output = "⚠️ トピック「" + param + "」は既に登録されています。";
        } else {
          output = "✅ トピック「" + param + "」を追加しました。既存論文とのマッチ: " + addResult.backfillCount + "件";
        }
        break;

      case "remove_topic":
        var removeResult = removeTopic(param);
        output = removeResult.deleted
          ? "✅ トピック「" + param + "」を削除しました。"
          : "⚠️ トピック「" + param + "」の削除に失敗しました。";
        break;

      case "list_topics":
        var topics = listTopics();
        output = formatTopicList(topics);
        break;

      default:
        output = "⚠️ 不明なコマンド: " + command;
    }
  } catch (error) {
    Logger.log("doPost エラー: " + error.message);
    output = "⚠️ 処理中にエラーが発生しました: " + error.message;
  }

  // Discord に書き戻し
  if (token && token !== "dummy") {
    sendBackToDiscord(token, output);
  } else {
    // テスト時：Logger に出力
    Logger.log("=== 出力 ===\n" + output);
  }

  // GAS Web App はレスポンスを返す必要がある
  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Discord の仮応答（考え中...）を確定結果で上書きする。
 */
function sendBackToDiscord(token, messageContent) {
  var discordWebhookUrl = "https://discord.com/api/v10/webhooks/"
    + DISCORD_APPLICATION_ID + "/" + token + "/messages/@original";

  UrlFetchApp.fetch(discordWebhookUrl, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify({ content: messageContent }),
    muteHttpExceptions: true
  });
}

// -----------------------------------------------------------
// 5. テストハーネス（GAS エディタから直接実行可能）
// -----------------------------------------------------------

function test_searchWorks() {
  var results = searchWorks("emoji", "added");
  Logger.log("ヒット件数: " + results.length);
  results.forEach(function(r) {
    Logger.log("[" + r.paper_key + "] " + r.title);
  });
}

function test_searchWorks_published() {
  var results = searchWorks("multimodal", "published", 30);
  Logger.log("ヒット件数（出版日基準）: " + results.length);
  results.forEach(function(r) {
    Logger.log("  " + r.publication_date + " | " + r.title);
  });
}

function test_summarize() {
  // var results = searchWorks("emoji", "added");
  var results = searchWorks("web", "added");
  if (results.length === 0) { Logger.log("ヒットなし"); return; }
  Logger.log("Groqの登録: " + (isGroqConfigured() ? "有効 (Groq)" : "無効 (先頭切り出し)"));
  var summary = summarizeArticle(results[0].title, results[0].abstract);
  Logger.log("タイトル: " + results[0].title);
  Logger.log("要約: " + summary);
}

function test_weeklyHits_all() {
  var result = getWeeklyHits(null, "added");
  Logger.log("=== 今週追加（全トピック）===");
  Logger.log(formatWeeklyResult(result, "added"));
}

function test_weeklyHits_topic() {
  var result = getWeeklyHits("emoji", "added");
  Logger.log("=== 今週追加（emoji）===");
  Logger.log(formatWeeklyResult(result, "added"));
}

function test_weeklyHits_published() {
  var result = getWeeklyHits(null, "published");
  Logger.log("=== 今週出版（全トピック）===");
  Logger.log(formatWeeklyResult(result, "published"));
}

function test_addTopic() {
  var result = addTopic("pragmatics");
  Logger.log("追加結果: " + JSON.stringify(result));
}

function test_removeTopic() {
  var result = removeTopic("pragmatics");
  Logger.log("削除結果: " + JSON.stringify(result));
}

function test_listTopics() {
  var topics = listTopics();
  Logger.log(formatTopicList(topics));
}

function test_fullPipeline() {
  // 検索 → フォーマット → ログ出力（Discord 不要で全パイプラインを確認）
  Logger.log("=== Full Pipeline Test ===\n");

  Logger.log("--- トピック一覧 ---");
  var topics = listTopics();
  Logger.log(formatTopicList(topics));

  Logger.log("\n--- 検索: emoji ---");
  var articles = searchWorks("emoji", "added");
  Logger.log(formatSearchResult("emoji", articles, false));

  Logger.log("\n--- 週次（全トピック）---");
  var weekly = getWeeklyHits(null, "added");
  Logger.log(formatWeeklyResult(weekly, "added"));
}

function test_doPost_search() {
  // doPost を疑似的に呼ぶ（Discord 書き戻しはスキップ）
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        command: "search",
        param: "emoji",
        mode: "added",
        token: "dummy"
      })
    }
  };
  doPost(fakeEvent);
}

function test_doPost_weekly() {
  var fakeEvent = {
    postData: {
      contents: JSON.stringify({
        command: "weekly",
        param: null,
        mode: "added",
        token: "dummy"
      })
    }
  };
  doPost(fakeEvent);
}