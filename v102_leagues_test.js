"use strict";
/**
 * v102(2026年11月17日)・★2「学習リーグの拡張 15大会 → 最大31大会」と、いっしょに入れた小さな修正の検証
 * ----------------------------------------------------------------------------
 *   予想は出しているのに過去試合を1件も学習していなかった国内リーグ16件を、学習の対象に足した。
 *   ここで確かめること:
 *     1. 足したのは16リーグ(カップ戦なし)。従来の15大会は変えていない
 *     2. リーグIDの照合(国・種別・名前)。一致したものだけを使い、違う大会・見つからないIDは使わない
 *     3. 照合の結果の保存(30日)・通信の失敗は保存しない(次回また試す)・見つからないIDは3日で照合し直す
 *     4. 「学習した大会」に数えるのは、照合に通って保存済みのデータセットに入ったリーグだけ
 *     5. シーズンの年の数え方(暦年のリーグ)
 *     6. データセットの取り直し(照合に通ったリーグだけを取得・目次に残す・保存できたら学習済みに反映)
 *     7. 「学習した大会の全試合を予想の対象に足す」処理が、足したリーグに自動で追従する
 *     8. 保存形式 v4(小さい形)の読み書き・v3 以前の読み込み・上限
 *     9. 画面・回答の文の「◯大会」が決め打ちでない
 *    10. コンセンサス(複数社のオッズ)の月間クレジットの実測が記録に残る
 *    11. C: 予想の記録数・答え合わせの上限
 *    12. 市場ブレンドの比率の決め方(時系列の前向き検証)
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const S = __dirname;
const hb = require(path.join(S, "learning", "historicalBackfill.js"));
const lc = require(path.join(S, "learning", "learnedCompetitions.js"));
const mt = require(path.join(S, "learning", "modelTuning.js"));
const odds = require(path.join(S, "learning", "oddsApi.js"));
const pm = require(path.join(S, "learning", "predictionModel.js"));
const dj = require(path.join(S, "learning", "dailyJob.js"));

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const NEW_IDS = [286, 119, 383, 207, 179, 106, 253, 197, 345, 141, 419, 113, 103, 79, 210, 271];
const CORE_IDS = [39, 140, 78, 135, 61, 88, 94, 203, 144, 2, 3, 848, 98, 40, 71];
// 照合先(API-Football の /leagues?id=)が返す形。国名・大会名は提供元の表記
const API_LEAGUES = {
  286: ["Super Liga", "Serbia"], 119: ["Superliga", "Denmark"], 383: ["Ligat Ha'al", "Israel"], 207: ["Super League", "Switzerland"],
  179: ["Premiership", "Scotland"], 106: ["Ekstraklasa", "Poland"], 253: ["Major League Soccer", "USA"], 197: ["Super League 1", "Greece"],
  345: ["Czech Liga", "Czech-Republic"], 141: ["Segunda División", "Spain"], 419: ["Premyer Liqa", "Azerbaidjan"], 113: ["Allsvenskan", "Sweden"],
  103: ["Eliteserien", "Norway"], 79: ["2. Bundesliga", "Germany"], 210: ["HNL", "Croatia"], 271: ["NB I", "Hungary"],
};
const leagueResponse = (id, name, country, type) => ([{ league: { id, name, type: type || "League" }, country: { name: country }, seasons: [{ year: 2025 }, { year: 2026 }] }]);
const specOf = (id) => hb.DEFAULT_BACKFILL_LEAGUES.find((l) => l.id === id);

function createMockRedis() {
  const store = new Map();
  const log = [];
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd; log.push(cmd);
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "MGET") return args.map((k) => (store.has(k) && typeof store.get(k) === "string" ? store.get(k) : null));
    if (op === "LRANGE") { const l = store.get(args[0]); if (!Array.isArray(l)) return []; const st = Number(args[1]), en = Number(args[2]); return l.slice(st < 0 ? Math.max(0, l.length + st) : st, en < 0 ? l.length + en + 1 : en + 1); }
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "DEL") return store.delete(args[0]) ? 1 : 0;
    if (op === "INCRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c + parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "DECRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c - parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "EXPIRE") return 1;
    if (op === "LPUSH") { const l = store.get(args[0]) || []; l.unshift(args[1]); store.set(args[0], l); return l.length; }
    if (op === "LTRIM") return "OK";
    return null;
  }
  const upstashGetJSON = async (k) => { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  return { store, log, upstashCmd, upstashGetJSON, upstashSetJSON };
}
/** 模擬の API-Football。leagues = { id: [name, country, type?] | "throw" | "empty" }、fixtures は (league, season) ごとに小さな総当たり */
function createFakeApi(leagues, opts) {
  const o = opts || {};
  const calls = [];
  const teamsOf = (leagueId) => [1, 2, 3, 4, 5, 6].map((k) => leagueId * 100 + k);
  async function callApiFootball(endpoint, params) {
    calls.push([endpoint, { ...(params || {}) }]);
    if (endpoint === "/leagues") {
      const v = leagues[params.id];
      if (v === "throw") { const e = new Error("API-Football error: rateLimit"); e.code = "API_ERROR"; throw e; }
      if (!v || v === "empty") return { response: [] };
      return { response: leagueResponse(params.id, v[0], v[1], v[2]) };
    }
    if (endpoint === "/fixtures" && params.league) {
      if (o.failFixturesFor && o.failFixturesFor.has(params.league)) throw new Error("fixtures down");
      const ids = teamsOf(params.league);
      const out = [];
      let n = 0;
      const rounds = o.rounds || 2;
      for (let rnd = 0; rnd < rounds; rnd++) for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        n++;
        // 暦年のリーグは 3月〜、秋始まりは 8月〜(どちらも「その年」に始まる)
        const date = new Date(Date.UTC(params.season, hb.CALENDAR_YEAR_LEAGUE_IDS.has(params.league) ? 2 : 7, 1) + n * 3 * 86400000).toISOString();
        out.push({
          fixture: { id: params.league * 1000000 + (params.season % 100) * 10000 + n, date, status: { short: "FT" } },
          teams: { home: { id: ids[i], name: `T${ids[i]}` }, away: { id: ids[j], name: `T${ids[j]}` } },
          goals: { home: (i * 3 + j + n) % 4, away: (j * 2 + i + n) % 3 },
        });
      }
      return { response: out };
    }
    return { response: [] };
  }
  return { calls, callApiFootball };
}
const resetActivation = () => hb.setActivatedLeagues([]);

