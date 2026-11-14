"use strict";
/**
 * v104.1 総点検(2026年11月14日)で見つけて直した欠陥の回帰テスト — 部品編(サーバーを起動しない)
 *
 * このファイルの方針(今回の総点検で分かった「テストが通っていたのに本番で壊れていた」原因への対策):
 *   ・本物の部品(require した実物)を動かして確かめる。期待値を「使う側が欲しい形」で手書きしない。
 *   ・各テストは「直す前のコード(v104)では落ちる」ことを、別途 v104 の部品に向けて実行して確認してある
 *     (環境変数 AUDIT_ROOT で部品の読み込み先を切り替えられる)。
 *   ・サーバーを起動して確かめる項目(道具の中身と本物の応答の突き合わせ・試合一覧・日次レポート)は
 *     v104_1_audit_server_test.js にある。
 *
 * 対象:
 *   A 同じ名前の別クラブを混ぜない(試合カードの知識・主力評価点・動的クラブの採用・対戦分析・弱点クラブの集計)
 *   B チームの照合(検索結果の先頭を無条件に採用しない)・女子/年代別の判定
 *   C 会話の道具(クラブでの絞り込みは部分一致にしない・結果は上限内で必ず JSON として読める)
 *   D 表示用の確信度の補正(帯の境目で逆転しない)は v104_1_tiers_grounding_test.js の K2b
 *   E 学習の履歴の日付(日本時間)
 *   F 画面(index.html): 長い文字列の折り返し・重みの影響の表示・試合カードの理由別の文・翻訳エンジンの速さと同値性
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = process.env.AUDIT_ROOT ? path.resolve(process.env.AUDIT_ROOT) : __dirname;
const req = (p) => require(path.join(ROOT, p));
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

/** Upstash 風の小さな保存先(ハッシュ・文字列) */
function fakeStore() {
  const data = new Map(); const log = [];
  const cmd = async (c) => {
    const [op, ...a] = c; log.push(op);
    if (op === "GET") return data.has(a[0]) ? data.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (data.has(k) ? data.get(k) : null));
    if (op === "SET") { data.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (data.delete(k)) n++; return n; }
    if (op === "HGETALL") { const h = data.get(a[0]); return h ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = data.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; data.set(a[0], h); return 1; }
    if (op === "HDEL") { const h = data.get(a[0]) || {}; let n = 0; for (const f of a.slice(1)) if (f in h) { delete h[f]; n++; } data.set(a[0], h); return n; }
    if (op === "LRANGE") return data.get(a[0]) || [];
    if (op === "RPUSH" || op === "LPUSH") { const l = data.get(a[0]) || []; if (op === "RPUSH") l.push(a[1]); else l.unshift(a[1]); data.set(a[0], l); return l.length; }
    if (op === "EXPIRE" || op === "LTRIM") return 1;
    return null;
  };
  const getJSON = async (k) => { const r = await cmd(["GET", k]); return r === null ? null : JSON.parse(r); };
  const setJSON = async (k, v) => { await cmd(["SET", k, JSON.stringify(v)]); return true; };
  return { data, log, cmd, getJSON, setJSON, hash: (k) => data.get(k) || {} };
}

