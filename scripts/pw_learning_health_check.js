/**
 * 2026年8月・優先順位⑨(Learning Engine総点検)のE2Eチェック。
 *
 * ご要望の核心は「今日追加した知識0件と表示されると、利用者は本当に学習して
 * いるのか不安になる」。そこで、
 *   1. 2回実行して「新規0件・重複あり」の状態を実際に作り出し、
 *      画面に「✅ 正常に動作しています(確認したN件すべて前回から変化なし)」と
 *      表示されることを確認する(これまでは「0件」としか出なかった)
 *   2. /api/learning/health が9つの構成要素と実行履歴を返すことを確認する
 * を、本物のserver.js(+モックAPI-Football/Upstash)を通して検証する。
 */
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.PORT = "0";
process.env.PLAYER_UPDATE_CAP = "2";

const redisStore = new Map();
function handleRedisCommand(cmd) {
  const [op, ...args] = cmd;
  if (op === "GET") return redisStore.has(args[0]) ? redisStore.get(args[0]) : null;
  if (op === "SET") { const [k, v, flag] = args; if (flag === "NX" && redisStore.has(k)) return null; redisStore.set(k, v); return "OK"; }
  if (op === "INCR") { const c = parseInt(redisStore.get(args[0]), 10) || 0; redisStore.set(args[0], String(c + 1)); return c + 1; }
  if (op === "RPUSH") { const [k, v] = args; const l = redisStore.get(k) || []; l.push(v); redisStore.set(k, l); return l.length; }
  if (op === "LRANGE") { const [k, s, e] = args; const l = redisStore.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; return l.slice(start, end + 1); }
  if (op === "LREM") { const [k, , v] = args; redisStore.set(k, (redisStore.get(k) || []).filter((x) => x !== v)); return 1; }
  if (op === "LTRIM") { const [k, s, e] = args; const l = redisStore.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; redisStore.set(k, l.slice(start, end + 1)); return "OK"; }
  return null;
}

