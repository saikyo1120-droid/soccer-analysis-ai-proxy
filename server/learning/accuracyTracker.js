/**
 * server/learning/accuracyTracker.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑨)。
 * 予測精度を毎日測定する: 勝敗(1X2)だけでなく、スコア・BTTS(両チーム得点)・
 * Over/Under 2.5 の各市場について、的中率・Brier Score・Log Loss・
 * Calibration(自信と実際の的中のズレ)を記録し、昨日・先週・先月と比較する。
 *
 * ■ でっち上げ防止
 *   ・BTTS/Over-Under の確率は、勝敗予測と同じポアソン分布(homeLambda/awayLambda)
 *     から機械的に導出する。別の「予想」を勝手に作らない。
 *   ・検証データが無い日は、無理に数字を出さず「測定できない」と正直に返す。
 *   ・ROI(オッズを使った収益率)は、現在オッズを取得していないため計算しない
 *     (存在しない数字を出さない)。API-Football Proにはオッズのエンドポイントが
 *     あるため、必要になれば追加できる。
 *
 * ■ 指標の意味(利用者向けの説明にも使う)
 *   ・的中率: 当たった割合。分かりやすいが「自信の質」は測れない。
 *   ・Brier Score: 確率予測の二乗誤差(0が最良、1X2の無情報予測≒0.667)。
 *   ・Log Loss: 実際の結果に割り当てていた確率の対数損失(低いほど良い。
 *     自信満々で外すと大きく罰される)。
 *   ・Calibration: 「70%と言った予測は本当に70%当たっているか」。
 */

const { poissonPmf } = require("./predictionModel");

const ACCURACY_KEY_PREFIX = "learn:accuracy:";
const P_FLOOR = 0.005; // log(0)回避

/**
 * ポアソン格子から全市場の確率を導出する(勝敗と同一のモデル・同一のλ)。
 */
function computeMarketProbs(homeLambda, awayLambda, maxGoals) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const cap = maxGoals || 8;
  let pHome = 0, pDraw = 0, pAway = 0, pBtts = 0, pOver25 = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (h > a) pHome += p; else if (h < a) pAway += p; else pDraw += p;
      if (h >= 1 && a >= 1) pBtts += p;
      if (h + a >= 3) pOver25 += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return {
    homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total,
    btts: pBtts / total, over25: pOver25 / total,
  };
}

/** 実スコアから各市場の実際の結果を出す */
function outcomesFromScore(homeGoals, awayGoals) {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  return {
    winner: homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw",
    btts: homeGoals >= 1 && awayGoals >= 1,
    over25: homeGoals + awayGoals >= 3,
  };
}

/**
 * 解決済みの予測1件を全市場で採点する。
 * actualScore(実スコア)が無い古い記録は、1X2(actualWinner)だけ採点する。
 * @returns {object|null} 採点結果。採点材料が無ければnull。
 */
function scorePrediction(record) {
  if (!record || !Number.isFinite(record.homeLambda) || !Number.isFinite(record.awayLambda)) return null;
  const probs = computeMarketProbs(record.homeLambda, record.awayLambda);
  if (!probs) return null;

  const out = { markets: {} };

  // ---- 1X2(勝敗) ----
  const actualWinner = record.actualWinner
    || (record.actualScore ? outcomesFromScore(record.actualScore.home, record.actualScore.away)?.winner : null);
  if (actualWinner) {
    const oneHot = { home: actualWinner === "home" ? 1 : 0, draw: actualWinner === "draw" ? 1 : 0, away: actualWinner === "away" ? 1 : 0 };
    const brier = Math.pow(probs.homeWin - oneHot.home, 2) + Math.pow(probs.draw - oneHot.draw, 2) + Math.pow(probs.awayWin - oneHot.away, 2);
    const pActual = actualWinner === "home" ? probs.homeWin : actualWinner === "away" ? probs.awayWin : probs.draw;
    const maxProb = Math.max(probs.homeWin, probs.draw, probs.awayWin);
    const predictedWinner = probs.homeWin === maxProb ? "home" : probs.awayWin === maxProb ? "away" : "draw";
    out.markets.oneX2 = {
      hit: record.predictedWinner ? record.predictedWinner === actualWinner : predictedWinner === actualWinner,
      brier: round4(brier),
      logLoss: round4(-Math.log(Math.max(P_FLOOR, pActual))),
      confidence: round4(maxProb), // 予測時の自信(較正の材料)
      probs: { homeWin: round4(probs.homeWin), draw: round4(probs.draw), awayWin: round4(probs.awayWin) },
      actual: actualWinner,
    };
  }

  // ---- BTTS / Over-Under 2.5(実スコアがある記録のみ) ----
  const score = record.actualScore;
  const actuals = score ? outcomesFromScore(score.home, score.away) : null;
  if (actuals) {
    out.markets.btts = binaryScore(probs.btts, actuals.btts);
    out.markets.over25 = binaryScore(probs.over25, actuals.over25);
    // 最終スコアの一致(最も難しい市場。参考値として記録)
    if (record.predictedScoreline) {
      out.markets.scoreline = { hit: record.predictedScoreline === `${score.home}-${score.away}`, predicted: record.predictedScoreline, actual: `${score.home}-${score.away}` };
    }
  }
  return out;
}

