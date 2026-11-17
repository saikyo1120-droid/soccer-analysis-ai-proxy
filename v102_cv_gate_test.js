"use strict";
/**
 * v102(2026年11月17日)・A「重みの採否を、交差検証と統計の検定で決める」の検証
 * ----------------------------------------------------------------------------
 *   本番実測(11/16): 重みは version 33 のまま32日間据え置き(候補5・通過0)。これまでの関門は
 *   「古い7割で候補を作り、新しい3割で1回だけ比べる」形で、たまたまの差と本物の差を区別する力が弱かった。
 *   v102 では、記録を時系列の順のまま5つに分け、各かたまりを順に検証用に取り置く(交差検証)。
 *   検証用の試合1件ごとの「現行の損失 − 候補の損失」を束ねて、平均・標準誤差・z を出し、
 *   改善の大きさ・z・改善した折の数・的中率の下限をすべて満たしたときだけ採用する。
 *   ここで確かめること:
 *     1. 部品(かたまりの分け方・対応のある差の統計・判定)が定義どおり
 *     2. 候補を作る処理に、検証用の記録が渡らない(未来・検証の情報を見ない)
 *     3. 合成データで「本物の改善は通る/偶然は通らない」
 *     4. 毎日の学習(runDailyLearning)に組み込まれ、採用・据え置き・件数不足・旧関門の切り替えが正しく動く
 */
const assert = require("assert");
const path = require("path");
const S = __dirname;
const cvg = require(path.join(S, "learning", "cvGate.js"));
const pm = require(path.join(S, "learning", "predictionModel.js"));
const { runDailyLearning } = require(path.join(S, "learning", "dailyJob.js"));

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

