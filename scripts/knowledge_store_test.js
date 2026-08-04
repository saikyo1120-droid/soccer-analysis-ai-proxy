/**
 * server/knowledge/knowledgeStore.js のユニットテスト(インメモリRedisモック使用)。
 */
const assert = require("assert");
const { createKnowledgeStore, computeItemHash, isExpired } = require("../server/knowledge/knowledgeStore");

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
  await test("saveKnowledgeItem: Upstash未設定なら正直に保存しない", async () => {
    const s = createKnowledgeStore({ upstashEnabled: false });
    const r = await s.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "form", type: "fact", statement: "x", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.reason, "NO_UPSTASH");
  });

  await test("saveKnowledgeItem: 不正なtypeは保存しない(fact/analysis/opinion以外禁止)", async () => {
    const s = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.saveKnowledgeItem({ teamEn: "X", category: "c", type: "rumor", statement: "s", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.reason, "INVALID_TYPE");
  });

  await test("saveKnowledgeItem: 新規の知識は保存される", async () => {
    const s = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "form", type: "fact", statement: "直近フォームが上昇", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, true);
    assert.ok(r.hash);
  });

  await test("saveKnowledgeItem: 全く同じ内容は重複登録しない(事実/分析/意見を混同しない設計の検証込み)", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const item = { teamEn: "Bayern Munich", category: "form", type: "fact", statement: "直近フォームが上昇", computedAt: "2026-08-01T00:00:00Z" };
    const r1 = await s.saveKnowledgeItem(item);
    const r2 = await s.saveKnowledgeItem({ ...item, computedAt: "2026-08-02T00:00:00Z" }); // 翌日も同じ内容が観測された
    assert.strictEqual(r1.saved, true);
    assert.strictEqual(r2.saved, false);
    assert.strictEqual(r2.reason, "DUPLICATE");
    assert.strictEqual(r1.hash, r2.hash, "同じ内容なら同じハッシュになるはず");
    const active = await s.getActiveKnowledge("Bayern Munich");
    assert.strictEqual(active.totalStored, 1, "重複は1件として扱われるはず(リストが際限なく膨らまない)");
  });

  await test("saveKnowledgeItem: 同じクラブでも内容が違えば別々に保存される", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "form", type: "fact", statement: "直近フォームが上昇", computedAt: new Date().toISOString() });
    await s.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "injuries", type: "fact", statement: "主力CBが離脱", computedAt: new Date().toISOString() });
    const active = await s.getActiveKnowledge("Bayern Munich");
    assert.strictEqual(active.totalActive, 2);
  });

  await test("getActiveKnowledge: type別(fact/analysis/opinion)に正しく分類される", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ teamEn: "T", category: "c1", type: "fact", statement: "事実A", computedAt: new Date().toISOString() });
    await s.saveKnowledgeItem({ teamEn: "T", category: "c2", type: "analysis", statement: "分析B", computedAt: new Date().toISOString() });
    await s.saveKnowledgeItem({ teamEn: "T", category: "c3", type: "opinion", statement: "意見C", computedAt: new Date().toISOString() });
    const active = await s.getActiveKnowledge("T");
    assert.strictEqual(active.facts.length, 1);
    assert.strictEqual(active.analyses.length, 1);
    assert.strictEqual(active.opinions.length, 1);
    assert.strictEqual(active.facts[0].statement, "事実A");
  });

  await test("getActiveKnowledge: 有効期限切れの知識はアクティブ一覧から除外される(失効管理)", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40日前(factの既定14日を超過)
    await s.saveKnowledgeItem({ teamEn: "T", category: "c", type: "fact", statement: "古い事実", computedAt: oldDate });
    await s.saveKnowledgeItem({ teamEn: "T", category: "c2", type: "fact", statement: "新しい事実", computedAt: new Date().toISOString() });
    const active = await s.getActiveKnowledge("T");
    assert.strictEqual(active.totalStored, 2, "保存自体は削除されず残っている");
    assert.strictEqual(active.totalActive, 1, "失効した方はアクティブ一覧から除外されるはず");
    assert.strictEqual(active.facts[0].statement, "新しい事実");
  });

  await test("isExpired: typeごとの既定有効日数(fact=14日, opinion=7日, profile=60日, reflection=90日)が正しく適用される", () => {
    const now = Date.now();
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(isExpired({ type: "fact", computedAt: fiveDaysAgo }, now), false, "factは14日以内なので有効なはず");
    assert.strictEqual(isExpired({ type: "opinion", computedAt: fiveDaysAgo }, now), false, "opinionは7日以内なので有効なはず");
    assert.strictEqual(isExpired({ type: "opinion", computedAt: tenDaysAgo }, now), true, "opinionは7日で失効するはず(Layer3は毎日更新される想定)");
    assert.strictEqual(isExpired({ type: "profile", computedAt: fortyDaysAgo }, now), false, "profileは60日以内なので有効なはず(Layer2は固定知識のため長め)");
    assert.strictEqual(isExpired({ type: "reflection", computedAt: fortyDaysAgo }, now), false, "reflectionは90日以内なので有効なはず(Layer4は学習履歴のため長め)");
  });

  console.log(failures === 0 ? "\nAll knowledge-store tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
