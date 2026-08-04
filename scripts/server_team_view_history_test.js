/**
 * GET /api/knowledge/team-view-history のテスト(2026年8月・知識拡張フェーズ:
 * Memory Engine強化 ―「AIは昨日何を考えていたか・今日何を考えているか・その
 * 理由」を実際に確認できるようにするための新エンドポイント)。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-viewhistory.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.PORT = "0";

const redisStore = new Map();
function handleRedisCommand(cmd) {
  const [op, ...args] = cmd;
  if (op === "GET") return redisStore.has(args[0]) ? redisStore.get(args[0]) : null;
  if (op === "SET") { redisStore.set(args[0], args[1]); return "OK"; }
  if (op === "RPUSH") { const [k, v] = args; const l = redisStore.get(k) || []; l.push(v); redisStore.set(k, l); return l.length; }
  if (op === "LRANGE") { const [k, s, e] = args; const l = redisStore.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; return l.slice(start, end + 1); }
  if (op === "LTRIM") { const [k, s, e] = args; const l = redisStore.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; redisStore.set(k, l.slice(start, end + 1)); return "OK"; }
  return null;
}
global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "fake-upstash-viewhistory.example.com") {
    const cmd = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server, memoryStore } = require(path.join(__dirname, "..", "server", "server.js"));

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

  {
    const r = await get(port, "/api/knowledge/team-view-history");
    ok(r.status === 400, "missing team param -> 400");
  }

  {
    const r = await get(port, "/api/knowledge/team-view-history?team=Nonexistent");
    ok(r.status === 200 && r.json.ok === true, "unknown team (no history yet) still returns ok:true");
    ok(r.json.today === null && r.json.history.length === 0, "no data yet -> today:null, empty history (honest, not fabricated)");
  }

  // 毎日学習エンジンのLayer3生成と同じ流れをシミュレートする: 1日目の見解 → 2日目に
  // 見解が変わる → 3日目にまた変わる、という3段階でsaveConclusionを呼ぶ。
  {
    const subjectKey = "team:Real Madrid:dailyView";
    await memoryStore.saveConclusion(subjectKey, { statement: "守備が安定している", computedAt: "2026-07-30T00:00:00Z" }, null);
    await memoryStore.saveConclusion(subjectKey, { statement: "攻撃陣の得点力が課題", computedAt: "2026-07-31T00:00:00Z" }, "守備は安定したが得点が伸び悩んだため");
    await memoryStore.saveConclusion(subjectKey, { statement: "怪我人が戻り好調", computedAt: "2026-08-01T00:00:00Z" }, "主力の負傷離脱者が復帰したため");

    const r = await get(port, "/api/knowledge/team-view-history?team=Real%20Madrid");
    ok(r.status === 200 && r.json.ok === true, "team with history returns ok:true");
    ok(r.json.today.statement === "怪我人が戻り好調", "today's view is the most recent conclusion, got " + JSON.stringify(r.json.today));
    ok(r.json.history.length === 2, "history has 2 superseded entries, got " + r.json.history.length);
    // 「昨日何を考えていたか」= 直近1つ前の見解(history[0]が最新の変化=通常は前日分)。
    ok(r.json.history[0].statement === "攻撃陣の得点力が課題", "history[0] is yesterday's view, got " + r.json.history[0].statement);
    ok(r.json.history[0].changeReason.includes("負傷離脱者が復帰"), "history[0] carries the reason the view changed away from it, got " + r.json.history[0].changeReason);
    ok(r.json.history[1].statement === "守備が安定している", "history[1] is the view from two days ago");
  }

  console.log(failures === 0 ? "\nteam-view-history tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
