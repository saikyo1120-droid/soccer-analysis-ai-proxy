/**
 * 2026年8月・「議論できるAI」強化フェーズ ご要望②(Knowledge Engineの毎日成長)の
 * うち、「監督交代による変化」「補強の影響」への対応(dailyJob.jsの①-dブロック)
 * を確認するテスト。
 *
 * ローテーション(COACH_TRANSFER_CHECK_CAP件/日)がその日どのクラブを選ぶかは
 * 日付依存のため、特定のクラブを名指しでは検証せず、「ローテーションで選ばれた
 * いずれかのクラブについて、監督交代が検知され、補強が事実として保存される」
 * ことを検証する(全登録クラブに同一の下準備をして、どれが選ばれても検出できる
 * ようにする)。
 */
const assert = require("assert");
const { runDailyLearning, REGISTERED_TEAMS } = require("../server/learning/dailyJob");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");
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

(async () => {
  await test("runDailyLearning: その日ローテーションで選ばれたクラブについて、監督交代がMemory Engineとの差分から検知され、Knowledge Engineにfactとして保存される", async () => {
    const mock = createMockRedis();
    const memoryStore = createMemoryStore({ upstashEnabled: true, ...mock });
    // 全登録クラブに「前回の監督名」をあらかじめ記録しておく(どのクラブが
    // ローテーションで選ばれても、必ず「変化」として検知されるようにする)。
    for (const team of REGISTERED_TEAMS) {
      await memoryStore.saveConclusion(`team:${team.nameEn}:coachName`, { statement: "Old Coach", computedAt: "2026-07-01T00:00:00Z" }, null);
    }

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/coachs" && params.team) {
        return { response: [{ name: "New Coach", career: [{ team: { id: params.team, name: "T" + params.team }, start: "2026-07-15", end: null }] }] };
      }
      if (endpoint === "/transfers" && params.team) {
        return { response: [{ player: { name: "New Signing" }, transfers: [{ date: new Date().toISOString().slice(0, 10), type: "Free", teams: { in: { id: params.team, name: "T" + params.team }, out: { id: 8888, name: "Old Club" } } }] }] };
      }
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.now()) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };

    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });

    assert.ok(result.coachChangesDetectedToday >= 1, `監督交代が最低1クラブで検知されるはず, got ${result.coachChangesDetectedToday}`);
    assert.ok(result.transferFactsAddedToday >= 1, `補強の事実が最低1件保存されるはず, got ${result.transferFactsAddedToday}`);
    assert.ok(result.otherFactsToday.length >= 2, `監督交代・補強の両方が表示用配列に含まれるはず, got ${JSON.stringify(result.otherFactsToday)}`);

    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    let foundCoachChange = false;
    let foundTransfer = false;
    for (const team of REGISTERED_TEAMS) {
      const active = await ks.getActiveKnowledge(team.nameEn);
      if (active.facts.some((f) => f.category === "coachChange" && f.statement.includes("Old Coach") && f.statement.includes("New Coach"))) foundCoachChange = true;
      if (active.facts.some((f) => f.category === "transferImpact" && f.statement.includes("New Signing"))) foundTransfer = true;
    }
    assert.ok(foundCoachChange, "Knowledge Engineに監督交代のfact(前任→現任の名前入り)が保存されているはず");
    assert.ok(foundTransfer, "Knowledge Engineに補強のfact(選手名入り)が保存されているはず");
  });

  await test("runDailyLearning: 初回記録(前回の監督名が無い)は「交代」として扱わない(でっち上げない)", async () => {
    const mock = createMockRedis();
    // Memory Engineに何も事前登録しない(=全クラブが初回記録になる)。
    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/coachs" && params.team) {
        return { response: [{ name: "Some Coach", career: [{ team: { id: params.team, name: "T" + params.team }, start: "2020-01-01", end: null }] }] };
      }
      if (endpoint === "/transfers") return { response: [] };
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.now()) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };
    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.coachChangesDetectedToday, 0, "初回記録は監督交代としてカウントされないはず");
  });

  console.log(failures === 0 ? "\nAll coach-change/transfer daily-knowledge tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
