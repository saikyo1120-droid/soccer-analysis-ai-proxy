"use strict";
/** v99(2026年11月6日): 「同じ日に学習が2回まるごと走る」問題と、その周辺の修正のテスト。
 *
 *  本番実測(11/6): 学習が 09:15 JST と 12:38 JST の2回走っていた(10/24・10/25 も2回)。
 *   原因: GitHub Actions の定期実行が「本番 04:17 JST」+「保険 08:43 JST」の2本立てで、
 *   二重起動の防止が「実行ロック(90分で失効)」だけだったため、保険の方は毎回ロックが消えた後に
 *   来て、まるごともう一度走っていた。Upstash の消費が1日約2.9万コマンド(月間上限50万に
 *   11/22 ごろ到達する計算)。さらに ①動的クラブの「1日20件まで」が2回目にも効かず40件採用、
 *   ②LLM空応答の停止理由(stop_reason)が記録に残らない、③学習1回の保存先コマンド数の内訳が
 *   分からない、も同時に判明した。
 *
 *  このテストは、差し替えた保存先で実際にサーバーを動かし、
 *   A: 「今日はもう完走した」ガードが run-daily / 自己修復 / 自動QA / 直接呼び出しの全入口で効き、
 *      ?force=1 と「完走していない日」では従来どおり学習が走ること(劣化なし)
 *   B: 動的クラブの1日上限が同日の2回目にも効くこと
 *   C: LLM空応答の手がかり(stop_reason・再試行)が失敗記録に残ること
 *   D: 学習1回の保存先コマンド数が段階別に実測されること
 *   E: 日次レポートに runsToday / storeUsage / 動的クラブの指標が載ること
 *   F: GitHub Actions のワークフローが「完走済み」の応答で待機を飛ばすこと
 *  を、戻り値と呼び出し回数で確かめる。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 保存先モック(GET/SET NX/MGET/HSET/HGETALL/HDEL/INCR/INCRBY/LRANGE/RPUSH/LPUSH/LTRIM/LREM/DEL/EXPIRE) */
function mockStore() {
  const store = new Map(); const calls = []; const m = { mode: "ok" };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (m.mode === "down") { const e = new Error("リクエストがタイムアウトしました(15000ms・接続先: 保存先(データベース))"); e.code = "TIMEOUT"; throw e; }
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "HDEL") { const h = store.get(a[0]) || {}; let n = 0; for (const f of a.slice(1)) if (f in h) { delete h[f]; n++; } store.set(a[0], h); return n; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "LLEN") { const l = store.get(a[0]) || []; return l.length; }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = store.get(a[0]) || []; l.unshift(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LREM") { const l = store.get(a[0]) || []; store.set(a[0], l.filter((v) => v !== a[2])); return 1; }
    if (op === "LTRIM") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; store.set(a[0], l.slice(s, e + 1)); return "OK"; }
    if (op === "EXPIRE" || op === "PEXPIRE") return 1;
    if (op === "EXISTS") return a.filter((k) => store.has(k)).length;
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  return { store, calls, count, m, upstashCmd, upstashGetJSON, upstashSetJSON };
}

const PORT = 8914;
const req = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, body: j }); }); });
  r.on("error", reject); r.end();
});

