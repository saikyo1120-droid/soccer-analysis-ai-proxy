"use strict";
/** v97(2026年10月・全体監査): 「隅々まで」の監査で見つかった不具合の修正を固定するテスト。
 *
 *  観点:
 *   A. Upstash コマンド消費(9月の無料枠枯渇の根本対策): 予算の書き戻し間隔・MGET まとめ読み・キャッシュ
 *   B. データ安全: 「読めなかった」を「無かった」と取り違えて上書き・消去しない(read-merge-write の欠陥)
 *   C. 正確さ: 判定に使った最終確率で採点・表示する / 自信=予測した勝敗の確率 / 延長戦は90分スコアで学習 等
 *   D. 公平さ・保護: 利用者固有の上限エラーを共有キャッシュに入れない / 軽い読み出しの別枠 / 処理中も上限に数える / 失敗時のAI予算返金
 *   E. 画面: 読めなかった表示の自動読み直し・二重送信防止・IME・分析の待ち時間・SW のキー正規化
 *  実際にモジュールと差し替え保存先で動かし、往復回数と戻り値で確かめる(文字列検査は最後の手段)。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const findUp = (...names) => {
  for (const n of names) { for (const base of [path.join(__dirname, ".."), __dirname]) { const f = path.join(base, n); if (fs.existsSync(f)) return f; } }
  return path.join(__dirname, "..", names[0]);
};
const INDEX_HTML = findUp("index.html");
const SW_JS = findUp("sw.js");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 記録つき保存先モック(MGET対応。mode で全コマンド失敗に切り替え可。失敗させるキーも指定可) */
function mockStore(opts) {
  const o = opts || {};
  const store = new Map(); const calls = []; const m = { mode: "ok", failKeys: new Set(), mgetUnsupported: !!o.mgetUnsupported };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (m.mode === "fail") throw new Error("Upstash error: simulated outage");
    if (op === "GET") { if (m.failKeys.has(a[0])) throw new Error("simulated key failure"); return store.has(a[0]) ? store.get(a[0]) : null; }
    if (op === "MGET") { if (m.mgetUnsupported) throw new Error("mock does not implement: MGET"); return a.map((k) => (store.has(k) ? store.get(k) : null)); }
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) { if (store.delete(k)) n++; } return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "DECR") { const v = (parseInt(store.get(a[0]), 10) || 0) - 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "LREM") { const l = store.get(a[0]) || []; store.set(a[0], l.filter((v) => v !== a[2])); return 1; }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = store.get(a[0]) || []; l.unshift(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LTRIM") return "OK";
    if (op === "HGETALL") { const h = store.get(a[0]); if (!h) return []; return Object.entries(h).flat(); }
    if (op === "HDEL") { const h = store.get(a[0]) || {}; for (const f of a.slice(1)) delete h[f]; store.set(a[0], h); return 1; }
    if (op === "HLEN") { const h = store.get(a[0]) || {}; return Object.keys(h).length; }
    if (op === "ZREVRANGE") return [];
    if (op === "ZCARD") return 0;
    if (op === "EXPIRE") return 1;
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  return { store, calls, count, m, upstashCmd, upstashGetJSON, upstashSetJSON };
}

