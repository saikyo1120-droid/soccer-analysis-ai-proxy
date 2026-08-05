/**
 * 2026年8月・優先順位⑥(主要リーグのKnowledge Engine日次蓄積)のテスト。
 * server/learning/leagueKnowledge.js(収集本体)とleagueConfig.js(対象リーグ・
 * ID解決)の両方を、モックAPI-Footballで検証する。
 */
const assert = require("assert");
const {
  collectLeagueKnowledge, formatStandingsStatement, formatTopListStatement,
  pickTodaysExtendedLeagues,
} = require("../server/learning/leagueKnowledge");
const { MANDATORY_LEAGUES, EXTENDED_LEAGUES, resolveLeagueId } = require("../server/learning/leagueConfig");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") { const [k, s, e] = args; const l = store.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; return l.slice(start, end + 1); }
    if (op === "LTRIM") { const [k, s, e] = args; const l = store.get(k) || []; let start = parseInt(s, 10), end = parseInt(e, 10); if (start < 0) start = Math.max(0, l.length + start); if (end < 0) end = l.length + end; store.set(k, l.slice(start, end + 1)); return "OK"; }
    throw new Error("unimplemented: " + op);
  }
  async function upstashGetJSON(key) { const raw = await upstashCmd(["GET", key]); return raw === null ? null : JSON.parse(raw); }
  async function upstashSetJSON(key, value) { await upstashCmd(["SET", key, JSON.stringify(value)]); return true; }
  return { upstashCmd, upstashGetJSON, upstashSetJSON };
}

const SAMPLE_STANDINGS = {
  response: [{ league: { standings: [[
    { rank: 1, team: { name: "Arsenal" }, points: 55, all: { played: 22 }, form: "WWWDW" },
    { rank: 2, team: { name: "Man City" }, points: 53, all: { played: 22 }, form: "WWDWL" },
    { rank: 3, team: { name: "Liverpool" }, points: 50, all: { played: 22 }, form: "WDWWW" },
    { rank: 4, team: { name: "Chelsea" }, points: 45, all: { played: 22 }, form: "WLWDW" },
    { rank: 5, team: { name: "Man United" }, points: 40, all: { played: 22 }, form: "LWWDL" },
    { rank: 6, team: { name: "Tottenham" }, points: 38, all: { played: 22 }, form: "DWLWL" },
    { rank: 7, team: { name: "Newcastle" }, points: 35, all: { played: 22 }, form: "WLDWL" },
    { rank: 18, team: { name: "Ipswich" }, points: 15, all: { played: 22 }, form: "LLLDL" },
    { rank: 19, team: { name: "Southampton" }, points: 12, all: { played: 22 }, form: "LLLLL" },
    { rank: 20, team: { name: "Sheffield United" }, points: 10, all: { played: 22 }, form: "LLLLD" },
  ]] } }],
};
const SAMPLE_TOPSCORERS = {
  response: [
    { player: { name: "E. Haaland" }, statistics: [{ team: { name: "Man City" }, goals: { total: 20, assists: 3 } }] },
    { player: { name: "M. Salah" }, statistics: [{ team: { name: "Liverpool" }, goals: { total: 18, assists: 10 } }] },
  ],
};
const SAMPLE_TOPASSISTS = {
  response: [
    { player: { name: "K. De Bruyne" }, statistics: [{ team: { name: "Man City" }, goals: { total: 5, assists: 15 } }] },
  ],
};

