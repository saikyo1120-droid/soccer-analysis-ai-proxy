/**
 * server/learning/predictionShift.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示①)。
 * 「何を学習したか」ではなく「その学習によって予測がどう変わったか」を保存する。
 *
 * 重みが更新されたとき、直近の検証済み試合(同じ特徴量)に対して
 * 旧重みと新重みの両方で予測を計算し、
 *   ・ホーム勝率が平均 +2.4%
 *   ・引き分け確率が平均 -1.8%
 *   ・期待得点(合計λ)が +0.31
 *   ・自信(最大確率)が +4%
 * のような「AIの判断の変化」を実際の計算値の差としてだけ記録する。
 *
 * でっち上げ防止: すべて predictOutcomeV2 + ポアソン分布の実計算の差分。
 * 「賢くなったように見える文章」をAIが作文することはない。
 */

const { predictOutcomeV2, computeMatchProbabilitiesRaw } = require("./predictionModel");

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

/**
 * @param {Array} records - features を持つ予測記録(直近の検証済みが望ましい)
 * @param {object} oldWeights
 * @param {object} newWeights
 * @returns {object|null} 平均変化と代表例。計算材料が無ければnull。
 */
function computePredictionShift(records, oldWeights, newWeights) {
  const usable = (records || []).filter((r) => r && r.features && typeof r.features === "object");
  if (!usable.length || !oldWeights || !newWeights) return null;
  let dHome = 0, dDraw = 0, dAway = 0, dExpGoals = 0, dConf = 0;
  let biggest = null;
  for (const r of usable) {
    const before = predictOutcomeV2(r.features, oldWeights);
    const after = predictOutcomeV2(r.features, newWeights);
    const pb = computeMatchProbabilitiesRaw(before.homeLambda, before.awayLambda);
    const pa = computeMatchProbabilitiesRaw(after.homeLambda, after.awayLambda);
    const dh = (pa.homeWin - pb.homeWin) * 100;
    const dd = (pa.draw - pb.draw) * 100;
    const da = (pa.awayWin - pb.awayWin) * 100;
    const dg = (after.homeLambda + after.awayLambda) - (before.homeLambda + before.awayLambda);
    const dc = (Math.max(pa.homeWin, pa.draw, pa.awayWin) - Math.max(pb.homeWin, pb.draw, pb.awayWin)) * 100;
    dHome += dh; dDraw += dd; dAway += da; dExpGoals += dg; dConf += dc;
    const magnitude = Math.abs(dh) + Math.abs(dd) + Math.abs(da);
    if (!biggest || magnitude > biggest.magnitude) {
      biggest = {
        magnitude,
        matchJa: `${r.homeTeamEn || "?"} vs ${r.awayTeamEn || "?"}`,
        homeWinPctBefore: round1(pb.homeWin * 100), homeWinPctAfter: round1(pa.homeWin * 100),
        drawPctBefore: round1(pb.draw * 100), drawPctAfter: round1(pa.draw * 100),
        awayWinPctBefore: round1(pb.awayWin * 100), awayWinPctAfter: round1(pa.awayWin * 100),
        winnerBefore: before.predictedWinner, winnerAfter: after.predictedWinner,
        flipped: before.predictedWinner !== after.predictedWinner,
      };
    }
  }
  const n = usable.length;
  const shift = {
    sampleSize: n,
    homeWinPctDelta: round1(dHome / n),
    drawPctDelta: round1(dDraw / n),
    awayWinPctDelta: round1(dAway / n),
    expectedGoalsDelta: round2(dExpGoals / n),
    confidencePctDelta: round1(dConf / n),
    biggestExample: biggest ? { ...biggest, magnitude: undefined } : null,
  };
  shift.summaryJa = describeShiftJa(shift);
  return shift;
}

/** 変化を日本語1〜3行で説明する(実際の数値のみから機械的に生成) */
function describeShiftJa(shift) {
  if (!shift) return null;
  const parts = [];
  const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
  if (Math.abs(shift.homeWinPctDelta) >= 0.1) parts.push(`ホーム勝率の見方が平均${sign(shift.homeWinPctDelta)}%変化`);
  if (Math.abs(shift.drawPctDelta) >= 0.1) parts.push(`引き分け確率が平均${sign(shift.drawPctDelta)}%変化`);
  if (Math.abs(shift.awayWinPctDelta) >= 0.1) parts.push(`アウェイ勝率が平均${sign(shift.awayWinPctDelta)}%変化`);
  if (Math.abs(shift.expectedGoalsDelta) >= 0.01) parts.push(`1試合の期待得点(合計)が平均${sign(shift.expectedGoalsDelta)}点変化`);
  if (Math.abs(shift.confidencePctDelta) >= 0.1) parts.push(`予測の自信が平均${sign(shift.confidencePctDelta)}%変化`);
  if (!parts.length) return `重みは更新されましたが、直近${shift.sampleSize}試合への予測はほとんど変わりませんでした(微調整)。`;
  let s = `この学習で、直近${shift.sampleSize}試合に対するAIの判断が変わりました: ${parts.join("、")}。`;
  if (shift.biggestExample && shift.biggestExample.flipped) {
    const b = shift.biggestExample;
    s += ` 最も大きく変わった試合(${b.matchJa})では、予想勝者が${w2ja(b.winnerBefore)}から${w2ja(b.winnerAfter)}に変わりました。`;
  }
  return s;
}

function w2ja(w) { return w === "home" ? "ホーム" : w === "away" ? "アウェイ" : "引き分け"; }

module.exports = { computePredictionShift, describeShiftJa };
