/**
 * server/learning/dailyJob.js のStage E統合(Knowledge Engine経由への保存の
 * リファクタリング、およびHypothesis Engineの検証ループ)を確認するテスト。
 * learning_daily_job_test.js が既存のStage D機能(自社予測モデル・重み再調整)を
 * カバーしているのに対し、このファイルはStage Eで追加された部分に絞る。
 */
const assert = require("assert");
const { runDailyLearning, REGISTERED_TEAMS } = require("../server/learning/dailyJob");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");

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

// 2026-09-02監査での更新: 文字数ベースのIDは衝突する(Bayern MunichとReal Sociedad等)。
// 衝突すると実行内メモ化(8/6導入)がモック応答を取り違える。連番で一意にする。
const __idMap = new Map(); let __idSeq = 1000;
async function resolveTeamId(nameEn) { if (!__idMap.has(nameEn)) __idMap.set(nameEn, __idSeq++); return __idMap.get(nameEn); }
const SPECIAL_TEAM_ID = 1000; // 最初に解決されるクラブ(REGISTERED_TEAMS[0])のID
function makeFixtureList(teamId, n, dateBase, gf, ga) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({ fixture: { id: 5000 + teamId * 100 + i, date: new Date(dateBase - i * 86400e3).toISOString(), status: { short: "FT" } }, teams: { home: { id: teamId, name: "T" + teamId }, away: { id: 9999, name: "Opponent" } }, goals: { home: gf, away: ga } });
  }
  return list;
}
async function callApiFootball(endpoint, params) {
  if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFixtureList(params.team, params.last, Date.now(), 1, 1) }; // フォーム変化なし = factsToday常に空
  if (endpoint === "/fixtures" && params.team && params.next) return { response: [] }; // 新規予測は生成させない(このテストの主眼ではないため)
  return { response: [] };
}

