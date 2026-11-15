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
//   (当時の既定) 全質問:  claude-sonnet-5 … $2/$10 per MTok。旧sonnet-4-5($3/$15)より賢く、しかも安い。
//   (当時の既定) heavy:   claude-opus-5   … $5/$25 per MTok。実データが十分に揃った深い考察のときだけ。
// 1日の呼び出し上限(MAX_LLM_CALLS_PER_DAY)と1人あたり上限は従来どおり効くので、
// 月額の上限はその設定で制御できる。
// ---- v104.2(2026年11月15日・利用者の決定「同じ料金で新しい版に」) ----
//   公式ドキュメント(platform.claude.com/docs/en/models/overview)で現行IDと価格を確認:
//     既定(全質問):    claude-sonnet-5-5 … $2/$10 per MTok(Sonnet 5 と同額)
//     重い分析(heavy): claude-opus-5-5   … $4/$20 per MTok(Opus 5 の $5/$25 より安い)
//   5.5 世代は「IDの差し替えだけ」では済まない(公式の移行手順より):
//     ・答える前に考える処理(adaptive thinking)が常に入り、その分も max_tokens に数えられる
//       → 下の maxTokensWithThinking() で「考える分の余裕」を上乗せする
//     ・応答の先頭に thinking ブロック(中身は空・署名つき)が付くことがあり、道具の往復では
//       それを**そのまま**次の要求へ返す必要がある → generateMessages() が rawContent を返す
//     ・会話の途中で system / tools を変えると拒まれることがある → discuss/toolLoop.js 側で対応
//     ・安全のための分類器が回答を見送ることがある(HTTP 200・stop_reason="refusal")
//       → 見送り用の戻り先(REFUSAL_FALLBACK_MODEL)で1回だけ答え直し、1件ずつ記録する
//     ・考える深さ(effort)の目盛りが Sonnet 5 と違う → 既定は API のまま。環境変数で調整できるようにする
//   新しい版が使えない(IDが無い・要求を受け付けない)ときは、その場で1つ前の版へ戻して必ず答える
//   (PREVIOUS_GENERATION)。どの版で答えたかは model / fallbackFrom で正直に開示する。
//   考えた分を含む実際の出力量は、応答の usage(実測値)を数えて /api/diag/llm で開示する。
//   ANTHROPIC_MODEL / ANTHROPIC_MODEL_HEAVY を設定すれば、従来どおりその値が最優先。
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const ANTHROPIC_MODEL_HEAVY = process.env.ANTHROPIC_MODEL_HEAVY || "claude-opus-5-5";
/** 新しい版 → 1つ前の版(v104.1 まで本番で動いていた版)。ANTHROPIC_PREVIOUS_FALLBACK=off で無効化できる */
const PREVIOUS_GENERATION = { "claude-sonnet-5-5": "claude-sonnet-5", "claude-opus-5-5": "claude-opus-5" };
const PREVIOUS_FALLBACK_ENABLED = String(process.env.ANTHROPIC_PREVIOUS_FALLBACK || "on").trim().toLowerCase() !== "off";
// ---- 2026年8月18日・v51: モデルID起因の全滅を防ぐ予備モデル ----
// 将来モデルIDが廃止・変更された場合、従来は全ての考察が失敗し続けた
// (利用者には「接続できませんでした」しか出ない)。モデルが見つからない
// エラーのときだけ、確実に存在する予備モデルで1回だけ再試行する。
// どのモデルで答えたかは呼び出し元(llm/index.js経由のmeta)に正直に出る。
const ANTHROPIC_FALLBACK_MODEL = process.env.ANTHROPIC_FALLBACK_MODEL || "claude-haiku-4-5";
// 尻切れ書き直し時の上限の天井(コスト暴走防止。環境変数で変更可能)
const TRUNCATE_RETRY_CAP = parseInt(process.env.ANTHROPIC_TRUNCATE_RETRY_CAP, 10) || 2400;
// v85: テスト時だけモックサーバーへ向けられるよう環境変数で上書き可能にする
// (本番・通常起動では未設定=従来どおり公式エンドポイント。挙動の変化なし)
const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** tier("light"/"heavy")に応じて実際に使うモデルIDを返す(llm/index.jsが開示にも使う) */
function resolveModel(tier) {
  return tier === "heavy" ? ANTHROPIC_MODEL_HEAVY : ANTHROPIC_MODEL;
}

function envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/* ============================================================================
 * v104.2: 考える分の余裕(thinking headroom)
 * ----------------------------------------------------------------------------
 * 5 世代以降の Claude は、答える前に考える処理が既定で入り、その分も max_tokens に
 * 数えられる(公式: "max_tokens covers thinking plus text")。呼び出し側の maxTokens は
 * 「本文の長さ」のつもりで決めてあるので(毎日の学習の一言は 260、会話は 700〜1400)、
 * そのまま送ると、考えただけで上限に達して本文が空(EMPTY_RESPONSE)や尻切れになる。
 *   → API へ送る max_tokens = 本文の上限 + 余裕(本文の上限の2倍。下限600・上限は下の値)
 *   → それでも考える処理だけで使い切ったとき(本文が空で stop_reason=max_tokens)は、
 *     余裕をさらに足して1回だけやり直す
 * 余裕は「使ってよい上限」であって、使わなかった分に料金はかからない(料金は実際に出力した
 * トークンぶん。考えた分は出力として数えられる)。4.x 系など既定で考えないモデルには足さない。
 * 環境変数: ANTHROPIC_THINKING_HEADROOM(既定2000)/ ANTHROPIC_THINKING_HEADROOM_HEAVY(既定3000)
 *           / ANTHROPIC_THINKING_HEADROOM_MIN(下限。既定600)/ ANTHROPIC_THINKING_RETRY_BOOST(既定4000)。
 *           上限(HEADROOM)や RETRY_BOOST を 0 にすると、その仕組みは無効。
 * 余裕が足りているかは、下の「実測の使用量」(/api/diag/llm の usage)で本番から確かめられる
 * (上限に達した応答の数 hitMaxTokens・1回の出力の最大 maxOutputTokens)。
 * ========================================================================== */
const THINKING_HEADROOM_LIGHT = envInt("ANTHROPIC_THINKING_HEADROOM", 2000);
const THINKING_HEADROOM_HEAVY = envInt("ANTHROPIC_THINKING_HEADROOM_HEAVY", 3000);
const THINKING_HEADROOM_MIN = envInt("ANTHROPIC_THINKING_HEADROOM_MIN", 600);
const THINKING_EXHAUSTED_BOOST = envInt("ANTHROPIC_THINKING_RETRY_BOOST", 4000);

