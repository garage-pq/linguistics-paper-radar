// ============================================================
// dailyCollect.js — Stage 1 日次バッチ収集スクリプト
// ============================================================
//
// 【前提】
// Supabase に以下の RPC を事前にデプロイしておくこと（後述の SQL セクション参照）
//   - upsert_work(p_paper_key, p_doi, p_title, p_abstract, ...)
//   - bulk_upsert_works(p_works JSONB)
//
// 【スクリプトプロパティ（GAS エディタで設定）】
//   SUPABASE_URL, SUPABASE_KEY, MAILTO, CINII_APPID,
//   SEMANTIC_SCHOLAR_KEY (任意), DISCORD_WEBHOOK_URL
//
// ============================================================

// -----------------------------------------------------------
// 0. 定数・設定
// -----------------------------------------------------------

var PROPS = PropertiesService.getScriptProperties();
var SUPABASE_URL = PROPS.getProperty("SUPABASE_URL");
var SUPABASE_KEY = PROPS.getProperty("SUPABASE_KEY");
var MAILTO = PROPS.getProperty("MAILTO");
var OPENALEX_APIKEY = PROPS.getProperty("OPENALEX_APIKEY");
var CINII_APPID = PROPS.getProperty("CINII_APPID");
var SEMANTIC_SCHOLAR_KEY = PROPS.getProperty("SEMANTIC_SCHOLAR_KEY");


// OpenAlexの分野検索対象 {"1203": "Language and Linguistics", "3310": "Linguistics and Language"}
var OPENALEX_SUBFIELDS = ["1203", "3310"];


// キーワード検索
// OpenAlexのキーワードリスト（ここにハードコードするか，topics テーブルから取得する）
var KEYWORD_SCOPE_QUERIES = [
  '"emoji" OR "emoticon"',
  '"CMC" OR "computer-mediated communication"',
  '"digital communication"',
  '"hashtag" OR "hashtags"',
  '"cognitive linguistics"',
  '"pictogram" OR "pictograph" OR "linguistic landscape"'
];

// CiNiiのキーワード
var CINII_QUERIES = [
  // 絵文字・顔文字
  '(絵文字 OR 顔文字 OR emoji OR emoticon)',

  // ピクトグラム
  '(pictogram OR ピクトグラム)',

  // 言語景観
  '(言語景観 OR linguistic landscape)',


  // CMC（コンピュータ媒介コミュニケーション）
  '(CMC OR computer-mediated)',

  // 語用論・プラグマティクス
  '(語用論 OR pragmatics)',

  // ハッシュタグ
  '(ハッシュタグ OR hashtag)',

  // ソーシャルメディア
  '(SNS or Twitter or YouTube or Instagram)'
];

// J-STAGE 監視対象 ISSN
var JSTAGE_ISSNS = [
  "2185-6710",  // 言語研究 Online
  "1344-3909",   // 社会言語科学（ISSN-L）   "2189-7239",  // 社会言語科学（online）
  "2433-0302",  // 計量国語学 Online
  "2189-5473",  // 認知言語科学 Online
  "2185-8314", // 自然言語処理 Online
  "1884-510X", // 認知神経科学 Online
  "2187-0047", // SECOND LANGUAGE（日本第二言語習得学会） Online
  "2432-0412",  //全国英語教育学会紀要（ARELE）
  "2185-7814", // 外国語教育メディア学会機関誌（Language Education & Technology）
  "2432-1591", // 日本教育工学会論文誌（Transactions of jset）
  "1881-0101", // 情報社会学会誌（Journal of Informatics Society）
  "1882-7802" // 情報処理学会論文誌（IPSJ Journal）
];

// -----------------------------------------------------------
// 1. メイン関数（GAS 時間トリガーで呼ばれる）
// -----------------------------------------------------------

