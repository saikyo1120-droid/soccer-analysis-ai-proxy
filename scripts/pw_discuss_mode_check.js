/**
 * Stage C end-to-end check: proves the new discussion-mode UI (hero chat AND
 * per-player chat) is genuinely driven by POST /api/discuss in a real browser,
 * AND that the honest fallback (no fake "thinking") works when the API is
 * unavailable. Same technique as pw_predict_match_api_check.js: index.html's
 * API_PROXY_BASE is a hard-coded absolute production URL, so this starts a
 * real local server.js instance and uses Playwright's page.route() to
 * transparently redirect the browser's requests to it.
 */
const { chromium } = require("playwright");
const path = require("path");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.PORT = "0";

// server.js の buildDiscussPrompt が実際に指定するセクション見出し
// (一般論/AI独自の意見/反対意見/最終結論/今後どうなると思うか/最も重要だと考える
// 点/フォローアップ)に合わせる。以前はここが###根拠###/###考察###/###結論###と
// いう異なる見出しになっていたため、parseDiscussLlmOutputがどの見出しも
// 一つもマッチできず(parsedOk=false)、テキスト全体が生のままaiOpinionに
// 詰め込まれてfollowUpQuestionsが常に空配列になる、というモック側の不具合が
// あった(2026年8月・優先順位⑤の作業中に発見・修正)。
const MOCK_LLM_TEXT = [
  "###一般論###",
  "一般的には、直近の結果だけでチームの実力を判断するのは早計だと言われます。",
  "",
  "###AI独自の意見###",
  "確かにそう感じる方もいるかもしれません。ただ直近の結果を見る限り、極端に崩れているわけではなさそうです。私は守備陣の負傷者の多さが最大の原因だと考えます。",
  "",
  "###反対意見###",
  "一方で、負傷者だけでは説明できない戦術面の課題も指摘されています。",
  "",
  "###最終結論###",
  "しかし負傷者が戻れば、再び安定する可能性は十分にあります。",
  "",
  "###今後どうなると思うか###",
  "主力の復帰とともに、失点数は徐々に落ち着いていくと考えられます。",
  "",
  "###最も重要だと考える点###",
  "私は守備陣の負傷者の多さが最も重要だと考えます。",
  "",
  "###フォローアップ###",
  "あなたは最大の問題は守備だと思いますか？",
  "監督の采配についてはどう感じますか？",
].join("\n");

// Node's real fetch, preserved so the page.route() handlers below (which run in
// THIS process, not the browser) can still reach the local apiServer directly —
// otherwise the mock below would intercept those calls too and misroute them.
const realFetch = global.fetch;

