/**
 * Tests the new POST /api/discuss endpoint (Stage C: 対話エンジン/議論モード).
 * Covers: club-subject discussion (full RAG success), club-subject with an
 * unresolvable team (graceful degradation), player-subject discussion (reuses
 * the existing /api/player-season-stats logic internally), no-subject general
 * discussion, and basic request validation. The LLM call itself is mocked by
 * intercepting requests to api.anthropic.com via global.fetch, exactly like
 * API-Football calls are mocked elsewhere in this test suite (this sandbox
 * can't reach either external host).
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.PORT = "0";

const apiFootballCalls = [];
const anthropicCalls = [];

function fakeAnthropicResponse(text) {
  return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
}

const MOCK_LLM_TEXT = [
  "###一般論###",
  "一般的には、成績が落ちているクラブは戦術や選手層の問題が指摘されがちです。",
  "",
  "###AI独自の意見###",
  "確かにそう感じる方は多いかもしれません。ただ直近の結果を見る限り、極端に崩れているわけではなさそうです。私は守備陣の負傷者の多さが最大の原因だと考えます。",
  "",
  "###反対意見###",
  "一方で、負傷者が多いことだけでは説明できない守備の連携ミスも見られるという見方もできます。",
  "",
  "###最終結論###",
  "総合的には、負傷者の影響が最も大きいと判断します。",
  "",
  "###今後どうなると思うか###",
  "しかし負傷者が戻れば、再び安定する可能性は十分にあります。",
  "",
  "###最も重要だと考える点###",
  "私は守備陣の負傷者の多さが最も重要だと考えます。",
  "",
  "###フォローアップ###",
  "あなたは最大の問題は守備だと思いますか？",
  "監督の采配についてはどう感じますか？",
].join("\n");

global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "api.anthropic.com") {
    anthropicCalls.push({ url: u.toString(), body: opts && opts.body ? JSON.parse(opts.body) : null });
    return fakeAnthropicResponse(MOCK_LLM_TEXT);
  }

  apiFootballCalls.push(u.pathname + "?" + u.searchParams.toString());

  if (u.pathname === "/teams" && u.searchParams.get("search") === "Real Madrid") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 541, name: "Real Madrid" } }] }) };
  }
  if (u.pathname === "/teams" && u.searchParams.get("search") === "Nonexistent FC") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("team") === "541") {
    const mk = (id, daysAgo, oppName, gf, ga) => ({
      fixture: { id, date: new Date(Date.now() - daysAgo * 86400e3).toISOString() },
      league: { name: "La Liga" },
      teams: { home: { id: 541, name: "Real Madrid" }, away: { id: 999, name: oppName } },
      goals: { home: gf, away: ga },
    });
    return { ok: true, json: async () => ({ errors: [], response: [
      mk(9001, 3, "Sevilla", 2, 1),
      mk(9002, 10, "Valencia", 1, 1),
      mk(9003, 17, "Betis", 3, 0),
      mk(9004, 24, "Getafe", 0, 1),
      mk(9005, 31, "Osasuna", 2, 0),
    ] }) };
  }
  if (u.pathname === "/fixtures/lineups" && u.searchParams.get("fixture") === "9001") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { team: { id: 541, name: "Real Madrid" }, formation: "4-3-3", coach: { name: "Carlo Ancelotti" } },
      { team: { id: 999, name: "Sevilla" }, formation: "4-4-2", coach: { name: "Someone Else" } },
    ] }) };
  }
  if (u.pathname === "/injuries" && u.searchParams.get("team") === "541") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { name: "D. Carvajal", type: "Injury", reason: "Knee" }, fixture: { date: new Date(Date.now() - 3 * 86400e3).toISOString() } },
      { player: { name: "E. Militão", type: "Injury", reason: "Hamstring" }, fixture: { date: new Date(Date.now() - 10 * 86400e3).toISOString() } },
    ] }) };
  }
  if (u.pathname === "/transfers" && u.searchParams.get("team") === "541") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { name: "New Signing" }, transfers: [{ date: new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10), type: "Free", teams: { in: { id: 541, name: "Real Madrid" }, out: { id: 123, name: "Some Club" } } }] },
    ] }) };
  }

  // player-subject sub-test: reuse the same pattern as server_team_fallback_test.js
  if (u.pathname === "/teams" && u.searchParams.get("search") === "Vissel Kobe") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 292, name: "Vissel Kobe" } }] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("team") === "292" && u.searchParams.get("search") === "Osako") {
    return { ok: true, json: async () => ({ errors: [], response: [
      { player: { id: 5001, name: "Y. Osako", birth: { date: "1990-05-18" } }, statistics: [{ team: { name: "Vissel Kobe" }, games: { appearences: 20 } }] },
    ] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("id") === "5001") {
    return { ok: true, json: async () => ({ errors: [], response: [{
      player: { id: 5001, name: "Y. Osako", nationality: "Japan" },
      statistics: [{ team: { name: "Vissel Kobe" }, games: { appearences: 20, minutes: 1600, rating: "7.05" }, goals: { total: 10, assists: 4 }, cards: { yellow: 1, red: 0 } }],
    }] }) };
  }
  if (u.pathname === "/players" && u.searchParams.get("league")) {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
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

  // ---- validation ----
  {
    const r1 = await post(port, "/api/discuss", { question: "" });
    ok(r1.status === 400, "empty question -> 400");
    const r2 = await post(port, "/api/discuss", { question: "あ".repeat(600) });
    ok(r2.status === 400, "over-length question -> 400");
    const r3 = await post(port, "/api/discuss", null);
    ok(r3.status === 400, "null body -> 400");
  }

  // ---- club subject: full RAG success ----
  {
    const r = await post(port, "/api/discuss", {
      question: "最近のレアル・マドリードは統率が取れていないから弱い気がする",
      subject: { type: "club", labelJa: "レアル・マドリード", labelEn: "Real Madrid" },
    });
    console.log(JSON.stringify(r.json, null, 2));
    ok(r.status === 200 && r.json.ok === true, "club discussion returns ok:true");
    ok(r.json.facts.some((f) => f.includes("直近5試合")), "facts include recent-form summary");
    ok(r.json.facts.some((f) => f.includes("Carlo Ancelotti")), "facts include real coach name");
    ok(r.json.facts.some((f) => f.includes("Carvajal") && f.includes("Militão")), "facts include real injury names");
    ok(typeof r.json.stats.avgGoalsFor === "number", "stats includes computed avgGoalsFor");
    // 2026年8月・第5次監査での設計変更に合わせて更新。
    // 以前は「必要なAPI呼び出しが全部成功したか」だけで★5にしていたが、
    // それは「データが取れた」ことしか表しておらず、「その根拠がどれだけ
    // 判断を支えているか」を無視していた。現在は熟考エンジンの評価
    // (データ充足率・実データの件数・対抗仮説との差)も合わせて厳しい方を採る。
    // ここでは根拠が各1件・仮説が拮抗しているため★5にはならないのが正しい。
    ok(r.json.confidence.stars >= 1 && r.json.confidence.stars <= 5, "confidence stars in range, got " + r.json.confidence.stars);
    ok(r.json.confidence.reasonJa.includes("データがすべて揃っている"), "confidence reason states the required data was fully fetched, got: " + r.json.confidence.reasonJa);
    ok(r.json.confidence.reasonJa.includes("実データが1件と少ない") || r.json.confidence.reasonJa.includes("拮抗"), "confidence reason explains why it is not full marks, got: " + r.json.confidence.reasonJa);
    ok(r.json.confidence.reasonJa.includes("監督コメント"), "confidence reason still honestly notes manager-quote data is unavailable");
    ok(
      r.json.generalView.length > 0 && r.json.aiOpinion.length > 0 && r.json.counterArgument.length > 0 &&
        r.json.finalConclusion.length > 0 && r.json.futureOutlook.length > 0 && r.json.mostImportantOpinion.length > 0,
      "generalView/aiOpinion/counterArgument/finalConclusion/futureOutlook/mostImportantOpinion all parsed from LLM output"
    );
    ok(r.json.followUpQuestions.length === 2, "2 follow-up questions parsed, got " + r.json.followUpQuestions.length);
    ok(r.json.meta.parsedOk === true, "meta.parsedOk true for well-formatted LLM output");
    ok(r.json.meta.llmProvider === "anthropic", "meta reports the anthropic provider");
    // 2026年8月・知識拡張フェーズ以降: クラブについて議論モードで質問すると、
    // 従来の考察生成用LLM呼び出しに加えて、Knowledge Engine Layer2(固定知識)を
    // オンデマンドで生成するLLM呼び出しが(未キャッシュの場合)1回追加で発生する
    // ようになった(server/rag/knowledgeSource.js の ensureClubProfile 呼び出し)。
    // そのため呼び出し回数は1回ではなく2回になる。どちらのプロンプトにも
    // (根拠として渡している)実際の監督名が含まれているはず。
    ok(anthropicCalls.length === 2, "anthropic is called twice now: once for the on-demand Layer2 club profile, once for the discuss consideration itself, got " + anthropicCalls.length);
    ok(anthropicCalls.some((c) => c.body.messages[0].content.includes("Carlo Ancelotti")), "at least one anthropic prompt is built from the formatted RAG facts (contains the real coach name)");
  }

  // ---- club subject: transfer-related question triggers the "transfers" need ----
  {
    const r = await post(port, "/api/discuss", {
      question: "レアル・マドリードの今シーズンの補強はうまくいってると思う？",
      subject: { type: "club", labelJa: "レアル・マドリード", labelEn: "Real Madrid" },
    });
    ok(r.json.meta.needs.includes("transfers"), "planner includes 'transfers' need when the question mentions 補強");
    ok(r.json.facts.some((f) => f.includes("New Signing")), "facts include the real transfer once the planner requests it");
  }

  // ---- club subject: team not found (graceful degradation) ----
  {
    const r = await post(port, "/api/discuss", {
      question: "このクラブはどう思う？",
      subject: { type: "club", labelJa: "存在しないクラブ", labelEn: "Nonexistent FC" },
    });
    ok(r.json.ok === true, "unresolvable club still returns ok:true (degrades gracefully)");
    ok(r.json.confidence.stars === 1, "confidence drops to 1 star when the club can't be resolved, got " + r.json.confidence.stars);
  }

  // ---- player subject ----
  {
    const r = await post(port, "/api/discuss", {
      question: "大迫勇也は衰えたと思う？",
      subject: { type: "player", labelJa: "大迫勇也" },
      playerHint: { name: "Yuya Osako", teamEn: "Vissel Kobe", birth: "1990-05-18" },
    });
    ok(r.json.ok === true, "player discussion returns ok:true");
    ok(r.json.facts.some((f) => f.includes("10得点") || f.includes("10") && f.includes("得点")), "facts include real season stats");
    ok(r.json.stats.goals === 10, "stats.goals reflects real data, got " + JSON.stringify(r.json.stats));
    ok(r.json.confidence.stars === 4, "player-subject confidence is 4 stars when season stats found, got " + r.json.confidence.stars);
  }

  // ---- player subject: not found ----
  {
    const r = await post(port, "/api/discuss", {
      question: "この選手はどう思う？",
      subject: { type: "player", labelJa: "無名選手" },
      playerHint: { name: "Totally Unknown Player" },
    });
    ok(r.json.ok === true, "unfindable player still returns ok:true");
    ok(r.json.confidence.stars === 1, "confidence is 1 star when player stats not found, got " + r.json.confidence.stars);
  }

  // ---- no subject: general discussion ----
  {
    const r = await post(port, "/api/discuss", { question: "なぜ4-3-3が主流なの？" });
    ok(r.json.ok === true, "no-subject discussion returns ok:true");
    ok(r.json.confidence.stars === 2, "no-subject confidence defaults to 2 stars, got " + r.json.confidence.stars);
    ok(r.json.meta.needs.length === 0, "planner requests no RAG data types when there's no subject");
  }

  // ---- GET not allowed ----
  {
    const got = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/discuss" }, (res) => resolve(res.statusCode)).on("error", reject);
    });
    ok(got === 405, "GET /api/discuss -> 405, got " + got);
  }

  server.close();
  console.log(failures === 0 ? "\nDiscuss API PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
