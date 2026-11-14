"use strict";
/**
 * server/discuss/grounding.js
 * ------------------------------------------------
 * v104.1(2026年11月14日)M「数字の裏取り」
 *
 * ■ なぜ必要か
 *   回答AIには「取得できた事実にある数字だけを使う」よう指示しているが、指示は保証ではない。
 *   利用者から見て、回答の「62%」「7.3」「18得点」が実測なのか、AIが文章の勢いで書いた数字なのかは
 *   区別がつかない。でっち上げ禁止の方針を、指示だけでなく**機械的な照合**でも守る。
 *
 * ■ 何をするか(LLMを追加で呼ばない=費用ゼロ・数ミリ秒)
 *   1. 回答の本文から「データとして意味を持つ数字」を取り出す
 *        ・割合(◯%)・小数(7.3 / 1.85)・10以上の整数(18得点・勝点42 など)
 *        ・対象外: 西暦・日付・時刻・フォーメーション(4-3-3)・90分などの定数・1桁の整数
 *          (1桁の整数はどの資料にも偶然含まれ、照合しても意味がないため数えない)
 *   2. 数字の出どころを3つに分けて調べる(混ぜない):
 *        D 取得したデータ … 今回AIに渡した実データ(取得できた事実・推論の材料・道具の結果・実成績)
 *        Q 利用者の言葉   … 今回の質問・これまでの質問・利用者の設定(利用者が自分で書いた数字)
 *        H これまでの回答 … この会話でAIが前に答えた内容の要旨
 *      回答の数字は D → Q → H の順に探す。
 *        ・D にある → 「一致」(四捨五入の幅だけ許す。0.731 と 73% は同じとみなす。
 *                     割合は「100%からの引き算」(例: 負けない確率)も D から導けるものとして数える)
 *        ・D に無く Q にある → 利用者が書いた数字の引用。AIの主張ではないので照合の対象から外す
 *        ・D にも Q にも無く H にある → AIが前の回答の数字を繰り返したもの。今回は照合していない、と伝える
 *        ・どこにも無い → 「取得したデータに同じ値が見当たらない数字」として挙げる
 *   3. 結果を回答に添える: すべて一致 / 一致しない数字の一覧 / 前の回答の繰り返し / そもそもデータを使っていない回答
 *
 * ■ なぜ出どころを分けるのか(実ブラウザ検査で見つけた穴)
 *   最初の実装は D・Q・H を1つの資料として照合していた。すると、AIが一般知識で答えた数字(照合できない数字)を
 *   次の質問でもう一度書いたとき、前の回答(H)に同じ数字があるため「取得したデータと一致」と表示されてしまった。
 *   一度書いた数字が次の回で「裏取り済み」に化けるのは、この機能の目的に反する。AIの推定(【AIによる推定】で
 *   始まる項目)も実データではないので D に入れない(呼び出し側で除く)。
 *
 * ■ 正直に伝えること(誤解を生まない言い方)
 *   ・一致しない=でっち上げ、とは限らない。AIが差や平均を**計算**した値、AIの推定や一般知識による値は、
 *     取得したデータに同じ数字が無い。画面には「取得したデータに同じ値が見当たりません(AIが計算した値や、
 *     AIの推定・一般知識による値の場合があります)」と出す。
 *   ・一致した=正しい、でもない(取得したデータに同じ数字があるだけ。別の項目の数字かもしれない)。
 *     この照合は「取得したデータに無い数字が紛れ込んだ」ことを見つけるための網であり、内容の採点ではない。
 */

const MAX_CORPUS_CHARS = 400000;
const MAX_UNSUPPORTED_SHOWN = 6;
const PCT_TOL = 0.6;

/** 全角の数字・記号を半角へ(照合の前処理)。文字はすべて Unicode エスケープで書く(編集時の取り違え防止) */
function normalizeDigits(s) {
  return String(s || "")
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 0-9
    .replace(/[\uFF05\uFE6A]/g, "%")   // % ﹪
    .replace(/\uFF0E/g, ".")           // .
    .replace(/\uFF0C/g, ",")           // ,
    .replace(/[\u2212\u2013\u2014\u2010\uFF0D]/g, "-") // − – — ‐ -
    .replace(/\uFF1A/g, ":")           // :
    .replace(/\uFF0F/g, "/");          // /
}

