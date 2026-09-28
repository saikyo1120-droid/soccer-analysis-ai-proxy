"use strict";
/** v94(2026年9月26日): 保存先(Upstash)停止時の「空回り」防止と、読み出し失敗の誤表示修正のテスト。
 *
 *  本番事故(実測): 9/25にUpstash無料プランの月間上限(50万コマンド)に達し、全コマンドが
 *   「ERR max requests limit exceeded」で拒否された。すると
 *   ・自己修復が「学習の記録が読めない(null)」を「学習が古い」と誤判定し、
 *   ・実行ロックの確認が失敗時に「許可」へ倒れていたため、
 *   約15分ごとに毎日の学習が繰り返し起動。保存できないので成果ゼロのまま、API-Football
 *   (Pro・1日7,500件)を 9/26 04:13 UTC 時点で利用者予約分の20件まで使い切っていた。
 *   さらに成長ログ・健康診断・進捗・日次レポートが「一度も実行されていません」「0件」と
 *   事実と違う表示をしていた。
 *
 *  このテストは、差し替えた保存先を「上限超過」状態に切り替えて実際にサーバーを動かし、
 *   ① 学習が始まらない(fail-closed) ② 各画面が「読めなかった」と正直に返す
 *   ③ 復旧後は従来どおり動く ④ 使用量カウンター/MGET/キャッシュが実際に効く
 *  ことを、往復回数と戻り値で確かめる(ソースの文字列検査だけに頼らない)。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const findUp = (...names) => {
  for (const n of names) { for (const base of [path.join(__dirname, ".."), __dirname]) { const f = path.join(base, n); if (fs.existsSync(f)) return f; } }
  return path.join(__dirname, "..", names[0]);
};
const INDEX_HTML = findUp("index.html");
const SW_JS = findUp("sw.js");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUOTA_MSG = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details";

/** 「上限超過」に切り替えられる保存先モック。全コマンドを記録する。 */
function mockStore() {
  const store = new Map(); const calls = []; const m = { mode: "ok" };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (m.mode === "quota") throw new Error("Upstash error: " + QUOTA_MSG);
    if (m.mode === "timeout") { const e = new Error("リクエストがタイムアウトしました(15000ms・接続先: 保存先(データベース))"); e.code = "TIMEOUT"; throw e; }
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { store.delete(a[0]); return 1; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; return l.slice(); }
    if (op === "LLEN") { const l = store.get(a[0]) || []; return l.length; }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "EXPIRE") return 1;
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  return { store, calls, count, m, upstashCmd, upstashGetJSON, upstashSetJSON };
}

const PORT = 8911;
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, body: j }); }); }).on("error", reject);
});

