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
 *   ・サンプルが少ない帯(既定20件未満)の数字は補正の材料にしない(少数の偶然で
 *     数字をいじらない)。補正できない理由は必ず言葉で返す。
 *   ・v104.1: 帯の境目で数字が逆転しないよう、帯ごとの実測を点としてなめらかにつなぐ
 *     (下の「帯の境目で数字が逆転しない補正」を参照)。
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
    noteJa: `直近の答え合わせ${eceReport.measuredOnN || "?"}件の実測から作成。各帯${MIN_BIN_SAMPLES}件以上の実測だけを補正の材料にします。`,
  };
}

/** accuracyTrackerの較正ビンと同じ境界(33-45 / 45-55 / 55-70 / 70+) */
function binKeyOfPct(pct) {
  const p = pct / 100;
  const bin = p < 0.45 ? "33-45" : p < 0.55 ? "45-55" : p < 0.7 ? "55-70" : "70+";
  return `${bin}%`;
}

// ---- v104.1(総点検): 帯の境目で数字が逆転しない補正 ----
//   以前は「帯ごとに同じ幅だけ足し引きする」方式だった(45〜55%の帯は +6pt、55〜70%の帯は +0.5pt、70%以上は -5pt…)。
//   このやり方だと帯の境目で段差ができ、モデルの値が低い予想のほうが高く表示される逆転が起きる
//   (本番の実測値での例: 生値54% → 表示60% / 生値56% → 表示56%、生値69% → 表示70% / 生値72% → 表示67%)。
//   自信ランク(S/A/B)はこの表示の数字で決めるため、ランクまで入れ替わっていた(Sに「生値69%台」と「75%以上」だけが入り、
//   70〜74%が抜ける穴ができる)。
//   直し方: 帯ごとの実測を「その帯の平均の自信 → 実際の的中率」という1つの点とみなし、点と点のあいだを直線でつなぐ。
//     ・自信が高い帯ほど的中率が低い、という実測の逆転(件数の少なさによる偶然)は、隣どうしを件数で重みづけして均す
//       (単調回帰・PAV)。これで「モデルの値が高い予想ほど、表示も高い(同じか上)」が必ず成り立つ。
//     ・実測が足りない帯(既定20件未満)の数字は、これまでどおり材料にしない。その帯の中心では「モデルの値のまま」を点にする。
//     ・いちばん下の点より下・いちばん上の点より上は、端の点と同じ幅だけ足し引きする(従来と同じ)。
//   帯の中心付近の数字は従来とほぼ同じで、変わるのは境目の近くだけ。勝敗の予想と確率そのものは一切変えない(表示とランクだけ)。
const BIN_ORDER = ["33-45%", "45-55%", "55-70%", "70+%"];
const BIN_RANGE = { "33-45%": [33, 45], "45-55%": [45, 55], "55-70%": [55, 70], "70+%": [70, 100] };
const BIN_CENTER = { "33-45%": 39, "45-55%": 50, "55-70%": 62.5, "70+%": 80 };
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * 補正の曲線(点の並び)を作る。各点: { bin, x(平均の自信%), y(補正後の%), n, evidence(実測を材料にしたか), evN(均した範囲の実測件数), evBins }
 * 使える実測が1つも無いときは null。
 */
