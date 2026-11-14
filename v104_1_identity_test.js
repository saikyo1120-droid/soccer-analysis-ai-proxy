"use strict";
/**
 * v104.1(2026年11月14日): 「選手索引にケイン・ムシアラが居ない」の根本原因の修正テスト
 * ----------------------------------------------------------------------------
 * 本番実測(2026-11-14):
 *   ・バイエルン・ミュンヘンの索引は13人で、全員が女子・女子ユース(男子は0人)。順位表なし。
 *     毎日「Frauen Bundesliga の成績しか無い27人」を除外し続けていた
 *     =調査ファイルに保存されたチームIDが**女子チーム**のものだった。
 *   ・登録クラブとしての「Bayern Munich」は検索で男子が返らず「クラブが見つからない」。
 *   ・自動QAは "Bruno Fernandes" "Dani Olmo" "R. Dōan" を「索引に居ない」と答えていた(照合語の書き方依存)。
 *   ・自動QAは毎日 ANSWER_REGRESSION(8件)を出していたが、中身は負傷者一覧が空になっただけだった。
 *
 * 検証すること:
 *   A. 照合の部品(clubUniverse): 発音記号の畳み込み・女子/2軍だけの検索結果を採用しない・
 *      直近試合による本人確認・順位表からの照合し直し
 *   B. 収集(collectUniverse): 取り違えの自動修復(差し替え・破棄・名簿の取り直し・索引の掃除)、
 *      確かめ切れない日は捨てない、正しいチームが見つからなければ取り消して開示、健全なクラブは追加API 0回
 *   C. 追加収集(collectClubPlayersBatch): 検索結果が女子1件だけでも採用しない
 *   D. 自動QA: 名前の書き方に依存しない照合・一覧が空になっただけを後退に数えない・修復手段の選び分け
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const U = require("./learning/clubUniverse");
const { createClubDossier } = require("./knowledge/clubDossier");
const { collectUniverse, collectClubPlayersBatch } = require("./learning/universeCollector");
const playerSearch = require("./knowledge/playerSearch");
const { createAutoQA } = require("./learning/autoQA");

function mockStore() {
  const store = new Map(); const calls = [];
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a[2] === "NX" && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) { if (store.delete(k)) n++; } return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; let s = parseInt(a[1], 10), e = parseInt(a[2], 10); if (s < 0) s = Math.max(0, l.length + s); if (e < 0) e = l.length + e; return l.slice(s, e + 1); }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LPUSH") { const l = store.get(a[0]) || []; l.unshift(a[1]); store.set(a[0], l); return l.length; }
    if (op === "LREM") { const l = store.get(a[0]) || []; const kept = l.filter((x) => x !== a[2]); store.set(a[0], kept); return l.length - kept.length; }
    if (op === "LTRIM" || op === "EXPIRE") return 1;
    if (op === "HGETALL") return [];
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : (typeof r === "string" ? JSON.parse(r) : r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  return { store, calls, upstashCmd, upstashGetJSON, upstashSetJSON };
}

const BAYERN = U.CLUB_UNIVERSE.find((c) => c.nameEn === "Bayern Munich");
const WOMEN_ID = 9001, MEN_ID = 157;
const fixturesOf = (teamId, name, league, n) => Array.from({ length: n || 10 }, (_, i) => ({
  fixture: { id: teamId * 100 + i, date: new Date(Date.parse("2026-11-10T15:00:00Z") - i * 7 * 86400e3).toISOString(), status: { short: "FT" } },
  league: { id: league[0], name: league[1], season: 2026 },
  teams: { home: { id: teamId, name }, away: { id: 5, name: "Opponent" } },
  goals: { home: 2, away: 1 },
}));
const bundesligaStandings = (extra) => ({ response: [{ league: { id: 78, standings: [[
  { rank: 1, team: { id: MEN_ID, name: "Bayern München" }, points: 28, all: { played: 10, goals: { for: 30, against: 8 } } },
  { rank: 2, team: { id: 168, name: "Bayer Leverkusen" }, points: 22, all: { played: 10, goals: { for: 20, against: 10 } } },
  { rank: 3, team: { id: 165, name: "Borussia Dortmund" }, points: 20, all: { played: 10, goals: { for: 19, against: 12 } } },
  ...(extra || []),
]] } }] });

/** バイエルンの調査ファイルに女子チームのIDが保存されている状態(=本番の状態)を作る */
async function seedWrongBayern(m, cd) {
  const meta = { nameJa: BAYERN.nameJa, teamId: WOMEN_ID, uefaRankSnapshot: 3, tier: "A", computedAt: "2026-11-13T00:20:00.000Z" };
  await cd.updateSection("Bayern Munich", "basic", { founded: 1970, venueName: "FC Bayern Campus", logo: "women.png" }, meta);
  await cd.updateSection("Bayern Munich", "form", { currentFormScore: 1.6, avgGoalsFor: 2.2, avgGoalsAgainst: 0.7 }, meta);
  await cd.updateSection("Bayern Munich", "injuries", { injuryCount: 0, injuredPlayers: [], suspendedPlayers: [] }, meta);
  await cd.updateSection("Bayern Munich", "squad", { players: [{ id: 569005, name: "Anna Klink", age: 30, position: "Goalkeeper" }, { id: 68842, name: "G. Stanway", age: 26, position: "Midfielder" }], count: 2 }, meta);
  // 前回の選手索引: バイエルン名義の女子2人+他クラブ1人
  const psDeps = { upstashEnabled: true, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON, upstashCmd: m.upstashCmd };
  const todayKey = playerSearch.dateKeyNum("2026-11-13T00:20:00.000Z");
  const mk = (id, name, teamEn, teamJa) => playerSearch.toIndexRow({ id, name, teamEn, teamJa, leagueId: 78, position: "Midfielder", age: 25 }, { leagueId: 78, todayKey }, Date.parse("2026-11-13T00:20:00.000Z"), null);
  await playerSearch.saveIndex(psDeps, [
    mk(569005, "Anna Klink", "Bayern Munich", BAYERN.nameJa),
    mk(68842, "G. Stanway", "Bayern Munich", BAYERN.nameJa),
    mk(777001, "Other Player", "Real Madrid", "レアル・マドリード"),
  ], { builtAt: "2026-11-13T00:20:00.000Z", dateKey: "2026-11-13" });
  return psDeps;
}

