/**
 * server/learning/roiTracker.js
 * ------------------------------------------------
 * 2026年8月・精度証明ラウンド⑤: オッズ比較とROI追跡。
 * ブックメーカーのオッズは「世界で最も厳しい採点者」であり、AIの予想が
 * 市場に勝てているかを毎日実測する。
 *
 * ■ 測り方(機械的・検算可能)
 *   ・オッズはAPI-Footballの/oddsから「Match Winner」を取得し、複数ブック
 *     メーカーの中央値を使う(1社の異常値に引きずられないため)。
 *   ・ROI: 「AIの予想した勝敗に毎回1単位を賭けたら」という仮想の採点。
 *     的中なら オッズ−1 の利益、外れなら −1。ROI% = 総利益 ÷ 総賭け金。
 *   ・エッジ: AIの予想確率 − 市場の織り込み確率(オッズの逆数を正規化)。
 *     プラス=AIが市場より強気だった部分。
 *
 * ■ でっち上げ防止
 *   ・オッズが取得できなかった試合はROI集計から正直に除外する(件数を開示)。
 *   ・これは賭けの推奨ではなく、予測精度を市場と比較するための評価指標である
 *     ことを表示に明記する。
 */

const ROI_KEY_PREFIX = "learn:roi:";
const { readManyJSON, dateKeysBack } = require("./storeRead"); // v97: 複数キーのまとめ読み(MGET)・失敗の区別

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * API-Footballの/odds応答から「Match Winner」のオッズ(複数社の中央値)を取り出す。
 * 取れない場合はnull(架空のオッズを作らない)。
 */
function extractMatchWinnerOdds(apiResponse) {
  const entry = apiResponse && Array.isArray(apiResponse.response) ? apiResponse.response[0] : null;
  if (!entry || !Array.isArray(entry.bookmakers)) return null;
  const homes = [], draws = [], aways = [];
  for (const bm of entry.bookmakers) {
    const bet = (bm.bets || []).find((b) => b && (b.name === "Match Winner" || b.id === 1));
    if (!bet) continue;
    const of = (label) => {
      const v = (bet.values || []).find((x) => x && x.value === label);
      const n = v ? parseFloat(v.odd) : NaN;
      return Number.isFinite(n) && n > 1 ? n : null;
    };
    const h = of("Home"), d = of("Draw"), a = of("Away");
    if (h !== null && d !== null && a !== null) { homes.push(h); draws.push(d); aways.push(a); }
  }
  if (!homes.length) return null;
  return {
    home: round2(median(homes)), draw: round2(median(draws)), away: round2(median(aways)),
    bookmakerCount: homes.length,
  };
}

/** オッズ → 市場の織り込み確率(%)。オーバーラウンド(胴元の取り分)を正規化して除く */
function impliedProbsPct(odds) {
  if (!odds || !Number.isFinite(odds.home) || !Number.isFinite(odds.draw) || !Number.isFinite(odds.away)) return null;
  const rh = 1 / odds.home, rd = 1 / odds.draw, ra = 1 / odds.away;
  const sum = rh + rd + ra;
  return {
    homePct: round1((rh / sum) * 100), drawPct: round1((rd / sum) * 100), awayPct: round1((ra / sum) * 100),
    overroundPct: round1((sum - 1) * 100),
  };
}

/** 解決済みの予測1件をROI採点する(オッズが記録されていない試合はnull) */
function scoreRoiForRecord(record) {
  if (!record || !record.resolved || !record.odds || !record.predictedWinner) return null;
  const odd = record.odds[record.predictedWinner];
  if (!Number.isFinite(odd) || odd <= 1) return null;
  const profit = record.correct ? round4(odd - 1) : -1;
  return { staked: 1, profit, win: !!record.correct, oddsUsed: odd };
}

function emptyRoiDaily() {
  return { bets: 0, staked: 0, profitSum: 0, wins: 0, edgeSumPt: 0, edgeN: 0, oddsMissing: 0 };
}

