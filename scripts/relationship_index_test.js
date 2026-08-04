/**
 * server/knowledge/relationshipIndex.js のユニットテスト(インメモリRedisモック使用)。
 */
const assert = require("assert");
const { createRelationshipIndex } = require("../server/knowledge/relationshipIndex");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  async function upstashGetJSON(key) { return store.has(key) ? store.get(key) : null; }
  async function upstashSetJSON(key, value) { store.set(key, value); return true; }
  return { upstashGetJSON, upstashSetJSON };
}

(async () => {
  await test("setRelation: Upstash未設定なら正直に保存しない", async () => {
    const idx = createRelationshipIndex({ upstashEnabled: false });
    const r = await idx.setRelation("team", "Bayern Munich", "manager", "person", "Vincent Kompany");
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.reason, "NO_UPSTASH");
  });

  await test("setRelation → getRelation: 関係を保存して取得できる", async () => {
    const idx = createRelationshipIndex({ upstashEnabled: true, ...createMockRedis() });
    await idx.setRelation("team", "Bayern Munich", "manager", "person", "Vincent Kompany");
    const r = await idx.getRelation("team", "Bayern Munich", "manager");
    assert.ok(r);
    assert.strictEqual(r.targetId, "Vincent Kompany");
    assert.strictEqual(r.targetType, "person");
  });

  await test("getRelation: 存在しない関係はnullを返す(捏造しない)", async () => {
    const idx = createRelationshipIndex({ upstashEnabled: true, ...createMockRedis() });
    const r = await idx.getRelation("team", "Unknown FC", "manager");
    assert.strictEqual(r, null);
  });

  await test("setRelation: 同じ関係を再設定すると上書きされる(最新の状態を保つ)", async () => {
    const idx = createRelationshipIndex({ upstashEnabled: true, ...createMockRedis() });
    await idx.setRelation("team", "X", "formation", "formation", "4-3-3");
    await idx.setRelation("team", "X", "formation", "formation", "4-2-3-1");
    const r = await idx.getRelation("team", "X", "formation");
    assert.strictEqual(r.targetId, "4-2-3-1");
  });

  console.log(failures === 0 ? "\nAll relationship-index tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
