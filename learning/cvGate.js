/**
 * server/learning/cvGate.js
 * ------------------------------------------------
 * v102(2026年11月17日)・A「重みの採否を、交差検証と統計の検定で決める」
 *
 * ■ なぜ必要か(本番実測)
 *   重みは 10/15(version 33)から 32日間、一度も変わっていない(11/16 の実測: 候補5・通過0)。
 *   これまでの関門は「古い7割で候補を作り、新しい3割(約480件)で1回だけ比べる」形だった。
 *   1回の分割では、たまたまその3割に合った/合わなかっただけの差と、本物の差を区別できない。
 *   しかも検証に使えるのは全体の3割だけで、小さな改善を見分ける力が足りなかった。
 *
 * ■ ここでやること
 *   記録を時系列の順のまま K 個のかたまり(ブロック)に分け、
 *     ・"blocked"(自社予想の記録用) … 1ブロックを検証用に取り置き、残りで候補を作る。これを全ブロックで繰り返す
 *     ・"forward"(過去試合用)       … ブロックk の検証には、それより前のブロックだけで作った候補を使う(未来を見ない)
 *   どちらも、検証用の試合1件ごとに「現行の重みの損失 − 候補の損失」(正なら候補が良い)を取り、全件を束ねて
 *   平均・標準誤差・z 値を出す(probCalibration.pairedGainStats と同じ「対応のある差」の考え方)。
 *
 * ■ 採用の条件(すべて満たしたときだけ)
 *   ① 束ねた件数が minN 以上               … 少なすぎる記録では判断しない
 *   ② 束ねた平均の改善が minGain 以上       … 意味のある大きさ
 *   ③ z が minZ 以上                        … 偶然では出にくい(1.64 = 片側5%)
 *   ④ 候補を作れた折のうち、ほぼ全部で改善  … 1つの折だけの大当たりで通さない(既定: 折の数−1 以上)
 *   ⑤ 束ねた的中率が accTolPt 以上は落ちない … 劣化禁止の下限
 *
 * ■ 正直な限界
 *   ・折どうしは学習用の記録を共有するので、束ねた標準誤差は少し小さめに出る(交差検証の既知の性質)。④はその補い。
 *   ・関門は毎日同じ記録の大部分で繰り返し試されるので、「1回の検定で5%」より多く偶然が通りうる。
 *     通った変更は小さく(②の大きさ)、次の日以降も同じ関門で試され続ける。
 *   すべて純関数(保存先・外部APIに触れない)。
 */
"use strict";

const DEFAULT_GATE = { minN: 100, minGain: 0.001, minZ: 1.64, accTolPt: 0.5 };

/** n 件を、順番を保ったまま k 個の連続したかたまりに分ける。戻り値は [start, end)(end は含まない)の配列 */
function timeBlocks(n, k) {
  const total = Math.max(0, Math.floor(Number(n) || 0));
  const parts = Math.max(1, Math.floor(Number(k) || 1));
  const out = [];
  for (let i = 0; i < parts; i++) {
    const start = Math.floor((total * i) / parts);
    const end = Math.floor((total * (i + 1)) / parts);
    out.push([start, end]);
  }
  return out;
}

/**
 * 対応のある差の統計。diffs[i] = 現行の損失 − 候補の損失(正 = 候補が良い)。
 * @returns {{ n, gain, se, z }} gain = 平均、se = 平均の標準誤差。件数が2未満なら null
 */
function pairedStats(diffs) {
  const d = (diffs || []).filter((x) => Number.isFinite(x));
  const n = d.length;
  if (n < 2) return { n, gain: n === 1 ? d[0] : null, se: null, z: null };
  let sum = 0, sumSq = 0;
  for (const x of d) { sum += x; sumSq += x * x; }
  const mean = sum / n;
  const variance = Math.max(0, (sumSq / n) - mean * mean) * (n / (n - 1));
  const se = Math.sqrt(variance / n);
  // 全件の差がまったく同じ(ばらつき0)のとき: 改善していれば「偶然ではない」、していなければ 0
  const z = se > 0 ? mean / se : (mean > 0 ? Infinity : 0);
  return { n, gain: mean, se, z };
}

/**
 * 関門の判定(純関数)。
 * @param {{ n, gain, se, z, accDeltaPt, foldsWithCandidate, positiveFolds }} stats
 * @param {{ minN, minGain, minZ, accTolPt, minPositiveFolds }} [opts]
 * @returns {{ pass: boolean, checks: object, reasonJa: string }}
 */