(async () => {
  // ---- 純粋関数: フォーマッタ ----
  await test("formatStandingsStatement: 上位6+下位3を抜粋し、実データの順位/勝点/試合数を含む", () => {
    const league = { nameJa: "プレミアリーグ", countryJa: "イングランド" };
    const s = formatStandingsStatement(league, SAMPLE_STANDINGS.response);
    assert.ok(s.includes("1位Arsenal"), "1位が含まれるはず: " + s);
    assert.ok(s.includes("55pt"), "勝点が含まれるはず: " + s);
    assert.ok(s.includes("22試合"), "消化試合数が含まれるはず: " + s);
    assert.ok(s.includes("20位Sheffield United"), "下位(降格圏想定)も含まれるはず: " + s);
    // 注意: "8位"のような数字部分文字列での判定は"18位"に誤マッチするため使わない。
    // 抜粋対象外(7位)のチーム名がまるごと含まれていないことで判定する。
    assert.ok(!s.includes("Newcastle"), "抜粋対象外の中位チーム(7位)は含まれないはず: " + s);
  });
  await test("formatStandingsStatement: 文中に日付を埋め込まない(内容が同じなら重複排除できるようにするため)", () => {
    const league = { nameJa: "プレミアリーグ", countryJa: "イングランド" };
    const s = formatStandingsStatement(league, SAMPLE_STANDINGS.response);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(s), "文中にYYYY-MM-DD形式の日付が含まれてはいけない: " + s);
  });
  await test("formatStandingsStatement: データが空ならnullを返す(でっち上げない)", () => {
    const league = { nameJa: "X", countryJa: "Y" };
    assert.strictEqual(formatStandingsStatement(league, []), null);
    assert.strictEqual(formatStandingsStatement(league, null), null);
  });
  await test("formatTopListStatement: 得点ランキング上位5を実データから生成する", () => {
    const league = { nameJa: "プレミアリーグ", countryJa: "イングランド" };
    const s = formatTopListStatement(league, SAMPLE_TOPSCORERS.response, "goals");
    assert.ok(s.includes("1位E. Haaland"), s);
    assert.ok(s.includes("20ゴール"), s);
    assert.ok(s.includes("得点ランキング"), s);
  });
  await test("formatTopListStatement: アシストランキングは正しくassists値を使う(goals.totalと混同しない)", () => {
    const league = { nameJa: "プレミアリーグ", countryJa: "イングランド" };
    const s = formatTopListStatement(league, SAMPLE_TOPASSISTS.response, "assists");
    assert.ok(s.includes("15アシスト"), "De Bruyneのアシスト数15が使われるはず(ゴール数5と混同しない): " + s);
    assert.ok(s.includes("アシストランキング"), s);
  });

  // ---- pickTodaysExtendedLeagues: 日付ベースのローテーション ----
  await test("pickTodaysExtendedLeagues: 常にEXTENDED_LEAGUE_CHECK_CAP(2)件を選ぶ", () => {
    const picked = pickTodaysExtendedLeagues("2026-08-04");
    assert.strictEqual(picked.length, 2);
  });
  await test("pickTodaysExtendedLeagues: 同じ日付なら常に同じ選択になる(冪等性)", () => {
    const a = pickTodaysExtendedLeagues("2026-08-04").map((l) => l.nameEn);
    const b = pickTodaysExtendedLeagues("2026-08-04").map((l) => l.nameEn);
    assert.deepStrictEqual(a, b);
  });
  await test("pickTodaysExtendedLeagues: 日付が変われば選択も変わりうる(全リーグがいずれ一巡する)", () => {
    const seen = new Set();
    for (let d = 1; d <= 10; d++) {
      const dateKey = `2026-08-${String(d).padStart(2, "0")}`;
      pickTodaysExtendedLeagues(dateKey).forEach((l) => seen.add(l.nameEn + l.countryJa));
    }
    assert.strictEqual(seen.size, EXTENDED_LEAGUES.length, "10日あれば拡張5リーグすべてが少なくとも1度は選ばれるはず");
  });

  // ---- collectLeagueKnowledge: 統合テスト(モックAPI-Football) ----
  function makeMockCallApiFootball(calls) {
    return async (endpoint, params) => {
      calls.push({ endpoint, params: { ...params } });
      if (endpoint === "/standings") return SAMPLE_STANDINGS;
      if (endpoint === "/players/topscorers") return SAMPLE_TOPSCORERS;
      if (endpoint === "/players/topassists") return SAMPLE_TOPASSISTS;
      if (endpoint === "/leagues") {
        // 拡張リーグのID解決(名前+国で検索)。テスト用に適当なIDを返す。
        return { response: [{ league: { id: 9000 + (params.name ? params.name.length : 0) } }] };
      }
      return { response: [] };
    };
  }

  await test("collectLeagueKnowledge: 必須5リーグは毎日必ず処理される(順位表+得点+アシストの3コール/リーグ)", async () => {
    const calls = [];
    const callApiFootball = makeMockCallApiFootball(calls);
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const result = await collectLeagueKnowledge(
      { callApiFootball, knowledgeStore, upstashEnabled: true, ...createMockRedis() },
      new Date("2026-08-04T09:00:00Z"), "2026-08-04"
    );
    assert.strictEqual(result.mandatoryLeaguesProcessed, MANDATORY_LEAGUES.length, "必須リーグはすべて処理されるはず");
    const standingsCalls = calls.filter((c) => c.endpoint === "/standings");
    assert.ok(standingsCalls.length >= MANDATORY_LEAGUES.length, "必須リーグの数だけ/standingsが呼ばれるはず");
  });

  await test("collectLeagueKnowledge: 拡張リーグはローテーションでEXTENDED_LEAGUE_CHECK_CAP件だけ処理される", async () => {
    const calls = [];
    const callApiFootball = makeMockCallApiFootball(calls);
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const result = await collectLeagueKnowledge(
      { callApiFootball, knowledgeStore, upstashEnabled: true, ...createMockRedis() },
      new Date("2026-08-04T09:00:00Z"), "2026-08-04"
    );
    assert.strictEqual(result.extendedLeaguesProcessed, 2);
  });

  await test("collectLeagueKnowledge: 新規の順位表・ランキングは事実として保存される", async () => {
    const calls = [];
    const callApiFootball = makeMockCallApiFootball(calls);
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const result = await collectLeagueKnowledge(
      { callApiFootball, knowledgeStore, upstashEnabled: true, ...createMockRedis() },
      new Date("2026-08-04T09:00:00Z"), "2026-08-04"
    );
    // 必須5リーグ x 3種(順位表/得点/アシスト) = 15件が初回はすべて新規のはず
    assert.strictEqual(result.leagueFactsSavedToday, (MANDATORY_LEAGUES.length + 2) * 3);
    assert.strictEqual(result.leagueFactsDuplicateToday, 0);
  });

  await test("collectLeagueKnowledge: 翌日も順位表・ランキングの内容が変わらなければ重複として扱われ、知識ベースが際限なく膨らまない", async () => {
    // 文中に日付を埋め込まない設計(formatStandingsStatement参照)により、
    // 「本当に内容が変わった時だけ新しい事実になる」ことを、日付をまたいだ
    // 2回の実行(かつ同じモックデータ=順位表に変化が無いシナリオ)で確認する。
    const calls = [];
    const callApiFootball = makeMockCallApiFootball(calls);
    const mockRedis = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mockRedis });
    const deps = { callApiFootball, knowledgeStore, upstashEnabled: true, ...mockRedis };
    const run1 = await collectLeagueKnowledge(deps, new Date("2026-08-04T09:00:00Z"), "2026-08-04");
    assert.ok(run1.leagueFactsSavedToday > 0, "初回はすべて新規のはず");
    assert.strictEqual(run1.leagueFactsDuplicateToday, 0);
    // 同じ日付で再実行(Renderの再起床待ち等の重複実行を想定): 完全に重複扱い。
    const run2 = await collectLeagueKnowledge(deps, new Date("2026-08-04T15:00:00Z"), "2026-08-04");
    assert.strictEqual(run2.leagueFactsSavedToday, 0, "同じ日付・同じ内容の再実行はすべて重複になるはず");
    assert.strictEqual(run2.leagueFactsDuplicateToday, run1.leagueFactsSavedToday);
    // 翌日、順位表・ランキングの中身(モックデータ)が一切変わっていなければ、
    // 必須5リーグ分は日付をまたいでも重複として扱われるはず(拡張リーグは
    // ローテーションの都合で対象が変わりうるため、必須リーグの重複件数のみで検証する)。
    const run3 = await collectLeagueKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.ok(run3.leagueFactsDuplicateToday >= MANDATORY_LEAGUES.length * 3, `必須5リーグ分(${MANDATORY_LEAGUES.length * 3}件)は日付が変わっても内容が同じなら重複扱いになるはず, got ${run3.leagueFactsDuplicateToday}`);
  });

  await test("collectLeagueKnowledge: 1つのリーグでAPI呼び出しが失敗しても、他のリーグの処理は継続する", async () => {
    const calls = [];
    let standingsCallCount = 0;
    const callApiFootball = async (endpoint, params) => {
      calls.push({ endpoint, params });
      if (endpoint === "/standings") {
        standingsCallCount++;
        if (standingsCallCount === 1) throw new Error("simulated API failure");
        return SAMPLE_STANDINGS;
      }
      if (endpoint === "/players/topscorers") return SAMPLE_TOPSCORERS;
      if (endpoint === "/players/topassists") return SAMPLE_TOPASSISTS;
      if (endpoint === "/leagues") return { response: [{ league: { id: 9001 } }] };
      return { response: [] };
    };
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...createMockRedis() });
    const result = await collectLeagueKnowledge(
      { callApiFootball, knowledgeStore, upstashEnabled: true, ...createMockRedis() },
      new Date("2026-08-04T09:00:00Z"), "2026-08-04"
    );
    assert.ok(result.errors.some((e) => e.includes("league_standings_failed")), "1件のエラーが記録されるはず");
    assert.ok(result.leagueFactsSavedToday > 0, "他のリーグ・他のデータ種別は正常に処理され続けるはず");
  });

  await test("resolveLeagueId: 一度解決したIDはUpstashにキャッシュされ、2回目は/leaguesを呼ばない", async () => {
    const calls = [];
    const callApiFootball = async (endpoint, params) => {
      calls.push(endpoint);
      if (endpoint === "/leagues") return { response: [{ league: { id: 12345 } }] };
      return { response: [] };
    };
    const mockRedis = createMockRedis();
    const league = { id: null, nameEn: "Test League", countryJa: "テスト国", searchCountry: "Testland" };
    const id1 = await resolveLeagueId(league, { callApiFootball, upstashEnabled: true, ...mockRedis });
    const id2 = await resolveLeagueId(league, { callApiFootball, upstashEnabled: true, ...mockRedis });
    assert.strictEqual(id1, 12345);
    assert.strictEqual(id2, 12345);
    assert.strictEqual(calls.filter((c) => c === "/leagues").length, 1, "2回目はキャッシュを使い、/leaguesを再度呼ばないはず");
  });

  await test("resolveLeagueId: 既にidが確定しているリーグ(必須5リーグ等)はAPIを呼ばずそのまま返す", async () => {
    const calls = [];
    const callApiFootball = async (endpoint) => { calls.push(endpoint); return { response: [] }; };
    const id = await resolveLeagueId(MANDATORY_LEAGUES[0], { callApiFootball, upstashEnabled: true, ...createMockRedis() });
    assert.strictEqual(id, MANDATORY_LEAGUES[0].id);
    assert.strictEqual(calls.length, 0);
  });

  await test("resolveLeagueId: 該当リーグが見つからない場合は正直にnullを返す(架空のIDを作らない)", async () => {
    const callApiFootball = async () => ({ response: [] });
    const league = { id: null, nameEn: "存在しないリーグ", countryJa: "どこか", searchCountry: "Nowhere" };
    const id = await resolveLeagueId(league, { callApiFootball, upstashEnabled: true, ...createMockRedis() });
    assert.strictEqual(id, null);
  });

  console.log(failures === 0 ? "\nAll league-knowledge (優先順位⑥) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