function calibrationCurveOf(map) {
  if (!map || !map.available || !map.bins || typeof map.bins !== "object") return null;
  const minN = Number.isFinite(map.minN) && map.minN > 0 ? map.minN : MIN_BIN_SAMPLES;
  const pts = [];
  for (const key of BIN_ORDER) {
    const b = map.bins[key] || null;
    const n = b && Number.isFinite(b.n) && b.n > 0 ? b.n : 0;
    const [lo, hi] = BIN_RANGE[key];
    const avgOk = n > 0 && Number.isFinite(b.avgConfPct) && b.avgConfPct >= lo - 0.5 && b.avgConfPct <= hi + 0.5;
    const evidence = n >= minN && avgOk && Number.isFinite(b.actualHitPct) && b.actualHitPct >= 0 && b.actualHitPct <= 100;
    const x = avgOk ? b.avgConfPct : BIN_CENTER[key];
    pts.push({ bin: key, x, y: evidence ? b.actualHitPct : x, rawY: evidence ? b.actualHitPct : null, n, evidence, w: evidence ? n : 1 });
  }
  if (!pts.some((p) => p.evidence)) return null;
  // 単調回帰(PAV): 左から見て、前の点より低くなったら、件数で重みづけした平均に均す
  const blocks = [];
  for (let i = 0; i < pts.length; i++) {
    blocks.push({ y: pts[i].y, w: pts[i].w, from: i, to: i });
    while (blocks.length >= 2 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y + 1e-12) {
      const b2 = blocks.pop(), b1 = blocks.pop();
      const w = b1.w + b2.w;
      blocks.push({ y: (b1.y * b1.w + b2.y * b2.w) / w, w, from: b1.from, to: b2.to });
    }
  }
  for (const blk of blocks) {
    const members = pts.slice(blk.from, blk.to + 1);
    const evMembers = members.filter((p) => p.evidence);
    const evN = evMembers.reduce((a, p) => a + p.n, 0);
    for (const p of members) { p.y = blk.y; p.pooled = members.length > 1; p.evN = evN; p.evBins = evMembers.map((q) => q.bin); }
  }
  return pts;
}

/** 曲線の上で、モデルの値(%)に対応する補正後の値と、その材料になった点を返す */
function evalCurve(curve, rawPct) {
  const first = curve[0], last = curve[curve.length - 1];
  if (rawPct <= first.x) return { y: rawPct + (first.y - first.x), used: [first] };
  if (rawPct >= last.x) return { y: rawPct + (last.y - last.x), used: [last] };
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i], b = curve[i + 1];
    if (rawPct >= a.x && rawPct < b.x) {
      const span = b.x - a.x;
      if (!(span > 1e-6)) return { y: b.y, used: [a, b] };
      return { y: a.y + ((rawPct - a.x) / span) * (b.y - a.y), used: [a, b] };
    }
  }
  return { y: rawPct + (last.y - last.x), used: [last] };
}

/**
 * 予想の表示勝率(%)に補正を適用する。
 * 帯ごとの実測(平均の自信 → 実際の的中率)をつないだ曲線で読み替える(上の説明を参照)。
 * 材料にできる実測が無い範囲では null(呼び出し側は生の値だけを表示する)。
 */
function applyCalibration(rawPct, map) {
  if (!Number.isFinite(rawPct) || !map || !map.available) return null;
  const curve = calibrationCurveOf(map);
  if (!curve) return null;
  const { y, used } = evalCurve(curve, rawPct);
  // 材料になった実測(均した範囲も含む)。1件も無ければ補正しない
  const evBins = [];
  for (const p of used) for (const k of p.evBins || []) if (!evBins.includes(k)) evBins.push(k);
  if (!evBins.length) return null;
  const basisN = evBins.reduce((a, k) => a + map.bins[k].n, 0);
  const key = binKeyOfPct(rawPct);
  const deltaPt = round1(y - rawPct);
  const calibratedPct = Math.max(1, Math.min(99, Math.round(y)));
  const parts = evBins.map((k) => `${k}の帯: 申告${map.bins[k].avgConfPct}%に対し実際は${map.bins[k].actualHitPct}%・${map.bins[k].n}件`);
  return {
    calibratedPct,
    rawPct: Math.round(rawPct),
    deltaPt,
    basisN,
    bin: key,
    method: "curve",
    basisBins: evBins,
    noteJa: `近い自信帯の直近の実測(${parts.join(" / ")})をもとに、${deltaPt > 0 ? "+" : ""}${deltaPt}pt補正しています(モデル生値${Math.round(rawPct)}%)。帯の境目で数字が逆転しないよう、帯と帯のあいだはなめらかにつないでいます。`,
  };
}

module.exports = { buildCalibrationMap, applyCalibration, calibrationCurveOf, binKeyOfPct, MIN_BIN_SAMPLES };
