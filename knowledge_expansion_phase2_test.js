/**
 * 2026年8月・知識拡張フェーズ(第二段階)のユニット/統合テスト。
 * 対象:
 *   - server/learning/features.js の computeHomeAwaySplit / computeCoachCareer
 *   - server/learning/playerFeatures.js の computePlayerRealStats
 *   - server/knowledge/playerProfileEngine.js(選手版Layer2)
 *   - server/knowledge/clubProfileEngine.js の拡張(counterAttack等・監督→フォーメーション関係)
 *   - server/reasoning/evidencePool.js がLayer2(profile)/Layer4(reflection)も
 *     根拠プールに含めるようになったこと
 *   - server/rag/knowledgeSource.js のオンデマンド知識補完(Layer2自動生成・監督歴取得)
 */
const assert = require("assert");
const {
  computeHomeAwaySplit, computeCoachCareer,
} = require("../server/learning/features");
const { computePlayerRealStats } = require("../server/learning/playerFeatures");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");
const { createClubProfileEngine } = require("../server/knowledge/clubProfileEngine");
const { createPlayerProfileEngine } = require("../server/knowledge/playerProfileEngine");
const { createRelationshipIndex } = require("../server/knowledge/relationshipIndex");
const { buildEvidencePool } = require("../server/reasoning/evidencePool");
const { createKnowledgeSource } = require("../server/rag/knowledgeSource");

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
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") { const [k, s, e] = args; const l = store.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; return l.slice(start, end + 1); }
    if (op === "LTRIM") { const [k, s, e] = args; const l = store.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; store.set(k, l.slice(start, end + 1)); return "OK"; }
    throw new Error("unimplemented: " + op);
  }
  async function upstashGetJSON(key) { const raw = await upstashCmd(["GET", key]); return raw === null ? null : JSON.parse(raw); }
  async function upstashSetJSON(key, value) { await upstashCmd(["SET", key, JSON.stringify(value)]); return true; }
  return { upstashCmd, upstashGetJSON, upstashSetJSON };
}

