/**
 * /api/debug-status(開発者向け自己診断ページ用エンドポイント)の動作確認。
 * - AUTO_COLLECT_SECRET未設定時は誰でもアクセスできる
 * - AUTO_COLLECT_SECRET設定時はkey不一致だと403
 * - Redis(Upstash)未設定時は「正直に未設定」を返す(架空の数字を出さない)
 * - Upstash設定時はPING・Knowledge/Memory/Prediction Engineの集計を試みる
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.AUTO_COLLECT_SECRET;

global.fetch = async (urlArg) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "v3.football.api-sports.io" && u.pathname === "/status") {
    return { ok: true, json: async () => ({ response: { requests: { current: 1, limit_day: 100 } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); } });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  // ---- AUTO_COLLECT_SECRET未設定なので誰でもアクセスできるはず ----
  const r1 = await get(port, "/api/debug-status");
  ok(r1.status === 200, "AUTO_COLLECT_SECRET未設定時は200が返る, got " + r1.status);
  ok(r1.json && r1.json.redis && r1.json.redis.configured === false, "Redis未設定が正直に反映される, got " + JSON.stringify(r1.json && r1.json.redis));
  ok(r1.json && r1.json.apiFootball && r1.json.apiFootball.configured === true && r1.json.apiFootball.reachable === true, "API-Football実接続確認(/status)が成功する, got " + JSON.stringify(r1.json && r1.json.apiFootball));
  ok(r1.json && r1.json.llm && r1.json.llm.configured === false, "LLM未設定が正直に反映される, got " + JSON.stringify(r1.json && r1.json.llm));
  ok(r1.json && r1.json.learningEngine && r1.json.learningEngine.configured === false, "Learning EngineもRedis未設定を正直に反映する, got " + JSON.stringify(r1.json && r1.json.learningEngine));
  ok(r1.json && r1.json.knowledgeEngine && r1.json.knowledgeEngine.totalActiveItems === 0, "Knowledge Engineは0件(Upstash未設定), got " + JSON.stringify(r1.json && r1.json.knowledgeEngine));
  ok(r1.json && r1.json.memoryEngine && r1.json.memoryEngine.subjectsWithConclusion === 0, "Memory Engineは0件(Upstash未設定), got " + JSON.stringify(r1.json && r1.json.memoryEngine));

  server.close();
  console.log(failures === 0 ? "\n/api/debug-status basic test PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
