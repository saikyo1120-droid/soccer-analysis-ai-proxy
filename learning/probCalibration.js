/**
 * server/learning/probCalibration.js
 * ------------------------------------------------
 * v101(2026年11月9日)★4「確率の鋭さ(較正)」: 最終確率の温度スケーリング。
 *
 * ■ なぜ必要か(本番実測 11/8・直近30日 772件)
 *   自信 33〜45% の予想(243件)は実際には 52.7% 当たり、70% 以上(123件)は 74% だった。
 *   つまり AI は「迷っている試合では自信不足・強気の試合ではやや自信過剰」で、
 *   ECE(較正誤差)は 6.8%。この歪みは的中率には影響しない(予想した勝敗は同じ)が、
 *   確率の質=技能スコア(LogLoss)を下げ、「60%」と言った数字が 60% の意味を持たない。
 *
 * ■ 何をするか
 *   最終確率 p(市場合成後)を p^(1/T) に変えて正規化する(温度 T)。T<1 で確率は鋭く、
 *   T>1 で平らになる。T は答え合わせ済みの記録から、時系列で前 70% を学習用・後 30% を
 *   検証用に分け、検証用の LogLoss が T=1(何もしない)より 0.002 以上良いときだけ採用する
 *   (重み学習と同じ「関門」方式。迷ったら現状維持)。
 *
 * ■ レジーム(状況)別に学習する理由
 *   自信不足の帯の多くは「オッズが無い(自前モデル単独)」試合で、市場合成のある試合とは
 *   歪み方が違う。1つの T で両方を直そうとすると片方を悪化させるため、
 *   「オッズあり」「オッズなし」で別々の T を学習する。
 *
 * ■ 守ること(劣化禁止・でっち上げ防止)
 *   ・p^(1/T) は単調変換なので、最大確率の勝敗(argmax)は変わらない=的中率は数学的に不変。
 *   ・学習に使うのは記録済みの生の確率(rawFinalProbs があればそれ、無ければ finalProbs)と
 *     実結果だけ。較正済みの確率を材料に再学習しない(二重較正の防止)。
 *   ・件数が足りない(学習 80 件・検証 30 件未満)レジームは T=1 のまま。理由を必ず言葉で残す。
 *   ・適用した記録には生の確率(rawFinalProbs)と T を併記する(数字のすり替えをしない)。
 */

const LN3 = Math.log(3);
const P_FLOOR = 0.005;
const MODEL_KEY = "learn:calibration:model";
const REGIMES = ["odds", "noOdds"];
const REGIME_LABELS_JA = { odds: "オッズあり(市場合成)", noOdds: "オッズなし(自前モデル単独)" };

const DEFAULT_OPTS = {
  minTrain: 80,
  minValid: 30,
  minGain: 0.002, // 検証 LogLoss の最小改善幅(重み学習の関門 B と同じ)
  // 改善が偶然でないことの確認: 検証データの試合ごとの差(T=1 との LogLoss の差)の平均を
  // その標準誤差で割った z 値が 1.64 以上(片側 95%)のときだけ採用する。
  // 合成データの検証で、数百件では ±0.005 程度の偶然の差が普通に出ることが分かったため。
  minZ: 1.64,
  tMin: 0.6,
  tMax: 1.6,
  tStep: 0.025,
};