/** 答える前に考える処理が既定で入るモデルか(5 世代以降。4.x 系は既定でオフ)。日付つきの ID(…-5-5-20261101 など)も同じ扱い */
function thinksByDefault(model) {
  return /^claude-(?:sonnet|opus|haiku|fable|mythos)-5(?:-\d+)*$/.test(String(model || ""));
}
function thinkingHeadroomFor(model, requested) {
  if (!thinksByDefault(model)) return 0;
  const cap = /-(?:opus|fable|mythos)-/.test(String(model)) ? THINKING_HEADROOM_HEAVY : THINKING_HEADROOM_LIGHT;
  if (cap <= 0) return 0;
  return Math.min(cap, Math.max(THINKING_HEADROOM_MIN, (requested || 700) * 2));
}
/** API へ送る max_tokens(本文の上限 + 考える分の余裕 + やり直し時の上乗せ) */
function maxTokensWithThinking(model, requested, boost) {
  const base = requested || 700;
  return base + thinkingHeadroomFor(model, base) + (boost || 0);
}
/** 考える処理だけで上限を使い切り、本文が1文字も出なかった失敗か */
function isThinkingExhausted(e, model) {
  return !!e && e.code === "EMPTY_RESPONSE" && e.stopReason === "max_tokens" && thinksByDefault(model) && THINKING_EXHAUSTED_BOOST > 0;
}

/* ============================================================================
 * v104.2: 考える深さ(effort)の任意設定 — 既定では何も送らない(= API の既定のまま)
 * ----------------------------------------------------------------------------
 * 公式(platform.claude.com/docs/en/build-with-claude/effort): 5 世代のモデルは output_config.effort で
 * 「どれだけ考えるか」を選べる。既定は Sonnet 5.5 が high、Opus 5.5 が medium(Opus 5 は high)。
 * 5.5 世代は目盛りの付け方が Sonnet 5 と違う("calibrated differently")ため、同じ既定でも考える量と
 * 待ち時間が Sonnet 5 と同じとは限らない。本物の API での量は配備後の実測でしか分からないので、
 * **コードを変えずに環境変数だけで調整できる**ようにしておく(未設定なら従来どおり何も送らない)。
 *   ANTHROPIC_EFFORT        … 軽量モデル(全質問・毎日の学習)用。low / medium / high
 *   ANTHROPIC_EFFORT_HEAVY  … 上位モデル(重い分析)用。low / medium / high
 *   ・xhigh / max は受け付けない(公式: その2つは大きな max_tokens が前提で、Opus 5.5 の移行手順は 64k から
 *     始めるよう案内している。本アプリの上限とは合わない)
 *   ・使えない値は無視して既定のまま動く(設定の打ち間違いで会話が全部止まらないように)
 *   ・4.x 系など effort に対応しないモデルへは送らない
 *   ・万一 API が指定を受け付けなかった(400)ら、指定なしで1回だけ送り直し、以後そのモデルには送らない
 * ========================================================================== */
const EFFORT_LEVELS = ["low", "medium", "high"];
function parseEffortLevel(raw) {
  const v = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!v) return { value: null, ignored: null };
  if (EFFORT_LEVELS.includes(v)) return { value: v, ignored: null };
  return { value: null, ignored: v.slice(0, 20) };
}
const effortConfig = { light: parseEffortLevel(process.env.ANTHROPIC_EFFORT), heavy: parseEffortLevel(process.env.ANTHROPIC_EFFORT_HEAVY) };
if (effortConfig.light.ignored) console.error(`[anthropic] ANTHROPIC_EFFORT="${effortConfig.light.ignored}" は使えない値のため無視します(使える値: ${EFFORT_LEVELS.join(" / ")})`);
if (effortConfig.heavy.ignored) console.error(`[anthropic] ANTHROPIC_EFFORT_HEAVY="${effortConfig.heavy.ignored}" は使えない値のため無視します(使える値: ${EFFORT_LEVELS.join(" / ")})`);
const effortRejectedBy = new Map(); // model -> { at, effort, detail }(API が指定を受け付けなかったモデル)

/** このモデルへ送る effort(送らないときは null) */
function effortFor(model) {
  if (!thinksByDefault(model) || effortRejectedBy.has(model)) return null;
  const isLight = model === ANTHROPIC_MODEL || model === PREVIOUS_GENERATION[ANTHROPIC_MODEL];
  const isHeavy = !isLight && (model === ANTHROPIC_MODEL_HEAVY || model === PREVIOUS_GENERATION[ANTHROPIC_MODEL_HEAVY]);
  return (isHeavy ? effortConfig.heavy.value : effortConfig.light.value) || null;
}
function isEffortRejectedError(e) {
  return !!e && e.code === "HTTP_ERROR" && e.httpStatus === 400 && /effort|output_config/i.test(String(e.bodyText || ""));
}
/** send(effort) を実行する。effort の指定だけが原因で断られたら、指定なしで1回だけ送り直す */
async function sendWithEffort(model, send) {
  const effort = effortFor(model);
  if (!effort) return send(null);
  try {
    return await send(effort);
  } catch (e) {
    if (!isEffortRejectedError(e)) throw e;
    effortRejectedBy.set(model, { at: new Date().toISOString(), effort, detail: String(e.message || "").slice(0, 200) });
    console.error(`[anthropic] モデル「${model}」が考える深さの指定(effort=${effort})を受け付けなかったため、指定なしで送り直します(以後このモデルには指定しません)`);
    return send(null);
  }
}

/* ============================================================================
 * v104.2: 新しい版が使えないときに「1つ前の版」へ戻る仕組み
 * ----------------------------------------------------------------------------
 *   ・新しい版(5.5)が要求を受け付けなかった(HTTP 400/403/404)か、混雑で断った(529)とき、
 *     同じ要求を1つ前の版(v104.1 まで本番で動いていた版)へ1回だけ送り直す
 *   ・ID が見つからない(404)と分かったら30分、要求の拒否が3回続いたら15分、最初から
 *     1つ前の版を使う(毎回の失敗ぶんの待ち時間を利用者に払わせない)。時間が来たら自動で新しい版を試す
 *   ・1つ前の版でも同じ失敗になるものは、版のせいではない(要求そのもの・残高など)ので数えない
 *   ・レート制限(429)・認証(401)・残高不足・時間切れは、版を変えても同じなので送り直さない(従来どおり)
 *   ・最後の砦: どの版も「ID が見つからない」ときだけ、従来の予備モデルで1回試す(v51 の挙動を維持)
 *   どの版で答えたかは返り値の model / fallbackFrom / fallbackReason に必ず残す。
 * ========================================================================== */