(async () => {
  // ---- computeHomeAwaySplit ----
  await test("computeHomeAwaySplit: ホーム/アウェイを正しく分けて勝率・平均得失点を計算する", () => {
    const fixtures = [
      { fixture: {}, teams: { home: { id: 1 }, away: { id: 2 } }, goals: { home: 2, away: 0 } }, // home win
      { fixture: {}, teams: { home: { id: 1 }, away: { id: 3 } }, goals: { home: 1, away: 1 } }, // home draw
      { fixture: {}, teams: { home: { id: 4 }, away: { id: 1 } }, goals: { home: 0, away: 1 } }, // away win
      { fixture: {}, teams: { home: { id: 5 }, away: { id: 1 } }, goals: { home: 2, away: 0 } }, // away loss
    ];
    const split = computeHomeAwaySplit(fixtures, 1);
    assert.strictEqual(split.home.sampleSize, 2);
    assert.strictEqual(split.home.winRate, 0.5);
    assert.strictEqual(split.away.sampleSize, 2);
    assert.strictEqual(split.away.winRate, 0.5);
    assert.strictEqual(split.away.avgGoalsFor, 0.5);
  });

  await test("computeHomeAwaySplit: データが無い側は正直にnullを返す(捏造しない)", () => {
    const split = computeHomeAwaySplit([], 1);
    assert.strictEqual(split.home.sampleSize, 0);
    assert.strictEqual(split.home.winRate, null);
  });

  // ---- computeCoachCareer ----
  await test("computeCoachCareer: 在籍クラブと在任期間(career)を正しく抽出する", () => {
    const resp = [
      {
        name: "Carlo Ancelotti",
        career: [
          { team: { id: 541, name: "Real Madrid" }, start: "2021-06-01", end: null },
          { team: { id: 489, name: "AC Milan" }, start: "2001-11-01", end: "2009-06-01" },
        ],
      },
    ];
    const result = computeCoachCareer(resp, 541);
    assert.strictEqual(result.currentCoachName, "Carlo Ancelotti");
    assert.strictEqual(result.career.length, 2);
    const previous = result.career.find((c) => c.teamId !== 541);
    assert.strictEqual(previous.teamName, "AC Milan");
    assert.strictEqual(previous.end, "2009-06-01");
  });

  await test("computeCoachCareer: 該当する監督が見つからない場合は正直に空を返す", () => {
    const result = computeCoachCareer([], 541);
    assert.strictEqual(result.currentCoachName, null);
    assert.deepStrictEqual(result.career, []);
  });

  // ---- computePlayerRealStats ----
  await test("computePlayerRealStats: API-Footballの実データ(誤字を含むフィールド名)から正しく抽出する", () => {
    const statsBlock = {
      games: { appearences: 20, minutes: 1600, rating: "7.42", position: "Attacker" },
      goals: { total: 10, assists: 4 },
      passes: { total: 800, key: 30, accuracy: 82 },
      dribbles: { attempts: 50, success: 30 },
      tackles: { total: 12, interceptions: 8 },
      duels: { total: 100, won: 55 },
      cards: { yellow: 2, red: 0 },
    };
    const stats = computePlayerRealStats(statsBlock);
    assert.strictEqual(stats.appearances, 20);
    assert.strictEqual(stats.avgRating, 7.42);
    assert.strictEqual(stats.keyPasses, 30);
    assert.strictEqual(stats.passAccuracyPct, 82);
    assert.strictEqual(stats.dribbleSuccessRatePct, 60);
    assert.strictEqual(stats.defensiveActions, 20); // 12 tackles + 8 interceptions
    assert.strictEqual(stats.duelWinRatePct, 55);
  });

  await test("computePlayerRealStats: データが欠けている項目は正直にnullを返す(捏造しない)", () => {
    const stats = computePlayerRealStats({ games: { appearences: 5 } });
    assert.strictEqual(stats.keyPasses, null);
    assert.strictEqual(stats.dribbleSuccessRatePct, null);
    assert.strictEqual(stats.duelWinRatePct, null);
    // 2026-09-02監査での更新: タックル・インターセプトが丸ごと欠落した入力に0を
    // 期待するのは「0回という実測」の捏造(テスト名の趣旨とも矛盾)。監査で null
    //(=測れていない)へ直された現行仕様が正しい。
    assert.strictEqual(stats.defensiveActions, null);
  });

  await test("computePlayerRealStats: 空/nullなら正直にnullを返す", () => {
    assert.strictEqual(computePlayerRealStats(null), null);
  });

  // ---- playerProfileEngine (Layer2 選手版) ----
  await test("playerProfileEngine: 実データを根拠にLLMでプレースタイルを生成し、AI生成ラベルを付与する", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const calls = [];
    const fakeGenerateLLM = async ({ userPrompt }) => {
      calls.push(userPrompt);
      return { text: '{"playstyle": "テクニカルな崩し", "traits": ["俊敏"], "strengths": ["ドリブル"], "weaknesses": ["守備の運動量"]}' };
    };
    const engine = createPlayerProfileEngine({ generateLLM: fakeGenerateLLM, knowledgeStore });
    const result = await engine.ensurePlayerProfile("player:5001", "大迫勇也", "Y. Osako", ["出場20試合・10得点"], new Date().toISOString(), "Vissel Kobe");
    assert.strictEqual(result.generated, true);
    assert.strictEqual(result.profile.detail.isAiGenerated, undefined); // detailはparsed結果のみ(isAiGeneratedはitem側)
    assert.ok(result.profile.statement.includes("AIによる推定"));
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("出場20試合"));
  });

  await test("playerProfileEngine: 既に有効なプロフィールがあれば再生成しない(コスト節約)", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    let callCount = 0;
    const fakeGenerateLLM = async () => { callCount++; return { text: '{"playstyle": "x", "traits": [], "strengths": [], "weaknesses": []}' }; };
    const engine = createPlayerProfileEngine({ generateLLM: fakeGenerateLLM, knowledgeStore });
    // 第5次監査での修正に追随: 実データが1件も無い場合はプロフィールを
    // 生成しない仕様になったため、根拠となる実データを渡す。
    const grounding = ["今季20試合出場・10得点4アシスト(API-Footballの実データ)"];
    await engine.ensurePlayerProfile("player:5001", "大迫勇也", "Y. Osako", grounding, new Date().toISOString());
    const second = await engine.ensurePlayerProfile("player:5001", "大迫勇也", "Y. Osako", grounding, new Date().toISOString());
    assert.strictEqual(callCount, 1);
    assert.strictEqual(second.generated, false);
  });

  await test("playerProfileEngine: generateLLM未設定なら正直にスキップする(捏造しない)", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const engine = createPlayerProfileEngine({ generateLLM: undefined, knowledgeStore });
    const result = await engine.ensurePlayerProfile("player:9999", "テスト選手", "Test Player", [], new Date().toISOString());
    assert.strictEqual(result.generated, false);
    assert.strictEqual(result.reason, "LLM_NOT_CONFIGURED");
  });

  // ---- clubProfileEngine 拡張 ----
  await test("clubProfileEngine: 新しいフィールド(カウンター・保持傾向・ホームアウェイ)を保存し、監督→フォーメーションの関係も記録する", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const relationshipIndex = createRelationshipIndex({ upstashEnabled: true, ...mock });
    const fakeGenerateLLM = async () => ({
      text: JSON.stringify({
        tacticalStyle: "ハイプレス", formationTendency: "4-3-3", strengths: ["攻撃"], weaknesses: ["守備"],
        buildUp: "短いパス", pressing: "強め", setPieces: "普通",
        counterAttack: "素早い切り替え", possessionStyle: "保持を好む", homeAwayNote: "ホームで強い",
      }),
    });
    const engine = createClubProfileEngine({ generateLLM: fakeGenerateLLM, knowledgeStore, setRelation: relationshipIndex.setRelation });
    const result = await engine.ensureClubProfile("Real Madrid", "レアル・マドリード", ["直近好調"], new Date().toISOString(), "Carlo Ancelotti");
    assert.ok(result.profile.statement.includes("カウンター"));
    assert.ok(result.profile.statement.includes("ホーム/アウェイ傾向"));
    const rel = await relationshipIndex.getRelation("person", "Carlo Ancelotti", "preferredFormation");
    assert.strictEqual(rel.targetId, "4-3-3");
  });

  // ---- evidencePool: Layer2(profile)/Layer4(reflection)も根拠プールに含む ----
  await test("buildEvidencePool: Layer2固定知識・Layer4振り返りも根拠プールに含まれるようになった", () => {
    const knowledge = {
      knowledgeEngine: {
        facts: [], analyses: [], opinions: [],
        profiles: [{ category: "clubProfile", statement: "【AIによる推定】ハイプレスが持ち味" }],
        reflections: [{ category: "matchReflection", statement: "【振り返り】予想的中" }],
      },
    };
    const pool = buildEvidencePool(knowledge, "Real Madrid");
    assert.ok(pool.some((e) => e.statement.includes("ハイプレス") && e.type === "analysis"));
    assert.ok(pool.some((e) => e.statement.includes("振り返り") && e.type === "analysis"));
  });

  // ---- knowledgeSource: オンデマンドのLayer2自動生成・監督歴取得 ----
  await test("knowledgeSource.gatherClubKnowledge: 未登録クラブでも質問されればLayer2プロフィールがオンデマンドで生成される", async () => {
    const apiCalls = [];
    const fakeCallApiFootball = async (endpoint, params) => {
      apiCalls.push(endpoint);
      if (endpoint === "/fixtures") {
        return {
          response: [{
            fixture: { id: 1, date: new Date().toISOString() },
            league: { name: "Test League" },
            teams: { home: { id: 77, name: "Some FC" }, away: { id: 88, name: "Other FC" } },
            goals: { home: 1, away: 0 },
          }],
        };
      }
      if (endpoint === "/fixtures/lineups") {
        return { response: [{ team: { id: 77, name: "Some FC" }, formation: "4-2-3-1", coach: { name: "Test Coach" } }] };
      }
      if (endpoint === "/coachs") {
        return { response: [{ name: "Test Coach", career: [{ team: { id: 77, name: "Some FC" }, start: "2024-01-01", end: null }] }] };
      }
      return { response: [] };
    };
    const fakeResolveTeamId = async () => 77;
    const savedItems = [];
    let profileGenerated = 0;
    const fakeEnsureClubProfile = async (teamEn, teamJa, groundingFacts, nowIso, coachName) => {
      profileGenerated++;
      return { generated: true, saved: true, profile: { statement: `【AIによる推定】${teamJa}はハイプレス傾向(監督:${coachName})` } };
    };
    const source = createKnowledgeSource({
      callApiFootball: fakeCallApiFootball, resolveTeamId: fakeResolveTeamId, guessSeason: () => 2026,
      getRecentFacts: async () => [], getActiveKnowledge: async () => ({ facts: [], analyses: [], opinions: [], profiles: [], reflections: [], totalStored: 0, totalActive: 0 }),
      setRelation: async () => {},
      ensureClubProfile: fakeEnsureClubProfile,
      fetchCoachCareer: async (teamId) => ({ currentCoachName: "Test Coach", career: [{ teamName: "Some FC", teamId: 77, start: "2024-01-01", end: null }] }),
      saveKnowledgeItem: async (item) => { savedItems.push(item); return { saved: true, hash: "x" }; },
    });
    const knowledge = await source.gatherClubKnowledge("Some FC", ["recentForm", "coach", "formation"], "サムFC");
    assert.strictEqual(profileGenerated, 1);
    assert.ok(knowledge.clubProfile.statement.includes("ハイプレス"));
    assert.ok(knowledge.clubProfile.statement.includes("Test Coach"));
  });

  await test("knowledgeSource.gatherClubKnowledge: 監督歴(career)が取れれば実データとして保存され、Knowledge Graphにも記録される", async () => {
    const fakeCallApiFootball = async (endpoint) => {
      if (endpoint === "/fixtures") {
        return { response: [{ fixture: { id: 1, date: new Date().toISOString() }, league: {}, teams: { home: { id: 541, name: "Real Madrid" }, away: { id: 2, name: "X" } }, goals: { home: 1, away: 0 } }] };
      }
      if (endpoint === "/fixtures/lineups") {
        return { response: [{ team: { id: 541, name: "Real Madrid" }, formation: "4-3-3", coach: { name: "Carlo Ancelotti" } }] };
      }
      return { response: [] };
    };
    const relations = [];
    const saved = [];
    const source = createKnowledgeSource({
      callApiFootball: fakeCallApiFootball, resolveTeamId: async () => 541, guessSeason: () => 2026,
      getRecentFacts: async () => [], getActiveKnowledge: async () => ({ facts: [], analyses: [], opinions: [], profiles: [], reflections: [], totalStored: 0, totalActive: 0 }),
      setRelation: async (...args) => { relations.push(args); },
      fetchCoachCareer: async () => ({
        currentCoachName: "Carlo Ancelotti",
        career: [
          { teamName: "Real Madrid", teamId: 541, start: "2021-06-01", end: null },
          { teamName: "Everton", teamId: 999, start: "2019-12-23", end: "2021-05-28" },
        ],
      }),
      saveKnowledgeItem: async (item) => { saved.push(item); return { saved: true, hash: "y" }; },
    });
    const knowledge = await source.gatherClubKnowledge("Real Madrid", ["coach"], "レアル・マドリード");
    assert.ok(saved.some((s) => s.category === "managerHistory" && s.statement.includes("Everton")));
    assert.ok(relations.some((r) => r[0] === "person" && r[1] === "Carlo Ancelotti" && r[2] === "previousClub" && r[4] === "Everton"));
    assert.ok(knowledge.managerCareer.career.some((c) => c.teamName === "Everton"));
  });

  console.log(failures === 0 ? "\nAll Phase-2 knowledge expansion tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
