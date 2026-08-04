/**
 * 2026年8月・優先順位⑦(選手情報を毎日更新)のE2Eチェック。
 *
 * ご要望の中心は「更新できなかった項目は理由を残してください」なので、
 * 実際のブラウザ上で、
 *   - 更新できた選手データが表示されること
 *   - 更新できなかった項目(利き足・市場価値・契約)の理由が開示されること
 *   - APIリクエストの使用量が表示されること
 * を、本物のserver.js(+モックAPI-Football/Upstash)を通して確認する。
 */
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.PORT = "0";
process.env.PLAYER_UPDATE_CAP = "3";

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
  if (u.pathname === "/teams") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541, name: u.searchParams.get("search") } }] }) };
  }
  // ---- 優先順位⑦: 選手関連 ----
  if (u.pathname === "/players" && u.searchParams.get("search")) {
    // 選手IDの解決(名前検索)
    return { ok: true, json: async () => ({ errors: [], response: [{ player: { id: 4242 }, statistics: [] }] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id")) {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 4242, name: "Mock Player", age: 27, height: "184 cm", nationality: "Argentina", injured: false },
      statistics: [{
        team: { id: 9001, name: "Mock United" },
        games: { position: "Attacker", appearences: 21, minutes: 1800, rating: "7.62" },
        goals: { total: 15, assists: 9 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {},
      }],
    }] }) };
  }
  if (u.pathname === "/transfers") {
    return { ok: true, json: async () => ({ errors: [], response: [{ transfers: [
      { date: "2024-07-01", type: "€50M", teams: { out: { name: "Old Town FC" }, in: { name: "Mock United" } } },
    ] }] }) };
  }
  if (u.pathname === "/injuries") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("last")) {
    const teamId = Number(u.searchParams.get("team"));
    const now = Date.now();
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push({
        fixture: { id: 500 + i, date: new Date(now - i * 86400e3).toISOString() },
        teams: { home: { id: teamId }, away: { id: 7 } },
        goals: { home: i < 7 ? 2 : 0, away: i < 7 ? 0 : 1 },
      });
    }
    return { ok: true, json: async () => ({ errors: [], response: list }) };
  }
  if (u.pathname === "/fixtures") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  // ---- 優先順位⑥: リーグ関連(このテストでは中身は問わない) ----
  if (u.pathname === "/leagues" || u.pathname === "/standings" || u.pathname === "/players/topscorers" || u.pathname === "/players/topassists") {
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
  ok(runResult.json.playersCheckedToday === 3, "PLAYER_UPDATE_CAP=3のとおり3名が確認される, got " + runResult.json.playersCheckedToday);
  ok(runResult.json.playersUpdatedToday === 3, "3名とも更新できる, got " + runResult.json.playersUpdatedToday);
  ok(runResult.json.playerFactsAddedToday === 3, "3名ぶんの事実が新規保存される, got " + runResult.json.playerFactsAddedToday);
  ok(runResult.json.playerFieldsPermanentlyUnavailable === 9, "3名×3項目(利き足/市場価値/契約)が恒久的に取得不可, got " + runResult.json.playerFieldsPermanentlyUnavailable);
  ok(runResult.json.playerFieldsUpdatedToday === 39, "3名×13項目が更新できる, got " + runResult.json.playerFieldsUpdatedToday);

  const reasons = runResult.json.playerUnavailableReasonsToday || [];
  ok(reasons.length >= 9, "「更新できなかった理由」が9件以上残る, got " + reasons.length);
  ok(reasons.every((r) => r.reason && r.reason.length > 20), "すべての理由に十分な説明文がある");
  ok(reasons.some((r) => r.fieldJa === "利き足" && r.permanent === true), "利き足が恒久的に取得不可として記録される");
  ok(reasons.some((r) => r.fieldJa === "市場価値" && r.permanent === true), "市場価値が恒久的に取得不可として記録される");
  ok(reasons.some((r) => r.fieldJa === "契約" && r.permanent === true), "契約が恒久的に取得不可として記録される");

  const budget = runResult.json.apiBudget;
  ok(budget && budget.dailyBudget === 100, "APIリクエスト予算(既定100)が記録される, got " + JSON.stringify(budget));
  ok(budget && budget.totalSpent > 0, "実際に使ったリクエスト数が記録される, got " + (budget && budget.totalSpent));

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
  ok(/\+3選手を分析/.test(summaryText), "サマリーに「+3選手を分析」が表示される, got: " + summaryText);

  await page.click("#growthLogToggleBtn");
  await page.waitForTimeout(200);

  const visibleText = await page.evaluate(() => document.getElementById("growthLogDetails").innerText);
  ok(visibleText.includes("選手情報の日次更新"), "詳細に「選手情報の日次更新」セクションが表示される");
  ok(visibleText.includes("本日3名をローテーションで確認"), "確認した人数が表示される, got: " + visibleText.slice(0, 300));
  ok(visibleText.includes("Mock Player") || visibleText.includes("年齢:27歳"), "実際に取得した選手データの内容が表示される");
  ok(visibleText.includes("本日のAPIリクエスト使用量"), "APIリクエスト使用量が表示される");

  // <details>は折りたたまれているため、innerTextではなくtextContentで中身を検証する
  const allText = await page.evaluate(() => document.getElementById("growthLogDetails").textContent);
  ok(allText.includes("現在のデータソースでは更新できない項目"), "更新できない項目の開示セクションがある");
  ok(allText.includes("利き足"), "利き足が開示対象に含まれる");
  ok(allText.includes("市場価値"), "市場価値が開示対象に含まれる");
  ok(allText.includes("契約"), "契約が開示対象に含まれる");
  ok(allText.includes("Transfermarkt"), "代替データソース(Transfermarkt)まで理由に含まれる");
  ok(allText.includes("優先順位⑪"), "今後どう解決する予定かまで理由に含まれる");

  // 実際に<details>を開いても壊れないことを確認する
  const detailsCount = await page.evaluate(() => {
    const els = document.querySelectorAll("#growthLogDetails details");
    els.forEach((d) => { d.open = true; });
    return els.length;
  });
  ok(detailsCount >= 1, "開閉できる開示セクションが存在する, got " + detailsCount);
  await page.waitForTimeout(100);
  const openedText = await page.evaluate(() => document.getElementById("growthLogDetails").innerText);
  ok(openedText.includes("利き足"), "開示セクションを開くと利き足の理由が実際に読める");

  const realErrors = errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  ok(realErrors.length === 0, "実データでの描画時にJSエラーが出ない, got: " + JSON.stringify(realErrors));

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nPlayer-daily-update (優先順位⑦) widget E2E PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