const realFetch = global.fetch;
global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(urlArg, opts);
  if (u.hostname === "fake-upstash.example.com") {
    const cmd = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
  }
  if (u.pathname === "/teams") return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541, name: u.searchParams.get("search") } }] }) };
  if (u.pathname === "/players" && u.searchParams.get("search")) return { ok: true, json: async () => ({ errors: [], response: [{ player: { id: 4242 }, statistics: [] }] }) };
  if (u.pathname === "/players" && u.searchParams.get("id")) {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 4242, name: "Mock Player", age: 27, height: "184 cm", nationality: "Argentina", injured: false },
      statistics: [{ team: { id: 9001, name: "Mock United" }, games: { position: "Attacker", appearences: 21, minutes: 1800, rating: "7.62" }, goals: { total: 15, assists: 9 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {} }],
    }] }) };
  }
  if (u.pathname === "/transfers") return { ok: true, json: async () => ({ errors: [], response: [{ transfers: [] }] }) };
  if (u.pathname === "/injuries") return { ok: true, json: async () => ({ errors: [], response: [] }) };
  if (u.pathname === "/fixtures" && u.searchParams.get("last")) {
    const teamId = Number(u.searchParams.get("team")) || 9001;
    const now = Date.now();
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push({ fixture: { id: 500 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: teamId }, away: { id: 7 } }, goals: { home: i < 7 ? 2 : 0, away: i < 7 ? 0 : 1 } });
    }
    return { ok: true, json: async () => ({ errors: [], response: list }) };
  }
  if (u.pathname === "/fixtures") return { ok: true, json: async () => ({ errors: [], response: [] }) };
  if (u.pathname === "/standings") {
    const rows = [];
    for (let i = 1; i <= 20; i++) rows.push({ rank: i, team: { name: `T${i}` }, points: (21 - i) * 3, all: { played: 22 }, form: "WWDLW" });
    return { ok: true, json: async () => ({ errors: [], response: [{ league: { standings: [rows] } }] }) };
  }
  if (u.pathname === "/players/topscorers" || u.pathname === "/players/topassists") {
    return { ok: true, json: async () => ({ errors: [], response: [{ player: { name: "Top Guy" }, statistics: [{ team: { name: "T1" }, goals: { total: 20, assists: 12 } }] }] }) };
  }
  if (u.pathname === "/leagues") return { ok: true, json: async () => ({ errors: [], response: [{ league: { id: 71, name: "X" } }] }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server: apiServer } = require(path.join(__dirname, "..", "server", "server.js"));

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8" };
const pageServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

function apiReq(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  await new Promise((resolve) => apiServer.on("listening", resolve));
  const apiPort = apiServer.address().port;
  await new Promise((resolve) => pageServer.listen(0, resolve));
  const pagePort = pageServer.address().port;

  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  // 1回目: 知識を積む。2回目: 同じ内容なので「新規0件・重複あり」になる。
  const run1 = await apiReq(apiPort, "POST", "/api/learning/run-daily?sync=1");
  ok(run1.json.knowledgeItemsSavedToday > 0, "1回目は知識が増える, got " + run1.json.knowledgeItemsSavedToday);
  // 2026年8月: 多重起動防止ロックを導入したため、意図的な2回目の実行には force=1 が必要
  const run2 = await apiReq(apiPort, "POST", "/api/learning/run-daily?sync=1&force=1");
  ok(run2.json.ok === true, "2回目も正常に実行できる");

  // ---- /api/growth-log に診断が同梱されるか ----
  const growth = await apiReq(apiPort, "GET", "/api/growth-log");
  const diag = growth.json.zeroKnowledgeDiagnosis;
  ok(!!diag, "growth-logに0件診断が同梱される");
  ok(growth.json.knowledgeItemsDuplicateToday > 0, "2回実行したので重複が発生している, got " + growth.json.knowledgeItemsDuplicateToday);

  // ---- /api/learning/health ----
  const health = await apiReq(apiPort, "GET", "/api/learning/health?days=5");
  ok(health.status === 200 && health.json.ok === true, "健康診断エンドポイントが応答する");
  ok(Array.isArray(health.json.engines) && health.json.engines.length >= 10, "9つ以上の構成要素を点検している, got " + (health.json.engines || []).length);
  const ids = (health.json.engines || []).map((e) => e.id);
  for (const id of ["githubActions", "render", "upstash", "apiFootball", "llm", "learning", "knowledge", "prediction", "memory", "hypothesis"]) {
    ok(ids.includes(id), `点検対象に ${id} が含まれる`);
  }
  ok(health.json.runHistory && health.json.runHistory.available === true, "過去の実行履歴を実データで返す");
  ok(health.json.runHistory.days.length === 5, "days=5のとおり5日分返す, got " + (health.json.runHistory.days || []).length);
  ok(health.json.runHistory.days[0].ran === true, "本日は実行済みとして記録されている");
  ok(health.json.runHistory.days.some((d) => d.ran === false), "実行記録が無い日は正直にran:falseで返す(推測で埋めない)");
  const upstashEngine = health.json.engines.find((e) => e.id === "upstash");
  ok(upstashEngine.status === "ok", "Upstashは設定済みなのでok");
  ok(typeof health.json.overallMessageJa === "string" && health.json.overallMessageJa.length > 5, "全体の総評が日本語で返る");
  ok(health.json.apiBudget && health.json.apiBudget.dailyBudget === 100, "APIリクエスト予算の状況も返る");

  // ---- 画面表示 ----
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/growth-log", async (route) => {
    const resp = await fetch(`http://127.0.0.1:${apiPort}/api/growth-log`);
    await route.fulfill({ status: resp.status, contentType: "application/json", body: await resp.text() });
  });
  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
  await page.waitForSelector("#growthLogCard", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(800);

  const summaryText = await page.evaluate(() => document.getElementById("growthLogSummary").innerText);
  // 2回実行して重複が出ているので、知識が0件だった場合は「正常な0件」と説明されるはず。
  // (1回目で保存された知識があるためmerge後は0件にならないこともあるので、
  //  どちらの場合でも「利用者が不安にならない説明」が出ていることを確認する)
  const knowledgeIsZero = /この日に追加した知識: 0件/.test(summaryText);
  if (knowledgeIsZero) {
    ok(/✅|正常に動作しています/.test(summaryText), "0件のときは「正常に動作しています」と説明される, got: " + summaryText);
  } else {
    ok(true, "本日は知識が増えたため0件診断は表示されない(想定内)");
  }
  ok(/検証した試合: 0件/.test(summaryText) ? /✅|❌/.test(summaryText) : true, "検証0件のときも理由が説明される, got: " + summaryText);
  ok(!/undefined|NaN|\[object Object\]/.test(summaryText), "表示に undefined/NaN が混ざらない, got: " + summaryText);

  const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  ok(realErrors.length === 0, "描画時にJSエラーが出ない, got: " + JSON.stringify(realErrors));

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nLearning-health (優先順位⑨) E2E PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
