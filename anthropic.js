/**
 * Anthropic Claude 用の LLM Provider 実装。
 * 外部ライブラリ不使用(Node.js標準のfetch)で Anthropic Messages API を直接呼びます。
 * 参考: https://docs.anthropic.com/en/api/messages
 *
 * このプロジェクト唯一の「フル実装された」プロバイダーです(既定値・動作確認済み)。
 * 他のプロバイダー(openai/gemini/openrouter/local)は、この形に合わせて実装すれば
 * すぐに差し替えられるプレースホルダーとして用意してあります。
 */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
// 既定モデル: コスト最適化の方針(設計書②)に合わせて軽量モデルを既定にしています。
// Anthropicのモデルは時期によって新しいものが追加されるため、最新の推奨モデルIDは
// https://docs.anthropic.com/en/docs/about-claude/models で確認し、必要なら
// .env の ANTHROPIC_MODEL で上書きしてください。
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function generate({ systemPrompt, userPrompt, maxTokens }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const res = await fetch(ANTHROPIC_API_BASE, {
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