function makeApi(over) {
  const calls = [];
  const o = over || {};
  const api = async (apiPath, params) => {
    calls.push({ apiPath, params: { ...params } });
    if (typeof o.hook === "function") { const r = await o.hook(apiPath, params); if (r !== undefined) return r; }
    if (apiPath === "/fixtures" && params.last) {
      if (Number(params.team) === WOMEN_ID) return { response: fixturesOf(WOMEN_ID, o.womenName || "Bayern Munich W", [82, "Frauen Bundesliga"]) };
      if (Number(params.team) === MEN_ID) return { response: fixturesOf(MEN_ID, "Bayern München", [78, "Bundesliga"]) };
      return { response: [] };
    }
    if (apiPath === "/standings") return Number(params.league) === 78 ? bundesligaStandings(o.standingsExtra) : { response: [] };
    if (apiPath === "/teams" && params.id) return { response: [{ team: { id: params.id, name: Number(params.id) === MEN_ID ? "Bayern München" : "X", founded: 1900, country: "Germany", logo: "men.png" }, venue: { name: "Allianz Arena", city: "München", capacity: 75000 } }] };
    if (apiPath === "/teams") {
      const term = String(params.search || "");
      if (term === "Bayern Munich") return { response: [{ team: { id: WOMEN_ID, name: "Bayern Munich W" }, venue: {} }] };
      if (term === "Bayern Munchen" || term === "Bayern") return { response: [{ team: { id: 8001, name: "Bayern München II" }, venue: {} }, { team: { id: MEN_ID, name: "Bayern München", founded: 1900, country: "Germany", logo: "men.png" }, venue: { name: "Allianz Arena" } }, { team: { id: 8002, name: "Bayern Hof" }, venue: {} }] };
      return { response: [] };
    }
    if (apiPath === "/players/squads") {
      if (Number(params.team) === MEN_ID) return { response: [{ players: [{ id: 184, name: "Harry Kane", age: 33, number: 9, position: "Attacker" }, { id: 181812, name: "Jamal Musiala", age: 23, number: 10, position: "Midfielder" }] }] };
      if (Number(params.team) === WOMEN_ID) return { response: [{ players: [{ id: 569005, name: "Anna Klink", age: 30, position: "Goalkeeper" }] }] };
      return { response: [] };
    }
    if (apiPath === "/players" && params.team) {
      if (Number(params.team) === MEN_ID) return { response: [
        { player: { id: 184, name: "H. Kane", age: 33, nationality: "England" }, statistics: [{ team: { id: MEN_ID, name: "Bayern München" }, league: { id: 78, name: "Bundesliga" }, games: { appearences: 10, lineups: 10, minutes: 880, position: "Attacker", rating: "7.90" }, goals: { total: 12, assists: 3 } }] },
        { player: { id: 181812, name: "J. Musiala", age: 23, nationality: "Germany" }, statistics: [{ team: { id: MEN_ID, name: "Bayern München" }, league: { id: 78, name: "Bundesliga" }, games: { appearences: 9, lineups: 8, minutes: 700, position: "Midfielder", rating: "7.50" }, goals: { total: 4, assists: 5 } }] },
      ], paging: { current: 1, total: 1 } };
      if (Number(params.team) === WOMEN_ID) return { response: [
        { player: { id: 68842, name: "G. Stanway", age: 26 }, statistics: [{ team: { id: WOMEN_ID, name: "Bayern Munich W" }, league: { id: 82, name: "Frauen Bundesliga" }, games: { appearences: 8, minutes: 700, position: "Midfielder", rating: "7.2" }, goals: { total: 2, assists: 1 } }] },
      ], paging: { current: 1, total: 1 } };
      return { response: [], paging: { current: 1, total: 1 } };
    }
    return { response: [] };
  };
  return { api, calls };
}
const depsOf = (m, cd, api) => ({
  callApiFootball: api, apiBudget: { remainingForJob: () => 999999 }, clubDossier: cd, knowledgeStore: null, knowledgeGraph: null, thoughtTimeline: null,
  computeFormScore: () => ({ currentFormScore: 1.2, delta: 0, sampleSize: 5 }), recordLearned: async () => {},
  upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
});

