/**
 * 2026年8月・優先順位⑥(主要リーグのKnowledge Engine日次蓄積)で追加した、
 * knowledgeStore.jsのリーグ単位(leagueEn)対応のユニットテスト。
 * 既存のクラブ単位(teamEn)の挙動を一切変えずに一般化できているかを重点的に
 * 検証する(既存のscripts/knowledge_store_test.jsと合わせて実行することで、
 * 後方互換性が壊れていないことを確認する)。
 */
const assert = require("assert");
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
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
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
  await test("saveKnowledgeItem: leagueEnのみでもteamEn同様に保存できる", async () => {
    const s = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.saveKnowledgeItem({ leagueEn: "Premier League (イングランド)", category: "leagueStandings", type: "fact", statement: "順位表A", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, true);
    assert.ok(r.hash);
  });

  await test("saveKnowledgeItem: teamEnもleagueEnも無ければINVALID_ITEM", async () => {
    const s = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const r = await s.saveKnowledgeItem({ category: "x", type: "fact", statement: "s", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, false);
    assert.strictEqual(r.reason, "INVALID_ITEM");
  });

  await test("getActiveKnowledgeForLeague: 保存したリーグ単位の知識を取得できる", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ leagueEn: "La Liga (スペイン)", category: "leagueTopScorers", type: "fact", statement: "得点ランキングA", computedAt: new Date().toISOString() });
    const active = await s.getActiveKnowledgeForLeague("La Liga (スペイン)");
    assert.strictEqual(active.totalActive, 1);
    assert.strictEqual(active.facts[0].statement, "得点ランキングA");
  });

  await test("getActiveKnowledgeForLeague: 存在しないリーグは空を返す(でっち上げない)", async () => {
    const s = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const active = await s.getActiveKnowledgeForLeague("存在しないリーグ");
    assert.strictEqual(active.totalActive, 0);
  });

  await test("同じ内容のリーグ知識は重複登録されない(前日と変化が無ければ再カウントしない)", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const item = { leagueEn: "Bundesliga (ドイツ)", category: "leagueStandings", type: "fact", statement: "1位Bayern(50pt)", computedAt: "2026-08-01T00:00:00Z" };
    const r1 = await s.saveKnowledgeItem(item);
    const r2 = await s.saveKnowledgeItem({ ...item, computedAt: "2026-08-02T00:00:00Z" });
    assert.strictEqual(r1.saved, true);
    assert.strictEqual(r2.saved, false);
    assert.strictEqual(r2.reason, "DUPLICATE");
    const active = await s.getActiveKnowledgeForLeague("Bundesliga (ドイツ)");
    assert.strictEqual(active.totalStored, 1, "内容が同じなら1件のままのはず");
  });

  await test("内容が変わったリーグ知識(順位変動)は新しい事実として追加される", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ leagueEn: "Serie A (イタリア)", category: "leagueStandings", type: "fact", statement: "1位Napoli(50pt)", computedAt: "2026-08-01T00:00:00Z" });
    const r2 = await s.saveKnowledgeItem({ leagueEn: "Serie A (イタリア)", category: "leagueStandings", type: "fact", statement: "1位Inter(53pt)", computedAt: "2026-08-02T00:00:00Z" });
    assert.strictEqual(r2.saved, true, "順位表の内容が変わったので新しい事実として保存されるはず");
    const active = await s.getActiveKnowledgeForLeague("Serie A (イタリア)");
    assert.strictEqual(active.totalActive, 2);
  });

  await test("同名だが国が異なるリーグ(例: Serie A=イタリア/ブラジル)は別々に扱われる(entityKeyに国名を含めているため)", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ leagueEn: "Serie A (イタリア)", category: "leagueStandings", type: "fact", statement: "1位Napoli", computedAt: new Date().toISOString() });
    await s.saveKnowledgeItem({ leagueEn: "Serie A (ブラジル)", category: "leagueStandings", type: "fact", statement: "1位Palmeiras", computedAt: new Date().toISOString() });
    const italy = await s.getActiveKnowledgeForLeague("Serie A (イタリア)");
    const brazil = await s.getActiveKnowledgeForLeague("Serie A (ブラジル)");
    assert.strictEqual(italy.totalActive, 1);
    assert.strictEqual(brazil.totalActive, 1);
    assert.strictEqual(italy.facts[0].statement, "1位Napoli");
    assert.strictEqual(brazil.facts[0].statement, "1位Palmeiras");
  });

  await test("クラブ単位(teamEn)の既存の挙動は変わらない(後方互換性)", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const r = await s.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "form", type: "fact", statement: "直近フォームが上昇", computedAt: new Date().toISOString() });
    assert.strictEqual(r.saved, true);
    const active = await s.getActiveKnowledge("Bayern Munich");
    assert.strictEqual(active.totalActive, 1);
    // リーグ用の名前空間とクラブ用の名前空間が混ざっていないことも確認する
    const asLeague = await s.getActiveKnowledgeForLeague("Bayern Munich");
    assert.strictEqual(asLeague.totalActive, 0, "クラブ名をリーグとして検索しても見つからないはず(名前空間が分離されている)");
  });

  await test("getKnowledgeDiffForLeague: 今日新しく追加されたリーグ知識を正しく分類する", async () => {
    const mock = createMockRedis();
    const s = createKnowledgeStore({ upstashEnabled: true, ...mock });
    await s.saveKnowledgeItem({ leagueEn: "Ligue 1 (フランス)", category: "leagueTopAssists", type: "fact", statement: "アシストランキングA", computedAt: "2026-08-04T09:00:00Z" });
    const diff = await s.getKnowledgeDiffForLeague("Ligue 1 (フランス)", "2026-08-04", Date.now());
    assert.strictEqual(diff.newItems.length, 1);
  });

  console.log(failures === 0 ? "\nAll knowledge-store league-scope tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
