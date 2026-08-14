// ============================================================
// weeklyNotify — Push型 週次自動通知
// ============================================================

function weeklyNotify() {
  const props = PropertiesService.getScriptProperties();
  const defaultUrl = props.getProperty("DISCORD_WEBHOOK_URL");

  // notify=TRUE のトピック一覧
  const topics = listTopics().filter(t => t.notify);
  if (!topics || topics.length === 0) return;

  console.log(topics);

  // 全トピックのヒットを先に取得（重複呼び出し回避）
  const hitsByKeyword = {};
  for (const t of topics) {
    const result = getWeeklyHits(t.keyword, "added");
    const articles = result.articles || [];
    if (articles.length > 0) {
      hitsByKeyword[t.keyword] = articles;
    }
  }

  // --- 1. デフォルト Webhook：全トピックまとめて送信 ---
  if (defaultUrl && Object.keys(hitsByKeyword).length > 0) {
    const topicCount = Object.keys(hitsByKeyword).length;
    const maxPerTopic = Math.floor(1800 / topicCount); // 2000文字制限の安全圏

    const lines = ["## 📬 今週の新着論文【全体通知・あいまい検索】\n"];
    for (const [kw, articles] of Object.entries(hitsByKeyword)) {
      const chunk = [`**【${kw}】** — ${articles.length}件`];
      let len = chunk[0].length;
      for (const a of articles) {
        const url = a.source_url || (a.doi ? `https://doi.org/${a.doi}` : "");
        const journal = a.journal_name ? ` — *${a.journal_name}*` : "";
        const line = `* **${a.title}** : ${journal} ${url} `;
        if (len + line.length > maxPerTopic) {
          chunk.push(`  …他 ${articles.length - (chunk.length - 1)}件`);
          break;
        }
        chunk.push(line);
        len += line.length;
      }
      lines.push(chunk.join("\n"));
      lines.push("");
    }
    // console.log(lines);
    postToWebhook(defaultUrl, lines.join("\n"));
  } else if (defaultUrl) {
    postToWebhook(defaultUrl, "📭 今週の新着論文はありませんでした。");
  }
  // 力業でsleep(5000) （連投による429エラーを避ける）
  Utilities.sleep(5000);

  // --- 1.5 LLM 推薦セクション ---
  var threshold = parseInt(props.getProperty("LLM_SCORE_THRESHOLD") || "5", 10);
  var llmHits = getWeeklyLlmHits(threshold);
  var llmMsg = formatLlmSection(llmHits, 1800);
  if (llmMsg && defaultUrl) {
    postToWebhook(defaultUrl, llmMsg);
    Utilities.sleep(5000);
  }

  // --- 2. subscriptions：トピック別に該当チャンネルへ送信 ---
  var subs = fetchFromSupabase(
    "/rest/v1/subscriptions?select=webhook_url,topic_keyword"
  ) || [];

  var byUrl = {};
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    if (!hitsByKeyword[s.topic_keyword]) continue;
    if (!byUrl[s.webhook_url]) byUrl[s.webhook_url] = [];
    byUrl[s.webhook_url].push(s.topic_keyword);
  }

  for (var url in byUrl) {

    postToWebhook(url, "### ■チャンネル別送信（指定トピックあいまい検索）");
    Utilities.sleep(500);

    var keywords = byUrl[url];
    for (var j = 0; j < keywords.length; j++) {
      sendTopicDigest(url, keywords[j], hitsByKeyword[keywords[j]],
        { useLlm: true, maxChars: 150 });
    }
  }

  // --- 3. llm_subscriptions：LLM スコアベースのチャンネル別通知 ---
  var llmSubs = fetchFromSupabase(
    "/rest/v1/llm_subscriptions?select=webhook_url,topic_keyword,min_score"
  ) || [];

  var llmByUrl = {};
  for (var i = 0; i < llmSubs.length; i++) {
    var ls = llmSubs[i];
    if (!llmHits[ls.topic_keyword]) continue;
    if (!llmByUrl[ls.webhook_url]) llmByUrl[ls.webhook_url] = [];
    llmByUrl[ls.webhook_url].push({
      keyword:  ls.topic_keyword,
      minScore: ls.min_score
    });
  }

  for (var url in llmByUrl) {

    postToWebhook(url, "### ■チャンネル別送信（指定トピックLLM関連度推定）");
    Utilities.sleep(500);

    var entries = llmByUrl[url];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      // min_score でフィルタ（llmHits は既にグローバル閾値で絞られているが，
      // subscription ごとの閾値で追加フィルタ）
      var filtered = llmHits[e.keyword].filter(function(p) {
        return p.score >= e.minScore;
      });
      if (filtered.length === 0) continue;
      sendTopicDigest(url, e.keyword, filtered,
        { useLlm: true, maxChars: 100, showScore: true });
    }
  }


}



/**
 * 論文リストを整形して webhook に送信する共通関数
 * @param {string} webhookUrl - 送信先
 * @param {string} keyword - トピック名（見出し用）
 * @param {Array} articles - 論文オブジェクトの配列
 * @param {Object} [opts] - { useLlm: bool, maxChars: number, showScore: bool }
 */
