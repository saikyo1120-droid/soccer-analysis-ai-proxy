/**
 * OpenAI用の LLM Provider ― 現時点では未実装のプレースホルダーです。
 *
 * 正直にお伝えします: 「動くふりをする」実装(実機で1度も試していないコードを
 * 動作確認済みであるかのように提供すること)は、このプロジェクトが一貫して
 * 避けてきた姿勢に反するため、ここでは意図的に未実装のままにしています。
 *
 * 実装するときは、providers/anthropic.js と同じ入出力の形
 * generate({systemPrompt, userPrompt, maxTokens}) => Promise<string>
 * を守ったまま、OpenAIのChat Completions API
 * (https://platform.openai.com/docs/api-reference/chat) を呼び出すコードに
 * 置き換えてください。呼び出し側(server/llm/index.js やそれより上位のコード)は
 * 一切変更する必要がありません。
 */
async function generate({ systemPrompt, userPrompt, maxTokens }) {
  const err = new Error("OpenAI Providerはまだ実装されていません(LLM_PROVIDER=openai は現時点で使用できません)");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { generate };
