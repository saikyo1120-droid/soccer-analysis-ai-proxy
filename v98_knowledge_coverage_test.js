"use strict";
/** v98(2026年11月・利用者の指摘「登録選手データがない試合が多い/AIの判断根拠が分からない」):
 *   ① 試合カードの選手データを画面内の手書き名簿(11クラブ)ではなく、サーバーの知識(172クラブ+動的クラブ)から組み立てる
 *   ② 全カードに根拠(効いた要素・使えたデータ・欠けたデータ)を出す
 *   ③ 見た試合のクラブを翌日までに自動で取り込む(動的クラブ宇宙)
 *   ④ 予想時の欠損データを記録し、外れ理由 data_missing と翌日の優先取得に接続する
 *   ⑤ 主力選手の評価点(squadRatingDiff)を特徴量として追加し、既存の日次検証で採否を判定する
 *   ⓪ Upstash 使用量カウンターの終了時積み上げ(再デプロイで消えていた分)
 *  実際にモジュールと差し替え保存先で動かし、往復回数と戻り値で確かめる。 */
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

function mockStore() {
  const store = new Map(); const calls = []; const m = { mode: "ok" };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (m.mode === "fail") throw new Error("Upstash error: simulated outage");
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) { if (store.delete(k)) n++; } return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = store.get(a[0]) || []; l.unshift(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LTRIM") return "OK";
    if (op === "HSET") { const h = store.get(a[0]) || {}; let n = 0; for (let i = 1; i + 1 < a.length; i += 2) { if (!(a[i] in h)) n++; h[a[i]] = a[i + 1]; } store.set(a[0], h); return n; }
    if (op === "HGETALL") { const h = store.get(a[0]); if (!h) return []; return Object.entries(h).flat(); }
    if (op === "HDEL") { const h = store.get(a[0]) || {}; let n = 0; for (const f of a.slice(1)) { if (f in h) { delete h[f]; n++; } } store.set(a[0], h); return n; }
    if (op === "HINCRBY") { const h = store.get(a[0]) || {}; h[a[1]] = String((parseInt(h[a[1]], 10) || 0) + (parseInt(a[2], 10) || 0)); store.set(a[0], h); return parseInt(h[a[1]], 10); }
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
  console.log("v98 知識の守備範囲・根拠表示・動的クラブ・データ不足学習・主力評価点のテスト");

  // ================= ⑤ 予測モデル: squadRatingDiff =================
  const PM = require("./learning/predictionModel");
  const { buildMatchFeatures } = require("./learning/featureEngine");
  await t("E1 squadRatingDiff: 両チームに実測があるときだけ差になり、片方でも無ければ0(推測で埋めない)・supplied/missingFeatures に反映", () => {
    const base = { form: { currentFormScore: 1, avgGoalsFor: 1.5, avgGoalsAgainst: 1.0, matchesLast7Days: 1 }, injuries: { injuryCount: 1, suspendedPlayers: [] }, standings: { points: 10, played: 5 } };
    const both = buildMatchFeatures({ ...base, teamId: 1, squadRating: 7.1 }, { ...base, teamId: 2, squadRating: 6.8 }, null, null);
    assert.ok(Math.abs(both.features.squadRatingDiff - 0.3) < 1e-9, JSON.stringify(both.features.squadRatingDiff));
    assert.strictEqual(both.supplied.squadRatingDiff, true);
    assert.ok(!both.missingFeatures.includes("squadRatingDiff"));
    const one = buildMatchFeatures({ ...base, teamId: 1, squadRating: 7.1 }, { ...base, teamId: 2, squadRating: null }, null, null);
    assert.strictEqual(one.features.squadRatingDiff, 0);
    assert.strictEqual(one.supplied.squadRatingDiff, false);
    assert.ok(one.missingFeatures.includes("squadRatingDiff"));
    assert.ok(one.missingFeatures.includes("xgDiff") && one.missingFeatures.includes("marketEdge"), "欠けた特徴量が一覧に出る: " + one.missingFeatures.join(","));
  });
  await t("E2 既定の重みは0(採用前は予測が1ビットも変わらない)・学習対象(LEARNABLE_KEYS)と日本語名に含まれる", () => {
    assert.strictEqual(PM.EXTENDED_DEFAULT_WEIGHTS.squadRatingSensitivity, 0);
    assert.ok(PM.LEARNABLE_KEYS.includes("squadRatingSensitivity"));
    assert.strictEqual(PM.FEATURE_WEIGHT_MAP.squadRatingDiff, "squadRatingSensitivity");
    assert.ok(PM.FEATURE_LABELS_JA.squadRatingDiff);
    const f = { formDiff: 0.5, squadRatingDiff: 0.4 };
    const a = PM.predictOutcomeV2(f, { ...PM.EXTENDED_DEFAULT_WEIGHTS });
    const b = PM.predictOutcomeV2({ ...f, squadRatingDiff: 0 }, { ...PM.EXTENDED_DEFAULT_WEIGHTS });
    assert.strictEqual(a.homeLambda, b.homeLambda); assert.strictEqual(a.awayLambda, b.awayLambda);
    const c = PM.predictOutcomeV2(f, { ...PM.EXTENDED_DEFAULT_WEIGHTS, squadRatingSensitivity: 0.5 });
    assert.ok(c.homeLambda > a.homeLambda, "重みが付けば効く");
  });
  await t("E3 特徴量の有効性レポート(ablation)に主力評価点が「未学習」として現れる(採用の判断材料が見える)", () => {
    const recs = Array.from({ length: 6 }, (_, i) => ({ actualWinner: i % 2 ? "home" : "away", features: { formDiff: i % 2 ? 0.5 : -0.5, squadRatingDiff: 0.2 } }));
    const rep = PM.computeFeatureEffectiveness(recs, { ...PM.EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.3 });
    const row = rep.features.find((f) => f.key === "squadRatingDiff");
    assert.ok(row && /未学習/.test(row.verdictJa), JSON.stringify(row));
  });

  // ================= ④ 外れ理由 data_missing =================
  await t("F1 classifyFailureReasons: missingFeatures のある外れは data_missing を必ず含む(上位3件の枠とは別)", () => {
    const record = { predictedWinner: "home", actualWinner: "away", correct: false,
      features: { formDiff: 0.8, goalRateDiff: 0.5, standingsDiff: 0.4, injuryDiff: 0.3 },
      weightsSnapshot: { ...PM.EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.2, goalRateSensitivity: 0.2, standingsSensitivity: 0.2, injurySensitivity: 0.2, homeBase: 1.6, awayBase: 1.1 },
      missingFeatures: ["xgDiff", "clubEloDiff"] };
    const reasons = PM.classifyFailureReasons(record, record.weightsSnapshot);
    const dm = reasons.find((r) => r.id === "data_missing");
    assert.ok(dm, JSON.stringify(reasons.map((r) => r.id)));
    assert.deepStrictEqual(dm.missingFeatures, ["xgDiff", "clubEloDiff"]);
    assert.ok(reasons.filter((r) => r.id !== "data_missing").length <= 3);
    const ok = PM.classifyFailureReasons({ ...record, correct: true }, record.weightsSnapshot);
    assert.strictEqual(ok.length, 0, "当たった試合には理由を付けない");
    const noMissing = PM.classifyFailureReasons({ ...record, missingFeatures: [] }, record.weightsSnapshot);
    assert.ok(!noMissing.some((r) => r.id === "data_missing"));
  });
  const { buildLearningAgenda } = require("./learning/learningAgenda");
  await t("F2 learningAgenda: 欠けたデータの内訳(2件以上)を「データ不足の解消」として計画に載せる", () => {
    const recs = [
      { resolved: true, correct: false, homeTeamEn: "A", awayTeamEn: "B", missingFeatures: ["xgDiff", "injuryDiff"] },
      { resolved: true, correct: false, homeTeamEn: "C", awayTeamEn: "D", missingFeatures: ["xgDiff"] },
      { resolved: true, correct: true, homeTeamEn: "E", awayTeamEn: "F", missingFeatures: ["xgDiff"] },
      { resolved: true, correct: true, homeTeamEn: "G", awayTeamEn: "H" },
    ];
    const agenda = buildLearningAgenda(recs, [], { nowIso: "2026-11-05T00:00:00Z", featureLabelsJa: PM.FEATURE_LABELS_JA });
    const item = agenda.items.find((it) => it.kind === "data");
    assert.ok(item, JSON.stringify(agenda));
    assert.strictEqual(item.missingFeatureCounts.xgDiff, 2);
    assert.ok(item.reasonJa.includes("2件") && item.reasonJa.includes("xG"), item.reasonJa);
    const none = buildLearningAgenda([{ resolved: true, correct: false, homeTeamEn: "A", awayTeamEn: "B", missingFeatures: ["xgDiff"] }], [], { nowIso: "2026-11-05T00:00:00Z" });
    assert.ok(!none.items.some((it) => it.kind === "data"), "1件だけでは計画に載せない");
  });

  // ================= ③ 動的クラブ宇宙 =================
  const { createDynamicUniverse } = require("./learning/dynamicUniverse");
  await t("G1 recordSeen: 候補はまとめ書き(HSET 1回)・2軍/女子/固定名簿は除外・出現回数と学習対象フラグが積み上がる", async () => {
    const m = mockStore();
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: m.upstashCmd });
    const teams = [
      { teamId: 10, nameEn: "Nukunu FC", leagueId: 98, league: "J1" },
      { teamId: 11, nameEn: "Porto B", leagueId: 95 },
      { teamId: 12, nameEn: "Arsenal", leagueId: 39 },
      { teamId: 13, nameEn: "Grenades", leagueId: 500 },
    ];
    const r = await du.recordSeen(teams, { source: "fixtures", learnedLeagueIds: new Set([98]), isStaticTeam: (id, name) => name === "Arsenal", nowMs: Date.parse("2026-11-05T10:00:00Z") });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.recorded, 2);
    assert.strictEqual(m.count("HSET"), 1); assert.strictEqual(m.count("HGETALL"), 1);
    const r2 = await du.recordSeen([{ teamId: 10, nameEn: "Nukunu FC", leagueId: 98 }], { source: "view", nowMs: Date.parse("2026-11-05T11:00:00Z") });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(m.count("HGETALL"), 1, "1時間以内の2回目は HGETALL しない(プロセス内キャッシュ)");
    const h = m.store.get("kb:universe:dyn:seen");
    const e = JSON.parse(h["10"]);
    assert.strictEqual(e.seen, 1); assert.strictEqual(e.views, 1); assert.strictEqual(e.learned, true);
    assert.ok(!h["11"] && !h["12"]);
  });
  await t("G2 adoptForToday: 優先度(データ欠け>学習対象>閲覧>出現)で1日の上限ぶん採用し、古い候補は掃除・60日出現しない採用は外す", async () => {
    const m = mockStore();
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: m.upstashCmd });
    const today = "2026-11-05";
    m.store.set("kb:universe:dyn:seen", {
      "1": JSON.stringify({ nameEn: "Old FC", lastSeen: "2026-09-01", seen: 9 }),
      "2": JSON.stringify({ nameEn: "Viewed FC", lastSeen: today, seen: 1, views: 3 }),
      "3": JSON.stringify({ nameEn: "Learned FC", lastSeen: today, seen: 1, learned: true, leagueId: 98 }),
      "4": JSON.stringify({ nameEn: "Missing FC", lastSeen: today, seen: 1, missing: 2 }),
      "5": JSON.stringify({ nameEn: "Popular FC", lastSeen: today, seen: 5 }),
      "6": JSON.stringify({ nameEn: "Static FC", lastSeen: today, seen: 5 }),
    });
    m.store.set("kb:universe:dyn:adopted", {
      "7": JSON.stringify({ nameEn: "Idle FC", adoptedAt: "2026-08-01", lastSeen: "2026-08-20" }),
      "8": JSON.stringify({ nameEn: "Active FC", adoptedAt: "2026-10-01", lastSeen: "2026-11-04" }),
    });
    const r = await du.adoptForToday({ dateKey: today, perDay: 3, isStaticTeam: (id) => Number(id) === 6 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.adoptedNow.map((a) => a.teamId), [4, 3, 2], JSON.stringify(r.adoptedNow));
    assert.strictEqual(r.prunedSeen, 2, "30日以上前の候補と固定名簿のチームを掃除: " + r.prunedSeen);
    assert.strictEqual(r.retired, 1, "60日以上出現しない採用クラブを外す");
    assert.strictEqual(r.adoptedAll.length, 4);
    assert.ok(r.adoptedNow[0].reasonJa.includes("欠けていた"));
    const objs = du.clubObjectsFor(r.adoptedAll, { dateKey: today, perDay: 20, newlyAdoptedIds: new Set([4, 3, 2]) });
    assert.strictEqual(objs.all.length, 4);
    assert.ok(objs.due.slice(0, 3).every((c) => c.isNew && c.dynamic && c.apiTeamId), JSON.stringify(objs.due));
    const active = objs.due.find((c) => c.apiTeamId === 8);
    assert.ok(active, "直近3日に出現した採用クラブは更新対象");
    assert.ok(objs.due.every((c) => c.rank >= 1000));
    const ok = await du.markCollected([4], today);
    assert.strictEqual(ok, true);
    assert.strictEqual(JSON.parse(m.store.get("kb:universe:dyn:adopted")["4"]).lastCollectedAt, today);
  });
  await t("G3 adoptForToday: 候補・採用済みが読めないときは採用を見送り、理由を返す(でっち上げない)", async () => {
    const m = mockStore(); m.m.mode = "fail";
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: m.upstashCmd });
    const r = await du.adoptForToday({ dateKey: "2026-11-05" });
    assert.strictEqual(r.ok, false); assert.ok(r.reasonJa);
  });

  await t("G4 収集(collectUniverse): 動的クラブは teamId で名前検索なしに収集され(基本情報1回+フォーム・怪我・名簿・一括成績)、teammap と収集日が保存される", async () => {
    const m = mockStore();
    const { createClubDossier } = require("./knowledge/clubDossier");
    const { collectUniverse } = require("./learning/universeCollector");
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: m.upstashCmd });
    m.store.set("kb:universe:dyn:adopted", { "77": JSON.stringify({ nameEn: "Nukunu FC", nameJa: "Nukunu FC", leagueId: 98, adoptedAt: "2026-11-05", lastSeen: "2026-11-05", lastCollectedAt: null }) });
    const calls = [];
    const api = async (apiPath, params) => {
      calls.push({ apiPath, params });
      if (apiPath === "/teams" && params.id) return { response: [{ team: { id: params.id, name: "Nukunu FC", founded: 1989, country: "Japan", logo: "l" }, venue: { name: "Nukunu Park", city: "Machida", capacity: 15000 } }] };
      if (apiPath === "/teams") return { response: [{ team: { id: 5000, name: params.search, founded: 1900, country: "X" }, venue: {} }] };
      if (apiPath === "/fixtures") return { response: [{ fixture: { id: 9001, date: "2026-11-01T10:00:00Z", status: { short: "FT" } }, league: { id: params.team === 77 ? 98 : 39 }, teams: { home: { id: params.team }, away: { id: 1 } }, goals: { home: 2, away: 1 } }] };
      if (apiPath === "/injuries") return { response: [] };
      if (apiPath === "/transfers") return { response: [] };
      if (apiPath === "/fixtures/lineups") return { response: [{ team: { id: params.fixture ? 77 : 0 }, coach: { name: "K. Coach" }, formation: "4-4-2", startXI: [] }] };
      if (apiPath === "/players/squads") return { response: [{ players: Number(params.team) === 77 ? [{ id: 7701, name: "N. Striker", age: 27, number: 9, position: "Attacker" }] : [] }] };
      if (apiPath === "/players") return Number(params.team) === 77
        ? { response: [{ player: { id: 7701, name: "N. Striker", age: 27 }, statistics: [{ team: { id: 77, name: "Nukunu FC" }, league: { id: 98, name: "J1 League", season: 2026 }, games: { appearences: 20, minutes: 1500, position: "Attacker", rating: "7.10" }, goals: { total: 9, assists: 2 } }] }], paging: { current: 1, total: 1 } }
        : { response: [], paging: { current: 1, total: 1 } };
      if (apiPath === "/standings") return { response: [] };
      return { response: [] };
    };
    const objs = du.clubObjectsFor([{ teamId: 77, nameEn: "Nukunu FC", nameJa: "Nukunu FC", leagueId: 98, adoptedAt: "2026-11-05", lastSeen: "2026-11-05", lastCollectedAt: null }], { dateKey: "2026-11-05", perDay: 20, newlyAdoptedIds: new Set([77]) });
    assert.strictEqual(objs.due.length, 1);
    process.env.UNIVERSE_BULK_CLUB_LIMIT = "1";
    const stats = await collectUniverse({
      callApiFootball: api, apiBudget: { remainingForJob: () => 999999 }, clubDossier: cd, knowledgeStore: null, knowledgeGraph: null, thoughtTimeline: null,
      computeFormScore: () => ({ currentFormScore: 1, delta: 0, sampleSize: 1 }), recordLearned: async () => {},
      upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
      dynamicClubs: { due: objs.due, all: objs.all }, dynamicUniverse: du,
    }, new Date("2026-11-05T02:00:00Z"), "2026-11-05");
    assert.strictEqual(stats.dynamic.dueToday, 1); assert.strictEqual(stats.dynamic.newToday, 1);
    assert.strictEqual(stats.dynamic.coreUpdated, 1, JSON.stringify(stats.dynamic));
    assert.ok(!calls.some((c) => c.apiPath === "/teams" && c.params.search === "Nukunu FC"), "動的クラブを名前で検索しない");
    assert.ok(calls.some((c) => c.apiPath === "/teams" && c.params.id === 77), "新規採用の基本情報を id で1回取る");
    for (const ep of ["/fixtures", "/injuries", "/players/squads", "/players"]) assert.ok(calls.some((c) => c.apiPath === ep && Number(c.params.team) === 77), "動的クラブの " + ep + " が呼ばれていない: " + JSON.stringify(calls.filter((c) => c.apiPath === ep).map((c) => c.params)));
    const d = await cd.getDossier("Nukunu FC");
    assert.ok(d && d.teamId === 77 && d.tier === "C" && d.sections.basic && d.sections.basic.venueName === "Nukunu Park", JSON.stringify(d && { teamId: d.teamId, tier: d.tier, sections: Object.keys(d.sections) }));
    const tm = JSON.parse(m.store.get("kb:universe:teammap"));
    assert.ok(tm.clubs.some((c) => c.teamId === 77 && c.dynamic === true && c.tier === "C"), JSON.stringify(tm));
    assert.strictEqual(JSON.parse(m.store.get("kb:universe:dyn:adopted")["77"]).lastCollectedAt, "2026-11-05");
    assert.strictEqual(stats.dynamic.bulkFetched, 1, "動的クラブの一括成績が取れていない: " + JSON.stringify(stats.dynamic));
    assert.strictEqual(stats.dynamic.squadsUpdated, 1);
    assert.ok(stats.playersIndexed >= 1, "動的クラブの選手が索引に載らない: " + stats.playersIndexed);
    delete process.env.UNIVERSE_BULK_CLUB_LIMIT;
  });

  // ================= v98.1: LLM の空応答(EMPTY_RESPONSE) =================
  await t("L1 generateLLM: 空応答(EMPTY_RESPONSE)は1回だけ再試行して成功を返し、他のエラーは再試行しない", async () => {
    process.env.LLM_EMPTY_RETRY_DELAY_MS = "0";
    const LLM = require("./llm/index.js");
    let calls = 0;
    LLM.PROVIDERS.fakeempty = () => ({ generate: async () => { calls++; if (calls === 1) { const e = new Error("empty"); e.code = "EMPTY_RESPONSE"; throw e; } return { text: "ok-after-retry" }; }, resolveModel: () => "fake-model" });
    const prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "fakeempty";
    const r = await LLM.generateLLM({ systemPrompt: "s", userPrompt: "u", maxTokens: 10 });
    assert.strictEqual(r.text, "ok-after-retry"); assert.strictEqual(calls, 2); assert.strictEqual(r.retriedAfterEmpty, true);
    let calls2 = 0;
    LLM.PROVIDERS.fakeempty2 = () => ({ generate: async () => { calls2++; const e = new Error("still empty(stop_reason=end_turn, blocks=empty)"); e.code = "EMPTY_RESPONSE"; throw e; }, resolveModel: () => "fake" });
    process.env.LLM_PROVIDER = "fakeempty2";
    await assert.rejects(() => LLM.generateLLM({ systemPrompt: "s", userPrompt: "u" }), (e) => e.code === "EMPTY_RESPONSE" && /stop_reason/.test(e.message));
    assert.strictEqual(calls2, 2, "2回目も空なら諦める(無限に再試行しない)");
    let calls3 = 0;
    LLM.PROVIDERS.fakehttp = () => ({ generate: async () => { calls3++; const e = new Error("HTTP 500"); e.code = "HTTP_ERROR"; throw e; }, resolveModel: () => "fake" });
    process.env.LLM_PROVIDER = "fakehttp";
    await assert.rejects(() => LLM.generateLLM({ systemPrompt: "s", userPrompt: "u" }), (e) => e.code === "HTTP_ERROR");
    assert.strictEqual(calls3, 1, "HTTPエラーは再試行しない");
    if (prevProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = prevProvider;
  });
  await t("L2 anthropic provider: 空応答のエラー文に停止理由とブロック種別が残る(原因が追える)", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "tool_use" }], stop_reason: "end_turn" }) });
    try {
      // 鍵はモジュール読み込み時に読まれるため、この検査だけ別の鍵付きで読み直す
      const modPath = require.resolve("./llm/providers/anthropic.js");
      const prevKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "sk-test-dummy-key";
      delete require.cache[modPath];
      const prov = require(modPath);
      await assert.rejects(() => prov.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 10, truncateRetry: false }), (e) => e.code === "EMPTY_RESPONSE" && /stop_reason=end_turn/.test(e.message) && /blocks=tool_use/.test(e.message) && !/sk-test-dummy-key/.test(e.message));
      delete require.cache[modPath];
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    } finally { global.fetch = realFetch; }
  });

  // ================= ① チーム知識(主力の実測・照合) =================
  const TK = require("./knowledge/teamKnowledge");
  await t("H1 squadStrengthFromPlayers: 出場時間上位14人の平均評価点・母数・注目選手・怪我人(実測のみ)", () => {
    const players = [];
    for (let i = 0; i < 20; i++) players.push({ name: "P" + i, position: "M", minutes: 100 + i * 50, rating: 6.5 + (i % 5) * 0.1, goals: i % 3, assists: 0, injured: i === 2 });
    players.push({ name: "Bench", minutes: 30, rating: 9.9 });
    const s = TK.squadStrengthFromPlayers(players);
    assert.strictEqual(s.coreCount, 14); assert.strictEqual(s.ratedCount, 14); assert.strictEqual(s.reliable, true);
    assert.ok(s.avgRating > 6.5 && s.avgRating < 7.0, String(s.avgRating));
    assert.strictEqual(s.keyPlayers.length, 3);
    assert.ok(!s.keyPlayers.some((p) => p.name === "Bench"), "出場の少ない選手は注目選手にしない");
    assert.deepStrictEqual(s.injuredIndexed, ["P2"]);
    const thin = TK.squadStrengthFromPlayers(players.slice(0, 5));
    assert.strictEqual(thin.reliable, false, "評価点のある主力が7人未満なら比較しない");
    // v98.1: 注目選手は270分(フル3試合)以上の選手から選ぶ(2試合ぶんの評価点は偶然に左右される)
    const few = TK.squadStrengthFromPlayers([{ name: "TwoGames", minutes: 180, rating: 9.0 }, { name: "Regular", minutes: 900, rating: 7.0 }]);
    assert.deepStrictEqual(few.keyPlayers.map((p) => p.name), ["Regular"]);
  });
  await t("H2 knowledgeForFixture: teamId で照合し、追跡クラブは選手実測+調査ファイル(MGET 1回)、対象外は tracked:false", async () => {
    const m = mockStore();
    const { createClubDossier } = require("./knowledge/clubDossier");
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    m.store.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル", tier: "A", dynamic: false }] }));
    m.store.set("kb:club:arsenal", JSON.stringify({ nameEn: "Arsenal", nameJa: "アーセナル", teamId: 42, tier: "A", updatedAt: "2026-11-04T02:00:00Z",
      sections: { form: { currentFormScore: 1.2, recentResults: [{ date: "2026-11-01", opponent: "X", homeAway: "H", goalsFor: 2, goalsAgainst: 0 }], computedAt: "2026-11-04T02:00:00Z" },
        injuries: { injuryCount: 2, injuredPlayers: ["A. Player", "B. Player"], suspendedPlayers: [], computedAt: "2026-11-04T02:00:00Z" },
        coach: { coachName: "M. Arteta", formation: "4-3-3", computedAt: "2026-11-04T02:00:00Z" } } }));
    const rows = Array.from({ length: 16 }, (_, i) => ({ name: "G" + i, teamEn: "Arsenal", minutes: 500 + i * 10, rating: 7.0, goals: 1, assists: 0 }));
    const tk = TK.createTeamKnowledge({ CLUB_UNIVERSE: [{ nameEn: "Arsenal", nameJa: "アーセナル", country: "イングランド", leagueId: 39, rank: 12 }], clubDossier: cd,
      getPlayerRows: () => ({ players: rows, builtAt: "2026-11-05T01:00:00Z" }), upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON });
    m.calls.length = 0;
    const k = await tk.knowledgeForFixture({ id: 42, name: "Arsenal FC" }, { id: 999, name: "Dibrados FC" });
    assert.strictEqual(k.home.tracked, true); assert.strictEqual(k.home.squad.reliable, true); assert.strictEqual(k.home.squad.avgRating, 7);
    assert.strictEqual(k.home.dossier.injuries.count, 2); assert.strictEqual(k.home.dossier.coach.formation, "4-3-3");
    assert.strictEqual(k.away.tracked, false); assert.strictEqual(k.away.reason, "untracked");
    assert.strictEqual(m.count("MGET"), 1, "調査ファイルは MGET 1回: " + JSON.stringify(m.calls));
    assert.strictEqual(await tk.squadRatingForFeature(42, "Arsenal"), 7);
    assert.strictEqual(await tk.squadRatingForFeature(999, "Dibrados FC"), null);
    assert.strictEqual(tk.isStaticTeamSync(42, "x"), true); assert.strictEqual(tk.isStaticTeamSync(999, "Arsenal"), true); assert.strictEqual(tk.isStaticTeamSync(999, "Nobody"), false);
  });
  await t("H3 teammap が無い日は調査ファイルから照合表を組み立て、動的クラブ(採用済み)も含める", async () => {
    const m = mockStore();
    const { createClubDossier } = require("./knowledge/clubDossier");
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    m.store.set("kb:club:arsenal", JSON.stringify({ nameEn: "Arsenal", teamId: 42, sections: {} }));
    m.store.set("kb:universe:dyn:adopted", { "77": JSON.stringify({ nameEn: "Nukunu FC", adoptedAt: "2026-11-05" }) });
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: m.upstashCmd });
    const tk = TK.createTeamKnowledge({ CLUB_UNIVERSE: [{ nameEn: "Arsenal", nameJa: "アーセナル", rank: 12 }], clubDossier: cd, dynamicUniverse: du, getPlayerRows: () => ({ players: [] }), upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON });
    const map = await tk.ensureMap(true);
    assert.strictEqual(map.get(42).nameEn, "Arsenal"); assert.strictEqual(map.get(77).dynamic, true);
    assert.strictEqual(tk.snapshot().source, "dossiers");
    const c = await tk.resolveTeam({ id: 77, name: "Nukunu FC" });
    assert.strictEqual(c.tier, "C");
  });

  // ================= サーバー(差し替え保存先で実際に動かす) =================
  const PORT = 8913;
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "k";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "0";
  process.env.RATE_LIMIT_PER_MINUTE = "1000";
  const srvMod = require("./server.js");
  const V = srvMod.__v98ForTest;
  const V97 = srvMod.__v97ForTest;
  const m = mockStore();
  const now = Date.now();
  const jstToday = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const apiCalls = [];
  const kickoff = new Date(now + 3 * 3600000).toISOString();
  const fx = (id, homeId, homeName, awayId, awayName, leagueId, leagueName) => ({
    fixture: { id, date: kickoff, status: { short: "NS" }, venue: { name: "Stadium" } },
    league: { id: leagueId, name: leagueName, country: "England" },
    teams: { home: { id: homeId, name: homeName, logo: "" }, away: { id: awayId, name: awayName, logo: "" } },
    goals: { home: null, away: null },
  });
  srvMod.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    callApiFootball: async (endpoint, params) => {
      apiCalls.push({ endpoint, params });
      if (endpoint === "/fixtures" && params && params.id) {
        const id = Number(params.id);
        if (id === 501) return { response: [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League")] };
        if (id === 502) return { response: [fx(502, 998, "Nukunu", 997, "Golden Warriors", 500, "Division One League")] };
        return { response: [] };
      }
      if (endpoint === "/fixtures" && params && params.date) {
        return { response: [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League"), fx(502, 998, "Nukunu", 997, "Golden Warriors", 500, "Division One League"), fx(503, 996, "Porto B", 995, "Braga B", 94, "Primeira Liga")] };
      }
      if (endpoint === "/predictions") return { response: [{ predictions: { percent: { home: "50%", draw: "25%", away: "25%" }, winner: { name: "Arsenal" } } }] };
      return { response: [] };
    },
  });
  await sleep(300);
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, headers: res.headers, body: j }); }); }).on("error", reject);
  });
  // 固定名簿(Arsenal)の照合表と調査ファイル、選手索引を用意
  m.store.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル", tier: "A", dynamic: false }] }));
  m.store.set("kb:club:arsenal", JSON.stringify({ nameEn: "Arsenal", nameJa: "アーセナル", teamId: 42, tier: "A", updatedAt: "2026-11-04T02:00:00Z",
    sections: { injuries: { injuryCount: 1, injuredPlayers: ["A. Player"], suspendedPlayers: [], computedAt: "2026-11-04T02:00:00Z" }, coach: { coachName: "M. Arteta", formation: "4-3-3", computedAt: "2026-11-04T02:00:00Z" } } }));
  const playerSearch = require("./knowledge/playerSearch");
  const idxRows = Array.from({ length: 16 }, (_, i) => playerSearch.toIndexRow({ id: 1000 + i, name: "Gunner " + i, teamEn: "Arsenal", teamJa: "アーセナル", position: "Midfielder", stats: { minutes: 600 + i * 10, rating: 7.1, goals: 2, assists: 1, appearances: 10 } }, { todayKey: 20261105 }, now, null));
  V.setPlayerIndexRowsForTest(idxRows, { builtAt: "2026-11-05T01:00:00Z" });
  teamKnowledgeInvalidate();
  function teamKnowledgeInvalidate() { V.teamKnowledge.invalidate(); }

  await t("S1 /api/fixtures/today: 各チームに teamId と leagueId が付き、候補(固定名簿を除く・学習対象大会フラグつき)がまとめ書きされる", async () => {
    V97.clearCache();
    m.calls.length = 0;
    const r = await get("/api/fixtures/today");
    assert.strictEqual(r.body.found, true);
    const f = r.body.fixtures.find((x) => x.id === 501);
    assert.strictEqual(f.home.id, 42); assert.strictEqual(f.away.id, 999); assert.strictEqual(f.leagueId, 39);
    await sleep(250); // 候補の記録は裏で行う
    const seen = m.store.get("kb:universe:dyn:seen") || {};
    assert.ok(seen["999"] && seen["998"] && seen["997"], "対象外チームが候補に記録される: " + JSON.stringify(Object.keys(seen)));
    assert.ok(!seen["42"], "固定名簿のチームは候補にしない");
    assert.ok(!seen["996"] && !seen["995"], "2軍(B)は候補にしない");
    assert.strictEqual(JSON.parse(seen["999"]).learned, true, "学習対象大会(39)のチームは learned");
    assert.strictEqual(m.count("HSET"), 1, "候補の記録は HSET 1回");
  });
  await t("S2 /api/fixture-analysis(試合前): knowledge(追跡クラブ=主力実測+怪我+監督 / 対象外=tracked:false)が付き、外部APIは試合1件分しか呼ばない", async () => {
    V97.clearCache();
    apiCalls.length = 0; m.calls.length = 0;
    const r = await get("/api/fixtures/analysis?id=501");
    assert.strictEqual(r.body.found, true, JSON.stringify(r.body).slice(0, 300)); assert.strictEqual(r.body.phase, "upcoming");
    const k = r.body.knowledge;
    assert.ok(k && k.home && k.away, JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(k.home.tracked, true, JSON.stringify(k).slice(0, 400)); assert.strictEqual(k.home.nameJa, "アーセナル");
    assert.strictEqual(k.home.squad.reliable, true); assert.strictEqual(k.home.squad.avgRating, 7.1); assert.strictEqual(k.home.squad.keyPlayers.length, 3);
    assert.strictEqual(k.home.dossier.injuries.count, 1); assert.strictEqual(k.home.dossier.coach.name, "M. Arteta");
    assert.strictEqual(k.away.tracked, false);
    assert.strictEqual(r.body.fixture.home.id, 42);
    const external = apiCalls.filter((c) => c.endpoint !== "/predictions");
    assert.deepStrictEqual(external.map((c) => c.endpoint), ["/fixtures"], "選手データのために外部APIを呼ばない: " + JSON.stringify(external));
    await sleep(250);
    const seen = m.store.get("kb:universe:dyn:seen") || {};
    assert.strictEqual(JSON.parse(seen["999"]).views, 1, "カードを開いた対象外チームは view として記録");
  });
  await t("S3 /api/fixture-analysis: AI自身の予想がある試合は ownBasis(効いた要素・使えた/欠けたデータ)、無い試合は null", async () => {
    V97.clearCache();
    m.store.set("learn:ownpred:501", JSON.stringify({ fixtureId: 501, homeTeamEn: "Arsenal", awayTeamEn: "Dibrados FC", predictedWinner: "home", homeLambda: 1.6, awayLambda: 1.0, resolved: false, kickoff, weightsVersion: 12, loggedAt: "2026-11-05T02:00:00Z", leagueId: 39, league: "Premier League",
      factorImportance: [{ key: "formDiff", labelJa: "直近フォーム", stars: 4 }, { key: "marketEdge", labelJa: "市場オッズ", stars: 2 }, { key: "xgDiff", labelJa: "xG", stars: 0 }],
      supplied: { formDiff: true, goalRateDiff: true, xgDiff: false, clubEloDiff: false, marketEdge: true, squadRatingDiff: true },
      squadRatings: { home: 7.1, away: 6.6 } }));
    const r = await get("/api/fixtures/analysis?id=501");
    const b = r.body.ownBasis;
    assert.ok(b, "ownBasis が無い");
    assert.deepStrictEqual(b.factors.map((f) => f.labelJa), ["直近フォーム", "市場オッズ"]);
    assert.ok(b.used.some((u) => u.key === "formDiff") && b.missing.some((u) => u.key === "xgDiff"), JSON.stringify(b));
    assert.strictEqual(b.basisKind, "measured"); assert.strictEqual(b.weightsVersion, 12); assert.strictEqual(b.squadRatings.home, 7.1);
    V97.clearCache();
    const r2 = await get("/api/fixtures/analysis?id=502");
    assert.strictEqual(r2.body.ownBasis, null);
    assert.strictEqual(r2.body.knowledge.home.tracked, false);
  });
  await t("S4 /api/predictions/today: 各予想に basis(根拠)が付く。旧記録(supplied なし)は featureTrust から「使えたデータ」だけ出し、欠けは断定しない", async () => {
    V97.clearCache();
    srvMod.__setTestHooks({ handleFixturesToday: async () => ({ status: 200, body: { found: true, date: jstToday, fixtures: [
      { id: 501, date: kickoff, status: "NS", league: "Premier League", home: { id: 42, name: "Arsenal" }, away: { id: 999, name: "Dibrados FC" }, score: null },
      { id: 601, date: kickoff, status: "NS", league: "Premier League", home: { id: 1, name: "Old Home" }, away: { id: 2, name: "Old Away" }, score: null },
    ] } }) });
    m.store.set("learn:ownpred:601", JSON.stringify({ fixtureId: 601, homeTeamEn: "Old Home", awayTeamEn: "Old Away", predictedWinner: "away", homeLambda: 1.0, awayLambda: 1.5, resolved: false, kickoff,
      factorImportance: [{ key: "standingsDiff", labelJa: "順位・勝点", stars: 3 }], featureTrust: [{ key: "form", kind: "form" }, { key: "odds", kind: "odds" }] }));
    const r = await get("/api/predictions/today");
    const p501 = r.body.predictions.find((p) => p.fixtureId === 501);
    const p601 = r.body.predictions.find((p) => p.fixtureId === 601);
    assert.ok(p501.basis && p501.basis.basisKind === "measured" && p501.basis.missing.length === 2, JSON.stringify(p501.basis));
    assert.ok(p601.basis && p601.basis.basisKind === "legacy" && p601.basis.missing === null && p601.basis.used.length === 2, JSON.stringify(p601.basis));
  });
  await t("S5 学習の依存に squadRatingOf と dynamicUniverse が渡り、索引の実測から主力評価点を返す", async () => {
    const d = V.learningDeps;
    assert.strictEqual(typeof d.squadRatingOf, "function"); assert.ok(d.dynamicUniverse && typeof d.dynamicUniverse.adoptForToday === "function");
    assert.strictEqual(await d.squadRatingOf(42, "Arsenal"), 7.1);
    assert.strictEqual(await d.squadRatingOf(999, "Dibrados FC"), null);
  });

  // ================= ⓪ 使用量カウンターの終了時積み上げ =================
  const ST = srvMod.__storeForTest;
  await t("Z1 flushUpstashUsageOnExit: 未積み上げぶんを時間を待たずに INCRBY で積み上げる(再デプロイで消えない)", async () => {
    ST.resetForTest();
    m.calls.length = 0;
    ST.noteCommandsForTest(7); // 7コマンドぶん数えさせる(本番では upstashCmd が通るたびに数える)
    const before = ST.usageUnflushed();
    assert.ok(before > 0, "未積み上げが数えられていない: " + before);
    const ok = await ST.flushUpstashUsageOnExit();
    assert.strictEqual(ok, true);
    const inc = m.calls.find((c) => c[0] === "INCRBY" && String(c[1]).startsWith("ops:upstash:usage:"));
    assert.ok(inc, "INCRBY が送られていない: " + JSON.stringify(m.calls.map((c) => c[0])));
    assert.ok(Number(inc[2]) >= before, "積み上げ件数 " + inc[2] + " < " + before);
    assert.strictEqual(ST.usageUnflushed(), 0);
    assert.strictEqual(ST.upstashUsageSnapshot().monthEstimateBasis, "store+process");
  });
  await t("Z2 maybeFlushUpstashUsage: 未積み上げが UPSTASH_USAGE_FLUSH_MAX を超えたら1時間を待たずに積み上げる", async () => {
    ST.resetForTest();
    // 直前に積み上げたことにして「時間では未到来」にする
    ST.noteCommandsForTest(1);
    await ST.maybeFlushUpstashUsage({ force: true }).catch(() => {});
    const many = ST.UPSTASH_USAGE_FLUSH_MAX + 5;
    ST.noteCommandsForTest(many);
    m.calls.length = 0;
    await ST.maybeFlushUpstashUsage();
    assert.ok(m.calls.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("ops:upstash:usage:")), "件数しきい値で積み上がらない");
    assert.ok(ST.usageUnflushed() < many, String(ST.usageUnflushed()));
  });

  // ================= 画面(静的検査) =================
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  await t("U1 index.html: 試合前プレビューが手書き名簿(REAL_FIXTURE_CLUB_EN_TO_JA / registeredPlayersForClubJa)を使わず、サーバーの knowledge を描く", () => {
    const fn = html.slice(html.indexOf("function buildKnowledgeSideHtml("), html.indexOf("function ratingBadgeColor("));
    assert.ok(fn.length > 200, "buildUpcomingPreviewHtml が見つからない");
    assert.ok(!/registeredPlayersForClubJa|mapEnglishClubToRegistered|REAL_FIXTURE_CLUB_EN_TO_JA/.test(fn), "手書き名簿への参照が残っている");
    assert.ok(/analysis\.knowledge/.test(fn), "knowledge を使っていない");
    assert.ok(/buildKnowledgeSideHtml|knowledgeSideHtml/.test(html), "チーム別の知識表示が無い");
    assert.ok(/追跡対象外/.test(fn) || /untracked/.test(fn), "対象外クラブの正直な表示が無い");
  });
  await t("U2 index.html: AIの予想ブロックに根拠(使えたデータ/未取得)の行があり、4言語の辞書に v98 の文言が入っている", () => {
    assert.ok(/function predBasisLineHtml/.test(html), "predBasisLineHtml が無い");
    assert.ok(/predBasisLineHtml\(p\)/.test(html), "予想ブロックから呼ばれていない");
    assert.ok(/v98/.test(html.slice(0, html.indexOf("/* ==== 辞書ここまで ==== */"))), "辞書に v98 ブロックが無い");
    for (const s of ["未取得のため考慮していないデータ", "追跡対象外のクラブ", "主力の平均評価点"]) {
      assert.ok(html.includes(s), "文言が無い: " + s);
      const i = html.indexOf(s); const dictPart = html.slice(0, html.indexOf("/* ==== 辞書ここまで ==== */"));
      assert.ok(dictPart.indexOf(s) !== -1, "辞書に訳が無い: " + s);
      void i;
    }
  });
  await t("U2b 試合前プレビューを実際に描く: 追跡クラブは主力実測(注目選手・怪我・監督・直近5試合)、対象外は正直な一文、AI予想が無ければ API-Football 参考表示。undefined/NaN を出さない", () => {
    const cut = (from, to) => { const i = html.indexOf(from); assert.ok(i >= 0, "見つからない: " + from); const j = html.indexOf(to, i + 1); assert.ok(j > i, "終端が見つからない: " + to); return html.slice(i, j); };
    const src = [
      cut("const KNOWLEDGE_POS_SHORT", "function ratingBadgeColor("),
      cut("function ratingBadgeColor(", "function playerRatingRowHtml("),
      cut("function strengthBarHtml(", "\n}\n") + "\n}\n",
      cut("function predBasisLineHtml(", "function predFactorsLineHtml("),
    ].join("\n");
    const escapeHtml = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const predsByFixtureId = new Map();
    const predictionSummaryBlockHtml = (p, title) => `<div class="own">${title}:${p.predictedWinner}${predBasisLineHtmlRef(p)}</div>`;
    let predBasisLineHtmlRef = () => "";
    const api = new Function("escapeHtml", "predsByFixtureId", "predictionSummaryBlockHtml", "window",
      src + "\nreturn { buildUpcomingPreviewHtml, buildKnowledgeSideHtml, predBasisLineHtml };")(escapeHtml, predsByFixtureId, predictionSummaryBlockHtml, {});
    predBasisLineHtmlRef = api.predBasisLineHtml;
    const squad = { playersIndexed: 25, coreCount: 14, ratedCount: 13, avgRating: 7.02, reliable: true, indexBuiltAt: "2026-11-05T01:00:00Z",
      keyPlayers: [{ name: "Saka", position: "Attacker", rating: 7.6, goals: 5, assists: 3, minutes: 900, injured: false }, { name: "Rice", position: "Midfielder", rating: 7.3, goals: 1, assists: 2, minutes: 950, injured: true }], injuredIndexed: ["Rice"], injuredIndexedCount: 1 };
    const dossier = { updatedAt: "2026-11-04T02:00:00Z", form: { recentResults: [{ date: "2026-11-01", opponent: "X", homeAway: "H", goalsFor: 2, goalsAgainst: 0 }, { date: "2026-10-28", opponent: "Y", homeAway: "A", goalsFor: 1, goalsAgainst: 1 }, { date: "2026-10-25", opponent: "Z", homeAway: "H", goalsFor: 0, goalsAgainst: 1 }] },
      injuries: { count: 1, players: ["Rice"], suspended: [] }, coach: { name: "M. Arteta", formation: "4-3-3" } };
    const analysis = { fixture: { id: 501, date: "2026-11-06T20:00:00Z", league: "Premier League", venue: "Emirates", home: { id: 42, name: "Arsenal" }, away: { id: 999, name: "Dibrados <FC>" } },
      knowledge: { home: { tracked: true, nameEn: "Arsenal", nameJa: "アーセナル", squad, dossier }, away: { tracked: false, reason: "untracked" } },
      aiPrediction: { homePct: 50, drawPct: 25, awayPct: 25 }, ownBasis: null };
    const out = api.buildUpcomingPreviewHtml(analysis, "standard");
    for (const sstr of ["Saka", "Rice", "7.60", "⚽×5", "🩹", "M. Arteta", "4-3-3", "○△●", "追跡対象外のクラブのため", "AI自身の予想対象外", "API-Football: Arsenal 50%", "評価点のある主力が少ないため", "Dibrados &lt;FC&gt;"]) {
      assert.ok(out.includes(sstr), "表示に無い: " + sstr);
    }
    assert.ok(!/undefined|NaN/.test(out), "undefined/NaN が混じる");
    // 両クラブ追跡済み・差あり → 優劣の一文とバー
    const analysis2 = { ...analysis, knowledge: { home: analysis.knowledge.home, away: { tracked: true, nameEn: "Chelsea", squad: { ...squad, avgRating: 6.7 }, dossier } } };
    const out2 = api.buildUpcomingPreviewHtml(analysis2, "standard");
    assert.ok(out2.includes("主力の平均評価点ではArsenalがやや上(差0.32)"), out2.slice(0, 600));
    assert.ok(out2.includes("bar-track"), "強さのバーが出る");
    // 拮抗
    const out3 = api.buildUpcomingPreviewHtml({ ...analysis2, knowledge: { home: analysis.knowledge.home, away: { tracked: true, nameEn: "Chelsea", squad: { ...squad, avgRating: 6.95 }, dossier } } }, "standard");
    assert.ok(out3.includes("拮抗しています"));
    // AI自身の予想があるときは根拠行(使えた/未取得/主力評価点)が出る
    predsByFixtureId.set("501", { predictedWinner: "home", basis: { factors: [], used: [{ key: "formDiff", labelJa: "直近フォーム" }], missing: [{ key: "xgDiff", labelJa: "xG" }], basisKind: "measured", squadRatings: { home: 7.02, away: 6.7 } } });
    const out4 = api.buildUpcomingPreviewHtml(analysis2, "standard");
    assert.ok(out4.includes("使えたデータ") && out4.includes("直近フォーム") && out4.includes("未取得のため考慮していないデータ") && out4.includes("xG") && out4.includes("7.02 vs 6.70"), out4.slice(0, 500));
    assert.ok(!out4.includes("AI自身の予想対象外"));
    // 旧記録: 欠けは断定しない
    const legacy = api.predBasisLineHtml({ basis: { factors: [], used: [{ labelJa: "直近フォーム" }], missing: null, basisKind: "legacy" } });
    assert.ok(legacy.includes("旧い記録のため") && !legacy.includes("未取得のため"), legacy);
    assert.strictEqual(api.predBasisLineHtml({}), "");
  });
  await t("U2c index.html: 試合前プレビューの見出し行「キックオフ」は辞書で訳せる形(span)になっている", () => {
    assert.ok(html.includes("` ・ <span>キックオフ</span> ${timeStr}`"), "キックオフが span で囲まれていない");
    const dictPart = html.slice(0, html.indexOf("/* ==== 辞書ここまで ==== */"));
    assert.ok(/"キックオフ":\s*\[/.test(dictPart), "辞書に「キックオフ」が無い");
  });
  await t("U3 sw.js の版は index.html の画面更新に追従している(v101 で v98→v101 へ更新)・index.html の言語パックは ?v=98", () => {
    const sw = fs.readFileSync(SW_JS, "utf8");
    assert.ok(/soccer-ai-shell-v(98|99|10\d)/.test(sw), "sw.js の版");
    assert.ok(!/soccer-ai-shell-v98"/.test(sw), "v101 で画面を更新したので sw.js の版は v98 のままではいけない");
    assert.ok(/\?v=98/.test(html), "index.html の版");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  try { srvMod.server.close(); } catch (e) { /* noop */ }
  process.exit(fail ? 1 : 0);
})();
