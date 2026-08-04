/**
 * Confirms the MAX_LLM_CALLS_PER_DAY safety cap on POST /api/discuss: since
 * every discussion-mode call now costs real money (a real LLM API call), the
 * server must refuse further calls once the daily budget is exhausted rather
 * than letting costs run unbounded. Sets a tiny limit (2) via env so the test
 * doesn't need 50+ requests to exercise it.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.MAX_LLM_CALLS_PER_DAY = "2";
process.env.PORT = "0";

let anthropicCallCount = 0;
global.fetch = async (urlArg) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "api.anthropic.com") {
    anthropicCallCount++;
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "###根拠###\nx\n###考察###\ny\n###結論###\nz\n###フォローアップ###\nq1" }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function post(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  const q = { question: "なぜ4-3-3が主流なの？" };
  const r1 = await post(port, "/api/discuss", q);
  const r2 = await post(port, "/api/discuss", q);
  const r3 = await post(port, "/api/discuss", q);

  ok(r1.json.ok === true, "call 1 (within budget) succeeds");
  ok(r2.json.ok === true, "call 2 (within budget) succeeds");
  ok(r3.json.ok === false && r3.json.reason === "llm_budget_exceeded_global", "call 3 (over the site-wide budget) is refused, got " + JSON.stringify(r3.json));
  ok(anthropicCallCount === 2, "the LLM was only actually called twice (budget check happens BEFORE the paid call), got " + anthropicCallCount);

  server.close();
  console.log(failures === 0 ? "\nDiscuss daily-budget cap PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
