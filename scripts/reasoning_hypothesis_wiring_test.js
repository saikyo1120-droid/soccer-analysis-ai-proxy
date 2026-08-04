/**
 * 2026年8月・「議論できるAI」強化フェーズ ご要望③(Reasoning Engineを
 * 5仮説以上の比較方式に拡張)の配線(wiring)テスト。
 *
 * hypothesisGenerator.js(9観点への拡張)自体はreasoning_engine_test.jsで
 * 純粋関数として検証済みだが、それだけでは「実際にPOST /api/discussを
 * 呼んだときに、本当に9つの仮説すべてが比較され、質問に応じて実データが
 * 取得されるか」までは確認できない。このテストは、planner.jsの新しい
 * "standings"トリガーと、server.js→knowledgeSource.jsに新しく注入した
 * fetchStandingsFeature/inferLeagueIdFromFixturesの配線が、実際に
 * エンドツーエンドで動くことを確認する。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-hypowiring.example.com";
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

const MOCK_LLM_TEXT = [
  "###一般論###", "一般的な見方です。", "",
  "###AI独自の意見###", "AIとしての意見です。", "",
  "###反対意見###", "反対の視点です。", "",
  "###最終結論###", "まとめです。", "",
  "###今後どうなると思うか###", "今後の見通しです。", "",
  "###最も重要だと考える点###", "私は与えられた事実が最も重要だと考えます。", "",
  "###フォローアップ###", "質問1？",
].join("\n");

const TEAM_ID = 778;
const LEAGUE_ID = 555;

global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "fake-upstash-hypowiring.example.com") {
    const cmd = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
  }
  if (u.hostname === "api.anthropic.com") {
    return { ok: true, json: async () => ({ content: [{ type: "text", text: MOCK_LLM_TEXT }] }) };
  }
  if (u.pathname === "/teams" && u.searchParams.get("search") === "Standings FC") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: TEAM_ID, name: "Standings FC" } }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("team") === String(TEAM_ID)) {
    const mk = (id, daysAgo, gf, ga) => ({
      fixture: { id, date: new Date(Date.now() - daysAgo * 86400e3).toISOString() },
      league: { id: LEAGUE_ID, name: "Test League" },
      teams: { home: { id: TEAM_ID, name: "Standings FC" }, away: { id: 999, name: "Opponent" } },
      goals: { home: gf, away: ga },
    });
    return { ok: true, json: async () => ({ errors: [], response: [mk(1, 3, 1, 1)] }) };
  }
  if (u.pathname === "/fixtures/lineups") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: TEAM_ID }, formation: "4-4-2", coach: { name: "Test Coach" } }] }) };
  }
  if (u.pathname === "/injuries") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) }; // 負傷者なし(順位以外の根拠を薄くする)
  }
  if (u.pathname === "/transfers") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/standings" && u.searchParams.get("league") === String(LEAGUE_ID)) {
    return {
      ok: true,
      json: async () => ({
        errors: [],
        response: [{
          league: {
            standings: [[
              { rank: 2, team: { id: TEAM_ID }, points: 50, all: { played: 20, goals: { for: 40, against: 15 } } },
            ]],
          },
        }],
      }),
    };
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

  // ① 順位に触れない質問: plannerがstandings needを要求しないため、
  //    順位の仮説は「根拠なし」のまま(でっち上げず、正直に0件)。
  const q1 = { question: "Standings FCの最近の調子はどう？", subject: { type: "club", labelJa: "スタンディングスFC", labelEn: "Standings FC" } };
  const r1 = await post(port, "/api/discuss", q1);
  ok(r1.json.ok === true, "①質問1はok:trueを返す");
  const hyps1 = r1.json.meta.reasoning.hypothesesConsidered;
  ok(Array.isArray(hyps1) && hyps1.length >= 5, `①最低5つ以上の仮説が比較されているはず, got ${hyps1 && hyps1.length}`);
  const standingsHyp1 = hyps1.find((h) => h.label.includes("順位"));
  ok(!!standingsHyp1, "①順位の観点自体はHYPOTHESIS_FACTORSの一員として常に含まれるはず");
  ok(standingsHyp1.evidenceCount === 0, `①順位に触れていない質問では順位の根拠は0件のはず(でっち上げない), got ${standingsHyp1.evidenceCount}`);

  // ② 順位に触れる質問: plannerがstandings needを要求し、knowledgeSourceが
  //    /standingsを実際に呼び出し、順位の仮説に根拠が付くはず。
  const q2 = { question: "Standings FCは今何位？順位的に厳しい状況？", subject: { type: "club", labelJa: "スタンディングスFC", labelEn: "Standings FC" } };
  const r2 = await post(port, "/api/discuss", q2);
  ok(r2.json.ok === true, "②質問2はok:trueを返す");
  const hyps2 = r2.json.meta.reasoning.hypothesesConsidered;
  const standingsHyp2 = hyps2.find((h) => h.label.includes("順位"));
  ok(!!standingsHyp2 && standingsHyp2.evidenceCount >= 1, `②順位に触れる質問では、実データ(2位・勝点50)を根拠に順位の仮説が支持されるはず, got ${JSON.stringify(standingsHyp2)}`);
  ok(standingsHyp2.label === "リーグ順位・置かれた状況が原因という仮説", `②hypothesisGenerator.jsの新しい観点ラベルがそのまま返るはず, got ${standingsHyp2.label}`);

  server.close();
  console.log(failures === 0 ? "\nReasoning Engine wiring (standings) tests PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