function decideCvGate(stats, opts) {
  const s = stats || {};
  const o = { ...DEFAULT_GATE, ...(opts || {}) };
  const num = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : null);
  const n = num(s.n), gain = num(s.gain), z = num(s.z), acc = num(s.accDeltaPt);
  const fc = Number.isFinite(s.foldsWithCandidate) ? s.foldsWithCandidate : null;
  const pf = Number.isFinite(s.positiveFolds) ? s.positiveFolds : null;
  // 「ほぼ全部の折」= 候補を作れた折の数 − 1(候補を作れた折が1つだけなら、その1つ)
  const needFolds = Number.isFinite(o.minPositiveFolds) ? o.minPositiveFolds : (fc === null ? null : Math.max(1, fc - 1));
  const checks = {
    enough: n !== null && n >= o.minN,
    gainOk: gain !== null && gain >= o.minGain,
    zOk: z !== null && z >= o.minZ,
    foldsOk: fc !== null && fc > 0 && pf !== null && needFolds !== null && pf >= needFolds,
    accOk: acc !== null && acc >= -o.accTolPt,
  };
  const pass = checks.enough && checks.gainOk && checks.zOk && checks.foldsOk && checks.accOk;
  const r4 = (x) => (x === null ? "測定不可" : (Number.isFinite(x) ? String(Math.round(x * 10000) / 10000) : (x > 0 ? "∞" : "−∞")));
  const r2 = (x) => (x === null ? "測定不可" : (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : (x > 0 ? "∞" : "−∞")));
  let reasonJa;
  if (!checks.enough) reasonJa = `検証に使えた記録が${n === null ? 0 : n}件で、統計的に判断できる件数(${o.minN}件)に達していません。`;
  else if (fc === null || fc === 0) reasonJa = "どの区間でも候補を作れなかったため、比べるものがありません。";
  else if (!checks.gainOk) reasonJa = `束ねた改善が${r4(gain)}で、意味のある大きさ(${o.minGain}以上)に達していません。`;
  else if (!checks.zOk) reasonJa = `改善は${r4(gain)}ありましたが、z=${r2(z)}で、偶然と区別できる水準(${o.minZ}以上)に達していません。`;
  else if (!checks.foldsOk) reasonJa = `改善した区間が${pf}/${fc}で、ほぼ全部の区間(${needFolds}以上)では改善していません(一部の時期だけの当たりの可能性)。`;
  else if (!checks.accOk) reasonJa = `確率の質は改善しましたが、的中率が${r2(acc)}pt 変化し、許容幅(−${o.accTolPt}pt)を超えて下がりました。`;
  else reasonJa = `検証${n}件を束ねて、改善${r4(gain)}・z=${r2(z)}・改善した区間${pf}/${fc}・的中率の変化${acc >= 0 ? "+" : ""}${r2(acc)}pt。条件をすべて満たしました。`;
  return { pass, checks, needPositiveFolds: needFolds, reasonJa };
}

/**
 * 交差検証の本体。
 * @param {Array} records 時系列の昇順(古い → 新しい)
 * @param {object} opts
 *   - folds: かたまりの数(既定5)
 *   - scheme: "blocked" | "forward"
 *   - procedure(trainRecords, info) → 候補の重み(または null = この折では候補なし)。info = { fold, validStart, validEnd }
 *   - lossOf(record, weights) → { nll: number, hit: 0|1 }   候補の評価
 *   - baseLossOf(record) → { nll, hit }                      現行の重みの評価(省略時は lossOf(record, baseWeights))
 *   - baseWeights: 現行の重み(baseLossOf を渡さないとき必須)
 *   - prepareFold(info) → 任意。折ごとの前処理(過去試合で、その折の学習範囲だけからレーティングを作る など)
 *   - groupOf(record) → 任意。内訳を出したいときのグループのキー(リーグID など)。戻り値に byGroup が付く
 *   - minValid: 検証用のかたまりの最小件数(既定20。これ未満の折は飛ばす)
 *   - minTrain: 学習用の最小件数(既定20)
 * @returns {{ scheme, foldsPlanned, folds: Array, n, gain, se, z, baseNll, candNll, accBasePct, accCandPct, accDeltaPt,
 *             foldsWithCandidate, positiveFolds }}
 */
