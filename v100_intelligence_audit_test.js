"use strict";
/** v100(2026年11月8日): 「本当に賢くなっているか」総点検で見つけた不具合の修正と、賢さの計測の追加のテスト。
 *
 *  本番実測(11/8)で分かったこと:
 *   ① 重みが 10/15(version 33)から24日間一度も採用されていない。候補は LogLoss を最小化して作るのに、
 *      採否は「的中率が学習用・検証用の両方で厳密に上がったときだけ」(同値も不採用)だった。小さな重みの
 *      変更では勝敗の予想(argmax)は変わらない=同値=不採用、が構造的に続いていた(物差しの不一致)。
 *   ② 自動QAが毎回「昨日は言えたことが1件言えない」の修復として選手索引を全件読み直して作り直していた
 *      (保存先の選手記録 6,000件を1件ずつ GET=約6,200コマンド/回・1日2回)。収集が索引を作った数分後に。
 *   ③ 母数20件以上で52%未満の日に「リーグ別・自信帯別の内訳」を調べる手段が無かった。
 *   ④ 「AIがいま何を信じているか」(重みの version・市場ブレンド比・各特徴量の重み)と、自前モデル単独の
 *      賢さの推移(過去試合によるモデル調整の LogLoss)がどのエンドポイントにも出ていなかった。
 *   ⑤ 学習計画が毎日「次回の重み学習で再評価」と書き続けていた(実際は24日間据え置き)。
 *
 *  このテストは実際にコードを動かし、戻り値・保存内容・コマンド数で確かめる。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 保存先モック(コマンド数を数える) */
function mockStore() {
  const store = new Map(); const calls = [];
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "HDEL") { const h = store.get(a[0]) || {}; for (const f of a.slice(1)) delete h[f]; store.set(a[0], h); return 1; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "LLEN") return (store.get(a[0]) || []).length;
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = store.get(a[0]) || []; l.unshift(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LREM") { const l = store.get(a[0]) || []; store.set(a[0], l.filter((v) => v !== a[2])); return 1; }
    if (op === "LTRIM") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; store.set(a[0], l.slice(s, e + 1)); return "OK"; }
    if (op === "EXPIRE" || op === "PEXPIRE") return 1;
    if (op === "EXISTS") return a.filter((k) => store.has(k)).length;
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  const setJSON = (k, v) => store.set(k, JSON.stringify(v));
  return { store, calls, count, upstashCmd, upstashGetJSON, upstashSetJSON, setJSON };
}

const PORT = 8915;
const req = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, body: j }); }); });
  r.on("error", reject); r.end();
});

