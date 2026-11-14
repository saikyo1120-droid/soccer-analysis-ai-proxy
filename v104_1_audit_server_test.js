"use strict";
/**
 * v104.1 総点検(2026年11月14日)で見つけて直した欠陥の回帰テスト — サーバー編
 *
 * 方針: 「作る側の本物の出力」を「使う側」に通して確かめる(期待値を、使う側が欲しい形で手書きしない)。
 *   今回の総点検で分かったこと: これまでのテストは、使う側が期待する形のデータを手で作って渡していたため、
 *   作る側が実際には別の名前で出していても(または出していなくても)通っていた。
 *     例1: 会話の道具「対戦分析」が拾う項目名が、本物の対戦分析の応答に1つも無い名前だった(勝敗確率が AI に届かない)
 *     例2: 日次レポートが読む動的クラブの項目名が、成長ログに保存される名前と違った(常に null)
 *     例3: 選手索引をテストが直接差し込んでいたため、「再起動の直後は索引が空」の経路を一度も通っていなかった
 *
 * 対象:
 *   S1 会話の道具「対戦分析」⇔ 本物の対戦分析の応答(項目名の突き合わせ・日本語のクラブ名)
 *   S2 「本日の実際の試合」に女子・年代別の試合を出さない
 *   S3 再起動の直後でも、試合カードは選手索引を読み込んでから組み立てる/読めないときは「分からない」として短く覚える
 *   S4 毎日の学習(本物)→ 成長ログ → 日次レポート: 動的クラブの採用結果が見える
 *   S5 会話の道具: 的中率の実測(件数つき・上限内)/外れの反省(特定できないクラブ)/今日の予想(読めなかったを「無い」にしない)
 *   S6 クラブのまとめ: 同じ名前の別クラブの成績を混ぜない(チームIDで照合)
 * 本物の Anthropic API・API-Football・Upstash は呼ばない(すべてローカルのモック)。
 */
const http = require("http");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore() {
  const data = new Map(); const failKeys = { re: null };
  const cmd = async (c) => {
    const [op, ...a] = c;
    if (failKeys.re && a.some((k) => failKeys.re.test(String(k)))) throw new Error("store unavailable (test)");
    if (op === "GET") return data.has(a[0]) ? data.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (data.has(k) ? data.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && data.has(a[0])) return null; data.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (data.delete(k)) n++; return n; }
    if (op === "INCR") { const v = (parseInt(data.get(a[0]), 10) || 0) + 1; data.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(data.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); data.set(a[0], String(v)); return v; }
    if (op === "HGETALL") { const h = data.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = data.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; data.set(a[0], h); return 1; }
    if (op === "HDEL") { const h = data.get(a[0]) || {}; let n = 0; for (const f of a.slice(1)) if (f in h) { delete h[f]; n++; } data.set(a[0], h); return n; }
    if (op === "HINCRBY") { const h = data.get(a[0]) || {}; h[a[1]] = String((parseInt(h[a[1]], 10) || 0) + Number(a[2])); data.set(a[0], h); return Number(h[a[1]]); }
    if (op === "LRANGE") { const l = data.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "LLEN") return (data.get(a[0]) || []).length;
    if (op === "RPUSH") { const l = data.get(a[0]) || []; l.push(...a.slice(1)); data.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = data.get(a[0]) || []; l.unshift(...a.slice(1)); data.set(a[0], l); return l.length; }
    if (op === "LREM") { const l = data.get(a[0]) || []; data.set(a[0], l.filter((v) => v !== a[2])); return 1; }
    if (op === "LTRIM") { const l = data.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; data.set(a[0], l.slice(s, e + 1)); return "OK"; }
    if (op === "EXPIRE" || op === "PEXPIRE") return 1;
    if (op === "EXISTS") return a.filter((k) => data.has(k)).length;
    if (op === "KEYS") { const re = new RegExp("^" + String(a[0]).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); return [...data.keys()].filter((k) => re.test(k)); }
    if (op === "SCAN") { const mi = a.indexOf("MATCH"); const pat = mi >= 0 ? a[mi + 1] : "*"; const re = new RegExp("^" + String(pat).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); return ["0", [...data.keys()].filter((k) => re.test(k))]; }
    return null;
  };
  const getJSON = async (k) => { const r = await cmd(["GET", k]); return r === null ? null : (typeof r === "string" ? JSON.parse(r) : r); };
  const setJSON = async (k, v) => { await cmd(["SET", k, JSON.stringify(v)]); return true; };
  return { data, cmd, getJSON, setJSON, failKeys };
}

