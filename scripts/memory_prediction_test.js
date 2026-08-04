/**
 * 2026年8月・「議論できるAI」強化フェーズ ご要望④(Memory Engineの活用強化)の
 * うち、「試合予測も保存してください。前回の予測・結果・外れた理由・学んだこと・
 * 次回改善点まで覚えてください」への対応(dailyJob.jsのpredictionMemory書き込み)
 * を確認するテスト。
 *
 * もう1つの要件(「以前はこう評価していましたが、今回評価を変えました」を
 * discuss-modeの回答本文で言語化する)は、buildDiscussSystemPrompt()の新しい
 * 「AI独自の意見」セクションの指示文として実装済み(server_discuss_test.js /
 * server_discuss_reasoning_memory_test.js でMemory Engineの変化検知自体は既に
 * 検証されている)。このファイルはpredictionMemory固有の部分に絞る。
 */
const assert = require("assert");
const { runDailyLearning, REGISTERED_TEAMS } = require("../server/learning/dailyJob");
const { EXTENDED_DEFAULT_WEIGHTS } = require("../server/learning/predictionModel");
const { createMemoryStore } = require("../server/memory/memoryStore");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

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

async function resolveOneFixture(mock, { fixtureId, originTeamEn, homeTeamEn, awayTeamEn, predictedWinner, actualHomeGoals, actualAwayGoals, features, weightsSnapshot, now }) {
  await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, {
    fixtureId, homeTeamEn, awayTeamEn, homeFormScore: 0, awayFormScore: 0, predictedWinner,
    features: features || { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
    weightsSnapshot: weightsSnapshot || EXTENDED_DEFAULT_WEIGHTS, factorImportance: [],
    kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
    resolved: false, actualWinner: null, correct: null, resolvedAt: null,
    originTeamEn, stateHypothesis: `${originTeamEn}のテスト用仮説`,
  });
  await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);
  const customApiFootball = async (endpoint, params) => {
    if (endpoint === "/fixtures" && params.id === String(fixtureId)) {
      return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: actualHomeGoals, away: actualAwayGoals } }] };
    }
    if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.now()) };
    if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
    return { response: [] };
  };
  return runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => now });
}

(async () => {
  await test("runDailyLearning: 解決した予測がMemory Engineにteam:<club>:predictionMemoryとして保存され、前回の予測・結果・学んだこと・次回改善点を含む", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    await resolveOneFixture(mock, {
      fixtureId: 717171, originTeamEn, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      predictedWinner: "home", actualHomeGoals: 2, actualAwayGoals: 0, // 的中
      now: new Date("2026-08-01T03:00:00Z"),
    });

    const memoryStore = createMemoryStore({ upstashEnabled: true, ...mock });
    const mem = await memoryStore.getLastConclusion(`team:${originTeamEn}:predictionMemory`);
    assert.ok(mem, "predictionMemoryが保存されているはず");
    assert.ok(mem.statement.includes("Rival FC"), `対戦カードが含まれるはず, got: ${mem.statement}`);
    assert.ok(mem.statement.includes("学んだこと"), `学んだことが含まれるはず, got: ${mem.statement}`);
    assert.ok(mem.statement.includes("次回改善点"), `次回改善点が含まれるはず, got: ${mem.statement}`);
    assert.strictEqual(mem.revision, 1, "1件目はrevision 1のはず");
  });

  await test("runDailyLearning: 2試合目が解決すると、1試合目の予測記憶が履歴(getConclusionHistory)へ退避される(「前回の予測」を覚えている)", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    const weightsSnapshot = { ...EXTENDED_DEFAULT_WEIGHTS, headToHeadSensitivity: 0.5 };

    // 1試合目: 的中
    await resolveOneFixture(mock, {
      fixtureId: 727272, originTeamEn, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      predictedWinner: "home", actualHomeGoals: 2, actualAwayGoals: 0,
      now: new Date("2026-08-01T03:00:00Z"),
    });
    // 2試合目: 過去対戦を重視しすぎて外れる
    await resolveOneFixture(mock, {
      fixtureId: 737373, originTeamEn, homeTeamEn: originTeamEn, awayTeamEn: "Other FC",
      predictedWinner: "home", actualHomeGoals: 0, actualAwayGoals: 2,
      features: { formDiff: 0, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 3, fatigueDiff: 0 },
      weightsSnapshot,
      now: new Date("2026-08-02T03:00:00Z"),
    });

    const memoryStore = createMemoryStore({ upstashEnabled: true, ...mock });
    const current = await memoryStore.getLastConclusion(`team:${originTeamEn}:predictionMemory`);
    assert.ok(current.statement.includes("Other FC"), `現在の記憶は2試合目のものになっているはず, got: ${current.statement}`);
    assert.ok(current.statement.includes("外れた理由"), `2試合目は外れたので外れた理由が含まれるはず, got: ${current.statement}`);
    assert.strictEqual(current.revision, 2);

    const history = await memoryStore.getConclusionHistory(`team:${originTeamEn}:predictionMemory`, 10);
    assert.strictEqual(history.length, 1, "1試合目の記憶が履歴に1件退避されているはず");
    assert.ok(history[0].statement.includes("Rival FC"), `履歴には前回(1試合目)の予測が残っているはず, got: ${history[0].statement}`);
  });

  console.log(failures === 0 ? "\nAll Memory Engine prediction-memory tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
