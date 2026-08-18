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
// ---- 2026年8月18日・v51: モデルID起因の全滅を防ぐ予備モデル ----
// 将来モデルIDが廃止・変更された場合、従来は全ての考察が失敗し続けた
// (利用者には「接続できませんでした」しか出ない)。モデルが見つからない
// エラーのときだけ、確実に存在する予備モデルで1回だけ再試行する。
// どのモデルで答えたかは呼び出し元(llm/index.js経由のmeta)に正直に出る。
const ANTHROPIC_FALLBACK_MODEL = process.env.ANTHROPIC_FALLBACK_MODEL || "claude-haiku-4-5";
// 尻切れ書き直し時の上限の天井(コスト暴走防止。環境変数で変更可能)
const TRUNCATE_RETRY_CAP = parseInt(process.env.ANTHROPIC_TRUNCATE_RETRY_CAP, 10) || 2400;
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

async function callOnce(model, { systemPrompt, userPrompt, maxTokens }) {
  const res = await fetchWithTimeout(ANTHROPIC_API_BASE, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 700,
      system: systemPrompt || "",
      messages: [{ role: "user", content: userPrompt || "" }],
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`Anthropic API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    err.code = "HTTP_ERROR";
    err.httpStatus = res.status;
    err.bodyText = bodyText;
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
  // v51: stop_reason==="max_tokens" は「トークン上限で文章が途中で切れた」印。
  // 本番の実画面で「…むしろ得点・アシストという直結指」のような尻切れが
  // 実際に発生したため、切れたかどうかを必ず呼び出し元へ返す。
  return { text, truncated: json.stop_reason === "max_tokens" };
}

/** 「モデルIDが存在しない/使えない」系のエラーか(=予備モデルで救済できる) */
function isModelNotFoundError(e) {
  if (!e || e.code !== "HTTP_ERROR") return false;
  if (e.httpStatus !== 400 && e.httpStatus !== 404) return false;
  return /model/i.test(String(e.bodyText || ""));
}

async function generate({ systemPrompt, userPrompt, maxTokens, tier }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const requested = resolveModel(tier);
  const runWithModel = async (model, fallbackFrom) => {
    let r = await callOnce(model, { systemPrompt, userPrompt, maxTokens });
    // ---- v51: 尻切れ対策 ----
    // 上限に当たって文章が切れた場合、1回だけ上限を2倍(既定の天井2400)にして
    // 書き直す。それでも切れたら truncated:true を正直に返す(呼び出し元が
    // 利用者に「末尾が省略された」と注記する)。
    if (r.truncated) {
      const retryMax = Math.min(TRUNCATE_RETRY_CAP, Math.max(1200, (maxTokens || 700) * 2));
      console.error(`[anthropic] 応答がトークン上限(${maxTokens || 700})で途切れたため、上限${retryMax}で1回だけ書き直します(model=${model})`);
      try {
        const retry = await callOnce(model, { systemPrompt, userPrompt, maxTokens: retryMax });
        r = retry;
      } catch (e) { /* 書き直しに失敗したら、切れた初回の本文をそのまま使う(無いより正直に多い方) */ }
    }
    return { text: r.text, model, fallbackFrom: fallbackFrom || undefined, truncated: !!r.truncated };
  };
  try {
    return await runWithModel(requested);
  } catch (e) {
    // モデルが見つからない場合だけ、予備モデルで1回だけ再試行する。
    // それ以外(レート制限・キー不正・タイムアウト等)は従来どおり失敗を返す
    // (予備モデルでも同じ理由で失敗するだけなので、費用を二重に使わない)。
    if (isModelNotFoundError(e) && ANTHROPIC_FALLBACK_MODEL && ANTHROPIC_FALLBACK_MODEL !== requested) {
      console.error(`[anthropic] モデル「${requested}」が見つからないため、予備モデル「${ANTHROPIC_FALLBACK_MODEL}」で再試行します:`, e.message);
      return await runWithModel(ANTHROPIC_FALLBACK_MODEL, requested);
    }
    throw e;
  }
}

module.exports = { generate, resolveModel };
