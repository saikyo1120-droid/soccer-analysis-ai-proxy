/**
 * Google Gemini用の LLM Provider ― 現時点では未実装のプレースホルダーです。
 * (未実装の理由は providers/openai.js のコメントと同じです)
 *
 * 実装するときは、providers/anthropic.js と同じ入出力の形
 * generate({systemPrompt, userPrompt, maxTokens}) => Promise<string>
 * を守ったまま、Gemini API
 * (https://ai.google.dev/gemini-api/docs) を呼び出すコードに置き換えてください。
 */
async function generate({ systemPrompt, userPrompt, maxTokens }) {
  const err = new Error("Gemini Providerはまだ実装されていません(LLM_PROVIDER=gemini は現時点で使用できません)");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { generate };