global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
    return realFetch(urlArg, opts);
  }
  if (u.hostname === "api.anthropic.com") {
    return { ok: true, json: async () => ({ content: [{ type: "text", text: MOCK_LLM_TEXT }] }) };
  }
  if (u.pathname === "/teams") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541, name: u.searchParams.get("search") } }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("team")) {
    return { ok: true, json: async () => ({ errors: [], response: [
      { fixture: { id: 1, date: new Date(Date.now() - 3 * 86400e3).toISOString() }, league: { name: "League" }, teams: { home: { id: 541, name: "Home" }, away: { id: 2, name: "Opponent" } }, goals: { home: 2, away: 1 } },
    ] }) };
  }
  if (u.pathname === "/fixtures/lineups") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541 }, formation: "4-3-3", coach: { name: "Test Coach" } }] }) };
  }
  if (u.pathname === "/injuries") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/transfers") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server: apiServer } = require(path.join(__dirname, "..", "server", "server.js"));

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

  // ---- Scenario 1: hero chat, discussion API genuinely reachable ----
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    let discussCallCount = 0;
    let lastBody = null;
    await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/discuss", async (route) => {
      discussCallCount++;
      lastBody = route.request().postDataJSON();
      const resp = await fetch(`http://127.0.0.1:${apiPort}/api/discuss`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: route.request().postData(),
      });
      const bodyText = await resp.text();
      await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
    });

    await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
    await page.fill("#heroChatInput", "最近のレアル・マドリードは統率が取れていないから弱い気がする");
    // 2026年8月・優先順位⑥検証中に発覚した既存テストの不具合(製品コードのバグ
    // ではない): pendingメッセージはpushFn()/renderFn()で同期的にDOMへ書き込まれる
    // (runDiscussFlow参照)が、その直後に`await fetchDiscussApi()`へ処理が移るため、
    // 高速なローカル環境ではclick()の解決からpage.evaluate()を呼ぶまでの間に
    // モックのAPIラウンドトリップが完了し、pending状態を素通りしてしまうことが
    // ある(単発のevaluate()では捕捉できないタイミング依存のレース)。
    // MutationObserverをクリック前に仕込んでおけば、pending状態のDOM書き込みは
    // fetchのawaitで処理が中断する「前」に同期的に発生するため、後続のどんな
    // マクロタスク(ネットワーク応答)よりも先にマイクロタスクとして確実に観測できる。
    await page.evaluate(() => {
      window.__sawThinkingState = false;
      const target = document.getElementById("heroChatMessages");
      const observer = new MutationObserver(() => {
        if (target.innerText.includes("考えています")) window.__sawThinkingState = true;
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    });
    await page.click("#heroChatBtn");
    await page.waitForTimeout(50);
    const sawThinking = await page.evaluate(() => window.__sawThinkingState || document.getElementById("heroChatMessages").innerText.includes("考えています"));
    ok(sawThinking, "shows an honest 'thinking' state instead of an instant fake answer");
    await page.waitForTimeout(1200);
    const finalText = await page.evaluate(() => document.getElementById("heroChatMessages").innerText);
    const starsPresent = /★+☆*/.test(finalText);

    ok(discussCallCount >= 1, "the real /api/discuss endpoint was actually called from the browser");
    ok(lastBody && lastBody.subject && lastBody.subject.type === "club" && lastBody.subject.labelEn === "Real Madrid", "request correctly identifies the club subject with its English name, got " + JSON.stringify(lastBody && lastBody.subject));
    ok(finalText.includes("守備陣の負傷者"), "the real LLM-generated consideration is rendered");
    ok(finalText.includes("負傷者が戻れば"), "the real LLM-generated conclusion is rendered");
    ok(starsPresent, "a confidence star rating is rendered");
    ok(finalText.includes("根拠にした事実を見る"), "the collapsible facts section is rendered");
    const followupCount = await page.locator("#heroChatMessages .chat-followup-btn").count();
    ok(followupCount === 2, "2 follow-up question chips rendered, got " + followupCount);
    ok(errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)).length === 0, "no real JS errors when driven by the live discuss API");

    // clicking a follow-up chip (phrased "〜だと思いますか？") should itself trigger discussion mode again
    await page.click("#heroChatMessages .chat-followup-btn >> nth=0");
    await page.waitForTimeout(1200);
    ok(discussCallCount >= 2, "clicking a follow-up chip re-triggers the discuss API (conversation continues)");
    await page.close();
  }

  // ---- Scenario 2: hero chat, discuss API unavailable -> honest fallback (no fake reasoning) ----
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/discuss", (route) => route.abort("failed"));

    await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
    await page.fill("#heroChatInput", "レアル・マドリードは統率が取れていないと思う？");
    await page.click("#heroChatBtn");
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.getElementById("heroChatMessages").innerText);

    ok(text.includes("接続できません") || text.includes("⚠️"), "honestly reports that discussion mode is unavailable, rather than pretending to answer");
    ok(text.includes("参考") && text.includes("レアル"), "still shows the existing rule-based club summary as a labeled reference");
    ok(errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)).length === 0, "no real JS errors when the discuss API is unreachable");
    await page.close();
  }

  // ---- Scenario 3: per-player chat also supports discussion mode ----
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    let discussCallCount = 0;
    let lastBody = null;
    await page.route("https://soccer-analysis-ai-proxy.onrender.com/api/discuss", async (route) => {
      discussCallCount++;
      lastBody = route.request().postDataJSON();
      const resp = await fetch(`http://127.0.0.1:${apiPort}/api/discuss`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: route.request().postData(),
      });
      const bodyText = await resp.text();
      await route.fulfill({ status: resp.status, contentType: "application/json", body: bodyText });
    });

    await page.goto(`http://localhost:${pagePort}/`, { waitUntil: "load" });
    await page.click('#modeSwitch button[data-mode="player"]');
    await page.fill("#playerSearchInput", "メッシ");
    await page.click("#playerSearchBtn");
    await page.waitForTimeout(300);
    // the chat card lives inside the collapsible "もっと見る" section (same as pw_dialogue_partner_check.js)
    await page.click("#moreDetailsToggleBtn");
    await page.waitForTimeout(200);
    await page.fill("#chatInput", "メッシはもう衰えたと思う？");
    await page.click("#chatSendBtn");
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.getElementById("chatMessages").innerText);

    ok(discussCallCount >= 1, "per-player chat also calls the real /api/discuss endpoint");
    ok(lastBody && lastBody.subject && lastBody.subject.type === "player", "per-player chat sends subject.type=player, got " + JSON.stringify(lastBody && lastBody.subject));
    ok(text.includes("守備陣の負傷者"), "per-player discussion mode renders the LLM-generated consideration");
    ok(errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)).length === 0, "no real JS errors in per-player discussion mode");
    await page.close();
  }

  await browser.close();
  apiServer.close();
  pageServer.close();
  console.log(failures === 0 ? "\nDiscuss-mode UI end-to-end PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