(async () => {
  process.env.PORT = "0"; process.env.API_FOOTBALL_KEY = "k"; process.env.ANTHROPIC_API_KEY = "";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  process.env.RATE_LIMIT_PER_MINUTE = "100000"; process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000"; process.env.LINEUP_WATCH = "0";
  process.env.DAILY_API_BUDGET = "100000";

  const srv = require(path.join(__dirname, "server.js"));
  const V104 = srv.__v104ForTest, V97 = srv.__v97ForTest, V98 = srv.__v98ForTest, V100 = srv.__v100ForTest;
  const discussTools = require(path.join(__dirname, "discuss/tools.js"));
  const playerSearch = require(path.join(__dirname, "knowledge/playerSearch.js"));
  const accLib = require(path.join(__dirname, "learning/accuracyTracker.js"));
  const SERVER_SRC = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  const S = makeStore();
  const now = Date.now();
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  const TEAMS = {
    porto: { id: 212, name: "FC Porto", country: "Portugal" }, benfica: { id: 211, name: "Benfica", country: "Portugal" },
    arsenal: { id: 42, name: "Arsenal", country: "England" },
  };
  const finished = (i, teamId, name) => ({
    fixture: { id: 9000 + teamId * 20 + i, date: new Date(now - (i + 1) * 4 * 86400000).toISOString(), status: { short: "FT" }, venue: { name: "S" } },
    league: { id: 94, name: "Primeira Liga", country: "Portugal", season: 2026 },
    teams: { home: { id: i % 2 ? teamId : 5000 + i, name: i % 2 ? name : "Opp" + i, winner: !!(i % 2) }, away: { id: i % 2 ? 5000 + i : teamId, name: i % 2 ? "Opp" + i : name, winner: !(i % 2) } },
    goals: { home: i % 2 ? 2 : 0, away: i % 2 ? 0 : 1 }, score: { halftime: { home: 1, away: 0 }, fulltime: { home: i % 2 ? 2 : 0, away: i % 2 ? 0 : 1 } },
  });
  const kickoff = new Date(now + 3 * 3600000).toISOString();
  const fx = (id, hid, hn, aid, an, lid, ln, country) => ({ fixture: { id, date: kickoff, status: { short: "NS" }, venue: { name: "Stadium" } }, league: { id: lid, name: ln, country: country || "World" }, teams: { home: { id: hid, name: hn, logo: "" }, away: { id: aid, name: an, logo: "" } }, goals: { home: null, away: null } });
  let todayFixtures = [];
  let fixtureById = new Map();
  const apiCalls = [];
  srv.__setTestHooks({
    upstashCmd: S.cmd, upstashGetJSON: S.getJSON, upstashSetJSON: S.setJSON,
    callApiFootball: async (ep, p) => {
      apiCalls.push({ ep, p: { ...(p || {}) } });
      if (ep === "/teams" && p && p.search) { const k = String(p.search).toLowerCase(); const hit = Object.keys(TEAMS).find((n) => k.includes(n)); return { response: hit ? [{ team: TEAMS[hit] }] : [] }; }
      if (ep === "/fixtures" && p && p.team && p.last) { const tm = Object.values(TEAMS).find((x) => x.id === Number(p.team)); return { response: tm ? Array.from({ length: 10 }, (_, i) => finished(i, tm.id, tm.name)) : [] }; }
      if (ep === "/fixtures" && p && p.date) return { response: todayFixtures };
      if (ep === "/fixtures" && p && p.id) { const f = fixtureById.get(Number(p.id)); return { response: f ? [f] : [] }; }
      return { response: [] };
    },
  });
  await sleep(200);
  const port = srv.server.address().port;
  const get = (p) => new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: p }, (res) => { let buf = ""; res.on("data", (c) => { buf += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (e) { j = null; } resolve({ status: res.statusCode, text: buf, body: j }); }); }).on("error", reject); });

  console.log("v104.1 総点検の回帰テスト(サーバー編)");

  // =====================================================================================
  console.log("■ S1 会話の道具「対戦分析」⇔ 本物の対戦分析の応答");
  await t("S1-1 道具が回答AIへ渡す項目名は、すべて本物の対戦分析の応答に実在する(v104 は存在しない名前を拾い、勝敗確率が一度も渡っていなかった)", async () => {
    V97.clearCache();
    const direct = await V104.handleMatchAnalysis(new URLSearchParams({ home: "Porto", away: "Benfica" }), "1.1.1.1", { skipLlm: true });
    assert.strictEqual(direct.status, 200); assert.strictEqual(direct.body.ok, true, JSON.stringify(direct.body).slice(0, 300));
    assert.ok(Array.isArray(V104.MATCH_ANALYSIS_TOOL_KEYS) && V104.MATCH_ANALYSIS_TOOL_KEYS.length >= 10);
    const missing = V104.MATCH_ANALYSIS_TOOL_KEYS.filter((k) => direct.body[k] === undefined);
    assert.deepStrictEqual(missing, [], "本物の応答に無い項目名を道具が拾っている: " + missing.join(", "));
    // 道具を実際に通す: 肝心の中身(勝敗確率・結論・布陣・注目選手・特徴量)が回答AIに届く
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const r = await discussTools.executeTool("get_match_analysis", { home: "Porto", away: "Benfica" }, deps);
    assert.strictEqual(r.ok, true, r.resultJson.slice(0, 300));
    const given = JSON.parse(r.resultJson).data;
    assert.deepStrictEqual(given.winProbability, direct.body.winProbability, "勝敗確率が道具の結果に入っていない");
    const sum = given.winProbability.homeWinPct + given.winProbability.drawPct + given.winProbability.awayWinPct;
    assert.ok(Math.abs(sum - 100) < 0.5, "確率の合計が100%でない: " + sum);
    for (const k of ["conclusion", "keyFactors", "featuresUsed", "predictedScoreline", "dataNotes", "formation", "keyPlayers", "injuries"]) assert.ok(given[k] !== undefined, "道具の結果に無い: " + k);
    assert.ok(r.resultJson.length <= discussTools.MAX_RESULT_CHARS, "上限を超えている: " + r.resultJson.length);
    // 配線: 道具は項目名の一覧(MATCH_ANALYSIS_TOOL_KEYS)だけを使って拾う(別の場所に名前を手書きしない)
    assert.ok(/for \(const k of MATCH_ANALYSIS_TOOL_KEYS\) if \(body\[k\] !== undefined\) pick\[k\] = body\[k\];/.test(SERVER_SRC));
  });
  await t("S1-2 追跡中クラブ(172クラブ)の日本語名を渡しても対戦分析できる(v104 は登録11クラブ以外を「クラブが特定できませんでした」で終えていた)", async () => {
    V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const r = await discussTools.executeTool("get_match_analysis", { home: "ポルト", away: "ベンフィカ" }, deps);
    assert.strictEqual(r.ok, true, "日本語のクラブ名で失敗: " + r.resultJson.slice(0, 200));
    const given = JSON.parse(r.resultJson).data;
    assert.ok(given.winProbability && Number.isFinite(given.winProbability.homeWinPct));
    assert.ok(/ポルト/.test(JSON.stringify(given.home)) && /ベンフィカ/.test(JSON.stringify(given.away)), JSON.stringify([given.home, given.away]).slice(0, 200));
    // どこにも居ないクラブは、従来どおり理由つきで失敗を返す(作り話をしない)
    const bad = await discussTools.executeTool("get_match_analysis", { home: "ポルト", away: "ナイナイユナイテッド" }, deps);
    assert.strictEqual(bad.ok, false); assert.ok(/特定できません/.test(bad.reasonJa), bad.reasonJa);
  });

  // =====================================================================================
  console.log("■ S2 本日の実際の試合");
  await t("S2 女子の大会・女子チーム・年代別チームの試合を一覧に出さない(大会名に「女子」と出ないものも)。男子の試合・片方が2軍の試合は残す", async () => {
    todayFixtures = [
      fx(1, 42, "Arsenal", 49, "Chelsea", 39, "Premier League", "England"),
      fx(2, 9101, "INAC Kobe Leonessa", 9102, "Urawa Reds", 9741, "WE League", "Japan"),               // 女子(大会名に女子の語なし)
      fx(3, 9103, "Bayern München", 9104, "VfL Wolfsburg", 82, "Frauen Bundesliga", "Germany"),        // 女子(チーム名は男子と同じ表記)
      fx(4, 9105, "England U21", 9106, "Japan U23", 10, "Friendlies", "World"),                         // 年代別(大会名に年代なし)
      fx(5, 9107, "Orlando Pirates U23", 9108, "Mamelodi Sundowns U23", 9742, "Diski Challenge", "South-Africa"),
      fx(6, 9109, "Lyon (W)", 9110, "PSG", 9743, "Coupe de France", "France"),                          // 片方が女子チーム
      fx(7, 9111, "Jong Ajax", 9112, "De Graafschap", 89, "Eerste Divisie", "Netherlands"),             // 2軍(Jong)対トップ → 残す
      fx(8, 9113, "Kashima Antlers", 9114, "Kawasaki Frontale", 98, "J1 League", "Japan"),
      fx(9, 9115, "West Ham", 9116, "Wolves", 39, "Premier League", "England"),                         // 名前が W で始まる男子
      fx(10, 9117, "Schalke 04", 9118, "Hannover 96", 79, "2. Bundesliga", "Germany"),                  // 数字つきの男子
    ];
    V97.clearCache();
    const r = await srv.handleFixturesToday(new URLSearchParams(""));
    assert.strictEqual(r.status, 200);
    const ids = r.body.fixtures.map((f) => f.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [1, 7, 8, 9, 10], "一覧に残った試合: " + JSON.stringify(r.body.fixtures.map((f) => `${f.id}:${f.league}:${f.home.name}`)));
  });

  // =====================================================================================
  console.log("■ S3 再起動の直後の試合カード");
  S.data.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル", tier: "A", dynamic: false }] }));
  S.data.set("kb:club:arsenal", JSON.stringify({ nameEn: "Arsenal", nameJa: "アーセナル", teamId: 42, tier: "A", updatedAt: new Date(now - 3600000).toISOString(),
    sections: { coach: { coachName: "M. Arteta", formation: "4-3-3", computedAt: new Date(now - 3600000).toISOString() }, standings: { position: 2, points: 25, played: 11, computedAt: new Date(now - 3600000).toISOString() } } }));
  const idxRows = Array.from({ length: 16 }, (_, i) => playerSearch.toIndexRow({ id: 1000 + i, name: "Gunner " + i, teamEn: "Arsenal", teamJa: "アーセナル", position: "Midfielder", stats: { minutes: 600 + i * 10, rating: 7.1, goals: 2, assists: 1, appearances: 10 } }, { todayKey: Number(jst(now).replace(/-/g, "")) }, now, null));
  const saved = await playerSearch.saveIndex({ upstashEnabled: true, upstashGetJSON: S.getJSON, upstashSetJSON: S.setJSON, upstashCmd: S.cmd }, idxRows, { builtAt: new Date(now - 7200000).toISOString() });
  const restart = () => { // プロセスの再起動を再現: メモリ上の選手索引と照合表を空に戻す(保存先はそのまま)
    const st = V100.playerIndexState();
    st.rows = []; st.meta = null; st.loadedAt = 0; st.available = false; st.partial = false; st.loading = null; st.facets = null;
    V98.teamKnowledge.invalidate(); V97.clearCache();
  };
  fixtureById = new Map([[701, fx(701, 42, "Arsenal", 9201, "Sagan Tosu", 39, "Premier League", "England")], [702, fx(702, 42, "Arsenal", 9202, "Vissel Kobe", 39, "Premier League", "England")]]);

  await t("S3-1 再起動の直後(メモリの選手索引が空)でも、試合カードは保存先から索引を読み込んでから組み立てる(「取り込み中・選手0人」と出さない)", async () => {
    assert.strictEqual(saved.saved, true, "選手索引を保存できていない(テストの準備): " + JSON.stringify(saved).slice(0, 200));
    restart();
    assert.strictEqual(V100.playerIndexState().rows.length, 0);
    const r = await srv.handleFixtureAnalysis(new URLSearchParams({ id: "701" }));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.found, true, JSON.stringify(r.body).slice(0, 300));
    const k = r.body.knowledge;
    assert.ok(k && k.home && k.home.tracked === true, JSON.stringify(k).slice(0, 300));
    assert.ok(k.home.squad && k.home.squad.playersIndexed === 16, "再起動の直後に選手が0人として組み立てられている: " + JSON.stringify(k.home.squad));
    assert.strictEqual(k.indexUnavailable, false);
    assert.ok(k.home.dossier && k.home.dossier.standings && k.home.dossier.standings.rank === 2, "順位(position)が渡っていない: " + JSON.stringify(k.home.dossier && k.home.dossier.standings));
    assert.strictEqual(V100.playerIndexState().rows.length, 16, "索引が読み込まれていない");
    // 毎日の学習が使う主力の平均評価点も、索引を読み込んでから引く
    restart();
    const rating = await srv.learningDeps.squadRatingOf(42, "Arsenal");
    assert.ok(rating > 7 && rating < 7.2, "再起動の直後の学習で主力の評価点が欠ける: " + rating);
  });
  await t("S3-2 選手索引を読めないとき: 「選手がいない」ではなく「分からない」(indexUnavailable)として返し、その応答を長く覚えない(最長でも1分)", async () => {
    restart();
    S.failKeys.re = new RegExp("^" + playerSearch.INDEX_META_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|^" + String(playerSearch.INDEX_SHARD_PREFIX || playerSearch.INDEX_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "|^" + String(playerSearch.INDEX_GEN_PREFIX || "kb:player:index").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let r;
    try { r = await srv.handleFixtureAnalysis(new URLSearchParams({ id: "702" })); } finally { S.failKeys.re = null; }
    assert.strictEqual(r.body.found, true);
    const k = r.body.knowledge;
    assert.strictEqual(k.indexUnavailable, true, "索引を読めなかったことが応答に出ていない: " + JSON.stringify(k).slice(0, 300));
    assert.strictEqual(k.home.squad, null, "読めなかったのに「0人」の実測を作っている");
    // 覚える長さ: 試合カードの応答を覚える4か所すべてが ttlOf(…) を通る(読み切れなかった応答は最長1分)
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf("async function handleFixtureAnalysis("), SERVER_SRC.indexOf("\n}\n", SERVER_SRC.indexOf("const ttlOf = (ms) =>")) + 2);
    assert.ok(/const knowledgeIncomplete = !!\(knowledge && \(knowledge\.readFailed \|\| knowledge\.indexUnavailable\)\);\s*\n\s*const ttlOf = \(ms\) => \(knowledgeIncomplete \? Math\.min\(ms, 60 \* 1000\) : ms\);/.test(fn), "読み切れなかった応答を短く覚える仕組みが無い");
    const after = fn.slice(fn.indexOf("const ttlOf = (ms) =>"));
    const sets = after.match(/cacheSet\(cacheKey, payload, [^;]*\);/g) || [];
    assert.ok(sets.length >= 4, "cacheSet の数が想定と違う: " + sets.length);
    for (const s of sets) assert.ok(/cacheSet\(cacheKey, payload, ttlOf\(/.test(s), "ttlOf を通していない保存がある: " + s);
    // 配線: 試合カード・対戦分析・学習の3か所が、使う前に索引を読み込む
    assert.ok((SERVER_SRC.match(/await ensurePlayerIndexLoaded\(\);/g) || []).length >= 3, "索引を読み込んでから使う箇所が足りない");
  });

  // =====================================================================================
  console.log("■ S4 毎日の学習 → 成長ログ → 日次レポート");
  await t("S4 本物の学習が保存した成長ログから、日次レポートが動的クラブの採用結果を読める(v99〜v104 は項目名の食い違いで常に null・空だった)", async () => {
    const dj = require(path.join(__dirname, "learning/dailyJob.js"));
    const L = makeStore();
    // 候補(見かけた試合のクラブ)を2つ用意 → 今日の学習で採用される
    const dayKey = jst(now);
    const seenRow = (nameEn) => JSON.stringify({ nameEn, leagueId: 98, league: "J1 League", country: "Japan", firstSeen: dayKey, lastSeen: dayKey, seen: 3, views: 1, learned: true, missing: 0 });
    // (追跡名簿に無い名前を使う。名簿のクラブは候補から外されるため)
    L.data.set("kb:universe:dyn:seen", { 9301: seenRow("Sagan Tosu"), 9302: seenRow("Tokushima Vortis") });
    const callApi = async (endpoint, params) => {
      if (endpoint === "/teams") return { response: [{ team: { id: 100, name: params.search } }] };
      return { response: [] };
    };
    const out = await dj.runDailyLearning({ callApiFootball: callApi, resolveTeamId: async () => 100, upstashEnabled: true, upstashCmd: L.cmd, upstashGetJSON: L.getJSON, upstashSetJSON: L.setJSON, now: () => new Date(now) });
    assert.strictEqual(out.ok, true, JSON.stringify(out.errors || []).slice(0, 300));
    const growth = await L.getJSON("learn:growthlog:latest");
    assert.ok(growth && growth.dynamicUniverse, "成長ログに動的クラブの欄が無い");
    // 作る側(成長ログ)の本物の形
    const du = growth.dynamicUniverse;
    assert.strictEqual(du.ok, true, JSON.stringify(du).slice(0, 300));
    assert.ok(Array.isArray(du.adoptedToday) && du.adoptedToday.length === 2, "今日の採用が成長ログに無い: " + JSON.stringify(du).slice(0, 300));
    // 使う側(日次レポート)へ、その成長ログをそのまま渡す
    for (const [k, v] of L.data) if (/^learn:growthlog:/.test(k)) S.data.set(k, v);
    V97.clearCache();
    const rep = await get(`/api/learning/daily-report?t=${Date.now()}`);
    assert.strictEqual(rep.status, 200, rep.text.slice(0, 300));
    const got = rep.body.updates && rep.body.updates.dynamicUniverse;
    assert.ok(got, "日次レポートに動的クラブの欄が無い: " + JSON.stringify(rep.body.updates || {}).slice(0, 300));
    assert.strictEqual(got.adoptedNow, 2, "今日採用した数が日次レポートから見えない: " + JSON.stringify(got));
    assert.deepStrictEqual(got.adoptedNowNames.slice().sort(), ["Sagan Tosu", "Tokushima Vortis"]);
    assert.strictEqual(got.adoptedAll, du.adoptedTotal); assert.ok(got.adoptedAll >= 2);
    assert.strictEqual(got.candidates, du.candidates); assert.strictEqual(got.dueToday, du.dueToday);
    for (const k of ["nameCollisionSkipped", "duplicateRetired", "retiredAsStatic", "perDay"]) assert.strictEqual(got[k], du[k], "項目が渡っていない: " + k);
    // 日次レポートが読む項目名は、成長ログに実在する名前だけ(総当たり: レポートの値が null でない項目は、成長ログの値と一致)
    assert.ok(got.adoptedTodayBefore === du.adoptedTodayBefore || (got.adoptedTodayBefore === null && du.adoptedTodayBefore === undefined));
  });

  // =====================================================================================
  console.log("■ S5 会話の道具");
  await t("S5-1 的中率の実測: 学習済み/未学習の大会の差は件数つきで渡し、どちらかが10件未満なら差は渡さない。結果は上限内で JSON として読める", async () => {
    const mk = (hit, learned, league, odds) => ({ official: true, league, leagueCountry: "X", learned, oddsPresent: odds, markets: { oneX2: { hit, brier: hit ? 0.3 : 0.9, logLoss: hit ? 0.5 : 1.3, confidence: 0.6, predicted: "home", actual: hit ? "home" : "away", probs: { homeWin: 0.6, draw: 0.2, awayWin: 0.2 } } } });
    const leagues = Array.from({ length: 30 }, (_, i) => `とても名前の長い大会の名前その${i}(国内リーグ・1部)`);
    for (let d = 1; d <= 20; d++) {
      const dk = jst(now - d * 86400000);
      const scored = [];
      for (let i = 0; i < 30; i++) scored.push(mk(i % 5 !== 0, true, leagues[i], i % 2 === 0));
      if (d === 1) scored.push(mk(false, false, "未学習の大会", false)); // 未学習は期間を通して1試合だけ
      S.data.set(`learn:accuracy:${dk}`, JSON.stringify(accLib.buildDailyAccuracy(scored)));
    }
    V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const r = await discussTools.executeTool("get_accuracy_summary", {}, deps);
    assert.strictEqual(r.ok, true, r.resultJson.slice(0, 300));
    assert.ok(r.resultJson.length <= discussTools.MAX_RESULT_CHARS, "上限を超えている: " + r.resultJson.length);
    let parsed = null;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.resultJson); }, "途中で切れて JSON として読めない");
    const w30 = parsed.data.last30Days || parsed.data.windows && parsed.data.windows.last30Days;
    assert.ok(w30 && w30.byLearned, "直近30日の学習済み/未学習の内訳が無い: " + Object.keys(parsed.data).join(","));
    assert.strictEqual(w30.byLearned.unlearnedN, 1, JSON.stringify(w30.byLearned));
    assert.ok(w30.byLearned.learnedN >= 500);
    assert.strictEqual(w30.byLearned.gapPt, null, "未学習が1試合しか無いのに、的中率の差を根拠として渡している: " + JSON.stringify(w30.byLearned));
    assert.ok(typeof parsed.data.noteJa === "string" && parsed.data.noteJa.length > 20, "注記(noteJa)が落ちている");
    assert.ok(Array.isArray(parsed.data.byLeague) && parsed.data.byLeague.length >= 5, "リーグ別の一覧が無い");
  });
  await t("S5-2 外れの反省: 特定できないクラブ名を渡されても、全クラブの外れをそのクラブの外れとして返さない(名前が完全に一致する試合だけ・その旨を添える)", async () => {
    const rec = (id, home, away, hid, aid) => JSON.stringify({ fixtureId: id, resolved: true, correct: false, homeTeamEn: home, awayTeamEn: away, homeTeamId: hid, awayTeamId: aid, originTeamEn: home, predictedWinner: "home", actualWinner: "away", actualScore: { home: 0, away: 1 }, kickoff: new Date(now - 86400000).toISOString(), league: "Serie A", finalProbs: { homeWin: 0.6, draw: 0.2, awayWin: 0.2 }, failureReasons: [{ labelJa: "直近フォームを重視しすぎた" }] });
    S.data.set("learn:ownpred:recent", [rec(1, "Romania", "Kosovo", 774, 1111), rec(2, "AS Roma", "Lazio", 497, 487), rec(3, "Inter Miami", "Orlando City", 9568, 1598), rec(4, "Comoros", "Ghana", 1530, 1504)]);
    V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    const all = await discussTools.executeTool("get_recent_misses", {}, deps);
    assert.strictEqual(all.ok, true, all.resultJson.slice(0, 200)); assert.strictEqual(all.data.totalMissesInWindow, 4);
    const unknown = await discussTools.executeTool("get_recent_misses", { team: "ナイナイユナイテッド" }, deps);
    assert.strictEqual(unknown.ok, true);
    assert.strictEqual(unknown.data.totalMissesInWindow, 0, "特定できないクラブに、全クラブの外れを返している: " + unknown.resultJson.slice(0, 300));
    assert.ok(/特定できなかった/.test(unknown.data.teamNoteJa), unknown.data.teamNoteJa);
    const roma = await discussTools.executeTool("get_recent_misses", { team: "ローマ" }, deps);
    assert.deepStrictEqual(roma.data.items.map((x) => x.fixtureId), [2], "ローマの外れに Romania の試合が混ざっている: " + JSON.stringify(roma.data.items.map((x) => x.home)));
    const como = await discussTools.executeTool("get_recent_misses", { team: "Como" }, deps);
    assert.strictEqual(como.data.totalMissesInWindow, 0, "コモの外れに Comoros の試合が混ざっている");
  });
  await t("S5-3 今日の予想: 「次の試合」の読み出しに失敗したときは「予想がありません」ではなく「読めませんでした」と返す", async () => {
    const depsFail = { getTodayPredictions: async () => ({ found: true, date: jst(now), predictions: [], upcomingPredictions: [], upcomingReadFailed: true, noteJa: "本日の予想はありません" }) };
    const r = await discussTools.executeTool("get_today_predictions", {}, depsFail);
    assert.strictEqual(r.ok, false, "読めなかったのに「予想なし」として成功を返している: " + r.resultJson.slice(0, 200));
    assert.ok(/読み出せませんでした/.test(r.reasonJa) && /無いのではなく/.test(r.reasonJa), r.reasonJa);
    // 本当に0件のとき(読み出しは成功)は、従来どおり成功で0件
    const depsEmpty = { getTodayPredictions: async () => ({ found: true, date: jst(now), predictions: [], upcomingPredictions: [], upcomingReadFailed: false, noteJa: "本日の予想はありません" }) };
    const r2 = await discussTools.executeTool("get_today_predictions", {}, depsEmpty);
    assert.strictEqual(r2.ok, true); assert.strictEqual(r2.data.count, 0);
  });

  // =====================================================================================
  console.log("■ S6 クラブのまとめ");
  await t("S6 同じ名前の別クラブ(チームIDが違う)の予想を、追跡クラブの成績に混ぜない", async () => {
    const portoEn = require(path.join(__dirname, "learning/clubUniverse.js")).findClub("Porto").nameEn;
    S.data.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 212, nameEn: portoEn, nameJa: "FCポルト", tier: "A", dynamic: false }, { teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル", tier: "A", dynamic: false }] }));
    V98.teamKnowledge.invalidate();
    const rec = (id, home, away, hid, aid, origin, correct) => JSON.stringify({ fixtureId: id, resolved: true, correct, homeTeamEn: home, awayTeamEn: away, homeTeamId: hid, awayTeamId: aid, originTeamEn: origin, predictedWinner: "home", actualWinner: correct ? "home" : "away", actualScore: { home: correct ? 2 : 0, away: 1 }, kickoff: new Date(now - id * 86400000).toISOString(), resolvedAt: new Date(now - id * 86400000 + 7200000).toISOString(), league: "Primeira Liga", official: true });
    S.data.set("learn:ownpred:recent", [
      rec(1, portoEn, "Braga", 212, 217, portoEn, true),          // 本物(このアプリの表記で記録)
      rec(2, "Sporting CP", "FC Porto", 228, 212, "Sporting CP", true),  // 本物(相手側・提供元の表記・IDで一致)…名前は違うがIDが同じ
      rec(3, "Porto", "Vitoria BA", 9999, 9998, "Vitoria BA", false),    // 同じ名前の別クラブ(ブラジル)
      rec(4, "Porto", "Bahia", 9999, 9997, "Bahia", false),              // 同上
    ]);
    S.data.set("learn:ownpred:pending", []);
    V97.clearCache();
    const r = await get(`/api/club/summary?club=${encodeURIComponent(portoEn)}&t=${Date.now()}`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true, r.text.slice(0, 300));
    const text = JSON.stringify(r.body);
    assert.ok(!/Vitoria BA|Bahia/.test(text), "同じ名前の別クラブの試合が、追跡クラブのまとめに混ざっている: " + text.slice(0, 500));
    assert.ok(/Braga/.test(text), "本物のクラブの試合が入っていない: " + text.slice(0, 500));
  });

  // =====================================================================================
  console.log("■ S7 会話の道具「クラブの現状」");
  await t("S7 提供元の表記がこのアプリの表記と違うクラブ(FC Porto / Bayern München)でも、毎晩蓄積した調査ファイルの中身(順位など)が回答AIに届く。チームIDは検索し直さない", async () => {
    const U = require(path.join(__dirname, "learning/clubUniverse.js"));
    const portoEn = U.findClub("Porto").nameEn, bayernEn = U.findClub("Bayern Munich").nameEn;
    const iso = new Date(now - 3600000).toISOString();
    const dossier = (nameEn, teamId, pos) => JSON.stringify({ nameEn, teamId, tier: "A", updatedAt: iso, identity: { teamId, verifiedAt: iso }, sections: { standings: { position: pos, points: 30, played: 12, computedAt: iso } } });
    const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    S.data.set(`kb:club:${slug(portoEn)}`, dossier(portoEn, 212, 1)); S.data.set(`kb:club:${slug(bayernEn)}`, dossier(bayernEn, 157, 2));
    S.data.set("kb:club:arsenal", dossier("Arsenal", 42, 3)); // 本人確認済み(identity.verifiedAt)の調査ファイル
    S.data.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 212, nameEn: portoEn, nameJa: "FCポルト" }, { teamId: 157, nameEn: bayernEn, nameJa: "バイエルン・ミュンヘン" }, { teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル" }] }));
    // 名前の索引(毎晩の学習が採集する名簿)は提供元の表記
    S.data.set("learn:teamnames", JSON.stringify({ 212: "FC Porto", 157: "Bayern München", 42: "Arsenal", 9999: "Porto" }));
    V98.teamKnowledge.invalidate(); V97.clearCache();
    const deps = V104.buildDiscussToolDeps("1.1.1.1");
    for (const [q, en, pos] of [["ポルト", portoEn, 1], ["FC Porto", portoEn, 1], ["バイエルン", bayernEn, 2], ["Bayern München", bayernEn, 2], ["アーセナル", "Arsenal", 3]]) {
      apiCalls.length = 0;
      const rc = await deps.resolveClub(q);
      assert.deepStrictEqual([rc.ok, rc.labelEn], [true, en], `「${q}」の解決: ` + JSON.stringify(rc));
      const r = await discussTools.executeTool("get_team_snapshot", { team: q }, deps);
      assert.strictEqual(r.ok, true, r.resultJson.slice(0, 200));
      assert.strictEqual(r.data.team, en, "道具が提供元の表記でクラブを扱っている: " + r.data.team);
      if (pos !== null) assert.ok(r.data.facts.some((f) => new RegExp(`国内リーグ順位: ${pos}位`).test(f)), `「${q}」: 調査ファイルの順位が届いていない: ` + JSON.stringify(r.data.facts).slice(0, 300));
      assert.strictEqual(apiCalls.filter((c) => c.ep === "/teams").length, 0, `「${q}」: 確認済みのチームIDがあるのに検索し直している: ` + JSON.stringify(apiCalls.filter((c) => c.ep === "/teams")));
    }
    // 対戦分析に提供元の表記(FC Porto)で渡されても、このアプリの表記に引き直して確認済みのチームIDを使う(検索し直さない)
    apiCalls.length = 0; V97.clearCache();
    const ma = await V104.handleMatchAnalysis(new URLSearchParams({ home: "FC Porto", away: "Bayern München" }), "1.1.1.1", { skipLlm: true });
    assert.strictEqual(ma.body.ok, true, JSON.stringify(ma.body).slice(0, 300));
    assert.deepStrictEqual([ma.body.home.nameEn || ma.body.home.name, ma.body.away.nameEn || ma.body.away.name], [portoEn, bayernEn], JSON.stringify([ma.body.home, ma.body.away]).slice(0, 300));
    assert.strictEqual(apiCalls.filter((c) => c.ep === "/teams").length, 0, "提供元の表記で検索し直している: " + JSON.stringify(apiCalls.filter((c) => c.ep === "/teams")));
    // 名前の索引を読めない間(保存先の不調・初回)でも、追跡名簿のクラブは名簿の表記で特定する
    S.data.delete("learn:teamnames"); V97.clearCache();
    const deps2 = V104.buildDiscussToolDeps("1.1.1.1");
    const noIdx = await deps2.resolveClub("ポルト");
    assert.deepStrictEqual([noIdx.ok, noIdx.labelEn, noIdx.teamId], [true, portoEn, 212], "索引が無いと有名クラブまで特定できない: " + JSON.stringify(noIdx));
    const unknown = await deps2.resolveClub("ナイナイユナイテッド");
    assert.strictEqual(unknown.ok, false);
  });

  // =====================================================================================
  console.log("■ S8 クラブ力ランキング");
  await t("S8 提供元の表記がこのアプリの表記と違うクラブ(Bayern München / FC Porto)にも日本語名が付く(本番で、これらだけ日本語名が null だった)", async () => {
    const U = require(path.join(__dirname, "learning/clubUniverse.js"));
    const portoUni = U.findClub("Porto"), bayernUni = U.findClub("Bayern Munich");
    S.data.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 212, nameEn: portoUni.nameEn, nameJa: portoUni.nameJa }, { teamId: 157, nameEn: bayernUni.nameEn, nameJa: bayernUni.nameJa }, { teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル" }, { teamId: 9301, nameEn: "Sagan Tosu", nameJa: "Sagan Tosu", dynamic: true, idVerified: true }] }));
    S.data.set("learn:ratings:v1", JSON.stringify({ available: true, updatedAt: new Date(now).toISOString(), matches: 5000,
      byTeam: { 42: { att: 0.6, def: 1.0, n: 200 }, 157: { att: 0.9, def: 0.4, n: 180 }, 212: { att: 0.5, def: 0.5, n: 170 }, 9301: { att: 0.1, def: 0.1, n: 60 } },
      namesById: { 42: "Arsenal", 157: "Bayern München", 212: "FC Porto", 9301: "Sagan Tosu" } }));
    V98.teamKnowledge.invalidate(); V97.clearCache();
    const r = await get(`/api/ratings/rankings?t=${Date.now()}`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.available, true, r.text.slice(0, 300));
    const by = (id) => r.body.teams.find((x) => x.id === id);
    assert.strictEqual(by(42).nameJa, "アーセナル");
    assert.strictEqual(by(157).nameJa, bayernUni.nameJa, "Bayern München に日本語名が付いていない: " + JSON.stringify(by(157)));
    assert.strictEqual(by(212).nameJa, portoUni.nameJa, "FC Porto に日本語名が付いていない: " + JSON.stringify(by(212)));
    assert.strictEqual(by(9301).nameJa, null, "日本語名を持たないクラブ(動的クラブ)には、作った名前を付けない");
  });

  srv.server.close();
  console.log(`\nv104.1 audit (server): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