const MODEL_NOT_FOUND_COOLDOWN_MS = 30 * 60 * 1000;
const MODEL_REJECT_COOLDOWN_MS = 15 * 60 * 1000;
const MODEL_REJECT_STREAK_FOR_COOLDOWN = 3;
const modelHealth = new Map(); // model -> { rejectStreak, unavailableUntil, lastReason, lastAt }
const stats = { primaryOk: 0, previousUsed: 0, lastResortUsed: 0, thinkingExhaustedRetries: 0, lastFallbacks: [], refusals: 0, refusalsAnswered: 0, lastRefusals: [] };

/* ============================================================================
 * v104.2: 回答の見送り(stop_reason: "refusal")への対応
 * ----------------------------------------------------------------------------
 * 公式(platform.claude.com/docs/en/build-with-claude/refusals-and-fallback): Sonnet 5.5 / Opus 5.5 などは、
 * 安全のための分類器が要求を止めることがある。そのときの応答は **HTTP 200** で stop_reason が "refusal"、
 * content は空(出力の途中で止まった場合は途中までの出力つき)、stop_details に分類(category)が入る。
 * サッカーの質問で起きることはまず無いはずだが、公式に「分類 general_harms は無害な内容でも起きうる」
 * 「すべての要求経路に戻り先を用意し、refusal は1件ずつ記録する(HTTP 200 なのでエラー率では気づけない)」
 * 「同じモデルへ送り直しても、たいてい同じ結果になる」とある。そこで:
 *   ・refusal は category ではなく stop_reason で判定する(category は null のことがある)
 *   ・途中までの出力は未完成として捨てる(公式の指示)
 *   ・同じ要求を戻り先のモデル(既定: claude-sonnet-5。この分類器を持たない、v104.1 まで本番で動いていた版)
 *     へ1回だけ送り直す。答えたモデルは model / fallbackFrom / fallbackReason("refusal")で開示する
 *   ・送り直さない場合: 分類が reasoning_extraction(公式: 送り直しではなく文面を直す)/
 *     流れる表示で本文の断片を既に画面へ流したあと(呼び出し側が画面を消してからやり直す)/
 *     戻り先のモデル自身が見送ったとき / ANTHROPIC_REFUSAL_FALLBACK=off
 *   ・送り直さなかった・戻り先も見送ったときは、従来の「空の応答」と同じ扱いのエラー
 *     (code=EMPTY_RESPONSE・stopReason="refusal")を投げる(呼び出し側の既存の処理がそのまま働く)
 *   ・モデルを休ませる回数には数えない(版が使えないのではなく、その要求の内容の問題だから)
 * ========================================================================== */
const REFUSAL_FALLBACK_MODEL = String(process.env.ANTHROPIC_REFUSAL_FALLBACK_MODEL || "claude-sonnet-5").trim();
const REFUSAL_FALLBACK_ENABLED = String(process.env.ANTHROPIC_REFUSAL_FALLBACK || "on").trim().toLowerCase() !== "off";

function makeRefusalError(stopDetails, model, partialStreamed) {
  const d = (stopDetails && typeof stopDetails === "object") ? stopDetails : {};
  const category = typeof d.category === "string" && d.category ? d.category.slice(0, 40) : null;
  const err = new Error(`Anthropic APIが回答を見送りました(stop_reason=refusal, category=${category || "不明"}, model=${model}${partialStreamed ? ", 途中まで出力あり" : ""})`);
  err.code = "EMPTY_RESPONSE";
  err.stopReason = "refusal";
  err.refusal = { category, explanation: typeof d.explanation === "string" ? d.explanation.slice(0, 200) : null };
  if (partialStreamed) err.partialStreamed = true;
  return err;
}
function isRefusalError(e) {
  return !!e && e.code === "EMPTY_RESPONSE" && e.stopReason === "refusal" && !!e.refusal;
}
function pushRefusalLog(entry) {
  stats.lastRefusals.push(entry);
  while (stats.lastRefusals.length > 8) stats.lastRefusals.shift();
}

function previousModelOf(model) {
  return PREVIOUS_FALLBACK_ENABLED ? (PREVIOUS_GENERATION[model] || null) : null;
}
/** 「モデルIDが存在しない/使えない」系のエラーか(=予備モデルで救済できる) */
function isModelNotFoundError(e) {
  if (!e || e.code !== "HTTP_ERROR") return false;
  if (e.httpStatus !== 400 && e.httpStatus !== 404) return false;
  return /model/i.test(String(e.bodyText || ""));
}
/** 版を変えれば通る可能性がある失敗か(要求の拒否・ID 不明・権限・混雑)。残高不足は版を変えても同じなので除く */
function isRejectedByModelError(e) {
  if (!e || e.code !== "HTTP_ERROR") return false;
  if (![400, 403, 404, 529].includes(e.httpStatus)) return false;
  return !/credit balance|billing/i.test(String(e.bodyText || ""));
}
function describeRejection(e) {
  if (!e) return "unknown";
  if (isModelNotFoundError(e) && e.httpStatus === 404) return "model_not_found";
  return `http_${e.httpStatus || "error"}`;
}
function noteModelOk(model) {
  const h = modelHealth.get(model);
  if (h) { h.rejectStreak = 0; h.unavailableUntil = 0; }
}
function noteModelRejected(model, e) {
  const h = modelHealth.get(model) || { rejectStreak: 0, unavailableUntil: 0, lastReason: null, lastAt: null };
  h.lastReason = describeRejection(e);
  h.lastAt = Date.now();
  if (e && e.httpStatus === 529) { modelHealth.set(model, h); return; } // 混雑は一時的。次の質問ではまた新しい版から試す
  if (isModelNotFoundError(e) && e.httpStatus === 404) {
    h.unavailableUntil = Date.now() + MODEL_NOT_FOUND_COOLDOWN_MS; h.rejectStreak = 0;
  } else {
    h.rejectStreak = (h.rejectStreak || 0) + 1;
    if (h.rejectStreak >= MODEL_REJECT_STREAK_FOR_COOLDOWN) { h.unavailableUntil = Date.now() + MODEL_REJECT_COOLDOWN_MS; h.rejectStreak = 0; }
  }
  modelHealth.set(model, h);
}
/** いま実際に最初に試すモデル(休ませている新しい版は飛ばして、1つ前の版から始める) */
function pickModel(requested) {
  const h = modelHealth.get(requested);
  const prev = previousModelOf(requested);
  if (prev && h && h.unavailableUntil > Date.now()) return { model: prev, skippedFrom: requested, skipReason: h.lastReason || "cooldown" };
  return { model: requested, skippedFrom: null, skipReason: null };
}
function pushFallbackLog(entry) {
  stats.lastFallbacks.push(entry);
  while (stats.lastFallbacks.length > 8) stats.lastFallbacks.shift();
}
/**
 * 回答を見送られた要求を、戻り先のモデルへ1回だけ送り直す(送り直せない条件は上の説明のとおり)。
 * 答えられたらその結果を返し、答えられなければ最初の見送りのエラーを投げる。1件ずつ必ず記録する。
 */
