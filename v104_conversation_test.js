"use strict";
/**
 * v104(2026年11月12日)・会話の改良(1〜7)の検証
 *   ① 質問の種類(intent): 挨拶/サッカー以外/事実/予想/議論 を4言語のルールで分ける
 *   ② 道具つきの会話: 回答AIが tool_use → サーバーが道具を実行 → tool_result → 最終回答。上限と予算
 *   ③ 予想と会話の接続: get_today_predictions が保存済みの予想(確率・確信度・根拠)を返す
 *   ④ 流れる表示: /api/discuss/stream の NDJSON(status → delta → reset → final)
 *   ⑤ 記憶: 10往復・切り詰め・利用者の設定(profile)の検証
 *   ⑥ 主題の解決: 辞書の語境界(「レアル・ベティス」を「レアル・マドリード」にしない)・漢字の先頭・複合語を分割しない
 *   ⑦ 聞き返し: 曖昧なときだけ候補つきで返し、LLM 予算を使わない
 *   本物の Anthropic API は呼ばない(ローカルのモック)。外部 API も全てモック。
 */
const http = require("http");
const assert = require("assert");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); } };

// ---------------------------------------------------------------------------
// モック Anthropic(道具・ストリーミング対応)。会話の中身を見て台本どおりに返す。
// ---------------------------------------------------------------------------
const mockLog = []; // 呼び出しの記録 {model, stream, hasTools, toolResults, maxTokens}
function textOfUser(messages) {
  const first = messages && messages[0];
  if (!first) return "";
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}
function hasToolResult(messages) {
  return (messages || []).some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result"));
}
function lastToolResultText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && Array.isArray(m.content)) {
      const tr = m.content.find((b) => b && b.type === "tool_result");
      if (tr) return String(tr.content || "");
    }
  }
  return "";
}
function scriptReply(body) {
  const system = String(body.system || "");
  const messages = body.messages || [];
  const userText = textOfUser(messages);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const mode = system.includes("###予想###") ? "prediction" : system.includes("###一般論###") ? "discussion" : "plain";
  const toolNames = tools.map((x) => x.name);
  // 道具の往復(道具が使え、まだ結果が無い)
  if (toolNames.length && !hasToolResult(messages)) {
    if (/TOOLSPAM/.test(userText)) return { toolUse: { name: "get_accuracy_summary", input: {} } };
    if (mode === "prediction" && toolNames.includes("get_today_predictions")) return { toolUse: { name: "get_today_predictions", input: { team: "Arsenal" } }, preText: "確認します。" };
    if (/外した/.test(userText) && toolNames.includes("get_recent_misses")) return { toolUse: { name: "get_recent_misses", input: { limit: 3 } } };
  }
  if (toolNames.length && /TOOLSPAM/.test(userText) && !/上限に達しました|予算が残り少ない/.test(JSON.stringify(messages))) {
    return { toolUse: { name: "get_accuracy_summary", input: {} } };
  }
  const tr = lastToolResultText(messages);
  const m = tr.match(/"confidencePct":(\d+)/);
  const conf = m ? m[1] : null;
  if (mode === "prediction") {
    return { text: `###予想###\nアーセナル勝利が有利です(確信度 ${conf ? conf + "%" : "取得できません"})。\n\n###根拠###\n直近フォームと主力評価点の差が根拠です。${conf ? `確率は${conf}%です。` : ""}\n\n###注意###\n特になし\n\n###フォローアップ###\n相手の怪我人は?\n直前版で変わる?` };
  }
  if (mode === "discussion") {
    return { text: "###一般論###\n一般論です。\n\n###AI独自の意見###\n私の意見です。\n\n###反対意見###\n反対です。\n\n###最終結論###\n結論です。\n\n###今後どうなると思うか###\n今後です。\n\n###最も重要だと考える点###\n私は直近フォームが最も重要だと考えます。\n\n###フォローアップ###\n次は?" };
  }
  if (/外した/.test(userText)) return { text: `外した理由は${/reasonsJa/.test(tr) ? "記録にあります" : "取得できません"}。` };
  if (/^こんにちは/.test(userText.replace(/^[\s\S]*利用者の質問: 「/, ""))) return { text: "こんにちは。今日はどのクラブの話をしましょうか。" };
  return { text: "オフサイドは、相手ゴールに近い側で味方より前に出ている状態でパスを受ける反則です。\n\n###フォローアップ###\nルールの例外は?" };
}
function sseChunks(reply, model) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
  let out = ev("message_start", { message: { id: "m1", model, usage: { input_tokens: 10 } } });
  let idx = 0;
  if (reply.preText) {
    out += ev("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { index: idx, delta: { type: "text_delta", text: reply.preText } });
    out += ev("content_block_stop", { index: idx });
    idx++;
  }
  if (reply.toolUse) {
    out += ev("content_block_start", { index: idx, content_block: { type: "tool_use", id: "tu_" + Date.now(), name: reply.toolUse.name, input: {} } });
    const json = JSON.stringify(reply.toolUse.input || {});
    out += ev("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: json.slice(0, Math.ceil(json.length / 2)) } });
    out += ev("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: json.slice(Math.ceil(json.length / 2)) } });
    out += ev("content_block_stop", { index: idx });
    out += ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  } else {
    out += ev("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
    const text = reply.text || "";
    for (let i = 0; i < text.length; i += 7) out += ev("content_block_delta", { index: idx, delta: { type: "text_delta", text: text.slice(i, i + 7) } });
    out += ev("content_block_stop", { index: idx });
    out += ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
  }
  out += ev("message_stop", {});
  return out;
}
function startMockAnthropic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) {}
        if (/BAD400/.test(textOfUser(body.messages)) && Array.isArray(body.tools) && body.tools.length) {
          res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "tools: schema rejected (mock)" } })); return;
        }
        const reply = scriptReply(body);
        mockLog.push({ model: body.model, stream: !!body.stream, hasTools: Array.isArray(body.tools) && body.tools.length > 0, toolResults: hasToolResult(body.messages), maxTokens: body.max_tokens, toolUse: reply.toolUse ? reply.toolUse.name : null });
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunks = sseChunks(reply, body.model);
          // 2回に分けて送る(断片の結合を検証)
          const half = Math.floor(chunks.length / 2);
          res.write(chunks.slice(0, half));
          setTimeout(() => { res.write(chunks.slice(half)); res.end(); }, 15);
          return;
        }
        const content = [];
        if (reply.preText) content.push({ type: "text", text: reply.preText });
        if (reply.toolUse) content.push({ type: "tool_use", id: "tu_" + Date.now(), name: reply.toolUse.name, input: reply.toolUse.input || {} });
        else content.push({ type: "text", text: reply.text || "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content, stop_reason: reply.toolUse ? "tool_use" : "end_turn", model: body.model, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const mock = await startMockAnthropic();
  const mockPort = mock.address().port;
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${mockPort}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "light-model";
  process.env.ANTHROPIC_MODEL_HEAVY = "heavy-model";
  process.env.PORT = "0"; process.env.API_FOOTBALL_KEY = "k";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  process.env.RATE_LIMIT_PER_MINUTE = "100000"; process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000"; process.env.LINEUP_WATCH = "0";
  process.env.PER_IP_LLM_CALLS_PER_DAY = "1000"; process.env.MAX_LLM_CALLS_PER_DAY = "100000";
  process.env.DISCUSS_MULTISTEP = "0";
  if (process.env.V104_LEGACY === "1") process.env.DISCUSS_TOOLS = "0";

  const SERVER_DIR = __dirname;
  const srv = require(path.join(SERVER_DIR, "server.js"));
  const V104 = srv.__v104ForTest;
  const V98 = srv.__v98ForTest; const V97 = srv.__v97ForTest;
  const intent = require(path.join(SERVER_DIR, "discuss/intent.js"));
  const resolver = require(path.join(SERVER_DIR, "discuss/subjectResolver.js"));
  const toolLoop = require(path.join(SERVER_DIR, "discuss/toolLoop.js"));
  const matchupLib = require(path.join(SERVER_DIR, "learning/matchupAnalysis.js"));

  // ---- 保存先と外部 API のモック ----
  const store = new Map();
  const cmd = async (c) => { const [op, ...a] = c;
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => store.has(k) ? store.get(k) : null);
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "LRANGE") return store.get(a[0]) || [];
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "EXPIRE") return 1;
    return null; };
  const now = Date.now(); const kickoff = new Date(now + 3 * 3600000).toISOString();
  const fx = (id, hid, hn, aid, an, lid, ln) => ({ fixture: { id, date: kickoff, status: { short: "NS" }, venue: { name: "Stadium" } }, league: { id: lid, name: ln, country: "England" }, teams: { home: { id: hid, name: hn, logo: "" }, away: { id: aid, name: an, logo: "" } }, goals: { home: null, away: null } });
  srv.__setTestHooks({
    upstashCmd: cmd, upstashGetJSON: async (k) => { const r = await cmd(["GET", k]); return r === null ? null : JSON.parse(r); }, upstashSetJSON: async (k, v) => { await cmd(["SET", k, JSON.stringify(v)]); return true; },
    callApiFootball: async (ep, p) => {
      if (ep === "/fixtures" && p && p.date) return { response: [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League")] };
      if (ep === "/fixtures" && p && p.id) return { response: Number(p.id) === 501 ? [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League")] : [] };
      return { response: [] };
    },
  });
  store.set("learn:ratings:v1", JSON.stringify({ byTeam: { 42: { att: 1.2, def: 0.9 }, 541: { att: 1.3, def: 0.8 }, 50: { att: 1.3, def: 0.8 }, 33: { att: 1.1, def: 1 }, 543: { att: 1, def: 1 } }, namesById: { 42: "Arsenal", 541: "Real Madrid", 50: "Manchester City", 33: "Manchester United", 543: "Real Betis" }, matches: 1000 }));
  store.set("learn:teamnames", JSON.stringify({ 42: "Arsenal", 541: "Real Madrid", 50: "Manchester City", 33: "Manchester United", 543: "Real Betis", 1616: "Inter Miami", 505: "Inter" }));
  store.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル" }, { teamId: 543, nameEn: "Real Betis", nameJa: "レアル・ベティス" }, { teamId: 1616, nameEn: "Inter Miami", nameJa: "インテル・マイアミ" }] }));
  store.set("learn:ownpred:501", JSON.stringify({ fixtureId: 501, homeTeamEn: "Arsenal", awayTeamEn: "Dibrados FC", predictedWinner: "home", homeLambda: 1.6, awayLambda: 1.0, resolved: false, kickoff, weightsVersion: 12, loggedAt: "2026-11-12T02:00:00Z", leagueId: 39, league: "Premier League", leagueCountry: "England",
    finalProbs: { homeWin: 0.52, draw: 0.26, awayWin: 0.22, source: "market_blend" }, marketImplied: { homePct: 50, drawPct: 27, awayPct: 23 }, odds: { home: 2.0, draw: 3.6, away: 4.2 },
    factorImportance: [{ key: "formDiff", labelJa: "直近フォーム", stars: 4 }], supplied: { formDiff: true, goalRateDiff: true, marketEdge: true }, squadRatings: { home: 7.1, away: 6.6 },
    content: V104.matchContentLib.buildMatchContent({ homeLambda: 1.6, awayLambda: 1.0, finalProbs: { homeWin: 0.52, draw: 0.26, awayWin: 0.22 }, rho: 0, model: null }) }));
  store.set("learn:ownpred:recent", [JSON.stringify({ fixtureId: 400, homeTeamEn: "Arsenal", awayTeamEn: "Chelsea", predictedWinner: "home", actualWinner: "away", resolved: true, correct: false, actualScore: { home: 0, away: 2 }, kickoff: "2026-11-01T15:00:00Z", league: "Premier League", finalProbs: { homeWin: 0.55, draw: 0.25, awayWin: 0.2 }, contextualFailureReasons: [{ labelJa: "主力選手の評価点を重視しすぎた", detail: "差 0.4" }] })]);
  V97.clearCache();
  await new Promise((r) => srv.server.on("listening", r));
  const port = srv.server.address().port;
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = ""; res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf, headers: res.headers }));
    });
    req.on("error", reject); req.end(data);
  });
  const get = (p) => new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: p }, (res) => { let buf = ""; res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf })); }).on("error", reject); });

  console.log("■ ① 質問の種類(intent)");
  await t("挨拶・お礼は smalltalk(短い文だけ)", () => {
    for (const q of ["こんにちは", "ありがとう!", "Hello", "hola", "你好", "おはようございます"]) assert.strictEqual(intent.classifyIntent(q).mode, "smalltalk", q);
    assert.notStrictEqual(intent.classifyIntent("こんにちは、レアルの今日の試合はどっちが勝つと思いますか?詳しく教えてください").mode, "smalltalk");
  });
  await t("サッカー以外は offtopic(サッカーの語があれば除外)", () => {
    assert.strictEqual(intent.classifyIntent("明日の天気は?").mode, "offtopic");
    assert.strictEqual(intent.classifyIntent("What is the weather tomorrow?").mode, "offtopic");
    assert.notStrictEqual(intent.classifyIntent("雨の日の試合は得点が減る?").mode, "offtopic");
  });
  await t("予想・勝敗・スコアは prediction(4言語)", () => {
    for (const q of ["レアルは今日勝てる?", "今夜のスコア予想は?", "Who will win Arsenal vs Chelsea?", "¿Quién gana el partido de hoy?", "今天的比赛谁会赢?", "引き分けになりそう?"]) assert.strictEqual(intent.classifyIntent(q).mode, "prediction", q);
  });
  await t("意見・仮説は discussion、予想と意見が混ざり対象が特定できれば prediction", () => {
    assert.strictEqual(intent.classifyIntent("ハイプレスは本当に有効だと思う?").mode, "discussion");
    assert.strictEqual(intent.classifyIntent("What do you think about Arsenal's defence?").mode, "discussion");
    assert.strictEqual(intent.classifyIntent("レアルは勝つと思う?", { subject: { type: "club" } }).mode, "prediction");
    assert.strictEqual(intent.classifyIntent("レアルは勝つと思う?", { subject: { type: null } }).mode, "discussion");
  });
  await t("それ以外は fact(用語・監督・順位・今日の試合一覧)", () => {
    for (const q of ["オフサイドって何?", "アーセナルの監督は?", "今日の試合は?", "Who is the coach of Arsenal?", "順位表を教えて"]) assert.strictEqual(intent.classifyIntent(q).mode, "fact", q);
  });
  await t("prediction の出力を4欄に分ける/見出し無しは parsedOk:false で全文を残す", () => {
    const p = intent.parsePredictionOutput("###予想###\nA\n\n###根拠###\nB\n\n###注意###\nC\n\n###フォローアップ###\n・Q1\n・Q2\n・Q3");
    assert.deepStrictEqual([p.prediction, p.basis, p.caution, p.followUpQuestions, p.parsedOk], ["A", "B", "C", ["Q1", "Q2"], true]);
    const q = intent.parsePredictionOutput("見出しなしの本文");
    assert.strictEqual(q.parsedOk, false); assert.strictEqual(q.prediction, "見出しなしの本文");
    const pl = intent.parsePlainOutput("本文です。###フォローアップ###\n次は?");
    assert.deepStrictEqual([pl.answerText, pl.followUpQuestions], ["本文です。", ["次は?"]]);
  });

  console.log("■ ⑥⑦ 主題の解決と聞き返し");
  const names = { 541: "Real Madrid", 543: "Real Betis", 33: "Manchester United", 50: "Manchester City", 505: "Inter", 1616: "Inter Miami", 42: "Arsenal", 1: "Kashima Antlers", 3: "Yokohama F. Marinos", 4: "Yokohama FC" };
  const uni = [...require(path.join(SERVER_DIR, "learning/clubUniverse.js")).CLUB_UNIVERSE, { nameEn: "Real Betis", nameJa: "レアル・ベティス" }, { nameEn: "Inter Miami", nameJa: "インテル・マイアミ" }, { nameEn: "Kashima Antlers", nameJa: "鹿島アントラーズ" }, { nameEn: "Yokohama F. Marinos", nameJa: "横浜F・マリノス" }, { nameEn: "Yokohama FC", nameJa: "横浜FC" }];
  const rctx = { index: matchupLib.buildNameIndex(names), jaMap: matchupLib.buildJaMap(uni), ratedIds: new Set(Object.keys(names).map(Number)) };
  await t("別名「レアル」はレアル・マドリード、「レアル・ベティス」「レアルベティス」はベティス(語境界で化けない)", () => {
    assert.strictEqual(resolver.resolveSubjectFromQuestion("レアルは今日勝てる?", rctx).subject.labelEn, "Real Madrid");
    assert.strictEqual(resolver.resolveSubjectFromQuestion("レアル・ベティスはどう?", rctx).subject.labelEn, "Real Betis");
    assert.strictEqual(resolver.resolveSubjectFromQuestion("レアルベティスの調子", rctx).subject.labelEn, "Real Betis");
  });
  await t("複合語は分割しない(「インテル・マイアミ」が「インテル」にならない)", () => {
    assert.strictEqual(resolver.resolveSubjectFromQuestion("インテル・マイアミはどう?", rctx).subject.labelEn, "Inter Miami");
    assert.strictEqual(resolver.resolveSubjectFromQuestion("インテルの調子は?", rctx).subject.labelEn, "Inter");
  });
  await t("「マンチェスター」「横浜」は候補2件で聞き返し(推測で決めない)・確定クラブがあれば聞き返さない", () => {
    const r = resolver.resolveSubjectFromQuestion("マンチェスターはどう?", rctx);
    assert.strictEqual(r.subject, null); assert.ok(r.clarify && r.clarify.candidates.length === 2, JSON.stringify(r));
    const y = resolver.resolveSubjectFromQuestion("横浜はどう?", rctx);
    assert.ok(y.clarify && y.clarify.candidates.includes("横浜FC"), JSON.stringify(y));
    const both = resolver.resolveSubjectFromQuestion("マンチェスターとアーセナルどっち?", rctx);
    assert.strictEqual(both.clarify, null); assert.strictEqual(both.subject.labelEn, "Arsenal");
  });
  await t("漢字の先頭(「鹿島の監督は?」)・英語(「Man City will win?」)・比較は出現順で2クラブ", () => {
    assert.strictEqual(resolver.resolveSubjectFromQuestion("鹿島の監督は?", rctx).subject.labelEn, "Kashima Antlers");
    assert.strictEqual(resolver.resolveSubjectFromQuestion("Man City will win?", rctx).subject.labelEn, "Manchester City");
    const cmp = resolver.resolveSubjectFromQuestion("バイエルンとアーセナルどっちが強い?", { ...rctx, index: matchupLib.buildNameIndex({ ...names, 157: "Bayern Munich" }) });
    assert.deepStrictEqual(cmp.clubs.map((c) => c.labelEn), ["Bayern Munich", "Arsenal"]);
  });
  await t("クラブ名が無い質問は none(でっち上げない)", () => {
    for (const q of ["今日の試合は?", "オフサイドって何?", "ハイプレスは有効?"]) assert.strictEqual(resolver.resolveSubjectFromQuestion(q, rctx).subject, null, q);
  });

  console.log("■ ⑤ 記憶と利用者の設定");
  await t("history は直近10往復・質問300字・回答400字に切り詰め、壊れた要素は捨てる", () => {
    const raw = Array.from({ length: 14 }, (_, i) => ({ q: "q" + i + "x".repeat(400), a: "a" + i + "y".repeat(600) }));
    raw.push(null, { q: "", a: "x" }, { q: "ok", a: "" });
    const h = V104.sanitizeDiscussHistory(raw);
    assert.strictEqual(h.length, 10); assert.strictEqual(h[0].q.slice(0, 2), "q4");
    assert.strictEqual(h[0].q.length, 300); assert.strictEqual(h[0].a.length, 400);
  });
  await t("profile は好きなクラブ(40字)・詳しさ(beginner/standard/expert)・呼び名(20字)だけを受け付ける", () => {
    const p = V104.sanitizeDiscussProfile({ favoriteClub: "アーセナル", level: "expert", nickname: "さい", extra: "x", bad: "<script>" });
    assert.deepStrictEqual(p, { favoriteClub: "アーセナル", level: "expert", nickname: "さい" });
    assert.strictEqual(V104.sanitizeDiscussProfile({ level: "god" }), null);
    assert.strictEqual(V104.sanitizeDiscussProfile({ favoriteClub: "<b>x</b>" }), null);
    const sp = V104.buildDiscussSystemPrompt("ja", "fact", { tools: true, profile: p });
    assert.ok(sp.includes("好きなクラブ: アーセナル") && sp.includes("道具の使い方") && sp.includes("見出しは使わず"), sp.slice(0, 200));
    const sd = V104.buildDiscussSystemPrompt("ja", "discussion", { tools: false, profile: null });
    assert.ok(sd.includes("###一般論###") && !sd.includes("道具の使い方"));
  });

  console.log("■ ② 道具つきの会話ループ(単体)");
  await t("tool_use → 実行 → 最終回答。重い質問は軽量で往復して上位モデルで仕上げる", async () => {
    const calls = [];
    const gen = async ({ messages, tools, tier }) => {
      calls.push({ tier, tools: tools.length, n: messages.length });
      if (tools.length && messages.length === 1) return { content: [{ type: "text", text: "確認します" }, { type: "tool_use", id: "t1", name: "get_today_predictions", input: { team: "Arsenal" } }], stopReason: "tool_use", model: "light-model" };
      return { content: [{ type: "text", text: `答え(${tier})` }], stopReason: "end_turn", model: tier === "heavy" ? "heavy-model" : "light-model" };
    };
    const events = [];
    const r = await toolLoop.runToolLoop({ systemPrompt: "s", userContent: "u", tools: [{ name: "get_today_predictions" }], execute: async (name) => ({ ok: true, resultJson: `{"ok":true,"name":"${name}"}`, summaryJa: "x", elapsedMs: 1 }), generateConversation: gen, tier: "light", finalTier: "heavy", stream: true, emit: (e) => events.push(e), canAffordRound: async () => true });
    assert.strictEqual(r.text, "答え(heavy)"); assert.strictEqual(r.model, "heavy-model");
    assert.strictEqual(r.calls, 1); assert.strictEqual(r.toolCalls[0].name, "get_today_predictions");
    assert.deepStrictEqual(calls.map((c) => c.tier), ["light", "light", "heavy"]);
    assert.ok(events.some((e) => e.t === "status" && e.key === "tool"), JSON.stringify(events));
  });
  await t("道具の往復は上限(maxRounds/maxCalls)で止まり、最終回答は必ず返る(exhausted を開示)", async () => {
    let n = 0;
    const gen = async ({ messages, tools }) => {
      n++;
      if (tools.length) return { content: [{ type: "tool_use", id: "t" + n, name: "get_accuracy_summary", input: {} }, { type: "tool_use", id: "u" + n, name: "get_accuracy_summary", input: {} }], stopReason: "tool_use", model: "light-model" };
      return { content: [{ type: "text", text: "最終" }], stopReason: "end_turn", model: "light-model" };
    };
    let executed = 0;
    const r = await toolLoop.runToolLoop({ systemPrompt: "s", userContent: "u", tools: [{ name: "get_accuracy_summary" }], execute: async () => { executed++; return { ok: true, resultJson: "{}", summaryJa: "x", elapsedMs: 1 }; }, generateConversation: gen, maxRounds: 2, maxCalls: 3, canAffordRound: async () => true });
    assert.strictEqual(r.text, "最終"); assert.strictEqual(r.exhausted, true);
    assert.ok(executed <= 3, "executed=" + executed); assert.strictEqual(r.rounds, 3);
  });
  await t("予算が無いときは2往復目で道具を外して最終回答を求める", async () => {
    let n = 0;
    const gen = async ({ tools }) => { n++; if (tools.length) return { content: [{ type: "tool_use", id: "t" + n, name: "x", input: {} }], stopReason: "tool_use", model: "m" }; return { content: [{ type: "text", text: "節約回答" }], stopReason: "end_turn", model: "m" }; };
    const r = await toolLoop.runToolLoop({ systemPrompt: "s", userContent: "u", tools: [{ name: "x" }], execute: async () => ({ ok: true, resultJson: "{}", summaryJa: "x", elapsedMs: 1 }), generateConversation: gen, canAffordRound: async () => false });
    assert.strictEqual(r.text, "節約回答"); assert.strictEqual(r.exhausted, true); assert.strictEqual(r.calls, 1);
  });
  await t("重いモデルが時間切れなら軽量モデルで同じ往復をやり直す(fallbackFrom を開示)", async () => {
    const gen = async ({ tier }) => { if (tier === "heavy") { const e = new Error("timeout"); e.code = "TIMEOUT"; throw e; } return { content: [{ type: "text", text: "軽量の答え" }], stopReason: "end_turn", model: "light-model" }; };
    const r = await toolLoop.runToolLoop({ systemPrompt: "s", userContent: "u", tools: [], execute: async () => ({}), generateConversation: gen, tier: "light", finalTier: "heavy", fallbackTier: "light" });
    assert.strictEqual(r.text, "軽量の答え"); assert.strictEqual(r.fallbackFrom, "heavy");
  });

  console.log("■ ②③④ HTTP(モック Anthropic・道具・ストリーム)");
  const legacy = process.env.V104_LEGACY === "1";
  await t("事実の質問(オフサイドって何?)→ mode:fact・見出し無しの本文・フォローアップ・道具は使わない", async () => {
    mockLog.length = 0;
    const r = await post("/api/discuss", { question: "オフサイドって何?", subject: { type: null }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.ok, true); assert.strictEqual(b.mode, "fact");
    assert.ok(b.answerText && b.answerText.startsWith("オフサイドは") && !b.answerText.includes("###"), b.answerText);
    assert.deepStrictEqual(b.followUpQuestions, ["ルールの例外は?"]);
    assert.strictEqual(b.meta.tools.calls, 0);
    assert.ok(mockLog.length >= 1 && mockLog[0].hasTools === !legacy, JSON.stringify(mockLog));
  });
  await t("挨拶(こんにちは)→ mode:smalltalk・短い回答・道具無し・max_tokens 300", async () => {
    mockLog.length = 0;
    const r = await post("/api/discuss", { question: "こんにちは", subject: { type: null }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.mode, "smalltalk"); assert.ok(b.answerText.startsWith("こんにちは"), b.answerText);
    assert.strictEqual(mockLog.length, 1); assert.strictEqual(mockLog[0].hasTools, false); assert.ok(mockLog[0].maxTokens <= 300);
    assert.strictEqual(b.confidence, null);
  });
  if (!legacy) {
    await t("予想の質問(アーセナルは今日勝てる?)→ 道具 get_today_predictions が保存済みの予想を返し、確率が回答に入る", async () => {
      mockLog.length = 0;
      const r = await post("/api/discuss", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
      const b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true, r.text.slice(0, 300)); assert.strictEqual(b.mode, "prediction");
      assert.strictEqual(b.meta.tools.calls, 1); assert.strictEqual(b.meta.tools.calls_list[0].name, "get_today_predictions"); assert.strictEqual(b.meta.tools.calls_list[0].ok, true);
      assert.ok(b.prediction && /52%/.test(b.prediction.prediction), JSON.stringify(b.prediction));
      assert.ok(b.prediction.basis.includes("52%") && b.prediction.caution === "特になし");
      assert.deepStrictEqual(b.followUpQuestions, ["相手の怪我人は?", "直前版で変わる?"]);
      assert.strictEqual(b.resolvedSubject.labelEn, "Arsenal");
    });
    await t("「昨日なぜ外した?」→ get_recent_misses が反省(外れ理由)を返す", async () => {
      mockLog.length = 0;
      const r = await post("/api/discuss", { question: "アーセナルの昨日の予想はなぜ外した?", subject: { type: null }, lang: "ja" });
      const b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true, r.text.slice(0, 300));
      assert.strictEqual(b.meta.tools.calls_list[0].name, "get_recent_misses");
      assert.ok(/記録にあります/.test(b.answerText), b.answerText);
    });
    await t("道具つきの往復が HTTP 400 で拒まれたら、従来の1往復でやり直して必ず答える(meta.tools に理由)", async () => {
      const r = await post("/api/discuss", { question: "BAD400 オフサイドって何?", subject: { type: null }, lang: "ja" });
      const b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true, r.text.slice(0, 300));
      assert.ok(b.answerText && b.answerText.startsWith("オフサイドは"), b.answerText);
      assert.ok(/HTTP 400/.test(b.meta.tools.fallbackReasonJa || ""), JSON.stringify(b.meta.tools));
    });
    await t("道具を使い続ける回答AIでも上限で止まり、exhausted:true を開示して答えが返る", async () => {
      const r = await post("/api/discuss", { question: "TOOLSPAM アーセナルの監督は?", subject: { type: null }, lang: "ja" });
      const b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true, r.text.slice(0, 300));
      assert.ok(b.meta.tools.exhausted === true && b.meta.tools.calls <= V104.constants.DISCUSS_TOOL_MAX_CALLS, JSON.stringify(b.meta.tools));
    });
    await t("ストリーム: status → delta(途中経過)→ reset(道具を使った)→ … → final(本文つき)の順で届く", async () => {
      const r = await post("/api/discuss/stream", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
      assert.ok(/x-ndjson/.test(r.headers["content-type"]), r.headers["content-type"]);
      const events = r.text.trim().split("\n").map((l) => JSON.parse(l));
      const types = events.map((e) => e.t);
      assert.strictEqual(types[0], "status"); assert.strictEqual(types[types.length - 1], "final");
      const resetIdx = types.indexOf("reset"); const firstDelta = types.indexOf("delta");
      assert.ok(firstDelta !== -1 && resetIdx > firstDelta, "途中経過の delta の後に reset が無い: " + types.join(","));
      const lastDeltas = events.slice(resetIdx + 1).filter((e) => e.t === "delta").map((e) => e.text).join("");
      assert.ok(lastDeltas.includes("###予想###"), lastDeltas.slice(0, 80));
      const fin = events[events.length - 1];
      assert.strictEqual(fin.body.ok, true); assert.strictEqual(fin.body.mode, "prediction"); assert.ok(fin.body.prediction.prediction.includes("52%"));
      assert.strictEqual(fin.body.meta.tools.calls, 1);
    });
  } else {
    await t("DISCUSS_TOOLS=0 では従来の1往復(道具無し)で予想の質問にも答える(meta.tools に理由)", async () => {
      const r = await post("/api/discuss", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
      const b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true); assert.strictEqual(b.mode, "prediction"); assert.strictEqual(b.meta.tools.calls, 0);
      assert.ok(/DISCUSS_TOOLS=0/.test(b.meta.tools.reasonJa), b.meta.tools.reasonJa);
      assert.ok(b.prediction && b.prediction.prediction.includes("取得できません"));
    });
  }
  await t("聞き返し: 「マンチェスターはどう?」→ mode:clarify・候補2件・LLM を呼ばない", async () => {
    mockLog.length = 0;
    const r = await post("/api/discuss", { question: "マンチェスターはどう?", subject: { type: null }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.ok, true); assert.strictEqual(b.mode, "clarify");
    assert.strictEqual(b.options.length, 2); assert.ok(b.question.includes("マンチェスター"), b.question);
    assert.strictEqual(mockLog.length, 0);
  });
  await t("議論の質問(と思う?)→ 従来の7欄のまま(劣化なし)", async () => {
    const r = await post("/api/discuss", { question: "ハイプレスは本当に有効だと思う?", subject: { type: null }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.mode, "discussion");
    assert.strictEqual(b.generalView, "一般論です。"); assert.ok(b.mostImportantOpinion.includes("最も重要"));
    assert.strictEqual(b.answerText, null);
  });
  await t("利用者の設定(profile)と10往復の history がサーバーに受け付けられ、meta に開示される", async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ q: "過去の質問" + i, a: "過去の回答" + i }));
    const r = await post("/api/discuss", { question: "オフサイドって何?", subject: { type: null }, lang: "ja", history, profile: { favoriteClub: "アーセナル", level: "beginner" } });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.meta.historyTurns, 10); assert.deepStrictEqual(b.meta.profileUsed, ["favoriteClub", "level"]);
  });

  console.log("■ J 試合内容の予測(表示・日次レポート)");
  await t("/api/predictions/today の各予想に content(合計得点・2.5点以上・両チーム得点・スコア上位3・見立て)が付く", async () => {
    V97.clearCache();
    const r = await get("/api/predictions/today");
    const b = JSON.parse(r.text);
    const p = (b.predictions || []).find((x) => x.fixtureId === 501);
    assert.ok(p, r.text.slice(0, 200));
    assert.ok(p.content && Number.isFinite(p.content.over25Pct) && Number.isFinite(p.content.bttsPct) && p.content.topScorelines.length === 3 && p.content.styleJa, JSON.stringify(p.content));
    assert.strictEqual(p.content.source, "lambda"); assert.ok(/較正中/.test(p.content.calibrationNoteJa));
  });
  await t("日次レポートに matchContent(model/today/last7Days/last30Days)がある", async () => {
    const r = await get("/api/learning/daily-report");
    const b = JSON.parse(r.text);
    assert.ok(b.matchContent && b.matchContent.model && b.matchContent.model.available === false, JSON.stringify(b.matchContent).slice(0, 200));
  });

  mock.close(); srv.server.close();
  console.log(`\nv104 conversation: ${pass} passed, ${fail} failed${legacy ? " (legacy mode)" : ""}`);
  if (!legacy && !process.env.V104_NO_CHILD) {
    // 従来の1往復(DISCUSS_TOOLS=0)でも壊れないことを別プロセスで確認
    const { spawnSync } = require("child_process");
    const child = spawnSync(process.execPath, [__filename], { env: { ...process.env, V104_LEGACY: "1", V104_NO_CHILD: "1" }, encoding: "utf-8" });
    process.stdout.write(child.stdout || "");
    if (child.status !== 0) { console.log(child.stderr || ""); fail++; }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