function binaryScore(prob, actual) {
  const y = actual ? 1 : 0;
  return {
    hit: (prob >= 0.5) === actual,
    brier: round4(Math.pow(prob - y, 2)),
    logLoss: round4(-Math.log(Math.max(P_FLOOR, actual ? prob : 1 - prob))),
    prob: round4(prob),
    actual,
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * 1日分の採点を集計する(合計値で持ち、同じ日の複数回実行はマージで加算できる形)。
 */
function buildDailyAccuracy(scoredList) {
  const agg = emptyDailyAccuracy();
  for (const s of scoredList || []) {
    if (!s || !s.markets) continue;
    for (const m of ["oneX2", "btts", "over25"]) {
      const mk = s.markets[m];
      if (!mk || !Number.isFinite(mk.brier)) continue;
      const a = agg[m];
      a.n++;
      if (mk.hit) a.hits++;
      a.brierSum = round4(a.brierSum + mk.brier);
      a.logLossSum = round4(a.logLossSum + mk.logLoss);
      if (m === "oneX2" && Number.isFinite(mk.confidence)) {
        // Calibration: 自信(最大確率)の帯ごとに「実際に当たった割合」を貯める
        const bin = mk.confidence < 0.45 ? "33-45" : mk.confidence < 0.55 ? "45-55" : mk.confidence < 0.7 ? "55-70" : "70+";
        a.calibration[bin].n++;
        if (mk.hit) a.calibration[bin].hits++;
      }
    }
    if (s.markets.scoreline) {
      agg.scoreline.n++;
      if (s.markets.scoreline.hit) agg.scoreline.hits++;
    }
  }
  return agg;
}

function emptyDailyAccuracy() {
  const bins = () => ({ "33-45": { n: 0, hits: 0 }, "45-55": { n: 0, hits: 0 }, "55-70": { n: 0, hits: 0 }, "70+": { n: 0, hits: 0 } });
  return {
    oneX2: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    btts: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    over25: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    scoreline: { n: 0, hits: 0 },
  };
}

/** 同じ日の2回目以降の実行分を加算マージする(上書きで消さない) */
function mergeDailyAccuracy(a, b) {
  if (!a) return b; if (!b) return a;
  const out = emptyDailyAccuracy();
  for (const m of ["oneX2", "btts", "over25"]) {
    out[m].n = (a[m]?.n || 0) + (b[m]?.n || 0);
    out[m].hits = (a[m]?.hits || 0) + (b[m]?.hits || 0);
    out[m].brierSum = round4((a[m]?.brierSum || 0) + (b[m]?.brierSum || 0));
    out[m].logLossSum = round4((a[m]?.logLossSum || 0) + (b[m]?.logLossSum || 0));
    for (const bin of Object.keys(out[m].calibration)) {
      out[m].calibration[bin].n = (a[m]?.calibration?.[bin]?.n || 0) + (b[m]?.calibration?.[bin]?.n || 0);
      out[m].calibration[bin].hits = (a[m]?.calibration?.[bin]?.hits || 0) + (b[m]?.calibration?.[bin]?.hits || 0);
    }
  }
  out.scoreline.n = (a.scoreline?.n || 0) + (b.scoreline?.n || 0);
  out.scoreline.hits = (a.scoreline?.hits || 0) + (b.scoreline?.hits || 0);
  return out;
}

/** 集計を人間が読む形(的中率%・平均Brier・平均LogLoss・較正表)へ変換 */
function summarizeAccuracy(agg) {
  if (!agg) return null;
  const marketJa = { oneX2: "勝敗(1X2)", btts: "両チーム得点(BTTS)", over25: "オーバー/アンダー2.5" };
  const out = { markets: {}, scoreline: null };
  let any = false;
  for (const m of ["oneX2", "btts", "over25"]) {
    const a = agg[m];
    if (!a || !a.n) { out.markets[m] = { labelJa: marketJa[m], n: 0, measurable: false }; continue; }
    any = true;
    out.markets[m] = {
      labelJa: marketJa[m], measurable: true, n: a.n,
      hitRatePct: round1((a.hits / a.n) * 100),
      avgBrier: round4(a.brierSum / a.n),
      avgLogLoss: round4(a.logLossSum / a.n),
      calibration: Object.entries(a.calibration)
        .filter(([, v]) => v.n > 0)
        .map(([bin, v]) => ({ bin: `${bin}%`, n: v.n, actualHitPct: round1((v.hits / v.n) * 100) })),
    };
  }
  if (agg.scoreline && agg.scoreline.n) {
    out.scoreline = { n: agg.scoreline.n, hitRatePct: round1((agg.scoreline.hits / agg.scoreline.n) * 100) };
  }
  out.measurable = any;
  if (!any) out.reasonJa = "この期間に答え合わせできた予測がありません(試合が無い・まだ結果が出ていない場合は正常です)。";
  return out;
}

async function saveDailyAccuracy(deps, dateKey, aggToday) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON } = deps || {};
  if (!upstashEnabled || !dateKey || !aggToday) return false;
  try {
    const existing = await upstashGetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`).catch(() => null);
    const merged = mergeDailyAccuracy(existing, aggToday);
    await upstashSetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`, merged);
    return true;
  } catch (e) { return false; }
}