function dailyCollect() {
  var allArticles = [];

  // --- 各ソースから収集（1ソースの失敗が全体を止めないよう個別 try-catch）---

  allArticles = allArticles.concat(safeCollect("openalex_field", collectOpenAlexField));
  allArticles = allArticles.concat(safeCollect("openalex_keyword", collectOpenAlexKeyword));
  allArticles = allArticles.concat(safeCollect("jstage", collectJstage));
  allArticles = allArticles.concat(safeCollect("cinii", collectCinii));
  allArticles = allArticles.concat(safeCollect("lingbuzz", collectLingBuzz));
  // allArticles = allArticles.concat(safeCollect("semantic_scholar", collectSemanticScholar));

  Logger.log("収集合計: " + allArticles.length + "件");

  if (allArticles.length === 0) {
    Logger.log("新着なし。終了。");
    // rotateOldRecords();
    return;
  }

  // --- Supabase へ一括 upsert ---
  var newWorkIds = bulkUpsertToSupabase(allArticles);
  Logger.log("upsert 完了。新規追加: " + newWorkIds.length + "件");

  // --- トピック紐づけ（新規追加分のみ）---
  if (newWorkIds.length > 0) {
    matchWorksToTopics(newWorkIds);
  }

  // --- 1ヶ月ローテーション ---
  // rotateOldRecords();

  Logger.log("dailyCollect 完了。");
}

/**
 * 収集関数を try-catch で包んで実行する。
 * 失敗しても空配列を返し，他ソースの処理を続行する。
 */
function safeCollect(sourceName, collectFn) {
  try {
    var articles = collectFn();
    // 各記事に source を付与
    articles.forEach(function(a) { a._source = sourceName; });
    Logger.log(sourceName + ": " + articles.length + "件");
    return articles;
  } catch (e) {
    Logger.log("⚠️ " + sourceName + " 収集エラー: " + e.message);
    return [];
  }
}

// -----------------------------------------------------------
// 2. 各ソースの収集関数
//    すべて同じ正規化形式 [{doi, title, abstract, authors,
//    journal_name, publication_date, source_url, language}] を返す
// -----------------------------------------------------------

// --- 2-A. OpenAlex（系統A：フィールドスコープ）---

// ORを|でつなぐとバグるので%7Cにしている
// ,type:article" で限定（ソフトウェア系省く）

function collectOpenAlexField() {
  var yesterday = getISODate(-1);
  var prevsevenday = getISODate(-7);
  var today = getISODate(0);

  // subfieldFilter: %7Cで繋ぐ．ブラウザなら"|"でアクセスできるが．
  // https://api.openalex.org/works?filter=primary_topic.subfield.id:1203|3310,from_publication_date:2026-06-24,to_publication_date:2026-07-25&sort=publication_date:desc&per_page=100
  var subfieldFilter = "primary_topic.subfield.id:" + OPENALEX_SUBFIELDS.join("%7C");

  var url = "https://api.openalex.org/works"
    + "?filter=" + subfieldFilter
    + ",from_publication_date:" + yesterday
    + ",to_publication_date:" + today
    + ",type:article"
    + "&sort=publication_date:desc"
    + "&per_page=100"
    + "&api_key=" + OPENALEX_APIKEY;
    // + "&mailto=" + MAILTO;

    // https://api.openalex.org/works?filter=primary_topic.subfield.id:1203|3310,from_publication_date:2026-06-24,to_publication_date:2026-07-25&sort=publication_date:desc&per_page=100 ぶらうざならいける

  return fetchOpenAlexPages(url);
}

// --- 2-B. OpenAlex（系統B：キーワードスコープ）---

function collectOpenAlexKeyword() {
  var yesterday = getISODate(-1);
  // var fromtargetday = getISODate(-30);
  var today = getISODate(0);
  var allResults = [];

  // articleに絞る

  KEYWORD_SCOPE_QUERIES.forEach(function(kw) {
    var url = "https://api.openalex.org/works"
      + "?filter=from_publication_date:" + yesterday
      + ",to_publication_date:" + today
      + ",type:article"
      + ",title_and_abstract.search:" + encodeURIComponent(kw)
      + "&sort=publication_date:desc"
      + "&per_page=200"
      + "&api_key=" + OPENALEX_APIKEY;

    console.log(url);

    allResults = allResults.concat(fetchOpenAlexPages(url));

    Utilities.sleep(100);

  });

  console.log(allResults.length);

  return allResults;
}

