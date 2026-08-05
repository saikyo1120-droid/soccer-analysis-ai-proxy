/**
 * scripts/final_policy_round1_test.js
 * ------------------------------------------------
 * 最終方針・第1ラウンド(計測基盤+使用回数管理+データ拡大)のテスト。
 */

const assert = require("assert");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function createMemoryUpstash() {
  const store = new Map();
  const lists = new Map();
  const upstashCmd = async (cmd) => {
    const [op, key, ...rest] = cmd;
    if (op === "LRANGE") return (lists.get(key) || []).slice();
    if (op === "RPUSH") { const l = lists.get(key) || []; l.push(rest[0]); lists.set(key, l); return l.length; }
    if (op === "LTRIM") return "OK";
    if (op === "DEL") { return store.delete(key) ? 1 : 0; }
    if (op === "INCR") { const v = (Number(store.get(key)) || 0) + 1; store.set(key, String(v)); return v; }
    if (op === "GET") return store.has(key) ? store.get(key) : null;
    if (op === "SET") { store.set(key, rest[0]); return "OK"; }
    return null;
  };
  const upstashGetJSON = async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null);
  const upstashSetJSON = async (key, obj) => { store.set(key, JSON.stringify(obj)); return true; };
  return { store, lists, upstashCmd, upstashGetJSON, upstashSetJSON };
}

async function main() {
  console.log("=== 最終方針①: 性能の常時計測 ===");

  await ok("perfSnapshotが実測値(稼働時間・キャッシュ率・メモリ・CPU・エンドポイント別応答)を返す", () => {
    const { perfSnapshot } = require("../server/server.js");
    const p = perfSnapshot();
    assert.ok(Number.isFinite(p.uptimeSec));
    assert.ok("hits" in p.cache && "misses" in p.cache && "hitRatePct" in p.cache);
    assert.ok(Number.isFinite(p.memory.rssMb) && p.memory.rssMb > 0);
    assert.ok(Number.isFinite(p.cpu.userMs));
    assert.ok(Array.isArray(p.endpoints));
  });

  console.log("=== 最終方針②: Knowledge使用回数の管理(質問時の追加負荷ゼロ) ===");

  await ok("知識が読まれた回数がメモリで数えられ、日次フラッシュで保存・上位表示できる", async () => {
    const up = createMemoryUpstash();
    const ks = createKnowledgeStore({ upstashEnabled: true, ...up });
    const saved = await ks.saveKnowledgeItem({
      teamEn: "Arsenal", teamJa: "アーセナル", category: "recentFormTrend", type: "fact",
      statement: "使用回数テスト用の事実です。", computedAt: new Date().toISOString(),
    });
    assert.ok(saved.saved);
    // 読み出し(RAG相当)を3回 — この間、Redisへの書き込みは発生しない設計
    const setCallsBefore = up.store.has("knowledge:usage");
    await ks.getActiveKnowledge("Arsenal");
    await ks.getActiveKnowledge("Arsenal");
    await ks.getActiveKnowledge("Arsenal");
    assert.strictEqual(up.store.has("knowledge:usage"), setCallsBefore, "質問時にはknowledge:usageへ書かない(応答速度を守る)");
    // 日次フラッシュ(学習ジョブ相当)
    const r = await ks.flushUsageCounters();
    assert.ok(r.flushed >= 3, `3回分が保存されるはず(実際: ${r.flushed})`);
    const stored = await up.upstashGetJSON("knowledge:usage");
    assert.ok(stored && Object.values(stored).some((v) => v >= 3));
    const top = await ks.getTopUsedKnowledge(5);
    assert.ok(top.length >= 1 && top[0].usageCount >= 3);
    assert.ok(top[0].statement.includes("使用回数テスト用"));
    // 二重フラッシュしても水増しされない(バッファはクリア済み)
    const r2 = await ks.flushUsageCounters();
    assert.strictEqual(r2.flushed, 0, "フラッシュ後のバッファは空");
  });

  console.log("=== 最終方針③: データ拡大(TOP100全クラブ毎日) ===");

  await ok("コア更新の対象が全100クラブ×毎日になっている(universe_knowledge_test A5でも検証)", () => {
    const { clubsForCoreUpdate } = require("../server/learning/clubUniverse");
    assert.strictEqual(clubsForCoreUpdate("2026-08-10").length, 100);
    assert.strictEqual(clubsForCoreUpdate("2026-08-11").length, 100);
  });

  console.log(`\n結果: ${passed}件成功 / ${failed}件失敗`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
