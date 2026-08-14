// ============================================================
// src/worker.js — Cloudflare Workers: Discord Bot Gateway
// ============================================================
//
//
// 責務:
//   1. Discord からの Interaction リクエストを受信
//   2. Ed25519 署名を検証（セキュリティ必須）
//   3. PING に即時応答（Discord の疎通確認）
//   4. スラッシュコマンドに Deferred Response を即時返却（3秒ルール回避）
//   5. GAS に非同期で処理を転送（ctx.waitUntil）
//
// 環境変数（wrangler.toml or Dashboard で設定）:
//   DISCORD_PUBLIC_KEY  — Discord Application の Public Key
//   GAS_ENDPOINT_URL    — GAS ウェブアプリの URL
//
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // POST 以外は拒否
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- 1. Ed25519 署名検証 ---
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();

    const isValid = await verifySignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // --- 2. PING 応答（Discord が Endpoint URL 登録時に送る疎通確認）---
    if (interaction.type === 1) { // InteractionType.Ping
      return jsonResponse({ type: 1 }); // InteractionResponseType.Pong
    }

    // --- 3. スラッシュコマンドの処理 ---
    if (interaction.type === 2) {
      const token = interaction.token;
      const userId = interaction.member
        ? interaction.member.user.id
        : (interaction.user ? interaction.user.id : null);

      const gasPayload = parseSubcommand(interaction.data, token, userId);

      ctx.waitUntil(forwardToGas(env.GAS_ENDPOINT_URL, gasPayload));

      return jsonResponse({ type: 5 });
    }

    return new Response("Unknown interaction type", { status: 400 });
  }
};

function parseSubcommand(data, token, userId) {
  const top = data.options[0];

  // /paper search, /paper weekly（type 1 = サブコマンド）
  if (top.type === 1) {
    const params = {};
    (top.options || []).forEach(opt => { params[opt.name] = opt.value; });

    if (top.name === "search") {
      return {
        command: "search",
        param: params.theme || null,
        mode: params.mode || "added",
        token, userId
      };
    }
    if (top.name === "weekly") {
      return {
        command: "weekly",
        param: params.topic || null,
        mode: params.mode || "added",
        token, userId
      };
    }
  }

  // /paper topic add, /paper topic list（type 2 = サブコマンドグループ）
  if (top.type === 2 && top.name === "topic") {
    const sub = top.options[0];
    const params = {};
    (sub.options || []).forEach(opt => { params[opt.name] = opt.value; });

    if (sub.name === "add") {
      return { command: "add_topic", param: params.keyword || null, token, userId };
    }
    if (sub.name === "list") {
      return { command: "list_topics", param: null, token, userId };
    }
  }

  return { command: "unknown", param: null, token, userId };
}


// -----------------------------------------------------------
// コマンド → GAS ペイロード変換
// -----------------------------------------------------------

function buildGasPayload(commandName, params, token, userId) {
  switch (commandName) {
    case "search":
      return {
        command: "search",
        param: params.theme || params.keyword || null,
        mode: params.mode || "added",
        token: token,
        userId: userId
      };

    case "weekly":
      return {
        command: "weekly",
        param: params.topic || null,
        mode: params.mode || "added",
        token: token,
        userId: userId
      };

    case "add_topic":
      return {
        command: "add_topic",
        param: params.keyword || null,
        token: token,
        userId: userId
      };

    case "remove_topic":
      return {
        command: "remove_topic",
        param: params.keyword || null,
        token: token,
        userId: userId
      };

    case "list_topics":
      return {
        command: "list_topics",
        param: null,
        token: token,
        userId: userId
      };

    default:
      return {
        command: commandName,
        param: null,
        token: token,
        userId: userId
      };
  }
}

// -----------------------------------------------------------
// GAS への非同期転送
// -----------------------------------------------------------

async function forwardToGas(gasUrl, payload) {
  try {
    await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("GAS 転送エラー:", error);
  }
}

// -----------------------------------------------------------
// Ed25519 署名検証（Web Crypto API 使用）
// -----------------------------------------------------------

async function verifySignature(body, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(publicKey),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"]
    );

    const message = new TextEncoder().encode(timestamp + body);
    const sig = hexToUint8Array(signature);

    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch (error) {
    console.error("署名検証エラー:", error);
    return false;
  }
}

function hexToUint8Array(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
}

// -----------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
