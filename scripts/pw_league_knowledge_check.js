/**
 * 2026年8月・優先順位⑥(主要リーグのKnowledge Engine日次蓄積)のE2Eチェック。
 * pw_growth_log_check.jsは/standings等をモックしていないため「今日は変化なし」
 * の空振りパスしか検証できていなかった。このテストでは/standings・
 * /players/topscorers・/players/topassists・/leagues(拡張リーグのID解決)を
 * 実データに近い形でモックし、実際にホーム画面の「昨日学んだこと」ウィジェットに
 * 本物のリーグ順位表・ランキングの事実が表示されるところまでを確認する。
 */
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.PORT = "0";

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

// 拡張リーグ(ID未確定分)を/leagues検索で解決した想定のダミーID。
const RESOLVED_EXTENDED_IDS = { Brazil: 71, England: 40, Portugal: 94, Turkey: 203 };
const KNOWN_LEAGUE_IDS = new Set([39, 140, 78, 135, 61, 253, 71, 40, 94, 203]);

function standingsFor(leagueId) {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({ rank: i, team: { name: `League${leagueId}Team${i}` }, points: (21 - i) * 3, all: { played: 22 }, form: "WWDLW" });
  }
  return { errors: [], response: [{ league: { standings: [rows] } }] };
}
function topScorersFor(leagueId) {
  return { errors: [], response: [
    { player: { name: `League${leagueId}TopScorer` }, statistics: [{ team: { name: `League${leagueId}Team1` }, goals: { total: 25, assists: 4 } }] },
  ] };
}
function topAssistsFor(leagueId) {
  return { errors: [], response: [
    { player: { name: `League${leagueId}TopAssister` }, statistics: [{ team: { name: `League${leagueId}Team2` }, goals: { total: 5, assists: 18 } }] },
  ] };
}

const realFetch = global.fetch;
let fixturesCallCount = 0;
global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(urlArg, opts);
  if (u.hostname === "fake-upstash.example.com") {
    const cmd = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
  }
  if (u.pathname === "/teams") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541, name: u.searchParams.get("search") } }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("last")) {
    fixturesCallCount++;
    const now = Date.now();
    if (fixturesCallCount === 1) {
      const list = [];
      for (let i = 0; i < 5; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: 541 }, away: { id: 2 } }, goals: { home: 4, away: 0 } });
      for (let i = 5; i < 10; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: 541 }, away: { id: 2 } }, goals: { home: 0, away: 3 } });
      return { ok: true, json: async () => ({ errors: [], response: list }) };
    }
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("next")) {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  // ---- 優先順位⑥: リーグ関連のエンドポイント ----
  if (u.pathname === "/leagues") {
    const country = u.searchParams.get("country");
    const id = RESOLVED_EXTENDED_IDS[country];
    if (id) return { ok: true, json: async () => ({ errors: [], response: [{ league: { id, name: u.searchParams.get("name") } }] }) };
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/standings") {
    const leagueId = Number(u.searchParams.get("league"));
    if (KNOWN_LEAGUE_IDS.has(leagueId)) return { ok: true, json: async () => standingsFor(leagueId) };
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/players/topscorers") {
    const leagueId = Number(u.searchParams.get("league"));
    if (KNOWN_LEAGUE_IDS.has(leagueId)) return { ok: true, json: async () => topScorersFor(leagueId) };
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/players/topassists") {
    const leagueId = Number(u.searchParams.get("league"));
    if (KNOWN_LEAGUE_IDS.has(leagueId)) return { ok: true, json: async () => topAssistsFor(leagueId) };
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
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

  const runResult = await apiReq(apiPort, "POST", "/api/learning/run-daily?sync=1");
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  ok(runResult.status === 200 && runResult.json.ok === true, "事前準備: run-dailyが正常に実行できる");
  ok(runResult.json.mandatoryLeaguesAnalyzedToday === 5, "必須5リーグがすべて処理される, got " + runResult.json.mandatoryLeaguesAnalyzedToday);
  ok(runResult.json.extendedLeaguesAnalyzedToday === 2, "拡張リーグはローテーションで2件処理される, got " + runResult.json.extendedLeaguesAnalyzedToday);
  ok(runResult.json.leaguesAnalyzedToday === 7, "合計7リーグが処理される(必須5+拡張2), got " + runResult.json.leaguesAnalyzedToday);
  ok(runResult.json.leagueFactsAddedToday === 21, "7リーグ×3種類(順位表/得点/アシスト)=21件の事実が新規保存される, got " + runResult.json.leagueFactsAddedToday);
  ok(Array.isArray(runResult.json.leagueFactsToday) && runResult.json.leagueFactsToday.length === 21, "leagueFactsTodayに21件の内訳が入る, got " + (runResult.json.leagueFactsToday || []).length);
  const leagueErrors = (runResult.json.errors || []).filter((e) => e.startsWith("league_"));
  ok(leagueErrors.length === 0, "リーグ関連の取得でエラーが出ない(モックが正しく効いている), got: " + JSON.stringify(leagueErrors));

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/growth-log", async (route) => {
    const resp = await fetch(`http://127.0.0.1:${apiPort}/api/growth-log`);
    const bodyText = await resp.text();
    await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
  });

  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
  await page.waitForSelector("#growthLogCard", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(800);

  const summaryText = await page.evaluate(() => document.getElementById("growthLogSummary").innerText);
  ok(/登録11クラブ\+7リーグ\+\d+選手を分析/.test(summaryText), "サマリーに「+7リーグ」が表示される, got: " + summaryText);

  await page.click("#growthLogToggleBtn");
  await page.waitForTimeout(200);
  const detailsText = await page.evaluate(() => document.getElementById("growthLogDetails").innerText);
  ok(detailsText.includes("主要リーグの日次分析"), "詳細に「主要リーグの日次分析」セクションが表示される, got先頭200文字: " + detailsText.slice(0, 200));
  ok(detailsText.includes("プレミアリーグ(イングランド)の現在の順位表"), "実際のプレミアリーグ順位表の文章が表示される, got: " + detailsText.slice(0, 2000));
  ok(detailsText.includes("League39TopScorer"), "得点ランキングの実データ(選手名)が表示される, got: " + detailsText.slice(0, 2000));
  ok(detailsText.includes("League39TopAssister"), "アシストランキングの実データ(選手名)が表示される, got: " + detailsText.slice(0, 2000));
  ok(!detailsText.includes("新しい事実の追加はありませんでした"), "リーグに変化があった日には「変化なし」フォールバック文が表示されないはず");

  const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  ok(realErrors.length === 0, "実データでの描画時にJSエラーが出ない, got: " + JSON.stringify(realErrors));

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nLeague-knowledge (優先順位⑥) widget E2E PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
