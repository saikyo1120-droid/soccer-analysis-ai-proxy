/**
 * 2026年8月・優先順位⑤(今日の試合検索)の実ブラウザでの動作確認。
 * 実際のserver.js(+モックAPI-Football)を起動し、ブラウザから
 * #fixtureSearchInputに日本語で入力するだけで、対応する試合に絞り込まれる
 * こと(クラブ名/リーグ名/国名)、および監督名検索(バックエンドの
 * /api/coach-search、デバウンス後に反映)で通常検索では出ない試合も
 * 追加されることを確認する。技術はpw_growth_log_check.jsと同じ。
 */
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

const realFetch = global.fetch;
global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(urlArg, opts);
  // 2026年8月・第7次監査での修正に追随:
  //   「本日の試合」の日付は、UTCではなく利用者のいる地域(既定=日本時間)の
  //   日付を使うようになった。UTC基準のままだと日本時間の0時〜9時に
  //   前日の試合が「本日の試合」として表示されていたため。
  const OFFSET_H = Number(process.env.APP_TIMEZONE_OFFSET_HOURS ?? 9);
  const today = new Date(Date.now() + OFFSET_H * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (u.pathname === "/fixtures" && u.searchParams.get("date") === today) {
    return { ok: true, json: async () => ({ errors: [], response: [
      { fixture: { id: 301, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Santiago Bernabéu" } }, league: { name: "La Liga", country: "Spain" }, teams: { home: { name: "Real Madrid", logo: "" }, away: { name: "Sevilla", logo: "" } }, goals: { home: null, away: null } },
      { fixture: { id: 302, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Etihad Stadium" } }, league: { name: "Premier League", country: "England" }, teams: { home: { name: "Manchester City", logo: "" }, away: { name: "Arsenal", logo: "" } }, goals: { home: null, away: null } },
      { fixture: { id: 303, date: new Date().toISOString(), status: { short: "NS" }, venue: { name: "Parc des Princes" } }, league: { name: "Ligue 1", country: "France" }, teams: { home: { name: "Paris Saint Germain", logo: "" }, away: { name: "Marseille", logo: "" } }, goals: { home: null, away: null } },
    ] }) };
  }
  if (u.pathname === "/coachs" && u.searchParams.get("search") === "galtier") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { name: "C. Galtier", photo: null, career: [{ team: { id: 85, name: "Paris Saint Germain" }, start: "2022-07-01", end: null }] },
    ] }) };
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

(async () => {
  await new Promise((resolve) => apiServer.on("listening", resolve));
  const apiPort = apiServer.address().port;
  await new Promise((resolve) => pageServer.listen(0, resolve));
  const pagePort = pageServer.address().port;

  let failures = 0;
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else { console.error("  [FAIL] " + msg); failures++; } };

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/fixtures/today", async (route) => {
    const resp = await fetch(`http://127.0.0.1:${apiPort}/api/fixtures/today`);
    const bodyText = await resp.text();
    await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
  });
  await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/coach-search**", async (route) => {
    const reqUrl = new URL(route.request().url());
    const resp = await fetch(`http://127.0.0.1:${apiPort}/api/coach-search${reqUrl.search}`);
    const bodyText = await resp.text();
    await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
  });

  await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
  await page.waitForSelector("#realFixturesCard", { state: "attached", timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("realFixturesList");
    return el && el.innerText.includes("Real Madrid");
  }, { timeout: 15000 });

  const rowCountBefore = await page.evaluate(() => document.querySelectorAll(".real-fixture-row").length);
  ok(rowCountBefore === 3, `検索前は3試合すべて表示されている, got ${rowCountBefore}`);

  // クラブ名を日本語(「レアル」)で検索 -> Real Madridの試合だけに絞り込まれる
  await page.fill("#fixtureSearchInput", "レアル");
  await page.waitForTimeout(300);
  const afterRealSearch = await page.evaluate(() => Array.from(document.querySelectorAll(".real-fixture-row .teams")).map((el) => el.textContent));
  ok(afterRealSearch.length === 1 && afterRealSearch[0].includes("Real Madrid"), `「レアル」検索でReal Madridの試合1件だけに絞り込まれる, got ${JSON.stringify(afterRealSearch)}`);

  // リーグ名を日本語(「プレミアリーグ」)で検索
  await page.fill("#fixtureSearchInput", "プレミアリーグ");
  await page.waitForTimeout(300);
  const afterLeagueSearch = await page.evaluate(() => Array.from(document.querySelectorAll(".real-fixture-row .teams")).map((el) => el.textContent));
  ok(afterLeagueSearch.length === 1 && afterLeagueSearch[0].includes("Manchester City"), `「プレミアリーグ」検索でManchester Cityの試合に絞り込まれる, got ${JSON.stringify(afterLeagueSearch)}`);

  // 監督名検索: 「ガルティエ」では通常のクラブ名/リーグ名一致は無いため、
  // デバウンス後の/api/coach-search結果でPSGの試合が追加表示されるはず。
  await page.fill("#fixtureSearchInput", "galtier");
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll(".real-fixture-row .teams"));
    return rows.some((el) => el.textContent.includes("Paris Saint Germain"));
  }, { timeout: 3000 }).catch(() => {});
  const afterCoachSearch = await page.evaluate(() => Array.from(document.querySelectorAll(".real-fixture-row .teams")).map((el) => el.textContent));
  ok(afterCoachSearch.some((t) => t.includes("Paris Saint Germain")), `監督名「galtier」検索でPSGの試合がデバウンス後に追加表示される, got ${JSON.stringify(afterCoachSearch)}`);
  const hintText = await page.evaluate(() => document.getElementById("fixtureSearchHint").textContent);
  ok(hintText.includes("監督"), `監督名でヒットした旨のヒント文言が表示される, got "${hintText}"`);

  // 検索窓を空にすると全件表示に戻る
  await page.fill("#fixtureSearchInput", "");
  await page.waitForTimeout(200);
  const rowCountAfterClear = await page.evaluate(() => document.querySelectorAll(".real-fixture-row").length);
  ok(rowCountAfterClear === 3, `検索窓を空にすると3試合すべてに戻る, got ${rowCountAfterClear}`);

  // 一致しない検索語では「見つかりませんでした」の正直なメッセージが出る(でっち上げない)
  await page.fill("#fixtureSearchInput", "存在しないクラブ名xyz");
  await page.waitForTimeout(700);
  const noMatchText = await page.evaluate(() => document.getElementById("realFixturesList").textContent);
  ok(noMatchText.includes("見つかりませんでした"), `一致しない検索では正直に「見つかりませんでした」と表示する, got "${noMatchText}"`);

  await browser.close();
  const realErrors = errors.filter((e) => !/Failed to load resource|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_|Load failed|Failed to fetch/.test(e));
  ok(realErrors.length === 0, `ページ読み込み・検索操作中にJSエラーが発生しない, got ${JSON.stringify(realErrors)}`);

  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nPlaywright fixture-search check PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
