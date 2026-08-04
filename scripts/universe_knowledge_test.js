/**
 * scripts/universe_knowledge_test.js
 * ------------------------------------------------
 * 2026年8月・知識拡張フェーズ(UEFA TOP100)のテスト。
 * 「実装しました」ではなく「実際に動く」ことを、モックAPIで収集ロジックを
 * 本当に実行して証明する(ご指示⑥)。
 *
 *  A. clubUniverse.js   … TOP100の定義と更新輪番(毎日/2日/7日/28日)の正しさ
 *  B. clubDossier.js    … 調査ファイルの保存・差分検出・でっち上げ防止
 *  C. universeCollector … 収集エンジンが実際にAPI応答→保存→差分→学習へ流すか
 *  D. フロントエンド     … index.htmlの対応表がclubUniverse.jsと一致しているか
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  CLUB_UNIVERSE, TIER_A_MAX_RANK, tierOf, clubsForCoreUpdate,
  clubsForSquadSync, clubsForXgUpdate, clubsForBasicInfo, findClub,
  dayNumberOf, UEFA_SNAPSHOT_NOTE_JA,
} = require("../server/learning/clubUniverse");
const { createClubDossier, UNAVAILABLE_FIELDS_JA, slugOf } = require("../server/knowledge/clubDossier");
const { collectUniverse, BUDGET_FLOOR, seasonOf } = require("../server/learning/universeCollector");

let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); });
}

// ============================================================
// 共通モック: メモリ上のUpstash(実際の保存・読み出しを再現)
// ============================================================
function createMemoryUpstash() {
  const store = new Map();
  const lists = new Map();
  const upstashCmd = async (cmd) => {
    const [op, key, ...rest] = cmd;
    if (op === "LRANGE") return (lists.get(key) || []).slice();
    if (op === "RPUSH") { const l = lists.get(key) || []; l.push(rest[0]); lists.set(key, l); return l.length; }
    if (op === "INCR") { const v = (Number(store.get(key)) || 0) + 1; store.set(key, String(v)); return v; }
    if (op === "GET") return store.has(key) ? store.get(key) : null;
    return null;
  };
  const upstashGetJSON = async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null);
  const upstashSetJSON = async (key, obj) => { store.set(key, JSON.stringify(obj)); return true; };
  return { store, lists, upstashCmd, upstashGetJSON, upstashSetJSON };
}
function newDossier() {
  const up = createMemoryUpstash();
  return { up, dossier: createClubDossier({ upstashEnabled: true, ...up }) };
}

// dailyJob.js の computeFormScore と同じ計算(依存注入されるものをテスト内に再現)
function computeFormScore(fixtures, teamId) {
  const withDiff = [...(fixtures || [])]
    .filter((f) => f && f.fixture && f.fixture.date && f.goals && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .map((f) => {
      const isHome = f.teams && f.teams.home && f.teams.home.id === teamId;
      return (isHome ? f.goals.home : f.goals.away) - (isHome ? f.goals.away : f.goals.home);
    });
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100 : null);
  const last5 = avg(withDiff.slice(0, 5));
  const prev5 = avg(withDiff.slice(5, 10));
  return { currentFormScore: last5, delta: last5 !== null && prev5 !== null ? Math.round((last5 - prev5) * 100) / 100 : null, sampleSize: withDiff.length };
}

async function main() {
  console.log("=== A. clubUniverse.js: TOP100の定義と更新輪番 ===");

  await ok("A1: ちょうど100クラブ・順位1〜100が重複なく揃っている", () => {
    assert.strictEqual(CLUB_UNIVERSE.length, 100);
    const ranks = new Set(CLUB_UNIVERSE.map((c) => c.rank));
    assert.strictEqual(ranks.size, 100);
    assert.ok(CLUB_UNIVERSE.every((c) => c.rank >= 1 && c.rank <= 100));
  });

  await ok("A2: 全クラブに英語名・日本語名・国があり、名前の重複がない", () => {
    for (const c of CLUB_UNIVERSE) {
      assert.ok(c.nameEn && c.nameJa && c.country, `${c.rank}位の情報が欠けています`);
    }
    assert.strictEqual(new Set(CLUB_UNIVERSE.map((c) => c.nameEn)).size, 100, "英語名が重複");
    assert.strictEqual(new Set(CLUB_UNIVERSE.map((c) => c.nameJa)).size, 100, "日本語名が重複(フロント対応表が壊れる)");
  });

  await ok("A3: leagueIdは動作確認済みIDのみ(決め打ちのでっち上げをしない)", () => {
    const verified = new Set([39, 140, 78, 135, 61, 88, 94, 144, 203, 253]);
    for (const c of CLUB_UNIVERSE) {
      assert.ok(c.leagueId === null || verified.has(c.leagueId), `${c.nameEn}のleagueId=${c.leagueId}は未確認IDです`);
    }
  });

  await ok("A4: tier分け=1〜40位がA(毎日更新)・41位以下がB", () => {
    assert.strictEqual(TIER_A_MAX_RANK, 40);
    assert.strictEqual(tierOf({ rank: 40 }), "A");
    assert.strictEqual(tierOf({ rank: 41 }), "B");
  });

  await ok("A5: コア更新はtier A全部+tier Bの半分。2日間で全100クラブを必ず一巡", () => {
    const d1 = clubsForCoreUpdate("2026-08-04");
    const d2 = clubsForCoreUpdate("2026-08-05");
    const tierA = CLUB_UNIVERSE.filter((c) => tierOf(c) === "A");
    for (const a of tierA) {
      assert.ok(d1.includes(a) && d2.includes(a), `tier Aの${a.nameEn}が毎日更新されていません`);
    }
    const union = new Set([...d1, ...d2].map((c) => c.rank));
    assert.strictEqual(union.size, 100, "2日間で全クラブを網羅できていません");
  });

  await ok("A6: 選手名簿は7日間で全100クラブを一巡(1クラブは週1回だけ)", () => {
    const seen = new Map();
    for (let i = 0; i < 7; i++) {
      const dk = `2026-08-${String(4 + i).padStart(2, "0")}`;
      for (const c of clubsForSquadSync(dk)) seen.set(c.rank, (seen.get(c.rank) || 0) + 1);
    }
    assert.strictEqual(seen.size, 100, "7日間で全クラブを網羅できていません");
    for (const [rank, n] of seen) assert.strictEqual(n, 1, `${rank}位が週${n}回更新されています`);
  });

  await ok("A7: xGはtier Aのみ・7日間で全tier Aを一巡(高価なため)", () => {
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      const dk = `2026-08-${String(4 + i).padStart(2, "0")}`;
      for (const c of clubsForXgUpdate(dk)) {
        assert.strictEqual(tierOf(c), "A", `tier Bの${c.nameEn}がxG対象になっています`);
        seen.add(c.rank);
      }
    }
    assert.strictEqual(seen.size, 40, "7日間で全tier Aを網羅できていません");
  });

  await ok("A8: 基本情報は28日間で全100クラブを一巡", () => {
    const seen = new Set();
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 7, 1) + i * 86400000).toISOString().slice(0, 10);
      for (const c of clubsForBasicInfo(d)) seen.add(c.rank);
    }
    assert.strictEqual(seen.size, 100);
  });

  await ok("A9: 輪番は日付から決定的(乱数なし=再実行しても同じ結果)", () => {
    const a = clubsForSquadSync("2026-08-10").map((c) => c.rank).join(",");
    const b = clubsForSquadSync("2026-08-10").map((c) => c.rank).join(",");
    assert.strictEqual(a, b);
    assert.ok(Number.isFinite(dayNumberOf("2026-08-10")));
  });

  await ok("A10: findClubは大文字小文字を区別しない・未知クラブはnull", () => {
    assert.strictEqual(findClub("real madrid").rank, 1);
    assert.strictEqual(findClub("存在しないクラブ"), null);
  });

  await ok("A11: UEFAランクは静的スナップショットである旨を正直に注記している", () => {
    assert.ok(/スナップショット/.test(UEFA_SNAPSHOT_NOTE_JA));
    assert.ok(/API-Football/.test(UEFA_SNAPSHOT_NOTE_JA));
  });

  console.log("=== B. clubDossier.js: 調査ファイルの保存・差分検出 ===");

  await ok("B1: 初回保存は成功するが「変化」は出さない(初めて知った事実は差分ではない)", async () => {
    const { dossier } = newDossier();
    const r = await dossier.updateSection("Real Madrid", "coach", { coachName: "Xabi Alonso", formation: "4-3-3" },
      { nameJa: "レアル・マドリード", teamId: 541, uefaRankSnapshot: 1, tier: "A" });
    assert.strictEqual(r.saved, true);
    assert.deepStrictEqual(r.changesJa, []);
    const d = await dossier.getDossier("Real Madrid");
    assert.strictEqual(d.sections.coach.coachName, "Xabi Alonso");
    assert.ok(d.sections.coach.computedAt, "実測時刻computedAtが必須");
  });

  await ok("B2: 監督交代・布陣変更を実測値の比較から検出する", async () => {
    const { dossier } = newDossier();
    const meta = { nameJa: "チェルシー", teamId: 49 };
    await dossier.updateSection("Chelsea", "coach", { coachName: "A監督", formation: "4-2-3-1" }, meta);
    const r = await dossier.updateSection("Chelsea", "coach", { coachName: "B監督", formation: "3-4-3" }, meta);
    assert.ok(r.changesJa.some((c) => c.includes("監督が交代") && c.includes("A監督") && c.includes("B監督")));
    assert.ok(r.changesJa.some((c) => c.includes("布陣") && c.includes("4-2-3-1") && c.includes("3-4-3")));
    const d = await dossier.getDossier("Chelsea");
    assert.strictEqual(d.lastChangesJa.length, 2, "変化がlastChangesJaへ記録される");
  });

  await ok("B3: 怪我人数・順位・フォーム・名簿人数の差分(方向も正しい)", async () => {
    const { dossier } = newDossier();
    const meta = { nameJa: "アーセナル" };
    await dossier.updateSection("Arsenal", "injuries", { injuryCount: 2 }, meta);
    let r = await dossier.updateSection("Arsenal", "injuries", { injuryCount: 5 }, meta);
    assert.ok(r.changesJa.some((c) => c.includes("2人から5人") && c.includes("増え")));
    await dossier.updateSection("Arsenal", "standings", { position: 4 }, meta);
    r = await dossier.updateSection("Arsenal", "standings", { position: 2 }, meta);
    assert.ok(r.changesJa.some((c) => c.includes("4位から2位") && c.includes("上がり")), "順位が下がる数字=上がる、の向き");
    await dossier.updateSection("Arsenal", "form", { currentFormScore: 0.5 }, meta);
    r = await dossier.updateSection("Arsenal", "form", { currentFormScore: 0.6 }, meta);
    assert.strictEqual(r.changesJa.length, 0, "0.3未満の揺れはノイズとして変化にしない");
    r = await dossier.updateSection("Arsenal", "form", { currentFormScore: 1.0 }, meta);
    assert.ok(r.changesJa.some((c) => c.includes("上向き")));
    await dossier.updateSection("Arsenal", "squad", { players: [{ id: 1 }, { id: 2 }] }, meta);
    r = await dossier.updateSection("Arsenal", "squad", { players: [{ id: 1 }, { id: 2 }, { id: 3 }] }, meta);
    assert.ok(r.changesJa.some((c) => c.includes("2人から3人")));
  });

  await ok("B4: 取得不可の項目(市場価値・契約・利き足など)へ正直な理由を保持する", async () => {
    const { dossier } = newDossier();
    await dossier.updateSection("Porto", "basic", { founded: 1893 }, { nameJa: "FCポルト" });
    const d = await dossier.getDossier("Porto");
    assert.ok(/API-Football/.test(d.unavailableJa.marketValue));
    assert.ok(/API-Football/.test(d.unavailableJa.contractUntil));
    assert.ok(/API-Football/.test(d.unavailableJa.preferredFoot));
    assert.ok(/スナップショット/.test(UNAVAILABLE_FIELDS_JA.uefaRankLive));
  });

  await ok("B5: 選手保存=新規はカウント増、更新はカウント据え置き・初認識日を保持", async () => {
    const { up, dossier } = newDossier();
    const r1 = await dossier.savePlayer({ id: 874, name: "Ronaldo", teamEn: "Al-Nassr", position: "Attacker" });
    assert.strictEqual(r1.isNew, true);
    assert.strictEqual(Number(up.store.get("kb:player:count")), 1);
    const first = (await dossier.getPlayer(874)).firstSeenAt;
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await dossier.savePlayer({ id: 874, name: "Ronaldo", teamEn: "Al-Nassr", stats: { goals: 30 } });
    assert.strictEqual(r2.isNew, false);
    assert.strictEqual(Number(up.store.get("kb:player:count")), 1, "同じ選手で二重カウントしない");
    const rec = await dossier.getPlayer(874);
    assert.strictEqual(rec.firstSeenAt, first, "初認識日は上書きしない");
    assert.strictEqual(rec.stats.goals, 30);
  });

  await ok("B6: 蓄積状況サマリー=実際に保存された件数だけを返す", async () => {
    const { dossier } = newDossier();
    await dossier.updateSection("Ajax", "form", { currentFormScore: 0.2 }, { nameJa: "アヤックス" });
    await dossier.updateSection("Ajax", "injuries", { injuryCount: 1 }, { nameJa: "アヤックス" });
    await dossier.updateSection("Benfica", "form", { currentFormScore: 0.8 }, { nameJa: "ベンフィカ" });
    await dossier.savePlayer({ id: 1, name: "P1" });
    await dossier.savePlayer({ id: 2, name: "P2" });
    const s = await dossier.getCoverageSummary();
    assert.strictEqual(s.clubCount, 2);
    assert.strictEqual(s.playerCount, 2);
    assert.strictEqual(s.sectionCounts.form, 2);
    assert.strictEqual(s.sectionCounts.injuries, 1);
  });

  await ok("B7: 保存先が未設定なら正直に「保存できない」と返す(黙って成功を装わない)", async () => {
    const d = createClubDossier({ upstashEnabled: false });
    const r = await d.updateSection("Inter", "form", { currentFormScore: 1 }, {});
    assert.strictEqual(r.saved, false);
    const s = await d.getCoverageSummary();
    assert.strictEqual(s.available, false);
    assert.ok(s.reasonJa);
  });

  await ok("B8: 変化の記録は上限20件で古いものから消える(無限に太らない)", async () => {
    const { dossier } = newDossier();
    const meta = { nameJa: "ナポリ" };
    for (let i = 0; i <= 25; i++) {
      await dossier.updateSection("Napoli", "injuries", { injuryCount: i }, meta);
    }
    const d = await dossier.getDossier("Napoli");
    assert.strictEqual(d.lastChangesJa.length, 20);
    assert.ok(d.lastChangesJa[0].changeJa.includes("24人から25人"), "最新の変化が先頭");
  });

  await ok("B9: クラブ一覧(index)へ同じクラブを二重登録しない", async () => {
    const { up, dossier } = newDossier();
    await dossier.updateSection("Lille", "form", { currentFormScore: 0 }, { nameJa: "リール" });
    await dossier.updateSection("Lille", "injuries", { injuryCount: 0 }, { nameJa: "リール" });
    const list = up.lists.get("kb:club:index") || [];
    assert.deepStrictEqual(list, [slugOf("Lille")]);
  });

  console.log("=== C. universeCollector.js: 収集エンジンが実際に動く証明 ===");

  // ---- モックAPI-Football: 実際の応答形式でクラブごとに返す ----
  function makeMockApi(overrides) {
    const o = overrides || {};
    const calls = [];
    const teamIdOf = (name) => 1000 + [...String(name)].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const fx = (teamId, n) => Array.from({ length: n }, (_, i) => ({
      fixture: { id: teamId * 100 + i, date: new Date(Date.UTC(2026, 6, 28) - i * 4 * 86400000).toISOString(), status: { short: "FT" } },
      league: { id: 39 },
      teams: { home: { id: teamId, name: "Me" }, away: { id: 9999, name: `Opp${i}` } },
      goals: { home: 2, away: 1 },
    }));
    const callApiFootball = async (apiPath, params) => {
      calls.push({ apiPath, params });
      if (o.fail && o.fail(apiPath, params)) { const e = new Error("mock_fail"); e.code = o.failCode || "MOCK_FAIL"; throw e; }
      if (apiPath === "/teams") {
        const id = teamIdOf(params.search);
        return { response: [{ team: { id, name: params.search, founded: 1900, country: "X" }, venue: { name: "Stadium", city: "City", capacity: 50000 } }] };
      }
      if (apiPath === "/fixtures") return { response: fx(params.team, 10) };
      if (apiPath === "/injuries") {
        return { response: (o.injuries || [{ player: { name: "P One", reason: "Knee Injury" } }]) };
      }
      if (apiPath === "/fixtures/lineups") {
        const teamId = Math.floor(params.fixture / 100);
        return { response: [{ team: { id: teamId }, coach: { name: o.coachName || "Coach A" }, formation: o.formation || "4-3-3" }] };
      }
      if (apiPath === "/transfers") return { response: [] };
      if (apiPath === "/standings") {
        return { response: [{ league: { id: params.league, standings: [[]] } }] };
      }
      if (apiPath === "/players/squads") {
        const teamId = params.team;
        return { response: [{ players: [
          { id: teamId * 10 + 1, name: `Player ${teamId}-1`, age: 25, number: 7, position: "Attacker" },
          { id: teamId * 10 + 2, name: `Player ${teamId}-2`, age: 28, number: 4, position: "Defender" },
        ] }] };
      }
      if (apiPath === "/players") {
        return { response: [{
          player: { id: params.id, name: `Player ${params.id}`, nationality: "Japan", height: "180 cm", birth: { date: "2000-01-01" } },
          statistics: [{ games: { appearences: 20, minutes: 1500, rating: "7.25", position: "Attacker" },
            goals: { total: 10, assists: 5 }, shots: { total: 40, on: 20 },
            passes: { total: 500, key: 30, accuracy: 85 },
            dribbles: { attempts: 50, success: 30 }, tackles: { total: 10, blocks: 2, interceptions: 5 },
            duels: { total: 100, won: 60 } }],
        }] };
      }
      return { response: [] };
    };
    return { callApiFootball, calls };
  }

  function makeDeps(mockApi, up, extra) {
    const dossier = createClubDossier({ upstashEnabled: true, ...up });
    const learned = [];
    const timeline = [];
    return {
      deps: {
        callApiFootball: mockApi.callApiFootball,
        apiBudget: (extra && extra.apiBudget) || { remainingForJob: () => 999999 },
        clubDossier: dossier,
        knowledgeStore: null,
        knowledgeGraph: { addEdge: async (e) => { timeline.push({ kind: "edge", e }); } },
        thoughtTimeline: { append: async (key, ev) => { timeline.push({ kind: "timeline", key, ev }); } },
        computeFormScore,
        recordLearned: async (item, signals) => { learned.push({ item, signals }); },
      },
      dossier, learned, timeline,
    };
  }
  const RUN_AT = new Date("2026-08-04T00:10:00Z");

  let firstRunStats = null;
  let sharedUp = createMemoryUpstash();
  await ok("C1: 初回収集=計画した全クラブのコア情報が実際に保存される", async () => {
    const mock = makeMockApi();
    const { deps, dossier } = makeDeps(mock, sharedUp);
    firstRunStats = await collectUniverse(deps, RUN_AT, "2026-08-04");
    const planned = clubsForCoreUpdate("2026-08-04").length;
    assert.strictEqual(firstRunStats.coreClubsPlanned, planned);
    assert.strictEqual(firstRunStats.coreClubsUpdated, planned, `エラー: ${firstRunStats.errors.slice(0, 3).join(" / ")}`);
    const d = await dossier.getDossier("Real Madrid");
    assert.ok(d, "レアル・マドリードの調査ファイルが作られている");
    for (const sec of ["basic", "form", "injuries", "coach", "transfers"]) {
      assert.ok(d.sections[sec], `${sec}セクションが保存されている`);
      assert.ok(d.sections[sec].computedAt, `${sec}に実測時刻がある`);
    }
    assert.strictEqual(d.sections.form.currentFormScore, 1, "モック試合(毎試合2-1勝ち)から+1が実計算される");
    assert.strictEqual(d.sections.coach.coachName, "Coach A");
    assert.strictEqual(d.uefaRankSnapshot, 1);
    assert.strictEqual(d.tier, "A");
  });

  await ok("C2: 初回は「変化」を主張しない(でっち上げ防止)", () => {
    assert.strictEqual(firstRunStats.changesDetected.length, 0);
  });

  await ok("C3: 名簿は当日の輪番クラブのみ・選手が実際に保存され人数が数えられる", async () => {
    const squadPlanned = clubsForSquadSync("2026-08-04").length;
    assert.strictEqual(firstRunStats.squadsPlanned, squadPlanned);
    assert.strictEqual(firstRunStats.squadsUpdated, squadPlanned);
    assert.ok(firstRunStats.playersUpdated >= squadPlanned * 2, "名簿2人×クラブ+詳細成績の保存が行われている");
    assert.strictEqual(Number(sharedUp.store.get("kb:player:count")), squadPlanned * 2);
  });

  await ok("C4: 選手詳細=実スタッツ(出場・得点・パス成功率など)が保存される", async () => {
    const { dossier } = makeDeps(makeMockApi(), sharedUp);
    const club = clubsForSquadSync("2026-08-04")[0];
    const d = await dossier.getDossier(club.nameEn);
    const pid = d.sections.squad.players[0].id;
    const rec = await dossier.getPlayer(pid);
    assert.ok(rec.stats, "詳細成績が保存されている");
    assert.strictEqual(rec.stats.appearances, 20);
    assert.strictEqual(rec.stats.goals, 10);
    assert.strictEqual(rec.stats.passAccuracyPct, 85);
    assert.strictEqual(rec.nationality, "Japan");
    assert.ok(rec.statsUpdatedAt, "更新時刻がある(輪番の古い順選定に使う)");
    assert.ok(/API-Football/.test(rec.unavailableJa.marketValue), "取得不可項目の正直な注記");
  });

  await ok("C5: 2回目の収集=監督交代・怪我増を検出し、知識・時系列へ流れる", async () => {
    const mock = makeMockApi({ coachName: "Coach B", formation: "3-5-2",
      injuries: [{ player: { name: "P One", reason: "Knee Injury" } }, { player: { name: "P Two", reason: "Red Card Suspension" } }, { player: { name: "P Three", reason: "Hamstring" } }] });
    const { deps, learned, timeline, dossier } = makeDeps(mock, sharedUp);
    const stats2 = await collectUniverse(deps, new Date("2026-08-05T00:10:00Z"), "2026-08-05");
    assert.ok(stats2.changesDetected.some((c) => c.changeJa.includes("監督が交代")), "監督交代を検出");
    assert.ok(stats2.changesDetected.some((c) => c.changeJa.includes("1人から3人に増え")), "怪我・出場停止の増加を検出");
    assert.ok(learned.some((l) => l.item.category === "coachChange" && l.item.statement.includes("監督が交代")), "知識(recordLearned)へ流れる");
    assert.ok(learned.every((l) => l.item.source && l.item.source.includes("実データ")), "出所を明記");
    assert.ok(timeline.some((t) => t.kind === "timeline" && t.ev.kind === "trigger" && t.ev.statementJa.includes("監督が交代")), "考えが変わったきっかけとして時系列へ");
    const d = await dossier.getDossier("Real Madrid");
    assert.strictEqual(d.sections.coach.coachName, "Coach B");
    assert.ok(d.sections.injuries.suspendedPlayers.includes("P Two"), "出場停止を負傷と区別");
  });

  await ok("C6: APIが一部失敗しても、失敗したセクションだけ前回の実測値を保持する", async () => {
    const mock = makeMockApi({ fail: (p) => p === "/injuries" });
    const { deps, dossier } = makeDeps(mock, sharedUp);
    const before = (await dossier.getDossier("Real Madrid")).sections.injuries;
    const stats3 = await collectUniverse(deps, new Date("2026-08-06T00:10:00Z"), "2026-08-06");
    assert.ok(stats3.errors.some((e) => e.startsWith("universe_injuries_failed:")), "失敗を正直に記録");
    const after = (await dossier.getDossier("Real Madrid")).sections.injuries;
    assert.deepStrictEqual(after, before, "失敗時は前回の実測値とcomputedAtがそのまま残る(古さが分かる)");
    assert.ok((await dossier.getDossier("Real Madrid")).sections.form.computedAt.startsWith("2026-08-06"), "成功したセクションは更新される");
  });

  await ok("C7: API予算が安全ライン(BUDGET_FLOOR)を割ったら、何を見送ったか正直に記録して打ち切る", async () => {
    const up2 = createMemoryUpstash();
    let remaining = BUDGET_FLOOR + 10; // 2〜3クラブ分しか予算がない
    const mock = makeMockApi();
    const wrapped = async (p, q) => { remaining--; return mock.callApiFootball(p, q); };
    const { deps } = makeDeps({ callApiFootball: wrapped }, up2, { apiBudget: { remainingForJob: () => remaining } });
    const stats = await collectUniverse(deps, RUN_AT, "2026-08-04");
    assert.ok(stats.coreClubsUpdated >= 1 && stats.coreClubsUpdated < stats.coreClubsPlanned, "一部だけ更新して打ち切る");
    assert.ok(stats.skipped.length >= 1, "見送りが記録される");
    assert.ok(stats.skipped.every((s) => s.reasonJa && s.reasonJa.includes("予算")), "見送り理由を日本語で明記");
  });

  await ok("C8: 1日予算が尽きた(BUDGET_EXHAUSTED)場合も落ちずに正直に打ち切る", async () => {
    const up2 = createMemoryUpstash();
    const mock = makeMockApi({ fail: (p) => p === "/players", failCode: "BUDGET_EXHAUSTED" });
    const { deps } = makeDeps(mock, up2);
    const stats = await collectUniverse(deps, RUN_AT, "2026-08-04");
    assert.ok(stats.skipped.some((s) => s.stage === "playerStats" && s.reasonJa.includes("予算に達した")));
  });

  await ok("C9: 2回目以降はteamIdを再利用し/teams検索を呼び直さない(予算節約)", async () => {
    const mock = makeMockApi();
    const { deps } = makeDeps(mock, sharedUp);
    await collectUniverse(deps, new Date("2026-08-07T00:10:00Z"), "2026-08-07");
    const teamsCalls = mock.calls.filter((c) => c.apiPath === "/teams");
    assert.strictEqual(teamsCalls.length, 0, "保存済みteamIdがあるのに/teamsを呼んでいる");
  });

  await ok("C10: シーズン計算=7月以降は当年、6月以前は前年", () => {
    assert.strictEqual(seasonOf(new Date("2026-08-04T00:00:00Z")), 2026);
    assert.strictEqual(seasonOf(new Date("2026-06-01T00:00:00Z")), 2025);
  });

  console.log("=== D. フロントエンド対応表の整合性 ===");

  await ok("D1: index.htmlのUNIVERSE_CLUB_JA_TO_ENがclubUniverse.jsと完全一致", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const m = html.match(/const UNIVERSE_CLUB_JA_TO_EN = \{([\s\S]*?)\};/);
    assert.ok(m, "UNIVERSE_CLUB_JA_TO_ENがindex.htmlに存在する");
    const map = {};
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^\s*"(.+?)":\s*"(.+?)",?\s*$/);
      if (mm) map[mm[1]] = mm[2];
    }
    assert.strictEqual(Object.keys(map).length, 100, "100クラブ全部が対応表にある");
    for (const c of CLUB_UNIVERSE) {
      assert.strictEqual(map[c.nameJa], c.nameEn, `${c.nameJa}の英語名が不一致`);
    }
  });

  await ok("D2: buildDiscussSubjectにTOP100フォールバックが組み込まれている", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const fn = html.slice(html.indexOf("function buildDiscussSubject"), html.indexOf("function buildDiscussSubject") + 4000);
    assert.ok(fn.includes("UNIVERSE_CLUB_JA_TO_EN"), "フォールバック参照がある");
    const idxPlayers = fn.indexOf("findAllMentionedPlayers");
    const idxUniverse = fn.indexOf("universeHit");
    assert.ok(idxPlayers !== -1 && idxUniverse > idxPlayers, "既存の選手判定より後に置かれ、既存挙動を変えない");
  });

  console.log(`\n結果: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