(async () => {
  console.log("v104.1 総点検の回帰テスト(部品編)" + (process.env.AUDIT_ROOT ? ` — 部品の読み込み先: ${ROOT}` : ""));

  // =====================================================================================
  // A. 同じ名前の別クラブを混ぜない
  // =====================================================================================
  console.log("■ A 同じ名前の別クラブを混ぜない");
  const { createTeamKnowledge } = req("knowledge/teamKnowledge.js");
  const { slugOf } = req("knowledge/clubDossier.js");
  const UNI = [
    { rank: 1, nameEn: "Porto", nameJa: "ポルト", leagueId: 94, country: "ポルトガル" },
    { rank: 2, nameEn: "Bayern Munich", searchAs: "Bayern Munchen", nameJa: "バイエルン・ミュンヘン", leagueId: 78, country: "ドイツ" },
    { rank: 3, nameEn: "Como", nameJa: "コモ", leagueId: 135, country: "イタリア" }, // チームID未保存の固定名簿クラブ
  ];
  const player = (name, teamEn, rating) => ({ name, teamEn, position: "Midfielder", rating, minutes: 900, appearances: 10, goals: 1, assists: 1 });
  const PLAYERS = [];
  for (let i = 0; i < 8; i++) PLAYERS.push(player(`Porto Player ${i}`, "Porto", 7.2 + i * 0.01));
  for (let i = 0; i < 8; i++) PLAYERS.push(player(`Kashima Player ${i}`, "Kashima", 6.9));
  for (let i = 0; i < 8; i++) PLAYERS.push(player(`Nacional Player ${i}`, "Nacional", 6.8));
  function makeTK({ teammap, adopted, dossiers, playersNull, isSecondaryName }) {
    const st = fakeStore();
    if (teammap) st.data.set("kb:universe:teammap", JSON.stringify(teammap));
    const dynamicUniverse = { loadAdopted: async () => ({ ok: true, map: new Map(Object.entries(adopted || {})) }) };
    const clubDossier = {
      getDossiers: async (names) => { const byName = new Map(); for (const n of names) if (dossiers && dossiers[n]) byName.set(n, dossiers[n]); return { byName, readFailed: false }; },
    };
    return createTeamKnowledge({
      CLUB_UNIVERSE: UNI, clubDossier, dynamicUniverse,
      getPlayerRows: () => (playersNull ? { players: null, builtAt: null, unavailable: true } : { players: PLAYERS, builtAt: "2026-11-14T00:00:00Z" }),
      upstashEnabled: true, upstashCmd: st.cmd, upstashGetJSON: st.getJSON,
      isSecondaryName: isSecondaryName || ((n) => /\bU2[0-3]\b|\bW$|\bII$/.test(String(n || ""))),
    });
  }
  const TEAMMAP = { clubs: [
    { teamId: 212, nameEn: "Porto", nameJa: "ポルト", tier: "A" },
    { teamId: 157, nameEn: "Bayern Munich", nameJa: "バイエルン・ミュンヘン", tier: "A" },
    { teamId: 290, nameEn: "Kashima", nameJa: "Kashima", dynamic: true, idVerified: true },
  ] };
  const dossierOf = (teamId, extra) => ({ teamId, tier: "A", nameJa: null, sections: { form: { currentFormScore: 60 }, standings: { position: 3, points: 21, played: 10 } }, ...(extra || {}) });

  await t("A1 追跡中の FC Porto(ID 212)と同じ名前の別クラブ(ブラジルの「Porto」ID 9999)に、Porto の選手・評価点・調査ファイルを見せない", async () => {
    const tk = makeTK({ teammap: TEAMMAP, dossiers: { Porto: dossierOf(212) } });
    // 本物の Porto: IDで一致 → 選手8人・調査ファイルあり
    const real = await tk.knowledgeForFixture({ id: 212, name: "FC Porto" }, { id: 157, name: "Bayern München" });
    assert.strictEqual(real.home.tracked, true); assert.strictEqual(real.home.nameEn, "Porto");
    assert.strictEqual(real.home.squad.playersIndexed, 8); assert.ok(real.home.dossier && real.home.dossier.form);
    // 同名の別クラブ: 名前は「Porto」だがチームIDが違う → 追跡対象外・理由は「同じ名前の別クラブ」。選手も調査ファイルも渡さない
    const other = await tk.knowledgeForFixture({ id: 9999, name: "Porto" }, { id: 157, name: "Bayern München" });
    assert.strictEqual(other.home.tracked, false, JSON.stringify(other.home));
    assert.strictEqual(other.home.reason, "same_name_other_club");
    assert.strictEqual(other.home.teamId, 9999);
    assert.ok(!("squad" in other.home) && !("dossier" in other.home), "別クラブの選手・調査ファイルを渡している");
    // 予測の特徴量(主力の平均評価点)も、別クラブには使わない
    assert.strictEqual(await tk.squadRatingForFeature(9999, "Porto"), null, "同じ名前の別クラブに Porto の主力評価点を使っている");
    assert.ok((await tk.squadRatingForFeature(212, "FC Porto")) > 7, "本物の Porto には使う");
    const r = await tk.resolveTeam({ id: 9999, name: "Porto" });
    assert.deepStrictEqual([r.idConflict, r.savedTeamId, r.teamIdUnconfirmed], [true, 212, true]);
  });

  await t("A2 アクセント記号を畳んで照合する(「Bayern München」= 固定名簿の Bayern Munich)。IDが無くても名前で固定名簿と分かる", async () => {
    const tk = makeTK({ teammap: TEAMMAP, dossiers: {} });
    await tk.ensureMap(true);
    const r = await tk.resolveTeam({ id: null, name: "Bayern München" });
    assert.ok(r && r.nameEn === "Bayern Munich", JSON.stringify(r));
    assert.strictEqual(tk.isStaticTeamSync(424242, "Bayern München"), true, "固定名簿のクラブを動的クラブの候補にしてしまう");
    assert.strictEqual(tk.isStaticTeamSync(424242, "FC  Como"), false);
    assert.strictEqual(tk.isStaticTeamSync(424242, "Como"), true, "チームID未保存の固定名簿クラブも、名前(slug)で固定名簿と分かる");
    assert.strictEqual(tk.staticTeamIdOf("Porto"), 212); assert.strictEqual(tk.staticTeamIdOf("Como"), null); assert.strictEqual(tk.staticTeamIdOf("Nobody"), null);
  });

  await t("A3 調査ファイルの持ち主(チームID)が試合のチームと違えば出さない。追跡対象外の理由を3つに分ける(2軍・女子/同名の別クラブ/未追跡)", async () => {
    // 調査ファイル kb:club:kashima の持ち主が別のチーム(ID 777)になっている = 同じ名前の別クラブのファイル
    const tk = makeTK({ teammap: TEAMMAP, adopted: { 290: { nameEn: "Kashima", adoptedAt: "2026-11-01" } }, dossiers: { Kashima: dossierOf(777) } });
    const k = await tk.knowledgeForFixture({ id: 290, name: "Kashima" }, { id: 5001, name: "Tokyo Verdy U23" });
    assert.deepStrictEqual([k.home.tracked, k.home.reason], [false, "same_name_other_club"]);
    assert.deepStrictEqual([k.away.tracked, k.away.reason], [false, "secondary_team"]);
    const k2 = await tk.knowledgeForFixture({ id: 6001, name: "Sagan Tosu" }, { id: 6002, name: "Bayern Munich" });
    assert.deepStrictEqual([k2.home.tracked, k2.home.reason], [false, "untracked"]);
    // 固定名簿のクラブ(保存済みID 157)と同じ名前だがIDが違い、調査ファイルでも確かめられない → 同名の別クラブ
    assert.deepStrictEqual([k2.away.tracked, k2.away.reason], [false, "same_name_other_club"]);
    // 調査ファイルの持ち主が一致するなら、名前だけで拾った候補でも出してよい(照合表がまだ古いだけ)
    const tk2 = makeTK({ teammap: { clubs: [{ teamId: 212, nameEn: "Porto" }] }, dossiers: { Como: dossierOf(895) } });
    const k3 = await tk2.knowledgeForFixture({ id: 895, name: "Como" }, { id: 212, name: "FC Porto" });
    assert.strictEqual(k3.home.tracked, true); assert.ok(k3.home.dossier);
  });

  await t("A4 動的クラブ: 同じ名前(slug)の2チームを両方は載せない(採用日の古い側だけ)。まだ収集で確かめられていないクラブは「取り込み中」で、評価点も使わない", async () => {
    const tk = makeTK({
      teammap: TEAMMAP,
      adopted: {
        3001: { nameEn: "Nacional", adoptedAt: "2026-11-02" },        // 先に採用(ウルグアイ)
        3002: { nameEn: "Nacional", adoptedAt: "2026-11-05" },        // 同名(ポルトガル)→ 載せない
        3003: { nameEn: "Al-Ahli", adoptedAt: "2026-11-03" },
        3004: { nameEn: "Al Ahli", adoptedAt: "2026-11-04" },         // slug が同じ(al-ahli)→ 載せない
        290: { nameEn: "Kashima", adoptedAt: "2026-11-01" },
        3005: { nameEn: "Porto", adoptedAt: "2026-11-06" },           // 固定名簿と同じ名前 → 載せない
      },
      dossiers: { Nacional: dossierOf(3001), Kashima: dossierOf(290) },
    });
    const map = await tk.ensureMap(true);
    assert.ok(map.has(3001) && !map.has(3002), "同じ名前の2チームを両方載せている");
    assert.ok(map.has(3003) && !map.has(3004), "slug が同じ2チームを両方載せている");
    assert.ok(!map.has(3005), "固定名簿のクラブと同じ名前の動的クラブを載せている");
    const snap = tk.snapshot();
    assert.deepStrictEqual(snap.nameCollisions.map((c) => [c.teamId, c.ownerTeamId]).sort(), [[3002, 3001], [3004, 3003], [3005, 212]].sort());
    // 対応表に行があり idVerified:true の Kashima は確認済み。Nacional / Al-Ahli は対応表に行が無い=未確認
    assert.strictEqual(map.get(290).unverified, undefined);
    assert.strictEqual(map.get(3001).unverified, true);
    assert.strictEqual(snap.unverifiedDynamic, 2);
    assert.strictEqual(await tk.squadRatingForFeature(3003, "Al-Ahli"), null, "未確認の動的クラブに評価点を使っている");
    // 未確認でも、調査ファイルの持ち主がそのチームIDなら確認できたものとして出す(Nacional 3001)
    const k = await tk.knowledgeForFixture({ id: 3001, name: "Nacional" }, { id: 3003, name: "Al-Ahli" });
    assert.strictEqual(k.home.tracked, true); assert.ok(k.home.squad && k.home.squad.playersIndexed === 8); assert.ok(!k.home.importing);
    assert.deepStrictEqual([k.away.tracked, k.away.importing, k.away.squad, k.away.dossier], [true, true, null, null], "未確認のクラブは取り込み中として出す");
    // もう片方の Nacional(3002)の試合カードには、3001 の情報を出さない
    const k2 = await tk.knowledgeForFixture({ id: 3002, name: "Nacional" }, { id: 290, name: "Kashima" });
    assert.deepStrictEqual([k2.home.tracked, k2.home.reason], [false, "same_name_other_club"]);
    assert.strictEqual(k2.away.squad.playersIndexed, 8);
    // 対応表に idVerified:false と書かれた行は未確認
    const tk3 = makeTK({ teammap: { clubs: [{ teamId: 290, nameEn: "Kashima", dynamic: true, idVerified: false }] }, adopted: { 290: { nameEn: "Kashima", adoptedAt: "2026-11-01" } } });
    assert.strictEqual((await tk3.ensureMap(true)).get(290).unverified, true);
  });

  await t("A5 選手索引を読めていないときは「選手がいない」ではなく「分からない」(indexUnavailable)。順位は保存名 position から読む", async () => {
    const tk = makeTK({ teammap: TEAMMAP, dossiers: { Porto: dossierOf(212) }, playersNull: true });
    const k = await tk.knowledgeForFixture({ id: 212, name: "FC Porto" }, { id: 6001, name: "Sagan Tosu" });
    assert.strictEqual(k.indexUnavailable, true);
    assert.strictEqual(k.home.squad, null, "索引が無いのに「0人」の実測を作っている");
    assert.strictEqual(k.home.dossier.standings.rank, 3, "順位(position)を読めていない");
    const tk2 = makeTK({ teammap: TEAMMAP, dossiers: { Porto: dossierOf(212) } });
    assert.strictEqual((await tk2.knowledgeForFixture({ id: 212, name: "FC Porto" }, { id: 6001, name: "Sagan Tosu" })).indexUnavailable, false);
  });

  // ---- 動的クラブの採用(保存先つき・本物の adoptForToday) ----
  const { createDynamicUniverse } = req("learning/dynamicUniverse.js");
  const SEEN_KEY = "kb:universe:dyn:seen", ADOPTED_KEY = "kb:universe:dyn:adopted";
  const seenRow = (nameEn, extra) => JSON.stringify({ nameEn, leagueId: 98, league: "J1 League", country: "Japan", firstSeen: "2026-11-10", lastSeen: "2026-11-14", seen: 3, views: 0, learned: true, missing: 0, ...(extra || {}) });

  await t("A6 動的クラブの採用: 同じ名前(slug)の候補は1つだけ採用。採用済みの別チームと同名の候補は採用しない。件数と例を開示する", async () => {
    const st = fakeStore();
    st.data.set(ADOPTED_KEY, { 3001: JSON.stringify({ nameEn: "Nacional", adoptedAt: "2026-11-02", lastSeen: "2026-11-14" }) });
    st.data.set(SEEN_KEY, {
      3002: seenRow("Nacional", { seen: 9 }),                 // 採用済み(3001)と同名 → 採用しない
      4001: seenRow("Al-Ahli", { seen: 8 }), 4002: seenRow("Al Ahli", { seen: 7 }), // 同じ回の候補どうしが同名 → 優先度の高い側だけ
      4003: seenRow("Sagan Tosu", { seen: 2 }),
      4004: seenRow("Urawa (W)", { seen: 9 }),                // 女子 → 候補から外す
      4005: seenRow("Kyoto Frauen", { seen: 9 }),             // 女子(独語表記)→ 候補から外す
    });
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: st.cmd });
    const out = await du.adoptForToday({ dateKey: "2026-11-14", nowMs: Date.parse("2026-11-14T19:00:00Z"), perDay: 10, isStaticTeam: () => false });
    assert.strictEqual(out.ok, true, JSON.stringify(out).slice(0, 300));
    const adoptedIds = Object.keys(st.hash(ADOPTED_KEY)).map(Number).sort((a, b) => a - b);
    assert.deepStrictEqual(adoptedIds, [3001, 4001, 4003], "採用結果: " + JSON.stringify(adoptedIds));
    assert.strictEqual(out.nameCollisionSkipped, 2);
    assert.deepStrictEqual(out.nameCollisionSkippedSample.map((c) => [c.teamId, c.ownerTeamId]).sort(), [[3002, 3001], [4002, 4001]]);
    assert.ok(!Object.keys(st.hash(SEEN_KEY)).includes("4004") && !Object.keys(st.hash(SEEN_KEY)).includes("4005"), "女子チームが候補に残っている");
    assert.strictEqual(du.isSecondaryName("Bayern Frauen"), true); assert.strictEqual(du.isSecondaryName("Roma Femminile"), true); assert.strictEqual(du.isSecondaryName("Ajax Vrouwen"), true);
    assert.strictEqual(du.isSecondaryName("Kashima Antlers"), false);
  });

  await t("A7 動的クラブの整理: 以前に両方採用されていた同名の組は古い側だけ残す。固定名簿のクラブ自身と分かったチームは動的クラブから外す", async () => {
    const st = fakeStore();
    st.data.set(ADOPTED_KEY, {
      3001: JSON.stringify({ nameEn: "Nacional", adoptedAt: "2026-11-02", lastSeen: "2026-11-14" }),
      3002: JSON.stringify({ nameEn: "Nacional", adoptedAt: "2026-11-05", lastSeen: "2026-11-14" }),
      157: JSON.stringify({ nameEn: "Bayern München", adoptedAt: "2026-11-03", lastSeen: "2026-11-14" }), // 実は固定名簿のクラブ
    });
    st.data.set(SEEN_KEY, {});
    const du = createDynamicUniverse({ upstashEnabled: true, upstashCmd: st.cmd });
    const out = await du.adoptForToday({ dateKey: "2026-11-14", nowMs: Date.parse("2026-11-14T19:00:00Z"), perDay: 10, isStaticTeam: (id) => id === 157 });
    assert.deepStrictEqual(Object.keys(st.hash(ADOPTED_KEY)).map(Number).sort((a, b) => a - b), [3001]);
    assert.strictEqual(out.duplicateRetired, 1); assert.deepStrictEqual(out.duplicateRetiredSample[0], { teamId: 3002, nameEn: "Nacional", keptTeamId: 3001 });
    assert.strictEqual(out.retiredAsStatic, 1);
  });

  // ---- 対戦分析の名寄せ ----
  const MA = req("learning/matchupAnalysis.js");
  await t("A8 対戦分析: 追跡中クラブは保存済みのチームIDで決める(名前の索引に同名の別クラブが居ても「候補が複数」にしない)", async () => {
    assert.strictEqual(typeof MA.buildTrackedIdMap, "function", "buildTrackedIdMap が無い");
    const idMap = MA.buildTrackedIdMap([
      { teamId: 212, nameEn: "Porto" }, { teamId: 157, nameEn: "Bayern Munich" },
      { teamId: 290, nameEn: "Kashima", dynamic: true, idVerified: true },
      { teamId: 3001, nameEn: "Nacional", dynamic: true, idVerified: false }, // 未確認は載せない
      { teamId: 9998, nameEn: "Porto", dynamic: true, idVerified: true },     // 固定名簿が先(上書きしない)
    ], UNI);
    const ids = [...idMap.values()];
    assert.ok(ids.includes(212) && ids.includes(157) && ids.includes(290), JSON.stringify([...idMap.entries()]));
    assert.ok(!ids.includes(3001), "まだ収集で確かめられていない動的クラブを載せている");
    assert.ok(!ids.includes(9998), "同じ名前の動的クラブが固定名簿のクラブを上書きしている");
    // 名前の索引に「FC Porto(212)」と「Porto(9999)」の両方がある状況で、Porto を解決する
    const index = MA.buildNameIndex({ 212: "FC Porto", 9999: "Porto", 157: "Bayern München" });
    const jaMap = MA.buildJaMap(UNI);
    const withIds = MA.resolveClub("ポルト", { index, jaMap, universe: UNI, trackedIdByNorm: idMap });
    assert.deepStrictEqual([withIds.ok, withIds.id], [true, 212], JSON.stringify(withIds));
    const withIdsEn = MA.resolveClub("Porto", { index, jaMap, universe: UNI, trackedIdByNorm: idMap });
    assert.deepStrictEqual([withIdsEn.ok, withIdsEn.id], [true, 212], JSON.stringify(withIdsEn));
    // 提供元での表記(Bayern München)・アプリの表記(Bayern Munich)のどちらで聞いても、保存済みのIDへ
    for (const q of ["Bayern Munich", "Bayern München", "バイエルン・ミュンヘン"]) {
      const r = MA.resolveClub(q, { index, jaMap, universe: UNI, trackedIdByNorm: idMap });
      assert.deepStrictEqual([r.ok, r.id], [true, 157], q + " → " + JSON.stringify(r));
    }
    // 索引にそのIDがまだ無いときは、従来の名前照合へ進む(壊さない)
    const noIdx = MA.resolveClub("Porto", { index: MA.buildNameIndex({ 9999: "Porto" }), jaMap, universe: UNI, trackedIdByNorm: idMap });
    assert.deepStrictEqual([noIdx.ok, noIdx.id], [true, 9999]);
  });

  await t("A8b 追跡中クラブは「このアプリでの名前」で渡す: 名前の索引にある提供元の表記(FC Porto / Bayern München)のままでは、蓄積した知識(保存名 Porto / Bayern Munich)を引けない", async () => {
    assert.strictEqual(typeof MA.buildTrackedNameMap, "function", "buildTrackedNameMap が無い");
    const teamMap = [
      { teamId: 212, nameEn: "Porto", nameJa: "ポルト" }, { teamId: 157, nameEn: "Bayern Munich", nameJa: "バイエルン・ミュンヘン" },
      { teamId: 290, nameEn: "Kashima", nameJa: "Kashima", dynamic: true, idVerified: true },
      { teamId: 3001, nameEn: "Nacional", dynamic: true, idVerified: false },
      { teamId: 212, nameEn: "Porto Dup", dynamic: true, idVerified: true }, // 固定名簿が先(上書きしない)
    ];
    const names = MA.buildTrackedNameMap(teamMap);
    assert.deepStrictEqual(names.get(212), { nameEn: "Porto", nameJa: "ポルト" });
    assert.deepStrictEqual(names.get(290), { nameEn: "Kashima", nameJa: null }, "日本語名が英語名と同じときは null");
    assert.strictEqual(names.has(3001), false, "未確認の動的クラブを載せている");
    const ctx = { index: MA.buildNameIndex({ 212: "FC Porto", 157: "Bayern München", 9999: "Porto", 5000: "Braga" }), jaMap: MA.buildJaMap(UNI), universe: UNI, trackedIdByNorm: MA.buildTrackedIdMap(teamMap, UNI), trackedNameById: names };
    const r = MA.resolveClub("ポルト", ctx);
    assert.deepStrictEqual([r.ok, r.id, r.name, r.trackedNameEn], [true, 212, "FC Porto", "Porto"], JSON.stringify(r));
    const b = MA.resolveClub("Bayern München", ctx);
    assert.deepStrictEqual([b.id, b.name, b.trackedNameEn, b.trackedNameJa], [157, "Bayern München", "Bayern Munich", "バイエルン・ミュンヘン"]);
    // 追跡していないクラブには付けない(提供元の表記のまま)
    const x = MA.resolveClub("Braga", ctx);
    assert.deepStrictEqual([x.ok, x.name, x.trackedNameEn], [true, "Braga", undefined]);
    // 会話の対象の解決(サーバー側の名寄せ)も、このアプリでの名前で返す
    const SR = req("discuss/subjectResolver.js");
    const sub = SR.resolveSubjectFromQuestion("ポルトは最近どう?", ctx);
    assert.ok(sub && sub.subject, JSON.stringify(sub));
    assert.deepStrictEqual([sub.subject.type, sub.subject.labelEn, sub.subject.teamId], ["club", "Porto", 212], "会話の対象が提供元の表記のまま: " + JSON.stringify(sub.subject));
    const sub2 = SR.resolveSubjectFromQuestion("ブラガの調子は?", { ...ctx, jaMap: MA.buildJaMap([...UNI, { nameEn: "Braga", nameJa: "ブラガ" }]) });
    assert.deepStrictEqual([sub2.subject && sub2.subject.labelEn], ["Braga"]);
  });

  // ---- 弱点クラブの集計 ----
  const AG = req("learning/learningAgenda.js");
  await t("A9 学習の課題(弱点クラブ): チームIDで数える。同じ名前の別クラブを1つに合算しない・別クラブに追跡クラブの名前や「優先更新します」を付けない", async () => {
    const U0 = req("learning/clubUniverse.js");
    const portoJa = U0.findClub("Porto").nameJa; // 追跡クラブ(FC Porto)の日本語名
    const recs = [];
    // 本物の Porto(ID 212・このアプリの表記で記録): 6試合で5的中 / 同じ名前の別クラブ(ID 9999): 6試合で0的中
    for (let i = 0; i < 6; i++) recs.push({ resolved: true, correct: i < 5, homeTeamEn: "Porto", awayTeamEn: `Opp${i}`, homeTeamId: 212, awayTeamId: 7000 + i, originTeamEn: "Porto", official: true });
    for (let i = 0; i < 6; i++) recs.push({ resolved: true, correct: false, homeTeamEn: "Porto", awayTeamEn: `Other${i}`, homeTeamId: 9999, awayTeamId: 8000 + i, originTeamEn: `Other${i}`, official: true });
    const out = AG.buildLearningAgenda(recs, [], { nowIso: "2026-11-14T00:00:00Z" });
    const clubs = out.items.filter((it) => it.kind === "club");
    // 合算(12試合で5的中=全体と同じ41.7%)すると弱点が1つも出ない。IDで分ければ、0/6 の別クラブだけが弱点に挙がる
    assert.strictEqual(clubs.length, 1, "弱点クラブ: " + JSON.stringify(clubs));
    assert.ok(/直近6試合の的中率が0%/.test(clubs[0].reasonJa), clubs[0].reasonJa);
    assert.ok(!JSON.stringify(clubs[0]).includes(portoJa), "同じ名前の別クラブの成績を「" + portoJa + "」として表示している");
    assert.strictEqual(clubs[0].tracked, false);
    assert.ok(!/優先更新します/.test(clubs[0].actionJa) && /追跡名簿の外/.test(clubs[0].actionJa), "追跡していないクラブに「優先更新します」と書いている: " + clubs[0].actionJa);
    // 同じ名前の追跡クラブ(FC Porto)を、別クラブの代わりに翌日の優先クラブにしない
    assert.deepStrictEqual(AG.priorityClubsOf(out), [], "別クラブの不振を理由に、同じ名前の追跡クラブを優先している");
    // 追跡クラブ自身が弱点のとき: 日本語名つき・「優先更新します」・翌日の優先クラブに入る
    const recs2 = [];
    for (let i = 0; i < 6; i++) recs2.push({ resolved: true, correct: false, homeTeamEn: "Porto", awayTeamEn: `Opp${i}`, homeTeamId: 212, awayTeamId: 7000 + i, originTeamEn: "Porto", official: true });
    for (let i = 0; i < 12; i++) recs2.push({ resolved: true, correct: true, homeTeamEn: `X${i}`, awayTeamEn: `Y${i}`, homeTeamId: 100 + i, awayTeamId: 200 + i, originTeamEn: `X${i}`, official: true });
    const out2 = AG.buildLearningAgenda(recs2, [], { nowIso: "2026-11-14T00:00:00Z" });
    const c2 = out2.items.filter((it) => it.kind === "club");
    assert.deepStrictEqual([c2[0].targetEn, c2[0].targetJa, c2[0].tracked], ["Porto", portoJa, true]);
    assert.ok(/優先更新します/.test(c2[0].actionJa));
    assert.deepStrictEqual(AG.priorityClubsOf(out2), ["Porto"]);
    // 旧い形式の計画(tracked の旗なし)でも、名簿に無い名前は優先クラブにしない
    assert.deepStrictEqual(AG.priorityClubsOf({ items: [{ kind: "club", targetEn: "Real Madrid" }, { kind: "club", targetEn: "Nowhere United" }] }), ["Real Madrid"]);
  });

  // =====================================================================================
  // B. チームの照合・女子/年代別の判定
  // =====================================================================================
  console.log("■ B チームの照合・女子/年代別の判定");
  const U = req("learning/clubUniverse.js");
  const row = (id, name, country) => ({ team: { id, name, country: country || null } });

  await t("B1 検索結果の先頭を無条件に採用しない: 「Como」の検索が「Comoros」(代表)しか返さなければ採用しない。名前の証拠があるチームだけを選ぶ", async () => {
    const como = U.findClub("Como");
    assert.strictEqual(U.pickBestTeamMatch([row(1530, "Comoros", "Comoros")], como), null, "コモロ代表をコモとして採用している");
    assert.strictEqual(U.pickBestTeamMatch([row(1530, "Comoros", "Comoros"), row(895, "Como", "Italy")], como).team.id, 895);
    // 創設年つきの表記は同じクラブ(数字だけの語は区別に使わない)
    const basel = U.findClub("Basel");
    assert.strictEqual(U.pickBestTeamMatch([row(1, "FC Basel 1893", "Switzerland")], basel).team.id, 1);
    // 完全一致が2つあるときは国で選ぶ(ポルトガルの FC Porto と、ブラジルの「Porto」)
    const porto = U.findClub("Porto");
    assert.strictEqual(U.pickBestTeamMatch([row(9999, "Porto", "Brazil"), row(212, "FC Porto", "Portugal")], porto).team.id, 212);
    // 女子・2軍・ユースだけなら採用しない
    assert.strictEqual(U.pickBestTeamMatch([row(5, "Porto B", "Portugal"), row(6, "FC Porto W", "Portugal"), row(7, "Porto U23", "Portugal")], porto), null);
    // 国が違い、名前の証拠も弱い(短縮形)チームは採用しない
    const brest = { nameEn: "Brest", nameJa: "ブレスト", country: "フランス" };
    assert.strictEqual(U.pickBestTeamMatch([row(50, "Dinamo Brest", "Belarus")], brest), null);
    assert.strictEqual(U.pickBestTeamMatch([row(51, "Stade Brestois 29", "France"), row(50, "Dinamo Brest", "Belarus")], { ...brest, searchAs: "Stade Brestois 29" }).team.id, 51);
    // 過去に取り違えと判定したIDは二度と採用しない
    assert.strictEqual(U.pickBestTeamMatch([row(212, "FC Porto", "Portugal")], porto, { rejectTeamIds: [212] }), null);
  });

  await t("B2 女子の大会・女子チーム・年代別チームの判定(本番 11/14 に一覧へ出ていた WE League・Frauen Bundesliga・U21/U23 を含む)", async () => {
    for (const n of ["WE League", "Frauen Bundesliga", "FA WSL", "NWSL Women", "Nadeshiko League 1", "Division 1 Féminine", "Liga MX Femenil", "W-League", "Damallsvenskan", "Liga F", "D1 Arkema"]) assert.strictEqual(U.womensCompetitionName(n), true, "女子の大会と判定できない: " + n);
    for (const n of ["Premier League", "Bundesliga", "J1 League", "Ligue 1", "Liga Profesional Argentina", "Championship", "Serie A", "La Liga", "2. Bundesliga", "Liga II", "Eredivisie"]) assert.strictEqual(U.womensCompetitionName(n), false, "男子の大会を女子と判定: " + n);
    for (const n of ["Urawa (W)", "Arsenal W", "Bayern Frauen", "Roma Femminile", "Lyon Féminin", "Ajax Vrouwen", "Chelsea Women", "INAC神戸レオネッサ 女子"]) assert.strictEqual(U.looksWomensTeamName(n), true, "女子チームと判定できない: " + n);
    for (const n of ["Arsenal", "West Ham", "Wolves", "Werder Bremen", "Kawasaki Frontale", "Bayern München", "W Connection"]) assert.strictEqual(U.looksWomensTeamName(n), false, "男子チームを女子と判定: " + n);
    for (const n of ["England U21", "Japan U23", "Orlando Pirates U23", "Benfica U-19", "Santos Sub-20", "Inter Primavera", "Real Madrid Juvenil"]) assert.strictEqual(U.looksYouthTeamName(n), true, "年代別と判定できない: " + n);
    for (const n of ["Schalke 04", "Hannover 96", "Real Madrid", "Porto B", "Jong Ajax", "1860 München", "Union Berlin"]) assert.strictEqual(U.looksYouthTeamName(n), false, "トップチームを年代別と判定: " + n);
  });

  // =====================================================================================
  // C. 会話の道具
  // =====================================================================================
  console.log("■ C 会話の道具");
  const DT = req("discuss/tools.js");
  await t("C1 クラブで絞るときは部分一致にしない: 「Roma」で Romania、「Inter」で Inter Miami、「Como」で Comoros の試合を混ぜない。IDが分かればIDだけで判定", async () => {
    assert.strictEqual(typeof DT.involvesTeam, "function", "involvesTeam が無い(部分一致のまま)");
    const roma = { labelEn: "AS Roma", labelJa: "ローマ", teamId: 497 };
    assert.strictEqual(DT.involvesTeam({ homeName: "Romania", awayName: "Kosovo", homeId: 774, awayId: 1111 }, roma, "ローマ"), false);
    assert.strictEqual(DT.involvesTeam({ homeName: "AS Roma", awayName: "Lazio", homeId: 497, awayId: 487 }, roma, "ローマ"), true);
    // 名前は同じでもIDが違えば別クラブ(両チームのIDが分かるとき)
    assert.strictEqual(DT.involvesTeam({ homeName: "AS Roma", awayName: "X", homeId: 99497, awayId: 5 }, roma, "ローマ"), false);
    // このアプリの表記で作った側(originName)は名前で一致してよい
    assert.strictEqual(DT.involvesTeam({ homeName: "Roma", awayName: "X", originName: "AS Roma" }, roma, "ローマ"), true);
    const inter = { labelEn: "Inter", labelJa: "インテル", teamId: null };
    assert.strictEqual(DT.involvesTeam({ homeName: "Inter Miami", awayName: "Orlando City" }, inter, "Inter"), false);
    assert.strictEqual(DT.involvesTeam({ homeName: "FC Inter", awayName: "Orlando City" }, inter, "Inter"), true, "FC/AC などの接頭辞の差は無視");
    // クラブを特定できなかったとき: 渡された名前との完全一致だけ
    assert.strictEqual(DT.involvesTeam({ homeName: "Comoros", awayName: "Ghana" }, null, "Como"), false);
    assert.strictEqual(DT.involvesTeam({ homeName: "Como", awayName: "Parma" }, null, "como"), true);
    assert.strictEqual(DT.involvesTeam({ homeName: "Como", awayName: "Parma" }, null, ""), false);
    assert.strictEqual(DT.sameClubName("Bayern München", "Bayern Munchen"), true); assert.strictEqual(DT.sameClubName("Porto", "Porto B"), false);
  });

  await t("C2 道具の結果は上限(6,000文字)に収め、必ず JSON として読める形で渡す(途中で切らない)。省いた件数を書き添える", async () => {
    const big = { ok: true, data: { head: "先頭の要約", list: Array.from({ length: 80 }, (_, i) => ({ id: i, text: "あ".repeat(120) })), tail: { rankCounts: { S: 1, A: 2 } } }, sourceJa: "出どころ" };
    const s = DT.truncateJson(big);
    assert.ok(s.length <= DT.MAX_RESULT_CHARS, "上限を超えている: " + s.length);
    let parsed = null;
    assert.doesNotThrow(() => { parsed = JSON.parse(s); }, "途中で切れて JSON として読めない");
    assert.strictEqual(parsed.data.head, "先頭の要約"); assert.deepStrictEqual(parsed.data.tail, { rankCounts: { S: 1, A: 2 } }, "末尾の要約が落ちている");
    assert.ok(parsed.data.list.length < 80 && parsed.data.list.length > 5);
    assert.ok(/\d+件/.test(JSON.stringify(parsed).match(/"omittedForLengthJa":"[^"]*"/)[0]), "省いた件数が書かれていない");
    // 小さい結果はそのまま
    assert.strictEqual(DT.truncateJson({ ok: true, a: 1 }), JSON.stringify({ ok: true, a: 1 }));
    // 一覧用の予想1件は小さく(値の無い項目・1件ごとに繰り返す文を省く)。詳細用はそのまま
    const entry = { fixtureId: 1, kickoff: "2026-11-15T12:00:00Z", status: "NS", league: "Serie A", home: { name: "A" }, away: { name: "B" }, predictedWinner: "home", probs: { homeWinPct: 60, drawPct: 22, awayWinPct: 18 },
      confidence: { displayPct: 60, calibrated: true, method: "bin" }, tier: { rank: "A", labelJa: "有力", record: { n: 120, hits: 76, hitPct: 63.3, basisJa: "当てはめた実測" } }, content: { over25Pct: 55, calibrationNoteJa: "長い注記".repeat(20) }, resolved: false };
    const listed = DT.compactPredictionEntry(entry, { list: true }), full = DT.compactPredictionEntry(entry, { full: true });
    assert.ok(!("rankRecordJa" in listed) && !("score" in listed) && !("resolved" in listed) && !("calibrationNoteJa" in listed.content));
    assert.ok(/120件中76件的中\(63\.3%\)/.test(full.rankRecordJa));
    assert.ok(JSON.stringify(listed).length < JSON.stringify(full).length * 0.7, `一覧用が小さくなっていない: ${JSON.stringify(listed).length} / ${JSON.stringify(full).length}`);
  });

  // =====================================================================================
  // E. 学習の履歴の日付
  // =====================================================================================
  console.log("■ E 学習の履歴の日付");
  await t("E1 モデル調整の履歴は、学習の「今日」(日本時間の日付)で記録する(日本時間の早朝=UTCでは前日、に動いても1日ずれない)", async () => {
    const src = fs.readFileSync(path.join(ROOT, "learning/modelTuning.js"), "utf8");
    assert.ok(/async function tuneModelOnHistory\(deps, currentWeights, runAt, opts\)/.test(src), "dateKey を受け取る引数が無い");
    assert.ok(/const recordDateKey = \(opts && typeof opts\.dateKey === "string" && \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(opts\.dateKey\)\) \? opts\.dateKey : runAt\.toISOString\(\)\.slice\(0, 10\);/.test(src), "記録の日付を dateKey から決めていない");
    assert.ok(/\n\s+date: recordDateKey,/.test(src) && !/\n\s+date: runAt\.toISOString\(\)\.slice\(0, 10\),/.test(src), "履歴の date が UTC の日付のまま");
    const dj = fs.readFileSync(path.join(ROOT, "learning/dailyJob.js"), "utf8");
    assert.ok(/tuneModelOnHistory\([^)]*\{ dateKey \}\)/.test(dj) || /tuneModelOnHistory\([\s\S]{0,200}?dateKey/.test(dj), "毎日の学習が dateKey を渡していない");
    // 実際に動かす: 履歴が足りない(=調整しない)場合でも、返る記録の日付は渡した日付
    const MT = req("learning/modelTuning.js");
    const st = fakeStore();
    const runAt = new Date("2026-11-14T19:17:00Z"); // 日本時間では 11/15 04:17
    const out = await MT.tuneModelOnHistory({ upstashEnabled: true, upstashCmd: st.cmd, upstashGetJSON: st.getJSON, upstashSetJSON: st.setJSON, callApiFootball: async () => ({ response: [] }) }, { version: 1 }, runAt, { dateKey: "2026-11-15" }).catch((e) => ({ threw: String(e && e.message) }));
    const dates = JSON.stringify(out).match(/"date":"(\d{4}-\d{2}-\d{2})"/g) || [];
    for (const d of dates) assert.ok(d.includes("2026-11-15"), "UTC の日付(11/14)で記録している: " + d);
  });

  // =====================================================================================
  // F. 画面(index.html)
  // =====================================================================================
  console.log("■ F 画面(index.html)");
  const HTML_PATH = path.join(ROOT, "index.html");
  const HTML = fs.readFileSync(HTML_PATH, "utf8");
  /** 画面本体のスクリプトを、見せかけの画面(DOM)の上で実際に動かし、指定した関数を取り出す */
  function loadPageFunctions(names) {
    const inline = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(HTML)) !== null) inline.push(m[1]);
    let code = inline.reduce((a, b) => (b.length >= a.length ? b : a), "");
    code += `\nreturn { ${names.join(", ")} };`;
    const makeEl = (id) => ({ id, innerHTML: "", textContent: "", value: "", style: {}, children: [], dataset: {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
      setAttribute() {}, getAttribute() { return null; }, appendChild() {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, scrollTop: 0, scrollHeight: 0, scrollIntoView() {}, click() {}, focus() {} });
    const documentStub = { getElementById: (id) => makeEl(id), documentElement: makeEl("html"), body: makeEl("body"), querySelectorAll: () => [], querySelector: () => makeEl("stub"), addEventListener() {}, createElement: () => makeEl("new") };
    const windowStub = { navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {}, addEventListener() {}, appLang: "ja" };
    // eslint-disable-next-line no-new-func
    return new Function("document", "window", "navigator", "fetch", code)(documentStub, windowStub, windowStub.navigator, async () => { throw new Error("no network"); });
  }

  await t("F1 空白のない長い文字列(技術的な記録・URL など)がスマホの画面幅をはみ出さない: ページ全体に折り返しの指定があり、記録の一覧は途中でも折り返す", async () => {
    const bodyCss = (HTML.match(/\n {2}body \{[\s\S]*?\n {2}\}/) || [""])[0];
    assert.ok(/overflow-wrap:\s*break-word;/.test(bodyCss), "body に overflow-wrap が無い: " + bodyCss.slice(0, 200));
    // 「記録された内容を見る」の一覧(失敗の記録そのまま=空白の無い長い文字列が入る)
    const i = HTML.indexOf("記録された内容を見る</summary>");
    assert.ok(i > 0);
    assert.ok(/<ul style="[^"]*overflow-wrap:anywhere;[^"]*">/.test(HTML.slice(i, i + 400)), "記録の一覧に、途中で折り返す指定が無い");
  });

  await t("F2 日次レポートの「重みの変更が予測に与えた影響」: 画面が読む項目名は、学習が保存する記録に実在する名前だけ(以前は存在しない項目を読み、記録が一度も表示されなかった)", async () => {
    // 作る側①: 学習(dailyJob)が learn:weights:impact へ保存する記録の項目名
    const dj = fs.readFileSync(path.join(ROOT, "learning/dailyJob.js"), "utf8");
    const pi = dj.indexOf('await upstashCmd(["RPUSH", "learn:weights:impact", JSON.stringify({');
    assert.ok(pi > 0, "学習側の保存処理が見つからない");
    const lit = dj.slice(pi, dj.indexOf("})]);", pi));
    const recordKeys = new Set([...lit.matchAll(/(?:^|[\s,{])([a-zA-Z_]+):/g)].map((m) => m[1]));
    for (const k of ["date", "weightsVersionFrom", "weightsVersionTo", "shift"]) assert.ok(recordKeys.has(k), "学習側の記録に無い: " + k + " / " + [...recordKeys].join(","));
    // 作る側②: shift の中身(本物の計算結果)
    const { computePredictionShift } = req("learning/predictionShift.js");
    const { EXTENDED_DEFAULT_WEIGHTS } = req("learning/predictionModel.js");
    const oldW = { ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02 };
    const shift = computePredictionShift([{ features: { formDiff: 2 }, homeTeamEn: "A", awayTeamEn: "B" }, { features: { formDiff: 1.5 }, homeTeamEn: "C", awayTeamEn: "D" }], oldW, { ...oldW, sensitivity: 0.5 });
    assert.ok(shift && Number.isFinite(shift.homeWinPctDelta));
    // 使う側: 画面の該当ブロックが読む項目名
    const bi = HTML.indexOf("const wi = data.weightsImpact;");
    const block = HTML.slice(bi, HTML.indexOf("const mt = data.modelTuning;", bi));
    assert.ok(block.length > 300);
    const shReads = [...new Set([...block.matchAll(/\bsh\.([a-zA-Z_]+)/g)].map((m) => m[1]))];
    const itReads = [...new Set([...block.matchAll(/\bit\.([a-zA-Z_]+)/g)].map((m) => m[1]))];
    const wiReads = [...new Set([...block.matchAll(/\bwi\.([a-zA-Z_]+)/g)].map((m) => m[1]))];
    assert.ok(shReads.length >= 5, "shift の項目を読んでいない: " + shReads.join(","));
    for (const k of shReads) assert.ok(k in shift, `画面が読む shift.${k} は、本物の計算結果に無い(あるのは: ${Object.keys(shift).join(", ")})`);
    for (const k of itReads) assert.ok(recordKeys.has(k), `画面が読む items[].${k} は、学習が保存する記録に無い`);
    // サーバーが返す形: { available, items, noteJa }(server.js の日次レポート)
    const sv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    for (const k of wiReads) assert.ok(new RegExp(`\\b${k}:`).test(sv.slice(sv.indexOf('upstashCmd(["LRANGE", "learn:weights:impact"'), sv.indexOf('upstashCmd(["LRANGE", "learn:weights:impact"') + 900)) || k === "items" || k === "reasonJa", `画面が読む weightsImpact.${k} を、サーバーは返していない`);
    assert.ok(!/wi\.changes/.test(block), "存在しない項目(changes)を読んでいる");
  });

  await t("F3 試合カードの「AIが持つ知識」: 追跡対象外の理由ごとに正しい文を出す。「取り込み候補に登録しました」と言うのは、本当に候補になるクラブだけ", async () => {
    const P = loadPageFunctions(["buildKnowledgeSideHtml"]);
    assert.strictEqual(typeof P.buildKnowledgeSideHtml, "function");
    // 本物の部品(teamKnowledge)が返す形を、そのまま画面の関数に渡す
    const tk = makeTK({ teammap: TEAMMAP, adopted: { 3003: { nameEn: "Al-Ahli", adoptedAt: "2026-11-03" } }, dossiers: { Porto: dossierOf(212) } });
    const k1 = await tk.knowledgeForFixture({ id: 9999, name: "Porto" }, { id: 5001, name: "Tokyo Verdy U23" });
    const k2 = await tk.knowledgeForFixture({ id: 6001, name: "Sagan Tosu" }, { id: 3003, name: "Al-Ahli" });
    const sameName = P.buildKnowledgeSideHtml("Porto", k1.home, { indexUnavailable: k1.indexUnavailable });
    const secondary = P.buildKnowledgeSideHtml("Tokyo Verdy U23", k1.away, { indexUnavailable: k1.indexUnavailable });
    const untracked = P.buildKnowledgeSideHtml("Sagan Tosu", k2.home, { indexUnavailable: k2.indexUnavailable });
    const importing = P.buildKnowledgeSideHtml("Al-Ahli", k2.away, { indexUnavailable: k2.indexUnavailable });
    assert.ok(/別のクラブと同じ名前のチームのため/.test(sameName) && !/取り込み候補に登録しました/.test(sameName), sameName);
    assert.ok(/2軍・女子・ユースのチームは収集の対象外/.test(secondary) && !/取り込み候補に登録しました/.test(secondary), secondary);
    assert.ok(/取り込み候補に登録しました/.test(untracked), untracked);
    assert.ok(/まだ取り込み中です/.test(importing), importing);
    // 選手索引を読み出せなかったとき(追跡中クラブ): 「取り込み中」ではなく「読み出せませんでした」
    const tkNull = makeTK({ teammap: TEAMMAP, dossiers: { Porto: dossierOf(212) }, playersNull: true });
    const k3 = await tkNull.knowledgeForFixture({ id: 212, name: "FC Porto" }, { id: 6001, name: "Sagan Tosu" });
    const unreadable = P.buildKnowledgeSideHtml("FC Porto", k3.home, { indexUnavailable: k3.indexUnavailable });
    assert.ok(/保存先から選手データを読み出せませんでした/.test(unreadable) && !/まだ取り込み中です/.test(unreadable), unreadable);
    // 通常(追跡中・選手あり): 主力の平均評価点が出る
    const tkOk = makeTK({ teammap: TEAMMAP, dossiers: { Porto: dossierOf(212) } });
    const k4 = await tkOk.knowledgeForFixture({ id: 212, name: "FC Porto" }, { id: 6001, name: "Sagan Tosu" });
    assert.ok(/主力の平均評価点/.test(P.buildKnowledgeSideHtml("FC Porto", k4.home, { indexUnavailable: k4.indexUnavailable })));
    // 4言語: 新しい文は辞書にある(英語・中国語・スペイン語の3つとも空でない)
    for (const ja of ["2軍・女子・ユースのチームは収集の対象外のため、選手データはありません(このAIは男子のトップチームを対象にしています)。", "AIが追跡している別のクラブと同じ名前のチームのため、選手データは表示しません(別のクラブの情報を混ぜないための措置です)。", "保存先から選手データを読み出せませんでした(1分ほど待って開き直してください)。", "近い自信帯の実測", "重みの更新ごとの変化(新しい順・平均)", "対象の試合数"]) {
      const m = HTML.match(new RegExp(`"${ja.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*\\[("(?:[^"\\\\]|\\\\.)*"),\\s*("(?:[^"\\\\]|\\\\.)*"),\\s*("(?:[^"\\\\]|\\\\.)*")\\]`));
      assert.ok(m, "辞書に無い: " + ja);
      for (let i = 1; i <= 3; i++) assert.ok(JSON.parse(m[i]).trim().length > 0, "訳が空: " + ja);
    }
  });

  await t("F4 会話: 「今日の試合」の質問をサーバーのAIへ渡す配線(固定の「おすすめカード」で答えて終わらせない)", async () => {
    const hi = HTML.indexOf("async function heroAskAI(question)");
    const fn = HTML.slice(hi, HTML.indexOf("\n}\n", HTML.indexOf("記憶は付加機能。即答の表示に影響させない", hi)));
    const bi = fn.indexOf("} else if (matchIntent) {");
    assert.ok(bi > 0, "matchIntent の分岐が無い");
    const branch = fn.slice(bi, fn.indexOf("} else {", bi + 10));
    assert.ok(/await runDiscussFlow\(q, dLevel, null, \(msg\) => heroChatHistory\.push\(msg\), renderHeroChatUI, undefined, "hero"\);\s*\n\s*return;/.test(branch), "matchIntent の質問を runDiscussFlow に渡していない: " + branch.slice(0, 300));
    const codeOnly = fn.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // 説明のコメント行は除く
    assert.ok(!/getDailyFeaturedMatchup\(\)/.test(branch) && !/具体的な対戦カードが分からなかった/.test(codeOnly), "固定の「おすすめカード」で答える旧処理が残っている");
  });

  // ---------------------------------------------------------------------------
  // G: 総点検・第2回(11月14日 夜) — 画面が持つクラブの対応表と、質問文からのクラブの読み取り
  // ---------------------------------------------------------------------------
  const vmG = require("vm");
  const pageMapOf = (name) => {
    const st = HTML.indexOf(`\nconst ${name} = {`);
    assert.ok(st >= 0, name + " が index.html に無い");
    const en = HTML.indexOf("\n};", st);
    const sb = {}; vmG.createContext(sb);
    vmG.runInContext(HTML.slice(st + 1, en + 3).replace(`const ${name}`, `var ${name}`), sb);
    return sb[name];
  };
  await t("G1 画面のクラブ対応表は、サーバーの対象クラブ(172)と1件ずつ同じ(以前は100クラブのまま残り、「推しクラブ」でJ1の全クラブなど72クラブを選べなかった)", () => {
    const U = require(path.join(ROOT, "learning/clubUniverse.js")).CLUB_UNIVERSE;
    const page = pageMapOf("UNIVERSE_CLUB_JA_TO_EN");
    const missing = U.filter((c) => page[c.nameJa] !== c.nameEn).map((c) => `${c.rank}:${c.nameJa}`);
    assert.deepStrictEqual(missing, [], `画面の対応表に無い/英語名が違うクラブ: ${missing.length} 件 ` + missing.slice(0, 8).join(" "));
    const extra = Object.keys(page).filter((ja) => !U.some((c) => c.nameJa === ja));
    assert.deepStrictEqual(extra, [], "サーバーに無いクラブが画面の対応表にある: " + extra.join(" "));
    assert.strictEqual(Object.keys(page).length, U.length);
    // 画面の文言(予測対象◯クラブ)と件数が合っている
    const label = /クラブを選ぶ\(予測対象(\d+)クラブ\)…<\/option>/.exec(HTML);
    assert.ok(label && Number(label[1]) === U.length, "「推しクラブ」の選択肢の見出しの件数が対応表と合っていない: " + (label && label[1]));
    for (const ja of ["鹿島アントラーズ", "浦和レッズ", "川崎フロンターレ", "エヴァートン", "ル・マン"]) assert.ok(page[ja], ja + " が選べない");
  });
  await t("G2 質問文からのクラブの読み取り: 別の語の一部(サンフレッチェ⊃レッチェ・コモン・パルマー・アンジェ・ポステコグルー・モナコグランプリ・ブレストする)をクラブと決めつけない。クラブ名そのものは読み取る", () => {
    const a = HTML.indexOf("const CLUB_NAME_SUFFIX_RE");
    assert.ok(a >= 0, "clubNameAppearsIn が無い");
    const b = HTML.indexOf("\n}\n", HTML.indexOf("function clubNameAppearsIn")) + 3;
    const sb = {}; vmG.createContext(sb);
    vmG.runInContext(HTML.slice(a, b).replace("const CLUB_NAME_SUFFIX_RE", "var CLUB_NAME_SUFFIX_RE"), sb);
    const page = pageMapOf("UNIVERSE_CLUB_JA_TO_EN");
    const hit = (q) => Object.keys(page).filter((ja) => sb.clubNameAppearsIn(q, ja)).sort((x, y) => y.length - x.length)[0] || null;
    // 画面の読み取りが実際にこの関数を使っている
    assert.ok(/\.filter\(\(ja\) => q && clubNameAppearsIn\(q, ja\)\)/.test(HTML), "universeHit が clubNameAppearsIn を使っていない");
    const none = ["サンフレッチェの調子は?", "コモンセンスで考えて", "パルマーは良い選手?", "アンジェ・ポステコグルー監督はどう?", "アンジェリーノの移籍", "モナコグランプリはいつ?", "ブレストしたい", "アイデアをブレストして", "ニュースを教えて"];
    for (const q of none) assert.strictEqual(hit(q), null, `「${q}」をクラブ(${hit(q)})と決めつけた`);
    const some = [["鹿島アントラーズの調子は?", "鹿島アントラーズ"], ["サンフレッチェ広島は強い?", "サンフレッチェ広島"], ["コモの監督は誰?", "コモ"], ["パルマは昇格組?", "パルマ"], ["アンジェの順位は?", "アンジェ"],
      ["ブレストは強い?", "ブレスト"], ["モナコの注目選手", "モナコ"], ["ナポリファンです。今季はどう?", "ナポリ"], ["リヴァプール戦の展望", "リヴァプール"], ["川崎フロンターレ対浦和レッズ", "川崎フロンターレ"],
      ["FC東京の次の試合", "FC東京"], ["エヴァートンは残留できる?", "エヴァートン"], ["レアル・マドリードの現状", "レアル・マドリード"], ["パリ・サンジェルマンは?", "パリ・サンジェルマン"]];
    for (const [q, exp] of some) assert.strictEqual(hit(q), exp, `「${q}」`);
    // 以前から読み取れていた100クラブは、名前そのものを書けば今も全部読み取れる(劣化なし)
    const U = require(path.join(ROOT, "learning/clubUniverse.js")).CLUB_UNIVERSE;
    for (const c of U) {
      for (const q of [`${c.nameJa}の調子は?`, `今日の${c.nameJa}はどう?`, `${c.nameJa}`]) {
        const got = hit(q);
        assert.ok(got === c.nameJa || (got && got.includes(c.nameJa)), `「${q}」→ ${got}`);
      }
    }
  });

  console.log(`\nv104.1 audit (parts): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