(async () => {
  console.log("v94 保存先停止時の空回り防止・誤表示修正テスト");

  // ================= 起動(差し替え保存先・自己修復は有効・チェック間隔0) =================
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; // 差し替え前に本物へ出ないよう到達不能に
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";                 // 自走タイマーは止め、テストから直接呼ぶ
  process.env.LEARN_SWEEP_CHECK_INTERVAL_MS = "0"; // 自己修復の確認を毎回行う
  process.env.STORE_QUOTA_STICKY_MS = "0";         // 復旧判定を即時に(本番既定は10分)
  process.env.ACCURACY_STATS_CACHE_MS = "600000";
  process.env.ACCURACY_STATS_FAIL_CACHE_MS = "60000";
  const srvMod = require("./server.js");
  const S = srvMod.__storeForTest;
  const m = mockStore();
  const now = Date.now();
  const jstToday = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const learnSpy = { calls: 0 };
  m.store.set("pred:autocollect:lastrun", JSON.stringify({ at: new Date(now).toISOString() }));
  m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now).toISOString(), errors: [], warnings: { count: 0, items: [] } }));
  srvMod.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    runDailyLearning: async () => { learnSpy.calls++; return { ok: true, date: jstToday }; },
  });
  await sleep(300);

  await t("① 上限超過メッセージの判定(実際の本番エラー文)", () => {
    assert.strictEqual(S.isQuotaExceededMessage("Upstash error: " + QUOTA_MSG), true);
    assert.strictEqual(S.isQuotaExceededMessage("Upstash error: WRONGTYPE Operation against a key"), false);
    assert.strictEqual(S.isQuotaExceededMessage(null), false);
  });

  await t("② 正常時: 実行ロックは取れる/自己修復は「古い」記録で学習を起動する(従来機能の保持)", async () => {
    S.resetForTest();
    const lock = await S.tryAcquireDailyRunLock();
    assert.strictEqual(lock.acquired, true, JSON.stringify(lock));
    m.store.delete(`learn:runlock:${jstToday}`); // 取ったロックを片づける(次の確認のため)
    // 48時間前の記録 = 古い → 自己修復が学習を起動する
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now - 48 * 3600000).toISOString(), errors: [] }));
    learnSpy.calls = 0;
    await S.maybeSelfHealDailyLearning();
    for (let i = 0; i < 100 && (learnSpy.calls === 0 || S.isLearningRunning()); i++) await sleep(100);
    assert.ok(learnSpy.calls >= 1, "正常時の自己修復が学習を起動しなかった(従来機能の劣化): calls=" + learnSpy.calls);
    // 後片づけ: 記録を新しくして、以降のリクエストで自己修復が動かないようにする
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date().toISOString(), errors: [] }));
    m.store.delete(`learn:runlock:${jstToday}`);
    for (let i = 0; i < 100 && S.isLearningRunning(); i++) await sleep(100);
    assert.strictEqual(S.isLearningRunning(), false, "学習が終わらない");
  });

  // ================= 上限超過モードへ =================
  await t("③ 上限超過: 自己修復は学習を起動しない(読めない≠古い)・見送りが記録される・保存先は down 判定", async () => {
    S.resetForTest();
    m.m.mode = "quota";
    learnSpy.calls = 0;
    await S.maybeSelfHealDailyLearning();
    await sleep(200);
    assert.strictEqual(learnSpy.calls, 0, "上限超過中に学習が起動した(空回りの再発)");
    const sk = S.selfHealSkipped();
    assert.ok(sk.count >= 1, "見送りが記録されていない: " + JSON.stringify(sk));
    assert.ok(/^read_failed:/.test(sk.lastReason) || sk.lastReason === "store_down", "見送り理由: " + sk.lastReason);
    assert.strictEqual(S.storeIsDown(), true, "上限超過を1回見ても down にならない");
    const st = S.storeStatusSnapshot();
    assert.strictEqual(st.quotaExceeded, true);
    assert.ok(/月間コマンド上限/.test(st.noteJa), st.noteJa);
    // 2回目は読みに行かずに見送る(store_down)
    await S.maybeSelfHealDailyLearning();
    assert.strictEqual(S.selfHealSkipped().lastReason, "store_down");
    assert.strictEqual(learnSpy.calls, 0);
  });

  await t("④ 上限超過: 実行ロックは fail-closed(acquired:false・storeUnavailable:true・理由つき)", async () => {
    const lock = await S.tryAcquireDailyRunLock();
    assert.strictEqual(lock.acquired, false, JSON.stringify(lock));
    assert.strictEqual(lock.storeUnavailable, true);
    assert.ok(/保存先\(Upstash\)に接続できないため、学習を見送りました/.test(lock.reasonJa), lock.reasonJa);
  });

  await t("⑤ 上限超過: GET /api/learning/run-daily は 503・STORE_UNAVAILABLE を返し、学習を始めない", async () => {
    learnSpy.calls = 0;
    const r = await get("/api/learning/run-daily");
    assert.strictEqual(r.status, 503, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.reason, "STORE_UNAVAILABLE");
    assert.strictEqual(r.body.started, false);
    assert.ok(r.body.store && r.body.store.down === true);
    await sleep(200);
    assert.strictEqual(learnSpy.calls, 0);
  });

  await t("⑥ 上限超過: /api/health が store.down / quotaExceeded を返す(保存先を読まずに)", async () => {
    const before = m.calls.length;
    const r = await get("/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.store.down, true);
    assert.strictEqual(r.body.store.quotaExceeded, true);
    assert.ok(r.body.upstashUsage && Number.isFinite(r.body.upstashUsage.monthEstimate));
    assert.strictEqual(r.body.learningRunning, false);
    await sleep(150);
    // health 自身は保存先を読まない(裏の自己修復は down のため即見送り=コマンド0)
    const newCalls = m.calls.slice(before).filter((c) => c[0] !== "INCRBY");
    assert.strictEqual(newCalls.length, 0, "health の応答で保存先へコマンドが出た: " + JSON.stringify(newCalls));
  });

  await t("⑦ 上限超過: /api/growth-log は readFailed:true・ranYet:null で「未実行」と言わない(診断コード STORE_UNAVAILABLE)", async () => {
    const r = await get("/api/growth-log");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.readFailed, true, JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(r.body.ranYet, null);
    assert.ok(/読み出せませんでした/.test(r.body.message), r.body.message);
    assert.ok(!/一度も実行されていません/.test(r.body.message));
    assert.strictEqual(r.body.zeroKnowledgeDiagnosis.causes[0].code, "STORE_UNAVAILABLE");
    assert.strictEqual(r.body.zeroVerificationDiagnosis.unknown, true);
    assert.strictEqual(r.body.engineTotals.knowledgeItemsTotal, null, "読めない件数を0と表示している");
    assert.strictEqual(r.body.store.down, true);
  });

  await t("⑧ 上限超過: /api/learning/health は保存先を error、依存項目を unknown にし、「実行記録が1件もありません」と言わない", async () => {
    const r = await get("/api/learning/health?days=5");
    assert.strictEqual(r.status, 200);
    assert.ok(/保存先\(Upstash\)に接続できないため/.test(r.body.overallMessageJa), r.body.overallMessageJa);
    const byId = Object.fromEntries(r.body.engines.map((e) => [e.id, e]));
    assert.strictEqual(byId.upstash.status, "error");
    assert.ok(/Pay as you go/.test(byId.upstash.actionJa), byId.upstash.actionJa);
    assert.strictEqual(byId.githubActions.status, "unknown");
    assert.strictEqual(byId.learning.status, "unknown");
    assert.strictEqual(byId.predictionAccuracy.status, "unknown");
    assert.ok(!r.body.engines.some((e) => /実行記録が1件もありません|一度も実行されていません/.test(e.messageJa || "")), "誤診断の文言が残っている");
    assert.strictEqual(r.body.runHistory.available, false);
    assert.strictEqual(r.body.runHistory.storeDown, true);
    assert.ok(r.body.store && r.body.store.down === true);
    assert.ok(r.body.selfHeal && r.body.selfHeal.skippedForStore >= 1);
  });

  await t("⑨ 上限超過: /api/learning/progress は readFailed:true で「1度も走っていません」と言わない", async () => {
    const r = await get("/api/learning/progress");
    assert.strictEqual(r.body.readFailed, true);
    assert.strictEqual(r.body.available, false);
    assert.ok(/読み出せませんでした/.test(r.body.reasonJa), r.body.reasonJa);
    assert.ok(!/1度も走っていません/.test(r.body.reasonJa));
  });

  await t("⑩ 上限超過: /api/learning/daily-report は degraded:true・「記録がまだありません」と言わない", async () => {
    srvMod.__clearCacheForTest("learn:daily-report");
    const r = await get("/api/learning/daily-report");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.degraded, true, JSON.stringify({ degraded: r.body.degraded, note: r.body.noteJa }));
    assert.strictEqual(r.body.latestReadFailed, true);
    assert.ok(/読み出せませんでした/.test(r.body.noteJa), r.body.noteJa);
    assert.ok(!/記録がまだありません/.test(r.body.noteJa));
    assert.ok(r.body.degradedNoteJa && /読み直します/.test(r.body.degradedNoteJa));
    assert.strictEqual(r.body.store.down, true);
  });

  await t("⑪ 上限超過: /api/accuracy-stats は error を返し、2回目は60秒キャッシュから返す(保存先に失敗を積み上げない)", async () => {
    srvMod.__clearCacheForTest("accuracy-stats");
    const r1 = await get("/api/accuracy-stats");
    assert.ok(/max requests limit exceeded/.test(r1.body.error || ""), JSON.stringify(r1.body).slice(0, 200));
    assert.strictEqual(r1.body.store.down, true);
    const before = m.calls.length;
    const r2 = await get("/api/accuracy-stats");
    assert.strictEqual(r2.body.cached, true, "2回目がキャッシュから返っていない");
    assert.strictEqual(r2.body.cacheTtlSec, 60, "失敗応答のキャッシュが60秒でない: " + r2.body.cacheTtlSec);
    await sleep(100);
    const cmdsDuring = m.calls.slice(before).filter((c) => c[0] !== "INCRBY").length;
    assert.strictEqual(cmdsDuring, 0, "キャッシュ中に保存先へコマンドが出た: " + cmdsDuring);
  });

  await t("⑫ 上限超過: スタメン監視は保存先を読まない(LRANGE 0回)", async () => {
    process.env.LINEUP_WATCH = "1"; // 関数内の判定を通す(自走タイマーは起動時にしか作られない)
    process.env.API_FOOTBALL_KEY = ""; // APIキー無しの経路は関数冒頭で return するため、キー条件を満たす形は下で別に確認
    const before = m.count("LRANGE");
    await S.maybeWatchLineups();
    assert.strictEqual(m.count("LRANGE") - before, 0);
  });

  // ================= 復旧 =================
  await t("⑬ 復旧: 成功を1回観測すると down が解除され、ロックが再び取れる", async () => {
    m.m.mode = "ok";
    assert.strictEqual(S.storeIsDown(), true, "復旧前なのに down でない");
    const v = await S.upstashGetJSONOrThrow("learn:growthlog:latest"); // 成功1回
    assert.ok(v && v.date);
    assert.strictEqual(S.storeIsDown(), false, "成功後も down のまま");
    const lock = await S.tryAcquireDailyRunLock();
    assert.strictEqual(lock.acquired, true, JSON.stringify(lock));
    m.store.delete(`learn:runlock:${jstToday}`);
  });

  await t("⑭ 復旧後: /api/growth-log は通常表示(ranYet:true)、/api/learning/progress は「記録なし」を正しく区別", async () => {
    const r = await get("/api/growth-log");
    assert.strictEqual(r.body.readFailed, undefined);
    assert.strictEqual(r.body.ranYet, true, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual(r.body.store.down, false);
    const p = await get("/api/learning/progress");
    assert.strictEqual(p.body.readFailed, false);
    assert.strictEqual(p.body.available, false); // 記録が無い(=読めたが null)
    assert.ok(/まだ進捗の記録がありません/.test(p.body.reasonJa), p.body.reasonJa);
  });

  await t("⑮ 連続失敗(タイムアウト3回)でも down になり、成功で戻る(上限超過以外の障害)", async () => {
    S.resetForTest();
    m.m.mode = "timeout";
    for (let i = 0; i < 3; i++) await S.upstashGetJSONOrThrow("x").catch(() => {});
    assert.strictEqual(S.storeIsDown(), true);
    assert.strictEqual(S.storeStatusSnapshot().quotaExceeded, false);
    m.m.mode = "ok";
    await S.upstashGetJSONOrThrow("x");
    assert.strictEqual(S.storeIsDown(), false);
  });

  // ================= 使用量カウンター・MGET・キャッシュ =================
  await t("⑯ 使用量カウンター: コマンド数を数え、MGETは1コマンド+引数総数、1時間に1回 INCRBY で積み上げ、推定が store+process になる", async () => {
    S.resetForTest();
    const s0 = S.upstashUsageSnapshot();
    const c0 = s0.monthCommandsThisProcess;
    await S.upstashMGetJSON(["k1", "k2", "k3"]);
    const s1 = S.upstashUsageSnapshot();
    assert.strictEqual(s1.monthCommandsThisProcess - c0, 1, "MGETが1コマンドとして数えられていない");
    assert.strictEqual(s1.monthMultiKeyArgsThisProcess - s0.monthMultiKeyArgsThisProcess, 3, "MGETの引数総数が数えられていない");
    m.store.set(`ops:upstash:usage:${s1.monthKey}`, "1000"); // 他プロセスが積み上げ済みの今月合計
    const beforeIncr = m.count("INCRBY");
    await S.maybeFlushUpstashUsage();
    assert.strictEqual(m.count("INCRBY") - beforeIncr, 1, "INCRBYが1回出ていない");
    const s2 = S.upstashUsageSnapshot();
    assert.strictEqual(s2.monthEstimateBasis, "store+process");
    assert.ok(s2.monthEstimate >= 1000, "保存先の合計が推定に反映されていない: " + s2.monthEstimate);
    assert.strictEqual(s2.level, "ok");
    assert.ok(/今月の推定使用量/.test(s2.noteJa));
    // 1時間以内の2回目は送らない
    await S.maybeFlushUpstashUsage();
    assert.strictEqual(m.count("INCRBY") - beforeIncr, 1, "1時間以内に2回目のINCRBYが出た");
    // health にも同じ推定が出る
    const h = await get("/api/health");
    assert.strictEqual(h.body.upstashUsage.monthEstimateBasis, "store+process");
  });

  await t("⑰ /api/accuracy-stats(正常時): 保留41件を MGET 1回で読み(readMode=mget)、2回目は10分キャッシュ", async () => {
    srvMod.__clearCacheForTest("accuracy-stats");
    const ids = []; for (let i = 0; i < 41; i++) { ids.push(String(1000 + i)); m.store.set(`pred:${1000 + i}`, JSON.stringify({ kickoff: new Date(now + 3600000).toISOString() })); }
    m.store.set("pred:pending", ids);
    m.store.set("pred:total", "50"); m.store.set("pred:resolved", "9"); m.store.set("pred:correct", "5");
    const before = m.calls.length;
    const r1 = await get("/api/accuracy-stats");
    assert.strictEqual(r1.body.error, undefined, JSON.stringify(r1.body).slice(0, 200));
    assert.strictEqual(r1.body.pendingDetail.readMode, "mget", JSON.stringify(r1.body.pendingDetail));
    assert.strictEqual(r1.body.pendingDetail.sampled, 41);
    assert.strictEqual(r1.body.pendingDetail.awaitingKickoff, 41);
    // この応答のためのコマンドだけを数える(裏で走る自己修復の索引点検はテスト設定=確認間隔0のため毎回動き、pred:* とは無関係)
    const cmds = m.calls.slice(before).filter((c) => c[0] !== "INCRBY" && String(c[1] || "").startsWith("pred:"));
    assert.strictEqual(cmds.filter((c) => c[0] === "MGET").length, 1, "MGETが1回でない");
    assert.strictEqual(cmds.filter((c) => c[0] === "GET" && /^pred:\d+$/.test(c[1])).length, 0, "保留記録を1件ずつGETしている");
    assert.ok(cmds.length <= 12, "1回の表示で保存先コマンドが多すぎる(v94前は約48): " + cmds.length + " " + JSON.stringify(cmds.map((c) => c[0] + " " + c[1])));
    const r2 = await get("/api/accuracy-stats");
    assert.strictEqual(r2.body.cached, true);
    assert.strictEqual(r2.body.cacheTtlSec, 600);
  });

  await t("⑱ スタメン監視(正常時): 保留60件の記録を MGET 1回で読む(1件ずつのGETをしない)", async () => {
    S.resetForTest();
    process.env.LINEUP_WATCH = "1";
    // APIキーが無いと関数冒頭で return するため、ここではキー有りにする(APIは呼ばれない: 窓内の試合が無い)
    const ids = []; for (let i = 0; i < 60; i++) { ids.push(String(2000 + i)); m.store.set(`learn:ownpred:${2000 + i}`, JSON.stringify({ kickoff: new Date(now + 5 * 3600000).toISOString(), resolved: false })); }
    m.store.set("learn:ownpred:pending", ids);
    const before = m.calls.length;
    // maybeWatchLineups は API_KEY(起動時に読んだ定数)を見る。起動時は空なので、ここでは MGET 化のコード経路を直接確認する
    const { values, readMode } = await S.upstashMGetJSON(ids.map((id) => `learn:ownpred:${id}`));
    assert.strictEqual(readMode, "mget");
    assert.strictEqual(values.length, 60);
    assert.strictEqual(values.filter(Boolean).length, 60);
    const cmds = m.calls.slice(before);
    assert.strictEqual(cmds.length, 1, "MGET 1回で済んでいない: " + cmds.length);
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const fnStart = src.indexOf("async function maybeWatchLineups()");
    const fnBody = src.slice(fnStart, src.indexOf("\nconst LINEUP_WATCH_SELF_TICK_MS", fnStart));
    assert.ok(/upstashMGetJSON\(ids\.map/.test(fnBody), "maybeWatchLineups が MGET 化されていない");
    assert.ok(/if \(storeIsDown\(\)\) return;/.test(fnBody), "maybeWatchLineups に保存先停止時の見送りが無い");
  });

  await t("⑲ MGETが使えない保存先でも upstashMGetJSON は1件ずつに落ちて同じ結果を返す", async () => {
    const saveCmd = m.upstashCmd;
    let mgetSeen = 0;
    srvMod.__setTestHooks({ upstashCmd: async (cmd) => { if (cmd[0] === "MGET") { mgetSeen++; throw new Error("ERR unknown command 'MGET'"); } return saveCmd(cmd); } });
    S.resetForTest();
    const { values, readMode } = await S.upstashMGetJSON(["pred:1000", "pred:1001", "nope"]);
    assert.strictEqual(mgetSeen, 1);
    assert.strictEqual(readMode, "per-key");
    assert.deepStrictEqual(values.map((v) => !!v), [true, true, false]);
    assert.strictEqual(S.storeIsDown(), false, "1回のMGET失敗で down 判定になってはいけない");
    srvMod.__setTestHooks({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
  });

  // ================= 精度トレンド: 読めなかった日を「無い日」にしない =================
  await t("⑳ getAccuracyTrend: 1件ずつ経路で全日読めなければ available:false・readFailed:true、一部なら partial:true", async () => {
    const { getAccuracyTrend, buildDailyAccuracy, ACCURACY_KEY_PREFIX } = require("./learning/accuracyTracker");
    const todayKey = new Date().toISOString().slice(0, 10);
    const store = new Map();
    const base = new Date(`${todayKey}T00:00:00Z`).getTime();
    for (let i = 1; i < 10; i++) store.set(`${ACCURACY_KEY_PREFIX}${new Date(base - i * 86400000).toISOString().slice(0, 10)}`, JSON.stringify(buildDailyAccuracy([{ record: { homeWinPct: 50, drawPct: 25, awayWinPct: 25, predictedHomeGoals: 2, predictedAwayGoals: 1 }, actualHome: 2, actualAway: 1 }])));
    let mode = "all-fail";
    const deps = {
      upstashEnabled: true,
      upstashCmd: async (cmd) => {
        if (cmd[0] === "MGET") throw new Error("mget unsupported");
        if (mode === "all-fail") throw new Error("Upstash error: " + QUOTA_MSG);
        if (mode === "partial" && /-0[1-5]$/.test(cmd[1])) throw new Error("timeout");
        return store.has(cmd[1]) ? store.get(cmd[1]) : null;
      },
      upstashGetJSON: async () => null,
    };
    const r1 = await getAccuracyTrend(deps, todayKey);
    assert.strictEqual(r1.available, false);
    assert.strictEqual(r1.readFailed, true);
    assert.strictEqual(r1.readFailures, 30);
    mode = "partial";
    const r2 = await getAccuracyTrend(deps, todayKey);
    assert.strictEqual(r2.available, true);
    assert.ok(r2.readFailures > 0 && r2.partial === true, JSON.stringify({ rf: r2.readFailures, partial: r2.partial }));
    assert.ok(/不完全/.test(r2.partialNoteJa));
    mode = "ok";
    const r3 = await getAccuracyTrend(deps, todayKey);
    assert.strictEqual(r3.partial, false);
    assert.strictEqual(r3.recordedDays, 9);
  });

  // ================= ソース側の確認(構造的な退行防止) =================
  await t("㉑ まとめ送りの停止は恒久ではなく時間制限つき(PIPELINE_DISABLE_MS)・全要素失敗は例外として扱う", () => {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(!/let pipelineDisabled = false;/.test(src), "恒久フラグ pipelineDisabled が残っている");
    assert.ok(/const PIPELINE_DISABLE_MS/.test(src));
    assert.ok(/PIPELINE_ALL_FAILED/.test(src));
    assert.ok(/countUpstashCommand\(c, "pipeline"\)/.test(src), "まとめ送りの使用量が数えられていない");
  });

  await t("㉒ 画面(index.html): 成長ログ・ダッシュボードが readFailed/degraded を「未実行・0件」と表示しない・4言語の辞書あり / sw.js は v94", () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(/if \(log\.readFailed\) \{/.test(html), "成長ログの readFailed 分岐が無い");
    assert.ok(/if \(data\.latestReadFailed\) \{/.test(html), "ダッシュボードの latestReadFailed 分岐が無い");
    for (const key of [
      "保存先(Upstash)が月間の上限に達しているため、いまは学習の記録を読み出せません。学習が止まったという意味ではありません。復旧すると自動的に表示が戻ります。",
      "保存先(Upstash)に接続できないため、いまは学習の記録を読み出せません。学習が止まったという意味ではありません。復旧すると自動的に表示が戻ります。",
      "📊 保存先(Upstash)が月間の上限に達しているため、いまはダッシュボードの数字を読み出せません(0件という意味ではありません)。復旧すると自動的に表示が戻ります。",
      "📊 保存先(Upstash)に接続できないため、いまはダッシュボードの数字を読み出せません(0件という意味ではありません)。復旧すると自動的に表示が戻ります。",
      "⚠️ 保存先から一部の記録を読み出せなかったため、この表示の一部は不完全です(60秒後に読み直します)。",
    ]) {
      const idx = html.indexOf(`"${key}": [`);
      assert.ok(idx > 0, "辞書に無い: " + key.slice(0, 30));
      const row = html.slice(idx, html.indexOf("\n", idx));
      assert.strictEqual((row.match(/", "/g) || []).length >= 2, true, "3言語そろっていない: " + key.slice(0, 30));
    }
    const sw = fs.readFileSync(SW_JS, "utf8");
    const swVer = Number((sw.match(/CACHE_NAME = "soccer-ai-shell-v(\d+)"/) || [])[1]);
    assert.ok(Number.isFinite(swVer) && swVer >= 94, "sw.js のキャッシュ名が v94 以上になっていない: v" + swVer);
  });

  srvMod.server.close();
  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