async function answerRefusalOnFallback(requested, refusedModel, e, attempt) {
  const category = (e.refusal && e.refusal.category) || null;
  const entry = {
    at: new Date().toISOString(), model: refusedModel, category,
    explanation: (e.refusal && e.refusal.explanation) || null,
    partialOutput: !!e.partialStreamed, answeredBy: null, note: null,
  };
  stats.refusals++;
  pushRefusalLog(entry);
  const target = REFUSAL_FALLBACK_MODEL;
  let whyNot = null;
  if (!REFUSAL_FALLBACK_ENABLED || !target) whyNot = "fallback_off";
  else if (target === refusedModel) whyNot = "fallback_model_itself_refused";
  else if (category === "reasoning_extraction") whyNot = "category_not_retryable";
  else if (e.partialStreamed) whyNot = "partial_text_already_shown";
  if (whyNot) {
    entry.note = whyNot;
    console.error(`[anthropic] モデル「${refusedModel}」が回答を見送りました(refusal・category=${category || "不明"})。別のモデルでは送り直しません(${whyNot})`);
    throw e;
  }
  console.error(`[anthropic] モデル「${refusedModel}」が回答を見送ったため(refusal・category=${category || "不明"})、「${target}」で答え直します`);
  let out;
  try {
    out = await attempt(target);
  } catch (e2) {
    entry.note = `fallback_failed:${(e2 && (e2.stopReason === "refusal" ? "refusal" : (e2.code || e2.httpStatus))) || "error"}`;
    if (e && typeof e === "object") e.refusalFallbackError = String((e2 && e2.message) || e2 || "").slice(0, 200);
    throw e;
  }
  stats.refusalsAnswered++;
  entry.answeredBy = target;
  pushFallbackLog({ at: entry.at, from: requested, to: target, reason: "refusal", detail: category });
  if (out && typeof out === "object") { out.fallbackFrom = requested; out.fallbackReason = "refusal"; }
  return out;
}

/**
 * attempt(model) を「求められた版 → 1つ前の版 →(ID 不明のときだけ)予備」の順に試す。
 * 成功した結果(オブジェクト)に、別の版で答えたときだけ fallbackFrom / fallbackReason を付けて返す。
 * 回答の見送り(refusal)は、版の順番とは別に、見送り用の戻り先へ1回だけ送り直す。
 */
async function runWithModelFallback(requested, attempt) {
  const pick = pickModel(requested);
  const chain = [pick.model];
  const prev = previousModelOf(pick.model);
  if (prev && prev !== pick.model) chain.push(prev);
  let lastErr = null;
  let firstErr = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const out = await attempt(model);
      if (model === requested) {
        stats.primaryOk++;
        noteModelOk(model);
      } else {
        const reason = pick.skippedFrom ? `cooldown:${pick.skipReason}` : describeRejection(firstErr);
        if (!pick.skippedFrom && firstErr) noteModelRejected(requested, firstErr); // 新しい版だけが断った(=版に固有)と確定したので数える
        stats.previousUsed++;
        pushFallbackLog({ at: new Date().toISOString(), from: requested, to: model, reason, detail: firstErr ? String(firstErr.message || "").slice(0, 200) : null });
        if (out && typeof out === "object") { out.fallbackFrom = requested; out.fallbackReason = reason; }
      }
      return out;
    } catch (e) {
      // 回答の見送り(HTTP 200 の refusal)は、版の不具合ではなく要求の内容への判定。見送り用の戻り先で1回だけ答え直す
      if (isRefusalError(e)) return await answerRefusalOnFallback(requested, model, e, attempt);
      lastErr = e;
      if (!firstErr) firstErr = e;
      if (!(i + 1 < chain.length && isRejectedByModelError(e))) break;
      console.error(`[anthropic] モデル「${model}」が要求を受け付けなかったため(HTTP ${e.httpStatus})、1つ前の版「${chain[i + 1]}」で答え直します:`, String(e.message || "").slice(0, 200));
    }
  }
  // 最後の砦(v51): どの版も ID が見つからないときだけ、予備モデルで1回だけ再試行する。
  // (レート制限・キー不正等は予備モデルでも同じ理由で失敗するだけなので再試行しない)
  if (isModelNotFoundError(lastErr) && ANTHROPIC_FALLBACK_MODEL && !chain.includes(ANTHROPIC_FALLBACK_MODEL)) {
    console.error(`[anthropic] モデル「${chain[chain.length - 1]}」が見つからないため、予備モデル「${ANTHROPIC_FALLBACK_MODEL}」で再試行します:`, lastErr.message);
    const out = await attempt(ANTHROPIC_FALLBACK_MODEL);
    stats.lastResortUsed++;
    pushFallbackLog({ at: new Date().toISOString(), from: requested, to: ANTHROPIC_FALLBACK_MODEL, reason: "model_not_found", detail: String(lastErr.message || "").slice(0, 200) });
    if (out && typeof out === "object") { out.fallbackFrom = requested; out.fallbackReason = "model_not_found"; }
    return out;
  }
  if (lastErr && firstErr && lastErr !== firstErr && typeof lastErr === "object") {
    // 1つ前の版でも失敗した。原因の調査には最初(新しい版)のエラー文が要るので添える(鍵は throwHttpError で除去済み)
    lastErr.primaryModelError = String(firstErr.message || "").slice(0, 300);
  }
  throw lastErr;
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

/** 実測の利用トークン(あれば)を、診断用の小さな形にする */
function usageOf(json) {
  const u = json && json.usage;
  if (!u || typeof u !== "object") return null;
  return { input: Number.isFinite(u.input_tokens) ? u.input_tokens : null, output: Number.isFinite(u.output_tokens) ? u.output_tokens : null };
}