/**
 * OpenAlex API をページネーション付きで取得し，正規化形式に変換する。
 * cursor ベースのページネーションで全件取得（最大5ページ なら 1,000件）。
 */
function fetchOpenAlexPages(baseUrl) {
  var results = [];
  var cursor = "*";
  var maxPages = 1;

  for (var page = 0; page < maxPages; page++) {
    var url = baseUrl 
    // + "&cursor=" + cursor;
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

    if (response.getResponseCode() !== 200) {
      Logger.log("OpenAlex API エラー: " + response.getResponseCode());
      break;
    }

    var data = JSON.parse(response.getContentText());
    if (!data.results || data.results.length === 0) break;

    data.results.forEach(function(work) {
      results.push({
        doi: work.doi ? work.doi.replace("https://doi.org/", "") : null,
        title: work.title || "",
        abstract: restoreAbstractFromInvertedIndex(work.abstract_inverted_index),
        authors: (work.authorships || []).map(function(a) {
          return a.author.display_name;
        }).join(", "),
        journal_name: (work.primary_location && work.primary_location.source)
          ? work.primary_location.source.display_name : null,
        publication_date: work.publication_date || null,
        source_url: (work.primary_location && work.primary_location.landing_page_url)
          ? work.primary_location.landing_page_url
          : (work.doi ? "https://doi.org/" + work.doi.replace("https://doi.org/", "") : null),
        language: work.language || "en"
      });
    });

    // 次ページの cursor を取得
    cursor = data.meta && data.meta.next_cursor ? data.meta.next_cursor : null;
    if (!cursor) break;

    Utilities.sleep(200); // polite pool でもマナーとして間隔を空ける
  }

  return results;
}

/**
 * OpenAlex の abstract_inverted_index をプレーンテキストに復元する。
 * 形式: {"word": [pos1, pos2], "another": [pos3], ...}
 */
function restoreAbstractFromInvertedIndex(invertedIndex) {
  if (!invertedIndex) return null;

  var positions = [];
  for (var word in invertedIndex) {
    invertedIndex[word].forEach(function(pos) {
      positions.push({ pos: pos, word: word });
    });
  }

  positions.sort(function(a, b) { return a.pos - b.pos; });
  return positions.map(function(p) { return p.word; }).join(" ");
}

// --- 2-C. J-STAGE ---

// ── ヘルパー ──

/** entry 直下の子要素のテキストを取る（1階層） */
function getXmlChildText(parent, tagName, ns) {
  var child = parent.getChild(tagName, ns);
  return child ? child.getText() : null;
}

/** entry > tagName > "ja" (or "en") の CDATA テキストを取る（2階層） */
function getXmlNestedText(parent, tagName, ns, lang) {
  var child = parent.getChild(tagName, ns);
  if (!child) return null;
  var langChild = child.getChild(lang || "ja", ns);
  return langChild ? langChild.getText() : null;
}

/** prism 名前空間の要素を取る */
function getXmlPrismText(parent, tagName, prismNs) {
  var child = parent.getChild(tagName, prismNs);
  return child ? child.getText() : null;
}

/** author/ja/name を連結して返す */
function getAuthors(entry, ns, lang) {
  var authorEl = entry.getChild("author", ns);
  if (!authorEl) return null;
  var langEl = authorEl.getChild(lang || "ja", ns);
  if (!langEl) return null;
  return langEl.getChildren("name", ns)
    .map(function(n) { return n.getText(); })
    .join(", ");
}

