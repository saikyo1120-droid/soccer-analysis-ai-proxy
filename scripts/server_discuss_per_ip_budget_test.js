/**
 * Confirms the new IP単位の1日あたり上限(PER_IP_LLM_CALLS_PER_DAY)on POST
 * /api/discuss: introduced so that a single visitor (or abusive traffic from one
 * source) cannot exhaust the site-wide daily LLM budget and lock everyone else
 * out, now that this is meant to be a public service for many simultaneous
 * users. Sets a tiny per-IP limit (2) via env, and a much larger site-wide
 * limit, so the test can isolate per-IP behavior. Also confirms a DIFFERENT
 * IP is unaffected by another IP's exhausted budget.
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.PER_IP_LLM_CALLS_PER_DAY = "2";
process.env.MAX_LLM_CALLS_PER_DAY = "1000"; // 十分大きくして、このテストではサイト全体の上限には触れないようにする
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

function post(port, urlPath, payload, forwardedFor) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
    if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST", headers }, (res) => {
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

  // ---- 同一IP(1.2.3.4)が上限(2回)を使い切る ----
  const r1 = await post(port, "/api/discuss", q, "1.2.3.4");
  const r2 = await post(port, "/api/discuss", q, "1.2.3.4");
  const r3 = await post(port, "/api/discuss", q, "1.2.3.4");

  ok(r1.json.ok === true, "IP1: 1回目(上限内)は成功する");
  ok(r2.json.ok === true, "IP1: 2回目(上限内)は成功する");
  ok(r3.json.ok === false && r3.json.reason === "llm_budget_exceeded_per_ip", "IP1: 3回目(上限超過)は拒否される, got " + JSON.stringify(r3.json));
  ok(/あなたがご利用いただける/.test(r3.json.message), "IP1: 拒否メッセージが「あなた」個人の上限であることを明示する, got " + r3.json.message);

  // ---- 別のIP(5.6.7.8)は、1.2.3.4が上限を使い切っていても影響を受けない ----
  const r4 = await post(port, "/api/discuss", q, "5.6.7.8");
  ok(r4.json.ok === true, "IP2(別の利用者)はIP1が上限に達していても問題なく利用できる, got " + JSON.stringify(r4.json));

  // ---- LLMが実際に呼ばれた回数 = 成功した回数(3件: IP1×2 + IP2×1)と一致するはず ----
  ok(anthropicCallCount === 3, "拒否されたリクエストではLLMは呼ばれていないはず(実費が発生しない), got " + anthropicCallCount);

  server.close();
  console.log(failures === 0 ? "\nPer-IP discuss budget PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