// ---- 再現できる乱数 ----
function rng(seed0) { let seed = seed0 >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const poisson = (rnd, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
/** 本当の重み trueW に従って、特徴量つきの「答え合わせ済みの記録」を n 件作る(古い順) */
function makeRecords(n, trueW, seed) {
  const rnd = rng(seed); const out = [];
  for (let i = 0; i < n; i++) {
    const features = { formDiff: (rnd() - 0.5) * 4, venueDiff: (rnd() - 0.5) * 1.2, standingsDiff: (rnd() - 0.5) * 2 };
    const { homeLambda, awayLambda } = pm.predictOutcomeV2(features, trueW);
    const hg = poisson(rnd, homeLambda), ag = poisson(rnd, awayLambda);
    out.push({ resolved: true, fixtureId: 100000 + i, features, actualWinner: hg > ag ? "home" : hg < ag ? "away" : "draw", actualHomeGoals: hg, actualAwayGoals: ag });
  }
  return out;
}
const lossOf = (rec, w) => {
  const po = pm.predictOutcomeV2(rec.features, w);
  const pr = pm.computeMatchProbabilitiesRaw(po.homeLambda, po.awayLambda, undefined, w && Number.isFinite(w.rho) ? w.rho : 0);
  const p = rec.actualWinner === "home" ? pr.homeWin : rec.actualWinner === "away" ? pr.awayWin : pr.draw;
  return { nll: -Math.log(Math.max(0.005, p)), hit: po.predictedWinner === rec.actualWinner ? 1 : 0 };
};
const W0 = { ...pm.EXTENDED_DEFAULT_WEIGHTS };
const GATE = { minN: 100, minGain: 0.001, minZ: 1.64, accTolPt: 0.5 };

// ---- 保存先の模擬(Redis の必要な命令だけ) ----
function createMockRedis() {
  const store = new Map();
  const progressLog = []; // 進捗(learn:progress)への書き込みを順に残す(段階の途中の「心拍」の検査用)
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "MGET") return args.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { const [k, v, ...rest] = args; if (rest.includes("NX") && store.has(k)) return null; store.set(k, v); if (k === "learn:progress") progressLog.push(JSON.parse(v)); return "OK"; }
    if (op === "EXPIRE") return store.has(args[0]) ? 1 : 0;
    if (op === "DEL") return store.delete(args[0]) ? 1 : 0;
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "INCRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c + parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "RPUSH" || op === "LPUSH") { const [k, ...vs] = args; const l = store.get(k) || []; for (const v of vs) { if (op === "RPUSH") l.push(v); else l.unshift(v); } store.set(k, l); return l.length; }
    if (op === "LLEN") return (store.get(args[0]) || []).length;
    if (op === "LRANGE") {
      const [k, s, e] = args; const l = store.get(k) || [];
      let st = parseInt(s, 10), en = parseInt(e, 10);
      if (st < 0) st = Math.max(0, l.length + st);
      if (en < 0) en = l.length + en;
      if (en >= l.length) en = l.length - 1;
      if (en < 0 || st > en) return [];
      return l.slice(st, en + 1);
    }
    if (op === "LREM") { const [k, , v] = args; store.set(k, (store.get(k) || []).filter((x) => x !== v)); return 1; }
    if (op === "LTRIM") {
      const [k, s, e] = args; const l = store.get(k) || [];
      let st = parseInt(s, 10), en = parseInt(e, 10);
      if (st < 0) st = Math.max(0, l.length + st);
      if (en < 0) en = l.length + en;
      store.set(k, l.slice(st, en + 1)); return "OK";
    }
    return null;
  }
  const upstashGetJSON = async (k) => { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  return { store, progressLog, upstashCmd, upstashGetJSON, upstashSetJSON };
}
/** 記録と現行の重みを保存先に置いて、毎日の学習を1回まわす */
async function runWith(records, storedWeights, env) {
  const mock = createMockRedis();
  mock.store.set("learn:ownpred:recent", records.map((r) => JSON.stringify(r)));
  mock.store.set("learn:ownpred:resolved", String(records.length));
  mock.store.set("learn:ownpred:correct", String(Math.round(records.length / 2)));
  mock.store.set("learn:weights", JSON.stringify(storedWeights));
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  let result;
  try {
    result = await runDailyLearning({
      callApiFootball: async () => ({ response: [] }), resolveTeamId: async () => null,
      upstashEnabled: true, ...mock, now: () => new Date("2026-11-17T19:17:00Z"),
    });
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const history = (mock.store.get("learn:weights:history") || []).map((x) => JSON.parse(x));
  const weightsAfter = JSON.parse(mock.store.get("learn:weights"));
  return { result, history, weightsAfter, mock };
}

(async () => {
  console.log("■ 1. 部品: かたまりの分け方・対応のある差の統計・判定");
  await t("時系列のかたまり: 順番を保ち、すき間も重なりも無く、全件を覆う(割り切れない件数でも)", () => {
    assert.deepStrictEqual(cvg.timeBlocks(10, 5), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
    for (const [n, k] of [[1601, 5], [103, 5], [7, 3], [5, 5], [0, 5], [3, 5]]) {
      const b = cvg.timeBlocks(n, k);
      assert.strictEqual(b.length, k); assert.strictEqual(b[0][0], 0); assert.strictEqual(b[k - 1][1], n);
      for (let i = 1; i < k; i++) assert.strictEqual(b[i][0], b[i - 1][1], "すき間・重なりがある");
      const sizes = b.map((x) => x[1] - x[0]); assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "大きさが2件以上違う: " + sizes);
    }
  });
  await t("対応のある差の統計: 平均・標準誤差・z は教科書どおり(不偏分散)。件数が足りなければ出さない", () => {
    const s = cvg.pairedStats([0.1, 0.3, -0.1, 0.2, 0.0]);
    assert.ok(Math.abs(s.gain - 0.1) < 1e-12);
    // 不偏分散 = Σ(d-0.1)^2/4 = (0+0.04+0.04+0.01+0.01)/4 = 0.025 → se = sqrt(0.025/5)
    assert.ok(Math.abs(s.se - Math.sqrt(0.025 / 5)) < 1e-12); assert.ok(Math.abs(s.z - 0.1 / Math.sqrt(0.025 / 5)) < 1e-9); assert.strictEqual(s.n, 5);
    assert.deepStrictEqual(cvg.pairedStats([]), { n: 0, gain: null, se: null, z: null });
    assert.strictEqual(cvg.pairedStats([0.2]).z, null);
    assert.strictEqual(cvg.pairedStats([0.2, 0.2, 0.2]).z, Infinity, "全件が同じだけ改善 → 偶然ではない");
    assert.strictEqual(cvg.pairedStats([0, 0, 0]).z, 0); assert.strictEqual(cvg.pairedStats([-0.2, -0.2]).z, 0);
    assert.strictEqual(cvg.pairedStats([0.1, NaN, 0.3, undefined]).n, 2, "数でない差は数えない");
  });
  await t("判定: 5つの条件(件数・改善の大きさ・z・改善した折・的中率)を1つでも欠くと通らない。理由を日本語で返す", () => {
    const ok = { n: 1600, gain: 0.004, se: 0.0015, z: 2.67, accDeltaPt: 0.2, foldsWithCandidate: 5, positiveFolds: 5 };
    assert.strictEqual(cvg.decideCvGate(ok, GATE).pass, true);
    assert.strictEqual(cvg.decideCvGate({ ...ok, positiveFolds: 4 }, GATE).pass, true, "5折のうち4折で改善なら通す");
    const cases = [
      [{ ...ok, n: 99 }, "enough", /99件/], [{ ...ok, gain: 0.0009 }, "gainOk", /意味のある大きさ/], [{ ...ok, z: 1.63 }, "zOk", /偶然と区別/],
      [{ ...ok, positiveFolds: 3 }, "foldsOk", /3\/5/], [{ ...ok, accDeltaPt: -0.6 }, "accOk", /的中率/],
      [{ ...ok, gain: null, z: null }, "gainOk", /測定不可/], [{ ...ok, foldsWithCandidate: 0, positiveFolds: 0 }, "foldsOk", /候補を作れなかった/],
    ];
    for (const [st, key, re] of cases) { const d = cvg.decideCvGate(st, GATE); assert.strictEqual(d.pass, false, key); assert.strictEqual(d.checks[key], false, key); assert.ok(re.test(d.reasonJa), key + ": " + d.reasonJa); }
    assert.strictEqual(cvg.decideCvGate({ ...ok, accDeltaPt: -0.5 }, GATE).pass, true, "ちょうど許容幅なら通す");
    assert.strictEqual(cvg.decideCvGate({ ...ok, z: Infinity }, GATE).pass, true);
    assert.strictEqual(cvg.decideCvGate(null, GATE).pass, false);
    // 候補を作れた折が4つ(前向き検証)なら、3つ以上で改善が必要
    assert.strictEqual(cvg.decideCvGate({ ...ok, foldsWithCandidate: 4, positiveFolds: 3 }, GATE).pass, true);
    assert.strictEqual(cvg.decideCvGate({ ...ok, foldsWithCandidate: 4, positiveFolds: 2 }, GATE).pass, false);
  });

  console.log("■ 2. 候補を作る処理は、検証用の記録を見ない");
  await t("取り置き型(blocked): 各折の学習用は「検証用のかたまり以外の全部」。検証用の記録は1件も渡らない", () => {
    const recs = Array.from({ length: 100 }, (_, i) => ({ i }));
    const seen = [];
    const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: (train, info) => { seen.push({ train: train.map((r) => r.i), info }); return { tag: info.fold }; }, lossOf: () => ({ nll: 1, hit: 0 }), baseLossOf: () => ({ nll: 1.1, hit: 0 }) });
    assert.strictEqual(seen.length, 5);
    for (const s of seen) {
      assert.strictEqual(s.train.length, 80);
      for (let i = s.info.validStart; i < s.info.validEnd; i++) assert.ok(!s.train.includes(i), "検証用の記録が学習用に入っている");
    }
    assert.strictEqual(cv.n, 100); assert.ok(Math.abs(cv.gain - 0.1) < 1e-9); assert.strictEqual(cv.foldsWithCandidate, 5); assert.strictEqual(cv.positiveFolds, 5);
  });
  await t("前向き型(forward): 各折の学習用は「検証用より前」だけ(未来を見ない)。最初のかたまりは検証に使わない", () => {
    const recs = Array.from({ length: 100 }, (_, i) => ({ i }));
    const seen = [];
    const cv = cvg.crossValidate(recs, { folds: 5, scheme: "forward", procedure: (train, info) => { seen.push({ max: Math.max(...train.map((r) => r.i)), n: train.length, info }); return {}; }, lossOf: () => ({ nll: 1, hit: 1 }), baseLossOf: () => ({ nll: 1, hit: 1 }) });
    assert.deepStrictEqual(seen.map((s) => s.n), [20, 40, 60, 80]);
    for (const s of seen) assert.ok(s.max < s.info.validStart, "未来の記録が学習用に入っている");
    assert.strictEqual(cv.n, 80); assert.strictEqual(cv.gain, 0); assert.strictEqual(cv.positiveFolds, 0, "差0の折は「改善した折」に数えない");
  });
  await t("候補を作れなかった折は「現行のまま」として差0で数える(改善を水増ししない)。件数の足りない折は飛ばす", () => {
    const recs = Array.from({ length: 100 }, (_, i) => ({ i }));
    const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: (train, info) => (info.fold < 2 ? { w: 1 } : null), lossOf: () => ({ nll: 0.9, hit: 1 }), baseLossOf: () => ({ nll: 1.0, hit: 0 }) });
    assert.strictEqual(cv.foldsWithCandidate, 2); assert.strictEqual(cv.n, 100);
    assert.ok(Math.abs(cv.gain - 0.04) < 1e-9, "2折ぶん(40件)だけ 0.1 改善 → 平均 0.04: " + cv.gain);
    assert.strictEqual(cv.accDeltaPt, 40);
    const tiny = cvg.crossValidate(recs.slice(0, 30), { folds: 5, scheme: "blocked", minValid: 20, procedure: () => ({}), lossOf: () => ({ nll: 1, hit: 0 }), baseLossOf: () => ({ nll: 1, hit: 0 }) });
    assert.strictEqual(tiny.n, 0); assert.ok(tiny.folds.every((f) => f.skipped));
    // 候補を作る処理が例外を投げても、その折は「候補なし」で続ける
    const thrown = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: () => { throw new Error("boom"); }, lossOf: () => ({ nll: 1, hit: 0 }), baseLossOf: () => ({ nll: 1, hit: 0 }) });
    assert.strictEqual(thrown.foldsWithCandidate, 0); assert.ok(thrown.folds.every((f) => f.procError === "boom"));
  });

  console.log("■ 3. 合成データ: 本物の改善は通る/偶然は通らない");
  const TRUE_W = { ...W0, homeBase: 1.45, awayBase: 1.1, sensitivity: 0.36, venueSensitivity: 0.25, standingsSensitivity: 0.2 };
  const fitKeys = ["sensitivity", "venueSensitivity", "standingsSensitivity", "homeBase", "awayBase"];
  const gd = (base) => (train) => pm.fitWeightsGradientDescent(train, base, { keys: fitKeys, iterations: 15 });
  await t("本物の改善: 現行の重みが実際と大きくずれているとき、勾配降下の候補は関門を通る(12通りの乱数すべて)", () => {
    const base = { ...W0, homeBase: 1.35, awayBase: 1.15, sensitivity: 0.05 };
    let passed = 0; const zs = [];
    for (let s = 1; s <= 12; s++) {
      const recs = makeRecords(1200, TRUE_W, 7000 + s);
      const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: gd(base), lossOf, baseWeights: base });
      if (cvg.decideCvGate(cv, GATE).pass) passed++; zs.push(Math.round(cv.z * 10) / 10);
    }
    console.log(`      通過 ${passed}/12(z: ${zs.join(", ")})`);
    assert.strictEqual(passed, 12);
  });
  await t("偶然①: 現行の重みがすでに実際どおりのとき、勾配降下の候補(記録への合わせすぎ)は通らない(12通りで 0)", () => {
    let passed = 0; const gains = [];
    for (let s = 1; s <= 12; s++) {
      const recs = makeRecords(1200, TRUE_W, 8000 + s);
      const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: gd(TRUE_W), lossOf, baseWeights: TRUE_W });
      if (cvg.decideCvGate(cv, GATE).pass) passed++; gains.push(Math.round(cv.gain * 10000) / 10000);
    }
    console.log(`      通過 ${passed}/12(束ねた改善: ${gains.join(", ")})`);
    assert.strictEqual(passed, 0);
  });
  await t("偶然②: 現行と同じだけ実際からずれた候補(良くも悪くもない)は、400通りのうち通るのが 5% 以下", () => {
    // 現行 = 実際より感度が +d、候補 = 実際より −d。どちらも同じくらい外れているので、本当の差はほぼ 0。
    //   候補は固定(学習用の記録に合わせて選ばない)。z だけの判定なら約5%が通る場面で、関門全体では何%通るかを数える。
    const d = 0.05;
    const base = { ...TRUE_W, sensitivity: TRUE_W.sensitivity + d }, cand = { ...TRUE_W, sensitivity: TRUE_W.sensitivity - d };
    let passed = 0, zOnly = 0;
    for (let s = 1; s <= 400; s++) {
      const recs = makeRecords(1500, TRUE_W, 20000 + s);
      const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: () => cand, lossOf, baseWeights: base });
      if (cv.z >= 1.64) zOnly++;
      if (cvg.decideCvGate(cv, GATE).pass) passed++;
    }
    console.log(`      関門を通過 ${passed}/400(${(passed / 4).toFixed(1)}%)。参考: z≥1.64 だけなら ${zOnly}/400(${(zOnly / 4).toFixed(1)}%)`);
    assert.ok(passed <= 20, `偶然の通過が多すぎる: ${passed}/400`);
    assert.ok(passed <= zOnly, "ほかの条件を足したのに、z だけの判定より多く通っている");
  });
  await t("偶然③: 学習用の記録で「いちばん良く見えた候補」を選んでも、検証用で選んでいないので偶然は通りにくい(200通りで 8% 以下)", () => {
    // 現行のまわりの4つの候補(どれも本当は現行より良くない)から、学習用の折でいちばん損失が小さいものを選ぶ手続き
    const base = { ...TRUE_W };
    const cands = [{ ...base, sensitivity: base.sensitivity * 1.2 }, { ...base, sensitivity: base.sensitivity * 0.8 }, { ...base, homeBase: base.homeBase + 0.1 }, { ...base, homeBase: base.homeBase - 0.1 }];
    const pick = (train) => { let best = null; const b0 = pm.computeNegativeLogLikelihood(train, base); for (const c of cands) { const l = pm.computeNegativeLogLikelihood(train, c); if (l < b0 - 1e-9 && (!best || l < best.l)) best = { c, l }; } return best ? best.c : null; };
    let passed = 0;
    for (let s = 1; s <= 200; s++) {
      const recs = makeRecords(1500, TRUE_W, 40000 + s);
      const cv = cvg.crossValidate(recs, { folds: 5, scheme: "blocked", procedure: pick, lossOf, baseWeights: base });
      if (cvg.decideCvGate(cv, GATE).pass) passed++;
    }
    console.log(`      関門を通過 ${passed}/200(${(passed / 2).toFixed(1)}%)`);
    assert.ok(passed <= 16, `偶然の通過が多すぎる: ${passed}/200`);
  });

  console.log("■ 4. 毎日の学習への組み込み(runDailyLearning を実際にまわす)");
  await t("既定は交差検証(cv)。現行の重みが実際と大きくずれている記録 700件 → 採用され、version が1つ進み、履歴に gate:\"cv\" と検定の数字が残る", async () => {
    const stored = { ...W0, sensitivity: 0.03, version: 33, updatedAt: "2026-10-15T00:00:00.000Z" };
    const { result, history, weightsAfter, mock } = await runWith(makeRecords(700, TRUE_W, 555), stored, { WEIGHT_GATE_MODE: null, WEIGHT_GATE_MIN_LOGLOSS_GAIN: null });
    const g = result.weightGate;
    // v102: 長い段階(③-b のクラブの収集・④-b の過去試合の取得)の途中で、進捗の時刻だけを更新する「心拍」が打たれている(段階の番号は進めない)
    const beat = mock.progressLog.find((p) => p.detail);
    assert.ok(beat, "段階の途中の心拍が1回も打たれていない");
    assert.ok(/^(クラブの基本情報の更新|名簿の更新|選手の一括取得|過去試合の取得 \d+件め|過去試合の交差検証.*)$/.test(beat.detail), beat.detail);
    assert.ok(/^(③-b|④-b) /.test(beat.stage), beat.stage); assert.strictEqual(beat.finished, false);
    const stageWrite = mock.progressLog.find((p) => !p.detail && p.stage === beat.stage);
    assert.strictEqual(beat.stageIndex, stageWrite.stageIndex, "心拍で段階の番号が進んだ");
    assert.strictEqual(mock.progressLog.filter((p) => p.detail).length, 1, "心拍は1分に1回まで(速いテストでは1回だけのはず)");
    assert.strictEqual(mock.progressLog[mock.progressLog.length - 1].finished, true, "最後は完了の記録で終わる");
    assert.strictEqual(g.mode, "cv"); assert.strictEqual(g.folds, 5); assert.strictEqual(g.minLogLossGain, 0.001); assert.strictEqual(g.minZ, 1.64);
    assert.strictEqual(g.records, 700); assert.strictEqual(g.validSize, 700, "5つのかたまり全部が検証に使われる(以前は3割=210件だけ)");
    assert.strictEqual(g.procedures.length, 3); assert.deepStrictEqual(g.procedures.map((p) => p.name), ["grid_search_v1", "gradient_descent_v2", "ablation"]);
    assert.ok(g.passed >= 1 && g.adoptedGate === "cv", JSON.stringify({ passed: g.passed, adopted: g.adoptedGate, reason: g.reasonJa }));
    assert.ok(g.z >= 1.64 && g.pooledGain >= 0.001 && Number.isFinite(g.pooledSe) && g.pooledSe > 0);
    const gdp = g.procedures.find((p) => p.name === "gradient_descent_v2");
    assert.strictEqual(gdp.passed, true); assert.strictEqual(gdp.n, 700); assert.strictEqual(gdp.perFold.length, 5); assert.ok(gdp.perFold.every((f) => f.train === 560 && f.valid === 140));
    assert.strictEqual(weightsAfter.version, 34); assert.ok(weightsAfter.sensitivity > 0.15, "学習した感度が実際(0.36)へ近づいていない: " + weightsAfter.sensitivity);
    const last = history[history.length - 1];
    assert.strictEqual(last.adopted, true); assert.strictEqual(last.gate, "cv"); assert.strictEqual(last.sampleSize, 700);
    assert.ok(last.cv && last.cv.folds === 5 && last.cv.z >= 1.64 && last.newLogLoss < last.oldLogLoss);
    assert.ok(/交差検証/.test(last.note) && /全件で実行した重みを採用/.test(last.note), last.note);
    assert.strictEqual(result.weightsUpdated, true);
  });
  await t("現行の重みがすでに実際どおり → どの手続きも通らず据え置き(version そのまま)。理由が手続きごとに残る", async () => {
    const stored = { ...TRUE_W, version: 33, updatedAt: "2026-10-15T00:00:00.000Z" };
    const { result, history, weightsAfter } = await runWith(makeRecords(700, TRUE_W, 556), stored, { WEIGHT_GATE_MODE: null });
    const g = result.weightGate;
    assert.strictEqual(g.mode, "cv"); assert.strictEqual(g.passed, 0); assert.strictEqual(g.adoptedGate, null);
    assert.strictEqual(weightsAfter.version, 33); assert.strictEqual(weightsAfter.sensitivity, TRUE_W.sensitivity);
    const last = history[history.length - 1];
    assert.strictEqual(last.adopted, false); assert.strictEqual(last.method, "cv_validated"); assert.strictEqual(last.gate, "cv");
    assert.ok(/どの手続きの候補も関門を通らなかった/.test(last.note), last.note);
    assert.ok(g.procedures.every((p) => typeof p.reasonJa === "string" && p.reasonJa.length > 5));
    assert.ok(Number.isFinite(g.baseValidLogLoss) && g.baseValidLogLoss > 0.8 && g.baseValidLogLoss < 1.2, "束ねた検証での現行の損失: " + g.baseValidLogLoss);
    assert.strictEqual(result.weightsUpdated, false);
  });
  await t("記録が少ない(60件)ときは、交差検証で判断せず据え置く(少ない記録での「たまたま」を採用しない)", async () => {
    const stored = { ...W0, sensitivity: 0.03, version: 5 };
    const { result, history, weightsAfter } = await runWith(makeRecords(60, TRUE_W, 557), stored, { WEIGHT_GATE_MODE: null });
    assert.strictEqual(result.weightGate.mode, "cv"); assert.strictEqual(result.weightGate.records, 60); assert.strictEqual(result.weightGate.passed, 0);
    assert.strictEqual(weightsAfter.version, 5);
    const last = history[history.length - 1];
    assert.strictEqual(last.method, "skipped_insufficient_cv"); assert.ok(/60件/.test(last.note) && /100件/.test(last.note), last.note);
  });
  await t("環境変数で以前の関門へ戻せる(WEIGHT_GATE_MODE=logloss。accuracy も同じ枝)。交差検証の分割数・z・改善の下限も変えられる", async () => {
    const stored = { ...W0, sensitivity: 0.03, version: 33 };
    const recs = makeRecords(700, TRUE_W, 558);
    const a = await runWith(recs, stored, { WEIGHT_GATE_MODE: "logloss" });
    assert.strictEqual(a.result.weightGate.mode, "logloss"); assert.strictEqual(a.result.weightGate.minLogLossGain, 0.002, "以前の関門の既定値は 0.002 のまま");
    assert.strictEqual(a.result.weightGate.fitSize, 490); assert.strictEqual(a.result.weightGate.validSize, 210);
    assert.strictEqual(a.result.weightGate.procedures, undefined);
    const c = await runWith(recs, stored, { WEIGHT_GATE_MODE: "cv", WEIGHT_GATE_CV_FOLDS: "4", WEIGHT_GATE_MIN_Z: "99", WEIGHT_GATE_MIN_LOGLOSS_GAIN: "0.003" });
    assert.strictEqual(c.result.weightGate.folds, 4); assert.strictEqual(c.result.weightGate.minZ, 99); assert.strictEqual(c.result.weightGate.minLogLossGain, 0.003);
    assert.strictEqual(c.result.weightGate.passed, 0, "z の下限を 99 にしたら通らない"); assert.strictEqual(c.weightsAfter.version, 33);
    assert.ok(c.result.weightGate.procedures.every((p) => p.perFold.length === 4));
    // 関門の種類の読み取り(コードの上で): accuracy → 従来の的中率の関門、logloss → v100 の関門、それ以外(未設定を含む)→ cv
    const src = require("fs").readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    assert.ok(src.includes('const gateModeRaw = String(process.env.WEIGHT_GATE_MODE || "cv").toLowerCase();'));
    assert.ok(src.includes('const GATE_MODE = gateModeRaw === "accuracy" ? "accuracy" : gateModeRaw === "logloss" ? "logloss" : "cv";'));
  });

  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