function collectJstage() {
  var results = [];
  var currentYear = new Date().getFullYear();
  // 12/31の更新とかも拾えるように
  var fromYear = (new Date().getMonth() === 0) ? currentYear - 1 : currentYear;

  JSTAGE_ISSNS.forEach(function(issn) {

    var url = "https://api.jstage.jst.go.jp/searchapi/do"
      + "?service=3"
      + "&pubyearfrom=" + fromYear
      + "&issn=" + issn
      + "&sortflg=2";

    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log("J-STAGE API エラー (" + issn + "): " + response.getResponseCode());
      return; // このISSNをスキップして次へ
    }

    var xml = XmlService.parse(response.getContentText());
    var root = xml.getRootElement();
    var ns = root.getNamespace();

    // J-STAGE API のエラーレスポンスをチェック
    // まだ刊行されていないとERRORになるISSNがある
    var resultEl = root.getChild("result", ns);
    if (resultEl) {
      var status = resultEl.getChildText("status", ns);
      if (status && status.indexOf("ERR") === 0) {
        Logger.log("J-STAGE: " + status + " (" + issn + ")");
        return;  // 次の ISSN へ
      }
    }

    var entries = root.getChildren("entry", ns);

    var prismNs = XmlService.getNamespace("prism",
      "http://prismstandard.org/namespaces/basic/2.0/");

    entries.forEach(function(entry) {
      var updatedText = getXmlChildText(entry, "updated", ns);
      if (updatedText && !isWithinLastNDays(updatedText, 7)) return;

      var titleJa = getXmlNestedText(entry, "article_title", ns, "ja");
      var titleEn = getXmlNestedText(entry, "article_title", ns, "en");
      var doi     = getXmlPrismText(entry, "doi", prismNs);

      var linkEl  = entry.getChild("article_link", ns);
      var sourceUrl = null;
      if (linkEl) {
        var jaLink = linkEl.getChild("ja", ns);
        sourceUrl = jaLink ? jaLink.getText() : null;
      }

      var title = titleJa || titleEn || null;
      if (!title) {
        Logger.log("issn: "+  issn);
        Logger.log("JSTAGE: title 欠損 | doi=" + (doi || "none") +
                   " | url=" + (sourceUrl || "none") + (linkEl || "none"));
        return;  // forEach なので return でスキップ
      }

      results.push({
        doi:              doi || null,
        title:            title,
        abstract:         null,
        authors:          getAuthors(entry, ns, "ja") || getAuthors(entry, ns, "en"),
        journal_name:     getXmlNestedText(entry, "material_title", ns, "ja"),
        publication_date: getXmlChildText(entry, "pubyear", ns),
        source_url:       sourceUrl,
        language:         titleJa ? "ja" : "en"
      });
    });
    Utilities.sleep(500);

    });

  return results;
}

// --- 2-D. CiNii Research（v2 API）---

function collectCinii() {
  var now = new Date();
  var prevMonth = new Date(now);
  prevMonth.setMonth(prevMonth.getMonth() - 1);
  var fromYYYYMM = Utilities.formatDate(prevMonth, "Asia/Tokyo", "yyyyMM");

  var allResults = [];

  CINII_QUERIES.forEach(function(kw) {
    var url = "https://cir.nii.ac.jp/opensearch/v2/all"
      + "?q=" + encodeURIComponent(kw)
      + "&count=50"
      + "&hasLinkToFullText=true"
      + "&sortorder=0"
      + "&format=json"
      + "&from=" + fromYYYYMM
      + (CINII_APPID ? "&appid=" + CINII_APPID : "");

    console.log(url);

    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log("CiNii v2 API エラー: " + response.getResponseCode());
      return;
    }

    var data = JSON.parse(response.getContentText());
    var items = data.items || [];

    items.forEach(function(item) {
      var dateStr = item["dc:date"] || item["prism:publicationDate"] || "";
      if (dateStr && !isWithinLastNDays(dateStr, 2)) return;

      // item.link がオブジェクト {"@id": "..."} の場合と、文字列の場合の両方に対応する
      var sourceUrl = (item.link && item.link["@id"]) || 
                      (typeof item.link === 'string' ? item.link : null) || 
                      item["@id"] || 
                      null;

      allResults.push({
        doi: extractDoi(item["dc:identifier"]),
        title: item["dc:title"] || item.title || "",
        abstract: item["dc:description"] || null,
        authors: item["dc:creator"] ? (Array.isArray(item["dc:creator"])
          ? item["dc:creator"].join(", ") : String(item["dc:creator"])) : null,
        journal_name: item["prism:publicationName"] || null,
        publication_date: dateStr || null,
        source_url: sourceUrl,
        language: "ja"
      });
    });
  });

  // クエリ間の重複除去
  var seen = {};
  return allResults.filter(function(r) {
    var key = r.doi || r.source_url || r.title;
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// --- 2-E. LingBuzz（RSS）---

function collectLingBuzz() {
  var url = "https://feeds.feedburner.com/LingBuzz";
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error("LingBuzz RSS 取得エラー: " + response.getResponseCode());
  }

  // XML 1.0 で許容される文字以外を除去（対策：An invalid XML character (Unicode: 0x1d) was found in the CDATA section.）
  var rawText = response.getContentText();
  var sanitized = rawText.replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, "");

  var xml = XmlService.parse(sanitized);
  var root = xml.getRootElement();
  var ns = root.getNamespace();
  var items = root.getChild("channel", ns).getChildren("item", ns);
  var results = [];

  items.forEach(function(item) {
    var pubDate = getXmlChildText(item, "pubDate", ns);
    if (pubDate && !isWithinLastNDays(pubDate, 2)) return;

    var title = getXmlChildText(item, "title", ns) || "";
    var link = getXmlChildText(item, "link", ns) || "";
    var description = getXmlChildText(item, "description", ns) || "";

    // LingBuzz の description から著者名を抽出する試み
    // 形式が不定なので，最低限 title と link を確保
    results.push({
      doi: null,
      title: title,
      abstract: description || null,
      authors: null, // RSS からは著者の分離が難しい
      journal_name: "LingBuzz (preprint)",
      publication_date: pubDate ? formatDateISO(new Date(pubDate)) : null,
      source_url: link,
      language: "en"
    });
  });

  return results;
}

