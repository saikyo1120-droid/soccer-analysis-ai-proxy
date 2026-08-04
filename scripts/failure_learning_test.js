/**
 * 2026年8月・「議論できるAI」強化フェーズ ご要望①(Failure Learning)のテスト。
 *   - predictionModel.js の classifyFailureReasons/summarizeFailureReasons が、
 *     予測時点の特徴量・重みだけから正直に(でっち上げず)理由を分類できるか。
 *   - dailyJob.js の runDailyLearning() が、外れた予測について
 *     ①record.failureReasonsを保存する ②Knowledge Engineに
 *     「predictionFailureReason」としてanalysis保存する(→議論モードの根拠プールに
 *     も乗る) ③growthLog.failureReasonsToday/topFailureReasonsRecentに反映する
 *     ことを、実際に確認する。
 */
const assert = require("assert");
const {
  classifyFailureReasons, summarizeFailureReasons, EXTENDED_DEFAULT_WEIGHTS,
} = require("../server/learning/predictionModel");
const { runDailyLearning, REGISTERED_TEAMS } = require("../server/learning/dailyJob");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

// ---- classifyFailureReasons(純粋関数)のテスト ----

test("classifyFailureReasons: 的中した予測は空配列を返す(理由のでっち上げをしない)", () => {
  const record = { predictedWinner: "home", actualWinner: "home", correct: true, features: {}, weightsSnapshot: EXTENDED_DEFAULT_WEIGHTS };
  assert.deepStrictEqual(classifyFailureReasons(record, EXTENDED_DEFAULT_WEIGHTS), []);
});

test("classifyFailureReasons: ホーム補正が強すぎて外れた場合、home_bonus_overweightedを検出する", () => {
  const weights = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.9, awayBase: 1.1 }; // 差0.8(閾値0.3以上)
  const record = {
    predictedWinner: "home", actualWinner: "away", correct: false,
    features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    weightsSnapshot: weights,
  };
  const reasons = classifyFailureReasons(record, weights);
  assert.ok(reasons.some((r) => r.id === "home_bonus_overweighted"), `home_bonus_overweightedが含まれるはず, got: ${JSON.stringify(reasons)}`);
});

test("classifyFailureReasons: 過去対戦を根拠に予想したが外れた場合、headToHeadDiff_overweightedを検出する", () => {
  const weights = { ...EXTENDED_DEFAULT_WEIGHTS, headToHeadSensitivity: 0.5 };
  const record = {
    predictedWinner: "home", actualWinner: "away", correct: false,
    features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 3, fatigueDiff: 0 },
    weightsSnapshot: weights,
  };
  const reasons = classifyFailureReasons(record, weights);
  assert.ok(reasons.some((r) => r.id === "headToHeadDiff_overweighted" && r.labelJa === "過去対戦を重視しすぎた"), `got: ${JSON.stringify(reasons)}`);
});

