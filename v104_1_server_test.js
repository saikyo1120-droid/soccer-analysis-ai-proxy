"use strict";
/**
 * v104.1(2026年11月14日): サーバーを実際に起動して確かめる結合テスト
 *   K 確信ピック … /api/predictions/today の各予想にランク(刻印/参考/対象外)・ランク別の実績、
 *                   カードの数字とランクの材料が同じ計算であること、会話の道具(ランクで絞る)、
 *                   日次レポート、毎日の学習での刻印と境の学習
 *   M 数字の裏取り … /api/discuss の回答に照合結果が付く(すべて一致/一致しない数字/一般知識/対象外)、
 *                   流れる表示の最終結果にも付く、集計に数えられる
 *   照合の修正    … resolveTeamId が追跡クラブで「確認済みのチームID」と共通の選び方を使う
 *   画面          … ランクの行・ランク別の成績・裏取りの注記が実際に描けること、4言語の辞書があること
 * 本物の Anthropic API・API-Football・Upstash は呼ばない(すべてローカルのモック)。
 */
const http = require("http");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

// ---------------------------------------------------------------------------
// モック Anthropic(道具対応)。質問文の目印で台本を切り替える。
// ---------------------------------------------------------------------------
const mockLog = [];
const textOfUser = (messages) => { const f = messages && messages[0]; return !f ? "" : (typeof f.content === "string" ? f.content : JSON.stringify(f.content)); };
const hasToolResult = (messages) => (messages || []).some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result"));
function lastToolResultText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && Array.isArray(m.content)) { const tr = m.content.find((b) => b && b.type === "tool_result"); if (tr) return String(tr.content || ""); }
  }
  return "";
}
function scriptReply(body) {
  const system = String(body.system || "");
  const messages = body.messages || [];
  const userText = textOfUser(messages);
  const tools = Array.isArray(body.tools) ? body.tools.map((x) => x.name) : [];
  const mode = system.includes("###予想###") ? "prediction" : system.includes("###一般論###") ? "discussion" : "plain";
  if (tools.length && !hasToolResult(messages)) {
    if (/自信のある/.test(userText) && tools.includes("get_today_predictions")) return { toolUse: { name: "get_today_predictions", input: { rank: "S" } } };
    if (mode === "prediction" && tools.includes("get_today_predictions")) return { toolUse: { name: "get_today_predictions", input: { team: "Arsenal" } } };
  }
  const tr = lastToolResultText(messages);
  const m = tr.match(/"confidencePct":(\d+)/);
  const conf = m ? m[1] : null;
  const qText = (userText.match(/利用者の質問: 「([^」]*)」/) || [])[1] || "";
  if (mode === "prediction") {
    const extra = (/HALLUCINATE/.test(qText) ? "得失点差は+91、シュート成功率は88.8%です。" : "")
      + (/REPEAT/.test(qText) ? "会場は82500人収容です。" : "")
      + (/ECHO/.test(qText) ? "80%には届きません。" : "");
    return { text: `###予想###\nアーセナル勝利が有利です(確信度 ${conf ? conf + "%" : "取得できません"})。\n\n###根拠###\n直近フォームと主力評価点の差が根拠です。${conf ? `確率は${conf}%です。` : ""}${extra}\n\n###注意###\n特になし\n\n###フォローアップ###\n相手の怪我人は?` };
  }
  if (mode === "discussion") {
    return { text: "###一般論###\n一般論です。\n\n###AI独自の意見###\n私の意見です。\n\n###反対意見###\n反対です。\n\n###最終結論###\n結論です。\n\n###今後どうなると思うか###\n今後です。\n\n###最も重要だと考える点###\n私は直近フォームが最も重要だと考えます。\n\n###フォローアップ###\n次は?" };
  }
  if (/自信のある/.test(userText)) {
    // 一覧では、ランクの実績は先頭の tiers.recordJa に1回だけ載る(v104.1 総点検: 1件ごとの繰り返しをやめて上限内に収めた)
    const rk = tr.match(/"recordJa":"[^"]*?S (\d+件中\d+件的中\([\d.]+%\))/);
    return { text: `自信ランクSの試合があります。${rk ? `このランクの実績: ${rk[1]}。` : "実績は取得できません。"}` };
  }
  if (/W杯/.test(userText)) return { text: "ワールドカップ(2026年大会)には48チームが出場し、決勝の会場は82500人を収容します。" };
  if (/^こんにちは/.test(userText.replace(/^[\s\S]*利用者の質問: 「/, ""))) return { text: "こんにちは。今日はどのクラブの話をしましょうか。" };
  return { text: "オフサイドは、相手ゴールに近い側で味方より前に出ている状態でパスを受ける反則です。" };
}
function sseChunks(reply, model) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
  let out = ev("message_start", { message: { id: "m1", model, usage: { input_tokens: 10 } } });
  if (reply.toolUse) {
    out += ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_" + Date.now(), name: reply.toolUse.name, input: {} } });
    out += ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input || {}) } });
    out += ev("content_block_stop", { index: 0 });
    out += ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  } else {
    out += ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const text = reply.text || "";
    for (let i = 0; i < text.length; i += 9) out += ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 9) } });
    out += ev("content_block_stop", { index: 0 });
    out += ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
  }
  return out + ev("message_stop", {});
}
function startMockAnthropic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) { body = {}; }
        const reply = scriptReply(body);
        mockLog.push({ stream: !!body.stream, toolUse: reply.toolUse ? reply.toolUse : null, system: String(body.system || "") });
        if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sseChunks(reply, body.model)); return; }
        const content = reply.toolUse ? [{ type: "tool_use", id: "tu_" + Date.now(), name: reply.toolUse.name, input: reply.toolUse.input || {} }] : [{ type: "text", text: reply.text || "" }];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content, stop_reason: reply.toolUse ? "tool_use" : "end_turn", model: body.model, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** index.html から関数の本体を名前で取り出す(波かっこの対応を数える) */
function extractFunction(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, "関数が見つからない: " + name);
  let i = html.indexOf("{", html.indexOf(")", start));
  let depth = 0, inStr = null, inTpl = 0;
  for (let j = i; j < html.length; j++) {
    const ch = html[j], prev = html[j - 1];
    if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "`") { inTpl = inTpl ? 0 : 1; continue; }
    if (inTpl) { continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error("関数の終わりが見つからない: " + name);
}