// --- 2-F. Semantic Scholar ---

function collectSemanticScholar() {
  var query = "emoji emoticon CMC computer-mediated communication";
  var currentYear = new Date().getFullYear();
  var fromYear = (new Date().getMonth() === 0) ? currentYear - 1 : currentYear;


  var url = "https://api.semanticscholar.org/graph/v1/paper/search"
    + "?query=" + encodeURIComponent(query)
    + "&year=" + fromYear
    + "&fields=title,abstract,authors,journal,externalIds,publicationDate,url"
    + "&limit=100";

  console.log(url);

  var headers = {};
  if (SEMANTIC_SCHOLAR_KEY) {
    headers["x-api-key"] = SEMANTIC_SCHOLAR_KEY;
  }

  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: headers
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("Semantic Scholar API エラー: " + response.getResponseCode());
  }

  var data = JSON.parse(response.getContentText());
  var papers = data.data || [];
  var results = [];

  papers.forEach(function(paper) {
    // 直近24時間判定
    if (paper.publicationDate && !isWithinLastNDays(paper.publicationDate, 2)) return;

    var doi = (paper.externalIds && paper.externalIds.DOI) || null;
    results.push({
      doi: doi,
      title: paper.title || "",
      abstract: paper.abstract || null,
      authors: (paper.authors || []).map(function(a) { return a.name; }).join(", "),
      journal_name: paper.journal ? paper.journal.name : null,
      publication_date: paper.publicationDate || null,
      source_url: paper.url || (doi ? "https://doi.org/" + doi : null),
      language: "en"
    });
  });

  return results;
}

// -----------------------------------------------------------
// 3. Supabase 一括 upsert（RPC 経由）
// -----------------------------------------------------------

/**
 * 全記事を Supabase の RPC bulk_upsert_works に一括送信する。
 * 新規追加された work_id の配列を返す。
 *
 * 【前提】Supabase に bulk_upsert_works RPC がデプロイ済みであること。
 * RPC が存在しない場合は fallbackUpsert（1件ずつ REST API）にフォールバック。
 */
