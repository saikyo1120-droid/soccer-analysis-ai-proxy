/**
 * scripts/daily_intelligence_proof_test.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズの証明テスト。
 * 「実装しました」ではなく「実際に動いて、毎日賢くなっている」ことを、
 * 本物の runDailyLearning を複数日ぶん実行して数値とログで証明する。
 *
 *  A. trustEngine       … ⑤ 信頼度(出所×鮮度)の計算
 *  B. accuracyTracker   … ⑨ 市場別の採点(Brier/LogLoss/較正)と日次比較
 *  C. predictionShift   … ① 「学習で予測がどう変わったか」の実計算
 *  D. learningAgenda    … ⑩ 弱点の実測→学習計画→翌日の収集への反映
 *  E. 特徴量の有効性     … ⑧ 有効/有害の実測と自動0化候補
 *  F. 3日間シミュレーション … ①〜⑩が本物の日次学習で連鎖して動く証明:
 *     1日目: 学習→重み更新(v0→v1)→「予測がどう変わったか」記録
 *     2日目: 1日目の予測(v0)を答え合わせ(外れ)。新規予測はv1を使用
 *             =「昨日の学習が今日の予測に反映された」ログ証明
 *     3日目: 2日目の予測(v1)を答え合わせ(的中)。前日比で精度改善を数値証明
 */

const assert = require("assert");
const { runDailyLearning } = require("../server/learning/dailyJob");
const { trustOf, sampleWeightOf, buildFeatureTrust, SOURCE_TRUST } = require("../server/learning/trustEngine");
const {
  computeMarketProbs, outcomesFromScore, scorePrediction,
  buildDailyAccuracy, mergeDailyAccuracy, summarizeAccuracy,
  saveDailyAccuracy, getAccuracyTrend,
} = require("../server/learning/accuracyTracker");
const { computePredictionShift } = require("../server/learning/predictionShift");
const { buildLearningAgenda, priorityClubsOf, saveAgenda, loadLatestAgenda } = require("../server/learning/learningAgenda");
const { computeFeatureEffectiveness, buildAblationCandidates, EXTENDED_DEFAULT_WEIGHTS } = require("../server/learning/predictionModel");
const { REGISTERED_TEAMS } = require("../server/learning/registeredTeams");

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") { const [k, v, flag] = args; if (flag === "NX" && store.has(k)) return null; store.set(k, v); return "OK"; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "INCRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c + parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; return l.slice(st, en + 1); }
    if (op === "LREM") { const [k, , v] = args; store.set(k, (store.get(k) || []).filter((x) => x !== v)); return 1; }
    if (op === "LTRIM") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; store.set(k, l.slice(st, en + 1)); return "OK"; }
    if (op === "EXPIRE") return 1;
    return null;
  }
  async function upstashGetJSON(k) { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); }
  async function upstashSetJSON(k, v) { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; }
  return { store, upstashCmd, upstashGetJSON, upstashSetJSON };
}

