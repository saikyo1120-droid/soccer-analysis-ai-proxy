/**
 * LLM Provider 抽象化レイヤー
 * ----------------------------------------------------------------
 * このファイルが、アプリの他のどこからでも呼ばれる「唯一の入り口」です。
 * server/discuss/ 以下のコードは、実際にどのLLM(Claude / OpenAI / Gemini / ...)を
 * 使っているか一切知りません。将来モデルを乗り換えたいときは、.env(本番はRenderの
 * 環境変数)の LLM_PROVIDER を書き換えるだけで済み、コードの変更は不要です。
 *
 * 新しいプロバイダーを追加したいときは、providers/ に1ファイル追加し、下の
 * PROVIDERS マップに1行足すだけで使えるようになります。呼び出し側のコードには
 * 一切手を入れません。
 */
const PROVIDERS = {
  anthropic: () => require("./providers/anthropic"),
  openai: () => require("./providers/openai"),
  gemini: () => require("./providers/gemini"),
  openrouter: () => require("./providers/openrouter"),
  local: () => require("./providers/local"),
};

function currentProviderName() {
  return String(process.env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt - LLMへの役割・ルール指定(事実の捏造禁止など)
 * @param {string} opts.userPrompt - RAGで取得した事実 + 利用者の質問を組み立てたプロンプト
 * @param {number} [opts.maxTokens] - 応答の最大トークン数(コスト上限のため既定値あり)
 * @returns {Promise<{text: string, provider: string}>}
 */
async function generateLLM({ systemPrompt, userPrompt, maxTokens }) {
  const name = currentProviderName();
  const loader = PROVIDERS[name];
  if (!loader) {
    const err = new Error(`未知のLLM_PROVIDERです: "${name}"(対応済み: ${Object.keys(PROVIDERS).join(", ")})`);
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  const provider = loader();
  const text = await provider.generate({ systemPrompt: systemPrompt || "", userPrompt: userPrompt || "", maxTokens: maxTokens || 700 });
  return { text, provider: name };
}

module.exports = { generateLLM, currentProviderName, PROVIDERS };