test("classifyFailureReasons: 怪我人の差が実際の結果方向を示していたのに重みがほぼ0だった場合、injuryDiff_underweightedを検出する(怪我人を軽視した)", () => {
  const weights = { ...EXTENDED_DEFAULT_WEIGHTS, injurySensitivity: 0 }; // まだ学習していない(0)
  const record = {
    predictedWinner: "home", actualWinner: "away", correct: false,
    // injuryDiff = away - home。負の値はホーム側に有利な符号のはずだが、
    // ここではawayが実際に勝ったので「away方向を示す」ケースを作るため符号を負に。
    features: { formDiff: 0, goalRateDiff: 0, injuryDiff: -2, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    weightsSnapshot: weights,
  };
  const reasons = classifyFailureReasons(record, weights);
  assert.ok(reasons.some((r) => r.id === "injuryDiff_underweighted" && r.labelJa === "怪我人を軽視した"), `got: ${JSON.stringify(reasons)}`);
});

test("classifyFailureReasons: v1のみの古いレコード(featuresが無い)でも、正直に「モデルが扱っていない要因」を返す(でっち上げない)", () => {
  const record = { predictedWinner: "home", actualWinner: "draw", correct: false };
  const reasons = classifyFailureReasons(record, EXTENDED_DEFAULT_WEIGHTS);
  assert.strictEqual(reasons.length, 1);
  assert.strictEqual(reasons[0].id, "unmodeled_factors");
});

test("summarizeFailureReasons: 頻度順に集計し、的中した記録は無視する", () => {
  const records = [
    { correct: false, failureReasons: [{ id: "headToHeadDiff_overweighted", labelJa: "過去対戦を重視しすぎた" }] },
    { correct: false, failureReasons: [{ id: "headToHeadDiff_overweighted", labelJa: "過去対戦を重視しすぎた" }, { id: "injuryDiff_underweighted", labelJa: "怪我人を軽視した" }] },
    { correct: true, failureReasons: [] },
    { correct: false, failureReasons: [] }, // 外れたがfailureReasonsが空(旧データ等)
  ];
  const summary = summarizeFailureReasons(records, 5);
  assert.strictEqual(summary[0].id, "headToHeadDiff_overweighted");
  assert.strictEqual(summary[0].count, 2);
  assert.strictEqual(summary[1].id, "injuryDiff_underweighted");
  assert.strictEqual(summary[1].count, 1);
});

// ---- runDailyLearning() 統合テスト ----

function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") { const [key, value, flag] = args; if (flag === "NX" && store.has(key)) return null; store.set(key, value); return "OK"; }
    if (op === "INCR") { const cur = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(cur + 1)); return cur + 1; }
    if (op === "RPUSH") { const [key, val] = args; const l = store.get(key) || []; l.push(val); store.set(key, l); return l.length; }
    if (op === "LRANGE") { const [key, s, e] = args; const l = store.get(key) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; return l.slice(start, end + 1); }
    if (op === "LREM") { const [key, , val] = args; const l = store.get(key) || []; store.set(key, l.filter((v) => v !== val)); return 1; }
    if (op === "LTRIM") { const [key, s, e] = args; const l = store.get(key) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; store.set(key, l.slice(start, end + 1)); return "OK"; }
    throw new Error("mock does not implement: " + op);
  }
  async function upstashGetJSON(key) { const raw = await upstashCmd(["GET", key]); return raw === null || raw === undefined ? null : JSON.parse(raw); }
  async function upstashSetJSON(key, value) { await upstashCmd(["SET", key, JSON.stringify(value)]); return true; }
  return { upstashCmd, upstashGetJSON, upstashSetJSON, store };
}

async function resolveTeamId(nameEn) { return 1000 + nameEn.length; }
function makeFlatFixtureList(teamId, n, dateBase) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({ fixture: { id: 5000 + teamId * 100 + i, date: new Date(dateBase - i * 86400e3).toISOString(), status: { short: "FT" } }, teams: { home: { id: teamId, name: "T" + teamId }, away: { id: 9999, name: "Opponent" } }, goals: { home: 1, away: 1 } });
  }
  return list;
}