/* ----------------------------------------------------------------------------
 * v104.2: 実測の使用量(このプロセスの起動後・モデルごと)。/api/diag/llm で開示する
 *   5.5 世代は「考えた分」も出力トークンに数えられ、その量は本物の API でしか分からない。
 *   推測で語らないために、応答に付いてくる usage(実測値)だけを数えておく:
 *     calls … 応答を受け取った回数 / inputTokens・outputTokens … 合計(出力には考えた分を含む)
 *     maxOutputTokens … 1回の出力の最大 / hitMaxTokens … 上限(max_tokens)に達した応答の数
 *     refusals … 回答を見送った応答の数
 *   質問文・回答文・鍵は含めない(数だけ)。
 * -------------------------------------------------------------------------- */
const PROCESS_STARTED_AT = new Date().toISOString();
const usageByModel = new Map();
function noteUsage(model, usage, stopReason) {
  const u = usageByModel.get(model) || { calls: 0, withUsage: 0, inputTokens: 0, outputTokens: 0, maxOutputTokens: 0, hitMaxTokens: 0, refusals: 0 };
  u.calls++;
  const inTok = usage && (Number.isFinite(usage.input_tokens) ? usage.input_tokens : (Number.isFinite(usage.input) ? usage.input : null));
  const outTok = usage && (Number.isFinite(usage.output_tokens) ? usage.output_tokens : (Number.isFinite(usage.output) ? usage.output : null));
  if (Number.isFinite(inTok) || Number.isFinite(outTok)) u.withUsage++;
  if (Number.isFinite(inTok)) u.inputTokens += inTok;
  if (Number.isFinite(outTok)) { u.outputTokens += outTok; if (outTok > u.maxOutputTokens) u.maxOutputTokens = outTok; }
  if (stopReason === "max_tokens") u.hitMaxTokens++;
  if (stopReason === "refusal") u.refusals++;
  usageByModel.set(model, u);
}

async function callOnce(model, { systemPrompt, userPrompt, maxTokens, timeoutMs, boost }) {
  const json = await sendWithEffort(model, async (effort) => {
    const body = {
      model,
      max_tokens: maxTokensWithThinking(model, maxTokens, boost),
      system: systemPrompt || "",
      messages: [{ role: "user", content: userPrompt || "" }],
    };
    if (effort) body.output_config = { effort }; // v104.2: 環境変数で指定されたときだけ(既定では送らない)
    const res = await fetchWithTimeout(ANTHROPIC_API_BASE, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }, timeoutMs || ANTHROPIC_TIMEOUT_MS);
    // v97(全体監査・防御的措置): 応答本文に万一キー文字列が含まれても、エラー文(ログ・
    //   診断JSONへ流れる)に残さない(throwHttpError が除去する)。
    if (!res.ok) await throwHttpError(res);
    const parsed = await res.json();
    return (parsed && typeof parsed === "object") ? parsed : {}; // 本文が JSON の null などでも、下の「空の応答」として扱う
  });
  noteUsage(model, json.usage, json.stop_reason);
  // v104.2: 回答の見送り(HTTP 200・stop_reason="refusal")。途中までの出力があっても未完成として捨てる(公式の指示)
  if (json.stop_reason === "refusal") throw makeRefusalError(json.stop_details, model, false);
  // v104.2: 5 世代以降は先頭に thinking ブロックが付くことがある。本文は type で選び、
  //   複数の text ブロックに分かれていても全部つなぐ(先頭の1つだけを読むと欠ける)。
  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  if (!text) {
    // v98.1: 本番で毎日数クラブに起きている EMPTY_RESPONSE の原因が追えるよう、
    //   停止理由(stop_reason)と返ってきたブロックの種類をエラー文に残す(本文・鍵は含めない)。
    const types = Array.isArray(json.content) ? json.content.map((b) => b && b.type).filter(Boolean).join(",") : "none";
    const err = new Error(`Anthropic APIから空の応答が返されました(stop_reason=${json.stop_reason || "?"}, blocks=${types || "empty"})`);
    err.code = "EMPTY_RESPONSE";
    err.stopReason = json.stop_reason || null;
    throw err;
  }
  // v51: stop_reason==="max_tokens" は「トークン上限で文章が途中で切れた」印。
  // 本番の実画面で「…むしろ得点・アシストという直結指」のような尻切れが
  // 実際に発生したため、切れたかどうかを必ず呼び出し元へ返す。
  return { text, truncated: json.stop_reason === "max_tokens", stopReason: json.stop_reason || null, usage: usageOf(json) };
}

