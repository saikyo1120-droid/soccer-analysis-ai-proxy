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
// 既定モデル: コスト最適化の方針(設計書②)に合わせて軽量モデルを既定にしています。
// 2026年8月時点でAnthropic公式ドキュメント(platform.claude.com/docs)を確認し、
// 直接のAnthropic API経由では入手できなくなっていた旧モデル(claude-3-5-haiku-
// 20241022。Bedrock/Google Cloud経由でのみ現在も提供)から、現行の軽量モデル
// claude-haiku-4-5(入力$1/output$5 per MTok)に更新しました。Anthropicのモデルは
// 時期によって新しいものが追加されるため、最新の推奨モデルIDは
// https://platform.claude.com/docs/en/about-claude/models で確認し、必要なら
// .env の ANTHROPIC_MODEL で上書きしてください。
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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

async function generate({ systemPrompt, userPrompt, maxTokens }) {
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
      model: ANTHROPIC_MODEL,
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

module.exports = { generate };