/**
 * 昨日・直近7日・直近30日との比較(ご指示⑨「昨日/先週/先月との比較」)。
 * 記録の無い日は欠落として扱い、推測で埋めない。
 */
async function getAccuracyTrend(deps, todayDateKey) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  if (!upstashEnabled) return { available: false, reasonJa: "Upstashが未設定のため測定記録を読み出せません。" };
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const daily = [];
  for (let i = 0; i < 30; i++) {
    const dk = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const agg = await upstashGetJSON(`${ACCURACY_KEY_PREFIX}${dk}`).catch(() => null);
    if (agg) daily.push({ date: dk, agg });
  }
  const sumRange = (rows) => rows.reduce((acc, r) => mergeDailyAccuracy(acc, r.agg), null);
  const today = daily.find((d) => d.date === todayDateKey) || null;
  const yesterdayKey = new Date(base - 86400000).toISOString().slice(0, 10);
  const yesterday = daily.find((d) => d.date === yesterdayKey) || null;
  const last7 = sumRange(daily.filter((d) => d.date !== todayDateKey).slice(0, 7));
  const last30 = sumRange(daily.filter((d) => d.date !== todayDateKey));
  const s = (agg) => summarizeAccuracy(agg);
  const t = today ? s(today.agg) : null;
  const y = yesterday ? s(yesterday.agg) : null;
  return {
    available: true,
    recordedDays: daily.length,
    today: t, yesterday: y, last7Days: s(last7), last30Days: s(last30),
    // 「前日より精度が何%改善したか」: 両日とも測定できた市場だけ差を出す
    vsYesterday: (t && y && t.markets.oneX2.measurable && y.markets.oneX2.measurable)
      ? {
        hitRateDeltaPct: round1(t.markets.oneX2.hitRatePct - y.markets.oneX2.hitRatePct),
        brierDelta: round4(t.markets.oneX2.avgBrier - y.markets.oneX2.avgBrier),
        logLossDelta: round4(t.markets.oneX2.avgLogLoss - y.markets.oneX2.avgLogLoss),
        noteJa: "Brier/LogLossはマイナス(減少)が改善です。",
      }
      : { noteJa: "昨日か今日のどちらかに答え合わせできた予測が無いため、前日比は測定できません。" },
  };
}

module.exports = {
  ACCURACY_KEY_PREFIX,
  computeMarketProbs, outcomesFromScore, scorePrediction,
  buildDailyAccuracy, mergeDailyAccuracy, emptyDailyAccuracy,
  summarizeAccuracy, saveDailyAccuracy, getAccuracyTrend,
};