// ---- v85(2026年9月8日・本番実測での特定「チャットの深い考察だけ毎回失敗」への対応) ----
//   原因: 8/18にモデルを格上げ(heavy=claude-opus-5・回答1400トークン)した際、
//   タイムアウト(30秒)を据え置いた。高性能モデルの長い回答は生成に40〜70秒
//   かかるため、完成する前に打ち切られ、重い考察がほぼ毎回TIMEOUTになっていた
//   (軽量モデル・短い回答のマッチ分析は同時刻の本番で成功=キー・残高は正常と実測)。
//   対応: ①呼び出しごとにtimeoutMsを指定可能に ②それでも時間切れの場合、
//   呼び出し元が指定した高速モデルへ1回だけ自動で切り替えて必ず答えを返す
//   (使ったモデルはfallbackFromで正直に開示) ③対話用途では尻切れ書き直しを
//   無効化できる(truncateRetry:false。書き直しで待ち時間が2倍になるのを防ぐ。
//   切れた場合はtruncated:trueで正直に注記される)。
//   既定値はすべて従来どおり(timeoutMs=30秒・truncateRetry=有効・fallback無し)。
async function generate({ systemPrompt, userPrompt, maxTokens, tier, timeoutMs, truncateRetry, timeoutFallbackModel, timeoutFallbackTimeoutMs, timeoutFallbackMaxTokens }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const requested = resolveModel(tier);
  const runWithModel = async (model, callTimeoutMs, callMaxTokens) => {
    const useMax = callMaxTokens || maxTokens;
    const call = (mt, boost) => callOnce(model, { systemPrompt, userPrompt, maxTokens: mt, timeoutMs: callTimeoutMs, boost });
    let r;
    try {
      r = await call(useMax);
    } catch (e) {
      // v104.2: 考える処理だけで上限を使い切って本文が空だったときは、同じ上限でやり直しても
      //   同じ結果になる。余裕を足して1回だけやり直す(それでも空なら、そのエラーを投げる)。
      if (!isThinkingExhausted(e, model)) throw e;
      stats.thinkingExhaustedRetries++;
      console.error(`[anthropic] 本文が出る前に上限に達したため、上限に余裕を足して1回だけやり直します(model=${model})`);
      r = await call(useMax, THINKING_EXHAUSTED_BOOST);
    }
    // ---- v51: 尻切れ対策 ----
    // 上限に当たって文章が切れた場合、1回だけ上限を2倍(既定の天井2400)にして
    // 書き直す。それでも切れたら truncated:true を正直に返す(呼び出し元が
    // 利用者に「末尾が省略された」と注記する)。
    // v85: truncateRetry:false のときは書き直さない(対話は待ち時間を優先し、
    // 切れたことを正直に注記する方を選ぶ)。
    if (r.truncated && truncateRetry !== false) {
      const retryMax = Math.min(TRUNCATE_RETRY_CAP, Math.max(1200, (useMax || 700) * 2));
      console.error(`[anthropic] 応答がトークン上限(${useMax || 700})で途切れたため、上限${retryMax}で1回だけ書き直します(model=${model})`);
      try {
        const retry = await call(retryMax);
        r = retry;
      } catch (e) { /* 書き直しに失敗したら、切れた初回の本文をそのまま使う(無いより正直に多い方) */ }
    }
    return { text: r.text, model, truncated: !!r.truncated, usage: r.usage || null };
  };
  try {
    // 求められた版 → 1つ前の版 →(ID 不明のときだけ)予備、の順に試す。別の版で答えたときだけ fallbackFrom が付く
    return await runWithModelFallback(requested, (model) => runWithModel(model, timeoutMs));
  } catch (e) {
    // v85: 時間切れのときだけ、呼び出し元が指定した高速モデルへ1回だけ切り替える。
    // 「賢い回答が時間内に完成しない」よりも「少し軽いモデルでも必ず答えが返る」
    // 方が対話としては誠実(どのモデルで答えたかは画面に開示される)。
    if (e && e.code === "TIMEOUT" && timeoutFallbackModel && timeoutFallbackModel !== requested) {
      console.error(`[anthropic] モデル「${requested}」が時間切れ(${timeoutMs || ANTHROPIC_TIMEOUT_MS}ms)のため、高速モデル「${timeoutFallbackModel}」で再試行します`);
      const out = await runWithModelFallback(timeoutFallbackModel, (model) => runWithModel(model, timeoutFallbackTimeoutMs || 25000, timeoutFallbackMaxTokens));
      out.fallbackFrom = requested; // 時間切れになった元のモデルを開示する(従来どおり)
      out.fallbackReason = "timeout";
      return out;
    }
    throw e;
  }
}

/* ============================================================================
 * v104(2026年11月12日・利用者の決定「会話(1〜7)を今すぐ実装」): 道具を使える会話と流れる表示
 * ----------------------------------------------------------------------------
 * generate() は「system + 利用者の文1つ → 文章1つ」の1往復専用だった。会話の
 * ①道具(tool use: AIが必要なデータを自分で取りに行く)と ④流れる表示(streaming)には、
 *   ・複数ターンの messages(tool_use → tool_result の往復)
 *   ・tools の定義(JSON Schema)
 *   ・SSE(server-sent events)の逐次読み出し
 * が必要なので、別関数 generateMessages() として追加する。
 *
 * 返り値: { content, rawContent, stopReason, model, text, truncated, usage, fallbackFrom?, fallbackReason? }
 *   content    … アプリの処理用: text と tool_use だけ([{type:"text",text}|{type:"tool_use",id,name,input}])
 *   rawContent … 会話の続きに**そのまま**返すための、受け取ったままの全ブロック(v104.2)。
 *                thinking / redacted_thinking(考えた跡。中身は空でも署名つき)を含む。
 *                公式の決まり: 道具の往復では、これらを順番も中身も変えずに返す必要がある。
 *                (空白だけの text ブロックは API が受け付けないので、ここで外しておく)
 *   text       … content の text ブロックを結合したもの(互換用)
 *   onDelta(text) … stream:true のとき、本文の断片が届くたびに呼ばれる(考えた跡・tool_use の入力は流さない)
 * 失敗時は generate() と同じ code(TIMEOUT / HTTP_ERROR / EMPTY_RESPONSE / NO_KEY)を投げる。
 * ========================================================================== */
// v104.2: 断片が途絶えたと見なすまでの時間を 30秒 → 45秒 に。5.5 世代は答える前に考える時間が入り、
//   その間は本文の断片が届かない(既定では考えた中身は送られない)。重い質問で打ち切らないための余裕。
const ANTHROPIC_STREAM_IDLE_MS = parseInt(process.env.ANTHROPIC_STREAM_IDLE_MS, 10) || 45000;

function buildMessagesBody(model, { systemPrompt, messages, tools, maxTokens, stream, boost, effort }) {
  const body = {
    model,
    max_tokens: maxTokensWithThinking(model, maxTokens, boost),
    system: systemPrompt || "",
    messages: Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: "" }],
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (stream) body.stream = true;
  if (effort) body.output_config = { effort }; // v104.2: 環境変数で指定されたときだけ(既定では送らない)
  return body;
}

/** 空白以外の文字を含むか(API は空・空白だけの text ブロックを受け付けない) */
function hasVisibleText(s) {
  return typeof s === "string" && /\S/.test(s);
}

/**
 * 受け取ったブロックの列を、アプリの処理用(content)と、会話へそのまま返す用(rawContent)に分ける。
 *   ・text … 1文字でもあれば content へ。rawContent へは空白以外を含むものだけ
 *   ・tool_use … 両方へ(入力は解釈済みのオブジェクト)
 *   ・thinking … 署名のあるものだけ rawContent へ(署名の無い断片は API が受け付けない)
 *   ・それ以外(redacted_thinking など)… 受け取ったまま rawContent へ
 */
function splitContentBlocks(blocks) {
  const content = [];
  const rawContent = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    if (b.type === "text") {
      if (typeof b.text !== "string" || !b.text) continue;
      content.push({ type: "text", text: b.text });
      if (hasVisibleText(b.text)) rawContent.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use") {
      const blk = { type: "tool_use", id: String(b.id || ""), name: String(b.name || ""), input: (b.input && typeof b.input === "object") ? b.input : {} };
      content.push(blk);
      rawContent.push(blk);
    } else if (b.type === "thinking") {
      if (typeof b.signature === "string" && b.signature) rawContent.push(b);
    } else {
      rawContent.push(b);
    }
  }
  return { content, rawContent };
}