function crossValidate(records, opts) {
  const o = opts || {};
  const list = Array.isArray(records) ? records : [];
  const k = Math.max(2, Math.floor(o.folds || 5));
  const scheme = o.scheme === "forward" ? "forward" : "blocked";
  const minValid = Number.isFinite(o.minValid) ? o.minValid : 20;
  const minTrain = Number.isFinite(o.minTrain) ? o.minTrain : 20;
  const blocks = timeBlocks(list.length, k);
  const baseLossOf = typeof o.baseLossOf === "function" ? o.baseLossOf : (r) => o.lossOf(r, o.baseWeights);
  const diffs = [];
  const folds = [];
  let baseNllSum = 0, candNllSum = 0, baseHits = 0, candHits = 0;
  let foldsWithCandidate = 0, positiveFolds = 0;
  const groupOf = typeof o.groupOf === "function" ? o.groupOf : null;
  const groups = new Map(); // グループのキー → { diffs, baseSum, candSum, baseHits, candHits }
  for (let f = 0; f < blocks.length; f++) {
    if (scheme === "forward" && f === 0) continue; // 最初のかたまりは、それより前が無いので検証に使わない
    const [vs, ve] = blocks[f];
    const valid = list.slice(vs, ve);
    const train = scheme === "forward" ? list.slice(0, vs) : list.slice(0, vs).concat(list.slice(ve));
    const info = { fold: f, validStart: vs, validEnd: ve, trainSize: train.length, validSize: valid.length };
    if (valid.length < minValid || train.length < minTrain) {
      folds.push({ ...info, skipped: true, reasonJa: `この区間は学習用${train.length}件・検証用${valid.length}件で、必要な件数(${minTrain}件・${minValid}件)に足りません。` });
      continue;
    }
    if (typeof o.prepareFold === "function") o.prepareFold(info, train, valid);
    let cand = null, procError = null;
    try { cand = o.procedure(train, info) || null; } catch (e) { cand = null; procError = String((e && e.message) || e).slice(0, 120); }
    let fSum = 0, fBase = 0, fCand = 0;
    for (const r of valid) {
      const b = baseLossOf(r);
      const c = cand ? o.lossOf(r, cand) : b; // 候補を作れなかった折は「現行のまま」= 差0(改善を水増ししない)
      if (!b || !c || !Number.isFinite(b.nll) || !Number.isFinite(c.nll)) continue;
      const d = b.nll - c.nll;
      diffs.push(d); fSum += d;
      baseNllSum += b.nll; candNllSum += c.nll;
      baseHits += b.hit ? 1 : 0; candHits += c.hit ? 1 : 0;
      fBase += b.nll; fCand += c.nll;
      if (groupOf) {
        const key = groupOf(r);
        let g = groups.get(key);
        if (!g) { g = { diffs: [], baseSum: 0, candSum: 0, baseHits: 0, candHits: 0 }; groups.set(key, g); }
        g.diffs.push(d); g.baseSum += b.nll; g.candSum += c.nll; g.baseHits += b.hit ? 1 : 0; g.candHits += c.hit ? 1 : 0;
      }
    }
    const fGain = valid.length ? fSum / valid.length : null;
    if (cand) { foldsWithCandidate++; if (fGain !== null && fGain > 0) positiveFolds++; }
    folds.push({
      ...info, skipped: false, candidate: !!cand, ...(procError ? { procError } : {}),
      gain: fGain === null ? null : Math.round(fGain * 100000) / 100000,
      baseNll: valid.length ? Math.round((fBase / valid.length) * 10000) / 10000 : null,
      candNll: valid.length ? Math.round((fCand / valid.length) * 10000) / 10000 : null,
    });
  }
  const st = pairedStats(diffs);
  const n = st.n;
  const pct = (h) => (n ? Math.round((h / n) * 1000) / 10 : null);
  const accBasePct = pct(baseHits), accCandPct = pct(candHits);
  return {
    scheme, foldsPlanned: k, folds,
    n, gain: st.gain, se: st.se, z: st.z,
    baseNll: n ? baseNllSum / n : null, candNll: n ? candNllSum / n : null,
    accBasePct, accCandPct,
    accDeltaPt: (accBasePct === null || accCandPct === null) ? null : Math.round((accCandPct - accBasePct) * 10) / 10,
    foldsWithCandidate, positiveFolds,
    // グループ別の内訳(groupOf を渡したときだけ)。全体と同じ行・同じ損失を、グループごとに束ね直したもの
    ...(groupOf ? {
      byGroup: [...groups.entries()].map(([key, g]) => {
        const gs = pairedStats(g.diffs);
        const m = g.diffs.length;
        return {
          key, n: m, gain: gs.gain, se: gs.se, z: gs.z,
          baseNll: m ? g.baseSum / m : null, candNll: m ? g.candSum / m : null,
          accBasePct: m ? Math.round((g.baseHits / m) * 1000) / 10 : null, accCandPct: m ? Math.round((g.candHits / m) * 1000) / 10 : null,
        };
      }).sort((a, b) => b.n - a.n),
    } : {}),
  };
}

/** 記録に残す用に、交差検証の結果を丸めて短くする */
function summarizeCv(cv, decision) {
  if (!cv) return null;
  const r = (x, d) => (Number.isFinite(x) ? Math.round(x * Math.pow(10, d)) / Math.pow(10, d) : (x === Infinity ? "Infinity" : null));
  return {
    scheme: cv.scheme, folds: cv.foldsPlanned,
    n: cv.n, pooledGain: r(cv.gain, 5), pooledSe: r(cv.se, 5), z: r(cv.z, 2),
    baseLogLoss: r(cv.baseNll, 4), candLogLoss: r(cv.candNll, 4),
    accBasePct: cv.accBasePct, accCandPct: cv.accCandPct, accDeltaPt: cv.accDeltaPt,
    foldsWithCandidate: cv.foldsWithCandidate, positiveFolds: cv.positiveFolds,
    perFold: (cv.folds || []).map((f) => (f.skipped
      ? { fold: f.fold, skipped: true }
      : { fold: f.fold, train: f.trainSize, valid: f.validSize, candidate: f.candidate, gain: f.gain })),
    ...(decision ? { passed: !!decision.pass, reasonJa: decision.reasonJa } : {}),
  };
}

module.exports = { DEFAULT_GATE, timeBlocks, pairedStats, decideCvGate, crossValidate, summarizeCv };
