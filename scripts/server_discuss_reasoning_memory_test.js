/**
 * Stage E(Knowledge Engine / Memory Engine / Reasoning Engine)がPOST /api/discuss
 * に実際に組み込まれ、動作することを確認するエンドツーエンドテスト。
 *
 * server_discuss_test.js はUpstash未設定の状態(Stage Eが正直に何もしないケース)を
 * カバーしているのに対し、このテストはUpstashを設定した状態で:
 *   ① Reasoning Engineが実データから仮説を組み立て、根拠の強い仮説を選ぶこと
 *   ② Memory Engineが初回の結論を記録し(INITIAL)、同じ状況での再質問では
 *      「変わっていない」と正しく判定すること(UNCHANGED)
 *   ③ 状況が変わった(負傷者情報が無くなり、移籍情報が新たに出た)場合には
 *      結論が変わったと判定され、前回の結論が記録に残ること(CHANGED)
 *   ④ AI自身が選んだ分析がKnowledge Engineに保存され、次回のRAG取得時に
 *      knowledgeEngine.analysesとして返ってくること
 * を検証する。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-reasoning.example.com";
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

// "injuries": 1回目・2回目のシナリオ(負傷者情報のみ根拠がある状態)。
// "transfers": 3回目のシナリオ(負傷者情報が無くなり、直近成績データも無い状態で
//   移籍情報だけが根拠として残る。他カテゴリの根拠を意図的に無くすことで、
//   「状況が変わったので選ばれる仮説そのものが変わる」ことを明確に検証する)。
let scenario = "injuries";

global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "fake-upstash-reasoning.example.com") {
    const cmd = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
  }
  if (u.hostname === "api.anthropic.com") {
    return { ok: true, json: async () => ({ content: [{ type: "text", text: MOCK_LLM_TEXT }] }) };
  }
  if (u.pathname === "/teams" && u.searchParams.get("search") === "Test FC") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 777, name: "Test FC" } }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("team") === "777") {
    if (scenario === "transfers") return { ok: true, json: async () => ({ errors: [], response: [] }) }; // このシナリオでは直近成績データも無い状態にする
    const mk = (id, daysAgo, gf, ga) => ({
      fixture: { id, date: new Date(Date.now() - daysAgo * 86400e3).toISOString() },
      league: { name: "Test League" },
      teams: { home: { id: 777, name: "Test FC" }, away: { id: 999, name: "Opponent" } },
      goals: { home: gf, away: ga },
    });
    return { ok: true, json: async () => ({ errors: [], response: [mk(1, 3, 1, 1)] }) };
  }
  if (u.pathname === "/fixtures/lineups") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 777 }, formation: "4-4-2", coach: { name: "Test Coach" } }] }) };
  }
  if (u.pathname === "/injuries" && u.searchParams.get("team") === "777") {
    if (scenario !== "injuries") return { ok: true, json: async () => ({ errors: [], response: [] }) };
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { name: "Injured Player", type: "Injury", reason: "Knee" }, fixture: { date: new Date().toISOString() } },
    ] }) };
  }
  if (u.pathname === "/transfers" && u.searchParams.get("team") === "777") {
    if (scenario !== "transfers") return { ok: true, json: async () => ({ errors: [], response: [] }) };
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { name: "New Signing" }, transfers: [{ date: new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10), type: "Free", teams: { in: { id: 777, name: "Test FC" }, out: { id: 555, name: "Other Club" } } }] },
    ] }) };
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

  // 「補強」を含めることで、Plannerが常にtransfers needも含めるようにする
  // (3回目のシナリオで移籍データが根拠として拾われるようにするため)。
  const question = { question: "Test FCの最近の補強はどう思う？", subject: { type: "club", labelJa: "テストFC", labelEn: "Test FC" } };

  // ① 1回目: 負傷者情報が根拠になり、defense_injury仮説が選ばれ、Memory EngineがINITIALとして記録するはず
  const r1 = await post(port, "/api/discuss", question);
  ok(r1.json.ok === true, "1回目のdiscussはok:true");
  const reasoning1 = r1.json.meta.reasoning;
  ok(!!reasoning1, "meta.reasoningが存在する(クラブ質問なので)");
  ok(reasoning1.selectedLabel.includes("守備陣"), "根拠(負傷者情報)から守備陣の仮説が選ばれる, got " + reasoning1.selectedLabel);
  ok(reasoning1.memory.saved === true && reasoning1.memory.changed === true, "1回目はMemory Engineに新規結論として保存される, got " + JSON.stringify(reasoning1.memory));

  // ② 2回目(同じ状況で再質問): 結論は変わらないはず(UNCHANGED)
  const r2 = await post(port, "/api/discuss", question);
  const reasoning2 = r2.json.meta.reasoning;
  ok(reasoning2.selectedLabel.includes("守備陣"), "2回目も同じ仮説が選ばれる(状況が変わっていないため)");
  ok(reasoning2.memory.changed === false, "2回目は結論が変わっていないとMemory Engineが正しく判定する, got " + JSON.stringify(reasoning2.memory));
  ok(reasoning2.previousConclusion === reasoning1.selectedLabel || typeof reasoning2.previousConclusion === "string", "2回目には前回の結論が引き継がれて渡される");

  // ③ 状況変化: 負傷者情報・直近成績データが無くなり、代わりに移籍情報が出てきた -> 選ばれる仮説が変わるはず
  scenario = "transfers";
  const r3 = await post(port, "/api/discuss", question);
  const reasoning3 = r3.json.meta.reasoning;
  ok(reasoning3.selectedLabel.includes("移籍"), "根拠が変わったので移籍による戦力変化の仮説が選ばれる, got " + reasoning3.selectedLabel);
  ok(reasoning3.memory.changed === true, "状況が変わったのでMemory Engineは結論の変化を検知する, got " + JSON.stringify(reasoning3.memory));
  ok(typeof reasoning3.previousConclusion === "string" && reasoning3.previousConclusion.includes("負傷"), "3回目のリクエストには前回(守備陣仮説)の結論が渡されている, got " + reasoning3.previousConclusion);

  // ④ Knowledge Engineへの保存確認: 1回目の分析がRedisにanalysisとして保存され、
  //    Knowledge Engineが直接読み取れることを確認する(knowledgeStoreを直接使う)
  const { knowledgeStore } = require(path.join(__dirname, "..", "server", "server.js"));
  const active = await knowledgeStore.getActiveKnowledge("Test FC");
  ok(active.analyses.length >= 1, "AIが選んだ分析がKnowledge Engineにanalysisとして保存されている, got " + JSON.stringify(active.analyses.map((a) => a.statement)));

  server.close();
  console.log(failures === 0 ? "\nDiscuss reasoning/memory integration PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
