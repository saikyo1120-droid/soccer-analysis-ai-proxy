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

// ---- 2026年8月・精度証明ラウンド⑥: AIモデルの自動切替(コスト最適化) ----
// 「軽い質問は軽量モデル、重い分析だけ高性能モデル」というご指示への対応。
//   ・tier未指定/"light" … 既定の軽量モデル(従来と同じ。バッチ処理・軽い質問)
//   ・tier "heavy"        … 高性能モデル(実データの根拠が揃ったクラブ考察のみ)
// どちらのモデルを使うかの判定は呼び出し側の機械的なルール(server.jsの
// resolveLlmTier)で行い、使ったtier/モデル名は応答のmetaで開示する。
// 環境変数 LLM_TIER_ROUTING=off で全リクエストを既定モデルに戻せる。
function resolveTier(tier) {
  if (String(process.env.LLM_TIER_ROUTING || "on").toLowerCase() === "off") return "light";
  return tier === "heavy" ? "heavy" : "light";
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt - LLMへの役割・ルール指定(事実の捏造禁止など)
 * @param {string} opts.userPrompt - RAGで取得した事実 + 利用者の質問を組み立てたプロンプト
 * @param {number} [opts.maxTokens] - 応答の最大トークン数(コスト上限のため既定値あり)
 * @param {"light"|"heavy"} [opts.tier] - モデルの重さ(未指定=light。従来呼び出しと完全互換)
 * @returns {Promise<{text: string, provider: string, tier: string, model: string|null}>}
 */
async function generateLLM({ systemPrompt, userPrompt, maxTokens, tier, timeoutMs, truncateRetry, timeoutFallbackToLight, timeoutFallbackTimeoutMs, timeoutFallbackMaxTokens }) {
  const name = currentProviderName();
  const loader = PROVIDERS[name];
  if (!loader) {
    const err = new Error(`未知のLLM_PROVIDERです: "${name}"(対応済み: ${Object.keys(PROVIDERS).join(", ")})`);
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  const provider = loader();
  const usedTier = resolveTier(tier);
  // v85: 対話のように「賢い(=重い)モデルだが時間内に完成しないと困る」用途向けに、
  // 呼び出しごとのタイムアウト・尻切れ書き直しの無効化・時間切れ時の軽量モデル
  // 自動切替を、プロバイダーへ透過的に渡す。未指定なら従来と完全に同じ挙動。
  //   timeoutFallbackToLight=true のときだけ、そのプロバイダーの軽量モデルIDを
  //   解決して time-out 時の予備として渡す(モデルIDはプロバイダーが握っており、
  //   server.js からは知らなくてよい設計を維持する)。
  let timeoutFallbackModel = null;
  if (timeoutFallbackToLight && usedTier === "heavy" && typeof provider.resolveModel === "function") {
    const lightModel = provider.resolveModel("light");
    const heavyModel = provider.resolveModel("heavy");
    if (lightModel && lightModel !== heavyModel) timeoutFallbackModel = lightModel;
  }
  const out = await provider.generate({
    systemPrompt: systemPrompt || "", userPrompt: userPrompt || "", maxTokens: maxTokens || 700, tier: usedTier,
    timeoutMs, truncateRetry, timeoutFallbackModel, timeoutFallbackTimeoutMs, timeoutFallbackMaxTokens,
  });
  // v51: プロバイダーは従来どおり文字列を返してもよいし、{text, model, fallbackFrom}を
  // 返してもよい(予備モデルで答えた場合、実際に使ったモデルを正直に開示するため)。
  const isObj = out && typeof out === "object";
  const text = isObj ? out.text : out;
  const model = (isObj && out.model)
    ? out.model
    : (typeof provider.resolveModel === "function" ? provider.resolveModel(usedTier) : null);
  return { text, provider: name, tier: usedTier, model, modelFallbackFrom: (isObj && out.fallbackFrom) || null, truncated: !!(isObj && out.truncated) };
}

module.exports = { generateLLM, currentProviderName, resolveTier, PROVIDERS };
