/**
 * Anthropic Claude 用の LLM Provider 実装。
 * 外部ライブラリ不使用(Node.js標準のfetch)で Anthropic Messages API を直接呼びます。
 * 参考: https://docs.anthropic.com/en/api/messages
 *
 * このプロジェクト唯一の「フル実装された」プロバイダーです(既定値・動作確認済み)。
 * 他のプロバイダー(openai/gemini/openrouter/local)は、この形に合わせて実装すれば
 * すぐに差し替えられるプレースホルダーとして用意してあります。
 */
// 実際に本番で発生した不具合への対処: Renderの環境変数にAPIキーを貼り付ける際、
// 末尾に見えない改行やスペースが紛れ込むことがある(コピー元によっては、コピー
// した文字列の末尾に改行が1つ付いてくる場合がある)。これが混入すると、fetchの
// リクエストヘッダーとして不正な値になり、"Headers.append: ... is an invalid
// header value" という分かりにくいエラーで全リクエストが失敗し続ける
// (APIキー自体は正しいのに、です)。.trim()で前後の空白・改行を必ず取り除く
// ことで、この種の貼り付けミスの影響を受けないようにする。
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
// ---- 2026年8月18日・「AIが賢いと思えない」へのご指示による格上げ ----
// これまでの既定は最小モデル(claude-haiku-4-5・$1/$5 per MTok)だった。
// 会話が賢く感じない主因はここ(モデルの格・文脈の薄さ)だったため、
// 公式ドキュメント(platform.claude.com/docs)で現行IDと価格を確認のうえ更新:
//   既定(全質問):     claude-sonnet-5  … $2/$10 per MTok。旧sonnet-4-5($3/$15)より
//                     賢く、しかも安い。1質問あたり約2円。
//   重い分析(heavy):  claude-opus-5    … $5/$25 per MTok。実データが十分に揃った
//                     深い考察のときだけ。1質問あたり約6〜9円。
// さらに上のclaude-fable-5($10/$50)も存在する。使う場合は
// .env の ANTHROPIC_MODEL_HEAVY=claude-fable-5 で上書きできる(費用は約2倍)。
// 1日の呼び出し上限(MAX_LLM_CALLS_PER_DAY)と1人あたり上限は従来どおり効くので、
// 月額の上限はその設定で制御できる。
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const ANTHROPIC_MODEL_HEAVY = process.env.ANTHROPIC_MODEL_HEAVY || "claude-opus-5";
const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** tier("light"/"heavy")に応じて実際に使うモデルIDを返す(llm/index.jsが開示にも使う) */
function resolveModel(tier) {
  return tier === "heavy" ? ANTHROPIC_MODEL_HEAVY : ANTHROPIC_MODEL;
}

// 2026年8月・本番調査で発見された不具合の修正: fetch()にタイムアウトが無いと、
// Anthropic APIの応答が万一止まった場合に日次学習ジョブ全体がフリーズしてしまう
// (server.jsのfetchWithTimeoutと同じ理由・同じ対策)。LLM生成は他の外部API呼び出し
// より時間がかかることがあるため、少し長めの30秒を上限とする(環境変数で上書き可能。
// 自動テストでは短い値に設定して実際に何秒も待たずに動作検証する)。
const ANTHROPIC_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS, 10) || 30000;
async function fetchWithTimeout(url, options = {}, timeoutMs = ANTHROPIC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error(`Anthropic APIへのリクエストがタイムアウトしました(${timeoutMs}ms)`);
      err.code = "TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function generate({ systemPrompt, userPrompt, maxTokens, tier }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const res = await fetchWithTimeout(ANTHROPIC_API_BASE, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: resolveModel(tier),
      max_tokens: maxTokens || 700,
      system: systemPrompt || "",
      messages: [{ role: "user", content: userPrompt || "" }],
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`Anthropic API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    err.code = "HTTP_ERROR";
    throw err;
  }
  const json = await res.json();
  const block = Array.isArray(json.content) ? json.content.find((b) => b.type === "text") : null;
  const text = block ? block.text : "";
  if (!text) {
    const err = new Error("Anthropic APIから空の応答が返されました");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }
  return text;
}

module.exports = { generate, resolveModel };
