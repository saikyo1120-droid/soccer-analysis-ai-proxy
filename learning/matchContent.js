"use strict";
/**
 * v104(2026年11月12日)・J「試合内容の予測」
 * ----------------------------------------------------------------------------
 * 利用者の最終目標「試合内容もおおかた予測できるAI」への最初の一歩。
 *
 * ■ これまで
 *   予想カードの「両チーム得点」「3点以上」「スコア上位5件」は、自前モデルの期待得点
 *   λ(homeLambda / awayLambda)だけから作っていた。一方、公開している勝敗の確率
 *   (finalProbs)は市場オッズと混合し温度較正まで済ませた値なので、**勝敗の確率と
 *   試合内容の確率が別々の分布から出ていた**(「ホーム勝利52%」と言いながら、スコア分布は
 *   λ だけの別世界)。
 *
 * ■ この版で足すこと
 *   1. 「最終の勝敗確率と整合するスコア分布」(fin): finalProbs の P(home)・P(away) を
 *      再現する期待得点の組(λh', λa')を数値的に解き(Dixon-Coles のρ込み)、その格子から
 *      合計得点の見込み・2.5点以上・両チーム得点・スコア上位・無失点率を出す。
 *   2. 従来の λ だけの分布(raw)も同じ記録に残し、答え合わせで**両方を採点**する
 *      (Brier: 2.5点以上と両チーム得点の平均)。試合ごとの差 d_i = Brier(raw) − Brier(fin) を
 *      束ねた z 検定(v101 の較正と同じ方式)で、fin が本当に良いときだけ表示に採用する
 *      (劣化禁止: 既定は raw のまま。採用後に有意に悪化したら raw へ戻す)。
 *   3. 2.5点以上・両チーム得点の確率に、v101 と同じ関門つきの温度較正(logit 尺度)を掛ける。
 *   4. 「試合の見立て」の一言(接戦/優勢・ロースコア/打ち合い)を分布から機械的に作る
 *      (作文ではなく閾値の分類。閾値は README に開示)。
 *   勝敗の予想(1X2)そのものは1ビットも変えない(argmax・finalProbs は不変)。
 * ■ 保存先コマンド: 予想記録に content を同居させるだけ(+0)。モデルは1キー(MODEL_KEY)。
 */
const { scoreGrid, LAMBDA_MIN, LAMBDA_MAX } = require("./predictionModel");

const MODEL_KEY = "learn:content:model";
const DEFAULT_OPTS = {
  minCompareN: 100, minGain: 0.001, minZ: 1.64,            // 表示元(raw/fin)の切り替え関門
  minTrain: 80, minValid: 30, minCalGain: 0.002,            // 較正の関門(v101 と同じ)
  tMin: 0.6, tMax: 1.6, tStep: 0.025,
};
const P_FLOOR = 0.005;
const GRID_CAP = 8;

function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
function round6(v) { return Math.round(v * 1000000) / 1000000; }
function clampLambda(v) { return Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, v)); }

/** スコア格子から試合内容の指標をまとめて取り出す(勝敗確率も同じ格子から) */
function gridMetrics(homeLambda, awayLambda, rho) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const grid = scoreGrid(homeLambda, awayLambda, GRID_CAP, rho || 0);
  let pHome = 0, pDraw = 0, pAway = 0, over25 = 0, btts = 0, homeCs = 0, awayCs = 0, expTotal = 0;
  const cells = [];
  for (let h = 0; h <= GRID_CAP; h++) {
    for (let a = 0; a <= GRID_CAP; a++) {
      const p = grid[h][a];
      if (h > a) pHome += p; else if (h < a) pAway += p; else pDraw += p;
      if (h + a > 2.5) over25 += p;
      if (h > 0 && a > 0) btts += p;
      if (a === 0) homeCs += p;
      if (h === 0) awayCs += p;
      expTotal += (h + a) * p;
      cells.push({ scoreline: `${h}-${a}`, p });
    }
  }
  cells.sort((x, y) => y.p - x.p);
  return {
    pHome, pDraw, pAway, over25, btts, homeCs, awayCs, expTotal,
    top: cells.slice(0, 5).map((c) => ({ scoreline: c.scoreline, p: round4(c.p) })),
  };
}

