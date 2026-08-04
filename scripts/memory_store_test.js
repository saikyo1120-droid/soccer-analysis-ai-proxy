/**
 * server/memory/memoryStore.js のユニットテスト(インメモリRedisモック使用)。
 */
const assert = require("assert");
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
  await test("saveConclusion: Upstash未設定なら正直に保存しない", async () => {
    const s = createMemoryStore({ upstashEnabled: false });
    const r = await s.saveConclusion("team:Bayern Munich:form", { statement: "調子が良い", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.reason, "NO_UPSTASH");
  });

  await test("saveConclusion: 初回の結論はINITIALとして保存される(revision=1)", async () => {
    const s = createMemoryStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.saveConclusion("team:Bayern Munich:form", { statement: "直近フォームは上昇傾向", computedAt: "2026-07-30T00:00:00Z" });
    assert.strictEqual(r.saved, true);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.reason, "INITIAL");
    assert.strictEqual(r.revision, 1);
  });

  await test("saveConclusion: 同じ結論を再度保存してもUNCHANGEDとして扱われ、リビジョンは増えない", async () => {
    const mock = createMockRedis();
    const s = createMemoryStore({ upstashEnabled: true, ...mock });
    await s.saveConclusion("team:X:form", { statement: "調子が良い", computedAt: "2026-07-30T00:00:00Z" });
    const r2 = await s.saveConclusion("team:X:form", { statement: "調子が良い", computedAt: "2026-07-31T00:00:00Z" });
    assert.strictEqual(r2.changed, false);
    assert.strictEqual(r2.reason, "UNCHANGED");
    assert.strictEqual(r2.revision, 1);
    const current = await s.getLastConclusion("team:X:form");
    assert.strictEqual(current.lastConfirmedAt, "2026-07-31T00:00:00Z", "再確認日時が更新されているはず");
  });

  await test("saveConclusion: 結論が変わるとCHANGEDとして扱われ、変化理由が履歴に記録される", async () => {
    const mock = createMockRedis();
    const s = createMemoryStore({ upstashEnabled: true, ...mock });
    await s.saveConclusion("team:Y:defense", { statement: "守備が悪いのはCBが原因", computedAt: "2026-07-30T00:00:00Z" });
    const r2 = await s.saveConclusion(
      "team:Y:defense",
      { statement: "守備が悪いのは中盤の連携が原因", computedAt: "2026-07-31T00:00:00Z" },
      "新しい試合データでCBのタックル成功率は平均的だったが、中盤とのライン間が広がっていたことが判明したため"
    );
    assert.strictEqual(r2.changed, true);
    assert.strictEqual(r2.reason, "CHANGED");
    assert.strictEqual(r2.revision, 2);
    assert.strictEqual(r2.previousStatement, "守備が悪いのはCBが原因");

    const current = await s.getLastConclusion("team:Y:defense");
    assert.strictEqual(current.statement, "守備が悪いのは中盤の連携が原因");

    const history = await s.getConclusionHistory("team:Y:defense");
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].statement, "守備が悪いのはCBが原因");
    assert.strictEqual(history[0].supersededBy, "守備が悪いのは中盤の連携が原因");
    assert.ok(history[0].changeReason.includes("ライン間"));
  });

  await test("saveConclusion: 変化理由を渡さなかった場合は正直に「記録されていません」と保存される(でっち上げない)", async () => {
    const mock = createMockRedis();
    const s = createMemoryStore({ upstashEnabled: true, ...mock });
    await s.saveConclusion("team:Z:form", { statement: "A", computedAt: "2026-07-30T00:00:00Z" });
    await s.saveConclusion("team:Z:form", { statement: "B", computedAt: "2026-07-31T00:00:00Z" });
    const history = await s.getConclusionHistory("team:Z:form");
    assert.strictEqual(history[0].changeReason, "(変化理由は記録されていません)");
  });

  await test("getConclusionHistory: 新しい順(直近の変化が先頭)に並ぶ", async () => {
    const mock = createMockRedis();
    const s = createMemoryStore({ upstashEnabled: true, ...mock });
    await s.saveConclusion("team:W:form", { statement: "A", computedAt: "2026-07-29T00:00:00Z" });
    await s.saveConclusion("team:W:form", { statement: "B", computedAt: "2026-07-30T00:00:00Z" }, "理由1");
    await s.saveConclusion("team:W:form", { statement: "C", computedAt: "2026-07-31T00:00:00Z" }, "理由2");
    const history = await s.getConclusionHistory("team:W:form");
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].statement, "B", "直近の変化(A→B ではなく B→C の元になったB)が先頭に来るはず");
    assert.strictEqual(history[0].changeReason, "理由2");
    assert.strictEqual(history[1].statement, "A");
    assert.strictEqual(history[1].changeReason, "理由1");
  });

  await test("getLastConclusion: 存在しないsubjectはnullを返す(捏造しない)", async () => {
    const s = createMemoryStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.getLastConclusion("team:Unknown:form");
    assert.strictEqual(r, null);
  });

  console.log(failures === 0 ? "\nAll memory-store tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