/** 日付・時刻・URL・フォーメーションなど「数字に見えるが成績の数字ではないもの」を空白に置き換える */
function stripNonDataPatterns(text) {
  return text
    .replace(/https?:\/\/[^\s"'<>)]+/g, " ")
    // ISO日時・日付(2026-11-14T19:30:00+00:00 / 2026-11-14 / 2026/11/14)
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, " ")
    // シーズン表記(2025-26 / 2026/27)
    .replace(/\b(?:19|20)\d{2}\s?[-/]\s?\d{2}\b/g, " ")
    // 時刻(19:30 / 19:30:00)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    // フォーメーション(4-3-3 / 4-2-3-1 / 3-4-2-1)
    .replace(/(?<![\d.])\d(?:\s?-\s?\d){2,4}(?![\d.])/g, " ");
}

const NUM_RE = /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;

/**
 * 回答の本文から、照合の対象になる数字を取り出す。
 * @returns {{items:Array<{text:string,value:number,kind:"pct"|"num",decimals:number}>, skippedSmall:number}}
 */
function extractClaims(answerText) {
  const text = stripNonDataPatterns(normalizeDigits(answerText));
  const items = [];
  const seen = new Set();
  let skippedSmall = 0;
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(text))) {
    const intPart = m[1].replace(/,/g, "");
    const frac = m[2] || "";
    const raw = intPart + frac;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 12);
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    const decimals = frac ? frac.length - 1 : 0;
    const isPct = /^\s?(%|パーセント|percent\b|per cent\b|por ciento)/i.test(after);
    // --- 対象外(成績の数字ではないもの) ---
    if (/^[A-Za-z]/.test(after) && /^\d*X\d/.test(text.slice(m.index, end + 3))) continue;        // 1X2
    if (!frac && !isPct) {
      if (/^\s?(年|月|日|時|節|世紀|年代|番目|か国|ヶ国|カ国|か月|ヶ月|カ月|週間|日間|時間|秒|か所|つ目)/.test(after) && !/^\s?日本/.test(after)) continue; // 日付・回数の言い回し
      if (/第\s?$/.test(before)) continue;                                                        // 第3節・第2戦
      if (value >= 1900 && value <= 2099 && !/^\s?(分|試合|得点|ゴール|点|回|本|人|件|min|minutes|goals|points|pts|appearances)/i.test(after)) continue; // 西暦
      if ((value === 90 || value === 45 || value === 120) && /^\s?(分|min|minutes|')/i.test(after)) continue; // 試合時間の定数
      if (value === 11 && /^\s?(人|対|v)/.test(after)) continue;                                  // 11人
    }
    if (isPct && value === 100 && !frac) continue;                                                // 「100%とは言えません」
    if (frac && /\.5$/.test(raw) && value <= 4.5 && /^\s?(点|ゴール|得点|goals?|以上|以下|超|未満|over|under)/i.test(after)) continue; // 2.5点以上 などの基準線
    if (!frac && !isPct && value < 10) { skippedSmall++; continue; }                               // 1桁の整数は照合しない
    const kind = isPct ? "pct" : "num";
    const key = `${kind}:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text: isPct ? `${raw}%` : raw, value, kind, decimals });
  }
  return { items, skippedSmall };
}

/** 資料から数字を取り出す(並べ替え済みの配列と、割合らしい数字の配列) */
function extractCorpusNumbers(corpusTexts) {
  let joined = (Array.isArray(corpusTexts) ? corpusTexts : [corpusTexts]).filter(Boolean).map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join("\n");
  if (joined.length > MAX_CORPUS_CHARS) joined = joined.slice(0, MAX_CORPUS_CHARS);
  const text = stripNonDataPatterns(normalizeDigits(joined));
  const all = [];
  const pctLike = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(text))) {
    const raw = m[1].replace(/,/g, "") + (m[2] || "");
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    all.push(v);
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 3);
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    const looksPct = /^\s?%/.test(after) || /(pct|percent|rate|prob|share|率|確率|割合)[A-Za-z]*"?\s*[:=(]?\s*$/i.test(before);
    if (looksPct && v >= 0 && v <= 100) pctLike.push(v);
    // 0〜1 の確率(0.731)は、割合(73.1)としても資料にあるとみなす
    if (m[2] && v > 0 && v < 1 && (m[2].length - 1) >= 2) { all.push(v * 100); pctLike.push(v * 100); }
  }
  // 直近の勝敗の並び(WWDLW)から、勝ち・分け・負けの数を資料の数字として足す(10以上は稀だが形式を揃える)
  const forms = text.match(/(?<![A-Za-z])[WDL]{3,12}(?![A-Za-z])/g) || [];
  for (const f of forms) {
    for (const ch of ["W", "D", "L"]) all.push(f.split(ch).length - 1);
    all.push(f.length);
  }
  all.sort((a, b) => a - b);
  pctLike.sort((a, b) => a - b);
  return { all, pctLike, chars: joined.length };
}

function nearestDiff(sorted, v) {
  if (!sorted.length) return Infinity;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1; else hi = mid;
  }
  let best = Math.abs(sorted[lo] - v);
  if (lo > 0) best = Math.min(best, Math.abs(sorted[lo - 1] - v));
  return best;
}

/** 道具つきの会話の記録(runToolLoop の messages)から、道具の結果の文字列だけを取り出す */
function toolResultTextsOf(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === "tool_result" && b.content !== undefined && b.content !== null) {
        out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
      }
    }
  }
  return out;
}

/** 回答の数字1つが資料にあるか。 "direct"(同じ値) / "complement"(100%からの引き算) / null */
function matchClaim(claim, corpus) {
  const eps = 1e-9;
  if (claim.kind === "pct") {
    if (nearestDiff(corpus.all, claim.value) <= PCT_TOL + eps) return "direct";
    if (nearestDiff(corpus.pctLike, 100 - claim.value) <= PCT_TOL + eps) return "complement";
    return null;
  }
  // 小数は「最後の桁の四捨五入」の幅だけ許す(1.8 は 1.75〜1.85 と一致)。整数は ±0.5(87.4 → 87)
  const tol = claim.decimals > 0 ? 0.5 * Math.pow(10, -claim.decimals) : 0.5;
  return nearestDiff(corpus.all, claim.value) <= tol + eps ? "direct" : null;
}

/**
 * @param {object} p
 * @param {string[]} p.answerTexts   回答の本文(欄ごと)
 * @param {Array<string|object>} p.corpusTexts         D: 今回AIに渡した実データ(事実・推論の材料・道具の結果・実成績)
 * @param {Array<string>} [p.questionTexts]            Q: 利用者の言葉(今回の質問・これまでの質問・設定)
 * @param {Array<string>} [p.earlierAnswerTexts]       H: この会話でAIが前に答えた内容(要旨)
 * @param {boolean} p.dataUsed       この回答で実データ(事実・道具)を1件でも使えたか
 * @returns {{verdict:string, checked:number, supported:number, derived:number, unsupportedCount:number,
 *            unsupported:Array<{text:string,kind:string}>, fromQuestion:number, repeated:number,
 *            ratePct:number|null, skippedSmall:number, dataUsed:boolean, noteJa:string|null}}
 *   verdict: "all_supported"(照合した数字がすべて D にある) / "partial"(D に無い数字がある) /
 *            "general_knowledge"(実データを使っていない回答の数字) / "repeated_only"(前の回答の数字の繰り返しだけ) /
 *            "none"(添えることが無い: 照合の対象になる数字が無い、または利用者の数字の引用だけ)
 *   checked = supported + unsupportedCount(Q の引用と H の繰り返しは数えない)
 */
function checkGrounding(p) {
  const o = p || {};
  const answer = (Array.isArray(o.answerTexts) ? o.answerTexts : [o.answerTexts]).filter((t) => typeof t === "string" && t.trim()).join("\n");
  const base = { verdict: "none", checked: 0, supported: 0, derived: 0, unsupportedCount: 0, unsupported: [], fromQuestion: 0, repeated: 0, ratePct: null, skippedSmall: 0, dataUsed: o.dataUsed === true, noteJa: null };
  if (!answer) return base;
  const { items, skippedSmall } = extractClaims(answer);
  base.skippedSmall = skippedSmall;
  if (!items.length) return base;
  const corpus = extractCorpusNumbers(o.corpusTexts || []);
  const asked = extractCorpusNumbers(o.questionTexts || []);
  const earlier = extractCorpusNumbers(o.earlierAnswerTexts || []);
  let supported = 0, derived = 0, fromQuestion = 0, repeated = 0;
  const unsupported = [];
  for (const c of items) {
    const how = matchClaim(c, corpus);
    if (how) { supported++; if (how === "complement") derived++; continue; }
    // 利用者の数字・前の回答の数字は「同じ値」だけを見る(引き算で導いた値は、AIがいま計算した値として扱う)
    if (asked.all.length && matchClaim(c, asked) === "direct") { fromQuestion++; continue; }
    if (earlier.all.length && matchClaim(c, earlier) === "direct") { repeated++; continue; }
    unsupported.push({ text: c.text, kind: c.kind });
  }
  const checked = supported + unsupported.length;
  const out = {
    ...base,
    checked, supported, derived,
    unsupportedCount: unsupported.length,
    unsupported: unsupported.slice(0, MAX_UNSUPPORTED_SHOWN),
    fromQuestion, repeated,
    ratePct: checked > 0 ? Math.round((supported / checked) * 1000) / 10 : null,
  };
  const repeatedOnlyJa = `この回答の数字${repeated}個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。`;
  const repeatedAlsoJa = repeated > 0 ? ` ほかに${repeated}個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。` : "";
  if (o.dataUsed !== true) {
    // 実データを使っていない回答(一般知識での回答)。照合できる相手が無いので「一致」「不一致」とは呼ばない。
    //   利用者の数字の引用だけなら何も添えない。前の回答の繰り返しだけなら、そう伝える。
    //   それ以外の数字があれば「一般知識の数字」と伝える。
    if (unsupported.length) {
      out.verdict = "general_knowledge";
      out.noteJa = `この回答は取得したデータを使っていないため、数字(${unsupported.length}個)はAIの一般知識にもとづくものです。最新の値と違う場合があります。`;
    } else if (repeated > 0) {
      out.verdict = "repeated_only";
      out.noteJa = repeatedOnlyJa;
    }
    return out;
  }
  if (unsupported.length) {
    out.verdict = "partial";
    const list = out.unsupported.map((u) => u.text).join("、");
    out.noteJa = `照合した数字${checked}個のうち${supported}個は取得したデータと一致しました。次の数字は、取得したデータに同じ値が見当たりません(AIが計算した値や、AIの推定・一般知識による値の場合があります): ${list}${unsupported.length > out.unsupported.length ? " ほか" : ""}。${repeatedAlsoJa}`.trim();
  } else if (supported > 0) {
    out.verdict = "all_supported";
    out.noteJa = `照合した数字${checked}個は、すべて取得したデータにある数字と一致しました。${repeatedAlsoJa}`.trim();
  } else if (repeated > 0) {
    out.verdict = "repeated_only";
    out.noteJa = repeatedOnlyJa;
  }
  return out;
}

/**
 * 「取得したデータ(D)」に入れてよい事実か。
 *   AIの推定(知識として保存したクラブ・選手の推定プロフィール。実際の書き出しは「【AIによる推定・戦術傾向】」
 *   「【AIによる推定・プレースタイル】」で、前に「[似たクラブ ◯◯ の知識] 」などの見出しが付くこともある)と、
 *   AIの結論(【AIの結論】)は、実データではないので入れない。
 */
function isMeasuredFact(fact) {
  const t = String(fact || "").trim();
  return !!t && !t.includes("【AIによる推定") && !t.includes("【AIの結論】");
}

/**
 * 会話の処理(handleDiscuss)が持っている材料を、3つの出どころ(D/Q/H)に仕分ける(純関数)。
 * @param {object} p
 * @param {string[]} p.facts             AIに渡した「取得できた事実」(推定・断り書きを含む全件)
 * @param {string}   p.reasoningBlock    AIに渡した推論の材料(観点・検討メモ)
 * @param {string[]} p.toolTexts         道具が返した結果の文字列
 * @param {object}   p.stats             画面に出す実成績
 * @param {string}   p.question          今回の質問
 * @param {Array<{q:string,a:string}>} p.history 直前までの会話(質問と回答の要旨)
 * @param {string}   p.profileText       利用者の設定(呼び名・好きなクラブ)
 * @param {string}   p.previousConclusion 記憶にある「AIが前回下した結論」
 */
function buildSources(p) {
  const o = p || {};
  const facts = (Array.isArray(o.facts) ? o.facts : []).filter(isMeasuredFact);
  // 推論の材料のうち、「AIが前回下した結論」の行(今回のデータではない)と、調査計画AI(LLM)が書いた論点の行は D に入れない。
  //   どちらの数字も、実データにあれば事実の側で一致する。
  const reasoning = String(o.reasoningBlock || "").split("\n")
    .filter((line) => !/^AIが前回下した結論/.test(line) && !/^【調査計画AIが特定した/.test(line)).join("\n");
  const stats = (o.stats && typeof o.stats === "object" && Object.keys(o.stats).length) ? JSON.stringify(o.stats) : "";
  const history = Array.isArray(o.history) ? o.history.filter((t) => t && typeof t === "object") : [];
  return {
    corpusTexts: [facts.join("\n"), reasoning, ...(Array.isArray(o.toolTexts) ? o.toolTexts : []), stats].filter((t) => typeof t === "string" && t),
    questionTexts: [o.question, ...history.map((t) => t.q), o.profileText].filter((t) => typeof t === "string" && t),
    earlierAnswerTexts: [...history.map((t) => t.a), o.previousConclusion].filter((t) => typeof t === "string" && t),
  };
}

module.exports = { checkGrounding, buildSources, isMeasuredFact, extractClaims, extractCorpusNumbers, matchClaim, normalizeDigits, stripNonDataPatterns, toolResultTextsOf, MAX_UNSUPPORTED_SHOWN, PCT_TOL };
