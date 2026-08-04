/**
 * Confirms the honest degradation path for POST /api/discuss when
 * ANTHROPIC_API_KEY is not configured: the RAG/Planner pipeline still runs
 * (facts/stats/confidence are all computed), but instead of crashing or
 * fabricating an answer, the endpoint returns ok:false with a clear Japanese
 * message explaining the LLM key is missing — the same honesty pattern this
 * project uses for a missing API_FOOTBALL_KEY / unconfigured Upstash.
 *
 * Deliberately a separate process from server_discuss_test.js: the Anthropic
 * provider reads ANTHROPIC_API_KEY into a module-level const at require time,
 * so it can't be toggled within a single already-running process.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
// ANTHROPIC_API_KEY intentionally left unset.

global.fetch = async (urlArg) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "api.anthropic.com") {
    throw new Error("this test should never actually reach the Anthropic API (no key configured)");
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

  const r = await post(port, "/api/discuss", { question: "なぜ4-3-3が主流なの？" });
  console.log(JSON.stringify(r.json, null, 2));
  ok(r.status === 200, "still returns HTTP 200 (not a server error)");
  ok(r.json.ok === false, "ok:false when no LLM key is configured");
  ok(r.json.reason === "NO_KEY", "reason code is NO_KEY, got " + r.json.reason);
  ok(typeof r.json.message === "string" && r.json.message.includes("APIキー"), "message honestly explains the missing key");

  server.close();
  console.log(failures === 0 ? "\nDiscuss no-LLM-key honesty check PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