(async () => {
  console.log("v100 総点検: 重み採否の関門・索引作り直しの鮮度/まとめ読み・リーグ別内訳と技能スコア・日次レポートの開示 テスト");

  /* ================= A: 精度集計(リーグ別・学習済み別・技能スコア) ================= */
  const acc = require("./learning/accuracyTracker");
  await t("A1 buildDailyAccuracy: リーグ別・学習済み/未学習別の集計が積まれ、技能スコアが出る", async () => {
    const mk = (hit, league, learned, p) => ({ official: true, league, learned, markets: { oneX2: { hit, brier: 0.5, logLoss: -Math.log(p), confidence: p, predicted: "home", actual: hit ? "home" : "away" } } });
    const scored = [mk(true, "Premier League", true, 0.6), mk(false, "Premier League", true, 0.55), mk(true, "Major League Soccer", false, 0.4), mk(false, "Major League Soccer", false, 0.45), mk(false, "Major League Soccer", false, 0.5), mk(true, "J1 League", true, 0.5)];
    const agg = acc.buildDailyAccuracy(scored);
    assert.strictEqual(agg.oneX2.byLeague["Premier League"].n, 2); assert.strictEqual(agg.oneX2.byLeague["Premier League"].hits, 1);
    assert.strictEqual(agg.oneX2.byLeague["Major League Soccer"].n, 3); assert.strictEqual(agg.oneX2.byLeague["Major League Soccer"].hits, 1);
    assert.deepStrictEqual(agg.oneX2.byLearned.learned, { n: 3, hits: 2 }); assert.deepStrictEqual(agg.oneX2.byLearned.unlearned, { n: 3, hits: 1 });
    const s = acc.summarizeAccuracy(agg).markets.oneX2;
    assert.strictEqual(s.byLeague.measurable, true); assert.strictEqual(s.byLeague.rows[0].league, "Major League Soccer"); assert.strictEqual(s.byLeague.rows[0].hitRatePct, 33.3);
    assert.strictEqual(s.byLearned.learned.hitRatePct, 66.7); assert.strictEqual(s.byLearned.unlearned.hitRatePct, 33.3); assert.strictEqual(s.byLearned.gapPt, 33.4);
    assert.ok(Number.isFinite(s.skill.logLossSkillPct) && Number.isFinite(s.skill.brierSkillPct), JSON.stringify(s.skill));
    // 当てずっぽう(LogLoss ln3・Brier 2/3)なら技能スコアは 0%
    const uniform = acc.skillOf(Math.log(3), 2 / 3);
    assert.strictEqual(uniform.logLossSkillPct, 0); assert.strictEqual(uniform.brierSkillPct, 0);
    // 本番 11/8 の30日実測(LogLoss 0.963・Brier 0.57)→ +12.3% / +14.5%
    const prod = acc.skillOf(0.963, 0.57);
    assert.strictEqual(prod.logLossSkillPct, 12.3); assert.strictEqual(prod.brierSkillPct, 14.5);
  });

  await t("A2 mergeDailyAccuracy: 2日ぶんの合算と、旧形式(リーグ別の無い記録)との合算が壊れない", async () => {
    const mk = (hit, league, learned) => ({ official: true, league, learned, markets: { oneX2: { hit, brier: 0.5, logLoss: 0.7, confidence: 0.6, predicted: "home", actual: hit ? "home" : "away" } } });
    const d1 = acc.buildDailyAccuracy([mk(true, "Serie A", true), mk(false, "Serie A", true)]);
    const d2 = acc.buildDailyAccuracy([mk(true, "Serie A", true), mk(true, "Eredivisie", true), mk(false, "Cup", null)]);
    const m = acc.mergeDailyAccuracy(d1, d2);
    assert.deepStrictEqual(m.oneX2.byLeague["Serie A"], { n: 3, hits: 2 }); assert.deepStrictEqual(m.oneX2.byLeague["Eredivisie"], { n: 1, hits: 1 });
    assert.deepStrictEqual(m.oneX2.byLearned.learned, { n: 4, hits: 3 }); assert.deepStrictEqual(m.oneX2.byLearned.unknown, { n: 1, hits: 0 });
    // 旧形式(v100 以前の保存)と合算しても、新しい方の内訳は残る
    const old = acc.emptyDailyAccuracy(); old.oneX2.n = 10; old.oneX2.hits = 6; old.oneX2.brierSum = 5; old.oneX2.logLossSum = 9;
    delete old.oneX2.byLeague; delete old.oneX2.byLearned;
    const m2 = acc.mergeDailyAccuracy(old, d1);
    assert.strictEqual(m2.oneX2.n, 12); assert.deepStrictEqual(m2.oneX2.byLeague["Serie A"], { n: 2, hits: 1 });
    const s2 = acc.summarizeAccuracy(old).markets.oneX2;
    assert.strictEqual(s2.byLeague.measurable, false); assert.strictEqual(s2.byLearned.measurable, false);
  });

  /* ================= B: 重み採否の関門 ================= */
  const pm = require("./learning/predictionModel");
  await t("B1 decideWeightGate: 的中率が両方で厳密に改善→accuracy / LogLossが改善し的中率は許容幅内→logloss / 悪化→null / mode=accuracy では従来だけ", async () => {
    const base = { baseTrainAccuracy: 56.0, baseValidAccuracy: 54.0, baseTrainLoss: 1.020, baseValidLoss: 1.035 };
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.5, validAccuracy: 54.5, trainLoss: 1.03, validLoss: 1.04 }), "accuracy");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 54.0, trainLoss: 1.015, validLoss: 1.030 }), "logloss", "同値の的中率でも LogLoss が下がれば通るべき(24日間の凍結の原因)");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 53.6, trainLoss: 1.015, validLoss: 1.030 }), "logloss", "的中率 −0.4pt は許容幅(0.5pt)の中");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 53.4, trainLoss: 1.015, validLoss: 1.030 }), null, "的中率 −0.6pt は劣化として拒む");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 54.0, trainLoss: 1.015, validLoss: 1.034 }), null, "検証LogLossの改善が 0.002 未満なら通さない");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 54.0, trainLoss: 1.021, validLoss: 1.030 }), null, "学習用LogLossが下がらない候補は通さない(検証用だけ良く見えるまぐれ)");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 54.0, trainLoss: 1.015, validLoss: 1.030, mode: "accuracy" }), null, "mode=accuracy では従来の関門だけ");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 57, validAccuracy: 55, mode: "accuracy" }), "accuracy");
    assert.strictEqual(pm.decideWeightGate({ ...base, trainAccuracy: 56.0, validAccuracy: 54.0, trainLoss: 1.0, validLoss: 1.0, minLogLossGain: 0.05 }), null, "しきい値の変更が効く");
    assert.strictEqual(pm.decideWeightGate(null), null);
  });

  /* ================= C: 索引の作り直しのまとめ読み ================= */
  const playerSearch = require("./knowledge/playerSearch");
  const { createClubDossier } = require("./knowledge/clubDossier");
  await t("C1 rebuildIndexFromStore: 選手記録と調査ファイルをまとめ読み(MGET)し、コマンド数が人数に比例しない", async () => {
    const s = mockStore();
    const dossier = createClubDossier({ upstashEnabled: true, upstashCmd: s.upstashCmd, upstashGetJSON: s.upstashGetJSON, upstashSetJSON: s.upstashSetJSON });
    const clubs = [{ nameEn: "Alpha FC", nameJa: "アルファ", leagueId: 39 }, { nameEn: "Beta FC", nameJa: "ベータ", leagueId: 39 }, { nameEn: "Gamma FC", nameJa: "ガンマ", leagueId: 140 }];
    const statsIndex = {};
    for (let i = 0; i < 300; i++) {
      const club = clubs[i % 3];
      s.setJSON(`kb:player:${1000 + i}`, { id: 1000 + i, name: "Player " + i, teamEn: club.nameEn, teamJa: club.nameJa, position: "Midfielder", stats: { minutes: 500 + i, rating: 6.8 + (i % 10) / 10, appearances: 8 } });
      statsIndex[String(1000 + i)] = `2026-11-0${1 + (i % 8)}T00:00:00.000Z`;
    }
    s.setJSON("kb:player:statsIndex", statsIndex);
    for (const c of clubs) s.setJSON(`kb:club:${c.nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, { nameEn: c.nameEn, nameJa: c.nameJa, sections: { squad: { players: [{ id: 5000 + clubs.indexOf(c), name: "Squad " + c.nameEn, position: "Defender" }] } } });
    s.calls.length = 0;
    const deps = { upstashEnabled: true, upstashCmd: s.upstashCmd, upstashGetJSON: s.upstashGetJSON, upstashSetJSON: s.upstashSetJSON };
    const r = await playerSearch.rebuildIndexFromStore(deps, { clubDossier: dossier, clubs, nowMs: Date.now(), dateKey: "2026-11-08", playerRecordCap: 6000 });
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(r.recordsRead, 300); assert.strictEqual(r.fromRecords, 300); assert.strictEqual(r.fromSquads, 3);
    assert.strictEqual(r.count, 303, "索引の人数(記録300+名簿のみ3)");
    const gets = s.count("GET"), mgets = s.count("MGET");
    assert.ok(mgets >= 3 && mgets <= 8, `選手300件+クラブ3件は MGET 数回で読めるはず: MGET=${mgets}`);
    assert.ok(gets <= 10, `1件ずつの GET が残っている(GET=${gets})`);
    assert.ok(r.redisReads <= 15, `redisReads=${r.redisReads}(v100 以前は 300+3+2 回)`);
    assert.strictEqual(r.playerReadMode, "mget");
    // 読み直し(loadIndex)もブロックをまとめ読みする
    s.calls.length = 0;
    const loaded = await playerSearch.loadIndex(deps);
    assert.strictEqual(loaded.available, true); assert.strictEqual(loaded.rows.length, 303);
    assert.ok(s.count("GET") <= 2 && s.count("MGET") >= 1, `索引の読み出し: GET=${s.count("GET")} MGET=${s.count("MGET")}`);
  });

  await t("C2 clubDossier.getPlayers: 100人ずつの MGET で読み、読めなかった件は null、コマンド数の見積もりを返す", async () => {
    const s = mockStore();
    const dossier = createClubDossier({ upstashEnabled: true, upstashCmd: s.upstashCmd, upstashGetJSON: s.upstashGetJSON, upstashSetJSON: s.upstashSetJSON });
    for (let i = 0; i < 250; i++) s.setJSON(`kb:player:${i}`, { id: i, name: "P" + i });
    const ids = []; for (let i = 0; i < 260; i++) ids.push(i); // 10件は存在しない
    s.calls.length = 0;
    const got = await dossier.getPlayers(ids);
    assert.strictEqual(got.byId.size, 250); assert.strictEqual(got.readMode, "mget"); assert.strictEqual(got.commands, 3); assert.strictEqual(s.count("MGET"), 3);
    assert.strictEqual(got.readFailed, false);
    const none = await dossier.getPlayers([]);
    assert.strictEqual(none.byId.size, 0); assert.strictEqual(none.commands, 0);
  });

  /* ================= D: 学習計画の正直さ ================= */
  await t("D1 learningAgenda: 重みが何日も据え置きなら「次回の重み学習で再評価」にその事実を添える", async () => {
    const { buildLearningAgenda } = require("./learning/learningAgenda");
    const recs = []; for (let i = 0; i < 40; i++) recs.push({ resolved: true, correct: i % 2 === 0, homeTeamEn: "A" + (i % 7), awayTeamEn: "B" + (i % 5) });
    const reasons = [{ id: "formDiff_overweighted", labelJa: "直近フォームを重視しすぎた", count: 12 }];
    const a1 = buildLearningAgenda(recs, reasons, { nowIso: "2026-11-08T03:00:00Z", weightsState: { weightsUpdatedToday: false, daysSinceUpdate: 24, gate: { mode: "logloss", candidates: 6, passed: 0 } } });
    const theme = a1.items.find((it) => it.kind === "theme");
    assert.ok(theme, "テーマ項目が無い");
    assert.ok(/24日間据え置き/.test(theme.actionJa), theme.actionJa);
    assert.ok(/候補6件のうち0件/.test(theme.actionJa), theme.actionJa);
    assert.strictEqual(theme.weightsDaysSinceUpdate, 24);
    const a2 = buildLearningAgenda(recs, reasons, { nowIso: "2026-11-08T03:00:00Z", weightsState: { weightsUpdatedToday: true, daysSinceUpdate: 0 } });
    assert.ok(/本日の重み学習で重みが更新されました/.test(a2.items.find((it) => it.kind === "theme").actionJa));
    const a3 = buildLearningAgenda(recs, reasons, { nowIso: "2026-11-08T03:00:00Z" }); // 情報が無ければ従来どおり
    assert.ok(!/据え置き/.test(a3.items.find((it) => it.kind === "theme").actionJa));
  });

  /* ================= E: サーバー(鮮度ガード・日次レポートの開示) ================= */
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "0";
  const srvMod = require("./server.js");
  const V = srvMod.__v100ForTest;
  const m = mockStore();
  srvMod.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    callApiFootball: async () => ({ response: [] }),
  });
  await sleep(300);
  const now = Date.now();
  const jstToday = new Date(now + 9 * 3600000).toISOString().slice(0, 10);

  await t("E1 rebuildPlayerIndexNow: 作られたばかりの索引(6時間以内)は読み直さず見送る/force なら作り直す/古ければ作り直す", async () => {
    // 新しい索引を保存先に置く(本番の収集が作った直後の状態)
    const rows = []; for (let i = 0; i < 20; i++) rows.push(playerSearch.toIndexRow({ id: 7000 + i, name: "Fresh " + i, teamEn: "Arsenal", teamJa: "アーセナル", position: "Midfielder", stats: { minutes: 400, rating: 7.0 } }, { todayKey: 20261108 }, now, null));
    const saved = await playerSearch.saveIndex(V.playerSearchDeps, rows, { builtAt: new Date(now - 5 * 60000).toISOString(), dateKey: jstToday });
    assert.strictEqual(saved.saved, true, JSON.stringify(saved));
    m.calls.length = 0;
    const r = await V.rebuildPlayerIndexNow({ trigger: "autoQA" });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.skippedFresh, true); assert.ok(/作られたばかり/.test(r.reasonJa), r.reasonJa);
    assert.ok(m.count("MGET") + m.count("GET") <= 6, `見送りなのに保存先を大量に読んだ(GET=${m.count("GET")} MGET=${m.count("MGET")})`);
    // force なら作り直す(統計索引が無いので0人=ok:false だが、鮮度では止まらない)
    const r2 = await V.rebuildPlayerIndexNow({ trigger: "manual", force: true });
    assert.notStrictEqual(r2.skippedFresh, true, JSON.stringify(r2).slice(0, 200));
    // 索引が古ければ(7時間前)作り直す
    await playerSearch.saveIndex(V.playerSearchDeps, rows, { builtAt: new Date(now - 7 * 3600000).toISOString(), dateKey: jstToday });
    const r3 = await V.rebuildPlayerIndexNow({ trigger: "autoQA" });
    assert.notStrictEqual(r3.skippedFresh, true, "6時間より古い索引は作り直すべき");
  });

  await t("E2 /api/learning/daily-report: weightsNow(version・市場ブレンド比・特徴量の重み)・weightGate・tuningHistory・marketBlendFit・lineupWatch・clubElo・リーグ別/学習済み別/技能スコア が載る", async () => {
    srvMod.__clearCache();
    m.setJSON("learn:weights", { version: 33, updatedAt: "2026-10-15T22:15:48.563Z", marketBlend: 0.9, apifbBlend: 0, modelForm: "mult", homeBase: 1.42, awayBase: 1.08, rho: -0.05, drawBand: 0.15, sensitivity: 0.053, marketSensitivity: 0.246, ratingSensitivity: 0.315, squadRatingSensitivity: 0 });
    m.store.set("learn:modeltuning:log", [
      JSON.stringify({ date: "2026-11-05", adopted: false, oldEval: { logLoss: 1.018, brier: 0.6102 }, newEval: { logLoss: 1.0183, brier: 0.6106 }, testSize: 1500, trainSize: 3500, datasetSize: 5000, reasonJa: "有意な改善なし" }),
      JSON.stringify({ date: "2026-11-04", adopted: true, oldEval: { logLoss: 1.03 }, newEval: { logLoss: 1.018 }, testSize: 1480 }),
    ]);
    const g = {
      date: jstToday, ranAt: new Date(now).toISOString(), runsToday: 1, errors: [], warnings: { count: 0, items: [] },
      weightGate: { mode: "logloss", minLogLossGain: 0.002, accuracyTolerancePt: 0.5, fitSize: 1000, validSize: 428, baseValidLogLoss: 1.0123, candidates: 6, passed: 1, adoptedGate: "logloss", bestValidLogLoss: 1.0081 },
      marketBlendFit: { adopted: true, w: 0.9, samples: 420, saved: false, validNllBase: 1.0211, validNllBest: 0.9512, reasonJa: "x" },
      apifbBlendFit: { adopted: false, w: 0, samples: 300, saved: false },
      lineupWatch: { comparedToday: 3, morningBrier: 0.61, prekickBrier: 0.6 },
      clubElo: { dailyAvailable: false, staleDays: 70, usedInPredictions: 0, error: "HTTP_502" },
    };
    m.setJSON("learn:growthlog:latest", g);
    // 本日の精度記録(リーグ別つき)
    const scored = [
      { official: true, league: "Premier League", learned: true, markets: { oneX2: { hit: true, brier: 0.4, logLoss: 0.5, confidence: 0.6, predicted: "home", actual: "home" } } },
      { official: true, league: "Major League Soccer", learned: false, markets: { oneX2: { hit: false, brier: 0.9, logLoss: 1.3, confidence: 0.5, predicted: "home", actual: "away" } } },
    ];
    const yKey = new Date(now + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    m.setJSON(`learn:accuracy:${yKey}`, acc.buildDailyAccuracy(scored));
    const r = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now()}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const b = r.body;
    assert.strictEqual(b.weightsNow.available, true); assert.strictEqual(b.weightsNow.version, 33); assert.strictEqual(b.weightsNow.marketBlend, 0.9); assert.strictEqual(b.weightsNow.modelForm, "mult");
    assert.strictEqual(b.weightsNow.sensitivities.marketEdge, 0.246); assert.strictEqual(b.weightsNow.sensitivities.squadRatingDiff, 0); assert.strictEqual(b.weightsNow.sensitivities.ratingLambdaDiff, 0.315);
    assert.ok(Number.isFinite(b.weightsNow.daysSinceUpdate) && b.weightsNow.daysSinceUpdate >= 20, JSON.stringify(b.weightsNow.daysSinceUpdate));
    assert.deepStrictEqual(b.weightGate, g.weightGate);
    assert.strictEqual(b.tuningHistory.available, true); assert.strictEqual(b.tuningHistory.items.length, 2);
    assert.strictEqual(b.tuningHistory.items[0].oldLogLoss, 1.018); assert.strictEqual(b.tuningHistory.items[0].newLogLoss, 1.0183); assert.strictEqual(b.tuningHistory.items[1].adopted, true);
    assert.deepStrictEqual(b.marketBlendFit, g.marketBlendFit); assert.deepStrictEqual(b.apifbBlendFit, g.apifbBlendFit);
    assert.deepStrictEqual(b.lineupWatch, g.lineupWatch); assert.deepStrictEqual(b.clubElo, g.clubElo);
    const y = b.accuracy.yesterday.markets.oneX2;
    assert.strictEqual(y.byLeague.measurable, true); assert.strictEqual(y.byLeague.rows.length, 2);
    assert.strictEqual(y.byLearned.learned.n, 1); assert.strictEqual(y.byLearned.unlearned.n, 1);
    assert.ok(Number.isFinite(y.skill.logLossSkillPct));
    // 重みが無い環境でも壊れない
    m.store.delete("learn:weights"); m.store.delete("learn:modeltuning:log"); srvMod.__clearCache();
    const r2 = await req("GET", `/api/learning/daily-report?d=${jstToday}&t=${Date.now() + 1}`);
    assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.weightsNow.available, false); assert.strictEqual(r2.body.tuningHistory.available, false);
  });

  await t("F1 v92方針: learning/ に黙った catch を増やしていない(今回触ったファイル)", async () => {
    for (const f of ["learning/accuracyTracker.js", "learning/learningAgenda.js", "learning/dailyJob.js", "learning/predictionModel.js"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      const n = (src.match(/catch \(e\) \{ \/\*/g) || []).length;
      if (f === "learning/accuracyTracker.js") assert.strictEqual(n, 1, f + ": 許可リストの1か所(MGET不可→従来経路)だけのはず: " + n);
      else assert.strictEqual(n, 0, f + " に黙った catch がある: " + n);
    }
  });

  console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
  try { srvMod.server.close(); } catch (e) { /* テスト終了時の後片づけ */ }
  process.exit(fail ? 1 : 0);
})();
