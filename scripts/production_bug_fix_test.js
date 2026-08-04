/**
 * 2026年8月・本番で実際に報告されたバグの修正を検証する専用テスト。
 *
 * 症状: AIの成長レポートに「本日のデータ取得で1件のエラーが発生しました」
 * (errors: ["team_not_found:Al-Nassr"])に加え、「今日追加した知識0件」
 * 「検証した試合0件」が表示された。
 *
 * 根本原因は2つあった:
 *   ①(主因) Renderのスリープ起床待ち等により、同じ日に学習エンジンが実質
 *     2回実行されることがあり、growthLogが「その日の合計」ではなく「直近の
 *     実行結果」でまるごと上書きされていたため、1回目で実際に保存した知識が
 *     2回目の「重複でした」という結果に隠れてしまっていた。
 *   ②(副因) resolveTeamId()が「本当に見つからなかった」場合と「一時的な
 *     ネットワーク/API障害で例外が発生した」場合を区別せず、どちらも
 *     24時間キャッシュしていたため、一時的な障害が丸1日尾を引いていた。
 *
 * このテストは、①をdailyJob.js(mergeGrowthLogs)のレベルで、②をserver.js
 * (resolveTeamId)のレベルで、それぞれ再現・修正確認する。
 */
const assert = require("assert");
const path = require("path");
const http = require("http");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

// ============================================================
// パート1: mergeGrowthLogs / runDailyLearningの二重実行マスキング修正
// ============================================================
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

async function resolveTeamIdStub(nameEn) { return 1000 + nameEn.length; }
function makeFlatFixtureList(teamId, n, dateBase) {
  const list = [];
  for (let i = 0; i < n; i++) {
    // 2試合ごとに得失点差を variesさせ、フォーム変化(fact)が確実に生成される
    // ようにする(実際の本番データと同じく、facts配列が空でないケースを再現する)。
    const gf = i % 2 === 0 ? 3 : 0;
    list.push({ fixture: { id: 6000 + teamId * 100 + i, date: new Date(dateBase - i * 86400e3).toISOString(), status: { short: "FT" } }, teams: { home: { id: teamId, name: "T" + teamId }, away: { id: 9999, name: "Opponent" } }, goals: { home: gf, away: 0 } });
  }
  return list;
}