function bulkUpsertToSupabase(articles) {
  // paper_key を生成して正規化
  var payload = articles.map(function(a) {
    return {
      paper_key: generatePaperKey(a.doi, a.title, a.authors),
      doi: a.doi || null,
      title: a.title,
      abstract: a.abstract || null,
      authors: a.authors || null,
      journal_name: a.journal_name || null,
      publication_date: normalizeDate(a.publication_date),
      source_url: a.source_url || null,
      language: a.language || "en",
      source: a._source
    };
  });

  // title が欠損しているレコードを除外（原因特定用にログ出力）
  var valid = [];
  payload.forEach(function(r) {
    if (!r.title || r.title.trim() === "") {
      Logger.log("SKIP: title 欠損 | source=" + r.source +
                 " | doi=" + r.doi +
                 " | paper_key=" + r.paper_key +
                 " | source_url=" + r.source_url);
    } else {
      valid.push(r);
    }
  });

  if (valid.length < payload.length) {
    Logger.log("bulkUpsert: " + (payload.length - valid.length) +
               "/" + payload.length + " 件を title 欠損で除外");
  }

  payload = valid;
  if (payload.length === 0) {
    Logger.log("bulkUpsert: 有効なレコードなし。スキップ。");
    return [];
  }

  // RPC 呼び出し（バッチ処理で HTTP 1回）
  try {
    var response = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/rpc/bulk_upsert_works", {
      method: "post",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      payload: JSON.stringify({ p_works: payload }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      var result = JSON.parse(response.getContentText());
      // RPC は新規追加された work_id の配列を返す
      return result || [];
    }

    Logger.log("RPC エラー (" + response.getResponseCode() + ")。フォールバックへ。");
  } catch (e) {
    Logger.log("RPC 呼び出し失敗: " + e.message + "。フォールバックへ。");
  }

  // フォールバック：1件ずつ REST API で upsert
  return fallbackUpsert(payload);
}

/**
 * RPC が使えない場合のフォールバック。1件ずつ upsert する。
 */
function fallbackUpsert(articles) {
  var newIds = [];

  articles.forEach(function(a) {
    // 既存チェック
    var existing = fetchFromSupabase(
      "/rest/v1/works?paper_key=eq." + encodeURIComponent(a.paper_key) + "&select=id,collection_sources"
    );

    if (existing.length > 0) {
      // 既存 → collection_sources 追加
      var sources = existing[0].collection_sources || [];
      if (sources.indexOf(a.source) === -1) {
        sources.push(a.source);
        patchToSupabase("/rest/v1/works?id=eq." + existing[0].id, {
          collection_sources: sources
        });
      }
    } else {
      // 新規 INSERT
      var inserted = postToSupabase("/rest/v1/works", [{
        paper_key: a.paper_key,
        doi: a.doi,
        title: a.title,
        abstract: a.abstract,
        authors: a.authors,
        journal_name: a.journal_name,
        publication_date: normalizeDate(a.publication_date),
        source_url: a.source_url,
        language: a.language,
        collection_sources: [a.source]
      }], "return=representation");

      if (inserted && inserted.length > 0) {
        newIds.push(inserted[0].id);
      }
    }
  });

  return newIds;
}

// -----------------------------------------------------------
// 4. トピック紐づけ
// -----------------------------------------------------------

function matchWorksToTopics(newWorkIds) {
  // topics テーブルから全キーワードを取得
  var topics = fetchFromSupabase("/rest/v1/topics?select=id,keyword");
  if (topics.length === 0) return;

  // 新規 works を取得
  // Supabase の in フィルタは URL 長制限があるため，チャンクに分割
  var chunks = chunkArray(newWorkIds, 50);
  var pairs = [];

  chunks.forEach(function(chunk) {
    var works = fetchFromSupabase(
      "/rest/v1/works?select=id,title,abstract&id=in.(" + chunk.join(",") + ")"
    );

    works.forEach(function(w) {
      var text = ((w.title || "") + " " + (w.abstract || "")).toLowerCase();
      topics.forEach(function(t) {
        if (text.indexOf(t.keyword.toLowerCase()) !== -1) {
          pairs.push({ work_id: w.id, topic_id: t.id });
        }
      });
    });
  });

  if (pairs.length > 0) {
    // ON CONFLICT DO NOTHING で重複回避
    postToSupabase("/rest/v1/works_topics", pairs, "resolution=ignore-duplicates");
    Logger.log("トピック紐づけ: " + pairs.length + "件");
  }
}

// -----------------------------------------------------------
// 5. 1ヶ月ローテーション
// -----------------------------------------------------------

