/**
 * ローカルLLM(Ollama等、自分のPC/サーバー上で動かすモデル)用の LLM Provider ―
 * 現時点では未実装のプレースホルダーです。(未実装の理由は providers/openai.js のコメントと同じです)
 *
 * 実装するときは、providers/anthropic.js と同じ入出力の形
 * generate({systemPrompt, userPrompt, maxTokens}) => Promise<string>
 * を守ったまま、ローカルLLMサーバー(例: Ollamaの http://localhost:11434/api/chat)を
 * 呼び出すコードに置き換えてください。LOCAL_LLM_BASE_URL のような環境変数で
 * 接続先を指定できるようにしておくと、環境が変わっても設定変更だけで対応できます。
 */
async function generate({ systemPrompt, userPrompt, maxTokens }) {
  const err = new Error("Local LLM Providerはまだ実装されていません(LLM_PROVIDER=local は現時点で使用できません)");
  err.code = "NOT_IMPLEMENTED";
  throw err;
}

module.exports = { generate };