(async () => {
  await test("知識の保存先がKnowledge Engine経由に統一されている: 重複する事実は2回目以降カウントされない", async () => {
    const mock = createMockRedis();
    // フォームが実際に変化するようカスタムAPIを用意(learning_daily_job_test.jsと同じ手法)
    let call = 0;
    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.team && params.last) {
        call++;
        // 2026-09-02監査での更新: 「何回目の呼び出しか」はメモ化・巡回順に依存して
        // 壊れる。対象クラブのIDで判定する(1回目も2回目も同じ内容=重複検証の意図どおり)。
        if (params.team === SPECIAL_TEAM_ID) {
          const list = [];
          const now = Date.now();
          for (let i = 0; i < 5; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 4, away: 0 } });
          for (let i = 5; i < 10; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 0, away: 3 } });
          return { response: list };
        }
        return { response: makeFixtureList(params.team, params.last, Date.now(), 1, 1) };
      }
      return callApiFootball(endpoint, params);
    };
    const r1 = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.ok(r1.knowledgeItemsSavedToday >= 1, "1回目は新規の知識として保存されるはず, got " + r1.knowledgeItemsSavedToday);
    assert.strictEqual(r1.knowledgeItemsDuplicateToday, 0, "1回目は重複が無いはず");

    const r2 = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-02T03:00:00Z") });
    assert.ok(r2.knowledgeItemsDuplicateToday >= 1, "2回目は全く同じ内容なので重複として扱われるはず, got " + r2.knowledgeItemsDuplicateToday);

    // Knowledge Engine側から見ても、重複した内容が1件としてしか蓄積されていないことを確認
    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const active = await ks.getActiveKnowledge(REGISTERED_TEAMS[0].nameEn, new Date("2026-08-02T04:00:00Z").getTime());
    const matching = active.facts.filter((f) => f.category === "recentFormTrend");
    assert.strictEqual(matching.length, 1, "同じ内容の事実がKnowledge Engine上で重複して蓄積されていないはず");
  });

  await test("getRecentFactsForTeam(RAG向け)はKnowledge Engine経由で取得でき、内容が一致する", async () => {
    const mock = createMockRedis();
    const { getRecentFactsForTeam } = require("../server/learning/dailyJob");
    let call = 0;
    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.team && params.last) {
        call++;
        if (call === 1) {
          const list = [];
          const now = Date.now();
          for (let i = 0; i < 5; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 5, away: 0 } });
          for (let i = 5; i < 10; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 0, away: 4 } });
          return { response: list };
        }
        return { response: makeFixtureList(params.team, params.last, Date.now(), 1, 1) };
      }
      return callApiFootball(endpoint, params);
    };
    // 2026-09-02監査での更新: getRecentFactsForTeamは実時刻で失効判定するため、
    // このテストだけは相対時刻で実行する(固定日付だと14日後に必ず壊れる)。
    await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date() });
    const facts = await getRecentFactsForTeam({ upstashEnabled: true, ...mock }, REGISTERED_TEAMS[0].nameEn);
    assert.ok(facts.length >= 1, "RAGが使うgetRecentFactsForTeamがKnowledge Engine経由で事実を返すはず");
    assert.ok(facts[0].statement.includes(REGISTERED_TEAMS[0].nameJa), "取得した事実に対象クラブ名が含まれるはず");
    assert.ok(facts[0].date, "dateフィールドが付与されているはず(firstSeenAtから変換)");
  });

  await test("Hypothesis Engine: 状態仮説が実際の結果と一致した場合、Knowledge Engineにanalysisとして昇格する", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    const fixtureId = 424242;
    // 「事前にホームが優位という仮説を立てて予測していた」状態を人工的に用意する
    await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, {
      fixtureId, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      homeFormScore: 3, awayFormScore: -3, predictedWinner: "home",
      kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
      resolved: false, actualWinner: null, correct: null, resolvedAt: null,
      originTeamEn, stateHypothesis: `${REGISTERED_TEAMS[0].nameJa}が優位という仮説(テスト用)`,
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id === String(fixtureId)) {
        return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: 2, away: 0 } }] }; // ホームが実際に勝利 = 仮説通り
      }
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFixtureList(params.team, params.last, Date.now(), 1, 1) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };
    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.hypothesesConfirmed, 1, "仮説が的中したので1件確認されたはず");
    assert.strictEqual(result.hypothesesDiscarded, 0);

    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const active = await ks.getActiveKnowledge(originTeamEn, new Date("2026-08-01T04:00:00Z").getTime());
    const promoted = active.analyses.find((a) => a.category === "predictionHypothesis");
    assert.ok(promoted, "検証済みの仮説がanalysisとしてKnowledge Engineに保存されているはず");
    assert.ok(promoted.statement.includes("優位という仮説(テスト用)"), "元の仮説の内容が引き継がれているはず");
  });

  await test("Hypothesis Engine: 状態仮説が外れた場合は破棄され、知識としては保存されない(でっち上げない)", async () => {
    const mock = createMockRedis();
    const originTeamEn = REGISTERED_TEAMS[0].nameEn;
    const fixtureId = 434343;
    await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, {
      fixtureId, homeTeamEn: originTeamEn, awayTeamEn: "Rival FC",
      homeFormScore: 3, awayFormScore: -3, predictedWinner: "home",
      kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
      resolved: false, actualWinner: null, correct: null, resolvedAt: null,
      originTeamEn, stateHypothesis: `${REGISTERED_TEAMS[0].nameJa}が優位という仮説(外れる予定)`,
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id === String(fixtureId)) {
        return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: 0, away: 3 } }] }; // 実際はアウェイ勝利 = 仮説は外れ
      }
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFixtureList(params.team, params.last, Date.now(), 1, 1) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      return { response: [] };
    };
    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.hypothesesConfirmed, 0);
    assert.strictEqual(result.hypothesesDiscarded, 1, "仮説が外れたので1件破棄されたはず");

    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const active = await ks.getActiveKnowledge(originTeamEn, new Date("2026-08-01T04:00:00Z").getTime());
    const promoted = active.analyses.find((a) => a.statement.includes("外れる予定"));
    assert.ok(!promoted, "外れた仮説は知識として保存されていないはず");
  });

  console.log(failures === 0 ? "\nAll dailyJob Stage E tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