function rotateOldRecords() {
  // Supabase REST API で30日超のレコードを削除
  // DELETE /rest/v1/works?created_at=lt.{30日前}
  var cutoff = getISODate(-30);
  var response = UrlFetchApp.fetch(
    SUPABASE_URL + "/rest/v1/works?created_at=lt." + cutoff + "T00:00:00Z",
    {
      method: "delete",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY
      },
      muteHttpExceptions: true
    }
  );
  Logger.log("ローテーション: HTTP " + response.getResponseCode());
}

// -----------------------------------------------------------
// 6. Supabase 通信ユーティリティ（インフラ層）
// -----------------------------------------------------------

function fetchFromSupabase(path) {
  var response = UrlFetchApp.fetch(SUPABASE_URL + path, {
    method: "get",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log("Supabase GET エラー: " + response.getResponseCode() + " " + path);
    return [];
  }
  return JSON.parse(response.getContentText());
}

function postToSupabase(path, body, prefer) {
  var headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json"
  };
  if (prefer) {
    headers["Prefer"] = prefer;
  }

  var response = UrlFetchApp.fetch(SUPABASE_URL + path, {
    method: "post",
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() >= 300) {
    Logger.log("Supabase POST エラー: " + response.getResponseCode() + " " + path);
    Logger.log(response.getContentText().substring(0, 500));
    return [];
  }

  var text = response.getContentText();
  return text ? JSON.parse(text) : [];
}

function patchToSupabase(path, body) {
  var response = UrlFetchApp.fetch(SUPABASE_URL + path, {
    method: "patch",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() >= 300) {
    Logger.log("Supabase PATCH エラー: " + response.getResponseCode() + " " + path);
  }
}

// -----------------------------------------------------------
// 7. 汎用ユーティリティ
// -----------------------------------------------------------

function generatePaperKey(doi, title, authors) {
  if (doi && doi.trim() !== "") {
    return doi.trim();
  }
  var raw = (title || "") + (authors || "");
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    raw,
    Utilities.Charset.UTF_8
  ).map(function(b) {
    return ("0" + (b & 0xFF).toString(16)).slice(-2);
  }).join("");
}

/** N日前の日付を YYYY-MM-DD 形式で返す */
function getISODate(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return formatDateISO(d);
}

function formatDateISO(date) {
  return Utilities.formatDate(date, "Asia/Tokyo", "yyyy-MM-dd");
}

/**
 * 日付文字列を PostgreSQL DATE 型互換の YYYY-MM-DD に正規化する。
 * "2026-08" → "2026-08-01"
 * "2026"    → "2026-01-01"
 * "2026-07-20" → そのまま
 * パース不能 → null
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  dateStr = String(dateStr).trim();
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) return dateStr.substring(0, 10);
  if (dateStr.match(/^\d{4}-\d{2}$/))      return dateStr + "-01";
  if (dateStr.match(/^\d{4}$/))             return dateStr + "-01-01";
  // その他（"June 2026" 等）は Date パースを試みる
  try {
    var d = new Date(dateStr);
    if (!isNaN(d.getTime())) return formatDateISO(d);
  } catch (e) {}
  return null;
}

/** ISO日付文字列または Date が直近 N 日以内かどうか判定する */
function isWithinLastNDays(dateStr, n) {
  try {
    var d = new Date(dateStr);
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - n);
    return d >= cutoff;
  } catch (e) {
    return true; // パースできない場合は含める（取りこぼし防止）
  }
}

/** XML要素から子要素のテキストを取得する（名前空間対応） */
function getXmlChildText(element, childName, ns) {
  var child = element.getChild(childName, ns);
  if (!child) {
    // 名前空間なしでも試す
    child = element.getChild(childName);
  }
  return child ? child.getText() : null;
}