function round4(v) { return Math.round(v * 10000) / 10000; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/** 記録の状況(レジーム): 市場オッズが使えた予想か */
function regimeOf(record) {
  const m = record && record.marketImplied;
  return (m && Number.isFinite(m.homePct) && Number.isFinite(m.awayPct)) ? "odds" : "noOdds";
}

/** 学習の材料にする「生の」最終確率(較正前)。無ければ null */
function rawProbsOf(record) {
  if (!record) return null;
  const src = record.rawFinalProbs || record.finalProbs;
  if (!src) return null;
  const h = src.homeWin, d = src.draw, a = src.awayWin;
  if (![h, d, a].every((v) => Number.isFinite(v) && v >= 0)) return null;
  const total = h + d + a;
  if (!(total > 0)) return null;
  return { home: h / total, draw: d / total, away: a / total };
}

/** 温度 T を適用する(T=1 なら同一)。単調変換なので最大確率の順位は変わらない。 */
function temper(probs, T) {
  if (!probs || !Number.isFinite(T) || T <= 0) return probs;
  if (Math.abs(T - 1) < 1e-9) return { home: probs.home, draw: probs.draw, away: probs.away };
  const e = 1 / T;
  const h = Math.pow(Math.max(P_FLOOR, probs.home), e);
  const d = Math.pow(Math.max(P_FLOOR, probs.draw), e);
  const a = Math.pow(Math.max(P_FLOOR, probs.away), e);
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

function nllOf(samples, T) {
  if (!samples.length) return null;
  let sum = 0;
  for (const x of samples) {
    const p = temper(x.probs, T);
    sum -= Math.log(Math.max(P_FLOOR, p[x.actual]));
  }
  return sum / samples.length;
}

function accuracyOf(samples, T) {
  if (!samples.length) return null;
  let hits = 0;
  for (const x of samples) {
    const p = temper(x.probs, T);
    const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
    if (pick === x.actual) hits++;
  }
  return hits / samples.length;
}

/**
 * 検証データでの「T=1 に対する改善」が偶然でないかを見る(対応のある差の z 値)。
 * d_i = LogLoss(T=1) − LogLoss(T) を試合ごとに取り、平均 / 標準誤差 を返す。
 */
function pairedGainStats(samples, T) {
  const n = samples.length;
  if (n < 2) return { gain: null, se: null, z: null };
  let sum = 0, sumSq = 0;
  for (const x of samples) {
    const p1 = Math.max(P_FLOOR, x.probs[x.actual]);
    const pT = Math.max(P_FLOOR, temper(x.probs, T)[x.actual]);
    const d = (-Math.log(p1)) - (-Math.log(pT));
    sum += d; sumSq += d * d;
  }
  const mean = sum / n;
  const variance = Math.max(0, (sumSq / n) - mean * mean) * (n / (n - 1));
  const se = Math.sqrt(variance / n);
  return { gain: mean, se, z: se > 0 ? mean / se : (mean > 0 ? Infinity : 0) };
}

/** 学習用データで LogLoss を最小にする T を格子探索する */
function fitTemperature(samples, opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  let bestT = 1, bestNll = nllOf(samples, 1);
  for (let T = o.tMin; T <= o.tMax + 1e-9; T += o.tStep) {
    const t = Math.round(T * 1000) / 1000;
    const nll = nllOf(samples, t);
    if (nll !== null && nll < bestNll - 1e-12) { bestNll = nll; bestT = t; }
  }
  return { T: bestT, trainNll: bestNll };
}

/** 答え合わせ済みの記録 → 学習サンプル(時系列順) */
function samplesFromRecords(records) {
  const out = { odds: [], noOdds: [] };
  for (const r of records || []) {
    if (!r || !r.resolved || !r.actualWinner) continue;
    if (!["home", "draw", "away"].includes(r.actualWinner)) continue;
    const probs = rawProbsOf(r);
    if (!probs) continue;
    const ts = Date.parse(r.resolvedAt || r.kickoff || r.loggedAt || "") || 0;
    out[regimeOf(r)].push({ probs, actual: r.actualWinner, ts });
  }
  for (const k of REGIMES) out[k].sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 較正モデルを学習する(純関数)。
 * @returns {{version:number, fittedAt:string, samples:number, regimes:object, anyAdopted:boolean, noteJa:string}}
 */
function fitCalibrationModel(records, opts) {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const samples = samplesFromRecords(records);
  const regimes = {};
  let anyAdopted = false;
  let total = 0;
  for (const k of REGIMES) {
    const s = samples[k];
    total += s.length;
    const split = Math.floor(s.length * 0.7);
    const train = s.slice(0, split);
    const valid = s.slice(split);
    const base = { regime: k, labelJa: REGIME_LABELS_JA[k], nTrain: train.length, nValid: valid.length, T: 1, adopted: false };
    if (train.length < o.minTrain || valid.length < o.minValid) {
      regimes[k] = { ...base, reasonJa: `答え合わせ済みの記録が学習用${train.length}件・検証用${valid.length}件で、較正の学習に必要な${o.minTrain}件・${o.minValid}件に達していないため、この状況では較正しません(T=1)。` };
      continue;
    }
    const fit = fitTemperature(train, o);
    const validBase = nllOf(valid, 1);
    const validT = nllOf(valid, fit.T);
    const accBase = accuracyOf(valid, 1);
    const accT = accuracyOf(valid, fit.T);
    const gain = validBase - validT;
    const paired = pairedGainStats(valid, fit.T);
    const zOk = Number.isFinite(paired.z) ? paired.z >= o.minZ : paired.z === Infinity;
    const adopted = Math.abs(fit.T - 1) > 1e-9 && gain >= o.minGain && zOk;
    if (adopted) anyAdopted = true;
    const zTxt = Number.isFinite(paired.z) ? round3(paired.z) : String(paired.z);
    regimes[k] = {
      ...base,
      T: adopted ? fit.T : 1,
      bestTrainT: fit.T,
      adopted,
      trainNllBase: round4(nllOf(train, 1)),
      trainNllT: round4(fit.trainNll),
      validNllBase: round4(validBase),
      validNllT: round4(validT),
      validGain: round4(gain),
      validGainSe: paired.se === null ? null : round4(paired.se),
      validGainZ: Number.isFinite(paired.z) ? round3(paired.z) : null,
      validAccBasePct: accBase === null ? null : Math.round(accBase * 1000) / 10,
      validAccTPct: accT === null ? null : Math.round(accT * 1000) / 10,
      skillBasePct: Math.round((1 - validBase / LN3) * 1000) / 10,
      skillTPct: Math.round((1 - validT / LN3) * 1000) / 10,
      reasonJa: adopted
        ? `${REGIME_LABELS_JA[k]}: 学習用${train.length}件で最適な温度 T=${fit.T}(${fit.T < 1 ? "確率を鋭く" : "確率を平らに"})。検証用${valid.length}件の LogLoss が ${round4(validBase)}→${round4(validT)}(−${round4(gain)}・z=${zTxt})と改善したため採用。的中率は ${Math.round(accBase * 1000) / 10}%→${Math.round(accT * 1000) / 10}%(順位を変えない変換なので同じ)。`
        : (Math.abs(fit.T - 1) <= 1e-9
          ? `${REGIME_LABELS_JA[k]}: 学習用${train.length}件では T=1(何もしない)が最良でした。較正しません。`
          : (gain >= o.minGain && !zOk
            ? `${REGIME_LABELS_JA[k]}: 学習用では T=${fit.T} が最良で、検証用${valid.length}件の LogLoss 改善は ${round4(gain)} でしたが、偶然の範囲(z=${zTxt} < ${o.minZ})を出なかったため採用を見送りました(件数が増えれば判定し直します)。`
            : `${REGIME_LABELS_JA[k]}: 学習用では T=${fit.T} が最良でしたが、検証用${valid.length}件の LogLoss 改善が ${round4(gain)} で関門(${o.minGain})に届かなかったため、採用を見送りました(迷ったら現状維持)。`)),
    };
  }
  return {
    version: 1,
    fittedAt: (opts && opts.nowIso) || new Date().toISOString(),
    samples: total,
    regimes,
    anyAdopted,
    noteJa: "最終確率の較正(温度スケーリング)。状況別(オッズあり/なし)に温度 T を学習し、検証データで LogLoss が改善したときだけ適用します。最大確率の勝敗は変わらないため的中率は不変で、変わるのは確率の質(技能スコア・ECE)だけです。",
  };
}

/**
 * 予想時に較正を適用する。採用されていないレジーム・モデル無しなら何もしない。
 * @returns {{probs:object, applied:boolean, T:number|null, regime:string}}
 */
function applyCalibration(probs, model, regime) {
  const k = REGIMES.includes(regime) ? regime : "noOdds";
  if (!probs || !model || !model.regimes || !model.regimes[k]) return { probs, applied: false, T: null, regime: k };
  const r = model.regimes[k];
  if (!r.adopted || !Number.isFinite(r.T) || Math.abs(r.T - 1) < 1e-9) return { probs, applied: false, T: null, regime: k };
  return { probs: temper(probs, r.T), applied: true, T: r.T, regime: k };
}

/** 日次レポート用の要約 */
function summarizeModel(model) {
  if (!model || !model.regimes) {
    return { available: false, reasonJa: "確率の較正モデルはまだ学習されていません(v101 の学習が1回走ると作られます)。" };
  }
  const regimes = {};
  for (const k of REGIMES) {
    const r = model.regimes[k];
    if (!r) continue;
    regimes[k] = {
      labelJa: r.labelJa || REGIME_LABELS_JA[k], adopted: !!r.adopted, T: r.T ?? 1,
      nTrain: r.nTrain ?? 0, nValid: r.nValid ?? 0,
      validNllBase: r.validNllBase ?? null, validNllT: r.validNllT ?? null, validGain: r.validGain ?? null,
      skillBasePct: r.skillBasePct ?? null, skillTPct: r.skillTPct ?? null,
      validAccBasePct: r.validAccBasePct ?? null, validAccTPct: r.validAccTPct ?? null,
      reasonJa: r.reasonJa || null,
    };
  }
  return { available: true, fittedAt: model.fittedAt || null, samples: model.samples ?? null, anyAdopted: !!model.anyAdopted, regimes, noteJa: model.noteJa || null };
}

module.exports = {
  MODEL_KEY, REGIMES, REGIME_LABELS_JA, DEFAULT_OPTS, LN3,
  regimeOf, rawProbsOf, temper, nllOf, accuracyOf, pairedGainStats, fitTemperature, samplesFromRecords,
  fitCalibrationModel, applyCalibration, summarizeModel, round3,
};
