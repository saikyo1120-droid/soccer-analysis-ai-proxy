/**
 * ホーム画面の「昨日学んだこと」ウィジェットのE2Eチェック。実際にローカルの
 * server.js(+モックUpstash/API-Football)を立ち上げ、/api/learning/run-daily を
 * 一度実行してから、ブラウザで実際にホーム画面がその本物の結果を表示するかを
 * 確認する。技術はpw_discuss_mode_check.jsと同じ(page.route()でproduction URLを
 * ローカルサーバーへリダイレクト)。
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
    // 最初に呼ばれるクラブ(バイエルン)だけ、直近5試合絶好調・前5試合不調にして
    // 「事実」が確実に1件生成されるようにする。
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

  // 学習エンジンを事前に1回実行し、本物のgrowth-logデータを作っておく。
  // 2026年8月・優先順位①で日次学習エンドポイントをfire-and-forget化した(GitHub
  // Actionsのクライアントタイムアウトと実処理時間のミスマッチが根本原因だった
  // exit code 28対策)ため、通常呼び出しは即座に{ok:true, started:true}を返す
  // だけになった。このテストの事前準備ではfactsAddedToday等の結果をこの場で
  // 使って検証したいので、デバッグ用に残してある?sync=1(旧来の同期動作)を使う。
  const runResult = await apiReq(apiPort, "POST", "/api/learning/run-daily?sync=1");
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };
  ok(runResult.status === 200 && runResult.json.ok === true, "事前準備: run-dailyが正常に実行できる");
  ok(runResult.json.factsAddedToday >= 1, "事前準備: バイエルンのフォーム変化が事実として記録される, got " + runResult.json.factsAddedToday);

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
  // 2026年8月・第7次監査での表示修正に追随:
  //   同じ実行を「昨日学んだこと」と呼びながら、2行下で「今日追加した知識」と
  //   書いており、どちらかが必ず間違っている状態だった。表現を統一した。
  ok(summaryText.includes("直近の学習で分かったこと"), "サマリーに学習結果の見出しが表示される, got: " + summaryText);
  ok(/この日に追加した知識: 1件/.test(summaryText), "実際に記録された追加知識の件数が表示される, got: " + summaryText);

  await page.click("#growthLogToggleBtn");
  await page.waitForTimeout(200);
  const detailsText = await page.evaluate(() => document.getElementById("growthLogDetails").innerText);
  ok(detailsText.includes("バイエルン・ミュンヘン"), "詳細に実際のクラブ名を含む事実の文章が表示される, got: " + detailsText);
  ok(detailsText.includes("自社予測モデル") && detailsText.includes("AI予測の実績"), "既存の「AI予測の実績」ウィジェットとは別物であることが明示されている");

  const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  ok(realErrors.length === 0, "実データでの描画時にJSエラーが出ない, got: " + JSON.stringify(realErrors));

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nGrowth-log widget E2E PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
