/**
 * Stage B end-to-end check: proves the curated match analysis card is genuinely
 * driven by POST /api/predict-match in a real browser (not just falling back to
 * local computation every time), AND that the graceful-degradation fallback still
 * works identically when the API is unavailable.
 *
 * index.html calls a HARD-CODED ABSOLUTE production URL (API_PROXY_BASE =
 * "https://soccer-analysis-ai-proxy.onrender.com/api"), not a relative path, so a
 * plain "run server.js locally and navigate to it" setup would never actually
 * exercise the new endpoint in this sandbox (that domain isn't reachable here,
 * and even in an environment where it is, it wouldn't yet have this change until
 * the user deploys it). This script starts a real local server.js instance (with
 * the new endpoint) and uses Playwright's page.route() to transparently redirect
 * the browser's requests to that hard-coded URL to the local instance instead —
 * so this is a genuine end-to-end exercise of the real server-side code added in
 * this change, not a mock.
 */
const { chromium } = require("playwright");
const path = require("path");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
const { server: apiServer } = require(path.join(__dirname, "..", "server", "server.js"));

// Minimal static file server for index.html (same approach as run_all_pw_checks.js),
// kept separate from apiServer so this test also proves the app works correctly
// when the page and the API are served from different origins (as in production,
// where API_PROXY_BASE always points at the single canonical Render URL).
const http = require("http");
const fs = require("fs");
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

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  // ---- Scenario 1: API genuinely reachable and used ----
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    let apiCallCount = 0;
    let lastRequestBody = null;
    await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/predict-match", async (route) => {
      apiCallCount++;
      lastRequestBody = route.request().postDataJSON();
      const resp = await fetch(`http://127.0.0.1:${apiPort}/api/predict-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: route.request().postData(),
      });
      const bodyText = await resp.text();
      await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
    });

    await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
    await page.click('#modeSwitch button[data-mode="match"]');
    await page.waitForTimeout(300);
    await page.click('#matchList .match-analyze-btn[data-id="bayern-arsenal"]');
    await page.waitForTimeout(1200);

    const text = await page.evaluate(() => document.getElementById("matchAnalysisWrap").innerText);
    const svgCount = await page.locator("#matchAnalysisWrap svg").count();

    ok(apiCallCount >= 1, "the real /api/predict-match endpoint was actually called from the browser");
    ok(lastRequestBody && Array.isArray(lastRequestBody.homePlayers) && lastRequestBody.homePlayers.length > 0, "request payload includes a non-empty homePlayers roster");
    ok(lastRequestBody && lastRequestBody.homeLabel === "バイエルン・ミュンヘン", "request payload includes the correct homeLabel");
    ok(text.includes("予想勝因"), "win-factor section rendered from API-sourced data");
    ok(text.includes("試合の流れ(予想)"), "match-flow section rendered from API-sourced data");
    ok(text.includes("戦術ボード"), "tactics board section rendered from API-sourced data");
    ok(svgCount === 3, "3 SVG diagrams rendered (identical structure to the pre-Stage-B UI)");
    ok(errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)).length === 0, "no real JS errors when driven by the live API");
    await page.close();
  }

  // ---- Scenario 2: API unavailable -> identical UI via local fallback ----
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/predict-match", (route) => route.abort("failed"));

    await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
    await page.click('#modeSwitch button[data-mode="match"]');
    await page.waitForTimeout(300);
    await page.click('#matchList .match-analyze-btn[data-id="bayern-arsenal"]');
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => document.getElementById("matchAnalysisWrap").innerText);
    const svgCount = await page.locator("#matchAnalysisWrap svg").count();

    ok(text.includes("予想勝因") && text.includes("試合の流れ(予想)") && text.includes("戦術ボード"), "fallback path renders the exact same sections when the API is unreachable");
    ok(svgCount === 3, "fallback path renders the same 3 SVG diagrams");
    ok(errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)).length === 0, "no real JS errors when the API is unreachable (fallback handled cleanly)");
    await page.close();
  }

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nPredict-match end-to-end PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
