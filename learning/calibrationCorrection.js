/**
 * server/learning/calibrationCorrection.js
 * ------------------------------------------------
 * 2026年8月・精度証明ラウンド②: 較正(Calibration)に基づく自信の自動補正。
 * v14で毎日測定しているECE(自信の帯ごとの「申告した自信」と「実際の的中率」の
 * ズレ)を使い、翌日以降の予想の表示勝率を実績側へ自動補正する(FiveThirtyEight
 * などが実際に行っている方式)。
 *
 * ■ でっち上げ防止
 *   ・補正の材料は保存済みの実測(直近30日の答え合わせ)だけ。
 *   ・サンプルが少ない帯(既定20件未満)は補正しない(少数の偶然で
 *     数字をいじらない)。補正できない理由は必ず言葉で返す。
 *   ・補正後もモデルの生の値を必ず併記する(数字のすり替えをしない)。
 */

const MIN_BIN_SAMPLES = 20; // この件数未満の帯は補正しない(偶然の上下で数字を動かさない)

/**
 * 毎日の学習の最後に、直近30日のECEレポート(accuracyTracker.computeEceの出力)
 * から補正マップを作る。ECEが測定できない期間は「補正なし」を正直に保存する。
 */
function buildCalibrationMap(eceReport, builtAtIso) {
  if (!eceReport || !eceReport.measurable || !Array.isArray(eceReport.bins) || !eceReport.bins.length) {
    return {
      available: false,
      reasonJa: (eceReport && eceReport.reasonJa) || "答え合わせ済みの予測がまだ足りないため、自信の補正はまだ行いません(実測が貯まり次第、自動で始まります)。",
      builtAt: builtAtIso || null,
    };
  }
  const bins = {};
  for (const b of eceReport.bins) {
    bins[b.bin] = { n: b.n, avgConfPct: b.avgConfPct, actualHitPct: b.actualHitPct };
  }
  return {
    available: true,
    builtAt: builtAtIso || null,
    builtFromN: eceReport.measuredOnN || null,
    minN: MIN_BIN_SAMPLES,
    bins,
    noteJa: `直近の答え合わせ${eceReport.measuredOnN || "?"}件の実測から作成。各帯${MIN_BIN_SAMPLES}件以上のときだけ補正します。`,
  };
}

/** accuracyTrackerの較正ビンと同じ境界(33-45 / 45-55 / 55-70 / 70+) */
function binKeyOfPct(pct) {
  const p = pct / 100;
  const bin = p < 0.45 ? "33-45" : p < 0.55 ? "45-55" : p < 0.7 ? "55-70" : "70+";
  return `${bin}%`;
}

/**
 * 予想の表示勝率(%)に補正を適用する。
 * 補正量 = その帯の「実際の的中率 − 申告した自信の平均」(実測のズレそのもの)。
 * 適用できない場合はnull(呼び出し側は生の値だけを表示する)。
 */
function applyCalibration(rawPct, map) {
  if (!Number.isFinite(rawPct) || !map || !map.available) return null;
  const key = binKeyOfPct(rawPct);
  const b = map.bins ? map.bins[key] : null;
  if (!b || !Number.isFinite(b.n) || b.n < (map.minN || MIN_BIN_SAMPLES)) return null;
  const deltaPt = Math.round((b.actualHitPct - b.avgConfPct) * 10) / 10;
  const calibratedPct = Math.max(1, Math.min(99, Math.round(rawPct + deltaPt)));
  return {
    calibratedPct,
    rawPct: Math.round(rawPct),
    deltaPt,
    basisN: b.n,
    bin: key,
    noteJa: `同じ自信帯(${key})の直近実測${b.n}件では、申告${b.avgConfPct}%に対し実際は${b.actualHitPct}%だったため、${deltaPt > 0 ? "+" : ""}${deltaPt}pt補正しています(モデル生値${Math.round(rawPct)}%)。`,
  };
}

module.exports = { buildCalibrationMap, applyCalibration, binKeyOfPct, MIN_BIN_SAMPLES };