/**
 * finalProbs(P(home), P(away))を再現する λ の組を Newton 法で解く(ρ込み)。
 * 2未知数(log λh, log λa)・2方程式。収束しなければ ok:false(呼び出し側は raw を使う)。
 */
function solveLambdasForProbs(targetHome, targetAway, rho, init) {
  const tH = Number(targetHome), tA = Number(targetAway);
  if (!(tH > 0.02 && tA > 0.02 && tH < 0.96 && tA < 0.96 && tH + tA < 0.985)) return { ok: false, reason: "target_out_of_range" };
  let u = Math.log(clampLambda(Number(init && init.homeLambda) || 1.3));
  let v = Math.log(clampLambda(Number(init && init.awayLambda) || 1.1));
  const F = (uu, vv) => {
    const m = gridMetrics(Math.exp(uu), Math.exp(vv), rho);
    return [m.pHome - tH, m.pAway - tA];
  };
  const h = 1e-4;
  let f = F(u, v);
  let residual = Math.abs(f[0]) + Math.abs(f[1]);
  let it = 0;
  for (; it < 40 && residual > 2e-4; it++) {
    const fu = F(u + h, v), fv = F(u, v + h);
    const J = [[(fu[0] - f[0]) / h, (fv[0] - f[0]) / h], [(fu[1] - f[1]) / h, (fv[1] - f[1]) / h]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    let du = -(J[1][1] * f[0] - J[0][1] * f[1]) / det;
    let dv = -(-J[1][0] * f[0] + J[0][0] * f[1]) / det;
    // 減衰: 1ステップで λ が3倍以上動かないようにする(発散防止)
    const cap = 1.0;
    du = Math.max(-cap, Math.min(cap, du));
    dv = Math.max(-cap, Math.min(cap, dv));
    let step = 1;
    let accepted = false;
    for (let k = 0; k < 6; k++) {
      const nu = Math.log(clampLambda(Math.exp(u + du * step)));
      const nv = Math.log(clampLambda(Math.exp(v + dv * step)));
      const nf = F(nu, nv);
      const nr = Math.abs(nf[0]) + Math.abs(nf[1]);
      if (nr < residual) { u = nu; v = nv; f = nf; residual = nr; accepted = true; break; }
      step /= 2;
    }
    if (!accepted) break;
  }
  const homeLambda = Math.exp(u), awayLambda = Math.exp(v);
  const ok = residual <= 2e-3 && homeLambda > LAMBDA_MIN - 1e-9 && awayLambda > LAMBDA_MIN - 1e-9;
  return { ok, homeLambda: round3(homeLambda), awayLambda: round3(awayLambda), iterations: it, residual: round4(residual), reason: ok ? null : "not_converged" };
}

/** 二値確率の温度較正(logit 尺度)。T=1 で恒等 */
function temperBinary(p, T) {
  const t = Number(T);
  const q = Math.min(1 - P_FLOOR, Math.max(P_FLOOR, Number(p)));
  if (!Number.isFinite(t) || t <= 0 || t === 1) return q;
  const logit = Math.log(q / (1 - q)) / t;
  return 1 / (1 + Math.exp(-logit));
}

function binaryNll(p, y) {
  const q = Math.min(1 - P_FLOOR, Math.max(P_FLOOR, p));
  return -Math.log(y ? q : 1 - q);
}

/** 試合ごとの NLL 改善 d_i = NLL(base) − NLL(T) を束ねた平均・標準誤差・z */
function pairedGainStatsBinary(samples, T) {
  const n = samples.length;
  if (!n) return { gain: 0, se: 0, z: 0, n: 0 };
  let sum = 0, sumSq = 0;
  for (const s of samples) {
    const d = binaryNll(s.p, s.y) - binaryNll(temperBinary(s.p, T), s.y);
    sum += d; sumSq += d * d;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const se = n > 1 ? Math.sqrt(variance / (n - 1)) : 0;
  return { gain: mean, se, z: se > 0 ? mean / se : 0, n };
}

/** v101 の温度較正と同じ関門で、二値市場(2.5点以上 / 両チーム得点)の T を学習する */
function fitBinaryTemperature(samples, opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const sorted = (samples || []).filter((s) => s && Number.isFinite(s.p) && (s.y === 0 || s.y === 1))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  const n = sorted.length;
  const nTrain = Math.floor(n * 0.7);
  const nValid = n - nTrain;
  const base = { T: 1, adopted: false, nTrain, nValid, validNllBase: null, validNllT: null, validGain: null, validGainZ: null, reasonJa: null };
  if (nTrain < o.minTrain || nValid < o.minValid) {
    return { ...base, reasonJa: `件数不足(学習${nTrain}件/検証${nValid}件。必要 ${o.minTrain}/${o.minValid})のため較正なし(T=1)` };
  }
  const train = sorted.slice(0, nTrain), valid = sorted.slice(nTrain);
  let bestT = 1, bestNll = Infinity;
  for (let T = o.tMin; T <= o.tMax + 1e-9; T += o.tStep) {
    const t = Math.round(T * 1000) / 1000;
    let s = 0;
    for (const x of train) s += binaryNll(temperBinary(x.p, t), x.y);
    if (s < bestNll - 1e-12) { bestNll = s; bestT = t; }
  }
  const validBase = valid.reduce((acc, x) => acc + binaryNll(x.p, x.y), 0) / valid.length;
  const validT = valid.reduce((acc, x) => acc + binaryNll(temperBinary(x.p, bestT), x.y), 0) / valid.length;
  const st = pairedGainStatsBinary(valid, bestT);
  const adopted = bestT !== 1 && st.gain >= o.minCalGain && st.z >= o.minZ;
  return {
    T: adopted ? bestT : 1, adopted, nTrain, nValid,
    validNllBase: round4(validBase), validNllT: round4(validT),
    validGain: round4(st.gain), validGainSe: round4(st.se), validGainZ: round4(st.z),
    candidateT: bestT,
    reasonJa: adopted
      ? `検証${nValid}件で LogLoss が ${round4(validBase)}→${round4(validT)}(改善 ${round4(st.gain)}・z=${round4(st.z)})のため T=${bestT} を採用`
      : (bestT === 1 ? `学習${nTrain}件で最良が T=1(較正の必要なし)` : `候補 T=${bestT} は検証${nValid}件で改善 ${round4(st.gain)}・z=${round4(st.z)} と関門(改善≥${o.minCalGain}・z≥${o.minZ})に届かず不採用(T=1)`),
  };
}

/** 試合の見立て(閾値の分類。作文ではない) */
function styleOf(expTotal, pHome, pAway) {
  const scoring = expTotal < 2.2 ? "low" : expTotal <= 3.0 ? "mid" : "high";
  const diff = Math.abs(pHome - pAway);
  const favored = diff < 0.12 ? null : (pHome > pAway ? "home" : "away");
  const balance = diff < 0.12 ? "even" : diff < 0.30 ? "slight" : "clear";
  const scoringJa = { low: "ロースコア寄り", mid: "標準的な得点", high: "打ち合いになりやすい" }[scoring];
  const sideJa = favored === "home" ? "ホーム" : favored === "away" ? "アウェイ" : null;
  const balanceJa = balance === "even" ? "接戦(拮抗)" : balance === "slight" ? `${sideJa}がやや優勢` : `${sideJa}が大きく優勢`;
  return { scoring, balance, favored, styleJa: `${balanceJa}・${scoringJa}` };
}

/**
 * 予想記録に保存する content を作る(純関数)。
 * @param {object} p { homeLambda, awayLambda, finalProbs, rho, model }
 */
function buildMatchContent(p) {
  const { homeLambda, awayLambda, finalProbs, rho, model } = p || {};
  const raw = gridMetrics(homeLambda, awayLambda, rho);
  if (!raw) return null;
  const pack = (m, extra) => ({
    ou25: round3(m.over25), btts: round3(m.btts), exp: round3(m.expTotal),
    hcs: round3(m.homeCs), acs: round3(m.awayCs),
    top: m.top.map((t) => ({ s: t.scoreline, p: round3(t.p) })),
    ...(extra || {}),
  });
  const content = { v: 1, raw: pack(raw), fin: null, disp: "lambda", cal: null, shown: null };
  const fp = finalProbs;
  if (fp && [fp.homeWin, fp.draw, fp.awayWin].every((x) => Number.isFinite(x))) {
    const total = fp.homeWin + fp.draw + fp.awayWin || 1;
    const sol = solveLambdasForProbs(fp.homeWin / total, fp.awayWin / total, rho, { homeLambda, awayLambda });
    if (sol.ok) {
      const fm = gridMetrics(sol.homeLambda, sol.awayLambda, rho);
      content.fin = pack(fm, { lh: sol.homeLambda, la: sol.awayLambda, ok: true });
    } else {
      content.fin = { ok: false, reason: sol.reason || "not_converged" };
    }
  }
  const useFinal = !!(model && model.display === "final" && content.fin && content.fin.ok);
  content.disp = useFinal ? "final" : "lambda";
  const src = useFinal ? content.fin : content.raw;
  // 較正(表示元の生値に掛ける。採用されていなければ T=1=そのまま)
  const cal = model && model.calibration ? model.calibration : null;
  const tOu = cal && cal.over25 && cal.over25.adopted ? cal.over25.T : 1;
  const tBt = cal && cal.btts && cal.btts.adopted ? cal.btts.T : 1;
  content.cal = (tOu !== 1 || tBt !== 1) ? { ou: tOu, btts: tBt, fittedAt: (cal && cal.fittedAt) || null } : null;
  const probsForStyle = useFinal
    ? { pHome: fp.homeWin / (fp.homeWin + fp.draw + fp.awayWin || 1), pAway: fp.awayWin / (fp.homeWin + fp.draw + fp.awayWin || 1) }
    : { pHome: raw.pHome, pAway: raw.pAway };
  const style = styleOf(src.exp, probsForStyle.pHome, probsForStyle.pAway);
  content.shown = {
    ou25: round3(temperBinary(src.ou25, tOu)), btts: round3(temperBinary(src.btts, tBt)),
    exp: src.exp, hcs: src.hcs, acs: src.acs, top: src.top.slice(0, 3),
    style: style.scoring + "/" + style.balance, styleJa: style.styleJa,
  };
  return content;
}

/** 画面・道具向け(日本語の注記つき) */
function describeContent(content, opts) {
  if (!content || !content.shown) return null;
  const s = content.shown;
  const o = opts || {};
  const calNote = content.cal ? `2.5点以上・両チーム得点の確率は実測で学習した較正を適用済み(T=${content.cal.ou}/${content.cal.btts})` : null;
  return {
    source: content.disp,
    sourceJa: content.disp === "final" ? "公開中の勝敗確率と整合するスコア分布" : "自前モデルの期待得点からのスコア分布",
    expTotalGoals: s.exp,
    over25Pct: Math.round(s.ou25 * 100), under25Pct: Math.round((1 - s.ou25) * 100),
    bttsPct: Math.round(s.btts * 100),
    homeCleanSheetPct: Math.round(s.hcs * 100), awayCleanSheetPct: Math.round(s.acs * 100),
    topScorelines: (s.top || []).map((t) => ({ scoreline: t.s, pct: Math.round(t.p * 1000) / 10 })),
    styleJa: s.styleJa,
    calibrated: !!content.cal,
    calibrationNoteJa: calNote || (Number.isFinite(o.calibrationSamples) ? `較正中(答え合わせ ${o.calibrationSamples}件。件数が貯まるまで生値)` : "較正中(件数が貯まるまで生値)"),
    noteJa: "試合内容の見立ては、勝敗と同じスコア分布から機械的に取り出した確率です(閾値: 合計得点見込み 2.2未満=ロースコア寄り・3.0超=打ち合い、勝敗確率の差 0.12未満=接戦・0.30以上=大きく優勢)。",
  };
}

/* ============================================================================
 * 答え合わせ(採点)— accuracyTracker から呼ぶ純関数
 * ========================================================================== */
function scoreContent(record, actualScore) {
  const c = record && record.content;
  if (!c || !c.raw || !actualScore) return null;
  const h = Number(actualScore.home), a = Number(actualScore.away);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const yOu = (h + a > 2.5) ? 1 : 0;
  const yBt = (h > 0 && a > 0) ? 1 : 0;
  const sl = `${h}-${a}`;
  const side = (m) => {
    if (!m || !Number.isFinite(m.ou25) || !Number.isFinite(m.btts)) return null;
    const top = Array.isArray(m.top) ? m.top.map((t) => t.s) : [];
    return {
      ouBrier: round4(Math.pow(m.ou25 - yOu, 2)), bttsBrier: round4(Math.pow(m.btts - yBt, 2)),
      ouLogLoss: round4(binaryNll(m.ou25, yOu)), bttsLogLoss: round4(binaryNll(m.btts, yBt)),
      top1Hit: top.length ? top[0] === sl : null, top3Hit: top.length ? top.slice(0, 3).includes(sl) : null,
      expErr: Number.isFinite(m.exp) ? round4(Math.abs(m.exp - (h + a))) : null,
    };
  };
  const raw = side(c.raw);
  const fin = c.fin && c.fin.ok ? side(c.fin) : null;
  const shown = side(c.shown);
  const d = (raw && fin) ? round4(((raw.ouBrier + raw.bttsBrier) / 2) - ((fin.ouBrier + fin.bttsBrier) / 2)) : null;
  return { raw, fin, shown, d, yOu, yBt, shownOu: c.shown ? c.shown.ou25 : null, shownBtts: c.shown ? c.shown.btts : null, disp: c.disp || "lambda" };
}

function emptyContentAgg() {
  const bins = () => ({ "0-35": { n: 0, hits: 0, confSum: 0 }, "35-50": { n: 0, hits: 0, confSum: 0 }, "50-65": { n: 0, hits: 0, confSum: 0 }, "65+": { n: 0, hits: 0, confSum: 0 } });
  const side = () => ({ n: 0, ouBrierSum: 0, bttsBrierSum: 0, ouLogLossSum: 0, bttsLogLossSum: 0, top1N: 0, top1Hits: 0, top3N: 0, top3Hits: 0, expErrSum: 0, expErrN: 0 });
  return { n: 0, raw: side(), fin: side(), shown: side(), pairedN: 0, dSum: 0, dSqSum: 0, shownOuBins: bins(), shownBttsBins: bins(), dispFinal: 0 };
}

function binOf(p) { return p < 0.35 ? "0-35" : p < 0.5 ? "35-50" : p < 0.65 ? "50-65" : "65+"; }

function addContentScore(agg, sc) {
  if (!agg || !sc) return agg;
  const addSide = (dst, s) => {
    if (!s) return;
    dst.n++;
    dst.ouBrierSum = round4(dst.ouBrierSum + s.ouBrier);
    dst.bttsBrierSum = round4(dst.bttsBrierSum + s.bttsBrier);
    dst.ouLogLossSum = round4(dst.ouLogLossSum + s.ouLogLoss);
    dst.bttsLogLossSum = round4(dst.bttsLogLossSum + s.bttsLogLoss);
    if (typeof s.top1Hit === "boolean") { dst.top1N++; if (s.top1Hit) dst.top1Hits++; }
    if (typeof s.top3Hit === "boolean") { dst.top3N++; if (s.top3Hit) dst.top3Hits++; }
    if (Number.isFinite(s.expErr)) { dst.expErrSum = round4(dst.expErrSum + s.expErr); dst.expErrN++; }
  };
  agg.n++;
  addSide(agg.raw, sc.raw);
  addSide(agg.fin, sc.fin);
  addSide(agg.shown, sc.shown);
  if (Number.isFinite(sc.d)) { agg.pairedN++; agg.dSum = round6(agg.dSum + sc.d); agg.dSqSum = round6(agg.dSqSum + sc.d * sc.d); }
  if (sc.disp === "final") agg.dispFinal++;
  if (Number.isFinite(sc.shownOu)) { const b = agg.shownOuBins[binOf(sc.shownOu)]; b.n++; if (sc.yOu) b.hits++; b.confSum = round4(b.confSum + sc.shownOu); }
  if (Number.isFinite(sc.shownBtts)) { const b = agg.shownBttsBins[binOf(sc.shownBtts)]; b.n++; if (sc.yBt) b.hits++; b.confSum = round4(b.confSum + sc.shownBtts); }
  return agg;
}

function mergeContentAgg(a, b) {
  if (!a && !b) return null;
  const out = emptyContentAgg();
  const srcs = [a, b].filter((x) => x && typeof x === "object");
  for (const s of srcs) {
    out.n += s.n || 0;
    for (const k of ["raw", "fin", "shown"]) {
      const d = out[k], v = s[k] || {};
      for (const f of Object.keys(d)) d[f] = /Sum$/.test(f) ? round4(d[f] + (v[f] || 0)) : d[f] + (v[f] || 0);
    }
    out.pairedN += s.pairedN || 0; out.dSum = round6(out.dSum + (s.dSum || 0)); out.dSqSum = round6(out.dSqSum + (s.dSqSum || 0));
    out.dispFinal += s.dispFinal || 0;
    for (const bk of ["shownOuBins", "shownBttsBins"]) {
      for (const bin of Object.keys(out[bk])) {
        const v = (s[bk] || {})[bin] || {};
        out[bk][bin].n += v.n || 0; out[bk][bin].hits += v.hits || 0; out[bk][bin].confSum = round4(out[bk][bin].confSum + (v.confSum || 0));
      }
    }
  }
  return out;
}

function eceOf(bins) {
  let total = 0; for (const v of Object.values(bins)) total += v.n;
  if (!total) return null;
  let ece = 0;
  for (const v of Object.values(bins)) { if (!v.n) continue; ece += (v.n / total) * Math.abs(v.confSum / v.n - v.hits / v.n); }
  return Math.round(ece * 1000) / 10; // %
}

function summarizeContentAgg(agg) {
  if (!agg || !agg.n) return { measurable: false, reasonJa: "試合内容の予測の採点は v104 以降に予想した試合から始まります(まだ貯まっていません)。" };
  const side = (s) => s && s.n ? {
    n: s.n, ouBrier: round4(s.ouBrierSum / s.n), bttsBrier: round4(s.bttsBrierSum / s.n),
    ouLogLoss: round4(s.ouLogLossSum / s.n), bttsLogLoss: round4(s.bttsLogLossSum / s.n),
    top1HitPct: s.top1N ? Math.round((s.top1Hits / s.top1N) * 1000) / 10 : null,
    top3HitPct: s.top3N ? Math.round((s.top3Hits / s.top3N) * 1000) / 10 : null,
    expGoalsMae: s.expErrN ? round4(s.expErrSum / s.expErrN) : null,
  } : null;
  const n = agg.pairedN || 0;
  const mean = n ? agg.dSum / n : null;
  const variance = n > 1 ? Math.max(0, agg.dSqSum / n - mean * mean) : 0;
  const se = n > 1 ? Math.sqrt(variance / (n - 1)) : 0;
  return {
    measurable: true, n: agg.n,
    raw: side(agg.raw), final: side(agg.fin), shown: side(agg.shown),
    compare: n ? { n, gain: round4(mean), se: round4(se), z: (n >= 10 && se > 0) ? round4(mean / se) : null, noteJa: "gain=Brier(λだけの分布)−Brier(勝敗確率と整合する分布)。プラスなら整合版の方が良い" } : null,
    shownCalibration: { over25EcePct: eceOf(agg.shownOuBins), bttsEcePct: eceOf(agg.shownBttsBins) },
    displayedFinalShare: agg.n ? Math.round((agg.dispFinal / agg.n) * 100) : 0,
  };
}

/* ============================================================================
 * 毎晩の学習で呼ぶ: 表示元の切り替え関門+較正の学習(保存は呼び出し側)
 * ========================================================================== */
function compareContentSources(records) {
  const ds = [];
  for (const r of records || []) {
    const sc = scoreContent(r, r && r.actualScore);
    if (sc && Number.isFinite(sc.d)) ds.push(sc.d);
  }
  const n = ds.length;
  if (!n) return { n: 0, gain: null, se: null, z: null };
  const mean = ds.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? ds.reduce((a, d) => a + (d - mean) * (d - mean), 0) / (n - 1) : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : 0;
  return { n, gain: round4(mean), se: round4(se), z: se > 0 ? round4(mean / se) : null };
}

function decideDisplay(prevDisplay, compare, opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const prev = prevDisplay === "final" ? "final" : "lambda";
  if (!compare || compare.n < o.minCompareN) {
    return { display: prev, changed: false, reasonJa: `比較できる答え合わせが${(compare && compare.n) || 0}件(必要 ${o.minCompareN}件)のため、表示元は「${prev === "final" ? "整合版" : "λ版"}」のまま` };
  }
  if (prev === "final") {
    if (compare.z !== null && compare.z <= -o.minZ) return { display: "lambda", changed: true, reasonJa: `整合版が有意に悪化(改善 ${compare.gain}・z=${compare.z})したため λ版へ戻す` };
    return { display: "final", changed: false, reasonJa: `整合版を継続(${compare.n}件・改善 ${compare.gain}・z=${compare.z})` };
  }
  const adopt = compare.gain >= o.minGain && compare.z !== null && compare.z >= o.minZ;
  return adopt
    ? { display: "final", changed: true, reasonJa: `${compare.n}件で整合版の Brier 改善 ${compare.gain}(z=${compare.z})が関門(≥${o.minGain}・z≥${o.minZ})を通ったため、表示を整合版へ切り替え` }
    : { display: "lambda", changed: false, reasonJa: `${compare.n}件で整合版の改善 ${compare.gain}・z=${compare.z} は関門(≥${o.minGain}・z≥${o.minZ})に届かず、λ版のまま` };
}

/** 較正の学習材料: 表示元(display)の生値(較正前)と実結果 */
function calibrationSamples(records, display, which) {
  const out = [];
  for (const r of records || []) {
    const c = r && r.content; const sc = r && r.actualScore;
    if (!c || !sc || !Number.isFinite(Number(sc.home)) || !Number.isFinite(Number(sc.away))) continue;
    const src = display === "final" ? (c.fin && c.fin.ok ? c.fin : null) : c.raw;
    if (!src) continue;
    const p = which === "over25" ? src.ou25 : src.btts;
    if (!Number.isFinite(p)) continue;
    const h = Number(sc.home), a = Number(sc.away);
    const y = which === "over25" ? ((h + a > 2.5) ? 1 : 0) : ((h > 0 && a > 0) ? 1 : 0);
    out.push({ p, y, at: r.resolvedAt || r.kickoff || "" });
  }
  return out;
}

function fitContentModel(records, p) {
  const o = p || {};
  const prev = o.prevModel || null;
  const compare = compareContentSources(records);
  const decision = decideDisplay(prev && prev.display, compare, o.opts);
  const display = decision.display;
  const over25 = fitBinaryTemperature(calibrationSamples(records, display, "over25"), o.opts);
  const btts = fitBinaryTemperature(calibrationSamples(records, display, "btts"), o.opts);
  const fittedAt = o.nowIso || new Date().toISOString();
  return {
    version: 1, fittedAt, display, decision,
    compare,
    calibration: { fittedAt, over25, btts },
    anyCalibrationAdopted: !!(over25.adopted || btts.adopted),
    history: [...(Array.isArray(prev && prev.history) ? prev.history.slice(-9) : []), ...(decision.changed ? [{ at: fittedAt, display, reasonJa: decision.reasonJa }] : [])],
    noteJa: `表示元: ${display === "final" ? "勝敗確率と整合するスコア分布" : "λだけのスコア分布(既定)"}。${decision.reasonJa}。較正: 2.5点以上 ${over25.adopted ? `T=${over25.T} 採用` : "なし"} / 両チーム得点 ${btts.adopted ? `T=${btts.T} 採用` : "なし"}`,
  };
}

function summarizeModel(model) {
  if (!model) return { available: false, display: "lambda", reasonJa: "試合内容モデル(learn:content:model)はまだ保存されていません(v104 の最初の学習後に作られます)" };
  return {
    available: true, display: model.display || "lambda", fittedAt: model.fittedAt || null,
    compare: model.compare || null, decisionJa: model.decision ? model.decision.reasonJa : null,
    calibration: model.calibration ? {
      over25: pickCal(model.calibration.over25), btts: pickCal(model.calibration.btts),
    } : null,
    history: model.history || [],
    noteJa: model.noteJa || null,
  };
}
function pickCal(c) { return c ? { T: c.T, adopted: !!c.adopted, nTrain: c.nTrain, nValid: c.nValid, validNllBase: c.validNllBase, validNllT: c.validNllT, validGain: c.validGain, validGainZ: c.validGainZ, reasonJa: c.reasonJa } : null; }

module.exports = {
  MODEL_KEY, DEFAULT_OPTS,
  gridMetrics, solveLambdasForProbs, temperBinary, binaryNll, pairedGainStatsBinary, fitBinaryTemperature, styleOf,
  buildMatchContent, describeContent,
  scoreContent, emptyContentAgg, addContentScore, mergeContentAgg, summarizeContentAgg,
  compareContentSources, decideDisplay, calibrationSamples, fitContentModel, summarizeModel,
};