(async () => {
  const mock = await startMockAnthropic();
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${mock.address().port}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "light-model"; process.env.ANTHROPIC_MODEL_HEAVY = "heavy-model";
  process.env.PORT = "0"; process.env.API_FOOTBALL_KEY = "k";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  process.env.RATE_LIMIT_PER_MINUTE = "100000"; process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000"; process.env.LINEUP_WATCH = "0";
  process.env.PER_IP_LLM_CALLS_PER_DAY = "1000"; process.env.MAX_LLM_CALLS_PER_DAY = "100000"; process.env.DISCUSS_MULTISTEP = "0";

  const srv = require(path.join(__dirname, "server.js"));
  const V104 = srv.__v104ForTest; const V97 = srv.__v97ForTest;
  const T = require(path.join(__dirname, "learning/confidenceTiers.js"));
  const IM = require(path.join(__dirname, "learning/intelligenceMetrics.js"));
  const discussTools = require(path.join(__dirname, "discuss/tools.js"));
  const U = require(path.join(__dirname, "learning/clubUniverse.js"));
  const { createClubDossier } = require(path.join(__dirname, "knowledge/clubDossier.js"));

  // ---- 保存先と外部 API のモック ----
  const store = new Map();
  const opLog = []; let mgetOff = false; // 往復の数え上げ用 / MGET に対応しない保存先の再現用
  const cmd = async (c) => { const [op, ...a] = c;
    opLog.push({ op, keys: a.slice() });
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return mgetOff ? null : a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "LRANGE") return store.get(a[0]) || [];
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "EXPIRE" || op === "LTRIM") return 1;
    return null; };
  const getJSON = async (k) => { const r = await cmd(["GET", k]); return r === null ? null : JSON.parse(r); };
  const setJSON = async (k, v) => { await cmd(["SET", k, JSON.stringify(v)]); return true; };
  const now = Date.now(); const kickoff = new Date(now + 3 * 3600000).toISOString();
  const fx = (id, hid, hn, aid, an, lid, ln) => ({ fixture: { id, date: kickoff, status: { short: "NS" }, venue: { name: "Stadium" } }, league: { id: lid, name: ln, country: "England" }, teams: { home: { id: hid, name: hn, logo: "" }, away: { id: aid, name: an, logo: "" } }, goals: { home: null, away: null } });
  const apiCalls = [];
  let teamsSearch = () => [];
  srv.__setTestHooks({
    upstashCmd: cmd, upstashGetJSON: getJSON, upstashSetJSON: setJSON,
    callApiFootball: async (ep, p) => {
      apiCalls.push({ ep, p: { ...(p || {}) } });
      if (ep === "/fixtures" && p && p.date) return { response: [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League"), fx(502, 50, "Manchester City", 998, "Northfield", 39, "Premier League"), fx(503, 33, "Manchester United", 997, "Sabah FA", 667, "Friendlies Clubs")] };
      if (ep === "/teams" && p && p.search) return { response: teamsSearch(String(p.search)) };
      return { response: [] };
    },
  });
  const MAP = { available: true, minN: 20, bins: { "33-45%": { n: 214, avgConfPct: 40.5, actualHitPct: 47.2 }, "45-55%": { n: 167, avgConfPct: 50, actualHitPct: 56.3 }, "55-70%": { n: 187, avgConfPct: 62, actualHitPct: 61.5 }, "70+%": { n: 98, avgConfPct: 78.5, actualHitPct: 73.5 } } };
  const rowT = (n, hits) => ({ n, hits, confSum: n * 0.6, hitPct: n ? Math.round((hits / n) * 1000) / 10 : null, avgConfPct: 60, lowPct: 50, sharePct: 25 });
  const tbl = (s, a, b, k) => ({ S: rowT(...s), A: rowT(...a), B: rowT(...b), skip: rowT(...k), total: s[0] + a[0] + b[0] + k[0] });
  const TIER_MODEL = { v: 1, fittedAt: "2026-11-14T00:40:00.000Z", target: 0.75, thresholds: { tS: 0.7, tA: 0.6, tSkip: 0.5 }, adopted: false, decision: "kept_default", reasonJa: "既定のままにしました。",
    samples: { total: 980, train: 686, valid: 294 }, candidates: [],
    table: { all: tbl([150, 112], [290, 181], [300, 160], [240, 110]), last30: tbl([61, 46], [120, 76], [131, 71], [100, 46]) },
    forward: { all: tbl([5, 4], [12, 8], [10, 5], [9, 4]), last30: tbl([5, 4], [12, 8], [10, 5], [9, 4]) } };
  const baseRec = (id, home, away, p, extra) => ({ fixtureId: id, homeTeamEn: home, awayTeamEn: away, predictedWinner: "home", homeLambda: 1.6, awayLambda: 1.0, resolved: false, kickoff, weightsVersion: 33, loggedAt: "2026-11-14T00:30:00Z", leagueId: 39, league: "Premier League", leagueCountry: "England",
    finalProbs: { homeWin: p, draw: Math.round((1 - p) * 0.55 * 100) / 100, awayWin: Math.round((1 - p) * 0.45 * 100) / 100, source: "market_blend" }, factorImportance: [{ key: "formDiff", labelJa: "直近フォーム", stars: 4 }], supplied: { formDiff: true }, official: true, learnedCompetition: true, ...(extra || {}) });
  store.set("learn:calibration:map", JSON.stringify(MAP));
  store.set(T.MODEL_KEY, JSON.stringify(TIER_MODEL));
  store.set("learn:ownpred:501", JSON.stringify(baseRec(501, "Arsenal", "Dibrados FC", 0.52)));                                    // 刻印なし(v104.1 より前の予想)→ 参考値
  store.set("learn:ownpred:502", JSON.stringify(baseRec(502, "Manchester City", "Northfield", 0.78, { tier: { rank: "S", conf: 0.74, rawConf: 0.78, basis: "bin", tS: 0.7, tA: 0.6, tSkip: 0.5, v: 1 } }))); // 刻印あり
  store.set("learn:ownpred:503", JSON.stringify(baseRec(503, "Manchester United", "Sabah FA", 0.8, { official: false, league: "Friendlies Clubs", tier: { rank: null, conf: null, tS: 0.7, tA: 0.6, tSkip: 0.5, v: 1, reasonJa: "親善試合・2軍の試合のため、ランクの対象外です。" } })));
  store.set("learn:ratings:v1", JSON.stringify({ byTeam: { 42: { att: 1.2, def: 0.9 }, 50: { att: 1.3, def: 0.8 }, 33: { att: 1.1, def: 1 } }, namesById: { 42: "Arsenal", 50: "Manchester City", 33: "Manchester United" }, matches: 1000 }));
  store.set("learn:teamnames", JSON.stringify({ 42: "Arsenal", 50: "Manchester City", 33: "Manchester United" }));
  store.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル" }] }));
  V97.clearCache();
  await new Promise((r) => srv.server.on("listening", r));
  const port = srv.server.address().port;
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => { let buf = ""; res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf })); });
    req.on("error", reject); req.end(data);
  });
  const get = (p) => new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: p }, (res) => { let buf = ""; res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf })); }).on("error", reject); });
  const ask = async (question, extra) => JSON.parse((await post("/api/discuss", { question, subject: { type: null }, lang: "ja", ...(extra || {}) })).text);

  // ================= K: 今日の予想とランク =================
  console.log("■ K 確信ピック(サーバー)");
  let today = null;
  await t("K-S1 /api/predictions/today: 刻印ありはそのまま(S)・刻印なしは今の基準で導いた参考値・親善試合は対象外(理由つき)。ランクの実績つき", async () => {
    const r = await get("/api/predictions/today");
    today = JSON.parse(r.text);
    assert.strictEqual(today.found, true, r.text.slice(0, 300));
    const by = (id) => today.predictions.find((p) => p.fixtureId === id);
    const p502 = by(502), p501 = by(501), p503 = by(503);
    assert.deepStrictEqual([p502.tier.rank, p502.tier.labelJa, p502.tier.confPct, p502.tier.stamped], ["S", "確信", 74, true]);
    assert.deepStrictEqual([p502.tier.record.basis, p502.tier.record.window, p502.tier.record.n, p502.tier.record.hitPct], ["backtest", "last30", 61, 75.4], "前向きの実績が5件(20件未満)なので、当てはめの実測を出す");
    // 刻印なし: 最終確率52% → 帯ごとの実測をつないだ曲線で補正((50→56.3)と(62→61.5)のあいだ: 56.3+(2/12)×5.2=57.2)→ 57% → B(参考値)。カードの数字と同じ
    assert.deepStrictEqual([p501.tier.rank, p501.tier.labelJa, p501.tier.stamped, p501.tier.confPct], ["B", "やや優勢", false, 57]);
    assert.strictEqual(p501.confidence.displayPct, 57, "カードに出る自信と、ランクの材料が同じ数字");
    assert.deepStrictEqual([p501.confidence.rawPct, p501.confidence.method, p501.confidence.basisN], [52, "bin", 167 + 187], "材料は 45-55% の帯と 55-70% の帯の実測");
    assert.deepStrictEqual([p503.tier.rank, p503.tier.stamped], [null, true]); assert.ok(/対象外/.test(p503.tier.reasonJa));
    // 予想そのものは変えていない
    assert.strictEqual(p502.predictedWinner, "home"); assert.strictEqual(p502.probs.homeWinPct, 78);
  });
  await t("K-S2 /api/predictions/today: ランクの境とランク別の実績(当てはめ/前向き)を返す。件数の少ないランクも件数ごと返す", async () => {
    const tiers = today.tiers;
    assert.deepStrictEqual(tiers.thresholds, { sPct: 70, aPct: 60, skipPct: 50 });
    assert.deepStrictEqual(tiers.ranks.map((x) => [x.rank, x.labelJa]), [["S", "確信"], ["A", "有力"], ["B", "やや優勢"], ["skip", "見送り"]]);
    assert.deepStrictEqual(tiers.backtest.last30.map((x) => [x.rank, x.n, x.hitPct]), [["S", 61, 75.4], ["A", 120, 63.3], ["B", 131, 54.2], ["skip", 100, 46]]);
    assert.strictEqual(tiers.backtest.totalLast30, 412); assert.strictEqual(tiers.forward.totalAll, 36);
    assert.ok(/見送り/.test(tiers.noteJa) && /公式戦/.test(tiers.noteJa));
    // ランクのモデルが無い環境(導入直後)でも壊れない: 既定の境・実績は null
    store.delete(T.MODEL_KEY); V97.clearCache();
    const r2 = JSON.parse((await get("/api/predictions/today")).text);
    assert.strictEqual(r2.tiers.available, false); assert.deepStrictEqual(r2.tiers.thresholds, { sPct: 70, aPct: 60, skipPct: 50 }); assert.strictEqual(r2.tiers.backtest, null);
    const p502 = r2.predictions.find((p) => p.fixtureId === 502);
    assert.strictEqual(p502.tier.rank, "S"); assert.strictEqual(p502.tier.record, null, "実績が無いときは作らない");
    store.set(T.MODEL_KEY, JSON.stringify(TIER_MODEL)); V97.clearCache();
  });
  await t("K-S3 カードの数字(confidence.displayPct)とランクの材料(displayConfOf)は、どんな確率・補正の状態でも一致する", async () => {
    const fixture = { id: 1, date: kickoff, status: "NS", league: "Serie A", home: { name: "A" }, away: { name: "B" } };
    let n = 0;
    for (const map of [null, MAP, { available: true, minN: 20, bins: { "55-70%": { n: 50, avgConfPct: 60, actualHitPct: 70 } } }]) {
      for (let p = 0.34; p <= 0.951; p += 0.01) {
        for (const temp of [false, true]) {
          const pr = Math.round(p * 100) / 100;
          const record = baseRec(1, "A", "B", pr, temp ? { rawFinalProbs: { homeWin: pr - 0.05, draw: 0.3, awayWin: 0.2 }, probCalibration: { applied: true, T: 0.8, regime: "odds" } } : {});
          // 記録の確率は正規化されて使われるので、合計1になるよう整える
          record.finalProbs = { homeWin: pr, draw: Math.round((1 - pr) * 0.6 * 1e4) / 1e4, awayWin: Math.round((1 - pr) * 0.4 * 1e4) / 1e4, source: "x" };
          const entry = V104.buildTodayPredictionEntry(fixture, record, map, null, TIER_MODEL);
          const dc = T.displayConfOf(record, map);
          assert.strictEqual(entry.confidence.displayPct, Math.round(dc.conf * 100), `p=${pr} temp=${temp} map=${map ? Object.keys(map.bins).length : 0}`);
          assert.strictEqual(entry.tier.confPct, entry.confidence.displayPct);
          assert.strictEqual(entry.tier.rank, T.rankOf(dc.conf, T.thresholdsOf(TIER_MODEL)));
          n++;
        }
      }
    }
    assert.ok(n > 300);
  });
  await t("K-S4 会話の道具: ランクで絞れる(rank:S)・自信の高い順・ランク別の件数と実績の文を添える。該当なしは理由を返す", async () => {
    V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const all = await discussTools.executeTool("get_today_predictions", {}, deps);
    assert.strictEqual(all.ok, true, all.resultJson.slice(0, 200));
    assert.deepStrictEqual(all.data.rankCounts, { S: 1, A: 0, B: 1, skip: 0, none: 1 });
    assert.deepStrictEqual(all.data.predictions.map((p) => p.fixtureId), [503, 502, 501], "自信の高い順(80 → 73 → 57)");
    const p502 = all.data.predictions.find((p) => p.fixtureId === 502);
    assert.deepStrictEqual([p502.rank, p502.rankLabelJa], ["S", "確信"]);
    // ランクの実績は、一覧の先頭(tiers.recordJa)に1回だけ載せる(v104.1 総点検: 1件ごとに同じ文を繰り返すと、
    //   8件で回答AIに渡せる上限 6,000 文字を超えて後ろが切れていた)。1件ごとの rankRecordJa は一覧には付けない。
    assert.strictEqual(p502.rankRecordJa, undefined, "一覧の1件ごとに実績の文を繰り返さない");
    assert.ok(/当てはめた実測: S 61件中46件的中\(75\.4%\) \/ A 120件中76件的中\(63\.3%\)/.test(all.data.tiers.recordJa), all.data.tiers.recordJa);
    // 1試合の詳細(get_prediction_detail)では、その試合のランクの実績を従来どおり添える
    const det = await discussTools.executeTool("get_prediction_detail", { fixtureId: 502 }, deps);
    assert.ok(det.ok && /61件中46件的中\(75\.4%\)/.test(det.data.rankRecordJa) && /当てはめた実測/.test(det.data.rankRecordJa), JSON.stringify(det.data).slice(0, 300));
    const p503 = all.data.predictions.find((p) => p.fixtureId === 503);
    // 対象外の試合: ランクの項目そのものを載せず(一覧では値の無い項目を省く)、理由(rankNoteJa)だけを添える
    assert.ok(p503.rank == null && !("rankLabelJa" in p503)); assert.ok(/対象外/.test(p503.rankNoteJa));
    assert.ok(/S: 自信70%以上/.test(all.data.tiers.thresholdsJa), JSON.stringify(all.data.tiers));
    // 上限内に収まり、途中で切れていない(JSON として読める・末尾の一覧まで入っている)
    assert.ok(all.resultJson.length <= discussTools.MAX_RESULT_CHARS, "道具の結果が上限を超えている: " + all.resultJson.length);
    assert.doesNotThrow(() => JSON.parse(all.resultJson), "道具の結果が途中で切れている");
    const onlyS = await discussTools.executeTool("get_today_predictions", { rank: "S" }, deps);
    assert.deepStrictEqual(onlyS.data.predictions.map((p) => p.fixtureId), [502]); assert.strictEqual(onlyS.data.rankFilter, "S"); assert.ok(/ランクS/.test(onlyS.summaryJa));
    const none = await discussTools.executeTool("get_today_predictions", { rank: "skip" }, deps);
    assert.strictEqual(none.data.count, 0); assert.ok(/見送り/.test(none.data.noteJa) && /rankCounts/.test(none.data.noteJa));
    const bad = await discussTools.executeTool("get_today_predictions", { rank: "ZZZ" }, deps);
    assert.strictEqual(bad.data.rankFilter, null); assert.strictEqual(bad.data.count, 3, "不正なランク指定は無視して全件");
    // 道具の定義と指示
    const defs = discussTools.toolDefinitions(deps);
    const def = defs.find((d) => d.name === "get_today_predictions");
    assert.deepStrictEqual(def.input_schema.properties.rank.enum, ["S", "A", "B", "skip"]);
    const sys = V104.buildDiscussSystemPrompt("ja", "prediction", { tools: true });
    assert.ok(/自信ランク/.test(sys) && /「見送り」の試合を勧めないでください/.test(sys) && /機械的に照合/.test(sys));
  });
  await t("K-S5 会話の道具: 的中率の実測にランクの境と当てはめ/前向きの実績が載る(導入直後から答えられる)", async () => {
    V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const s = await discussTools.executeTool("get_accuracy_summary", {}, deps);
    assert.strictEqual(s.ok, true);
    const cr = s.data.confidenceRanks;
    assert.ok(cr && /S\(確信\): 自信70%以上/.test(cr.thresholdsJa), JSON.stringify(cr).slice(0, 200));
    assert.deepStrictEqual(cr.backtest.last30.map((x) => [x.rank, x.n, x.hitPct])[0], ["S", 61, 75.4]);
    assert.strictEqual(cr.forward.all[0].n, 5);
  });

  // ================= M: 数字の裏取り(会話) =================
  console.log("■ M 数字の裏取り(サーバー)");
  await t("M-S1 予想の質問: 回答の数字(道具で取った確信度)がすべて取得データにある → all_supported。集計に数える", async () => {
    V97.clearCache();
    const before = IM.pendingGrounding();
    const r = await ask("アーセナルは今日勝てる?");
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 300)); assert.strictEqual(r.mode, "prediction");
    assert.ok(/57%/.test(r.prediction.prediction), r.prediction.prediction);
    assert.deepStrictEqual([r.grounding.verdict, r.grounding.checked, r.grounding.supported, r.grounding.unsupportedCount, r.grounding.dataUsed], ["all_supported", 1, 1, 0, true], JSON.stringify(r.grounding));
    assert.ok(r.meta.tools.calls >= 1);
    const after = IM.pendingGrounding();
    assert.strictEqual(after.answers - before.answers, 1); assert.strictEqual(after.allSupported - before.allSupported, 1); assert.strictEqual(after.numbersChecked - before.numbersChecked, 1);
  });
  await t("M-S2 取得データに無い数字が混ざった回答: partial。該当の数字だけを挙げ、「計算した値や、AIの推定・一般知識による値の場合があります」と添える", async () => {
    const before = IM.pendingGrounding();
    const r = await ask("アーセナルは今日勝てる? HALLUCINATE");
    assert.strictEqual(r.grounding.verdict, "partial", JSON.stringify(r.grounding));
    assert.deepStrictEqual(r.grounding.unsupported.map((u) => u.text), ["91", "88.8%"]);
    assert.deepStrictEqual([r.grounding.checked, r.grounding.supported, r.grounding.unsupportedCount], [3, 1, 2]);
    assert.strictEqual(r.grounding.noteJa, "照合した数字3個のうち1個は取得したデータと一致しました。次の数字は、取得したデータに同じ値が見当たりません(AIが計算した値や、AIの推定・一般知識による値の場合があります): 91、88.8%。");
    assert.deepStrictEqual([r.grounding.fromQuestion, r.grounding.repeated], [0, 0]);
    assert.strictEqual(IM.pendingGrounding().withUnsupported - before.withUnsupported, 1);
    assert.ok(r.prediction.basis.includes("88.8%"), "回答の本文は書き換えない(注記するだけ)");
  });
  await t("M-S3 実データを使っていない回答(一般知識): general_knowledge(一致/不一致とは呼ばない)。西暦は数えない", async () => {
    const r = await ask("W杯の出場国数を教えて");
    assert.strictEqual(r.mode, "fact"); assert.ok(/48チーム/.test(r.answerText));
    assert.deepStrictEqual([r.grounding.verdict, r.grounding.dataUsed, r.grounding.unsupported.map((u) => u.text)], ["general_knowledge", false, ["48", "82500"]], JSON.stringify(r.grounding));
    assert.ok(/一般知識/.test(r.grounding.noteJa));
  });
  await t("M-S4 数字の無い回答は verdict:none(注記なし)。挨拶・聞き返しは照合の対象外(grounding は null/無し)", async () => {
    const f = await ask("オフサイドって何?");
    assert.strictEqual(f.mode, "fact"); assert.deepStrictEqual([f.grounding.verdict, f.grounding.noteJa], ["none", null]);
    const s = await ask("こんにちは");
    assert.strictEqual(s.mode, "smalltalk"); assert.strictEqual(s.grounding, null);
    const d = await ask("ハイプレスは本当に有効だと思う?");
    assert.strictEqual(d.mode, "discussion"); assert.strictEqual(d.grounding.verdict, "none");
  });
  await t("M-S5 流れる表示(/api/discuss/stream)の最終結果にも裏取りが付く", async () => {
    const r = await post("/api/discuss/stream", { question: "アーセナルは今日勝てる? HALLUCINATE", subject: { type: null }, lang: "ja" });
    const events = r.text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fin = events.find((e) => e.t === "final");
    assert.ok(fin && fin.body && fin.body.ok === true, r.text.slice(-300));
    assert.strictEqual(fin.body.grounding.verdict, "partial"); assert.deepStrictEqual(fin.body.grounding.unsupported.map((u) => u.text), ["91", "88.8%"]);
  });
  await t("M-S7 出どころを混ぜない(会話の文脈つき): 前の回答の数字を繰り返しても「一致」にしない。利用者が書いた数字の引用は照合しない", async () => {
    const hist = [{ q: "W杯の出場国数を教えて", a: "ワールドカップ(2026年大会)には48チームが出場し、決勝の会場は82500人を収容します。" }];
    const before = IM.pendingGrounding();
    // 実データ(道具)を使う回答の中で、前の回答(一般知識)の数字 82500 を繰り返す
    const r = await ask("アーセナルは今日勝てる? REPEAT", { history: hist });
    assert.strictEqual(r.mode, "prediction"); assert.ok(r.prediction.basis.includes("82500人"), r.prediction.basis);
    assert.deepStrictEqual([r.grounding.verdict, r.grounding.checked, r.grounding.supported, r.grounding.repeated, r.grounding.unsupportedCount], ["all_supported", 1, 1, 1, 0], JSON.stringify(r.grounding));
    assert.strictEqual(r.grounding.noteJa, "照合した数字1個は、すべて取得したデータにある数字と一致しました。 ほかに1個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。");
    // 同じ回答でも、前の回答に無ければ「取得したデータに見当たらない数字」
    const r2 = await ask("アーセナルは今日勝てる? REPEAT");
    assert.deepStrictEqual([r2.grounding.verdict, r2.grounding.unsupported.map((u) => u.text), r2.grounding.repeated], ["partial", ["82500"], 0], JSON.stringify(r2.grounding));
    // 実データを使わない回答が、前の回答の数字をそのまま繰り返した場合(黙って通さず、繰り返しだと伝える)
    const r3 = await ask("W杯の出場国数をもう一度教えて", { history: hist });
    assert.strictEqual(r3.mode, "fact");
    assert.deepStrictEqual([r3.grounding.verdict, r3.grounding.repeated, r3.grounding.checked, r3.grounding.dataUsed], ["repeated_only", 2, 0, false], JSON.stringify(r3.grounding));
    assert.strictEqual(r3.grounding.noteJa, "この回答の数字2個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。");
    // 利用者が質問に書いた数字(80%)の引用は照合しない。道具で取った 57% だけを照合する
    const r4 = await ask("アーセナルは今日勝てる? 80%くらい? ECHO");
    assert.ok(r4.prediction.basis.includes("80%には届きません"), r4.prediction.basis);
    assert.deepStrictEqual([r4.grounding.verdict, r4.grounding.checked, r4.grounding.supported, r4.grounding.fromQuestion, r4.grounding.unsupportedCount], ["all_supported", 1, 1, 1, 0], JSON.stringify(r4.grounding));
    // 集計: 繰り返しの個数は別に数え、裏取り率(一致/照合)には入れない
    const after = IM.pendingGrounding();
    assert.strictEqual(after.numbersRepeated - before.numbersRepeated, 3, "1(REPEAT)+2(W杯の繰り返し)");
    assert.strictEqual(after.numbersChecked - before.numbersChecked, 1 + 2 + 1, "REPEAT: 57% / REPEATのみ: 57%・82500 / ECHO: 57%");
    assert.strictEqual(after.numbersSupported - before.numbersSupported, 3);
    // 配線: 会話の処理は、出どころの仕分け(buildSources)を通して照合している
    const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(/discussGrounding\.buildSources\(\{\s*facts, reasoningBlock: reasoningPromptBlock, toolTexts: groundingToolTexts, stats,/.test(SERVER) && !/corpusTexts: \[userPrompt/.test(SERVER), "プロンプト全体(質問・会話の文脈を含む)を照合先にしていない");
  });
  await t("M-S6 「自信のある試合は?」: 回答AIが rank:S で道具を呼び、ランクの実績(取得データの数字)を引用 → すべて一致", async () => {
    const r = await ask("今日の自信のある試合は?");
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 300));
    const used = mockLog.filter((x) => x.toolUse && x.toolUse.name === "get_today_predictions" && x.toolUse.input && x.toolUse.input.rank === "S");
    assert.ok(used.length >= 1, "rank:S で道具が呼ばれている");
    assert.ok(/ランクS/.test(JSON.stringify(r.meta.tools.calls_list)), JSON.stringify(r.meta.tools.calls_list));
    assert.ok(/61件中46件的中\(75\.4%\)/.test(r.answerText), r.answerText);
    assert.strictEqual(r.grounding.verdict, "all_supported", JSON.stringify(r.grounding));
    assert.deepStrictEqual([r.grounding.checked, r.grounding.supported], [3, 3], "61・46・75.4%(「直近30日」は期間の言い回しなので数えない)");
  });

  // ================= 日次レポート =================
  console.log("■ 日次レポート");
  await t("R1 /api/learning/daily-report: confidenceTiers(model/today/last7Days/last30Days)・answerGrounding・照合の本人確認(universeIdentity)が載る", async () => {
    V97.clearCache();
    const jstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date().toISOString(), runsToday: 1, errors: [], warnings: { count: 0, items: [] },
      confidenceTiers: { fitted: true, saved: true, stampedToday: { S: 3, A: 9, B: 14, skip: 11, none: 6 }, decision: "kept_default", reasonJa: "既定のままにしました。" },
      universe: { coreClubsUpdated: 192, coreClubsPlanned: 192, skipped: [{ stage: "teamIdentity", reasonJa: "バイエルン・ミュンヘンの照合先が誤っていたため…照合し直しました。" }], errors: [], unresolvedClubs: [],
        identity: { checked: 190, verified: 188, healed: 1, cleared: 0, deferred: 0, suspectKept: 2 },
        identityFixes: [{ nameEn: "Bayern Munich", nameJa: "バイエルン・ミュンヘン", status: "healed", previousTeamId: 9001, previousApiName: "Bayern Munich W", teamId: 157, apiName: "Bayern München", evidenceJa: "提供元での登録名が「Bayern Munich W」でした", viaJa: "所属リーグの順位表(リーグID 78)" }],
        playerIndex: { built: true, count: 9380, newRows: 31, carriedOver: 2100, droppedStale: 4, droppedWrongTeam: 13 } } }));
    const acc = require(path.join(__dirname, "learning/accuracyTracker.js"));
    const sc = (tier, hit, conf) => ({ official: true, league: "Serie A", learned: true, tier, markets: { oneX2: { hit, brier: 0.4, logLoss: 0.6, confidence: conf, predicted: "home", actual: hit ? "home" : "away", probs: { homeWin: conf, draw: 0.2, awayWin: 0.2 } } } });
    const yKey = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    store.set(`learn:accuracy:${yKey}`, JSON.stringify(acc.buildDailyAccuracy([sc("S", true, 0.74), sc("S", false, 0.72), sc("A", true, 0.63), sc("skip", false, 0.45)])));
    IM.recordGroundingSample({ verdict: "all_supported", checked: 2, supported: 2, dataUsed: true });
    // 数字の裏取りの保存済みの集計: 今日(10個中9個一致)・昨日(20個中15個一致)・9日前(窓の外=数に入れない)
    const gRow = (answers, checked, supported, clean) => ({ grounding: { answers, withNumbers: answers, numbersChecked: checked, numbersSupported: supported, allSupported: clean, withUnsupported: answers - clean, generalKnowledge: 0 } });
    const d9Key = new Date(Date.now() + 9 * 3600000 - 9 * 86400000).toISOString().slice(0, 10);
    store.set(`learn:intel:${jstToday}`, JSON.stringify(gRow(4, 10, 9, 3)));
    store.set(`learn:intel:${yKey}`, JSON.stringify(gRow(6, 20, 15, 2)));
    store.set(`learn:intel:${d9Key}`, JSON.stringify(gRow(50, 500, 100, 1)));
    opLog.length = 0;
    const r = await get(`/api/learning/daily-report?d=${Date.now()}`);
    assert.strictEqual(r.status, 200, r.text.slice(0, 300));
    const b = JSON.parse(r.text);
    const opsFirst = opLog.slice();
    assert.strictEqual(b.confidenceTiers.model.available, true); assert.deepStrictEqual(b.confidenceTiers.model.thresholds, { tS: 0.7, tA: 0.6, tSkip: 0.5 });
    assert.ok(/S: 自信70%以上/.test(b.confidenceTiers.model.thresholdsJa));
    assert.deepStrictEqual(b.confidenceTiers.today.stampedToday, { S: 3, A: 9, B: 14, skip: 11, none: 6 });
    assert.strictEqual(b.confidenceTiers.last7Days.measurable, true); assert.deepStrictEqual([b.confidenceTiers.last7Days.S.n, b.confidenceTiers.last7Days.S.hitPct], [2, 50]);
    assert.strictEqual(b.confidenceTiers.model.table.last30.S.hitPct, 75.4);
    assert.ok(b.answerGrounding && b.answerGrounding.pending && b.answerGrounding.pending.answers >= 1, JSON.stringify(b.answerGrounding).slice(0, 200));
    assert.ok(/機械的に照合/.test(b.answerGrounding.noteJa));
    // today=今日の保存分 / last7Days=その前の7日間(今日を含まない・窓の外の日も含まない)
    assert.strictEqual(b.answerGrounding.available, true);
    assert.deepStrictEqual([b.answerGrounding.today.answers, b.answerGrounding.today.groundedRatePct], [4, 90]);
    assert.deepStrictEqual([b.answerGrounding.last7Days.answers, b.answerGrounding.last7Days.groundedRatePct], [6, 75]);
    assert.strictEqual(b.answerGrounding.recordedDays, 2);
    assert.ok(/今日を含みません/.test(b.answerGrounding.noteJa));
    // 往復: モデル3つ(較正・試合内容・自信ランク)と裏取り8日ぶんは MGET 1回。モデルを GET で1つずつ読まない
    const PC = require(path.join(__dirname, "learning/probCalibration.js")); const MC = require(path.join(__dirname, "learning/matchContent.js"));
    const modelKeys = [PC.MODEL_KEY, MC.MODEL_KEY, T.MODEL_KEY];
    const bundled = opsFirst.filter((o) => o.op === "MGET" && modelKeys.every((k) => o.keys.includes(k)));
    assert.strictEqual(bundled.length, 1, "モデル3つをまとめた MGET が1回でない: " + bundled.length);
    assert.strictEqual(bundled[0].keys.length, 3 + 8, "MGET のキー数(モデル3+裏取り8日): " + bundled[0].keys.length);
    assert.strictEqual(bundled[0].keys.filter((k) => /^learn:intel:\d{4}-\d{2}-\d{2}$/.test(k)).length, 8);
    assert.strictEqual(opsFirst.filter((o) => o.op === "GET" && modelKeys.includes(o.keys[0])).length, 0, "モデルを GET で個別に読んでいる");
    assert.strictEqual(opsFirst.filter((o) => (o.op === "GET" || o.op === "MGET") && o.keys.some((k) => /^learn:intel:\d{4}-/.test(k))).length, 1, "裏取りの集計を2回以上読んでいる");
    assert.deepStrictEqual(b.updates.universeIdentity, { checked: 190, verified: 188, healed: 1, cleared: 0, deferred: 0, suspectKept: 2 });
    assert.strictEqual(b.updates.universeIdentityFixes[0].apiName, "Bayern München"); assert.strictEqual(b.updates.universePlayerIndex.droppedWrongTeam, 13);
    assert.ok(b.updates.universeSkipped.some((s) => s.stage === "teamIdentity"));
    // 旧い学習記録(項目が無い)でも壊れない
    store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date().toISOString(), errors: [] })); store.delete(T.MODEL_KEY); V97.clearCache();
    const b2 = JSON.parse((await get(`/api/learning/daily-report?d=${Date.now() + 1}`)).text);
    assert.strictEqual(b2.confidenceTiers.model.available, false); assert.strictEqual(b2.confidenceTiers.today, null); assert.strictEqual(b2.updates.universeIdentity, null); assert.deepStrictEqual(b2.updates.universeIdentityFixes, []);
    store.set(T.MODEL_KEY, JSON.stringify(TIER_MODEL));
  });

  await t("R2 日次レポート: MGET に対応しない保存先でも、モデルと裏取りの集計は同じ内容で返る(1件ずつの GET に落ちる)", async () => {
    V97.clearCache();
    const a = JSON.parse((await get(`/api/learning/daily-report?d=${Date.now() + 2}`)).text);
    V97.clearCache(); mgetOff = true; opLog.length = 0;
    let bOff;
    try { bOff = JSON.parse((await get(`/api/learning/daily-report?d=${Date.now() + 3}`)).text); } finally { mgetOff = false; }
    assert.strictEqual(a.confidenceTiers.model.available, true); assert.strictEqual(a.answerGrounding.available, true);
    assert.deepStrictEqual(bOff.confidenceTiers.model, a.confidenceTiers.model);
    assert.deepStrictEqual(bOff.matchContent.model, a.matchContent.model);
    assert.deepStrictEqual(bOff.probCalibration.model, a.probCalibration.model);
    assert.deepStrictEqual([bOff.answerGrounding.available, bOff.answerGrounding.today, bOff.answerGrounding.last7Days], [true, a.answerGrounding.today, a.answerGrounding.last7Days]);
    assert.ok(opLog.some((o) => o.op === "GET" && o.keys[0] === T.MODEL_KEY), "MGET 非対応のときは GET で読む");
  });

  await t("R3 日次レポート: 保存先が読めないとき、裏取りは「読めなかった」と正直に返し(0件と言わない)、モデルは未取得として扱う", async () => {
    V97.clearCache();
    const IMk = IM.groundingTrendKeys(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
    assert.strictEqual(IMk.length, 8);
    const tr = IM.groundingTrendFromValues("2026-11-14", { values: [], readFailed: true, firstError: "timeout" });
    assert.strictEqual(tr.available, false); assert.strictEqual(tr.readFailed, true); assert.ok(/読み出せませんでした\(timeout\)/.test(tr.reasonJa) && /記録が無いという意味ではありません/.test(tr.reasonJa));
    assert.ok(tr.pending && typeof tr.pending.answers === "number", "未保存分(メモリ)は読めなくても返す");
    const off = IM.groundingTrendFromValues("2026-11-14", { upstashEnabled: false });
    assert.strictEqual(off.available, false); assert.ok(/Upstash未設定/.test(off.reasonJa));
    // 値の並びがキーと同じであること(今日が先頭): 今日だけ記録がある場合
    const one = IM.groundingTrendFromValues("2026-11-14", { values: [{ grounding: { answers: 2, withNumbers: 2, numbersChecked: 4, numbersSupported: 4, allSupported: 2, withUnsupported: 0, generalKnowledge: 0 } }, null, null, null, null, null, null, null] });
    assert.deepStrictEqual([one.available, one.today.answers, one.last7Days.measurable, one.recordedDays], [true, 2, false, 1]);
  });

  // ================= 照合の修正(resolveTeamId) =================
  console.log("■ クラブ照合(resolveTeamId)");
  const cd = createClubDossier({ upstashEnabled: true, upstashCmd: cmd, upstashGetJSON: getJSON, upstashSetJSON: setJSON });
  await t("C1 追跡クラブ: 毎晩の収集が確認したチームIDがあれば、検索せずそれを使う(API 0回)", async () => {
    V97.clearCache();
    await cd.updateSection("Bayern Munich", "form", { currentFormScore: 2 }, { nameJa: "バイエルン・ミュンヘン", teamId: 157, identityVerified: { teamId: 157, apiName: "Bayern München", at: "2026-11-15T00:20:00.000Z" } });
    const n0 = apiCalls.filter((c) => c.ep === "/teams").length;
    teamsSearch = () => [{ team: { id: 9001, name: "Bayern Munich W" } }];
    const id = await srv.resolveTeamId("Bayern Munich");
    assert.strictEqual(id, 157); assert.strictEqual(apiCalls.filter((c) => c.ep === "/teams").length, n0, "検索していない");
    assert.strictEqual(await srv.resolveTeamId("bayern munich"), 157, "大文字小文字が違っても同じ");
  });
  await t("C2 追跡クラブ: 確認済みIDがまだ無いときは、別名・特徴語を含む検索語を順に試し、女子・2軍と取り違え済みのIDを採用しない", async () => {
    V97.clearCache(); store.delete("kb:club:bayern-munich");
    const seen = [];
    teamsSearch = (term) => { seen.push(term);
      if (term === "Bayern Munich") return [{ team: { id: 9001, name: "Bayern Munich W" } }];
      if (term === "Bayern") return [{ team: { id: 8001, name: "Bayern München II" } }, { team: { id: 157, name: "Bayern München" } }, { team: { id: 8002, name: "Bayern Hof" } }];
      return []; };
    assert.strictEqual(await srv.resolveTeamId("Bayern Munich"), 157);
    assert.deepStrictEqual(seen, ["Bayern Munchen", "Bayern Munich", "Bayern"]);
    // 取り違えと判定済みのIDは、完全一致で返ってきても採用しない
    V97.clearCache();
    await cd.updateSection("Arsenal", "form", { currentFormScore: 1 }, { nameJa: "アーセナル", teamId: 4242 });
    await cd.resetIdentity("Arsenal", { teamId: null, previousTeamId: 4242, previousApiName: "Arsenal", evidenceJa: "直近10試合のうち9試合が女子大会でした", at: "2026-11-15T00:00:00.000Z" });
    teamsSearch = () => [{ team: { id: 4242, name: "Arsenal" } }, { team: { id: 42, name: "Arsenal FC" } }];
    assert.strictEqual(await srv.resolveTeamId("Arsenal"), 42);
    // どの検索語でも女子・2軍しか返らないときは、正直に null(従来どおり)
    V97.clearCache(); store.delete("kb:club:real-madrid");
    teamsSearch = () => [{ team: { id: 7001, name: "Real Madrid W" } }, { team: { id: 7002, name: "Real Madrid U19" } }];
    assert.strictEqual(await srv.resolveTeamId("Real Madrid"), null);
    // 追跡クラブ以外の名前は従来の照合のまま
    V97.clearCache();
    teamsSearch = () => [{ team: { id: 9001, name: "Testville W" } }, { team: { id: 9002, name: "Testville United" } }];
    assert.strictEqual(await srv.resolveTeamId("Testville"), 9002);
  });

  // ================= 毎日の学習(刻印と境の学習) =================
  console.log("■ 毎日の学習");
  await t("D1 runDailyLearning: 新しい予想にランクが刻まれる(予想時の境と補正で)・境の学習結果が保存される・成長ログに刻印の件数が載る", async () => {
    const dj = require(path.join(__dirname, "learning/dailyJob.js"));
    const st = new Map(); const c2 = async (c) => { const [op, ...a] = c;
      if (op === "GET") return st.has(a[0]) ? st.get(a[0]) : null;
      if (op === "MGET") return a.map((k) => (st.has(k) ? st.get(k) : null));
      if (op === "SET") { if (a[2] === "NX" && st.has(a[0])) return null; st.set(a[0], a[1]); return "OK"; }
      if (op === "DEL") { let n = 0; for (const k of a) if (st.delete(k)) n++; return n; }
      if (op === "INCR") { const v = (parseInt(st.get(a[0]), 10) || 0) + 1; st.set(a[0], String(v)); return v; }
      if (op === "INCRBY") { const v = (parseInt(st.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); st.set(a[0], String(v)); return v; }
      if (op === "HGETALL") { const h = st.get(a[0]); return h ? Object.entries(h).flat() : []; }
      if (op === "HSET") { const h = st.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; st.set(a[0], h); return 1; }
      if (op === "LRANGE") { const l = st.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
      if (op === "LLEN") return (st.get(a[0]) || []).length;
      if (op === "RPUSH") { const l = st.get(a[0]) || []; l.push(a[1]); st.set(a[0], l); return l.length; }
      if (op === "LREM") { const l = st.get(a[0]) || []; st.set(a[0], l.filter((v) => v !== a[2])); return 1; }
      if (op === "LTRIM") { const l = st.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; st.set(a[0], l.slice(s, e + 1)); return "OK"; }
      if (op === "EXPIRE" || op === "PEXPIRE") return 1;
      if (op === "EXISTS") return a.filter((k) => st.has(k)).length;
      return null; };
    const g2 = async (k) => { try { const r = await c2(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
    const s2 = async (k, v) => { await c2(["SET", k, JSON.stringify(v)]); return true; };
    // 前夜の学習が保存した境(S=75%)
    st.set(T.MODEL_KEY, JSON.stringify({ v: 1, thresholds: { tS: 0.75, tA: 0.6, tSkip: 0.5 }, fittedAt: "2026-11-13T22:00:00Z" }));
    // 直近の答え合わせの実測(70%以上の帯は、平均の自信80%に対して実際は60%しか当たっていない=自信過剰)。
    // 表示用の較正マップはこの実測から作られる(-20pt)。前夜のマップ(保存済み)はわざと別の内容にしておく。
    const accLib = require(path.join(__dirname, "learning/accuracyTracker.js"));
    const scoredHi = (hit) => ({ official: true, league: "Premier League", learned: true, markets: { oneX2: { hit, brier: 0.4, logLoss: 0.6, confidence: 0.8, predicted: "home", actual: hit ? "home" : "away", probs: { homeWin: 0.8, draw: 0.1, awayWin: 0.1 } } } });
    const NOW = new Date();
    for (let d = 1; d <= 3; d++) {
      const dk = new Date(NOW.getTime() + 9 * 3600000 - d * 86400000).toISOString().slice(0, 10);
      st.set(`learn:accuracy:${dk}`, JSON.stringify(accLib.buildDailyAccuracy(Array.from({ length: 10 }, (_, i) => scoredHi(i < 6)))));
    }
    st.set("learn:calibration:map", JSON.stringify({ available: true, minN: 20, bins: { "70+%": { n: 50, avgConfPct: 80, actualHitPct: 85 } } })); // 前夜のマップ(+5pt)
    const callApiFootball = async (endpoint, params) => {
      if (endpoint === "/teams") return { response: [{ team: { id: 100, name: params.search } }] };
      if (endpoint === "/fixtures" && params.next) return { response: [{ fixture: { id: 424242, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } }, teams: { home: { id: 100, name: "Home FC" }, away: { id: 2, name: "Away FC" } }, goals: { home: null, away: null }, league: { id: 39, name: "Premier League", country: "England", season: 2026 } }] };
      if (endpoint === "/fixtures" && params.last) { const list = []; for (let i = 0; i < 10; i++) list.push({ fixture: { id: 1000 + i, date: new Date(Date.now() - i * 86400e3).toISOString(), status: { short: "FT" } }, teams: { home: { id: 100 }, away: { id: 2 } }, goals: { home: i < 5 ? 3 : 0, away: i < 5 ? 0 : 2 } }); return { response: list }; }
      return { response: [] };
    };
    // 試合の日時は「いま」から作っているので、学習の時刻も「いま」にする(固定の日時だと、実行する時刻によって試合が過去になる)
    const out = await dj.runDailyLearning({ callApiFootball, resolveTeamId: async () => 100, upstashEnabled: true, upstashCmd: c2, upstashGetJSON: g2, upstashSetJSON: s2, now: () => NOW });
    assert.strictEqual(out.ok, true, JSON.stringify(out.errors || []).slice(0, 300));
    const recd = await g2("learn:ownpred:424242");
    assert.ok(recd && recd.tier, "予想にランクが刻まれていない: " + JSON.stringify((out.errors || []).slice(0, 5)));
    // 刻印は「予想時の境(S=75%)」と「今夜作り直される較正マップ(直近の実測)」で決まる。
    //   学習の最後に保存されたマップ=画面が使うマップで計算し直しても、刻んだ自信と同じ数字になる
    //   (予想カードの数字と、ランクの材料が食い違わない)。前夜のマップ(+5pt)は使われない。
    const mapServed = await g2("learn:calibration:map");
    assert.ok(mapServed && mapServed.available === true && mapServed.bins["70+%"] && mapServed.bins["70+%"].actualHitPct === 60, JSON.stringify(mapServed).slice(0, 200));
    const expect = T.stampFor({ ...recd, tier: undefined }, { thresholds: { tS: 0.75 } }, mapServed);
    assert.deepStrictEqual(recd.tier, expect, JSON.stringify({ got: recd.tier, expect, fp: recd.finalProbs }));
    assert.strictEqual(recd.tier.basis, "bin"); assert.strictEqual(recd.tier.tS, 0.75);
    assert.strictEqual(recd.tier.conf, Math.round(recd.tier.rawConf * 100 - 20) / 100, "実測のズレ(-20pt)ぶん補正した自信で刻む: " + JSON.stringify(recd.tier));
    assert.strictEqual(recd.tier.rank, T.rankOf(recd.tier.conf, { tS: 0.75, tA: 0.6, tSkip: 0.5 }));
    const entry = V104.buildTodayPredictionEntry({ id: 424242, date: recd.kickoff, status: "NS", league: "Premier League", home: { name: "Home FC" }, away: { name: "Away FC" } }, recd, mapServed, null, savedModelEarly());
    assert.strictEqual(entry.confidence.displayPct, Math.round(recd.tier.conf * 100), "画面の数字=刻んだ自信");
    assert.strictEqual(entry.tier.rank, recd.tier.rank); assert.strictEqual(entry.tier.stamped, true);
    assert.ok(recd.predictedWinner && recd.finalProbs, "予想そのものは従来どおり保存されている");
    function savedModelEarly() { return { thresholds: { tS: 0.75 } }; }
    const savedModel = await g2(T.MODEL_KEY);
    assert.ok(savedModel && savedModel.table && savedModel.forward && savedModel.fittedAt === NOW.toISOString(), JSON.stringify(savedModel).slice(0, 200));
    assert.strictEqual(savedModel.thresholds.tS, 0.75, "答え合わせ済みの記録が足りない夜は、前回の境をそのまま引き継ぐ");
    assert.strictEqual(savedModel.decision, "kept_previous"); assert.ok(/届いていない/.test(savedModel.reasonJa));
    const g = await g2("learn:growthlog:latest");
    assert.ok(g.confidenceTiers && g.confidenceTiers.fitted === true && g.confidenceTiers.saved === true, JSON.stringify(g.confidenceTiers).slice(0, 200));
    const stamped = g.confidenceTiers.stampedToday;
    assert.strictEqual(stamped.S + stamped.A + stamped.B + stamped.skip + stamped.none, 1); assert.strictEqual(stamped[recd.tier.rank], 1);
    // 採点のとき、刻印が採点結果に渡る(ソースの確認)
    const src = fs.readFileSync(path.join(__dirname, "learning/dailyJob.js"), "utf8");
    assert.ok(src.includes("record.marketScores.tier = (record.tier && confidenceTiers.RANKS.includes(record.tier.rank)) ? record.tier.rank : null;"));
    assert.ok(src.includes("record.tier = confidenceTiers.stampFor(record, tierModelOnce, displayCalibrationMapOnce);"));
  });

  // ================= 画面 =================
  console.log("■ 画面(index.html)");
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const sandbox = { escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) };
  vm.createContext(sandbox);
  for (const fn of ["predTierChipHtml", "predTierLineHtml", "tiersTableHtml", "groundingNoteHtml"]) vm.runInContext(extractFunction(html, fn), sandbox);
  const strip = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const stripCells = (h) => h.replace(/<\/t[dh]>/g, " ").replace(/<\/tr>/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); // 表はセルの間に空白を入れて読む
  await t("U1 予想カード: ランクの印と1行(ランク・意味・実績・どの数え方か)。見送りは「自信が低い」と正直に出す。対象外・旧い応答は何も出さない", async () => {
    const pS = today.predictions.find((p) => p.fixtureId === 502), pB = today.predictions.find((p) => p.fixtureId === 501), pNone = today.predictions.find((p) => p.fixtureId === 503);
    const lineS = strip(sandbox.predTierLineHtml(pS));
    assert.strictEqual(lineS, "🏅 自信ランク S(確信) ・ このランクの実績: 75.4%(61件中46件的中 ・ 直近30日 ・ 今の基準を過去の予想に当てはめた実測) ・ 予想時の自信 74%", lineS);
    assert.ok(/class="tier-chip tier-s">S</.test(sandbox.predTierChipHtml(pS)));
    const lineB = strip(sandbox.predTierLineHtml(pB));
    assert.ok(lineB.startsWith("🏅 自信ランク B(やや優勢) ・ このランクの実績: 54.2%(131件中71件的中") && !/予想時の自信/.test(lineB), lineB);
    assert.strictEqual(sandbox.predTierLineHtml(pNone), ""); assert.strictEqual(sandbox.predTierChipHtml(pNone), "");
    assert.strictEqual(sandbox.predTierLineHtml({}), ""); assert.strictEqual(sandbox.predTierLineHtml(null), ""); assert.strictEqual(sandbox.predTierChipHtml({ tier: null }), "");
    const skip = strip(sandbox.predTierLineHtml({ tier: { rank: "skip", labelJa: "見送り", confPct: 44, stamped: true, record: { basis: "forward", window: "all", n: 30, hits: 13, hitPct: 43.3 } }, confidence: { displayPct: 44 } }));
    assert.strictEqual(skip, "🏅 自信ランク 見送り ・ 自信が低い試合です(当たる見込みが5割未満) ・ このランクの実績: 43.3%(30件中13件的中 ・ 全期間 ・ 予想時のランクのまま数えた実績)");
    assert.ok(/tier-skip/.test(sandbox.predTierChipHtml({ tier: { rank: "skip" } })));
    const noRec = strip(sandbox.predTierLineHtml({ tier: { rank: "A", labelJa: "有力", confPct: 62, stamped: false, record: null }, confidence: { displayPct: 62 } }));
    assert.strictEqual(noRec, "🏅 自信ランク A(有力) ・ このランクの実績はまだ集計中です");
    // 名前など利用者由来の文字列が混ざっても HTML として解釈されない
    assert.ok(!sandbox.predTierLineHtml({ tier: { rank: "A", labelJa: "<img src=x>", record: null } }).includes("<img"));
  });
  await t("U2 ランク別の成績(折りたたみ): 境・前向きの実績・当てはめの実測を件数つきで出す。実績が無い導入直後は「次回の学習のあとから」と出す", async () => {
    const h = sandbox.tiersTableHtml(today.tiers);
    const txt = stripCells(h);
    assert.ok(txt.includes("🏅 自信ランク別の成績") && txt.includes("S: 自信70%以上 / A: 60%以上 / B: 50%以上 / 見送り: 50%未満"), txt.slice(0, 200));
    assert.ok(txt.includes("予想時のランクのまま数えた実績(全期間 ・ 36件)") && txt.includes("今の基準を過去の予想に当てはめた実測(直近30日 ・ 412件)"), txt);
    assert.ok(/S 確信 61 75\.4%/.test(txt) && /見送り 100 46%/.test(txt), txt);
    assert.ok(/<details/.test(h) && !/<details[^>]*open/.test(h), "既定は折りたたみ(画面を混ませない)");
    const empty = strip(sandbox.tiersTableHtml({ available: false, thresholds: { sPct: 70, aPct: 60, skipPct: 50 }, ranks: today.tiers.ranks, backtest: null, forward: null }));
    assert.ok(empty.includes("ランク別の実績は、次回の毎日の学習のあとから表示されます。"));
    assert.strictEqual(sandbox.tiersTableHtml(null), ""); assert.strictEqual(sandbox.tiersTableHtml({}), "");
    // 0件のランクは「—」(0% と書かない)
    const zero = stripCells(sandbox.tiersTableHtml({ thresholds: { sPct: 70, aPct: 60, skipPct: 50 }, ranks: today.tiers.ranks, forward: null, backtest: { totalAll: 5, totalLast30: 0, last30: [], all: [{ rank: "S", labelJa: "確信", n: 0, hits: 0, hitPct: null }, { rank: "A", labelJa: "有力", n: 5, hits: 3, hitPct: 60 }] } }));
    assert.ok(/S 確信 0 —/.test(zero) && /A 有力 5 60%/.test(zero), zero);
  });
  await t("U3 会話の裏取りの注記: すべて一致(✅)・一致しない数字の一覧(⚠️)・一般知識(ℹ️)。対象外・旧い応答・数字なしは何も出さない", async () => {
    assert.strictEqual(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "all_supported", checked: 4, supported: 4 } })), "✅ 数字の裏取り: 照合した数字4個は、すべて取得したデータにある数字と一致しました");
    const part = strip(sandbox.groundingNoteHtml({ grounding: { verdict: "partial", checked: 5, supported: 3, unsupportedCount: 2, unsupported: [{ text: "91", kind: "num" }, { text: "88.8%", kind: "pct" }] } }));
    assert.strictEqual(part, "⚠️ 数字の裏取り: 照合した数字5個のうち3個は取得したデータと一致しました。次の数字は、取得したデータに同じ値が見当たりません(AIが計算した値や、AIの推定・一般知識による値の場合があります): 91、88.8%");
    // 前の回答の数字の繰り返し: 一致・不一致とは分けて添える。繰り返しだけの回答は ℹ️
    assert.strictEqual(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "all_supported", checked: 1, supported: 1, repeated: 2 } })), "✅ 数字の裏取り: 照合した数字1個は、すべて取得したデータにある数字と一致しました ・ ほかに2個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)");
    assert.ok(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "partial", checked: 2, supported: 1, unsupportedCount: 1, unsupported: [{ text: "41" }], repeated: 1 } })).endsWith(": 41 ・ ほかに1個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)"));
    assert.strictEqual(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "repeated_only", checked: 0, supported: 0, repeated: 2 } })), "ℹ️ 数字の裏取り: この回答の数字2個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)");
    assert.strictEqual(sandbox.groundingNoteHtml({ grounding: { verdict: "repeated_only", repeated: 0 } }), "");
    assert.ok(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "partial", checked: 9, supported: 1, unsupportedCount: 8, unsupported: [{ text: "11%" }] } })).endsWith("11% ほか"));
    assert.ok(strip(sandbox.groundingNoteHtml({ grounding: { verdict: "general_knowledge", checked: 2, unsupportedCount: 2, unsupported: [] } })).startsWith("ℹ️ 数字の裏取り: この回答は取得したデータを使っていないため"));
    for (const resp of [null, {}, { grounding: null }, { grounding: { verdict: "none", checked: 0 } }, { grounding: { verdict: "all_supported", checked: 0 } }, { grounding: { verdict: "partial", unsupported: [] } }]) assert.strictEqual(sandbox.groundingNoteHtml(resp), "");
    assert.ok(!sandbox.groundingNoteHtml({ grounding: { verdict: "partial", checked: 1, supported: 0, unsupportedCount: 1, unsupported: [{ text: "<b>1</b>" }] } }).includes("<b>1</b>"));
  });
  await t("U4 配線と辞書: 両方の予想カード・一覧の行・両方の会話の描画に入っている。新しい文言はすべて EN/ZH/ES の訳がある。sw.js の版を進めた", async () => {
    assert.strictEqual((html.match(/\$\{predUnlearnedLineHtml\(p\)\}\$\{predTierLineHtml\(p\)\}\$\{predConfidenceLineHtml\(p\)\}/g) || []).length, 2, "予想カード2種類");
    assert.strictEqual((html.match(/\$\{predTierChipHtml\(p\)\}/g) || []).length, 3, "ヒーロー・詳細・一覧の行");
    assert.ok(html.includes("${tiersTableHtml(data.tiers)}"));
    assert.ok(html.includes("return `${toolsHtml}${groundingNoteHtml(resp)}${factsHtml}${genInfoHtml}${followupsHtml}`;") && html.includes("${ragHtml}${toolsLineHtml(resp)}${groundingNoteHtml(resp)}${deliberationHtml}"), "会話の描画2種類");
    const dictStart = html.indexOf("/* ==== v104.1(2026年11月14日): 確信ピック(K・自信ランク)と数字の裏取り(M)の文言 ==== */");
    const dictPart = html.slice(dictStart, html.indexOf("/* ==== v104(2026年11月12日)", dictStart));
    assert.ok(dictStart > 0 && dictPart.length > 1000);
    const keys = ["自信ランク", "確信", "有力", "やや優勢", "見送り", "自信が低い試合です(当たる見込みが5割未満)", "このランクの実績", "このランクの実績はまだ集計中です", "直近30日", "全期間", "予想時のランクのまま数えた実績", "今の基準を過去の予想に当てはめた実測", "自信ランク別の成績", "ランク", "ランク別の実績は、次回の毎日の学習のあとから表示されます。", "数字の裏取り", "この回答は取得したデータを使っていないため、数字はAIの一般知識にもとづくものです(最新の値と違う場合があります)"];
    for (const k of keys) {
      const m = dictPart.match(new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*\\[("(?:[^"\\\\]|\\\\.)*"),\\s*("(?:[^"\\\\]|\\\\.)*"),\\s*("(?:[^"\\\\]|\\\\.)*")\\]`));
      assert.ok(m, "辞書に無い: " + k);
      for (const v of [m[1], m[3]]) assert.ok(!/[ぁ-んァ-ヶ一-龥]/.test(v), "英語・スペイン語の訳に日本語が残っている: " + k + " → " + v);
      assert.ok(JSON.parse(m[1]).length > 0 && JSON.parse(m[2]).length > 0 && JSON.parse(m[3]).length > 0, "空の訳: " + k);
    }
    for (const p of ["⦿件中⦿件的中", "予想時の自信 ⦿%", "S: 自信⦿%以上 / A: ⦿%以上 / B: ⦿%以上 / 見送り: ⦿%未満", "照合した数字⦿個は、すべて取得したデータにある数字と一致しました", "照合した数字⦿個のうち⦿個は取得したデータと一致しました。次の数字は、取得したデータに同じ値が見当たりません(AIが計算した値や、AIの推定・一般知識による値の場合があります)", "この回答の数字⦿個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)", "ほかに⦿個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)"]) {
      assert.ok(dictPart.includes(`["${p}", "`), "型テンプレートに無い: " + p);
    }
    // 型テンプレート(RAWP8)の全行: 差し込み口(⦿)の数だけ $1..$n を各言語が使い、英語・スペイン語の訳に日本語が残っていない
    const rawp8 = dictPart.slice(dictPart.indexOf("var RAWP8 = ["), dictPart.indexOf("for (var rp8"));
    const rows = [...rawp8.matchAll(/^\s*\[("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\],?\s*$/gm)].map((m) => m.slice(1, 5).map((x) => JSON.parse(x)));
    assert.strictEqual(rows.length, 10, "RAWP8 の行数: " + rows.length);
    for (const [ja, en, zh, es] of rows) {
      const slots = (ja.match(/⦿/g) || []).length;
      for (const [lang, tr] of [["EN", en], ["ZH", zh], ["ES", es]]) {
        const used = new Set((tr.match(/\$\{?(\d+)\}?/g) || []).map((x) => x.replace(/[^\d]/g, "")));
        assert.deepStrictEqual([...used].sort(), Array.from({ length: slots }, (_, i) => String(i + 1)), `${lang} の差し込み口が合わない: ${ja} → ${tr}`);
      }
      for (const tr of [en, es]) assert.ok(!/[ぁ-んァ-ヶ一-龥]/.test(tr), "英語・スペイン語の訳に日本語が残っている: " + tr);
      assert.ok(!/[ぁ-んァ-ヶ]/.test(zh), "中国語の訳にかなが残っている: " + zh);
    }
    // サーバーが返すランクの名前(labelJa)は、すべて辞書の見出しにある(画面で訳せる)
    for (const r of T.RANKS) assert.ok(keys.includes(T.RANK_LABELS_JA[r]), T.RANK_LABELS_JA[r]);
    const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
    assert.ok(/CACHE_NAME = "soccer-ai-shell-v1041"/.test(sw));
    assert.ok(/\.tier-chip\s*\{/.test(html) && /\.tier-chip\.tier-skip\s*\{/.test(html));
  });

  console.log(`\nv104.1 server: ${pass} passed, ${fail} failed`);
  try { srv.server.close(); mock.close(); } catch (e) { /* テスト終了時の後片づけ */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