function mergeRoiDaily(a, b) {
  if (!a) return b; if (!b) return a;
  const out = emptyRoiDaily();
  for (const k of Object.keys(out)) out[k] = round4((a[k] || 0) + (b[k] || 0));
  return out;
}

function summarizeRoi(agg) {
  if (!agg || !agg.bets) {
    return { measurable: false, reasonJa: "オッズつきで答え合わせできた予測がまだありません(オッズは予測時に取得し、試合終了後に採点されます)。", oddsMissing: (agg && agg.oddsMissing) || 0 };
  }
  return {
    measurable: true,
    bets: agg.bets,
    roiPct: round1((agg.profitSum / agg.staked) * 100),
    profitUnits: round2(agg.profitSum),
    winRatePct: round1((agg.wins / agg.bets) * 100),
    avgEdgePt: agg.edgeN ? round1(agg.edgeSumPt / agg.edgeN) : null,
    oddsMissing: agg.oddsMissing || 0,
    noteJa: "ROI=AIの予想勝敗に毎回1単位を賭けたと仮定した収支(市場比較のための評価指標であり、賭けの推奨ではありません)。0%超なら市場のオッズに勝っています。",
  };
}

async function saveDailyRoi(deps, dateKey, agg) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON, upstashCmd } = deps || {};
  if (!upstashEnabled || !dateKey || !agg) return false;
  try {
    // v97(全体監査): 「読めなかった」のに「無かった」と見なして上書きすると、その日の
    //   既存ROI(同じ日の前回実行分)が消える(read-merge-write の欠陥)。upstashCmd が
    //   あれば失敗を区別できる経路で読み、失敗したら保存を見送る(次回の実行で再度足される)。
    let existing = null;
    if (typeof upstashCmd === "function") {
      const r = await readManyJSON({ upstashCmd }, [`${ROI_KEY_PREFIX}${dateKey}`]);
      if (r.readFailed) return false;
      existing = r.values[0];
    } else {
      existing = await upstashGetJSON(`${ROI_KEY_PREFIX}${dateKey}`).catch(() => null);
    }
    const ok = await upstashSetJSON(`${ROI_KEY_PREFIX}${dateKey}`, mergeRoiDaily(existing, agg));
    return ok !== false;
  } catch (e) { return false; }
}

/** 直近7日・30日のROIまとめ(記録の無い日は欠落のまま。推測で埋めない) */
async function getRoiTrend(deps, todayDateKey) {
  const { upstashEnabled } = deps || {};
  if (!upstashEnabled) return { available: false, reasonJa: "Upstash未設定のため読み出せません。" };
  let last7 = null, last30 = null, today = null;
  // v97: 30日ぶんを1件ずつ GET → MGET 1回。読めなかった場合は正直に返す。
  const dks = dateKeysBack(todayDateKey, 30);
  const r = await readManyJSON(deps, dks.map((dk) => `${ROI_KEY_PREFIX}${dk}`));
  if (r.readFailed) return { available: false, readFailed: true, reasonJa: `保存先(Upstash)からROIの記録を読み出せませんでした${r.firstError ? `(${r.firstError})` : ""}。記録が無いという意味ではありません。` };
  for (let i = 0; i < dks.length; i++) {
    const agg = r.values[i];
    if (!agg) continue;
    if (i === 0) today = agg;
    if (i < 7) last7 = mergeRoiDaily(last7, agg);
    last30 = mergeRoiDaily(last30, agg);
  }
  return {
    available: true,
    partial: !!r.partial, // 一部の日が読めなかった(件数が実際より少ない可能性)
    today: summarizeRoi(today),
    last7Days: summarizeRoi(last7),
    last30Days: summarizeRoi(last30),
  };
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

module.exports = {
  ROI_KEY_PREFIX,
  extractMatchWinnerOdds, impliedProbsPct, scoreRoiForRecord,
  emptyRoiDaily, mergeRoiDaily, summarizeRoi, saveDailyRoi, getRoiTrend,
};