function sendTopicDigest(webhookUrl, keyword, articles, opts) {
  opts = opts || {};
  var useLlm    = opts.useLlm    !== undefined ? opts.useLlm    : false;
  var maxChars  = opts.maxChars  !== undefined ? opts.maxChars  : 150;
  var showScore = opts.showScore !== undefined ? opts.showScore : false;

  var lines = ["**【" + keyword + "】** — " + articles.length + "件"];
  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];
    var url = a.source_url || (a.doi ? "https://doi.org/" + a.doi : "");
    var journal = a.journal_name ? " — *" + a.journal_name + "*" : "";
    var prefix = showScore && a.score != null ? "[" + a.score + "] " : "";
    var summary = "";
    if (useLlm && a.abstract) {
      summary = " [要約] " + summarizeArticle(a.title, a.abstract, { useLlm: true, maxChars: maxChars });
    }
    lines.push("* " + prefix + "**" + a.title + "**" + journal + " " + url + summary);
  }

  var msg = lines.join("\n");
  if (msg.length > 2000) {
    postToWebhook(webhookUrl, msg.substring(0, 1997) + "…");
  } else {
    postToWebhook(webhookUrl, msg);
  }
  Utilities.sleep(5000);
}


// ============================================================
// LLM 推薦セクション
//
// 追加するスクリプトプロパティ:
//   LLM_SCORE_THRESHOLD — 通知対象の最低スコア（デフォルト: 5）
// ============================================================


/**
 * LLM スコアが閾値以上の論文を取得（直近7日の評価分）
 * トピック別にグループ化して返す
 */
function getWeeklyLlmHits(minScore) {
  var since = new Date();
  since.setDate(since.getDate() - 7);
  var sinceStr = since.toISOString();

  // PostgREST: llm_topic_relevance JOIN works, topics
  var query = "/rest/v1/llm_topic_relevance"
    + "?select=score,reason,work_id(id,title,abstract,doi,source_url,journal_name),topic_id(keyword)"
    + "&score=gte." + minScore
    + "&evaluated_at=gte." + sinceStr
    + "&order=score.desc";

  var rows = fetchFromSupabase(query) || [];

  // トピック別にグループ化
  var byTopic = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var kw = r.topic_id.keyword;
    if (!byTopic[kw]) byTopic[kw] = [];
    byTopic[kw].push({
      title:        r.work_id.title,
      doi:          r.work_id.doi,
      source_url:   r.work_id.source_url,
      journal_name: r.work_id.journal_name,
      abstract:     r.work_id.abstract,
      score:        r.score,
      reason:       r.reason
    });
  }
  return byTopic;
}

/**
 * LLM 推薦セクションのメッセージを組み立てる
 */
function formatLlmSection(byTopic, maxChars) {
  if (Object.keys(byTopic).length === 0) return null;

  var topicCount = Object.keys(byTopic).length;
  var maxPerTopic = Math.floor((maxChars - 100) / topicCount);

  var lines = ["## 🔍トピック関連度推定で表示\n"];

  for (var kw in byTopic) {
    var papers = byTopic[kw];
    var chunk = ["**【" + kw + "】** — " + papers.length + "件"];
    var len = chunk[0].length;

    for (var j = 0; j < papers.length; j++) {
      var p = papers[j];
      var url = p.source_url || (p.doi ? "https://doi.org/" + p.doi : "");
      var journal = p.journal_name ? " — *" + p.journal_name + "*" : "";
      var summarizedAbstract = summarizeArticle(p.title, p.abstract, { useLlm: true, maxChars: 100 });
      var line = "* [" + p.score + "] **" + p.title + "**" + journal + " " + url + " [要約]" + summarizedAbstract;

      if (len + line.length > maxPerTopic) {
        chunk.push("  …他 " + (papers.length - j) + "件");
        break;
      }
      chunk.push(line);
      len += line.length;
    }
    lines.push(chunk.join("\n"));
    lines.push("");
  }
  return lines.join("\n");
}


// ============================================================
// weeklyNotify() 内への追加箇所
// ============================================================
//
// 既存の weeklyNotify() 関数内で，デフォルト Webhook への送信の後
// （「--- 2. subscriptions ---」コメントの前）に以下を挿入する:
//
//   // --- 1.5 LLM 推薦セクション ---
//   var threshold = parseInt(props.getProperty("LLM_SCORE_THRESHOLD") || "5", 10);
//   var llmHits = getWeeklyLlmHits(threshold);
//   var llmMsg = formatLlmSection(llmHits, 1800);
//   if (llmMsg && defaultUrl) {
//     postToWebhook(defaultUrl, llmMsg);
//     Utilities.sleep(2000);
//   }
//
// これにより，通常の「📬 今週の新着論文」の直後に
// 「🤖 LLM 推薦」が別メッセージとして送信される。


function postToWebhook(webhookUrl, content) {
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ content: content }),
    muteHttpExceptions: true
  });
  console.log("status:", res.getResponseCode(), "body:", res.getContentText());

}



function test_llmsub() {

  const props = PropertiesService.getScriptProperties();
  const defaultUrl = props.getProperty("DISCORD_WEBHOOK_URL");

  // notify=TRUE のトピック一覧
  const topics = listTopics().filter(t => t.notify);
  if (!topics || topics.length === 0) return;

  console.log(topics);

  // --- 1.5 LLM 推薦セクション ---
   var threshold = parseInt(props.getProperty("LLM_SCORE_THRESHOLD") || "5", 10);
   var llmHits = getWeeklyLlmHits(threshold);
   var llmMsg = formatLlmSection(llmHits, 1800);
   console.log(llmMsg);
   if (llmMsg && defaultUrl) {
     postToWebhook(defaultUrl, llmMsg);
     Utilities.sleep(2000);
   }



}