(async () => {
  console.log("v104.1 クラブ照合の取り違え(バイエルン=女子チームID)の根治・自動QAの照合と誤検知の修正");

  // ================= A. 照合の部品 =================
  await t("A1 発音記号を畳んで比べる: 「Bayern München」と別名「Bayern Munchen」が一致する(従来は ü を捨てて不一致)", () => {
    assert.strictEqual(U.normalizeTeamName("Bayern München"), "bayernmunchen");
    assert.strictEqual(U.normalizeTeamName("1. FC Köln"), "1fckoln");
    assert.strictEqual(U.normalizeTeamName("Bodø/Glimt"), "bodoglimt");
    assert.strictEqual(BAYERN.searchAs, "Bayern Munchen");
    assert.deepStrictEqual(U.searchVariantsOf(BAYERN), ["Bayern Munchen", "Bayern Munich", "Bayern"]);
  });

  await t("A2 検索結果が女子・2軍だけのときは採用しない(従来は全候補へ戻して先頭=女子を採用していた)", () => {
    assert.strictEqual(U.pickBestTeamMatch([{ team: { id: 1, name: "Bayern Munich W" } }], BAYERN), null);
    assert.strictEqual(U.pickBestTeamMatch([{ team: { id: 1, name: "Bayern Munich (W)" } }, { team: { id: 2, name: "Bayern München II" } }, { team: { id: 3, name: "Bayern München Frauen" } }, { team: { id: 4, name: "Bayern U19" } }], BAYERN), null);
    const pick = U.pickBestTeamMatch([{ team: { id: 8002, name: "Bayern Hof" } }, { team: { id: 8001, name: "Bayern München II" } }, { team: { id: 157, name: "Bayern München" } }], BAYERN);
    assert.strictEqual(pick.team.id, 157, "別名(発音記号を畳んだ表記)との完全一致を、先頭の別クラブより優先する");
    // 女子チームとして登録されているクラブ(明示指定)は従来どおり女子を返せる
    assert.strictEqual(U.pickBestTeamMatch([{ team: { id: 7, name: "Sample FC W" } }], { nameEn: "Sample FC W" }).team.id, 7);
  });

  await t("A3 提供元表記(別名)との完全一致を、アプリ表記と同名の別チームより優先する。過去に取り違えと判定したIDは二度と採用しない(完全一致でも)", () => {
    const rows = [{ team: { id: 9001, name: "Bayern Munich" } }, { team: { id: 157, name: "Bayern München" } }];
    assert.strictEqual(U.pickBestTeamMatch(rows, BAYERN).team.id, 157, "別名の完全一致を優先");
    assert.strictEqual(U.pickBestTeamMatch(rows, { nameEn: "Bayern Munich" }).team.id, 9001, "前提: 別名が無ければ、同名の9001が選ばれる");
    assert.strictEqual(U.pickBestTeamMatch(rows, { nameEn: "Bayern Munich" }, { rejectTeamIds: [9001] }).team.id, 157);
    assert.strictEqual(U.pickBestTeamMatch([{ team: { id: 9001, name: "Bayern Munich" } }], BAYERN, { rejectTeamIds: [9001] }), null);
    // 別名を持つ既存クラブの選び方は変わらない
    const urawa = U.CLUB_UNIVERSE.find((c) => c.nameEn === "Urawa Red Diamonds");
    assert.strictEqual(U.pickBestTeamMatch([{ team: { id: 1, name: "Urawa W" } }, { team: { id: 287, name: "Urawa" } }], urawa).team.id, 287);
  });

  await t("A4 本人確認: 登録名が女子表記 → 誤り/名前は普通でも直近試合の過半が女子大会 → 誤り/男子 → 正常/情報なし → 判定しない", () => {
    const a = U.assessTeamIdentity(BAYERN, WOMEN_ID, fixturesOf(WOMEN_ID, "Bayern Munich W", [82, "Frauen Bundesliga"]));
    assert.ok(a.wrong && a.kind === "secondary_name" && a.evidenceJa.includes("Bayern Munich W"), JSON.stringify(a));
    const b = U.assessTeamIdentity(BAYERN, WOMEN_ID, fixturesOf(WOMEN_ID, "Bayern Munich", [82, "Frauen Bundesliga"]));
    assert.ok(b.wrong && b.kind === "womens_competitions" && b.evidenceJa.includes("Frauen Bundesliga"), JSON.stringify(b));
    const c = U.assessTeamIdentity(BAYERN, MEN_ID, fixturesOf(MEN_ID, "Bayern München", [78, "Bundesliga"]));
    assert.ok(!c.wrong && !c.suspect && c.apiName === "Bayern München", JSON.stringify(c));
    const d = U.assessTeamIdentity(BAYERN, MEN_ID, [{ teams: { home: { id: MEN_ID }, away: { id: 2 } } }]);
    assert.ok(!d.wrong && !d.suspect && d.apiName === null, "名前も大会名も無い応答では判定しない(誤検知しない)");
    const e = U.assessTeamIdentity(BAYERN, MEN_ID, []);
    assert.ok(!e.wrong && !e.suspect);
    // 女子大会が少数(親善試合で混ざる等)なら誤りにしない
    const mixed = [...fixturesOf(MEN_ID, "Bayern München", [78, "Bundesliga"], 8), ...fixturesOf(MEN_ID, "Bayern München", [999, "Women's Friendly"], 2)];
    assert.ok(!U.assessTeamIdentity(BAYERN, MEN_ID, mixed).wrong);
  });

  await t("A5 弱い証拠: 所属リーグが設定されているのに直近5試合以上に1つもそのリーグが無い → suspect(これだけでは直さない)", () => {
    const s = U.assessTeamIdentity(BAYERN, 8002, fixturesOf(8002, "Bayern Hof", [900, "Regionalliga - Bayern"]));
    assert.ok(!s.wrong && s.suspect && s.kind === "league_absent", JSON.stringify(s));
    const few = U.assessTeamIdentity(BAYERN, 8002, fixturesOf(8002, "Bayern Hof", [900, "Regionalliga - Bayern"], 4));
    assert.ok(!few.suspect, "4試合以下では判断しない");
    const dyn = U.assessTeamIdentity({ nameEn: "Nukunu FC", leagueId: 98, dynamic: true }, 77, fixturesOf(77, "Nukunu FC", [900, "Cup"]));
    assert.ok(!dyn.suspect, "動的クラブは対象外");
  });

  await t("A6 順位表からの照合し直し: 厳密(特徴語が完全一致の1チームだけ)と通常(一致数が単独1位)。別クラブを掴まない", () => {
    const st = bundesligaStandings().response;
    assert.deepStrictEqual(U.findClubInStandings(BAYERN, st, { strict: true }), { id: 157, name: "Bayern München", match: "equal" });
    assert.strictEqual(U.findClubInStandings(BAYERN, st, { strict: true, rejectTeamIds: [157] }), null, "除外IDは候補にしない");
    // 降格したクラブ(順位表に居ない)+同じ特徴語を持つ別クラブ: 厳密モードでは採用しない(二次被害の防止)
    const eng = [{ league: { standings: [[{ team: { id: 62, name: "Sheffield Wednesday" } }, { team: { id: 40, name: "Liverpool" } }]] } }];
    assert.strictEqual(U.findClubInStandings({ nameEn: "Sheffield United" }, eng, { strict: true }), null);
    // 通常モード: 一致数が単独1位なら返す/同点なら返さない
    assert.strictEqual(U.findClubInStandings({ nameEn: "Sheffield United" }, eng, {}).id, 62);
    const tie = [{ league: { standings: [[{ team: { id: 1, name: "Borussia Dortmund" } }, { team: { id: 2, name: "Borussia Mönchengladbach" } }]] } }];
    assert.strictEqual(U.findClubInStandings({ nameEn: "Borussia Neunkirchen" }, tie, {}), null, "同点は特定できない");
    // 女子表記のチームは候補にしない
    assert.strictEqual(U.findClubInStandings(BAYERN, [{ league: { standings: [[{ team: { id: 9, name: "Bayern München W" } }]] } }], {}), null);
    assert.deepStrictEqual(U.listStandingsTeams(st).map((x) => x.id), [157, 168, 165]);
  });

  // ================= B. 収集(collectUniverse) =================
  process.env.UNIVERSE_BULK_CLUB_LIMIT = "3";
  await t("B1 自動修復: 女子チームIDのバイエルンを検出 → 順位表から正しいチームへ差し替え → 誤データ破棄 → 同じ実行で名簿・成績を取り直し → 索引から女子が消えケインが入る", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const psDeps = await seedWrongBayern(m, cd);
    const { api, calls } = makeApi();
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(stats.identity.healed, 1, JSON.stringify(stats.identity) + JSON.stringify(stats.errors.slice(0, 5)));
    const fix = stats.identityFixes.find((f) => f.nameEn === "Bayern Munich");
    assert.ok(fix && fix.status === "healed" && fix.previousTeamId === WOMEN_ID && fix.teamId === MEN_ID && fix.apiName === "Bayern München" && /順位表/.test(fix.viaJa), JSON.stringify(fix));
    assert.ok(stats.skipped.some((s) => s.stage === "teamIdentity" && s.reasonJa.includes("バイエルン") && s.reasonJa.includes("Bayern München")), "差し替えを開示する");
    const d = await cd.getDossier("Bayern Munich");
    assert.strictEqual(d.teamId, MEN_ID);
    assert.ok(d.identity && d.identity.verifiedAt && d.identity.apiName === "Bayern München" && d.identity.correctedAt, JSON.stringify(d.identity));
    assert.deepStrictEqual(d.identity.rejected.map((x) => x.teamId), [WOMEN_ID], "取り違えたIDを覚える");
    assert.strictEqual(d.sections.basic.venueName, "Allianz Arena", "基本情報も正しいチームのものへ");
    assert.strictEqual(d.sections.basic.logo, "men.png");
    assert.ok(d.sections.form && d.sections.form.currentFormScore === 1.2, "フォームは正しいチームで取り直す");
    assert.ok(d.sections.standings && d.sections.standings.position === 1 && d.sections.standings.points === 28, "順位表が取れるようになる: " + JSON.stringify(d.sections.standings));
    assert.deepStrictEqual(d.sections.squad.players.map((p) => p.id), [184, 181812], "名簿を輪番を待たずに取り直す");
    assert.ok(d.lastChangesJa.length >= 1 && d.lastChangesJa.some((c) => c.changeJa.includes("照合し直し")), "差分履歴に訂正が残る");
    // API: 女子IDでは最初の /fixtures 1回だけ。怪我・移籍・名簿・成績は女子IDで呼ばない
    const byWomen = calls.filter((c) => Number(c.params.team) === WOMEN_ID);
    assert.deepStrictEqual(byWomen.map((c) => c.apiPath), ["/fixtures"], "誤ったIDでの収集を続けない: " + JSON.stringify(byWomen.map((c) => c.apiPath)));
    for (const ep of ["/injuries", "/transfers", "/players/squads", "/players"]) assert.ok(calls.some((c) => c.apiPath === ep && Number(c.params.team) === MEN_ID), ep + " を正しいIDで呼ぶ");
    assert.strictEqual(calls.filter((c) => c.apiPath === "/standings" && Number(c.params.league) === 78).length, 1, "順位表は本人確認と②で共有し、二度取らない");
    assert.ok(!calls.some((c) => c.apiPath === "/teams" && c.params.search && /bayern/i.test(String(c.params.search))), "順位表で見つかれば名前検索はしない");
    // 索引
    const idx = await playerSearch.loadIndex(psDeps);
    const C = playerSearch.COL;
    const bayernRows = idx.rows.filter((r) => r[C.teamEn] === "Bayern Munich");
    assert.deepStrictEqual(bayernRows.map((r) => Number(r[C.id])).sort((a, b) => a - b), [184, 181812], "バイエルンの行: " + JSON.stringify(bayernRows.map((r) => r[C.name])));
    assert.ok(idx.rows.some((r) => Number(r[C.id]) === 777001), "他クラブの行は持ち越す(消さない)");
    assert.strictEqual(stats.playerIndex.droppedWrongTeam, 2, JSON.stringify(stats.playerIndex));
    const kane = idx.rows.find((r) => Number(r[C.id]) === 184);
    assert.strictEqual(kane[C.name], "H. Kane"); assert.strictEqual(kane[C.goals], 12);
    // teamId 対応表も正しいIDになる
    const tm = await m.upstashGetJSON("kb:universe:teammap");
    assert.ok(tm.clubs.some((c) => c.nameEn === "Bayern Munich" && c.teamId === MEN_ID) && !tm.clubs.some((c) => c.teamId === WOMEN_ID), "対応表: " + JSON.stringify(tm.clubs.filter((c) => c.nameEn === "Bayern Munich")));
  });

  await t("B2 翌日: 直したクラブは健全と判定され、追加のAPI呼び出しは0回・差し替えも起きない(毎日やり直さない)", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await seedWrongBayern(m, cd);
    await collectUniverse(depsOf(m, cd, makeApi().api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    const day2 = makeApi();
    const stats2 = await collectUniverse(depsOf(m, cd, day2.api), new Date("2026-11-16T00:20:00Z"), "2026-11-16");
    assert.strictEqual(stats2.identity.healed, 0); assert.strictEqual(stats2.identityFixes.length, 0);
    assert.ok(stats2.identity.verified >= 1, JSON.stringify(stats2.identity));
    assert.ok(!day2.calls.some((c) => Number(c.params.team) === WOMEN_ID), "女子IDはもう使わない");
    assert.strictEqual(day2.calls.filter((c) => c.apiPath === "/teams").length, 0, "照合のための検索は発生しない");
    assert.strictEqual(day2.calls.filter((c) => c.apiPath === "/fixtures" && Number(c.params.team) === MEN_ID && c.params.last).length, 1, "直近試合は従来どおり1回だけ");
    const d = await cd.getDossier("Bayern Munich");
    assert.strictEqual(d.identity.verifiedAt, "2026-11-16T00:20:00.000Z", "確認日時が毎日更新される(保存先コマンドは増えない=フォーム保存に相乗り)");
    assert.strictEqual(d.identity.rejected.length, 1);
  });

  await t("B3 名前は普通でも女子大会に出ているチーム(完全一致で掴んだ場合)も検出し、順位表が使えなければ名前検索(取り違えたIDは除外)で直す", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await seedWrongBayern(m, cd);
    const { api, calls } = makeApi({ womenName: "Bayern Munich", hook: (p, q) => {
      if (p === "/standings" && Number(q.league) === 78) return { response: [] }; // 順位表が空(シーズン開始前など)
      if (p === "/teams" && q.search === "Bayern Munich") return { response: [{ team: { id: WOMEN_ID, name: "Bayern Munich" }, venue: {} }] }; // 完全一致の罠
      return undefined;
    } });
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    const fix = stats.identityFixes.find((f) => f.nameEn === "Bayern Munich");
    assert.ok(fix && fix.status === "healed" && fix.teamId === MEN_ID && /名前の検索/.test(fix.viaJa) && /女子大会/.test(fix.evidenceJa), JSON.stringify(fix));
    assert.ok(calls.some((c) => c.apiPath === "/teams" && c.params.search === "Bayern Munchen"));
    const d = await cd.getDossier("Bayern Munich");
    assert.strictEqual(d.teamId, MEN_ID);
  });

  await t("B4 確かめ切れない日(順位表も検索も通信失敗): 調査ファイルは捨てず、誤ったチームのデータも足さず、理由を開示して次回へ", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await seedWrongBayern(m, cd);
    const before = JSON.stringify(await cd.getDossier("Bayern Munich"));
    const { api, calls } = makeApi({ hook: (p) => { if (p === "/standings" || p === "/teams") { const e = new Error("timeout"); e.code = "TIMEOUT"; throw e; } return undefined; } });
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(stats.identity.deferred, 1, JSON.stringify(stats.identity));
    assert.strictEqual(stats.identity.healed + stats.identity.cleared, 0);
    assert.strictEqual(JSON.stringify(await cd.getDossier("Bayern Munich")), before, "調査ファイルは1文字も変えない");
    assert.ok(stats.skipped.some((s) => s.stage === "teamIdentity" && s.reasonJa.includes("見送り")), JSON.stringify(stats.skipped.filter((s) => s.stage === "teamIdentity")));
    const byWomen = calls.filter((c) => Number(c.params.team) === WOMEN_ID).map((c) => c.apiPath);
    assert.deepStrictEqual(byWomen, ["/fixtures"], "誤ったIDで怪我・移籍・名簿・成績を取りに行かない: " + JSON.stringify(byWomen));
    assert.ok(!stats.errors.some((e) => e.includes("universe_form_failed:Bayern Munich")), "見送りを「エラー」として二重に数えない");
  });

  await t("B5 正しいチームが見つからない(検索結果が女子だけ・順位表にも居ない): 誤データを破棄しIDを取り消して「照合できないクラブ」として開示。索引からも外す", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const psDeps = await seedWrongBayern(m, cd);
    // 前回の対応表には、取り違えたIDがバイエルンとして載っている(本番の状態)
    await m.upstashSetJSON("kb:universe:teammap", { at: "2026-11-14T00:20:00.000Z", count: 2, clubs: [
      { teamId: WOMEN_ID, nameEn: "Bayern Munich", nameJa: BAYERN.nameJa, tier: "A", dynamic: false, leagueId: 78 },
      { teamId: 541, nameEn: "Real Madrid", nameJa: "レアル・マドリード", tier: "A", dynamic: false, leagueId: 140 },
    ] });
    const { api } = makeApi({ hook: (p, q) => {
      if (p === "/standings") return { response: [{ league: { standings: [[{ team: { id: 168, name: "Bayer Leverkusen" } }]] } }] };
      if (p === "/teams" && q.search) return { response: [{ team: { id: WOMEN_ID, name: "Bayern Munich W" }, venue: {} }, { team: { id: 9002, name: "Bayern München U19" }, venue: {} }] };
      return undefined;
    } });
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(stats.identity.cleared, 1, JSON.stringify(stats.identity));
    const d = await cd.getDossier("Bayern Munich");
    assert.strictEqual(d.teamId, null); assert.deepStrictEqual(d.sections, {});
    assert.deepStrictEqual(d.identity.rejected.map((x) => x.teamId), [WOMEN_ID]);
    assert.ok(stats.unresolvedClubs.some((u) => u.nameEn === "Bayern Munich"), "照合できないクラブとして開示");
    const idx = await playerSearch.loadIndex(psDeps);
    assert.ok(!idx.rows.some((r) => r[playerSearch.COL.teamEn] === "Bayern Munich"), "別チームの選手を索引に残さない");
    const tm = await m.upstashGetJSON("kb:universe:teammap");
    assert.ok(tm && tm.clubs.some((c) => c.nameEn === "Real Madrid" && c.teamId === 541), "他クラブの対応は前回の表から引き継ぐ");
    assert.ok(!tm.clubs.some((c) => c.teamId === WOMEN_ID || c.nameEn === "Bayern Munich"), "対応表に誤ったIDを書き戻さない(前回の表からも引き継がない): " + JSON.stringify(tm.clubs));
    // 翌日: 取り違えたIDは検索でも採用されない(同じ間違いを繰り返さない)
    const day2 = makeApi({ hook: (p, q) => {
      if (p === "/teams" && q.search) return { response: [{ team: { id: WOMEN_ID, name: "Bayern Munich" }, venue: {} }] };
      return undefined;
    } });
    const stats2 = await collectUniverse(depsOf(m, cd, day2.api), new Date("2026-11-16T00:20:00Z"), "2026-11-16");
    const d2 = await cd.getDossier("Bayern Munich");
    assert.strictEqual(d2.teamId, null, "覚えた取り違えIDを再採用しない");
    assert.ok(stats2.unresolvedClubs.some((u) => u.nameEn === "Bayern Munich"));
  });

  await t("B6 表記だけ女子に見えても、所属リーグ(男子)の順位表に載っているIDは取り違えと決めつけない(誤修復の防止)", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await cd.updateSection("Bayern Munich", "form", { currentFormScore: 2 }, { nameJa: BAYERN.nameJa, teamId: MEN_ID, tier: "A" });
    const { api, calls } = makeApi({ hook: (p, q) => {
      if (p === "/fixtures" && q.last && Number(q.team) === MEN_ID) return { response: fixturesOf(MEN_ID, "Bayern W", [78, "Bundesliga"]) }; // 表記の揺れ(仮)
      return undefined;
    } });
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(stats.identity.healed + stats.identity.cleared + stats.identity.deferred, 0, JSON.stringify(stats.identity));
    assert.strictEqual((await cd.getDossier("Bayern Munich")).teamId, MEN_ID);
    assert.ok(calls.some((c) => c.apiPath === "/injuries" && Number(c.params.team) === MEN_ID), "収集は続ける");
  });

  await t("B7 弱い証拠(所属リーグの試合が無い)だけでは直さない。順位表に特徴語が完全一致の別IDがいるときだけ直す", async () => {
    // (a) 降格クラブ相当: 順位表に同名チームがいない → そのまま
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await cd.updateSection("Bayern Munich", "form", { currentFormScore: 2 }, { nameJa: BAYERN.nameJa, teamId: 8002, tier: "A" });
    const a = makeApi({ hook: (p, q) => {
      if (p === "/fixtures" && q.last && Number(q.team) === 8002) return { response: fixturesOf(8002, "Bayern Hof", [900, "Regionalliga - Bayern"]) };
      if (p === "/standings" && Number(q.league) === 78) return { response: [{ league: { standings: [[{ team: { id: 168, name: "Bayer Leverkusen" } }]] } }] };
      return undefined;
    } });
    const s1 = await collectUniverse(depsOf(m, cd, a.api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(s1.identity.suspectKept, 1, JSON.stringify(s1.identity));
    assert.strictEqual((await cd.getDossier("Bayern Munich")).teamId, 8002, "証拠が弱いので触らない");
    assert.strictEqual(s1.identityFixes.length, 0);
    // (b) 順位表に「Bayern München」(特徴語が完全一致)がいる → 同名の別チームを掴んでいたと判断して直す
    const m2 = mockStore();
    const cd2 = createClubDossier({ upstashEnabled: true, upstashCmd: m2.upstashCmd, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON });
    await cd2.updateSection("Bayern Munich", "form", { currentFormScore: 2 }, { nameJa: BAYERN.nameJa, teamId: 8002, tier: "A" });
    const b = makeApi({ hook: (p, q) => {
      if (p === "/fixtures" && q.last && Number(q.team) === 8002) return { response: fixturesOf(8002, "Bayern Hof", [900, "Regionalliga - Bayern"]) };
      return undefined;
    } });
    const s2 = await collectUniverse(depsOf(m2, cd2, b.api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(s2.identity.healed, 1, JSON.stringify(s2.identity));
    assert.strictEqual((await cd2.getDossier("Bayern Munich")).teamId, MEN_ID);
  });

  await t("B8 健全なクラブ: 本人確認のための追加API呼び出しは0回(順位表は②の1回だけ・検索なし)で、確認結果が調査ファイルに残る", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await cd.updateSection("Bayern Munich", "form", { currentFormScore: 2 }, { nameJa: BAYERN.nameJa, teamId: MEN_ID, tier: "A" });
    const { api, calls } = makeApi();
    const setsBefore = m.calls.filter((c) => c[0] === "SET" && c[1] === "kb:club:bayern-munich").length;
    const stats = await collectUniverse(depsOf(m, cd, api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    assert.strictEqual(stats.identityFixes.length, 0);
    assert.strictEqual(calls.filter((c) => c.apiPath === "/teams").filter((c) => c.params.search === "Bayern Munich" || c.params.search === "Bayern" || c.params.search === "Bayern Munchen").length, 0);
    assert.strictEqual(calls.filter((c) => c.apiPath === "/standings" && Number(c.params.league) === 78).length, 1);
    assert.strictEqual(calls.filter((c) => c.apiPath === "/fixtures" && Number(c.params.team) === MEN_ID && c.params.last).length, 1);
    const d = await cd.getDossier("Bayern Munich");
    assert.ok(d.identity && d.identity.teamId === MEN_ID && d.identity.apiName === "Bayern München" && d.identity.verifiedAt, JSON.stringify(d.identity));
    assert.ok(!d.identity.correctedAt);
    assert.ok(setsBefore >= 1);
  });

  await t("B9 調査ファイル: resetIdentity は誤ったIDで集めた欄と差分履歴を捨て、取り違えIDを最大10件覚える。確認の記録はIDが一致するときだけ", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await cd.updateSection("X Club", "form", { currentFormScore: 1 }, { nameJa: "Xクラブ", teamId: 1 });
    await cd.updateSection("X Club", "coach", { coachName: "A" }, { nameJa: "Xクラブ", teamId: 1 });
    await cd.updateSection("X Club", "coach", { coachName: "B" }, { nameJa: "Xクラブ", teamId: 1 });
    assert.ok((await cd.getDossier("X Club")).lastChangesJa.length >= 1, "前提: 差分履歴がある");
    const r = await cd.resetIdentity("X Club", { teamId: 2, apiName: "X Club", previousTeamId: 1, previousApiName: "X Club W", evidenceJa: "女子表記", viaJa: "テスト", at: "2026-11-15T00:00:00.000Z" });
    assert.ok(r.saved && r.purgedSections.includes("form") && r.purgedSections.includes("coach"));
    const d = await cd.getDossier("X Club");
    assert.strictEqual(d.teamId, 2); assert.deepStrictEqual(d.sections, {});
    assert.strictEqual(d.lastChangesJa.length, 1); assert.ok(d.lastChangesJa[0].changeJa.includes("照合し直し") && !JSON.stringify(d.lastChangesJa).includes("監督"));
    assert.deepStrictEqual(d.identity.rejected, [{ teamId: 1, apiName: "X Club W", at: "2026-11-15T00:00:00.000Z", evidenceJa: "女子表記" }]);
    // 確認の記録: 保存されるIDと違うIDの確認は書かない
    await cd.updateSection("X Club", "form", { currentFormScore: 1 }, { nameJa: "Xクラブ", teamId: 2, identityVerified: { teamId: 999, apiName: "Other", at: "2026-11-16T00:00:00.000Z" } });
    assert.strictEqual((await cd.getDossier("X Club")).identity.verifiedAt, "2026-11-15T00:00:00.000Z");
    await cd.updateSection("X Club", "form", { currentFormScore: 1 }, { nameJa: "Xクラブ", teamId: 2, identityVerified: { teamId: 2, apiName: "X Club", at: "2026-11-16T00:00:00.000Z" } });
    const d2 = await cd.getDossier("X Club");
    assert.strictEqual(d2.identity.verifiedAt, "2026-11-16T00:00:00.000Z"); assert.strictEqual(d2.identity.rejected.length, 1, "確認で取り違えの記憶を消さない");
    assert.strictEqual((await cd.resetIdentity("No Such", { teamId: 1 })).saved, false);
    // 読めないときは上書きしない
    const m2 = mockStore();
    const failing = async (cmd) => { if (cmd[0] === "GET") throw new Error("down"); return m2.upstashCmd(cmd); };
    const cd2 = createClubDossier({ upstashEnabled: true, upstashCmd: failing, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON });
    const rf = await cd2.resetIdentity("X Club", { teamId: 2 });
    assert.ok(rf.saved === false && rf.readFailed === true);
  });

  await t("B10 守備範囲の一覧(getCoverageSummary)に、確認済み・未確認の数と直したクラブ(誤っていたIDと根拠)が出る", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    await seedWrongBayern(m, cd);
    await collectUniverse(depsOf(m, cd, makeApi().api), new Date("2026-11-15T00:20:00Z"), "2026-11-15");
    const cov = await cd.getCoverageSummary();
    assert.ok(cov.identity && cov.identity.verified >= 1, JSON.stringify(cov.identity));
    const c = cov.identity.corrected.find((x) => x.nameEn === "Bayern Munich");
    assert.ok(c && c.teamId === MEN_ID && c.apiName === "Bayern München" && c.rejected[0].teamId === WOMEN_ID && /Bayern Munich W/.test(c.rejected[0].evidenceJa), JSON.stringify(c));
  });
  delete process.env.UNIVERSE_BULK_CLUB_LIMIT;

  // ================= C. 追加収集(collectClubPlayersBatch) =================
  await t("C1 取り違えの発生源: 検索結果が女子チーム1件だけでも採用しない(従来は「1件ならそれ」で女子IDを保存していた)。別名の検索で男子を見つける", async () => {
    const m = mockStore();
    const cd = createClubDossier({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const idxBayern = U.CLUB_UNIVERSE.findIndex((c) => c.nameEn === "Bayern Munich");
    await m.upstashSetJSON("kb:player:collectcursor", { next: idxBayern });
    const src = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
    const cursorKey = (src.match(/const COLLECT_CURSOR_KEY = "([^"]+)"/) || [])[1];
    assert.ok(cursorKey, "カーソルのキー名");
    await m.upstashSetJSON(cursorKey, { next: idxBayern });
    const { api, calls } = makeApi();
    const r = await collectClubPlayersBatch({ callApiFootball: api, clubDossier: cd, apiBudget: { remainingForJob: () => 999999 }, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON, upstashCmd: m.upstashCmd }, { clubLimit: 1, nowMs: Date.parse("2026-11-15T03:00:00Z") });
    const d = await cd.getDossier("Bayern Munich");
    assert.ok(d && d.teamId === MEN_ID, "採用されたID: " + (d && d.teamId) + " / " + JSON.stringify(r.unresolvedClubs));
    assert.strictEqual(d.sections.basic.apiTeamName, "Bayern München");
    assert.ok(!calls.some((c) => c.apiPath === "/players" && Number(c.params.team) === WOMEN_ID), "女子IDで選手を取りに行かない");
    // 検索結果がどの語でも女子だけなら、正直に「照合できない」
    const m2 = mockStore();
    const cd2 = createClubDossier({ upstashEnabled: true, upstashCmd: m2.upstashCmd, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON });
    await m2.upstashSetJSON(cursorKey, { next: idxBayern });
    const only = makeApi({ hook: (p, q) => (p === "/teams" && q.search ? { response: [{ team: { id: WOMEN_ID, name: "Bayern Munich W" }, venue: {} }] } : undefined) });
    const r2 = await collectClubPlayersBatch({ callApiFootball: only.api, clubDossier: cd2, apiBudget: { remainingForJob: () => 999999 }, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON, upstashCmd: m2.upstashCmd }, { clubLimit: 1, nowMs: Date.parse("2026-11-15T03:00:00Z") });
    assert.ok(r2.unresolvedClubs.includes("Bayern Munich"), JSON.stringify(r2.unresolvedClubs));
    assert.ok(!(await cd2.getDossier("Bayern Munich")), "女子IDを保存しない");
  });

  // ================= D. 自動QA =================
  const mkQA = (rows, dossiers) => {
    const m = mockStore();
    return createAutoQA({
      upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
      playerSearch, loadPlayerIndex: async () => ({ rows, available: true }),
      clubDossier: { getDossier: async (n) => (dossiers && dossiers[n]) || null },
      registeredTeams: [], learningStages: [], now: () => Date.parse("2026-11-15T01:00:00Z"),
    });
  };
  const row = (id, name, teamEn) => playerSearch.toIndexRow({ id, name, teamEn, teamJa: teamEn, position: "Midfielder", age: 27, stats: { appearances: 9, rating: 7.1, goals: 2, assists: 3 } }, { todayKey: playerSearch.dateKeyNum("2026-11-15T00:00:00Z") }, Date.parse("2026-11-15T00:00:00Z"), null);

  await t("D1 選手の照合が名前の書き方に依存しない: Bruno Fernandes / Dani Olmo / R. Dōan / Harry Kane / H. Kane をすべて見つける", async () => {
    const qa = mkQA([row(1485, "Bruno Fernandes", "Manchester United"), row(1323, "Dani Olmo", "Barcelona"), row(2598, "R. Dōan", "Eintracht Frankfurt"), row(184, "Harry Kane", "Bayern Munich"), row(1100, "E. Haaland", "Manchester City")]);
    const set = await qa.buildAnswers();
    const by = (id) => set.answers.find((a) => a.id === id);
    for (const id of ["player_bfernandes", "player_olmo", "player_doan", "player_kane", "player_haaland"]) assert.strictEqual(by(id).canAnswer, true, id + ": " + by(id).reasonJa);
    assert.strictEqual(by("player_doan").subjectEn, "R. Dōan");
    assert.strictEqual(by("player_musiala").canAnswer, false, "居ない選手は従来どおり正直に「答えられません」");
    const qa2 = mkQA([row(184, "H. Kane", "Bayern Munich"), row(1485, "B. Fernandes", "Manchester United"), row(1323, "D. Olmo", "Barcelona")]);
    const set2 = await qa2.buildAnswers();
    for (const id of ["player_kane", "player_bfernandes", "player_olmo"]) assert.strictEqual(set2.answers.find((a) => a.id === id).canAnswer, true, "従来の書き方も引き続き当たる: " + id);
  });

  await t("D2 別人に当てない: 「Josh Kane」「T. Kaneko」はハリー・ケインにしない/「Rodri」はロドリゴにしない", async () => {
    const qa = mkQA([row(1, "Josh Kane", "X"), row(2, "T. Kaneko", "Y"), row(3, "Rodri", "Z"), row(4, "Joelson Fernandes", "W")]);
    const set = await qa.buildAnswers();
    assert.strictEqual(set.answers.find((a) => a.id === "player_kane").canAnswer, false);
    assert.strictEqual(set.answers.find((a) => a.id === "player_rodrygo").canAnswer, false);
    assert.strictEqual(set.answers.find((a) => a.id === "player_bfernandes").canAnswer, false);
  });

  const clubSet = (injCount, names, transfersCount, recent) => ({ answers: [{
    id: "club_barcelona", questionJa: "バルセロナの今の状態は？", churn: null, canAnswer: true, subjectJa: "FCバルセロナ",
    facts: [
      { k: "リーグ順位", v: "2" },
      ...(injCount === null ? [] : [{ k: "負傷・出場停止の人数", v: String(injCount) }]),
      ...(names ? [{ k: "負傷・出場停止の選手", v: names }] : []),
      ...(transfersCount === null ? [] : [{ k: "直近30日の移籍件数", v: String(transfersCount) }]),
      ...(recent ? [{ k: "直近の移籍", v: recent }] : []),
    ],
  }] });

  await t("D3 一覧が空になっただけ(負傷者0人・直近の移籍0件)は後退に数えない。状態の変化として別に残す(本番の毎日の ANSWER_REGRESSION の正体)", async () => {
    const qa = mkQA([]);
    const diff = qa.diffAnswers(clubSet(0, null, 0, null), clubSet(2, "A、B", 1, "C(加入)"));
    assert.strictEqual(diff.lostFactTotal, 0, JSON.stringify(diff.items[0].lostFacts));
    assert.strictEqual(diff.stateChangedTotal, 2);
    assert.deepStrictEqual(diff.items[0].stateChangedFacts.map((f) => f.k), ["負傷・出場停止の選手", "直近の移籍"]);
    assert.ok(diff.items[0].stateChangedFacts[0].nowJa.includes("負傷・出場停止の人数は0"));
    assert.deepStrictEqual(diff.lostBreakdown, []);
    const anomalies = qa.detectAnomalies({ learning: { available: true, finished: true, isToday: true }, reflection: { player: { indexAvailable: true, indexCount: 10, searchable: true }, club: { dossiers: 5 } }, predictions: { total: 5, readFailed: false, staleHours: 1, lastResolvedAt: "x" }, growth: { droppedCount: 0, hasYesterday: true, increasedCount: 1 }, answersDiff: { ...diff, hasYesterday: true, grew: true }, storageFailed: null });
    assert.ok(!anomalies.some((a) => a.code === "ANSWER_REGRESSION"), JSON.stringify(anomalies.map((a) => a.code)));
  });

  await t("D4 欄ごと消えた(件数も言えない)ときは従来どおり後退として数える(本物の後退は隠さない)", async () => {
    const qa = mkQA([]);
    const diff = qa.diffAnswers(clubSet(null, null, 0, null), clubSet(2, "A、B", 1, "C(加入)"));
    assert.strictEqual(diff.lostFactTotal, 2, "負傷の件数と一覧の2件が後退");
    assert.strictEqual(diff.stateChangedTotal, 1, "移籍は件数が言えているので状態の変化");
    assert.deepStrictEqual(diff.lostBreakdown, [{ id: "club_barcelona", subjectJa: "FCバルセロナ", keys: ["負傷・出場停止の人数", "負傷・出場停止の選手"] }]);
  });

  await t("D5 修復手段の選び分け: クラブの欄だけが減った日は索引を作り直さない(無関係な修復で「直しました」と書かない)。選手が減った日は従来どおり作り直す", async () => {
    const qa = mkQA([]);
    const base = { learning: { available: true, finished: true, isToday: true }, reflection: { player: { indexAvailable: true, indexCount: 10, searchable: true }, club: { dossiers: 5 } }, predictions: { total: 5, readFailed: false, staleHours: 1, lastResolvedAt: "x" }, growth: { droppedCount: 0, hasYesterday: true, increasedCount: 1 }, storageFailed: null };
    const clubOnly = qa.detectAnomalies({ ...base, answersDiff: { hasYesterday: true, grew: true, lostFactTotal: 2, lostBreakdown: [{ id: "club_barcelona", subjectJa: "FCバルセロナ", keys: ["負傷・出場停止の人数", "負傷・出場停止の選手"] }] } }).find((a) => a.code === "ANSWER_REGRESSION");
    assert.ok(clubOnly && clubOnly.repairKey === null && clubOnly.detailJa.includes("FCバルセロナ") && clubOnly.noRepairNoteJa.includes("次回の毎日の収集"), JSON.stringify(clubOnly));
    const withPlayer = qa.detectAnomalies({ ...base, answersDiff: { hasYesterday: true, grew: true, lostFactTotal: 9, lostBreakdown: [{ id: "player_kane", subjectJa: "ハリー・ケイン", keys: ["所属クラブ"] }] } }).find((a) => a.code === "ANSWER_REGRESSION");
    assert.strictEqual(withPlayer.repairKey, "rebuildPlayerIndex");
    const legacy = qa.detectAnomalies({ ...base, answersDiff: { hasYesterday: true, grew: true, lostFactTotal: 3 } }).find((a) => a.code === "ANSWER_REGRESSION");
    assert.strictEqual(legacy.repairKey, "rebuildPlayerIndex", "内訳が無い(旧形式)ときは従来どおり");
  });

  await t("D6 取り違えを直したクラブの知識の掃除: 「日次の宇宙収集」が出典の知識だけを消し、他の出典は残す。読めないときは消さない", async () => {
    const { createKnowledgeStore } = require("./knowledge/knowledgeStore");
    const m = mockStore();
    const ks = createKnowledgeStore({ upstashEnabled: true, upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const now = new Date().toISOString();
    await ks.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "coachChange", type: "fact", statement: "監督が交代しました。", computedAt: now, source: "API-Footballの実データ(日次の宇宙収集)" });
    await ks.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "injuries", type: "fact", statement: "負傷者が3人に増えました。", computedAt: now, source: "API-Footballの実データ(日次の宇宙収集)" });
    await ks.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "form", type: "fact", statement: "直近フォームが上昇。", computedAt: now, source: "API-Footballの直近10試合" });
    const r = await ks.purgeKnowledgeForEntity("Bayern Munich", (it) => /日次の宇宙収集/.test(String(it.source || "")));
    assert.deepStrictEqual({ ok: r.ok, removed: r.removed, kept: r.kept }, { ok: true, removed: 2, kept: 1 });
    const active = await ks.getActiveKnowledge("Bayern Munich");
    assert.deepStrictEqual(active.facts.map((f) => f.statement), ["直近フォームが上昇。"]);
    assert.strictEqual([...m.store.keys()].filter((k) => k.startsWith("knowledge:item:")).length, 1, "本体キーも消える(孤児を残さない)");
    const failing = createKnowledgeStore({ upstashEnabled: true, upstashCmd: async (c) => { if (c[0] === "LRANGE") throw new Error("down"); return m.upstashCmd(c); }, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    const rf = await failing.purgeKnowledgeForEntity("Bayern Munich", () => true);
    assert.ok(rf.ok === false && rf.removed === 0);
    // 1件ずつ消す途中の失敗は、件数(failed)で必ず返す(黙って「残した」ことにしない)。学習ジョブはそれを記録に残す
    const m2 = mockStore();
    const ks2 = createKnowledgeStore({ upstashEnabled: true, upstashCmd: m2.upstashCmd, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON });
    await ks2.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "coachChange", type: "fact", statement: "監督が交代しました。", computedAt: now, source: "API-Footballの実データ(日次の宇宙収集)" });
    await ks2.saveKnowledgeItem({ teamEn: "Bayern Munich", category: "injuries", type: "fact", statement: "負傷者が3人に増えました。", computedAt: now, source: "API-Footballの実データ(日次の宇宙収集)" });
    let lrem = 0;
    const flaky = createKnowledgeStore({ upstashEnabled: true, upstashCmd: async (c) => { if (c[0] === "LREM" && ++lrem === 1) throw new Error("timeout"); return m2.upstashCmd(c); }, upstashGetJSON: m2.upstashGetJSON, upstashSetJSON: m2.upstashSetJSON });
    const rp = await flaky.purgeKnowledgeForEntity("Bayern Munich", () => true);
    assert.deepStrictEqual({ ok: rp.ok, removed: rp.removed, kept: rp.kept, failed: rp.failed }, { ok: true, removed: 1, kept: 0, failed: 1 });
    assert.strictEqual(r.failed, 0);
    const job = fs.readFileSync(path.join(__dirname, "learning", "dailyJob.js"), "utf8");
    assert.ok(job.includes("knowledgeStore.purgeKnowledgeForEntity(fix.nameEn, (it) => /日次の宇宙収集/.test("), "学習ジョブから呼ばれている");
    assert.ok(job.includes("else if (purged.failed > 0) warn(`identity_knowledge_purge_partial:${fix.nameEn}`"), "消せなかった件数を記録に残す");
  });

  // ================= E. 配線の確認(ソース) =================
  await t("E1 配線: resolveTeamId が追跡クラブで確認済みIDと共通の照合を使う/日次レポートに本人確認の結果が出る/従来の文字列条件を壊していない", () => {
    const srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(srv.includes("const uniClub = clubUniverseLib.findClub(name);"));
    assert.ok(srv.includes("clubUniverseLib.pickBestTeamMatch(r.list, uniClub, { rejectTeamIds })"));
    assert.ok(srv.includes("universeIdentityFixes:") && srv.includes("universePlayerIndex:"));
    const col = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
    assert.ok(col.includes("if (womensEffective.has(id)) { droppedWomens++; continue; }"), "v91 の条件を保つ");
    assert.ok(col.includes("for (const id of womensEffective) merged.delete(id);"));
    assert.ok(!/list\.length === 1 \? list\[0\]/.test(col), "「1件ならそれを採用」が残っていない");
    const job = fs.readFileSync(path.join(__dirname, "learning", "dailyJob.js"), "utf8");
    assert.ok(job.includes("identityFixes: (universeStats.identityFixes || []).slice(0, 30)"));
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})();