async function throwHttpError(res) {
  let bodyText = await res.text().catch(() => "");
  if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY.length >= 8) bodyText = bodyText.split(ANTHROPIC_API_KEY).join("[redacted]");
  const err = new Error(`Anthropic API HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  err.code = "HTTP_ERROR";
  err.httpStatus = res.status;
  err.bodyText = bodyText;
  throw err;
}

function parseSseChunk(chunk) {
  let evName = null; const dataLines = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) evName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { evName, data: dataLines.join("\n") };
}

/** SSE を1イベントずつ読み、content ブロックを組み立てる(本文の断片は onDelta へ) */
async function readStreamedMessage(res, onDelta, idleMs) {
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) {
    const err = new Error("Anthropic APIのストリーム応答を読み出せません(body が無い)");
    err.code = "STREAM_UNAVAILABLE";
    throw err;
  }
  const decoder = new TextDecoder();
  // index 順。v104.2: ブロックの種類ごとに組み立てる。
  //   以前は tool_use 以外を全部「text」として扱っていたため、thinking ブロック(考えた跡)が
  //   中身が空の text ブロックに化け、道具の往復でそれを返すと API に拒まれる(空の text は不可)
  //   形になっていた。thinking は thinking_delta / signature_delta で組み立て、受け取ったまま残す。
  const blocks = [];
  let stopReason = null;
  let stopDetails = null; // v104.2: 回答の見送り(refusal)の分類など(あれば)
  let usage = null;
  let buffer = "";
  let streamError = null;
  const startBlock = (index, cb) => {
    const c = (cb && typeof cb === "object") ? cb : {};
    if (c.type === "tool_use") blocks[index] = { kind: "tool_use", raw: { type: "tool_use", id: c.id || "", name: c.name || "" }, json: "" };
    else if (c.type === "thinking") blocks[index] = { kind: "thinking", raw: { ...c, type: "thinking", thinking: typeof c.thinking === "string" ? c.thinking : "", signature: typeof c.signature === "string" ? c.signature : "" } };
    else if (c.type === "text" || !c.type) blocks[index] = { kind: "text", raw: { type: "text", text: typeof c.text === "string" ? c.text : "" } };
    else blocks[index] = { kind: "other", raw: { ...c } }; // redacted_thinking など: 受け取ったまま保持する
    return blocks[index];
  };
  const handleEvent = (evName, dataStr) => {
    if (!dataStr) return;
    let ev;
    try { ev = JSON.parse(dataStr); } catch (e) { return; } // 壊れたイベントは無視(本文は後続で続く)
    const type = ev.type || evName;
    if (type === "content_block_start") {
      startBlock(ev.index, ev.content_block);
    } else if (type === "content_block_delta") {
      const d = ev.delta || {};
      // 開始イベントを取りこぼした場合の保険(断片の種類から推定する)
      const blk = blocks[ev.index] || startBlock(ev.index, {
        type: d.type === "input_json_delta" ? "tool_use" : ((d.type === "thinking_delta" || d.type === "signature_delta") ? "thinking" : "text"),
      });
      if (d.type === "text_delta" && typeof d.text === "string" && blk.kind === "text") {
        blk.raw.text += d.text;
        if (typeof onDelta === "function" && d.text) { try { onDelta(d.text); } catch (e) { /* 表示側の失敗は本文に影響させない */ } }
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string" && blk.kind === "tool_use") {
        blk.json += d.partial_json;
      } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && blk.kind === "thinking") {
        blk.raw.thinking += d.thinking;
      } else if (d.type === "signature_delta" && typeof d.signature === "string" && blk.kind === "thinking") {
        blk.raw.signature += d.signature;
      }
    } else if (type === "message_delta") {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      const sd = (ev.delta && ev.delta.stop_details) || ev.stop_details;
      if (sd && typeof sd === "object") stopDetails = sd;
      if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
    } else if (type === "message_start") {
      if (ev.message && ev.message.usage) usage = { ...(usage || {}), ...ev.message.usage };
    } else if (type === "error") {
      const msg = (ev.error && ev.error.message) || "stream error";
      streamError = new Error(`Anthropic APIのストリーム中にエラー: ${String(msg).slice(0, 200)}`);
      streamError.code = "STREAM_ERROR";
    }
  };
  const processBuffer = (final) => {
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const { evName, data } = parseSseChunk(chunk);
      handleEvent(evName, data);
    }
    if (final && buffer.trim()) {
      const { evName, data } = parseSseChunk(buffer);
      buffer = "";
      handleEvent(evName, data);
    }
  };
  for (;;) {
    let timer = null;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`Anthropic APIのストリームが${idleMs}ms途絶えました`); e.code = "TIMEOUT"; reject(e); }, idleMs); });
    let step;
    try {
      step = await Promise.race([reader.read(), idle]);
    } catch (e) {
      try { await reader.cancel(); } catch (e2) { /* 既に閉じている */ }
      throw e;
    } finally { clearTimeout(timer); }
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    processBuffer(false);
    if (streamError) { try { await reader.cancel(); } catch (e2) { /* 既に閉じている */ } throw streamError; }
  }
  processBuffer(true);
  const received = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.kind === "tool_use") {
      let input = {};
      if (b.json) { try { input = JSON.parse(b.json); } catch (e) { input = { __invalidJson: b.json.slice(0, 200) }; } }
      received.push({ ...b.raw, input });
    } else received.push(b.raw);
  }
  return { ...splitContentBlocks(received), stopReason, stopDetails, usage };
}

async function generateMessages({ systemPrompt, messages, tools, maxTokens, tier, model: modelOverride, timeoutMs, stream, onDelta }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const requested = modelOverride || resolveModel(tier);
  const headers = { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
  const callTimeout = timeoutMs || ANTHROPIC_TIMEOUT_MS;
  const callOnceMessages = async (model, boost) => {
    // 画面へ流した本文の文字数(回答の見送りが「本文を流したあと」に来たかどうかの判定に使う)
    let shownChars = 0;
    const onDeltaCounted = (stream && typeof onDelta === "function") ? (t) => { shownChars += String(t || "").length; onDelta(t); } : undefined;
    // effort の指定が原因の 400 は、本文の断片が流れる前(ヘッダーの時点)に分かるので、送り直しても表示は二重にならない
    const out = await sendWithEffort(model, async (effort) => {
      const body = buildMessagesBody(model, { systemPrompt, messages, tools, maxTokens, stream: !!stream, boost, effort });
      if (stream) {
        // 接続の確立(ヘッダー到着)までは timeoutMs、その後は断片ごとの無応答時間で判定する
        const res = await fetchWithTimeout(ANTHROPIC_API_BASE, { method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify(body) }, callTimeout);
        if (!res.ok) await throwHttpError(res);
        return readStreamedMessage(res, onDeltaCounted, ANTHROPIC_STREAM_IDLE_MS);
      }
      const res = await fetchWithTimeout(ANTHROPIC_API_BASE, { method: "POST", headers, body: JSON.stringify(body) }, callTimeout);
      if (!res.ok) await throwHttpError(res);
      const parsed = await res.json();
      const json = (parsed && typeof parsed === "object") ? parsed : {}; // 本文が JSON の null などでも、下の「空の応答」として扱う
      return { ...splitContentBlocks(json.content), stopReason: json.stop_reason || null, stopDetails: json.stop_details || null, usage: json.usage || null };
    });
    noteUsage(model, out.usage, out.stopReason);
    // v104.2: 回答の見送り(HTTP 200・stop_reason="refusal")。途中までの出力(本文・道具の呼び出し)は未完成として捨てる
    if (out.stopReason === "refusal") throw makeRefusalError(out.stopDetails, model, shownChars > 0);
    const text = out.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const hasToolUse = out.content.some((b) => b.type === "tool_use");
    if (!text && !hasToolUse) {
      const types = out.rawContent.map((b) => b.type).join(",") || out.content.map((b) => b.type).join(",") || "empty";
      const err = new Error(`Anthropic APIから空の応答が返されました(stop_reason=${out.stopReason || "?"}, blocks=${types})`);
      err.code = "EMPTY_RESPONSE";
      err.stopReason = out.stopReason || null;
      throw err;
    }
    return { content: out.content, rawContent: out.rawContent, stopReason: out.stopReason, model, text, truncated: out.stopReason === "max_tokens", usage: out.usage || null };
  };
  const attempt = async (model) => {
    try {
      return await callOnceMessages(model);
    } catch (e) {
      // 考える処理だけで上限を使い切った(本文も道具の呼び出しも無い)ときは、余裕を足して1回だけやり直す。
      // 本文の断片は1つも流れていないので、流れる表示が二重になることはない。
      if (!isThinkingExhausted(e, model)) throw e;
      stats.thinkingExhaustedRetries++;
      console.error(`[anthropic] 本文が出る前に上限に達したため、上限に余裕を足して1回だけやり直します(model=${model}・会話)`);
      return await callOnceMessages(model, THINKING_EXHAUSTED_BOOST);
    }
  };
  // 求められた版 → 1つ前の版 →(ID 不明のときだけ)予備。要求の拒否(HTTP 4xx)は断片が流れる前に
  // 分かるので、流れる表示の途中で版が切り替わることはない。
  return await runWithModelFallback(requested, attempt);
}

/** v104.2: 診断用(/api/diag/llm)。いまの既定モデル・戻り先・切り替えの実績(このプロセスの起動後)を返す。鍵は含まない */
function diagnostics() {
  const health = {};
  for (const [m, h] of modelHealth) {
    health[m] = {
      rejectStreak: h.rejectStreak || 0,
      restingUntil: h.unavailableUntil > Date.now() ? new Date(h.unavailableUntil).toISOString() : null,
      lastReason: h.lastReason || null,
      lastAt: h.lastAt ? new Date(h.lastAt).toISOString() : null,
    };
  }
  const effortRejected = {};
  for (const [m, r] of effortRejectedBy) effortRejected[m] = { at: r.at, effort: r.effort, detail: r.detail };
  return {
    models: {
      light: ANTHROPIC_MODEL, heavy: ANTHROPIC_MODEL_HEAVY,
      previousLight: previousModelOf(ANTHROPIC_MODEL), previousHeavy: previousModelOf(ANTHROPIC_MODEL_HEAVY),
      lastResort: ANTHROPIC_FALLBACK_MODEL || null,
      previousFallbackEnabled: PREVIOUS_FALLBACK_ENABLED,
      refusalFallback: REFUSAL_FALLBACK_ENABLED ? (REFUSAL_FALLBACK_MODEL || null) : null,
    },
    thinkingHeadroom: { light: THINKING_HEADROOM_LIGHT, heavy: THINKING_HEADROOM_HEAVY, min: THINKING_HEADROOM_MIN, retryBoost: THINKING_EXHAUSTED_BOOST },
    // 考える深さ(effort): null は「指定なし(API の既定のまま)」。ignored は使えない値だったため無視した設定
    effort: {
      light: effortConfig.light.value, heavy: effortConfig.heavy.value,
      ignored: { light: effortConfig.light.ignored, heavy: effortConfig.heavy.ignored },
      rejectedByApi: effortRejected,
    },
    stats: {
      primaryOk: stats.primaryOk, previousUsed: stats.previousUsed, lastResortUsed: stats.lastResortUsed, thinkingExhaustedRetries: stats.thinkingExhaustedRetries, lastFallbacks: stats.lastFallbacks.slice(),
      // 回答の見送り(refusal): 起きた件数・戻り先のモデルが答えられた件数・直近の記録(質問文は含めない)
      refusals: stats.refusals, refusalsAnswered: stats.refusalsAnswered, lastRefusals: stats.lastRefusals.map((r) => ({ ...r })),
    },
    // 実測の使用量(このプロセスの起動後・モデルごと)。avgOutputTokens は usage が付いていた応答の平均
    usage: {
      since: PROCESS_STARTED_AT,
      byModel: Object.fromEntries([...usageByModel].map(([m, u]) => [m, { ...u, avgOutputTokens: u.withUsage ? Math.round(u.outputTokens / u.withUsage) : null }])),
    },
    health,
  };
}

module.exports = {
  generate, generateMessages, resolveModel, supportsTools: true, supportsStreaming: true, diagnostics,
  __v1042ForTest: {
    thinksByDefault, thinkingHeadroomFor, maxTokensWithThinking, splitContentBlocks, previousModelOf, pickModel, parseEffortLevel, effortFor,
    resetModelHealth: () => {
      modelHealth.clear(); effortRejectedBy.clear();
      stats.primaryOk = 0; stats.previousUsed = 0; stats.lastResortUsed = 0; stats.thinkingExhaustedRetries = 0; stats.lastFallbacks.length = 0;
      stats.refusals = 0; stats.refusalsAnswered = 0; stats.lastRefusals.length = 0;
      usageByModel.clear();
    },
    setModelUnavailable: (model, ms) => { modelHealth.set(model, { rejectStreak: 0, unavailableUntil: Date.now() + ms, lastReason: "test", lastAt: Date.now() }); },
    // テスト専用: 環境変数を読み直さずに effort の設定を差し替える(本番のコードからは呼ばれない)
    setEffortForTest: (light, heavy) => { effortConfig.light = parseEffortLevel(light); effortConfig.heavy = parseEffortLevel(heavy); },
  },
};