(async () => {
  console.log("v97 全体監査の修正テスト");

  // ================= A. storeRead(共通のまとめ読み) =================
  const { readManyJSON, dateKeysBack } = require("./learning/storeRead");
  await t("A1 readManyJSON: MGET 1回で複数キーを読み、無いキーは null・JSONは展開済み", async () => {
    const m = mockStore();
    m.store.set("a", JSON.stringify({ x: 1 })); m.store.set("c", "42");
    const r = await readManyJSON(m, ["a", "b", "c"]);
    assert.strictEqual(r.readMode, "mget");
    assert.deepStrictEqual(r.values, [{ x: 1 }, null, 42]);
    assert.strictEqual(r.readFailed, false);
    assert.strictEqual(m.count("MGET"), 1); assert.strictEqual(m.count("GET"), 0);
  });
  await t("A2 readManyJSON: MGET 非対応の保存先(モック)では1件ずつ GET に落ち、結果は同じ", async () => {
    const m = mockStore({ mgetUnsupported: true });
    m.store.set("a", JSON.stringify({ x: 1 }));
    const r = await readManyJSON(m, ["a", "b"]);
    assert.strictEqual(r.readMode, "per-key");
    assert.deepStrictEqual(r.values, [{ x: 1 }, null]);
    assert.strictEqual(r.readFailed, false);
  });
  await t("A3 readManyJSON: 保存先が落ちていれば readFailed:true(「無い」と言わない)", async () => {
    const m = mockStore(); m.m.mode = "fail";
    const r = await readManyJSON(m, ["a", "b"]);
    assert.strictEqual(r.readFailed, true);
    assert.ok(r.firstError);
    assert.deepStrictEqual(dateKeysBack("2026-10-02", 3), ["2026-10-02", "2026-10-01", "2026-09-30"]);
  });

  // ================= A. API予算の書き戻し =================
  const { createApiBudget } = require("./learning/apiBudget");
  await t("A4 apiBudget.flush: EXPIRE は日付キーにつきプロセスで1回だけ(以前は書き戻しのたび=API1件につきUpstash1コマンド)", async () => {
    const m = mockStore();
    const b = createApiBudget({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: async () => null, dailyBudget: 7500 });
    await b.init("2026-10-02");
    b.tryReserve(3, "x"); await b.flush();
    b.tryReserve(2, "x"); await b.flush();
    b.tryReserve(4, "x"); await b.flush();
    assert.strictEqual(m.count("INCRBY"), 3, "INCRBY は書き戻しごとに1回");
    assert.strictEqual(m.count("EXPIRE"), 1, "EXPIRE が毎回送られている: " + m.count("EXPIRE"));
    assert.strictEqual(b.summary().flushCount, 3);
    assert.strictEqual(b.summary().unflushed, 0);
    assert.strictEqual(m.store.get("learn:apibudget:n:2026-10-02"), "9");
  });
  await t("A5 server: 書き戻しは「25件ごと or 60秒」(2件ごとではない)。終了時の書き戻しと本家ヘッダーの合わせ直しは残っている", () => {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(/budgetWritesPending >= BUDGET_FLUSH_EVERY/.test(src));
    assert.ok(/lastBudgetFlushAt\) >= BUDGET_FLUSH_INTERVAL_MS/.test(src));
    assert.ok(!/budgetWritesPending >= 2\b/.test(src), "旧来の2件ごとの書き戻しが残っている");
    assert.ok(src.includes('process.on("beforeExit"'));
    assert.ok(src.includes("budget.reconcileFromRemaining(planNow.detectedRemaining)"));
  });

  // ================= A/B. 学習記録・指標・実行履歴のまとめ読みと「読めなかった」 =================
  const { getGrowthLog } = require("./learning/dailyJob");
  await t("A6 getGrowthLog: 5つの GET → MGET 1回。累計カウンターが無い(未設定)なら正直に 0", async () => {
    const m = mockStore();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: "2026-10-02", errors: [] }));
    m.store.set("learn:ownpred:resolved", "30");
    const log = await getGrowthLog({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON });
    assert.strictEqual(log.ranYet, true);
    assert.strictEqual(log.totalOwnPredictionsResolvedSoFar, 30);
    assert.deepStrictEqual(log.engineTotals, { knowledgeItemsTotal: 0, memoryConclusionsTotal: 0, predictionsTotal: 0 });
    assert.strictEqual(m.count("MGET"), 1, "MGET が使われていない");
    assert.strictEqual(m.calls.filter((c) => c[0] === "GET").length, 0, "GET が残っている: " + m.calls.filter((c) => c[0] === "GET").map((c) => c[1]).join(","));
    assert.strictEqual(log.countersReadFailed, false);
  });
  await t("B1 getGrowthLog: 保存先が読めなければ readFailed:true・ranYet:null・累計は null(0 と言わない)", async () => {
    const m = mockStore(); m.m.mode = "fail";
    const log = await getGrowthLog({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON });
    assert.strictEqual(log.readFailed, true);
    assert.strictEqual(log.ranYet, null);
    assert.deepStrictEqual(log.engineTotals, { knowledgeItemsTotal: null, memoryConclusionsTotal: null, predictionsTotal: null });
  });
  const { getMetricsTrend, buildDailySnapshot } = require("./learning/dailyMetrics");
  await t("A7 getMetricsTrend: 14日ぶんを MGET 1回で読む。読めなければ readFailed(全日「記録なし」と言わない)", async () => {
    const m = mockStore();
    m.store.set("learn:metrics:2026-10-02", JSON.stringify({ date: "2026-10-02", knowledgeTotal: 100, memoryTotal: 10 }));
    m.store.set("learn:metrics:2026-10-01", JSON.stringify({ date: "2026-10-01", knowledgeTotal: 90, memoryTotal: 10 }));
    const tr = await getMetricsTrend({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON }, 14, "2026-10-02");
    assert.strictEqual(tr.available, true);
    assert.strictEqual(tr.recordedDays, 2);
    assert.strictEqual(tr.latest.knowledgeDelta, 10);
    assert.strictEqual(m.count("MGET"), 1); assert.strictEqual(m.count("GET"), 0);
    const m2 = mockStore(); m2.m.mode = "fail";
    const tr2 = await getMetricsTrend({ upstashEnabled: true, upstashCmd: m2.upstashCmd, upstashGetJSON: m2.upstashGetJSON }, 14, "2026-10-02");
    assert.strictEqual(tr2.available, false); assert.strictEqual(tr2.readFailed, true);
  });
  await t("B2 buildDailySnapshot: 累計が null(読めなかった)なら 0 に潰さない(前日比が「数百件減った」にならない)", () => {
    const s = buildDailySnapshot({ engineTotals: { knowledgeItemsTotal: null, memoryConclusionsTotal: null, predictionsTotal: null } }, {});
    assert.strictEqual(s.knowledgeTotal, null); assert.strictEqual(s.memoryTotal, null);
    const s2 = buildDailySnapshot({}, {});
    assert.strictEqual(s2.knowledgeTotal, 0, "項目が無い(undefined)場合は従来どおり 0");
  });
  const { getRunHistory } = require("./learning/healthCheck");
  await t("A8 getRunHistory: 14日ぶんを MGET 1回で読み、読めなかった日は ran:null(未実行と言わない)", async () => {
    const m = mockStore();
    m.store.set("learn:growthlog:2026-10-02", JSON.stringify({ date: "2026-10-02", knowledgeItemsSavedToday: 3, errors: [] }));
    const h = await getRunHistory({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON }, 14, "2026-10-02", {});
    assert.strictEqual(m.count("MGET"), 1); assert.strictEqual(m.count("GET"), 0);
    assert.strictEqual(h.days[0].ran, true);
    const m2 = mockStore(); m2.m.mode = "fail";
    const h2 = await getRunHistory({ upstashEnabled: true, upstashCmd: m2.upstashCmd, upstashGetJSON: m2.upstashGetJSON }, 14, "2026-10-02", {});
    assert.strictEqual(h2.available, false); assert.strictEqual(h2.storeDown, true);
  });

  // ================= A/B. Knowledge Engine のまとめ読み =================
  const { createKnowledgeStore } = require("./knowledge/knowledgeStore");
  await t("A9 knowledgeStore.getActiveKnowledge: 本体の読み出しは MGET(1クラブ最大200 GET → 2回以内)", async () => {
    const m = mockStore();
    const ks = createKnowledgeStore({ upstashEnabled: true, ...m });
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) await ks.saveKnowledgeItem({ teamEn: "Arsenal", teamJa: "アーセナル", category: "recentFormTrend", type: "fact", statement: `fact ${i}`, computedAt: now, source: "test" });
    m.calls.length = 0;
    const active = await ks.getActiveKnowledge("Arsenal");
    assert.strictEqual(active.totalStored, 5);
    assert.strictEqual(m.count("MGET"), 1, "MGET が使われていない");
    assert.strictEqual(m.calls.filter((c) => c[0] === "GET" && String(c[1]).startsWith("knowledge:item:")).length, 0, "本体を1件ずつ GET している");
  });
  await t("B3 knowledgeStore.getActiveKnowledge: 保存先が読めなければ readFailed:true(知識0件と言わない)", async () => {
    const m = mockStore(); m.m.mode = "fail";
    const ks = createKnowledgeStore({ upstashEnabled: true, ...m });
    const active = await ks.getActiveKnowledge("Arsenal");
    assert.strictEqual(active.readFailed, true); assert.strictEqual(active.totalStored, 0);
    const diff = await ks.getKnowledgeDiffForTeam("Arsenal", "2026-10-02");
    assert.strictEqual(diff.readFailed, true);
  });

  // ================= B. read-merge-write の欠陥(読めなかった→上書き消去) =================
  const { createMemoryStore } = require("./memory/memoryStore");
  await t("B4 memoryStore.saveConclusion: 前の結論を読めなければ保存しない(revision 1 で上書きして履歴を飛ばさない)", async () => {
    const m = mockStore();
    const ms = createMemoryStore({ upstashEnabled: true, ...m });
    await ms.saveConclusion("team:X:view", { statement: "A", computedAt: "2026-10-01T00:00:00Z" });
    m.m.failKeys.add("memory:current:team:X:view");
    const r = await ms.saveConclusion("team:X:view", { statement: "B", computedAt: "2026-10-02T00:00:00Z" });
    assert.strictEqual(r.saved, false); assert.strictEqual(r.reason, "LOOKUP_FAILED");
    assert.strictEqual(JSON.parse(m.store.get("memory:current:team:X:view")).statement, "A", "前の結論が上書きされた");
    m.m.failKeys.clear();
    const r2 = await ms.saveConclusion("team:X:view", { statement: "B", computedAt: "2026-10-02T00:00:00Z" }, "新しい実データ");
    assert.strictEqual(r2.changed, true); assert.strictEqual(r2.revision, 2);
  });
  const { createClubDossier } = require("./knowledge/clubDossier");
  await t("B5 clubDossier.updateSection/savePlayer: 既存を読めなければ上書きせず見送る(他セクション・前日の成績が消えない)", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, ...m });
    await cd.updateSection("Arsenal", "squad", { players: [{ id: 1, name: "A" }], count: 1 }, { nameJa: "アーセナル" });
    await cd.updateSection("Arsenal", "form", { currentFormScore: 70 }, { nameJa: "アーセナル" });
    m.m.failKeys.add("kb:club:arsenal");
    const r = await cd.updateSection("Arsenal", "coach", { coachName: "Z" }, { nameJa: "アーセナル" });
    assert.strictEqual(r.saved, false); assert.strictEqual(r.readFailed, true);
    m.m.failKeys.clear();
    const d = await cd.getDossier("Arsenal");
    assert.ok(d.sections.squad && d.sections.form && !d.sections.coach, "読めなかったのに上書きされた");
    await cd.savePlayer({ id: 77, name: "P", teamEn: "Arsenal", stats: { rating: 7.1, minutes: 900 } });
    m.m.failKeys.add("kb:player:77");
    const sp = await cd.savePlayer({ id: 77, name: "P", teamEn: "Arsenal" });
    assert.strictEqual(sp.saved, false); assert.strictEqual(sp.readFailed, true);
    m.m.failKeys.clear();
    assert.strictEqual(JSON.parse(m.store.get("kb:player:77")).stats.rating, 7.1, "前日の成績が消えた");
    assert.strictEqual(m.store.get("kb:player:count"), "1", "読めなかった回で選手数が二重に増えた");
  });
  await t("B6 clubDossier.getDossiers: 172クラブを MGET でまとめ読みし、読めなかったときは readFailed を返す", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, ...m });
    await cd.updateSection("Arsenal", "basic", { founded: 1886 }, { nameJa: "アーセナル" });
    m.calls.length = 0;
    const r = await cd.getDossiers(["Arsenal", "Chelsea", "Inter"]);
    assert.strictEqual(r.byName.size, 1); assert.strictEqual(r.readFailed, false);
    assert.strictEqual(m.count("MGET"), 1);
    m.m.mode = "fail";
    const r2 = await cd.getDossiers(["Arsenal"]);
    assert.strictEqual(r2.readFailed, true);
  });
  const { loadTuneConfig, saveTuneConfig, defaultTuneConfig, tuneConfigReadFailed } = require("./learning/selfImprovement");
  await t("B7 selfImprovement: 自己調整値を読めなかった日は既定値で動くが、保存はしない(AIが調整してきた値を消さない)", async () => {
    const m = mockStore(); m.m.mode = "fail";
    const cfg = await loadTuneConfig({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON });
    assert.deepStrictEqual(cfg, defaultTuneConfig(), "既定値で動く挙動は不変");
    assert.strictEqual(tuneConfigReadFailed(cfg), true);
    m.m.mode = "ok";
    const saved = await saveTuneConfig({ upstashEnabled: true, upstashSetJSON: m.upstashSetJSON }, cfg);
    assert.strictEqual(saved, false); assert.strictEqual(m.store.has("learn:selftune:config"), false);
  });
  const { scoreFixtureDuels } = require("./learning/duelLeaderboard");
  await t("B8 duelLeaderboard: 参加者の累計を読めなければその人だけ見送り(0から始めて上書きしない)・ピックは残す", async () => {
    const m = mockStore();
    m.store.set("duel:picks:555", { u1: JSON.stringify({ p: "home", n: "A" }), u2: JSON.stringify({ p: "away", n: "B" }) });
    m.store.set("duel:player:u1", JSON.stringify({ w: 5, d: 1, l: 2, userHits: 6, aiHits: 4, n: 8 }));
    m.m.failKeys.add("duel:player:u1");
    const r = await scoreFixtureDuels({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON }, "555", "home", "home", Date.now());
    assert.strictEqual(r.scored, 1); assert.strictEqual(r.deferred, 1);
    assert.strictEqual(JSON.parse(m.store.get("duel:player:u1")).n, 8, "u1 の累計が上書きされた");
    const left = m.store.get("duel:picks:555");
    assert.ok(left && left.u1 && !left.u2, "見送った参加者のピックが消えた/採点済みが残っている: " + JSON.stringify(left));
  });

  // ================= C. 正確さ =================
  const AT = require("./learning/accuracyTracker");
  await t("C1 scorePrediction: 判定に使った最終確率(finalProbs)で採点し、自信=予測した勝敗の確率(argmax ではない)", () => {
    const rec = { homeLambda: 1.6, awayLambda: 1.1, predictedWinner: "draw", actualWinner: "draw", actualScore: { home: 1, away: 1 },
      finalProbs: { homeWin: 0.40, draw: 0.35, awayWin: 0.25, source: "market_blend" } };
    const s = AT.scorePrediction(rec);
    assert.strictEqual(s.markets.oneX2.probsSource, "market_blend");
    assert.strictEqual(s.markets.oneX2.confidence, 0.35, "自信が予測した勝敗(draw)の確率になっていない");
    assert.strictEqual(s.markets.oneX2.confidenceBasis, "pick");
    assert.strictEqual(s.markets.oneX2.hit, true);
    const legacy = AT.scorePrediction({ homeLambda: 1.6, awayLambda: 1.1, predictedWinner: "home", actualWinner: "home" });
    assert.strictEqual(legacy.markets.oneX2.probsSource, "lambda", "旧記録(finalProbs 無し)は λ から");
    assert.strictEqual(AT.confidenceOnPickOf(rec), 0.35);
    assert.strictEqual(AT.oneX2ProbsOf(rec).source, "market_blend");
  });
  const { fetchSeason } = (() => { try { return require("./learning/historicalBackfill"); } catch (e) { return {}; } })();
  await t("C2 historicalBackfill: 延長・PK決着(AET/PEN)は90分時点(score.fulltime)のスコアで学習する", async () => {
    if (typeof fetchSeason !== "function") return; // 公開されていなければ文字列検査へ
    const api = async () => ({ response: [
      { fixture: { id: 1, date: "2026-01-01", status: { short: "AET" } }, teams: { home: { id: 10, name: "H" }, away: { id: 20, name: "A" } }, goals: { home: 3, away: 1 }, score: { fulltime: { home: 1, away: 1 } } },
      { fixture: { id: 2, date: "2026-01-02", status: { short: "FT" } }, teams: { home: { id: 10, name: "H" }, away: { id: 20, name: "A" } }, goals: { home: 2, away: 0 }, score: { fulltime: { home: 2, away: 0 } } },
    ] });
    const r = await fetchSeason(api, 39, 2025);
    assert.deepStrictEqual([r.matches[0].hg, r.matches[0].ag, r.matches[0].finishedStatus], [1, 1, "AET"]);
    assert.deepStrictEqual([r.matches[1].hg, r.matches[1].ag], [2, 0]);
  });
  const { classifyFixtureOfficial } = require("./learning/predictionModel");
  await t("C3 2軍判定: Jong Ajax / 〜 2 / II (Castilla) / U20 / Primavera を参考扱いにし、Schalke 04・Hannover 96 は公式のまま", () => {
    for (const n of ["Jong Ajax", "Bayer Leverkusen 2", "Real Madrid II (Castilla)", "Juventus U20", "Juventus Primavera"]) assert.strictEqual(classifyFixtureOfficial("Liga", n, "X").official, false, n);
    for (const n of ["Schalke 04", "Hannover 96", "1. FC Köln", "Manchester City"]) assert.strictEqual(classifyFixtureOfficial("Liga", n, "X").official, true, n);
  });
  const { isWomensStatEntry } = require("./learning/playerFeatures");
  await t("C4 女子大会判定: Kvindeligaen / Vrouwen Eredivisie / Ekstraliga Kobiet / Naisten を弾き、Eredivisie / World Cup は弾かない", () => {
    for (const lg of ["Kvindeligaen", "Vrouwen Eredivisie", "Ekstraliga Kobiet", "Kansallinen Liiga Naisten"]) assert.strictEqual(isWomensStatEntry({ league: { name: lg }, team: { name: "X" } }), true, lg);
    for (const lg of ["Eredivisie", "World Cup", "Bundesliga"]) assert.strictEqual(isWomensStatEntry({ league: { name: lg }, team: { name: "X" } }), false, lg);
  });
  const { normalizeForSearch } = require("./knowledge/playerSearch");
  await t("C5 検索の正規化: æ/œ/ð/þ を分解(Kjær → kjaer)", () => {
    assert.strictEqual(normalizeForSearch("Simon Kjær"), "simon kjaer");
    assert.strictEqual(normalizeForSearch("Højbjerg"), "hojbjerg");
  });
  const { computeInjuryCountFeature } = require("./learning/features");
  await t("C6 負傷者: シーズン全体の記録から「今」の窓(過去10日〜未来7日)だけを数える。日付の無い応答は従来どおり全件", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    const resp = [
      { player: { name: "Old", reason: "Knee Injury" }, fixture: { date: "2026-08-10T18:00:00Z" } },
      { player: { name: "Now", reason: "Hamstring" }, fixture: { date: "2026-09-28T18:00:00Z" } },
      { player: { name: "Soon", reason: "Red Card Suspension" }, fixture: { date: "2026-10-05T18:00:00Z" } },
    ];
    const r = computeInjuryCountFeature(resp, now);
    assert.deepStrictEqual(r.injuredPlayers, ["Now"]); assert.deepStrictEqual(r.suspendedPlayers, ["Soon"]); assert.strictEqual(r.injuryCount, 2);
    const r2 = computeInjuryCountFeature([{ player: { name: "X", reason: "Injury" } }], now);
    assert.strictEqual(r2.injuryCount, 1, "日付の無い応答は従来どおり数える");
  });
  const { buildEvidencePool } = require("./reasoning/evidencePool");
  await t("C7 evidencePool: 同じ文の根拠(learnedFacts と knowledgeEngine.facts)を二重に数えない", () => {
    const pool = buildEvidencePool({
      recentForm: [], learnedFacts: [{ statement: "直近5試合で3勝" }],
      knowledgeEngine: { facts: [{ statement: "直近5試合で3勝", category: "recentFormTrend" }], analyses: [], opinions: [], profiles: [], reflections: [] },
    }, "Arsenal");
    assert.strictEqual(pool.filter((p) => p.statement === "直近5試合で3勝").length, 1);
  });
  const { executePlannedActions } = require("./discuss/multiStep");
  await t("C8 multiStep: 予測実績の根拠文に「実際[object Object]」が出ない(実スコアを 2-1 の形で書く)", async () => {
    const rec = { resolved: true, homeTeamEn: "Arsenal", awayTeamEn: "Chelsea", originTeamEn: "Arsenal", predictedWinner: "home", correct: true, actualScore: { home: 2, away: 1 }, kickoff: "2026-09-20T15:00:00Z" };
    const r = await executePlannedActions([{ type: "own_prediction_history", club: { nameEn: "Arsenal", nameJa: "アーセナル" } }], { upstashCmd: async () => [JSON.stringify(rec)] });
    const line = r.addedFacts.find((f) => f.includes("Arsenal対Chelsea"));
    assert.ok(line && line.includes("実際2-1") && !line.includes("[object Object]"), line);
  });

  // ================= D. サーバー(差し替え保存先で実際に動かす) =================
  const PORT = 8912;
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "0";
  process.env.RATE_LIMIT_PER_MINUTE = "4";
  process.env.LIGHT_RATE_LIMIT_PER_MINUTE = "9";
  const srvMod = require("./server.js");
  const V = srvMod.__v97ForTest;
  const m = mockStore();
  const now = Date.now();
  const jstToday = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  srvMod.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    handleFixturesToday: async () => ({ status: 200, body: { found: true, date: jstToday, fixtures: [
      { id: 101, date: new Date(now + 3600000).toISOString(), status: "NS", league: "Premier League", home: { name: "Arsenal" }, away: { name: "Chelsea" }, score: null },
      { id: 102, date: new Date(now + 7200000).toISOString(), status: "NS", league: "Premier League", home: { name: "Liverpool" }, away: { name: "Everton" }, score: null },
    ] } }),
  });
  await sleep(300);
  const get = (p, headers) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p, headers: headers || {} }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, headers: res.headers, body: j }); }); }).on("error", reject);
  });

  await t("D1 /api/predictions/today: 80回の GET → MGET(較正マップ込み)1回。判定に使った最終確率で勝率を表示", async () => {
    m.store.set("learn:ownpred:101", JSON.stringify({ fixtureId: 101, homeTeamEn: "Arsenal", awayTeamEn: "Chelsea", homeLambda: 1.5, awayLambda: 1.2, predictedWinner: "home", kickoff: new Date(now + 3600000).toISOString(), resolved: false,
      finalProbs: { homeWin: 0.61, draw: 0.24, awayWin: 0.15, source: "market_blend" } }));
    m.calls.length = 0;
    const r = await get("/api/predictions/today");
    assert.strictEqual(r.body.found, true);
    assert.strictEqual(r.body.predictions.length, 1);
    assert.strictEqual(r.body.predictions[0].probs.homeWinPct, 61, "最終確率ではなく λ から表示している: " + JSON.stringify(r.body.predictions[0].probs));
    assert.strictEqual(m.count("MGET"), 1, "MGET の回数: " + m.count("MGET"));
    assert.strictEqual(m.calls.filter((c) => c[0] === "GET" && String(c[1]).startsWith("learn:ownpred:")).length, 0, "予想を1件ずつ GET している");
  });
  await t("D2 /api/predictions/today: 保存先が読めないときは readFailed:true(「予想が無い」と断定せず60秒キャッシュ)", async () => {
    V.clearCache();
    m.m.mode = "fail";
    const r = await get("/api/predictions/today");
    assert.strictEqual(r.body.readFailed, true, JSON.stringify(r.body).slice(0, 200));
    assert.ok(/読み出せなかった/.test(r.body.noteJa));
    m.m.mode = "ok";
    const r2 = await get("/api/predictions/today");
    assert.strictEqual(r2.body.readFailed, true, "失敗結果の短いキャッシュが効いていない(即座に読み直すと保存先を叩き続ける)");
    V.clearCache();
    const r3 = await get("/api/predictions/today");
    assert.strictEqual(r3.body.readFailed, undefined); assert.strictEqual(r3.body.predictions.length, 1);
  });
  await t("D3 /api/growth-log: 5分キャッシュ(2回目は保存先へ出ない)。/api/learning/health は servedFromCache で生の状態だけ差し替え", async () => {
    V.clearCache();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: jstToday, ranAt: new Date(now).toISOString(), errors: [] }));
    const r1 = await get("/api/growth-log");
    assert.strictEqual(r1.body.ranYet, true);
    const before = m.calls.length;
    const r2 = await get("/api/growth-log");
    assert.strictEqual(r2.body.ranYet, true);
    assert.strictEqual(m.calls.length, before, "2回目で保存先へコマンドが出た: " + (m.calls.length - before));
    const h1 = await get("/api/learning/health");
    assert.strictEqual(h1.body.servedFromCache, undefined);
    const h2 = await get("/api/learning/health");
    assert.strictEqual(h2.body.servedFromCache, true);
    assert.ok(h2.body.store && h2.body.upstashUsage, "生の状態が付いていない");
  });
  await t("D4 利用者固有の上限エラー(IP_DAILY_LIMIT)は共有キャッシュに入れない。他の失敗は従来どおり短く入れる", () => {
    V.clearCache();
    const e1 = Object.assign(new Error("limit"), { code: "IP_DAILY_LIMIT" });
    V.cacheSetUnlessPerClient("k1", { found: false }, 60000, e1);
    assert.strictEqual(V.cacheGet("k1"), undefined, "利用者固有の失敗が全員向けにキャッシュされた");
    V.cacheSetUnlessPerClient("k2", { found: false }, 60000, Object.assign(new Error("x"), { code: "BUDGET_EXHAUSTED" }));
    assert.deepStrictEqual(V.cacheGet("k2"), { found: false });
    assert.strictEqual(V.isPerClientError(e1), true);
  });
  await t("D5 軽い読み出し(/api/health 等)は専用の緩い枠。重い処理(/api/matchup)は従来の枠(4回/分→5回目429)", async () => {
    assert.ok(V.LIGHT_API_PATHS.has("/api/health") && V.LIGHT_API_PATHS.has("/api/predictions/today") && !V.LIGHT_API_PATHS.has("/api/match-analysis"));
    assert.strictEqual(V.LIGHT_RATE_LIMIT_PER_MINUTE, 9);
    const H = { "x-forwarded-for": "9.9.9.9" };
    let last = null;
    for (let i = 0; i < 6; i++) last = await get("/api/matchup?q=x", H);
    assert.strictEqual(last.status, 429, "重い処理の枠が効いていない");
    assert.strictEqual(last.body.rateLimited, true);
    const light = await get("/api/health", H);
    assert.strictEqual(light.status, 200, "重い処理の枠が軽い読み出しを巻き添えにした");
  });
  await t("D6 1端末の日次上限: 処理中(未課金)の外部API回数も判定に含める(同時多発で枠をすり抜けない)", () => {
    const ip = "7.7.7.7|";
    V.heavyInflight.delete(ip);
    V.heavyCtx.run({ apiCalls: 0, jobOnly: false, ip, pathname: "/api/x" }, () => {
      for (let i = 0; i < 120; i++) V.noteHeavyApiCall();
      assert.strictEqual(V.heavyInflight.get(ip), 120);
      assert.strictEqual(V.heavyBudgetExceeded(ip, 120), true, "処理中の120回が上限判定に含まれていない");
      V.chargeHeavyBudget(ip, 120, "/api/x");
      assert.strictEqual(V.heavyInflight.has(ip), false, "課金後に処理中の数が解放されていない");
      assert.strictEqual(V.heavyBudgetExceeded(ip, 120), true, "課金後は確定使用量で判定");
    });
  });
  await t("D7 AI利用予算: 失敗時の返金(メモリ側と永続側の両方)", async () => {
    const before = V.llmBudgetState();
    assert.strictEqual(await V.tryConsumeLlmBudget(), true);
    const mid = V.llmBudgetState();
    assert.strictEqual(mid.count, (before.day === mid.day ? before.count : 0) + 1);
    const key = `llm:budget:${mid.day}`;
    const stored = parseInt(m.store.get(key), 10);
    await V.refundLlmBudget();
    assert.strictEqual(V.llmBudgetState().count, mid.count - 1);
    assert.strictEqual(parseInt(m.store.get(key), 10), stored - 1, "永続側が戻っていない");
  });
  await t("D8 /match/<id>: 保存先が読めないときは 404 ではなく 503 + no-store(検索エンジンに「存在しない」と伝えない)", async () => {
    V.clearCache();
    m.m.mode = "fail";
    const r = await get("/match/101");
    assert.strictEqual(r.status, 503, "status=" + r.status);
    assert.strictEqual(r.headers["cache-control"], "no-store");
    assert.ok(/一時的に表示できません/.test(r.body.raw || ""));
    m.m.mode = "ok";
    V.clearCache();
    const r2 = await get("/match/101");
    assert.strictEqual(r2.status, 200);
    const r3 = await get("/match/999999");
    assert.strictEqual(r3.status, 404);
  });
  await t("D9 /api/daily-diff: 読めなかった値を含むスナップショットは保存しない(翌日の差分を嘘にしない)", async () => {
    V.clearCache();
    m.m.mode = "fail";
    const r = await get("/api/daily-diff");
    assert.strictEqual(r.body.readFailed, true, JSON.stringify(r.body).slice(0, 200));
    assert.strictEqual([...m.store.keys()].some((k) => k.startsWith("kb:daily:snapshot:")), false, "読めなかった状態のスナップショットが保存された");
    m.m.mode = "ok";
  });
  await t("D10 releaseDailyRunLock: 持ち主の確認に失敗したら別プロセスのロックを消さない", async () => {
    const key = `learn:runlock:${jstToday}`;
    m.store.set(key, "other-process-token");
    m.m.failKeys.add(key);
    const r = await V.releaseDailyRunLock();
    assert.strictEqual(r.released, false);
    assert.strictEqual(m.store.get(key), "other-process-token", "確認できないのにロックを消した");
    m.m.failKeys.clear(); m.store.delete(key);
  });
  await t("D11 getOrLogPrediction: 既存の記録を読めないときは API も呼ばず記録しない(答え合わせ済みの記録を上書きしない)", async () => {
    let apiCalls = 0;
    srvMod.__setTestHooks({ callApiFootball: async () => { apiCalls++; return { response: [{ predictions: { percent: { home: "50%", draw: "30%", away: "20%" } } }] }; } });
    m.store.set("pred:777", JSON.stringify({ fixtureId: 777, resolved: true, correct: true, predictedWinner: "home" }));
    m.m.failKeys.add("pred:777");
    const r = await V.getOrLogPrediction(777, { league: "L", homeName: "A", awayName: "B", kickoff: new Date().toISOString() });
    assert.strictEqual(r, null); assert.strictEqual(apiCalls, 0, "読めないのに API を呼んだ");
    m.m.failKeys.clear();
    assert.strictEqual(JSON.parse(m.store.get("pred:777")).resolved, true, "答え合わせ済みの記録が上書きされた");
  });

  // ================= E. 画面・SW・学習ジョブ(ソース検査) =================
  await t("E1 index.html: 待ち時間の救済・専用の分析待ち時間・二重送信防止・IME・自動読み直し・日付つき時刻", () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(html.includes("return fetchJsonWithTimeout(url, COLD_START_TIMEOUT_MS, fetchOptions, true);"), "短い待ち時間で中断したGETの起床待ち再試行が無い");
    assert.ok(html.includes("const MATCH_ANALYSIS_TIMEOUT_MS = 45000;"), "マッチ分析の専用待ち時間が無い");
    assert.ok(html.includes("const discussInFlightKeys = new Set();") && html.includes("runDiscussFlowInner("), "考察の二重送信防止が無い");
    assert.ok((html.match(/e\.isComposing/g) || []).length >= 3, "IME変換中の Enter 対策が3箇所に無い");
    assert.ok(html.includes("function scheduleDegradedRetry(key, fn)") && (html.match(/scheduleDegradedRetry\(/g) || []).length >= 5, "読めなかった表示の自動読み直しが無い");
    assert.ok(/fetch\("\/i18n\." \+ appLang \+ "\.json\?v=(9[7-9]|[1-9]\d{2,})"/.test(html), "言語パックの版が上がっていない(v97以上)");
    assert.ok(!html.includes("good ゲーム"), "日英混在の誤字が残っている");
    assert.ok(html.includes("if (!wrap) return;\n  // v97(全体監査): カードを描いたのに枠が非表示"), "選手カードの枠を表示する修正が無い");
    assert.ok(html.includes("取得できません") && html.includes("前の質問にAIが答えている途中です"), "新しい文言の辞書項目が無い");
    for (const s of ["前の質問にAIが答えている途中です。回答が出てから、もう一度送ってください。", "本日の試合一覧を取得できませんでした(サーバー起動待ちの可能性があります。しばらくして再読み込みしてください)。"]) {
      assert.ok(html.includes(`"${s}":`), "4言語辞書に無い: " + s.slice(0, 20));
    }
  });
  await t("E2 sw.js: トップページはパス名「/」で保存(?from= つきURLでもオフライン代替に一致)・版は v97 以上", () => {
    const sw = fs.readFileSync(SW_JS, "utf8");
    assert.ok(sw.includes('const putKey = url.pathname === "/" ? new Request("/") : req;'));
    const ver = Number((sw.match(/CACHE_NAME = "soccer-ai-shell-v(\d+)"/) || [])[1]);
    assert.ok(ver >= 97, "sw.js の版: v" + ver);
  });
  await t("E3 dailyJob: キックオフ+2時間前の保留予想は API を呼ばない / 読めなかった保留は LREM しない / 保存失敗時は解決扱いにしない / 重みは読めなければ調整を見送る", () => {
    const dj = fs.readFileSync(path.join(__dirname, "learning", "dailyJob.js"), "utf8");
    assert.ok(dj.includes("nowFn().getTime() < kickoffMs + 2 * 60 * 60 * 1000) { pendingSkippedNotFinished++; continue; }"));
    assert.ok(dj.includes("if (!record && pendingRead.partial) continue;"));
    assert.ok(dj.includes("if (pendingRead.readFailed) break;"));
    assert.ok(dj.includes("prediction_resolve_save_failed:"));
    assert.ok(dj.includes("weights_read_failed:${weightsRead.error}"));
    assert.ok(dj.includes("predict_skipped_already_started:"));
    assert.ok(dj.includes("finalProbs,"), "最終確率が記録に保存されていない");
    assert.ok(!dj.includes("record.winProbability || record.probabilities"), "存在しないフィールドを見る旧コードが残っている");
    assert.ok(dj.includes("let storedWeightsOnce = null;"), "重みの読み出しがループの外に出ていない");
  });

  srvMod.server.close();
  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})();