/** 配列を指定サイズのチャンクに分割する */
function chunkArray(arr, size) {
  var chunks = [];
  for (var i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * CiNii 等の dc:identifier フィールドから DOI を抽出する。
 * 文字列・配列・オブジェクトのいずれで返ってきても対応する。
 *
 * CiNii v2 の実際の形式:
 *   [{"@type":"cir:DOI","@value":"10.14923/..."},
 *    {"@type":"cir:HDL","@value":"https://hdl.handle.net/..."}]
 */
function extractDoi(identifier) {
  if (!identifier) return null;

  // 文字列の場合
  if (typeof identifier === "string") {
    return extractDoiFromString(identifier);
  }

  // 配列の場合：@type が cir:DOI のものを優先検索，なければ全要素を順に検査
  if (Array.isArray(identifier)) {
    // まず cir:DOI タイプを探す
    for (var i = 0; i < identifier.length; i++) {
      var elem = identifier[i];
      if (elem && typeof elem === "object" && elem["@type"] === "cir:DOI") {
        var val = elem["@value"] || "";
        if (val) return val;  // cir:DOI の @value は DOI そのもの
      }
    }
    // cir:DOI がなければ全要素からURLパターンで探す
    for (var j = 0; j < identifier.length; j++) {
      var doi = extractDoi(identifier[j]);
      if (doi) return doi;
    }
    return null;
  }

  // オブジェクトの場合
  if (typeof identifier === "object") {
    if (identifier["@type"] === "cir:DOI") {
      return identifier["@value"] || null;
    }
    var objVal = identifier["@value"] || identifier["value"] || identifier["@id"] || "";
    return extractDoiFromString(String(objVal));
  }

  return null;
}

function extractDoiFromString(str) {
  if (!str) return null;
  // doi.org URL からの抽出
  var match = str.match(/(?:doi\.org\/|DOI:\s*)(10\.\S+)/i);
  if (match) return match[1];
  // "10." で始まる裸の DOI
  if (str.match(/^10\.\S+/)) return str;
  return null;
}

// -----------------------------------------------------------
// 8. テストハーネス（GAS エディタから直接実行可能）
// -----------------------------------------------------------

function test_collectOpenAlexField() {
  var results = collectOpenAlexField();
  Logger.log("OpenAlex Field: " + results.length + "件");
  if (results.length > 0) {
    Logger.log("例: " + results[0].title);
  }
}

function test_collectOpenAlexKeyword() {
  var results = collectOpenAlexKeyword();
  Logger.log("OpenAlex Keyword: " + results.length + "件");
  results.slice(0, 3).forEach(function(r) {
    Logger.log("  " + r.title);
  });
}

function test_collectJstage() {
  var results = collectJstage();
  Logger.log("J-STAGE: " + results.length + "件");
}

function test_collectCinii() {
  var results = collectCinii();
  Logger.log("CiNii: " + results.length + "件");
  if (results.length > 0){
    Logger.log(results[0]);
  }

}

function test_collectLingBuzz() {
  var results = collectLingBuzz();
  Logger.log("LingBuzz: " + results.length + "件");
}

function test_collectSemanticScholar() {
  var results = collectSemanticScholar();
  Logger.log("Semantic Scholar: " + results.length + "件");
}

function test_restoreAbstract() {
  // OpenAlex の inverted index 復元テスト
  var testIndex = {
    "This": [0],
    "is": [1],
    "a": [2],
    "test": [3],
    "abstract": [4],
    ".": [5]
  };
  var restored = restoreAbstractFromInvertedIndex(testIndex);
  Logger.log("復元結果: " + restored);
  // 期待: "This is a test abstract ."
}

function test_dailyCollect_dryRun() {
  // 指定した全ソースから収集するが Supabase に書き込まない（ドライラン）
  // 試したいことに合わせてコメントアウトすること．
  var all = [];
  all = all.concat(safeCollect("openalex_field", collectOpenAlexField));
  //all = all.concat(safeCollect("openalex_keyword", collectOpenAlexKeyword));
  // all = all.concat(safeCollect("jstage", collectJstage));
  //all = all.concat(safeCollect("cinii", collectCinii));
  //all = all.concat(safeCollect("lingbuzz", collectLingBuzz));
  //all = all.concat(safeCollect("semantic_scholar", collectSemanticScholar));

  Logger.log("=== ドライラン結果 ===");
  Logger.log("合計: " + all.length + "件");
  all.slice(0, 10).forEach(function(a, i) {
    Logger.log("[" + (i+1) + "] (" + a._source + ") " + a.title);
  });
}