async function main() {
  console.log("=== A. trustEngine: 信頼度=出所×鮮度(ご指示⑤) ===");

  await ok("A1: 取得直後のAPI-Football実データは信頼度0.95", () => {
    const now = Date.now();
    const t = trustOf({ source: "api-football", kind: "injuries", computedAt: new Date(now).toISOString(), nowMs: now });
    assert.strictEqual(t.score, 0.95);
  });

  await ok("A2: 古い情報ほど自動で評価が下がる(怪我情報は72時間で半減)", () => {
    const now = Date.now();
    const t72 = trustOf({ source: "api-football", kind: "injuries", computedAt: new Date(now - 72 * 3600000).toISOString(), nowMs: now });
    const t144 = trustOf({ source: "api-football", kind: "injuries", computedAt: new Date(now - 144 * 3600000).toISOString(), nowMs: now });
    assert.ok(Math.abs(t72.score - 0.48) <= 0.01, `72時間後は約半分のはず: ${t72.score}`);
    assert.ok(Math.abs(t144.score - 0.24) <= 0.01, `144時間後は約1/4のはず: ${t144.score}`);
    // ほぼ変わらない基本情報は同じ経過時間でも下がりにくい
    const basic = trustOf({ source: "api-football", kind: "basic", computedAt: new Date(now - 144 * 3600000).toISOString(), nowMs: now });
    assert.ok(basic.score >= 0.9, `基本情報の半減期は84日なので144時間ではほぼ下がらないはず: ${basic.score}`);
  });

  await ok("A3: AI推定(0.2)・静的スナップショット(0.6)は実データより必ず低い", () => {
    assert.strictEqual(SOURCE_TRUST["ai-estimate"].base, 0.2);
    assert.strictEqual(SOURCE_TRUST["static-snapshot"].base, 0.6);
    const now = Date.now();
    const ai = trustOf({ source: "ai-estimate", kind: "form", computedAt: new Date(now).toISOString(), nowMs: now });
    const real = trustOf({ source: "api-football", kind: "form", computedAt: new Date(now - 96 * 3600000).toISOString(), nowMs: now });
    assert.ok(ai.score < real.score, "取得直後のAI推定より、1半減期経過した実データの方がまだ信頼できる");
  });

  await ok("A4: 取得時刻が不明なデータは鮮度を厳しめ(半減1回分)に扱う", () => {
    const t = trustOf({ source: "api-football", kind: "form", computedAt: null, nowMs: Date.now() });
    assert.ok(Math.abs(t.score - 0.475) <= 0.01, String(t.score));
  });

  await ok("A5: 学習のサンプル重み=信頼度平均(記録が無い古いレコードは1.0で除外しない)", () => {
    assert.strictEqual(sampleWeightOf({}), 1);
    assert.strictEqual(sampleWeightOf({ featureTrust: { avgScore: 0.6 } }), 0.6);
    assert.strictEqual(sampleWeightOf({ featureTrust: { avgScore: 0.01 } }), 0.1, "下限0.1でクランプ");
    const now = Date.now();
    const ft = buildFeatureTrust([
      { key: "form", source: "derived", kind: "form", computedAt: new Date(now).toISOString() },
      { key: "xg", source: "api-football", kind: "xg", computedAt: new Date(now - 480 * 3600000).toISOString() },
    ], now);
    assert.ok(ft.avgScore > 0 && ft.avgScore < 1);
    assert.ok(ft.noteJa.includes("xg"), "信頼度が下がっているデータを名指しで注記する");
  });

  console.log("=== B. accuracyTracker: 市場別の採点と日次比較(ご指示⑨) ===");

  await ok("B1: 全市場の確率は勝敗と同じポアソン分布から導出される(別の予想を作らない)", () => {
    const p = computeMarketProbs(2.0, 1.0);
    assert.ok(Math.abs(p.homeWin + p.draw + p.awayWin - 1) < 1e-9, "1X2の確率は合計1");
    assert.ok(p.homeWin > p.awayWin, "λが大きい側の勝率が高い");
    const high = computeMarketProbs(2.5, 2.0);
    const low = computeMarketProbs(0.8, 0.6);
    assert.ok(high.over25 > low.over25, "λ合計が大きいほどOver2.5の確率が高い");
    assert.ok(high.btts > low.btts);
  });

  await ok("B2: 実スコアからの結果判定(2-1=ホーム勝ち・BTTS成立・Over2.5成立)", () => {
    assert.deepStrictEqual(outcomesFromScore(2, 1), { winner: "home", btts: true, over25: true });
    assert.deepStrictEqual(outcomesFromScore(0, 0), { winner: "draw", btts: false, over25: false });
    assert.strictEqual(outcomesFromScore(null, 1), null, "スコア不明なら判定しない");
  });

  await ok("B3: 採点=自信満々で外すほどBrier/LogLossが大きく罰される", () => {
    const confident = { homeLambda: 2.8, awayLambda: 0.5, predictedWinner: "home", actualWinner: "away", actualScore: { home: 0, away: 2 }, predictedScoreline: "2-0" };
    const humble = { homeLambda: 1.4, awayLambda: 1.2, predictedWinner: "home", actualWinner: "away", actualScore: { home: 0, away: 2 }, predictedScoreline: "1-1" };
    const sc = scorePrediction(confident);
    const sh = scorePrediction(humble);
    assert.ok(sc.markets.oneX2.brier > sh.markets.oneX2.brier, "強い自信で外した方がBrierが大きい");
    assert.ok(sc.markets.oneX2.logLoss > sh.markets.oneX2.logLoss);
    assert.strictEqual(sc.markets.oneX2.hit, false);
    assert.ok(sc.markets.btts && Number.isFinite(sc.markets.btts.brier), "BTTSも採点される");
    assert.ok(sc.markets.over25 && Number.isFinite(sc.markets.over25.brier), "Over/Under2.5も採点される");
    assert.strictEqual(sc.markets.scoreline.hit, false);
  });

  await ok("B4: 日次集計は加算マージでき、的中率・平均Brier・較正表を返す", () => {
    const s1 = scorePrediction({ homeLambda: 2.2, awayLambda: 0.8, predictedWinner: "home", actualWinner: "home", actualScore: { home: 2, away: 0 } });
    const s2 = scorePrediction({ homeLambda: 1.0, awayLambda: 2.0, predictedWinner: "away", actualWinner: "home", actualScore: { home: 1, away: 0 } });
    const aggA = buildDailyAccuracy([s1]);
    const aggB = buildDailyAccuracy([s2]);
    const merged = mergeDailyAccuracy(aggA, aggB);
    assert.strictEqual(merged.oneX2.n, 2);
    assert.strictEqual(merged.oneX2.hits, 1);
    const sum = summarizeAccuracy(merged);
    assert.strictEqual(sum.markets.oneX2.hitRatePct, 50);
    assert.ok(sum.markets.oneX2.avgBrier > 0);
    assert.ok(sum.markets.oneX2.calibration.length >= 1, "較正表(自信の帯ごとの実際の的中率)がある");
  });

  await ok("B5: 昨日との比較=両日とも測定できた場合だけ差を出す(推測で埋めない)", async () => {
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    const good = buildDailyAccuracy([scorePrediction({ homeLambda: 2.2, awayLambda: 0.8, predictedWinner: "home", actualWinner: "home", actualScore: { home: 2, away: 0 } })]);
    const bad = buildDailyAccuracy([scorePrediction({ homeLambda: 2.2, awayLambda: 0.8, predictedWinner: "home", actualWinner: "away", actualScore: { home: 0, away: 1 } })]);
    await saveDailyAccuracy(deps, "2026-08-20", bad);
    await saveDailyAccuracy(deps, "2026-08-21", good);
    const trend = await getAccuracyTrend(deps, "2026-08-21");
    assert.strictEqual(trend.available, true);
    assert.strictEqual(trend.vsYesterday.hitRateDeltaPct, 100, "0%→100%で+100pt");
    assert.ok(trend.vsYesterday.brierDelta < 0, "Brierは減少=改善");
    // 記録が無い日と比較する場合は正直に「測定できない」
    const trendEmpty = await getAccuracyTrend(deps, "2026-08-25");
    assert.ok(trendEmpty.vsYesterday.noteJa.includes("測定できません"));
  });

  console.log("=== C. predictionShift: 学習で予測がどう変わったか(ご指示①) ===");

  await ok("C1: 同じ重みなら変化0(でっち上げの変化を作らない)", () => {
    const recs = [{ features: { formDiff: 2 }, homeTeamEn: "A", awayTeamEn: "B" }];
    const w = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.3, awayBase: 1.1 };
    const shift = computePredictionShift(recs, w, { ...w });
    assert.strictEqual(shift.homeWinPctDelta, 0);
    assert.strictEqual(shift.drawPctDelta, 0);
    assert.ok(shift.summaryJa.includes("ほとんど変わりません") || shift.summaryJa.includes("微調整"));
  });

  await ok("C2: 重みが変わると「ホーム勝率+N% / 引き分け-N% / 自信+N%」を実計算で返す", () => {
    const recs = [
      { features: { formDiff: 2 }, homeTeamEn: "Strong FC", awayTeamEn: "Weak FC" },
      { features: { formDiff: 1.5 }, homeTeamEn: "Solid FC", awayTeamEn: "Soft FC" },
    ];
    const oldW = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02 };
    const newW = { ...oldW, sensitivity: 0.5 };
    const shift = computePredictionShift(recs, oldW, newW);
    assert.ok(shift.homeWinPctDelta > 5, `フォーム重視に変わればホーム勝率の見方が上がるはず: ${shift.homeWinPctDelta}`);
    assert.ok(shift.confidencePctDelta > 0, "自信も上がるはず");
    assert.ok(/ホーム勝率の見方が平均\+[\d.]+%変化/.test(shift.summaryJa), shift.summaryJa);
    assert.ok(shift.biggestExample && shift.biggestExample.flipped, "予想勝者が変わった代表例が特定される");
  });

  console.log("=== D. learningAgenda: AIが次に学ぶテーマを決める(ご指示⑩) ===");

  await ok("D1: 材料が少ないうちは「苦手」を断定しない(正直な注記)", () => {
    const agenda = buildLearningAgenda([{ resolved: true, correct: false, homeTeamEn: "X", awayTeamEn: "Y" }], [], { nowIso: "2026-08-20T00:00:00Z" });
    assert.strictEqual(agenda.items.length, 0);
    assert.ok(agenda.noteJa.includes("断定できる材料がありません"));
  });

  await ok("D2: 実測で的中率の低いクラブを特定し、優先収集の対象にする", () => {
    const records = [];
    // Real Madrid絡みは4戦全敗、その他は12戦全勝 → 全体75%、Real Madrid 0%
    for (let i = 0; i < 4; i++) records.push({ resolved: true, correct: false, homeTeamEn: "Real Madrid", awayTeamEn: `Other${i}` });
    for (let i = 0; i < 12; i++) records.push({ resolved: true, correct: true, homeTeamEn: `TeamA${i}`, awayTeamEn: `TeamB${i}` });
    const agenda = buildLearningAgenda(records, [], { nowIso: "2026-08-20T00:00:00Z" });
    const clubItem = agenda.items.find((it) => it.kind === "club" && it.targetEn === "Real Madrid");
    assert.ok(clubItem, "Real Madridが苦手クラブとして特定されるはず");
    assert.ok(clubItem.targetJa === "レアル・マドリード", "TOP100の日本語名で表示");
    assert.ok(/的中率が0%/.test(clubItem.reasonJa), clubItem.reasonJa);
    assert.deepStrictEqual(priorityClubsOf(agenda), ["Real Madrid"]);
  });

  await ok("D3: 外れた理由の頻度から学習テーマを立てる(1回だけの外れでは方針を変えない)", () => {
    const agenda = buildLearningAgenda([], [
      { id: "xgDiff_underweighted", labelJa: "xG(期待得点)との差を見逃した", count: 3 },
      { id: "injuryDiff_underweighted", labelJa: "怪我人を軽視した", count: 1 },
    ], { nowIso: "2026-08-20T00:00:00Z" });
    assert.ok(agenda.items.some((it) => it.kind === "theme" && it.targetEn === "xgDiff_underweighted"));
    assert.ok(!agenda.items.some((it) => it.targetEn === "injuryDiff_underweighted"), "1回だけの外れは採用しない");
  });

  await ok("D4: 計画は保存され、翌日読み出せる", async () => {
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    const agenda = buildLearningAgenda([], [], { nowIso: "2026-08-20T00:00:00Z" });
    assert.strictEqual(await saveAgenda(deps, "2026-08-20", agenda), true);
    const loaded = await loadLatestAgenda(deps);
    assert.strictEqual(loaded.generatedAt, "2026-08-20T00:00:00Z");
  });

  console.log("=== E. 特徴量の有効性(ご指示⑧) ===");

  const effRecords = [];
  for (let i = 0; i < 20; i++) {
    const homeStrong = i % 2 === 0;
    effRecords.push({
      resolved: true, actualWinner: homeStrong ? "home" : "away",
      // formDiffは結果と一致(有効)、xgDiffは結果と逆(有害)
      features: { formDiff: homeStrong ? 1 : -1, xgDiff: homeStrong ? -1 : 1 },
    });
  }
  const effWeights = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.2, awayBase: 1.2, sensitivity: 0.3, xgSensitivity: 0.3 };

  await ok("E1: 有効な特徴量と有害な特徴量を実測で区別する", () => {
    const report = computeFeatureEffectiveness(effRecords, effWeights);
    assert.strictEqual(report.measurable, true);
    const form = report.features.find((f) => f.key === "formDiff");
    const xg = report.features.find((f) => f.key === "xgDiff");
    assert.ok(form.contribution > 0, `結果と一致する特徴量は正の寄与のはず: ${form.contribution}`);
    assert.ok(form.verdictJa.includes("有効"));
    assert.ok(xg.contribution < 0, `結果と逆の特徴量は負の寄与のはず: ${xg.contribution}`);
    assert.ok(xg.verdictJa.includes("有害"));
    const unlearned = report.features.find((f) => f.key === "injuryDiff");
    assert.ok(unlearned.verdictJa.includes("未学習"), "重み0の特徴量は「未学習」と正直に区別");
  });

  await ok("E2: 有害な特徴量は0化候補になり、検証の関門を通ってから採用される", () => {
    const report = computeFeatureEffectiveness(effRecords, effWeights);
    const candidates = buildAblationCandidates(report, effWeights);
    assert.ok(candidates.some((c) => c.method === "ablation_xgDiff"), "有害と実測されたxgDiffの0化候補が作られる");
    const xgCand = candidates.find((c) => c.method === "ablation_xgDiff");
    assert.strictEqual(xgCand.w.xgSensitivity, 0);
    assert.strictEqual(xgCand.w.sensitivity, effWeights.sensitivity, "他の重みは変えない");
  });

  await ok("E3: 検証データ不足なら測定しない(でっち上げ防止)", () => {
    const report = computeFeatureEffectiveness(effRecords.slice(0, 3), effWeights);
    assert.strictEqual(report.measurable, false);
    assert.ok(report.reasonJa.includes("5件以上"));
  });

  console.log("=== F. 3日間シミュレーション: 毎日賢くなる連鎖の証明(①〜⑩) ===");

  // ---- 状態つきモックAPI: 「今日」立てた予測の試合が「明日」終わる ----
  const fixtureBook = new Map(); // fixtureId -> { homeId }
  let simDay = 0;
  const teamIdOf = new Map(REGISTERED_TEAMS.map((t, i) => [t.nameEn, 200 + i]));
  const OPP_ID = 9999;
  function winsFor(teamId, n) {
    const now = Date.parse("2026-08-20T00:00:00Z");
    return Array.from({ length: n }, (_, i) => ({
      fixture: { id: teamId * 1000 + i, date: new Date(now - (i + 1) * 4 * 86400e3).toISOString(), status: { short: "FT" } },
      teams: { home: { id: teamId }, away: { id: OPP_ID } },
      goals: { home: 1, away: 0 },
      league: { id: 39 },
    }));
  }
  function lossesFor(teamId, n) {
    return winsFor(teamId, n).map((f) => ({ ...f, teams: { home: { id: teamId }, away: { id: 12345 } }, goals: { home: 0, away: 1 } }));
  }
  async function simApi(endpoint, params) {
    if (endpoint === "/teams") {
      const known = teamIdOf.get(params.search);
      return { response: [{ team: { id: known || 100, name: params.search } }] };
    }
    if (endpoint === "/fixtures" && params.id) {
      const meta = fixtureBook.get(Number(params.id));
      if (!meta) return { response: [] };
      // 実結果はフォームどおり(ホーム=登録クラブが2-0で勝つ)。
      return { response: [{
        fixture: { id: Number(params.id), date: meta.kickoff, status: { short: "FT" } },
        teams: { home: { id: meta.homeId, name: meta.homeName }, away: { id: OPP_ID, name: "Opponent FC" } },
        goals: { home: 2, away: 0 },
        league: { id: 39 },
      }] };
    }
    if (endpoint === "/fixtures" && params.next) {
      const teamId = params.team;
      const fid = 700000 + teamId * 100 + simDay;
      const kickoff = new Date(Date.parse("2026-08-20T00:00:00Z") + simDay * 86400e3 + 6 * 3600e3).toISOString();
      const entry = [...teamIdOf.entries()].find(([, id]) => id === teamId);
      fixtureBook.set(fid, { homeId: teamId, homeName: entry ? entry[0] : "Unknown", kickoff });
      return { response: [{
        fixture: { id: fid, date: kickoff, status: { short: "NS" } },
        teams: { home: { id: teamId, name: entry ? entry[0] : "Unknown" }, away: { id: OPP_ID, name: "Opponent FC" } },
        goals: { home: null, away: null },
        league: { id: 39, season: 2026 },
      }] };
    }
    if (endpoint === "/fixtures" && params.last) {
      // 登録クラブは直近5連勝(フォーム+1)、対戦相手は5連敗(フォーム-1)。
      // formDiff=+2の「弱いが本物の」シグナル。初期の重み(sensitivity 0.02)では
      // 引き分け予想になって外れ、学習後(sensitivity≧0.1)はホーム勝ち予想で当たる。
      if (params.team === OPP_ID || params.team === 12345) return { response: lossesFor(params.team, 10) };
      return { response: winsFor(params.team, 10) };
    }
    return { response: [] };
  }
  const resolveTeamIdSim = async (name) => teamIdOf.get(name) || 100;

  // ---- 事前seed: 30件の検証済み予測(弱いフォーム差が結果を決めるデータ)。
  //      初期重み(壊れた状態: sensitivity 0.02)では全問「引き分け」予想=0%。
  //      学習すれば100%になれる=学習の効果が測定できる教材。 ----
  const sim = createMockRedis();
  const seeds = [];
  for (let i = 0; i < 30; i++) {
    const homeStrong = i % 2 === 0;
    seeds.push({
      fixtureId: 9000 + i,
      predictedWinner: "draw", actualWinner: homeStrong ? "home" : "away",
      correct: false, resolved: true,
      features: { formDiff: homeStrong ? 0.5 : -0.5, goalRateDiff: homeStrong ? 0.3 : -0.3, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
      weightsSnapshot: { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02 },
    });
  }
  await sim.upstashCmd(["SET", "learn:ownpred:resolved", "30"]);
  await sim.upstashCmd(["SET", "learn:ownpred:correct", "0"]);
  for (const r of seeds) await sim.upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(r)]);
  await sim.upstashSetJSON("learn:weights", { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02, version: 0, updatedAt: null });
  // ご指示⑩の実行確認: 前日にAIが立てた学習計画(優先クラブ)を仕込んでおく
  await sim.upstashSetJSON("learn:agenda:latest", {
    generatedAt: "2026-08-19T00:00:00Z",
    items: [{ priority: 1, kind: "club", targetEn: "Real Madrid", targetJa: "レアル・マドリード", reasonJa: "テスト用", actionJa: "優先更新" }],
  });

  const simDeps = { callApiFootball: simApi, resolveTeamId: resolveTeamIdSim, upstashEnabled: true, ...sim };
  let day1, day2, day3;

  await ok("F1(1日目): 学習が走り、検証で改善が証明された重みだけがv1として採用される", async () => {
    simDay = 0;
    day1 = await runDailyLearning({ ...simDeps, now: () => new Date("2026-08-20T03:00:00Z") });
    assert.strictEqual(day1.ok, true);
    const weights = await sim.upstashGetJSON("learn:weights");
    assert.strictEqual(weights.version, 1, `重みがv0→v1へ更新されるはず(sensitivity=${weights.sensitivity})`);
    assert.ok(weights.sensitivity > 0.05, "フォーム差の重要度が実際に学習されている");
    const history = (await sim.upstashCmd(["LRANGE", "learn:weights:history", "0", "-1"])).map((s) => JSON.parse(s));
    const adopted = history.find((h) => h.adopted);
    assert.ok(adopted, "採用の記録が履歴に残る");
    assert.ok(adopted.newAccuracy > adopted.oldAccuracy, `検証用データで本当に改善した場合のみ採用(${adopted.oldAccuracy}%→${adopted.newAccuracy}%)`);
    console.log(`        → 重みv1採用: 検証用の的中率 ${adopted.oldAccuracy}% → ${adopted.newAccuracy}%`);
  });

  await ok("F1-b(①): 「その学習で予測がどう変わったか」が±%の実数で記録される", async () => {
    assert.ok(day1.predictionShift, "growthLogに予測変化が記録される");
    const s = day1.predictionShift;
    assert.ok(Number.isFinite(s.homeWinPctDelta) && Number.isFinite(s.drawPctDelta) && Number.isFinite(s.confidencePctDelta));
    assert.ok(Math.abs(s.drawPctDelta) > 1, `引き分け一辺倒→勝敗判定に変わるので引き分け確率が大きく動くはず: ${s.drawPctDelta}`);
    assert.ok(s.summaryJa.includes("%変化"), s.summaryJa);
    const impact = (await sim.upstashCmd(["LRANGE", "learn:weights:impact", "0", "-1"])).map((x) => JSON.parse(x));
    assert.ok(impact.length >= 1 && impact[0].weightsVersionTo === 1, "learn:weights:impactにも保存される");
    console.log(`        → ${s.summaryJa}`);
  });

  await ok("F1-c(⑧⑩): 特徴量の有効性レポートと学習計画が同じ実行内で生成・保存される", async () => {
    assert.ok(day1.featureEffectiveness && day1.featureEffectiveness.measurable, "特徴量の有効性が測定される");
    assert.ok(day1.featureEffectiveness.features.length >= 5);
    assert.ok(day1.learningAgenda, "学習計画が生成される");
    const savedAgenda = await sim.upstashGetJSON("learn:agenda:2026-08-20");
    assert.ok(savedAgenda, "計画が日付キーで保存される");
    // ご指示⑩の実行確認: 前日の計画(Real Madrid優先)が今日の収集に渡っている
    assert.ok(day1.agendaAppliedToday && day1.agendaAppliedToday.priorityClubs.includes("Real Madrid"),
      "前日の計画の優先クラブが今日の収集に実際に反映される");
  });

  await ok("F2(2日目): 1日目の予測(v0)を答え合わせし、新規予測はv1を使う=昨日の学習が今日の予測に反映", async () => {
    simDay = 1;
    day2 = await runDailyLearning({ ...simDeps, now: () => new Date("2026-08-21T03:00:00Z") });
    assert.ok(day2.matchesResolvedToday >= 1, `1日目の予測が答え合わせされるはず(${day2.matchesResolvedToday}件)`);
    assert.ok(day2.accuracyScoredToday >= 1, "市場別の採点も行われる");
    // 「昨日の学習が今日の予測に反映された」のログ証明:
    assert.strictEqual(day1.learningProof.weightsVersionUsedForTodaysPredictions, 0, "1日目の予測は学習前の重みv0");
    assert.strictEqual(day2.learningProof.weightsVersionUsedForTodaysPredictions, 1, "2日目の予測は1日目に学習した重みv1");
    assert.ok(day2.learningProof.noteJa.includes("version 1"), day2.learningProof.noteJa);
    // 実際の予測レコードでも確認(ログだけでなく保存データそのもの)
    const pending = await sim.upstashCmd(["LRANGE", "learn:ownpred:pending", "0", "-1"]);
    let v1Count = 0;
    for (const id of pending) {
      const rec = await sim.upstashGetJSON(`learn:ownpred:${id}`);
      if (rec && rec.weightsVersion === 1) v1Count++;
    }
    assert.ok(v1Count >= 1, "2日目の新規予測レコードにweightsVersion=1が保存されている");
    console.log(`        → 1日目の予測=重みv0 / 2日目の予測=重みv1(${v1Count}件)。昨日の学習が今日の予測に反映されたことをログと保存データの両方で確認`);
  });

  await ok("F2-b(⑨): 答え合わせの結果が実スコア・市場別採点つきで保存される", async () => {
    const acc = await sim.upstashGetJSON("learn:accuracy:2026-08-21");
    assert.ok(acc && acc.oneX2.n >= 1, "日次の精度記録が保存される");
    const recent = (await sim.upstashCmd(["LRANGE", "learn:ownpred:recent", "0", "-1"])).map((s) => JSON.parse(s));
    const resolved = recent.filter((r) => r.actualScore);
    assert.ok(resolved.length >= 1, "実スコアが記録される");
    assert.ok(resolved[0].marketScores && resolved[0].marketScores.markets.btts, "BTTS/Over-Underまで採点される");
  });

  await ok("F3(3日目): 学習後の予測が的中し、前日比の精度改善が数値で証明される", async () => {
    simDay = 2;
    day3 = await runDailyLearning({ ...simDeps, now: () => new Date("2026-08-22T03:00:00Z") });
    assert.ok(day3.matchesResolvedToday >= 1, "2日目の予測(v1)が答え合わせされる");
    const trend = await getAccuracyTrend({ upstashEnabled: true, ...sim }, "2026-08-22");
    assert.strictEqual(trend.available, true);
    assert.ok(trend.today && trend.today.markets.oneX2.measurable, "今日の精度が測定できる");
    assert.ok(trend.yesterday && trend.yesterday.markets.oneX2.measurable, "昨日の精度が測定できる");
    assert.strictEqual(trend.today.markets.oneX2.hitRatePct, 100, "学習後(v1)の予測は的中する");
    assert.strictEqual(trend.yesterday.markets.oneX2.hitRatePct, 0, "学習前(v0)の予測は外れていた");
    assert.strictEqual(trend.vsYesterday.hitRateDeltaPct, 100, "前日比+100ポイントの改善が数値で出る");
    assert.ok(trend.vsYesterday.brierDelta < 0, "Brier Scoreも改善(減少)");
    console.log(`        → 的中率: 昨日${trend.yesterday.markets.oneX2.hitRatePct}%(学習前の重みv0) → 今日${trend.today.markets.oneX2.hitRatePct}%(学習後の重みv1)。前日比${trend.vsYesterday.hitRateDeltaPct > 0 ? "+" : ""}${trend.vsYesterday.hitRateDeltaPct}pt、Brier${trend.vsYesterday.brierDelta}`);
  });

  await ok("F4(④): 外れた予測には「なぜ外れたか」の分析が自動で付き、次の学習の材料になる", async () => {
    const recent = (await sim.upstashCmd(["LRANGE", "learn:ownpred:recent", "0", "-1"])).map((s) => JSON.parse(s));
    const misses = recent.filter((r) => r.correct === false && Array.isArray(r.failureReasons) && r.failureReasons.length);
    assert.ok(misses.length >= 1, "外れた予測に理由分析が付いている");
    const hits = recent.filter((r) => r.correct === true && Array.isArray(r.successReasons) && r.successReasons.length);
    assert.ok(hits.length >= 1, "当たった予測にも理由分析が付いている");
  });

  console.log(`\n結果: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