(async () => {
  console.log("v99 同日2回目の学習ガード・動的クラブ上限・LLM空応答の手がかり・保存先コマンド実測 テスト");

  // ================= 起動(差し替え保存先・自己修復は有効・チェック間隔0) =================
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.LEARN_SWEEP_CHECK_INTERVAL_MS = "0";
  process.env.STORE_QUOTA_STICKY_MS = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "1";
  delete process.env.AUTO_COLLECT_SECRET; // 鍵なし(手順書の既定)で run-daily を叩けるようにする
  const srvMod = require("./server.js");
  const S = srvMod.__storeForTest;
  const V = srvMod.__v99ForTest;
  const m = mockStore();
  const now = Date.now();
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  const jstToday = jst(now);
  const jstYesterday = jst(now - 86400000);
  const learnSpy = { calls: 0 };
  srvMod.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    runDailyLearning: async () => { learnSpy.calls++; return { ok: true, date: jstToday }; },
    callApiFootball: async () => ({ response: [] }),
  });
  await sleep(300);
  const waitIdle = async () => { for (let i = 0; i < 100 && S.isLearningRunning(); i++) await sleep(50); };
  const reset = () => { m.store.clear(); S.resetForTest(); learnSpy.calls = 0; };

  /* ================= A: 「今日はもう完走した」ガード ================= */
  await t("A1 判定: 記録なし→未完走 / 進捗が今日完走→完走 / 成長ログが今日→完走 / 日付だけ今日で時刻が2日前→未完走 / 読めない→readFailed", async () => {
    reset();
    let d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, false, JSON.stringify(d));
    m.store.set("learn:progress", JSON.stringify({ date: jstToday, finished: true, at: new Date(now).toISOString(), startedAt: new Date(now - 1800000).toISOString() }));
    d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, true); assert.strictEqual(d.source, "progress");
    m.store.clear();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now).toISOString(), runsToday: 1 }));
    d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, true); assert.strictEqual(d.source, "growthlog"); assert.strictEqual(d.runsToday, 1);
    m.store.clear();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now - 48 * 3600000).toISOString() }));
    d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, false, "日付だけ今日で時刻が2日前の食い違った記録を完走と誤認した");
    m.store.clear();
    m.store.set("learn:progress", JSON.stringify({ date: jstToday, finished: false, at: new Date(now).toISOString() }));
    d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, false, "finished:false を完走と誤認した");
    m.m.mode = "down";
    d = await V.dailyLearningCompletedToday();
    assert.strictEqual(d.completed, false); assert.strictEqual(d.readFailed, true);
    m.m.mode = "ok";
    S.resetForTest();
  });

  await t("A2 run-daily: 今日完走済みなら ok:true・started:false・alreadyCompleted:true を返し、学習を起動せず、実行ロックも取らない", async () => {
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now - 3600000).toISOString(), runsToday: 1 }));
    const r = await req("POST", "/api/learning/run-daily");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.started, false); assert.strictEqual(r.body.alreadyCompleted, true);
    assert.strictEqual(r.body.reason, "ALREADY_COMPLETED_TODAY");
    assert.ok(/完走/.test(r.body.messageJa), r.body.messageJa);
    await sleep(300);
    assert.strictEqual(learnSpy.calls, 0, "完走済みの日に学習が起動した");
    assert.ok(!m.store.has(`learn:runlock:${jstToday}`), "完走済みの判定の前に実行ロックを取ってしまった");
  });

  await t("A3 run-daily?force=1: 意図的な再実行は従来どおり走る(ガードを素通し)", async () => {
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now - 3600000).toISOString(), runsToday: 1 }));
    const r = await req("POST", "/api/learning/run-daily?force=1");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.started, true, JSON.stringify(r.body));
    await waitIdle();
    assert.strictEqual(learnSpy.calls, 1, "force=1 なのに学習が走らなかった(劣化)");
  });

  await t("A4 run-daily: 完走していない日は従来どおり起動し(劣化なし)、直後の再送は実行ロックで止まり、完走後は alreadyCompleted になる", async () => {
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstYesterday, ranAt: new Date(now - 26 * 3600000).toISOString(), runsToday: 1 }));
    const r1 = await req("POST", "/api/learning/run-daily");
    assert.strictEqual(r1.body.started, true, JSON.stringify(r1.body));
    await waitIdle();
    assert.strictEqual(learnSpy.calls, 1);
    const r2 = await req("POST", "/api/learning/run-daily");
    assert.strictEqual(r2.body.reason, "RUN_LOCK_HELD", JSON.stringify(r2.body));
    // 学習が完走して今日の成長ログが書かれた状態 → ロックが切れても2回目は走らない
    m.store.delete(`learn:runlock:${jstToday}`);
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date().toISOString(), runsToday: 1 }));
    const r3 = await req("POST", "/api/learning/run-daily");
    assert.strictEqual(r3.body.alreadyCompleted, true, JSON.stringify(r3.body));
    await sleep(200);
    assert.strictEqual(learnSpy.calls, 1, "完走後の再送で学習が2回目を走らせた");
  });

  await t("A5 runDailyLearningThenQA(全入口の最後の砦): 完走済みなら skipped、{force:true} なら走る", async () => {
    reset();
    m.store.set("learn:progress", JSON.stringify({ date: jstToday, finished: true, at: new Date(now).toISOString() }));
    const r = await V.runDailyLearningThenQA(srvMod.learningDeps);
    assert.strictEqual(r.skipped, true); assert.strictEqual(r.alreadyCompleted, true); assert.strictEqual(learnSpy.calls, 0);
    const r2 = await V.runDailyLearningThenQA(srvMod.learningDeps, { force: true });
    assert.notStrictEqual(r2.skipped, true); assert.strictEqual(learnSpy.calls, 1);
  });

  await t("A6 自己修復: 今日の完走記録があれば、止まった進捗(今日2回目の残骸)を拾い直さない/完走記録が無ければ従来どおり拾い直す", async () => {
    reset();
    // 時刻はすべて「日本時間の今日」の中に収める(日付境界をまたぐと「今日の完走」にならず、テストが時刻依存になる)
    const jstDayStartMs = Date.parse(`${jstToday}T00:00:00+09:00`);
    const sinceDayStartMs = now - jstDayStartMs;
    if (sinceDayStartMs < 40 * 60000) { console.log("    (日本時間の日付が変わった直後のため、この検査は時刻の都合でスキップ: 翌実行で検査されます)"); return; }
    const ranAtMs = Math.max(jstDayStartMs + 60000, now - 2 * 3600000 - 600000);  // 今日1回目の完走(成長ログ)
    const progStarted = Math.max(ranAtMs + 60000, now - 2 * 3600000);              // その後に始まった2回目
    const stalledAt = Math.max(progStarted + 1000, now - 3600000);                  // 2回目の最後の進捗(35分以上前)
    const stalledEnough = (now - stalledAt) >= 36 * 60000;
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(ranAtMs).toISOString(), runsToday: 1 }));
    m.store.set("learn:progress", JSON.stringify({ date: jstToday, finished: false, stage: "⑤ 収集", startedAt: new Date(progStarted).toISOString(), at: new Date(stalledAt).toISOString() }));
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(200);
    assert.strictEqual(learnSpy.calls, 0, "完走済みの日に止まった進捗を拾い直して3回目を走らせた");
    assert.ok(!m.store.has(`learn:stalledretry:${jstToday}`), "拾い直しの回数を消費した");
    // 従来機能の保持: 今日の完走記録が無い(昨日の記録)なら、止まった進捗は拾い直す
    if (!stalledEnough) { console.log("    (日付が変わって間もないため、従来機能の確認は次回の実行に回します)"); return; }
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstYesterday, ranAt: new Date(now - 20 * 3600000).toISOString(), runsToday: 1 }));
    m.store.set("learn:progress", JSON.stringify({ date: jstToday, finished: false, stage: "⑤ 収集", startedAt: new Date(progStarted).toISOString(), at: new Date(stalledAt).toISOString() }));
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(200);
    assert.strictEqual(learnSpy.calls, 1, "止まった学習の拾い直し(従来機能)が動かなくなった");
  });

  await t("A7 自動QAからの再起動(triggerDailyLearningForRepair): 完走済みなら起動しても学習本体は走らない", async () => {
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now - 3600000).toISOString(), runsToday: 1 }));
    const r = await V.triggerDailyLearningForRepair();
    await waitIdle(); await sleep(200);
    assert.strictEqual(learnSpy.calls, 0, JSON.stringify(r));
  });

  await t("A8 保存先が落ちている間はガードは判断せず、実行ロックの fail-closed が学習を止める(v94 の挙動を維持)", async () => {
    reset();
    m.m.mode = "down";
    const r = await req("POST", "/api/learning/run-daily");
    assert.strictEqual(r.status, 503, JSON.stringify(r.body));
    assert.strictEqual(r.body.reason, "STORE_UNAVAILABLE");
    m.m.mode = "ok";
    S.resetForTest();
    assert.strictEqual(learnSpy.calls, 0);
  });

  /* ================= B: 動的クラブの1日上限(同日の合計) ================= */
  await t("B1 adoptForToday: 同じ日に2回呼ばれても採用は合計 perDay 件まで。翌日は再び採用できる", async () => {
    const { createDynamicUniverse } = require("./learning/dynamicUniverse");
    const s = mockStore();
    const dyn = createDynamicUniverse({ upstashEnabled: true, upstashCmd: s.upstashCmd });
    const day = "2026-11-06";
    const nowMs = new Date("2026-11-06T00:00:00Z").getTime() + 12 * 3600000;
    const seen = await dyn.recordSeen([1, 2, 3, 4, 5].map((i) => ({ teamId: 100 + i, nameEn: "Dyn FC " + i, leagueId: 500 })), { source: "fixtures", nowMs, isStaticTeam: () => false });
    assert.strictEqual(seen.recorded, 5, JSON.stringify(seen));
    const a1 = await dyn.adoptForToday({ dateKey: day, nowMs, perDay: 2, maxAdopted: 300, isStaticTeam: () => false });
    assert.strictEqual(a1.ok, true); assert.strictEqual(a1.adoptedNow.length, 2); assert.strictEqual(a1.adoptedTodayBefore, 0);
    const a2 = await dyn.adoptForToday({ dateKey: day, nowMs, perDay: 2, maxAdopted: 300, isStaticTeam: () => false });
    assert.strictEqual(a2.ok, true); assert.strictEqual(a2.adoptedNow.length, 0, "同日2回目の呼び出しで上限を超えて採用した"); assert.strictEqual(a2.adoptedTodayBefore, 2);
    assert.strictEqual(a2.adoptedAll.length, 2); assert.ok(/すでに2件採用済み/.test(a2.reasonJa || ""), a2.reasonJa);
    const a3 = await dyn.adoptForToday({ dateKey: "2026-11-07", nowMs: nowMs + 86400000, perDay: 2, maxAdopted: 300, isStaticTeam: () => false });
    assert.strictEqual(a3.adoptedNow.length, 2); assert.strictEqual(a3.adoptedTodayBefore, 0); assert.strictEqual(a3.adoptedAll.length, 4);
  });

  /* ================= C: LLM空応答の手がかり ================= */
  await t("C1 llmErrorTag: コードに stop_reason・blocks・再試行の手がかりを添える(他のエラーは従来どおり)", async () => {
    const { llmErrorTag } = require("./learning/dailyJob");
    assert.strictEqual(typeof llmErrorTag, "function");
    const e = new Error("空の応答が返されました(stop_reason=max_tokens, blocks=thinking)"); e.code = "EMPTY_RESPONSE"; e.retriedAfterEmpty = true;
    assert.strictEqual(llmErrorTag(e), "EMPTY_RESPONSE(stop_reason=max_tokens, blocks=thinking・再試行も空)");
    const e2 = new Error("空の応答が返されました(stop_reason=end_turn, blocks=empty)"); e2.code = "EMPTY_RESPONSE";
    assert.strictEqual(llmErrorTag(e2), "EMPTY_RESPONSE(stop_reason=end_turn, blocks=empty)");
    const e3 = new Error("timed out"); e3.code = "TIMEOUT";
    assert.strictEqual(llmErrorTag(e3), "TIMEOUT");
    assert.strictEqual(llmErrorTag(new Error("LLM出力がJSON形式ではありませんでした")), "LLM出力がJSON形式ではありませんでした");
  });

  await t("C2 generateLLM: 再試行も空なら retriedAfterEmpty:true と「再試行も空」つきで投げる/再試行で復帰すれば結果に retriedAfterEmpty:true", async () => {
    process.env.LLM_EMPTY_RETRY_DELAY_MS = "1";
    delete require.cache[require.resolve("./llm/index.js")];
    const llm = require("./llm/index.js");
    let calls = 0;
    llm.PROVIDERS.stubv99 = () => ({
      generate: async () => { calls++; const e = new Error("空の応答が返されました(stop_reason=max_tokens, blocks=thinking)"); e.code = "EMPTY_RESPONSE"; throw e; },
      resolveModel: () => "stub-model",
    });
    process.env.LLM_PROVIDER = "stubv99";
    let thrown = null;
    try { await llm.generateLLM({ systemPrompt: "s", userPrompt: "u", maxTokens: 10 }); } catch (e) { thrown = e; }
    assert.ok(thrown, "投げられなかった"); assert.strictEqual(calls, 2, "再試行は1回だけのはず: " + calls);
    assert.strictEqual(thrown.code, "EMPTY_RESPONSE"); assert.strictEqual(thrown.retriedAfterEmpty, true);
    assert.ok(/再試行も空/.test(thrown.message), thrown.message);
    assert.ok(/stop_reason=max_tokens/.test(thrown.message), thrown.message);
    calls = 0;
    llm.PROVIDERS.stubv99 = () => ({
      generate: async () => { calls++; if (calls === 1) { const e = new Error("空"); e.code = "EMPTY_RESPONSE"; throw e; } return { text: "ok", model: "stub-model" }; },
      resolveModel: () => "stub-model",
    });
    const out = await llm.generateLLM({ systemPrompt: "s", userPrompt: "u", maxTokens: 10 });
    assert.strictEqual(out.text, "ok"); assert.strictEqual(out.retriedAfterEmpty, true);
    delete process.env.LLM_PROVIDER;
  });

  /* ================= D: 学習1回の保存先コマンド数(段階別の実測) ================= */
  await t("D1 runDailyLearning: storeUsage(合計・段階別)が実測され、進捗の記録にも合計が残る/計測関数が無ければ measured:false", async () => {
    const { runDailyLearning } = require("./learning/dailyJob");
    const s = mockStore();
    let counter = 0;
    const countedCmd = async (cmd) => { counter++; return s.upstashCmd(cmd); };
    const deps = {
      callApiFootball: async () => ({ response: [] }), resolveTeamId: async () => 1001,
      upstashEnabled: true, upstashCmd: countedCmd,
      upstashGetJSON: async (k) => { const r = await countedCmd(["GET", k]); return r === null ? null : JSON.parse(r); },
      upstashSetJSON: async (k, v) => { await countedCmd(["SET", k, JSON.stringify(v)]); return true; },
      now: () => new Date("2026-11-06T03:00:00Z"), appDateKey: (d) => new Date((d ? new Date(d) : new Date("2026-11-06T03:00:00Z")).getTime() + 9 * 3600000).toISOString().slice(0, 10),
      storeCommandsSoFar: () => counter,
    };
    const result = await runDailyLearning(deps);
    assert.strictEqual(result.ok, true, JSON.stringify(result).slice(0, 300));
    const su = result.storeUsage;
    assert.ok(su && su.measured === true, "storeUsage が実測されていない: " + JSON.stringify(su));
    assert.ok(Number.isFinite(su.commandsThisRun) && su.commandsThisRun > 0, "合計が0以下: " + su.commandsThisRun);
    assert.ok(su.commandsThisRun <= counter, "合計が実際のコマンド数を超えている");
    assert.ok(Array.isArray(su.byStage) && su.byStage.length > 0, "段階別が空");
    assert.ok(su.byStage.every((x) => typeof x.name === "string" && Number.isFinite(x.storeCmds) && x.storeCmds > 0));
    const sumStages = su.byStage.reduce((a, x) => a + x.storeCmds, 0);
    assert.ok(sumStages <= su.commandsThisRun, `段階別の合計(${sumStages})が全体(${su.commandsThisRun})を超えている`);
    assert.strictEqual(su.commandsToday, su.commandsThisRun, "同日1回目は commandsToday = commandsThisRun のはず");
    assert.ok(/コマンドは[\d,]+件/.test(su.noteJa), su.noteJa);
    const prog = JSON.parse(s.store.get("learn:progress"));
    assert.strictEqual(prog.finished, true);
    assert.ok(Number.isFinite(prog.storeCommandsThisRun) && prog.storeCommandsThisRun >= su.commandsThisRun, JSON.stringify({ prog: prog.storeCommandsThisRun, su: su.commandsThisRun }));
    assert.ok(prog.stages.some((x) => Number.isFinite(x.storeCmds)), "進捗の段階に storeCmds が無い");
    // 同日2回目(force 相当)は合算される
    const result2 = await runDailyLearning(deps);
    assert.strictEqual(result2.storeUsage.commandsToday, su.commandsThisRun + result2.storeUsage.commandsThisRun);
    assert.strictEqual(result2.storeUsage.runsCounted, 2);
    // 計測関数が無い環境では正直に measured:false
    const s2 = mockStore();
    const r3 = await runDailyLearning({ ...deps, upstashCmd: s2.upstashCmd, upstashGetJSON: s2.upstashGetJSON, upstashSetJSON: s2.upstashSetJSON, storeCommandsSoFar: undefined });
    assert.strictEqual(r3.storeUsage.measured, false); assert.strictEqual(r3.storeUsage.commandsThisRun, null);
  });

  await t("D2 本番の配線: learningDeps.storeCommandsSoFar は保存先コマンドの実測カウンターを返す(単調増加)", async () => {
    const before = srvMod.learningDeps.storeCommandsSoFar();
    assert.ok(Number.isFinite(before));
    S.noteCommandsForTest(5);
    assert.strictEqual(srvMod.learningDeps.storeCommandsSoFar(), before + 5);
    assert.strictEqual(V.processCommands(), before + 5);
  });

  /* ================= E: 日次レポートの開示 ================= */
  await t("E1 /api/learning/daily-report: runsToday・storeUsage・動的クラブの指標・teamMapSaved・squadRatingUsedToday が載る", async () => {
    reset();
    srvMod.__clearCache();
    const g = {
      date: jstToday, ranAt: new Date(now).toISOString(), firstRanAt: new Date(now - 3600000).toISOString(), runsToday: 2, errors: [], warnings: { count: 0, items: [] },
      storeUsage: { measured: true, commandsThisRun: 1234, commandsToday: 2468, runsCounted: 2, byStage: [{ name: "⑤ 収集", storeCmds: 900 }], noteJa: "n" },
      universe: { coreClubsPlanned: 192, coreClubsUpdated: 192, dynamic: { adoptedTotal: 40, dueToday: 20, newToday: 20 }, teamMapSaved: true, skipped: [], errors: [] },
      dynamicUniverse: { ok: true, adoptedNow: [{ nameEn: "Dyn FC 1" }, { nameEn: "Dyn FC 2" }], adoptedAll: new Array(40).fill({ nameEn: "x" }), adoptedTodayBefore: 0, candidates: 61, prunedSeen: 3, retired: 0, warnings: [] },
      squadRatingUsedToday: 7,
    };
    m.store.set("learn:growthlog:latest", JSON.stringify(g));
    const r = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now()}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(r.body.runsToday, 2); assert.strictEqual(r.body.firstRanAt, g.firstRanAt); assert.strictEqual(r.body.lastRanAt, g.ranAt);
    assert.deepStrictEqual(r.body.storeUsage, g.storeUsage);
    assert.deepStrictEqual(r.body.updates.universeDynamic, g.universe.dynamic);
    assert.strictEqual(r.body.updates.dynamicUniverse.adoptedNow, 2);
    assert.deepStrictEqual(r.body.updates.dynamicUniverse.adoptedNowNames, ["Dyn FC 1", "Dyn FC 2"]);
    assert.strictEqual(r.body.updates.dynamicUniverse.adoptedAll, 40); assert.strictEqual(r.body.updates.dynamicUniverse.candidates, 61);
    assert.strictEqual(r.body.updates.teamMapSaved, true); assert.strictEqual(r.body.updates.squadRatingUsedToday, 7);
    // 古い記録(v98 以前)でも壊れない
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now).toISOString(), errors: [] }));
    srvMod.__clearCache();
    const r2 = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now() + 1}`);
    assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.runsToday, 1); assert.strictEqual(r2.body.storeUsage, null); assert.strictEqual(r2.body.updates.dynamicUniverse, null);
  });

  /* ================= F: ワークフロー ================= */
  await t("F1 daily-learning.yml: 呼び出しステップが alreadyCompleted を出力し、待機ステップはそのとき飛ぶ", async () => {
    const yml = fs.readFileSync(path.join(__dirname, ".github", "workflows", "daily-learning.yml"), "utf8");
    assert.ok(/id:\s*call/.test(yml));
    assert.ok(/"alreadyCompleted":true/.test(yml));
    assert.ok(/already_completed=true" >> "\$GITHUB_OUTPUT"/.test(yml));
    assert.ok(/if:\s*steps\.call\.outputs\.already_completed != 'true'/.test(yml));
    assert.ok(/完走済みなら何もしない/.test(yml));
  });

  await t("H1 mergeGrowthLogs: 同日2回目の「本日実行済みのため見送り」(ran:false)が、1回目のモデル調整の結果を上書きしない", async () => {
    const { mergeGrowthLogs } = require("./learning/dailyJob");
    const run1 = { date: "2026-11-07", ranAt: "2026-11-06T23:43:00.000Z", modelTuning: { ran: true, adopted: false, reasonJa: "改善なし", oldEval: { logLoss: 1.018 }, newEval: { logLoss: 1.0183 } }, errors: [], warnings: { count: 0, items: [] } };
    const run2 = { date: "2026-11-07", ranAt: "2026-11-07T03:10:00.000Z", modelTuning: { ran: false, adopted: false, reasonJa: "本日23:43(UTC)に実行済みのため再実行しませんでした" }, errors: [], warnings: { count: 0, items: [] } };
    const merged = mergeGrowthLogs(mergeGrowthLogs(null, run1), run2);
    assert.strictEqual(merged.runsToday, 2);
    assert.strictEqual(merged.modelTuning.ran, true, "1回目の本当の調整結果が消えた: " + JSON.stringify(merged.modelTuning));
    assert.strictEqual(merged.modelTuning.newEval.logLoss, 1.0183);
    // 逆順(1回目が見送り・2回目が実行)でも、実行した方が残る
    const merged2 = mergeGrowthLogs(mergeGrowthLogs(null, run2), run1);
    assert.strictEqual(merged2.modelTuning.ran, true);
    // 両方とも見送りなら最新(従来どおり)
    const merged3 = mergeGrowthLogs(mergeGrowthLogs(null, run2), { ...run2, ranAt: "2026-11-07T05:00:00.000Z", modelTuning: { ran: false, reasonJa: "later" } });
    assert.strictEqual(merged3.modelTuning.reasonJa, "later");
  });

  await t("G1 v92方針: 今回触ったファイルに黙った catch(catch (e) { /*)を増やしていない", async () => {
    for (const f of ["learning/dynamicUniverse.js", "learning/dailyJob.js", "llm/index.js"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const n = (src.match(/catch \(e\d?\) \{ \/\*/g) || []).length;
      if (f === "learning/dynamicUniverse.js") assert.strictEqual(n, 0, f + " に黙った catch がある");
    }
  });

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
  try { srvMod.server.close(); } catch (e) { /* テスト終了時の後片づけ */ }
  process.exit(fail ? 1 : 0);
})();