(async () => {
  console.log("■ 1. 足したリーグの一覧");
  await t("一覧は 従来の15大会(照合なし・常に使う)+ 足した16リーグ(照合つき)。IDの重複なし・カップ戦を足していない", () => {
    const all = hb.DEFAULT_BACKFILL_LEAGUES;
    assert.strictEqual(all.length, 31);
    assert.strictEqual(new Set(all.map((l) => l.id)).size, 31);
    assert.deepStrictEqual(all.filter((l) => !l.verify).map((l) => l.id), CORE_IDS, "従来の15大会の並び・中身が変わっている");
    assert.deepStrictEqual(all.filter((l) => l.verify).map((l) => l.id), NEW_IDS);
    assert.deepStrictEqual([...hb.CORE_LEAGUE_IDS].sort((a, b) => a - b), CORE_IDS.slice().sort((a, b) => a - b));
    assert.deepStrictEqual([...hb.VERIFY_LEAGUE_IDS].sort((a, b) => a - b), NEW_IDS.slice().sort((a, b) => a - b));
    for (const l of all.filter((x) => x.verify)) {
      assert.ok(!l.cup, `${l.id} はカップ戦の印が付いている`);
      assert.ok(!/カップ|杯/.test(l.nameJa), `${l.nameJa} はカップ戦に見える`);
      assert.ok(Array.isArray(l.verify.country) && l.verify.country.length >= 1 && l.verify.country.every((c) => /^[a-z]+$/.test(c)), `${l.id} の国の条件`);
      assert.ok(l.verify.name instanceof RegExp, `${l.id} の名前の条件`);
      assert.ok(typeof l.nameJa === "string" && l.nameJa.length >= 3);
    }
    // 従来のカップ戦3つの印はそのまま
    assert.deepStrictEqual(all.filter((l) => l.cup).map((l) => l.id), [2, 3, 848]);
  });
  await t("学習の表のリーグ名(LEAGUE_NAMES_JA)に、足した16リーグの名前がある(表でIDのまま出さない)", () => {
    for (const id of NEW_IDS) assert.strictEqual(mt.LEAGUE_NAMES_JA[id], specOf(id).nameJa);
    assert.strictEqual(mt.LEAGUE_NAMES_JA[98], "J1リーグ");
  });

  console.log("■ 2. リーグIDの照合(国・種別・名前)");
  await t("想定どおりの応答(国・リーグ戦・名前)は16リーグすべて通る", () => {
    for (const id of NEW_IDS) {
      const [name, country] = API_LEAGUES[id];
      const r = hb.verifyLeagueIdentity(leagueResponse(id, name, country), specOf(id));
      assert.strictEqual(r.ok, true, `${id} ${country}/${name}: ${r.reasonJa}`);
      assert.strictEqual(r.name, name); assert.strictEqual(r.country, country); assert.strictEqual(r.latestSeason, 2026); assert.strictEqual(r.reasonJa, null);
    }
  });
  await t("名前の別表記(スポンサー名・書き方の違い)も通る", () => {
    const ok = (id, name, country) => assert.strictEqual(hb.verifyLeagueIdentity(leagueResponse(id, name, country), specOf(id)).ok, true, `${id} ${name}`);
    ok(119, "Superligaen", "Denmark"); ok(383, "Premier League", "Israel"); ok(197, "Super League", "Greece"); ok(345, "Chance Liga", "Czech-Republic"); ok(345, "First League", "Czechia");
    ok(141, "La Liga 2", "Spain"); ok(141, "LaLiga Hypermotion", "Spain"); ok(419, "Premier League", "Azerbaijan"); ok(79, "2 Bundesliga", "Germany");
    ok(210, "Prva HNL", "Croatia"); ok(210, "SuperSport HNL", "Croatia"); ok(271, "OTP Bank Liga", "Hungary"); ok(253, "Major League Soccer", "United States"); ok(286, "SuperLiga", "Serbia");
  });
  await t("別の大会は通さない: 国が違う・同じ国の別の階級・カップ戦・女子・見つからない(理由つき)", () => {
    const ng = (id, name, country, type, re) => {
      const r = hb.verifyLeagueIdentity(leagueResponse(id, name, country, type), specOf(id));
      assert.strictEqual(r.ok, false, `${id} ${country}/${name} が通ってしまった`);
      assert.ok(re.test(r.reasonJa), `${id}: ${r.reasonJa}`);
      assert.ok(r.reasonJa.includes(specOf(id).nameJa) && /学習には使いません/.test(r.reasonJa));
    };
    ng(179, "Premiership", "Northern-Ireland", "League", /国が一致しない/);      // 同じ名前・別の国
    ng(179, "Championship", "Scotland", "League", /名前が一致しない/);            // 同じ国の2部
    ng(271, "NB II", "Hungary", "League", /名前が一致しない/);
    ng(79, "Bundesliga", "Germany", "League", /名前が一致しない/);                // 1部
    ng(79, "3. Liga", "Germany", "League", /名前が一致しない/);
    ng(141, "La Liga", "Spain", "League", /名前が一致しない/);                    // 1部
    ng(207, "Challenge League", "Switzerland", "League", /名前が一致しない/);
    ng(113, "Damallsvenskan", "Sweden", "League", /名前が一致しない/);            // 女子
    ng(113, "Superettan", "Sweden", "League", /名前が一致しない/);
    ng(253, "US Open Cup", "USA", "Cup", /種別が一致しない|名前が一致しない/);
    ng(106, "Ekstraklasa", "Poland", "Cup", /種別が一致しない/);                  // 名前は同じでも種別がカップ
    ng(383, "Liga Leumit", "Israel", "League", /名前が一致しない/);
    ng(210, "HNL", "Bosnia", "League", /国が一致しない/);
    // 応答に無い(空・別のID)→ 見つからない
    for (const resp of [[], null, undefined, leagueResponse(999, "Super Liga", "Serbia")]) {
      const r = hb.verifyLeagueIdentity(resp, specOf(286));
      assert.strictEqual(r.ok, false); assert.strictEqual(r.notFound, true); assert.ok(/見つかりませんでした/.test(r.reasonJa));
    }
  });

  console.log("■ 3. 照合の結果の保存・やり直し");
  const RUN = new Date("2026-11-17T19:17:00Z");
  await t("初回: 16リーグを1回ずつ照合し、結果(通った/通らない)を保存する。通信に失敗したリーグは保存せず、理由を残す", async () => {
    const mock = createMockRedis();
    const api = createFakeApi({ ...API_LEAGUES, 271: ["NB II", "Hungary"], 419: "empty", 103: "throw" });
    const r = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: api.callApiFootball }, RUN);
    assert.strictEqual(r.requests, 15, "通信に失敗した1件は数えない"); assert.strictEqual(api.calls.length, 16);
    assert.ok(api.calls.every(([ep, p]) => ep === "/leagues" && NEW_IDS.includes(p.id)));
    assert.deepStrictEqual([...r.okIds].sort((a, b) => a - b), NEW_IDS.filter((id) => ![271, 419, 103].includes(id)).sort((a, b) => a - b));
    assert.deepStrictEqual(r.errors.length, 1); assert.ok(/^league_check_failed:league=103:/.test(r.errors[0]), r.errors[0]);
    const saved = JSON.parse(mock.store.get(hb.LEAGUE_CHECK_KEY));
    assert.strictEqual(Object.keys(saved.byId).length, 15); assert.strictEqual(saved.byId[103], undefined, "通信に失敗した結果を保存している");
    assert.strictEqual(saved.byId[179].ok, true); assert.strictEqual(saved.byId[179].name, "Premiership"); assert.strictEqual(saved.byId[179].checkedAt, RUN.toISOString());
    assert.strictEqual(saved.byId[271].ok, false); assert.ok(/NB II/.test(saved.byId[271].reasonJa));
    assert.strictEqual(saved.byId[419].ok, false); assert.strictEqual(saved.byId[419].notFound, true);
    const sum = hb.summarizeLeagueChecks(r.byId);
    assert.deepStrictEqual([sum.total, sum.ok, sum.rejected, sum.pending], [16, 13, 2, 1]);
    assert.strictEqual(sum.rows.find((x) => x.id === 103).status, "pending"); assert.ok(/まだ照合できていません/.test(sum.rows.find((x) => x.id === 103).reasonJa));
    assert.strictEqual(sum.rows.find((x) => x.id === 419).notFound, true);
    assert.strictEqual(sum.rows.find((x) => x.id === 179).apiName, "Premiership");
  });
  await t("2回目(翌日): 保存済みの結果は照合し直さない。失敗したリーグだけをもう一度試す", async () => {
    const mock = createMockRedis();
    const api1 = createFakeApi({ ...API_LEAGUES, 103: "throw" });
    await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: api1.callApiFootball }, RUN);
    const api2 = createFakeApi(API_LEAGUES);
    const r2 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: api2.callApiFootball }, new Date(RUN.getTime() + 86400000));
    assert.deepStrictEqual(api2.calls.map(([, p]) => p.id), [103]);
    assert.strictEqual(r2.okIds.size, 16); assert.deepStrictEqual(r2.errors, []);
    // 3回目: もう通信しない
    const api3 = createFakeApi(API_LEAGUES);
    const r3 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: api3.callApiFootball }, new Date(RUN.getTime() + 2 * 86400000));
    assert.strictEqual(api3.calls.length, 0); assert.strictEqual(r3.requests, 0); assert.strictEqual(r3.okIds.size, 16);
  });
  await t("見つからなかったIDは3日で照合し直す。通った結果・違う大会だった結果は30日で照合し直す", async () => {
    const mock = createMockRedis();
    await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: createFakeApi({ ...API_LEAGUES, 419: "empty", 271: ["NB II", "Hungary"] }).callApiFootball }, RUN);
    const at = (days) => new Date(RUN.getTime() + days * 86400000);
    const a2 = createFakeApi(API_LEAGUES); await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: a2.callApiFootball }, at(2.9));
    assert.strictEqual(a2.calls.length, 0, "3日たっていないのに照合し直した");
    const a3 = createFakeApi(API_LEAGUES); const r3 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: a3.callApiFootball }, at(3.1));
    assert.deepStrictEqual(a3.calls.map(([, p]) => p.id), [419]); assert.ok(r3.okIds.has(419), "見つかるようになったら通る");
    const a29 = createFakeApi(API_LEAGUES); await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: a29.callApiFootball }, at(29.9));
    assert.strictEqual(a29.calls.length, 0);
    const a31 = createFakeApi(API_LEAGUES); const r31 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: a31.callApiFootball }, at(30.1));
    assert.strictEqual(a31.calls.length, 15, "30日たった15件(419 は3日めに照合し直したので、まだ新しい)"); assert.ok(!a31.calls.some(([, p]) => p.id === 419));
    assert.ok(r31.okIds.has(271), "照合し直して通るようになった");
  });
  await t("以前に通っていたリーグは、照合し直しの通信に失敗しても、保存済みの結果のまま使い続ける", async () => {
    const mock = createMockRedis();
    await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: createFakeApi(API_LEAGUES).callApiFootball }, RUN);
    const allThrow = {}; for (const id of NEW_IDS) allThrow[id] = "throw";
    const r = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: createFakeApi(allThrow).callApiFootball }, new Date(RUN.getTime() + 31 * 86400000));
    assert.strictEqual(r.okIds.size, 16); assert.strictEqual(r.errors.length, 16); assert.strictEqual(r.requests, 0);
  });
  await t("外部APIの予算が無い・通信の関数が無い・保存先を読めないとき: 理由を残して、勝手に通さない", async () => {
    const mock = createMockRedis();
    const api = createFakeApi(API_LEAGUES);
    const r1 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock, callApiFootball: api.callApiFootball, apiBudget: { canAfford: () => false } }, RUN);
    assert.strictEqual(api.calls.length, 0); assert.strictEqual(r1.okIds.size, 0); assert.strictEqual(r1.errors.length, 16); assert.ok(r1.errors.every((e) => /^league_check_skipped_budget:league=\d+$/.test(e)));
    assert.strictEqual(mock.store.has(hb.LEAGUE_CHECK_KEY), false, "何も照合していないのに保存した");
    const r2 = await hb.ensureLeagueChecks({ upstashEnabled: true, ...mock }, RUN);
    assert.strictEqual(r2.okIds.size, 0); assert.ok(r2.errors.every((e) => /^league_check_unavailable/.test(e)));
    // 保存先の読み出しに失敗 → 「保存なし」として照合し直す(失敗は errors に残る)
    const api3 = createFakeApi(API_LEAGUES);
    const r3 = await hb.ensureLeagueChecks({ upstashEnabled: true, upstashGetJSON: async () => { throw new Error("store down"); }, upstashSetJSON: mock.upstashSetJSON, callApiFootball: api3.callApiFootball }, RUN);
    assert.strictEqual(api3.calls.length, 16); assert.strictEqual(r3.okIds.size, 16); assert.ok(r3.errors.some((e) => /^league_check_read_failed:store down/.test(e)), JSON.stringify(r3.errors));
  });

  console.log("■ 4. 「学習した大会」に数えるリーグ");
  await t("起動直後は従来の15大会だけ。足したリーグは、保存済みデータセットの目次に入っているものだけを数える", () => {
    resetActivation();
    assert.deepStrictEqual(hb.activeLeagueIds(), CORE_IDS);
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15); assert.strictEqual(lc.learnedCompetitionCount(), 15);
    for (const id of NEW_IDS) { assert.strictEqual(hb.isLeagueActive(id), false); assert.strictEqual(lc.classifyLearnedCompetition(id, "x").learned, false, `${id} が学習前から学習済み`); }
    const before = lc.LEARNED_LEAGUE_IDS; // 同じ Set のまま中身が変わること(server.js・dailyJob.js はこの Set を持っている)
    const ids = hb.activateFromMeta({ leagues: [...CORE_IDS, 179, 253, 999, "106"] });
    assert.deepStrictEqual(ids, [...CORE_IDS, 179, 106, 253], "一覧の順番で返る・一覧に無いIDは無視・文字列のIDも数として扱う");
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS, before); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 18); assert.strictEqual(lc.learnedCompetitionCount(), 18);
    assert.deepStrictEqual(lc.learnedScope(), { total: 18, core: 15, extra: 3 });
    assert.strictEqual(lc.classifyLearnedCompetition(179, "Premiership").learned, true);
    assert.strictEqual(lc.classifyLearnedCompetition(271, "NB I").learned, false);
    assert.ok(lc.classifyLearnedCompetition(271, "NB I").reasonJa.includes("学習しているのは18大会"));
    assert.strictEqual(lc.isLearnedRecord({ leagueId: 253 }), true);
    // 目次が無い・読めなかった(null)ときは、いまの状態を保つ
    hb.activateFromMeta(null); hb.activateFromMeta({}); hb.activateFromMeta({ leagues: "x" });
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 18);
    // 目次から外れたら数えない。従来の15大会は、目次に無くても外れない
    hb.activateFromMeta({ leagues: [39, 179] });
    assert.deepStrictEqual(hb.activeLeagueIds(), [...CORE_IDS, 179]);
    resetActivation();
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15);
  });
  await t("予想の記録の「学習した大会か」は予想時に保存した印が優先(あとから学習を始めても、過去の予想は学習済みに化けない)", () => {
    resetActivation();
    const old = { leagueId: 179, learnedCompetition: false };
    hb.setActivatedLeagues([179]);
    assert.strictEqual(lc.isLearnedRecord(old), false, "学習前に立てた予想が、学習済みに化けた");
    assert.strictEqual(lc.isLearnedRecord({ leagueId: 179, learnedCompetition: true }), true);
    const split = lc.accuracySplit([{ ...old, resolved: true, correct: true }, { leagueId: 179, learnedCompetition: true, resolved: true, correct: false }], () => true);
    assert.deepStrictEqual([split.learnedOfficial.n, split.unlearnedOfficial.n], [1, 1]);
    resetActivation();
  });
  await t("通知先が例外を投げても、学習リーグの反映は止まらない(黙って捨てずに警告を出す)", () => {
    const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(" "));
    try {
      hb.onLeagueActivationChange(() => { throw new Error("listener boom"); });
      const ids = hb.setActivatedLeagues([286]);
      assert.ok(ids.includes(286)); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.has(286), true);
      assert.ok(warns.some((w) => /league_activation_listener_failed/.test(w) && /listener boom/.test(w)), JSON.stringify(warns));
    } finally { console.warn = orig; resetActivation(); }
  });

  console.log("■ 5. シーズンの年の数え方");
  await t("秋に始まるリーグは従来どおり。暦年のリーグ(J1・ブラジル・MLS・スウェーデン・ノルウェー)はその年が今のシーズンで、1〜6月は1つ多く持つ", () => {
    assert.deepStrictEqual([...hb.CALENDAR_YEAR_LEAGUE_IDS].sort((a, b) => a - b), [71, 98, 103, 113, 253]);
    const eu = { id: 39 }, cal = { id: 253 };
    const at = (iso) => new Date(iso);
    assert.deepStrictEqual(hb.seasonsForLeague(eu, at("2026-11-17T19:17:00Z"), 5), [2026, 2025, 2024, 2023, 2022]);
    assert.deepStrictEqual(hb.seasonsForLeague(cal, at("2026-11-17T19:17:00Z"), 5), [2026, 2025, 2024, 2023, 2022]);
    assert.deepStrictEqual(hb.seasonsForLeague(eu, at("2027-02-10T19:17:00Z"), 5), [2026, 2025, 2024, 2023, 2022]);
    assert.deepStrictEqual(hb.seasonsForLeague(cal, at("2027-02-10T19:17:00Z"), 5), [2027, 2026, 2025, 2024, 2023, 2022], "2月に、始まったばかりの今年のシーズンを取りに行っていない");
    assert.deepStrictEqual(hb.seasonsForLeague(cal, at("2027-06-30T23:00:00Z"), 5), [2027, 2026, 2025, 2024, 2023, 2022]);
    assert.deepStrictEqual(hb.seasonsForLeague(cal, at("2027-07-01T00:00:00Z"), 5), [2027, 2026, 2025, 2024, 2023]);
    assert.deepStrictEqual(hb.seasonsForLeague(eu, at("2027-07-01T00:00:00Z"), 5), [2027, 2026, 2025, 2024, 2023]);
    assert.deepStrictEqual(hb.seasonsForLeague({ id: 98 }, at("2027-01-05T00:00:00Z"), 5).length, 6);
    // 秋始まりの数え方は、従来の関数(modelTuning.seasonsToFetch)と同じ
    for (const iso of ["2026-11-17T00:00:00Z", "2027-02-10T00:00:00Z", "2027-07-01T00:00:00Z", "2027-06-30T00:00:00Z"]) {
      assert.deepStrictEqual(hb.seasonsForLeague(eu, at(iso), 5), mt.seasonsToFetch(at(iso), 5), iso);
    }
  });

  console.log("■ 6. データセットの取り直し");
  await t("照合に通ったリーグだけを取得し、目次(meta.leagues)に残す。保存できたら「学習した大会」に反映する。通らなかったリーグは取得しない", async () => {
    resetActivation();
    const mock = createMockRedis();
    const api = createFakeApi({ ...API_LEAGUES, 271: ["NB II", "Hungary"], 419: "empty", 103: "throw" });
    const beats = [];
    const ds = await mt.ensureDataset({ upstashEnabled: true, ...mock, callApiFootball: api.callApiFootball, heartbeat: async (d) => { beats.push(d); } }, RUN);
    const want = [...CORE_IDS, ...NEW_IDS.filter((id) => ![271, 419, 103].includes(id))];
    const fetchedLeagues = [...new Set(api.calls.filter(([ep, p]) => ep === "/fixtures" && p.league).map(([, p]) => p.league))];
    assert.deepStrictEqual(fetchedLeagues, want, "取得したリーグ");
    for (const id of [271, 419, 103]) assert.ok(!fetchedLeagues.includes(id), `照合に通っていない ${id} を取得した`);
    // リーグごとのシーズン: 暦年のリーグも秋始まりも、11月は 2026〜2022 の5つ
    const seasonsOf = (id) => api.calls.filter(([ep, p]) => ep === "/fixtures" && p.league === id).map(([, p]) => p.season);
    assert.deepStrictEqual(seasonsOf(253), [2026, 2025, 2024, 2023, 2022]); assert.deepStrictEqual(seasonsOf(39), [2026, 2025, 2024, 2023, 2022]);
    assert.strictEqual(ds.refreshed, true); assert.strictEqual(ds.saved, true);
    assert.deepStrictEqual(ds.meta.leagues, want);
    assert.strictEqual(ds.meta.rowsVersion, hb.ROWS_VERSION); assert.strictEqual(hb.ROWS_VERSION, 4);
    assert.strictEqual(ds.meta.droppedOldest, 0);
    assert.deepStrictEqual([ds.leagueChecks.total, ds.leagueChecks.ok, ds.leagueChecks.rejected, ds.leagueChecks.pending], [16, 13, 2, 1]);
    assert.deepStrictEqual(ds.meta.leagueChecks, ds.leagueChecks);
    assert.ok(ds.leagueCheckErrors.some((e) => /league=103/.test(e)));
    assert.strictEqual(ds.meta.apiRequests, want.length * 5 + 15, "過去試合の取得+照合の通信");
    assert.ok(new RegExp(`過去5シーズン×${want.length}リーグから`).test(ds.reasonJa), ds.reasonJa);
    // 学習した大会への反映(保存できたあと)
    assert.deepStrictEqual(hb.activeLeagueIds(), hb.DEFAULT_BACKFILL_LEAGUES.map((l) => l.id).filter((id) => want.includes(id)));
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 28);
    assert.strictEqual(lc.classifyLearnedCompetition(271, "NB I").learned, false);
    // 行に、足したリーグの試合が入っている
    const leaguesInRows = new Set(ds.rows.map((r) => r.leagueId));
    assert.ok(leaguesInRows.has(179) && leaguesInRows.has(253) && leaguesInRows.has(39)); assert.ok(!leaguesInRows.has(271));
    // 長い取得の途中で、進捗の心拍を打っている
    assert.ok(beats.length >= want.length * 5, `心拍 ${beats.length}`); assert.ok(/過去試合の取得/.test(beats[0]));
    // 同じ日にもう一度: 取り直さない(新しい・リーグの構成も同じ)。照合も保存済みを使う(失敗した103だけ試す)
    const api2 = createFakeApi({ ...API_LEAGUES, 271: ["NB II", "Hungary"], 419: "empty", 103: "throw" });
    const ds2 = await mt.ensureDataset({ upstashEnabled: true, ...mock, callApiFootball: api2.callApiFootball }, new Date(RUN.getTime() + 3600000));
    assert.strictEqual(ds2.refreshed, false); assert.strictEqual(ds2.rows.length, ds.rows.length);
    assert.deepStrictEqual(api2.calls.map(([ep, p]) => `${ep}:${p.id}`), ["/leagues:103"]);
    assert.deepStrictEqual([ds2.leagueChecks.ok, ds2.leagueChecks.pending], [13, 1]);
    // 翌日、103 が照合に通った → リーグの構成が変わったので、3日を待たずに取り直す
    const api3 = createFakeApi({ ...API_LEAGUES, 271: ["NB II", "Hungary"], 419: "empty" });
    const ds3 = await mt.ensureDataset({ upstashEnabled: true, ...mock, callApiFootball: api3.callApiFootball }, new Date(RUN.getTime() + 86400000));
    assert.strictEqual(ds3.refreshed, true); assert.ok(ds3.meta.leagues.includes(103)); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.has(103), true); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 29);
    resetActivation();
  });
  await t("保存に失敗したら「学習した大会」に反映しない(学習していないものを学習済みと言わない)", async () => {
    resetActivation();
    const mock = createMockRedis();
    const api = createFakeApi(API_LEAGUES);
    const failingSet = async (k, v) => (String(k).startsWith("learn:backfill:dataset") ? false : mock.upstashSetJSON(k, v));
    const ds = await mt.ensureDataset({ upstashEnabled: true, ...mock, upstashSetJSON: failingSet, callApiFootball: api.callApiFootball }, RUN);
    assert.strictEqual(ds.saved, false); assert.ok(/保存に失敗しました/.test(ds.reasonJa));
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15, "保存できていないのに学習済みに数えた");
    resetActivation();
  });
  await t("照合が1件も通らない日(照合先の不調)でも、従来の15大会の取り直しは今までどおり動く", async () => {
    resetActivation();
    const mock = createMockRedis();
    const allThrow = {}; for (const id of NEW_IDS) allThrow[id] = "throw";
    const api = createFakeApi(allThrow);
    const ds = await mt.ensureDataset({ upstashEnabled: true, ...mock, callApiFootball: api.callApiFootball }, RUN);
    assert.strictEqual(ds.saved, true); assert.deepStrictEqual(ds.meta.leagues, CORE_IDS);
    assert.strictEqual(ds.leagueChecks.pending, 16); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15);
    assert.strictEqual(api.calls.filter(([ep, p]) => ep === "/fixtures" && p.league).length, 75);
    resetActivation();
  });
  await t("取り直しに必要なリクエスト数は「リーグごとのシーズン数の合計+予備」。足りなければ見送り、既存のデータで学習する", async () => {
    resetActivation();
    const mock = createMockRedis();
    const api = createFakeApi(API_LEAGUES);
    let asked = [];
    const budget = { canAfford: (n) => { asked.push(n); return n <= 16; } }; // 照合(1件ずつ)は払えるが、取り直しは払えない
    const ds = await mt.ensureDataset({ upstashEnabled: true, ...mock, callApiFootball: api.callApiFootball, apiBudget: budget }, RUN);
    assert.strictEqual(ds.refreshed, false);
    assert.ok(asked.includes(31 * 5 + 2), `必要数の問い合わせ: ${[...new Set(asked)].join(",")}`);
    assert.ok(/約157リクエストの余裕が無い/.test(ds.reasonJa), ds.reasonJa);
    assert.strictEqual(api.calls.filter(([ep]) => ep === "/fixtures").length, 0);
    assert.strictEqual(ds.leagueChecks.ok, 16, "見送った日も、照合の結果は返す");
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15, "取り込んでいないので、まだ学習済みではない");
    // 2月(暦年のリーグが6シーズン)は 31×5+5+2
    asked = [];
    await mt.ensureDataset({ upstashEnabled: true, ...createMockRedis(), callApiFootball: createFakeApi(API_LEAGUES).callApiFootball, apiBudget: budget }, new Date("2027-02-10T19:17:00Z"));
    assert.ok(asked.includes(31 * 5 + 5 + 2), `2月の必要数: ${[...new Set(asked)].join(",")}`);
    resetActivation();
  });

  console.log("■ 7. 「学習した大会の全試合を予想の対象に足す」処理の追従");
  await t("足したリーグの試合は、学習済みになる前は対象外・なった後は対象(同じ Set を渡しているだけで追従する)", async () => {
    resetActivation();
    const fx = (id, leagueId, hour) => ({ fixture: { id, date: `2026-11-18T${String(hour).padStart(2, "0")}:00:00Z`, status: { short: "NS" } }, league: { id: leagueId }, teams: { home: { id: id * 10 + 1, name: `H${id}` }, away: { id: id * 10 + 2, name: `A${id}` } } });
    const day = [fx(1, 39, 15), fx(2, 179, 12), fx(3, 253, 23), fx(4, 9999, 10), fx(5, 271, 11)];
    const deps = { callApiFootball: async (ep, p) => (ep === "/fixtures" && p.date === "2026-11-18" ? { response: day } : { response: [] }) };
    const before = await dj.buildExtraFixtureTeams(deps, { cap: dj.EXTRA_FIXTURES_CAP, dates: ["2026-11-18", "2026-11-19"], learnedIds: lc.LEARNED_LEAGUE_IDS });
    assert.deepStrictEqual(before.teams.map((x) => x.presetFixture.fixture.id), [1]); assert.strictEqual(before.scanned, 5);
    hb.setActivatedLeagues([179, 253]);
    const after = await dj.buildExtraFixtureTeams(deps, { cap: dj.EXTRA_FIXTURES_CAP, dates: ["2026-11-18", "2026-11-19"], learnedIds: lc.LEARNED_LEAGUE_IDS });
    assert.deepStrictEqual(after.teams.map((x) => x.presetFixture.fixture.id), [2, 1, 3], "キックオフの近い順");
    assert.strictEqual(after.totalEligible, 3);
    resetActivation();
  });
  await t("毎日の学習の最初に、保存済みの目次から学習リーグを反映している(今日の予想の判定が、昨日までに学習した範囲と合う)", () => {
    const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    const iStart = src.indexOf('await stage("開始");');
    const iAct = src.indexOf("activateFromMeta(await upstashGetJSON(BACKFILL_META_KEY))");
    const iPredict = src.indexOf('await stage("③ 新しい予測を立てる");');
    assert.ok(iStart > 0 && iAct > iStart && iPredict > iAct, "反映が、予想を立てる段階より前にない");
    assert.ok(src.includes("learnedIds: learnedComp.LEARNED_LEAGUE_IDS"));
    assert.ok(src.includes("leagueIds: activeLeagueIds(), season: seasonGuess"), "xG の収集が、学習に使っているリーグだけになっていない");
  });

  console.log("■ 8. 保存形式 v4・上限");
  await t("保存→読み込みで、学習に使う値がすべて元どおり(文脈・対戦成績・シーズン・勝敗)。1行の保存サイズは v3 の半分以下", async () => {
    const api = createFakeApi({}, { rounds: 3 });
    const fetched = await hb.backfillSeasons({ callApiFootball: api.callApiFootball }, { leagues: [{ id: 39, nameJa: "x" }, { id: 2, nameJa: "y", cup: true }], seasons: [2025, 2026] });
    const rows = hb.buildTrainingRows(fetched.matches);
    assert.ok(rows.length > 200, `行数 ${rows.length}`);
    const mock = createMockRedis();
    const res = await hb.saveDataset({ upstashEnabled: true, ...mock }, rows, { builtAt: "x", leagues: [39, 2] });
    assert.strictEqual(res.saved, true); assert.strictEqual(res.meta.rowsVersion, 4);
    const back = await hb.loadDataset({ upstashEnabled: true, ...mock });
    assert.strictEqual(back.rows.length, rows.length); assert.strictEqual(back.failedShards, undefined);
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i], b = back.rows[i];
      assert.deepStrictEqual(b.homeCtx, a.homeCtx, `行${i} homeCtx`); assert.deepStrictEqual(b.awayCtx, a.awayCtx, `行${i} awayCtx`);
      assert.deepStrictEqual(b.h2h, a.h2h); assert.strictEqual(b.season, a.season); assert.strictEqual(b.date, a.date); assert.strictEqual(b.leagueId, a.leagueId);
      assert.strictEqual(b.homeId, a.homeId); assert.strictEqual(b.awayId, a.awayId);
      assert.strictEqual(b.actualHomeGoals, a.actualHomeGoals); assert.strictEqual(b.actualAwayGoals, a.actualAwayGoals); assert.strictEqual(b.actualWinner, a.actualWinner);
    }
    const shard0 = mock.store.get(hb.backfillShardKey(0));
    const perRow = Buffer.byteLength(shard0) / JSON.parse(shard0).length;
    assert.ok(perRow < 190, `1行 ${perRow.toFixed(0)} バイト`);
    // v3 の形(文脈を項目名つきで保存)だと何バイトだったか
    const v3 = JSON.stringify(rows.slice(0, 200).map((r) => ({ d: r.date, l: r.leagueId, hi: r.homeId, ai: r.awayId, h: { formScore: 0.6, avgGoalsFor: 1.5, avgGoalsAgainst: 1.2, pointsPerGame: 1.6, homeVenueWinRate: 0.5, awayVenueWinRate: null, sampleSize: 10 }, a: { formScore: 0.6, avgGoalsFor: 1.5, avgGoalsAgainst: 1.2, pointsPerGame: 1.6, homeVenueWinRate: null, awayVenueWinRate: 0.5, sampleSize: 10 }, hg: 1, ag: 0, w: "home" })));
    assert.ok(perRow < (Buffer.byteLength(v3) / 200) * 0.6, `v3 は1行 ${(Buffer.byteLength(v3) / 200).toFixed(0)} バイト`);
  });
  await t("v3 以前の形で保存されたデータも読める(作り直すまでの間、そのまま学習に使える)", async () => {
    const mock = createMockRedis();
    const v3row = { d: "2026-01-01T00:00:00Z", l: 39, hi: 1, ai: 2, h: { formScore: 0.5, avgGoalsFor: 1.4, avgGoalsAgainst: 1.1, pointsPerGame: 1.7, homeVenueWinRate: 0.6, awayVenueWinRate: null, sampleSize: 10 }, a: { formScore: -0.2, avgGoalsFor: 1.0, avgGoalsAgainst: 1.3, pointsPerGame: 1.1, homeVenueWinRate: null, awayVenueWinRate: 0.3, sampleSize: 10 }, hg: 2, ag: 1, w: "home" };
    await mock.upstashSetJSON(hb.backfillShardKey(0), [v3row]);
    await mock.upstashSetJSON(hb.BACKFILL_META_KEY, { rowsVersion: 3, shardCount: 1, leagues: [39] });
    const back = await hb.loadDataset({ upstashEnabled: true, ...mock });
    assert.strictEqual(back.rows.length, 1);
    assert.deepStrictEqual(back.rows[0].homeCtx, v3row.h); assert.deepStrictEqual(back.rows[0].awayCtx, v3row.a);
    assert.strictEqual(back.rows[0].actualWinner, "home"); assert.strictEqual(back.rows[0].h2h, undefined);
    assert.strictEqual(back.meta.rowsVersion, 3);
  });
  await t("ブロックを1つ読めなかったら、1回読み直す。それでも読めなければ、番号を返す(黙って穴の開いたデータにしない)", async () => {
    const mock = createMockRedis();
    const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ d: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, l: 39, s: 2025, hi: 1, ai: 2, h: [0, 1, 1, 1, 0.5, 0, 10], a: [0, 1, 1, 1, 0.5, 0, 10], q: [0, 0, 0], hg: 1, ag: 0 }));
    await mock.upstashSetJSON(hb.backfillShardKey(0), rowsOf(5)); await mock.upstashSetJSON(hb.backfillShardKey(1), rowsOf(7)); await mock.upstashSetJSON(hb.backfillShardKey(2), rowsOf(3));
    await mock.upstashSetJSON(hb.BACKFILL_META_KEY, { rowsVersion: 4, shardCount: 3 });
    let failsLeft = 1; const tries = {};
    const flaky = async (k) => { tries[k] = (tries[k] || 0) + 1; if (k === hb.backfillShardKey(1) && failsLeft-- > 0) throw new Error("blip"); return mock.upstashGetJSON(k); };
    const ok = await hb.loadDataset({ upstashEnabled: true, upstashGetJSON: flaky });
    assert.strictEqual(ok.rows.length, 15, "読み直しで全部読めるはず"); assert.strictEqual(ok.failedShards, undefined); assert.strictEqual(tries[hb.backfillShardKey(1)], 2);
    const dead = async (k) => { if (k === hb.backfillShardKey(1)) throw new Error("down"); return mock.upstashGetJSON(k); };
    const bad = await hb.loadDataset({ upstashEnabled: true, upstashGetJSON: dead });
    assert.strictEqual(bad.rows.length, 8); assert.deepStrictEqual(bad.failedShards, [1]);
    // 学習側は、その事実を記録に残す
    const notes = [];
    await mt.ensureDataset({ upstashEnabled: true, upstashGetJSON: dead, upstashSetJSON: async () => false, callApiFootball: async () => ({ response: [] }), noteWarning: (tag, err) => notes.push(`${tag}:${err && err.message}`) }, RUN);
    assert.ok(notes.some((n) => /^backfill_shard_read_failed:blocks=1$/.test(n)), JSON.stringify(notes));
  });
  await t("保存の上限は 54,000 試合(45ブロック)。超えたら古い順に使わず、件数を返す", async () => {
    assert.strictEqual(hb.MAX_STORED_MATCHES, 54000); assert.strictEqual(hb.BACKFILL_MAX_SHARDS, 45); assert.ok(hb.BACKFILL_SHARD_SIZE * hb.BACKFILL_MAX_SHARDS >= hb.MAX_STORED_MATCHES);
    const big = [];
    for (let i = 0; i < 54300; i++) big.push({ fixture: { id: i + 1, date: new Date(Date.UTC(2022, 0, 1) + i * 60000).toISOString(), status: { short: "FT" } }, teams: { home: { id: 1, name: "a" }, away: { id: 2, name: "b" } }, goals: { home: 1, away: 0 } });
    const r = await hb.backfillSeasons({ callApiFootball: async () => ({ response: big }) }, { leagues: [{ id: 39, nameJa: "x" }], seasons: [2026] });
    assert.strictEqual(r.matches.length, 54000); assert.strictEqual(r.droppedOldest, 300); assert.strictEqual(r.matches[0].id, 301, "古い方から300件を使わない");
    assert.ok(/古い300試合は使っていません/.test(r.noteJa));
    const small = await hb.backfillSeasons({ callApiFootball: async () => ({ response: big.slice(0, 10) }) }, { leagues: [{ id: 39, nameJa: "x" }], seasons: [2026] });
    assert.strictEqual(small.droppedOldest, 0); assert.ok(!/使っていません/.test(small.noteJa));
  });

  console.log("■ 9. 画面・回答の文の「◯大会」");
  await t("足したリーグが0のあいだは、v101 までと1文字も変わらない。増えたら数と内訳が変わる", () => {
    resetActivation();
    assert.strictEqual(lc.learnedScopeNoteJa(), "AIが過去試合を学習しているのは15大会(欧州9リーグ+CL・EL・ECL+J1・イングランド2部・ブラジル全国選手権)です。それ以外の大会は学習データが無いため、予想は出しますが実力を測る集計とは分けています。");
    assert.strictEqual(lc.ratingsScopeJa(), "15大会×5シーズン(欧州カップ戦・J1・イングランド2部・ブラジルを含む)");
    assert.strictEqual(lc.clubScopeJa(), "15大会(欧州12大会+J1・イングランド2部・ブラジル全国選手権)");
    assert.ok(lc.classifyLearnedCompetition(999, "Major League Soccer").reasonJa.includes("学習しているのは15大会"));
    hb.setActivatedLeagues(NEW_IDS);
    assert.strictEqual(lc.learnedScopeNoteJa(), "AIが過去試合を学習しているのは31大会(欧州9リーグ+CL・EL・ECL+J1・イングランド2部・ブラジル全国選手権の15大会と、あとから加えた各国リーグ16大会)です。それ以外の大会は学習データが無いため、予想は出しますが実力を測る集計とは分けています。");
    assert.strictEqual(lc.ratingsScopeJa(), "31大会×5シーズン(欧州カップ戦・J1・イングランド2部・ブラジル・各国リーグ16大会を含む)");
    assert.strictEqual(lc.clubScopeJa(), "31大会(欧州12大会+J1・イングランド2部・ブラジル全国選手権+各国リーグ16大会)");
    assert.ok(lc.classifyLearnedCompetition(999, "x").reasonJa.includes("学習しているのは31大会"));
    resetActivation();
  });
  await t("サーバーと画面に「15大会」の決め打ちが残っていない(従来の文のための訳の行だけを残す)", () => {
    const srv = fs.readFileSync(path.join(S, "server.js"), "utf8");
    const srvCode = srv.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(!/15大会/.test(srvCode), "server.js のコードに 15大会 の決め打ちが残っている");
    assert.ok(srv.includes("learnedComp.clubScopeJa()") && srv.includes("learnedComp.ratingsScopeJa()") && srv.includes("noteJa: learnedComp.learnedScopeNoteJa()") && srv.includes("learnedCount: learnedComp.learnedCompetitionCount()"));
    assert.ok(srv.includes("(${learnedComp.learnedCompetitionCount()}大会×5シーズンの実試合からの初回学習)"));
    const html = fs.readFileSync(path.join(S, "index.html"), "utf8");
    // 画面のコード(辞書・型の行を除く)に決め打ちが無い
    const code = html.split("\n").filter((l) => /15大会/.test(l) && !/^\s*(\/\/|\[?"|\[")/.test(l) && !/^\s*\/\//.test(l));
    assert.deepStrictEqual(code.map((l) => l.trim().slice(0, 90)), ['const learnedLabel = Number.isFinite(Number(ls.learnedCount)) && Number(ls.learnedCount) > 0 ? `学習した大会(${Number(ls.learnedCount)}大会)` : "学習した大会(15大会)";'.slice(0, 90)],
      "画面のコードに 15大会 が残っている(古いサーバー向けの控えの1行だけのはず)");
    assert.ok(!html.includes("予測モデルは15大会"), "「このAIの予測モデルについて」に 15大会 が残っている");
    assert.ok(!html.includes("約200クラブ"), "「約200クラブ」の決め打ちが残っている");
    assert.ok(html.includes("rowOf(learnedLabel, ls.learned)"));
    // 新しい文の訳(型)がある
    for (const s of ['["学習した大会(⦿大会)", "Learned competitions ($1)"', "あとから加えた各国リーグ⦿大会)です。", "ブラジル・各国リーグ⦿大会を含む)の実試合⦿から", "(学習しているのは⦿大会)。参考予想として扱い"]) {
      assert.ok(html.includes(s), "訳の行が無い: " + s);
    }
  });
  await t("サーバー: 起動時に保存済みの目次を読んで学習リーグを反映する。読めなければ従来の15大会のまま(あとで読み直す)", async () => {
    resetActivation();
    process.env.PORT = String(41000 + Math.floor(Math.random() * 2000));
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "test";
    process.env.API_FOOTBALL_KEY = ""; process.env.ANTHROPIC_API_KEY = ""; process.env.LINEUP_WATCH = "0"; process.env.SELF_HEAL_DAILY_LEARNING = "0";
    const srv = require(path.join(S, "server.js"));
    const V = srv.__v102ForTest;
    assert.ok(V && typeof V.loadLearnedLeaguesFromStore === "function");
    const mock = createMockRedis();
    // ① 読めない保存先 → false・15大会のまま・失敗の理由が残る
    srv.__setTestHooks({ upstashGetJSON: async () => { throw new Error("store down"); } });
    V.resetLearnedLeaguesBootForTest();
    const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(" "));
    let ok1;
    try { ok1 = await V.loadLearnedLeaguesFromStore(); } finally { console.warn = orig; }
    assert.strictEqual(ok1, false); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15);
    assert.ok(/store down/.test(V.learnedLeaguesBoot().error)); assert.ok(warns.some((w) => /保存済みの学習リーグを読めませんでした/.test(w)));
    // ② 目次がある → 反映
    await mock.upstashSetJSON(hb.BACKFILL_META_KEY, { leagues: [...CORE_IDS, 179, 253, 141] });
    srv.__setTestHooks({ upstashGetJSON: mock.upstashGetJSON });
    assert.strictEqual(await V.loadLearnedLeaguesFromStore(), true);
    assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 18); assert.ok(V.learnedLeaguesBoot().loadedAt);
    // ③ 一度読めたら、もう読まない
    const n = mock.log.length; await V.loadLearnedLeaguesFromStore(); assert.strictEqual(mock.log.length, n);
    // ④ 目次が無い保存先(初回)→ 何もしないで成功(従来の15大会)
    resetActivation(); V.resetLearnedLeaguesBootForTest();
    srv.__setTestHooks({ upstashGetJSON: async () => null });
    assert.strictEqual(await V.loadLearnedLeaguesFromStore(), true); assert.strictEqual(lc.LEARNED_LEAGUE_IDS.size, 15);
    // ⑤ 日次レポート: 調整の履歴に「関門の種類・交差検証の要点・従来と同じ測り方の値」が載る。成長ログの新しい欄もそのまま出る
    const mock2 = createMockRedis();
    const nowIso = new Date().toISOString();
    const jstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    mock2.store.set("learn:modeltuning:log", [
      JSON.stringify({ date: jstToday, adopted: true, gateMode: "cv", method: "corpus_cv", oldEval: { logLoss: 1.0012 }, newEval: { logLoss: 0.9971 }, holdoutBaseEval: { logLoss: 1.0171 }, cv: { n: 36151, pooledGain: 0.0041, z: 4.56, positiveFolds: 4, foldsWithCandidate: 4 }, testSize: 13557, trainSize: 31633, datasetSize: 45190, leaguesInDataset: 31, reasonJa: "x".repeat(400) }),
      JSON.stringify({ date: "2026-11-16", adopted: false, oldEval: { logLoss: 1.0172, brier: 0.61 }, newEval: { logLoss: 1.0174, brier: 0.61 }, testSize: 6547, trainSize: 15277, datasetSize: 21824, reasonJa: "有意な改善なし" }),
    ]);
    const g = { date: jstToday, ranAt: nowIso, runsToday: 1, errors: [], warnings: { count: 0, items: [] },
      modelTuning: { ran: true, adopted: true, gateMode: "cv", method: "corpus_cv", cv: { n: 36151, pooledGain: 0.0041, z: 4.56 }, leagueChecks: { total: 16, ok: 15, rejected: 1, pending: 0, rows: [] }, learnedLeagueIds: [...CORE_IDS, 179], leaguesInDataset: 16 },
      oddsApi: { enabled: true, leaguesFetched: 7, usedInPredictions: 30, creditsUsedThisMonth: 211, monthlyBudget: 480, providerQuota: { remaining: 289, used: 211 } },
      marketBlendFit: { adopted: true, w: 0.85, mode: "cv", cv: { folds: 5, n: 1005 }, decision: "continue_updated", currentW: 0.9 } };
    await mock2.upstashSetJSON("learn:growthlog:latest", g);
    await mock2.upstashSetJSON(`learn:growthlog:${jstToday}`, g);
    srv.__setTestHooks({ upstashCmd: mock2.upstashCmd, upstashGetJSON: mock2.upstashGetJSON, upstashSetJSON: mock2.upstashSetJSON, callApiFootball: async () => ({ response: [] }) });
    const body = await new Promise((resolve, reject) => {
      require("http").get({ host: "127.0.0.1", port: Number(process.env.PORT), path: `/api/learning/daily-report?t=${Date.now()}` }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } }); }).on("error", reject);
    });
    assert.strictEqual(body.ok, true, JSON.stringify(body).slice(0, 300));
    const items = body.tuningHistory.items;
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual([items[0].gateMode, items[0].oldLogLoss, items[0].newLogLoss, items[0].holdoutLogLoss, items[0].cvN, items[0].cvGain, items[0].cvZ, items[0].cvPositiveFolds, items[0].leaguesInDataset],
      ["cv", 1.0012, 0.9971, 1.0171, 36151, 0.0041, 4.56, "4/4", 31]);
    assert.strictEqual(items[0].reasonJa.length, 300, "理由は300文字まで");
    assert.deepStrictEqual([items[1].gateMode, items[1].oldLogLoss, items[1].holdoutLogLoss, items[1].cvN], ["legacy", 1.0172, null, null], "v101 までの記録は legacy と出る(交差検証の欄は空)");
    assert.ok(/gateMode=\"cv\"/.test(body.tuningHistory.noteJa) && /holdoutLogLoss/.test(body.tuningHistory.noteJa) && /直接は比べられない/.test(body.tuningHistory.noteJa), body.tuningHistory.noteJa);
    assert.ok(!/検証用30%/.test(body.tuningHistory.noteJa));
    assert.deepStrictEqual(body.modelTuning.leagueChecks, g.modelTuning.leagueChecks); assert.strictEqual(body.modelTuning.learnedLeagueIds.length, 16);
    assert.deepStrictEqual(body.marketBlendFit, g.marketBlendFit);
    await new Promise((r) => srv.server.close(r));
    resetActivation();
  });

  console.log("■ 10. コンセンサス(複数社のオッズ)の月間クレジットの実測");
  await t("足した16リーグは、コンセンサスの対象にしていないことが明記されている(従来の15大会は全部対象のまま)", () => {
    assert.deepStrictEqual([...odds.NO_CONSENSUS_LEAGUE_IDS].sort((a, b) => a - b), NEW_IDS.slice().sort((a, b) => a - b));
    for (const id of CORE_IDS) assert.ok(odds.SPORT_KEYS[id], `${id} がコンセンサスの対象から外れた`);
    for (const id of NEW_IDS) assert.strictEqual(odds.SPORT_KEYS[id], undefined);
    assert.strictEqual(Object.keys(odds.SPORT_KEYS).length, 15, "対象の大会数が変わった(月の予算を取り合う)");
  });
  await t("今月の消費(自前のカウンター)を読める: 未使用の月は 0・保存先なし/読めないときは null(0 と区別)", async () => {
    const mock = createMockRedis();
    const now = Date.UTC(2026, 10, 17, 19, 17);
    assert.strictEqual(await odds.readCreditsUsed({ upstashCmd: mock.upstashCmd }, now), 0);
    assert.strictEqual(await odds.tryConsumeCredits({ upstashCmd: mock.upstashCmd, env: {} }, 1, now), true);
    assert.strictEqual(await odds.tryConsumeCredits({ upstashCmd: mock.upstashCmd, env: {} }, 1, now), true);
    assert.strictEqual(await odds.readCreditsUsed({ upstashCmd: mock.upstashCmd }, now), 2);
    assert.strictEqual(mock.store.get("oddsapi:credits:2026-11"), "2");
    assert.strictEqual(await odds.readCreditsUsed({ upstashCmd: mock.upstashCmd }, Date.UTC(2026, 11, 1)), 0, "月が変わったら別の数え");
    assert.strictEqual(await odds.readCreditsUsed({}, now), null); assert.strictEqual(await odds.readCreditsUsed(null, now), null);
    assert.strictEqual(await odds.readCreditsUsed({ upstashCmd: async () => { throw new Error("x"); } }, now), null);
    assert.strictEqual(await odds.readCreditsUsed({ upstashCmd: async () => "abc" }, now), null);
  });
  await t("提供元が応答ヘッダーで返す利用枠(残り・使用)を、取得の結果に付ける。無ければ null(でっち上げない)", async () => {
    const hdr = (o) => ({ get: (k) => (k in o ? o[k] : null) });
    assert.deepStrictEqual(odds.readQuotaHeaders({ headers: hdr({ "x-requests-remaining": "412", "x-requests-used": "88" }) }), { remaining: 412, used: 88 });
    assert.deepStrictEqual(odds.readQuotaHeaders({ headers: hdr({ "x-requests-remaining": "0" }) }), { remaining: 0, used: null });
    assert.strictEqual(odds.readQuotaHeaders({ headers: hdr({}) }), null); assert.strictEqual(odds.readQuotaHeaders({ headers: hdr({ "x-requests-remaining": "", "x-requests-used": "abc" }) }), null);
    assert.strictEqual(odds.readQuotaHeaders({}), null); assert.strictEqual(odds.readQuotaHeaders(null), null);
    assert.strictEqual(odds.readQuotaHeaders({ headers: { get: () => { throw new Error("x"); } } }), null);
    const mock = createMockRedis();
    const env = { ODDS_API_KEY: "k" };
    const okFetch = async () => ({ ok: true, status: 200, headers: hdr({ "x-requests-remaining": "400", "x-requests-used": "100" }), json: async () => [] });
    const r = await odds.fetchLeagueConsensus({ fetchFn: okFetch, upstashCmd: mock.upstashCmd, env }, 39, Date.UTC(2026, 10, 17));
    assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.quota, { remaining: 400, used: 100 });
    const ngFetch = async () => ({ ok: false, status: 429, headers: hdr({ "x-requests-remaining": "0", "x-requests-used": "500" }) });
    const r2 = await odds.fetchLeagueConsensus({ fetchFn: ngFetch, upstashCmd: mock.upstashCmd, env }, 39, Date.UTC(2026, 10, 17));
    assert.strictEqual(r2.ok, false); assert.strictEqual(r2.reason, "http_429"); assert.deepStrictEqual(r2.quota, { remaining: 0, used: 500 });
    // 足したリーグは取得しない(クレジットも使わない)
    const before = mock.store.get("oddsapi:credits:2026-11");
    assert.strictEqual(await odds.fetchLeagueConsensus({ fetchFn: okFetch, upstashCmd: mock.upstashCmd, env }, 179, Date.UTC(2026, 10, 17)), null);
    assert.strictEqual(mock.store.get("oddsapi:credits:2026-11"), before);
  });
  await t("成長ログの oddsApi に、今月の消費・月の予算・提供元の残りを残している", () => {
    const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    for (const s of ["creditsUsedThisMonth: oddsCreditsUsedThisMonth,", "monthlyBudget: oddsApiStats.enabled ? oddsApiMod.monthlyBudget(process.env) : null,", "providerQuota: oddsApiStats.providerQuota,", "if (r && r.quota) oddsApiStats.providerQuota = r.quota;", "oddsCreditsUsedThisMonth = await oddsApiMod.readCreditsUsed("]) {
      assert.ok(src.includes(s), "無い: " + s);
    }
  });

  console.log("■ 11. C: 予想の記録数・答え合わせの上限");
  await t("公開前モード: 記録 120件/日・学習した大会の全試合の枠 100件・答え合わせ 180件(120以上)。通常モードの値は変えていない", () => {
    const run = (env) => JSON.parse(execFileSync(process.execPath, ["-e", "const d=require('./learning/dailyJob');process.stdout.write(JSON.stringify([d.OWN_PREDICT_LOG_CAP,d.EXTRA_FIXTURES_CAP,d.OWN_PREDICT_RESOLVE_CAP,d.PRELAUNCH_LEARNING]))"],
      { cwd: S, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }));
    assert.deepStrictEqual(run({}), [120, 100, 180, true]);
    assert.deepStrictEqual(run({ PRELAUNCH_LEARNING: "0" }), [20, 0, 30, false]);
    assert.deepStrictEqual(run({ OWN_PREDICT_LOG_CAP: "150", EXTRA_FIXTURES_CAP: "130" }), [150, 130, 225, true]);
    assert.ok(run({})[2] >= 120 && run({})[2] > run({})[0], "答え合わせの上限が、記録の上限より多い(保留が溜まり続けない)");
  });

  console.log("■ 12. 市場ブレンドの比率(時系列の前向き検証)");
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const mix = (a, b, w) => ({ home: (1 - w) * a.home + w * b.home, draw: (1 - w) * a.draw + w * b.draw, away: (1 - w) * a.away + w * b.away });
  /** 自前の確率と、それとは独立にずれた市場の確率を持つ記録。truthOf(位置0〜1, 自前, 市場) が本当の確率 */
  function blendRecords(n, seed, truthOf) {
    const R = rng(seed); const recs = [];
    for (let i = 0; i < n; i++) {
      const lamH = 0.8 + R() * 1.4, lamA = 0.6 + R() * 1.2;
      const p = pm.computeMatchProbabilitiesRaw(lamH, lamA, undefined, 0);
      const model = { home: p.homeWin, draw: p.draw, away: p.awayWin };
      const j = (R() - 0.5) * 0.3;
      let mh = Math.min(0.85, Math.max(0.08, model.home + j)), md = 0.26, ma = Math.max(0.05, 1 - mh - md);
      const tot = mh + md + ma; mh /= tot; md /= tot; ma /= tot;
      const truth = truthOf(i / n, model, { home: mh, draw: md, away: ma });
      const u = R(); const actual = u < truth.home ? "home" : u < truth.home + truth.draw ? "draw" : "away";
      recs.push({ resolved: true, actualWinner: actual, homeLambda: lamH, awayLambda: lamA, marketImplied: { homePct: mh * 100, drawPct: md * 100, awayPct: ma * 100 }, weightsSnapshot: { rho: 0 } });
    }
    return recs;
  }
  await t("既定は前向きの検証(mode=cv)。MARKET_BLEND_FIT_MODE=holdout / opts.mode で v101 までの決め方に戻り、結果は従来の関数と同じ", () => {
    const recs = blendRecords(600, 11, (pos, m, k) => mix(m, k, 0.7));
    const cv = pm.fitMarketBlend(recs);
    assert.strictEqual(cv.mode, "cv"); assert.ok(cv.cv && cv.cv.folds === 5 && cv.cv.n === 480, JSON.stringify(cv.cv && { f: cv.cv.folds, n: cv.cv.n }));
    const legacy = pm.fitMarketBlendHoldout(recs);
    assert.deepStrictEqual(pm.fitMarketBlend(recs, { mode: "holdout" }), { ...legacy, mode: "holdout" });
    const saved = process.env.MARKET_BLEND_FIT_MODE; process.env.MARKET_BLEND_FIT_MODE = "holdout";
    try { assert.deepStrictEqual(pm.fitMarketBlend(recs), { ...legacy, mode: "holdout" }); } finally { if (saved === undefined) delete process.env.MARKET_BLEND_FIT_MODE; else process.env.MARKET_BLEND_FIT_MODE = saved; }
    // 開示用の曲線は v101 と同じ形(古い7割・新しい3割)+全件
    assert.strictEqual(cv.curve.length, 11);
    for (let i = 0; i < 11; i++) { assert.strictEqual(cv.curve[i].trainNll, legacy.curve[i].trainNll); assert.strictEqual(cv.curve[i].validNll, legacy.curve[i].validNll); assert.strictEqual(cv.curve[i].validAccPct, legacy.curve[i].validAccPct); assert.ok(Number.isFinite(cv.curve[i].allNll)); }
    assert.strictEqual(cv.marketAloneValidNll, legacy.marketAloneValidNll); assert.ok(cv.w <= 0.9);
  });
  await t("件数が足りないときは見送る(従来と同じ文)", () => {
    const r = pm.fitMarketBlend(blendRecords(39, 3, (pos, m, k) => k));
    assert.strictEqual(r.adopted, false); assert.strictEqual(r.w, 0); assert.strictEqual(r.samples, 39); assert.ok(/ブレンド学習に必要な40件に達していません/.test(r.reasonJa));
  });
  await t("各区間で試す比率は「それより前の記録」だけで選ぶ(後ろの記録を変えても、前の区間で試す比率は変わらない)", () => {
    const a = blendRecords(1000, 21, (pos, m, k) => mix(m, k, 0.7));
    const b = a.map((r, i) => (i >= 600 ? { ...r, actualWinner: r.actualWinner === "home" ? "away" : "home" } : r)); // 区間4・5の結果だけを変える
    const fa = pm.fitMarketBlend(a), fb = pm.fitMarketBlend(b);
    // 区間2・3(位置 200〜600)で試す比率は、区間1・2 までの記録で決まる → 同じ
    for (const k of [0, 1]) { assert.strictEqual(fb.cv.perBlock[k].wFromAllPast, fa.cv.perBlock[k].wFromAllPast); assert.strictEqual(fb.cv.perBlock[k].wFromRecent, fa.cv.perBlock[k].wFromRecent); assert.strictEqual(fb.cv.perBlock[k].bestWInBlock, fa.cv.perBlock[k].bestWInBlock); }
    // 区間4で試す比率も、区間1〜3 の記録で決まる → 同じ。区間5で試す比率は区間4を見るので、変わってよい
    assert.strictEqual(fb.cv.perBlock[2].wFromAllPast, fa.cv.perBlock[2].wFromAllPast);
    assert.deepStrictEqual(fa.cv.perBlock.map((x) => [x.block, x.size]), [[2, 200], [3, 200], [4, 200], [5, 200]]);
  });
  await t("いまブレンドしていない(w=0): 改善が確かめられたときだけ始める。市場がはっきり役に立つ世界では始まり、AI単独が正しい世界では始まらない", () => {
    let started = 0, wSum = 0;
    for (let seed = 1; seed <= 20; seed++) { const f = pm.fitMarketBlend(blendRecords(1250, seed * 7 + 3, (pos, m, k) => mix(m, k, 0.7)), { currentW: 0 }); if (f.adopted) { started++; wSum += f.w; assert.strictEqual(f.decision, "start"); assert.ok(f.cv.zVsAiOnly >= 1.64); } else assert.strictEqual(f.decision, "not_started"); }
    assert.ok(started >= 16, `市場7割の世界で始まった回数 ${started}/20`); assert.ok(Math.abs(wSum / started - 0.7) < 0.12, `平均の比率 ${(wSum / started).toFixed(2)}`);
    let falseStart = 0;
    for (let seed = 1; seed <= 40; seed++) { const f = pm.fitMarketBlend(blendRecords(1250, seed * 7 + 3, (pos, m) => m), { currentW: 0 }); if (f.adopted) falseStart++; else assert.ok(["not_started", "ai_only_best"].includes(f.decision)); }
    assert.ok(falseStart <= 3, `AI単独が正しい世界で、偶然に始まった回数 ${falseStart}/40`);
  });
  await t("いまブレンドしている(w=0.9): たまたま負けただけでは 0 に戻らない。比率は記録に合わせて動く(悪い比率に居座らない)", () => {
    // 市場7割の世界: 続ける。比率は 0.7 の近くへ
    let sum = 0, zero = 0;
    for (let seed = 1; seed <= 20; seed++) { const f = pm.fitMarketBlend(blendRecords(1250, seed * 7 + 3, (pos, m, k) => mix(m, k, 0.7)), { currentW: 0.9 }); if (!f.adopted) zero++; else sum += f.w; assert.strictEqual(f.currentW, 0.9); }
    assert.strictEqual(zero, 0, "市場が役に立つ世界で、ブレンドをやめた"); assert.ok(Math.abs(sum / 20 - 0.72) < 0.1, `平均の比率 ${(sum / 20).toFixed(2)}`);
    // AI単独が正しい世界: 0.9 に居座らない(0 か、小さい比率へ)
    let stay = 0, wAvg = 0;
    for (let seed = 1; seed <= 30; seed++) { const f = pm.fitMarketBlend(blendRecords(1250, seed * 7 + 3, (pos, m) => m), { currentW: 0.9 }); const w = f.adopted ? f.w : 0; wAvg += w / 30; if (w >= 0.85) stay++; }
    assert.strictEqual(stay, 0, "悪い比率 0.9 に居座った"); assert.ok(wAvg < 0.2, `平均の比率 ${wAvg.toFixed(2)}`);
  });
  await t("いまの比率と最良の比率の差がごく小さいときは、いまの比率を変えない(日ごとに行ったり来たりさせない)", () => {
    let kept = 0, moved = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const recs = blendRecords(1250, seed * 7 + 3, (pos, m, k) => mix(m, k, 0.7));
      const f = pm.fitMarketBlend(recs, { currentW: 0.7 });
      assert.strictEqual(f.adopted, true);
      if (f.decision === "continue_kept_ratio") { kept++; assert.strictEqual(f.w, 0.7); assert.notStrictEqual(f.bestW, 0.7); assert.ok(/いまの比率を変えません/.test(f.reasonJa)); }
      else if (f.decision === "continue_updated") { moved++; assert.strictEqual(f.w, f.bestW); assert.ok(Math.abs(f.w - 0.7) >= 0.05); }
      else assert.strictEqual(f.decision, "continue_same");
    }
    assert.ok(kept >= 10, `差が小さくて据え置いた回数 ${kept}/30`); assert.ok(moved <= 12, `動いた回数 ${moved}/30`);
  });
  await t("毎日の学習は「いま使っている比率」を先に読んで渡す。重みを読めなかった日は反映しない(従来どおり失敗として記録)", () => {
    const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    const iRead = src.indexOf("blendRead = await readWeightsStrict();");
    const iFit = src.indexOf("const fitB = fitMarketBlend(recentForBlend, { currentW:");
    assert.ok(iRead > 0 && iFit > iRead, "比率を読む前に学習している");
    assert.ok(src.includes("if (upstashEnabled && !blendReadError && fitB && fitB.samples >= MIN_SAMPLES_FOR_BLEND_CHANGE) {"));
    assert.ok(src.includes("throw new Error(`weights_read_failed:${blendReadError}(保存済みの重みを読み出せなかったため見送り)`);"));
    assert.ok(src.includes('mode: marketBlendFitToday.mode || "holdout",') && src.includes("cv: marketBlendFitToday.cv ?? null,"));
  });

  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