(async () => {
  await testAsync("runDailyLearning: 外れた自社予測はfailureReasonsを保存し、Knowledge Engineとgrowthlogの両方に反映される", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    const fixtureId = 515151;
    // 過去対戦を強く重視する重みで、ホーム有利と予測していたが、実際はアウェイ勝利、
    // という「過去対戦を重視しすぎた」ケースを人工的に再現する。
    const weightsSnapshot = { ...EXTENDED_DEFAULT_WEIGHTS, headToHeadSensitivity: 0.5 };
    await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, {
      fixtureId, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      homeFormScore: 0, awayFormScore: 0, predictedWinner: "home",
      homeLambda: 1.6, awayLambda: 1.1,
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 3, fatigueDiff: 0 },
      weightsSnapshot, factorImportance: [],
      kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
      resolved: false, actualWinner: null, correct: null, resolvedAt: null,
      originTeamEn, stateHypothesis: `${REGISTERED_TEAMS[0].nameJa}が優位という仮説(過去対戦重視・テスト用)`,
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id === String(fixtureId)) {
        return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: 0, away: 2 } }] }; // 実際はアウェイ勝利 = 予測は外れ
      }
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.now()) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };

    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });

    // ①record自体にfailureReasonsが保存されている
    const saved = await mock.upstashGetJSON(`learn:ownpred:${fixtureId}`);
    assert.ok(saved.resolved, "解決済みになっているはず");
    assert.strictEqual(saved.correct, false, "予測は外れているはず");
    assert.ok(Array.isArray(saved.failureReasons) && saved.failureReasons.length > 0, "failureReasonsが保存されているはず");
    assert.ok(saved.failureReasons.some((r) => r.id === "headToHeadDiff_overweighted"), `過去対戦を重視しすぎた、が検出されるはず, got: ${JSON.stringify(saved.failureReasons)}`);

    // ②Knowledge Engineに「predictionFailureReason」としてanalysis保存されている(→評議論モードの根拠プールにも乗る)
    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const active = await ks.getActiveKnowledge(originTeamEn);
    const failureItem = active.analyses.find((a) => a.category === "predictionFailureReason");
    assert.ok(failureItem, "predictionFailureReasonがKnowledge Engineのanalysisとして保存されているはず");
    assert.ok(failureItem.statement.includes("過去対戦"), `外れた理由の内容が含まれるはず, got: ${failureItem.statement}`);

    // ③Layer4振り返り(matchReflection)の本文にも、具体的な理由が(曖昧な表現ではなく)含まれている
    const reflectionItem = active.reflections.find((r) => r.category === "matchReflection" && r.statement.includes(originTeamEn) === false && r.statement.includes(String(fixtureId)) === false);
    const anyReflection = active.reflections.find((r) => r.category === "matchReflection");
    assert.ok(anyReflection, "matchReflectionが保存されているはず");
    assert.ok(anyReflection.statement.includes("過去対戦"), `振り返り本文に具体的な外れた理由が含まれるはず, got: ${anyReflection.statement}`);

    // ④growthLog(今回の実行結果)にfailureReasonsToday/topFailureReasonsRecentが反映されている
    assert.ok(Array.isArray(result.failureReasonsToday) && result.failureReasonsToday.length > 0, "growthLog.failureReasonsTodayに反映されるはず");
    assert.ok(Array.isArray(result.topFailureReasonsRecent) && result.topFailureReasonsRecent.length > 0, "growthLog.topFailureReasonsRecentに反映されるはず");
    assert.ok(result.topFailureReasonsRecent.some((r) => r.id === "headToHeadDiff_overweighted"), `直近の頻出理由に反映されるはず, got: ${JSON.stringify(result.topFailureReasonsRecent)}`);
  });

  await testAsync("runDailyLearning: 的中した自社予測はfailureReasonsが空配列のまま保存され、predictionFailureReasonは保存されない", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    const fixtureId = 616161;
    await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, {
      fixtureId, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      homeFormScore: 3, awayFormScore: -3, predictedWinner: "home",
      features: { formDiff: 6, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
      weightsSnapshot: EXTENDED_DEFAULT_WEIGHTS, factorImportance: [],
      kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
      resolved: false, actualWinner: null, correct: null, resolvedAt: null,
      originTeamEn, stateHypothesis: `${REGISTERED_TEAMS[0].nameJa}が優位という仮説(的中予定)`,
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id === String(fixtureId)) {
        return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: 2, away: 0 } }] }; // ホーム勝利 = 的中
      }
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.now()) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };
    await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });

    const saved = await mock.upstashGetJSON(`learn:ownpred:${fixtureId}`);
    assert.strictEqual(saved.correct, true);
    assert.deepStrictEqual(saved.failureReasons, [], "的中した予測はfailureReasonsが空配列のはず");

    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const active = await ks.getActiveKnowledge(originTeamEn);
    const failureItem = active.analyses.find((a) => a.category === "predictionFailureReason");
    assert.ok(!failureItem, "的中した予測についてはpredictionFailureReasonを保存しないはず(でっち上げ防止)");
  });

  console.log(failures === 0 ? "\nAll Failure Learning tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
