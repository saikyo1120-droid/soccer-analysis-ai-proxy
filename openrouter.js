/**
 * OpenRouter(複数モデルへの中継サービス)用の LLM Provider ― 現時点では
 * 未実装のプレースホルダーです。(未実装の理由は providers/openai.js のコメントと同じです)
 *
 * 実装するときは、providers/anthropic.js と同じ入出力の形
 * generate({systemPrompt, userPrompt, maxTokens}) => Promise<string>
 * を守ったまま、OpenRouter API
 * (https://openrouter.ai/docs) を呼び出すコードに置き換えてください。
 */
async function generate({ systemPrompt, userPrompt, maxTokens }) {
  const err = new Error("OpenRouter Providerはまだ実装されていません(LLM_PROVIDER=openrouter は現時点で使用できません)");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { generate };