(async () => {
  await test("mergeGrowthLogs: 同じ日付なら件数を合算し、事実は内容で重複排除する", () => {
    const { mergeGrowthLogs } = require("../server/learning/dailyJob");
    const prev = {
      date: "2026-08-03", ranAt: "2026-08-03T01:00:00Z",
      facts: [{ statement: "A" }, { statement: "B" }],
      otherFactsToday: [], coachChangesDetectedToday: 0, transferFactsAddedToday: 0,
      knowledgeItemsSavedToday: 16, knowledgeItemsDuplicateToday: 0,
      matchesResolvedToday: 2, newPredictionsLogged: 3,
      hypothesesConfirmed: 1, hypothesesDiscarded: 0, reflectionsSaved: 2,
      profilesGenerated: 1, aiViewsChanged: 10, aiViewsUnchanged: 0,
      failureReasonsToday: [], llmSkippedReasons: [], errors: ["form_failed:X"],
    };
    const cur = {
      date: "2026-08-03", ranAt: "2026-08-03T02:00:00Z",
      facts: [{ statement: "A" }, { statement: "C" }], // "A"はprevと重複、"C"だけ新規
      otherFactsToday: [], coachChangesDetectedToday: 0, transferFactsAddedToday: 0,
      knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 16,
      matchesResolvedToday: 0, newPredictionsLogged: 0,
      hypothesesConfirmed: 0, hypothesesDiscarded: 0, reflectionsSaved: 0,
      profilesGenerated: 0, aiViewsChanged: 0, aiViewsUnchanged: 5,
      failureReasonsToday: [], llmSkippedReasons: [], errors: ["team_not_found:Al-Nassr"],
    };
    const merged = mergeGrowthLogs(prev, cur);
    assert.strictEqual(merged.runsToday, 2);
    assert.strictEqual(merged.facts.length, 3, "AがA重複排除されB,Cは残るはず");
    assert.strictEqual(merged.knowledgeItemsSavedToday, 16, "1回目の実際の保存件数が2回目の0で消えてはいけない");
    assert.strictEqual(merged.knowledgeItemsDuplicateToday, 16);
    assert.strictEqual(merged.matchesResolvedToday, 2);
    assert.strictEqual(merged.aiViewsChanged, 10);
    assert.strictEqual(merged.aiViewsUnchanged, 5);
    assert.deepStrictEqual(merged.errors, ["form_failed:X", "team_not_found:Al-Nassr"], "エラーは両方の実行分を蓄積するはず");
  });

  await test("mergeGrowthLogs: 日付が違えば合算せず今回の値だけを使う(新しい日の開始)", () => {
    const { mergeGrowthLogs } = require("../server/learning/dailyJob");
    const prev = { date: "2026-08-02", knowledgeItemsSavedToday: 99, errors: ["old"] };
    const cur = { date: "2026-08-03", knowledgeItemsSavedToday: 3, errors: [] };
    const merged = mergeGrowthLogs(prev, cur);
    assert.strictEqual(merged.runsToday, 1);
    assert.strictEqual(merged.knowledgeItemsSavedToday, 3);
    assert.deepStrictEqual(merged.errors, []);
  });

  await test("runDailyLearning: 同じ日に2回実行しても、1回目に実際に保存した知識件数が2回目の結果で消えない(本番バグの再現・修正確認)", async () => {
    const mock = createMockRedis();
    const { runDailyLearning } = require("../server/learning/dailyJob");
    const nowFn = () => new Date("2026-08-03T22:00:00Z"); // 1回目・2回目とも「同じ日」扱いにする
    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFlatFixtureList(params.team, params.last, Date.parse("2026-08-03T22:00:00Z")) };
      if (endpoint === "/fixtures" && params.team && params.next) return { response: [] };
      if (endpoint === "/transfers") return { response: [] };
      return { response: [] };
    };
    const deps = { callApiFootball: customApiFootball, resolveTeamId: resolveTeamIdStub, upstashEnabled: true, ...mock, now: nowFn };

    const run1 = await runDailyLearning(deps);
    assert.ok(run1.ok, "1回目の実行は成功するはず");
    assert.ok(run1.knowledgeItemsSavedToday > 0, `1回目は新しい知識が保存されるはず, got ${run1.knowledgeItemsSavedToday}`);
    assert.strictEqual(run1.runsToday, 1);

    // 2回目: Renderの再起床待ちタイムアウト後のリトライ等を想定し、全く同じ日に
    // もう一度実行する(下地データは同一なので、Knowledge Engineの重複排除に
    // より新規保存は0件になるのが正しい挙動)。
    const run2 = await runDailyLearning(deps);
    assert.ok(run2.ok, "2回目の実行も成功するはず");
    assert.strictEqual(run2.runsToday, 2, "2回目はrunsToday=2になるはず");
    // ここが本番で壊れていた部分: 2回目のAPIレスポンス(このシナリオでは
    // 重複なので0件)が、1回目の実際の保存件数を上書きしてはならない。
    assert.strictEqual(
      run2.knowledgeItemsSavedToday, run1.knowledgeItemsSavedToday,
      `修正後は1回目の保存件数がそのまま合算表示されるはず(2回目は重複のみのため追加0件). got run1=${run1.knowledgeItemsSavedToday} run2=${run2.knowledgeItemsSavedToday}`
    );
    assert.ok(run2.knowledgeItemsDuplicateToday >= run1.knowledgeItemsSavedToday, "2回目はほぼ全て重複と判定されるはず");
  });

  // ============================================================
  // パート2: resolveTeamId ― 一時的な障害と「本当に見つからない」の区別
  // ============================================================
  await test("resolveTeamId: 一時的なネットワーク障害(1回目失敗)は自動リトライで回復し、誤って「見つからない」とキャッシュされない", async () => {
    process.env.API_FOOTBALL_KEY = "test-key-transient";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-transient.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    process.env.PORT = "0";
    delete process.env.AUTO_COLLECT_SECRET;

    let callCount = 0;
    global.fetch = async (urlArg) => {
      const u = new URL(urlArg.toString());
      if (u.hostname === "fake-upstash-transient.example.com") return { ok: true, json: async () => ({ result: null }) };
      if (u.pathname === "/teams") {
        callCount++;
        if (callCount === 1) return { ok: false, status: 503 }; // 1回目は一時的なサーバーエラーを模擬
        return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 3060, name: u.searchParams.get("search") } }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    delete require.cache[require.resolve(path.join(__dirname, "..", "server", "server.js"))];
    const { learningDeps, server } = require(path.join(__dirname, "..", "server", "server.js"));
    server.close();

    const id = await learningDeps.resolveTeamId("Some Transient Club");
    assert.strictEqual(id, 3060, "1回目が一時的な障害でも、自動リトライで正しく解決できるはず");
    assert.strictEqual(callCount, 2, "1回失敗→1回リトライで成功する想定");
  });

  await test("resolveTeamId: 本当に見つからない(全バリエーションで空)場合は正しくnullを返しキャッシュする", async () => {
    process.env.API_FOOTBALL_KEY = "test-key-notfound";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-notfound.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    process.env.PORT = "0";

    let callCount = 0;
    global.fetch = async (urlArg) => {
      const u = new URL(urlArg.toString());
      if (u.hostname === "fake-upstash-notfound.example.com") return { ok: true, json: async () => ({ result: null }) };
      if (u.pathname === "/teams") { callCount++; return { ok: true, json: async () => ({ errors: [], response: [] }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    delete require.cache[require.resolve(path.join(__dirname, "..", "server", "server.js"))];
    const { learningDeps, server } = require(path.join(__dirname, "..", "server", "server.js"));
    server.close();

    const id1 = await learningDeps.resolveTeamId("Totally Unknown FC");
    assert.strictEqual(id1, null);
    const callsAfterFirst = callCount;
    const id2 = await learningDeps.resolveTeamId("Totally Unknown FC");
    assert.strictEqual(id2, null);
    assert.strictEqual(callCount, callsAfterFirst, "本当に見つからない場合はキャッシュが効き、2回目はAPIを再度叩かないはず");
  });

  console.log(failures === 0 ? "\nAll production bug-fix tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
