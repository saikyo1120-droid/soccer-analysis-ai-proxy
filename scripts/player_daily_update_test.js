/**
 * 2026年8月・優先順位⑦「選手情報を毎日更新」のテスト
 * (server/learning/playerDailyUpdate.js)。
 *
 * 最重要の検証点はご要望の「更新できなかった項目は理由を残してください」。
 * 16項目それぞれについて、取得できた/できなかった、できなかった場合は
 * その理由が必ず残ることを検証する。
 */
const assert = require("assert");
const {
  collectPlayerKnowledge, pickTodaysPlayers, buildFieldStatus, formatPlayerStatement,
  countFieldStatus, describeRatingTrend, summarizeRecentFixtures, pickPrimaryStats,
  FIELD_SPECS,
} = require("../server/learning/playerDailyUpdate");
const { createApiBudget } = require("../server/learning/apiBudget");
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
  return { upstashCmd, upstashGetJSON, upstashSetJSON, store };
}

const TEST_PLAYERS = [
  { key: "messi", nameJa: "リオネル・メッシ", nameEn: "Lionel Messi", clubJa: "インテル・マイアミ", staticFoot: "左足", staticContractNote: "フリー移籍・前所属:パリ・サンジェルマン・2023年7月" },
  { key: "haaland", nameJa: "アーリング・ハーランド", nameEn: "Erling Haaland", clubJa: "マンチェスター・シティ", staticFoot: "左足", staticContractNote: "完全移籍・前所属:ドルトムント・2022年7月" },
  { key: "bellingham", nameJa: "ジュード・ベリンガム", nameEn: "Jude Bellingham", clubJa: "レアル・マドリード", staticFoot: "右足", staticContractNote: "完全移籍・前所属:ドルトムント・2023年6月" },
  { key: "saka", nameJa: "ブカヨ・サカ", nameEn: "Bukayo Saka", clubJa: "アーセナルFC", staticFoot: "左足", staticContractNote: null },
];

function makeMockApi(calls, overrides) {
  const o = overrides || {};
  return async function callApiFootball(endpoint, params) {
    calls.push({ endpoint, params });
    if (o[endpoint]) return o[endpoint](params);
    if (endpoint === "/players" && params.search) {
      return { response: [{ player: { id: 100 + params.search.length }, statistics: [] }] };
    }
    if (endpoint === "/players" && params.id) {
      return { response: [{
        player: { id: params.id, name: "Mock Player", age: 27, height: "181 cm", nationality: "Argentina", injured: false },
        statistics: [
          { team: { id: 9001, name: "Mock FC" }, games: { position: "Attacker", appearences: 20, minutes: 1700, rating: "7.45" }, goals: { total: 12, assists: 8 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {} },
          { team: { id: 9001, name: "Mock FC" }, games: { position: "Attacker", appearences: 3, minutes: 200, rating: "6.90" }, goals: { total: 1, assists: 0 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {} },
        ],
      }] };
    }
    if (endpoint === "/transfers") {
      return { response: [{ transfers: [{ date: "2023-07-15", type: "Free", teams: { out: { name: "Old FC" }, in: { name: "Mock FC" } } }] }] };
    }
    if (endpoint === "/injuries") {
      return { response: [{ player: { type: "Muscle Injury", reason: "Hamstring" } }] };
    }
    if (endpoint === "/fixtures") {
      const now = Date.now();
      const list = [];
      for (let i = 0; i < 10; i++) {
        list.push({
          fixture: { id: i + 1, date: new Date(now - i * 86400e3).toISOString() },
          teams: { home: { id: 9001 }, away: { id: 7 } },
          goals: { home: i < 6 ? 3 : 0, away: i < 6 ? 1 : 2 },
        });
      }
      return { response: list };
    }
    return { response: [] };
  };
}

function makeDeps(calls, overrides, mockRedis, budget) {
  const mock = mockRedis || createMockRedis();
  return {
    callApiFootball: makeMockApi(calls, overrides),
    knowledgeStore: createKnowledgeStore({ upstashEnabled: true, ...mock }),
    upstashEnabled: true,
    upstashGetJSON: mock.upstashGetJSON,
    upstashSetJSON: mock.upstashSetJSON,
    apiBudget: budget,
    playerUpdateCap: 2,
    playerList: TEST_PLAYERS,
    _mock: mock,
  };
}

(async () => {
  // ---- 純粋関数 ----
  await test("FIELD_SPECS: ご要望の16項目をすべて宣言している", () => {
    const expected = ["age", "club", "position", "foot", "height", "nationality", "appearances", "goals", "assists", "injury", "marketValue", "contract", "transfers", "recent5", "recent10", "ratingTrend"];
    assert.strictEqual(FIELD_SPECS.length, 16, "16項目あるはず, got " + FIELD_SPECS.length);
    for (const k of expected) {
      assert.ok(FIELD_SPECS.some((s) => s.key === k), `${k} が宣言されているはず`);
    }
  });

  await test("pickTodaysPlayers: 指定件数だけ選び、同じ日なら同じ結果になる(冪等)", () => {
    const a = pickTodaysPlayers("2026-08-05", 2, TEST_PLAYERS);
    const b = pickTodaysPlayers("2026-08-05", 2, TEST_PLAYERS);
    assert.strictEqual(a.length, 2);
    assert.deepStrictEqual(a.map((p) => p.key), b.map((p) => p.key));
  });

  await test("pickTodaysPlayers: 日付が変われば別の選手が選ばれ、いずれ全員が一巡する", () => {
    const seen = new Set();
    for (let d = 1; d <= 20; d++) {
      const day = `2026-08-${String(d).padStart(2, "0")}`;
      pickTodaysPlayers(day, 2, TEST_PLAYERS).forEach((p) => seen.add(p.key));
    }
    assert.strictEqual(seen.size, TEST_PLAYERS.length, `20日以内に全${TEST_PLAYERS.length}名が対象になるはず, got ${seen.size}`);
  });

  await test("pickPrimaryStats: 出場数が最も多い大会のブロックを主戦場として選ぶ", () => {
    const picked = pickPrimaryStats([
      { games: { appearences: 3 }, team: { name: "CupOnly" } },
      { games: { appearences: 25 }, team: { name: "League" } },
    ]);
    assert.strictEqual(picked.team.name, "League");
  });

  await test("summarizeRecentFixtures: ホーム/アウェイを取り違えずに勝敗を数える", () => {
    const now = Date.now();
    const fixtures = [
      { fixture: { id: 1, date: new Date(now).toISOString() }, teams: { home: { id: 5 }, away: { id: 9 } }, goals: { home: 2, away: 0 } }, // 勝
      { fixture: { id: 2, date: new Date(now - 1e5).toISOString() }, teams: { home: { id: 9 }, away: { id: 5 } }, goals: { home: 3, away: 1 } }, // 敗(アウェイ)
      { fixture: { id: 3, date: new Date(now - 2e5).toISOString() }, teams: { home: { id: 9 }, away: { id: 5 } }, goals: { home: 1, away: 1 } }, // 分
    ];
    const s = summarizeRecentFixtures(fixtures, 5, 5);
    assert.deepStrictEqual({ played: s.played, w: s.w, d: s.d, l: s.l }, { played: 3, w: 1, d: 1, l: 1 });
    assert.strictEqual(s.gf, 2 + 1 + 1);
    assert.strictEqual(s.ga, 0 + 3 + 1);
  });

  await test("summarizeRecentFixtures: 未終了(スコアがnull)の試合は数えない(でっち上げない)", () => {
    const s = summarizeRecentFixtures([
      { fixture: { id: 1, date: new Date().toISOString() }, teams: { home: { id: 5 }, away: { id: 9 } }, goals: { home: null, away: null } },
    ], 5, 5);
    assert.strictEqual(s, null);
  });

  await test("describeRatingTrend: 文面に「記録回数」を埋め込まない(知識の水増し防止)", () => {
    // 第5次監査で発見した重大な欠陥への回帰テスト。
    // 以前は「記録N回」という毎日1ずつ増えるカウンターを文面に入れていたため、
    // 選手の成績がまったく変わっていない日でも文面のハッシュが変わり、
    // 「今日も新しい知識が増えました」と毎日報告されていた(成長の自作自演)。
    const t = describeRatingTrend([{ date: "2026-08-05", rating: 7.4 }]);
    assert.ok(t.includes("7.40"), t);
    assert.ok(!/記録\d+回/.test(t), "記録回数を文面に入れてはいけない: " + t);
  });

  await test("describeRatingTrend: 評価が同じ日が続いても文面が変わらない(重複排除が効く)", () => {
    // 同じ評価が4日続いた場合、文面は完全に同一でなければならない。
    // 文面が変わると Knowledge Engine が「新しい知識」として数えてしまう。
    const history = [];
    const seen = new Set();
    for (let day = 1; day <= 4; day++) {
      history.push({ date: `2026-08-0${day}`, rating: 7.2 });
      seen.add(describeRatingTrend(history));
    }
    assert.strictEqual(seen.size, 1, "評価が変わっていないのに文面が変わっている: " + Array.from(seen).join(" | "));
  });

  await test("describeRatingTrend: 十分な記録があれば上昇/下降を判定する", () => {
    // 2026年8月・第6次監査での設計変更に追随。
    //   以前は「初回の値」を基準に判定していたが、その値は記録が上限(60件)に
    //   達すると窓がずれて毎日変わるため、評価が動いていなくても文面が毎日変わり、
    //   知識件数が水増しされ続けていた(60日後に必ず発火する時限式の欠陥)。
    //   現在は「直近5件の平均」と「その前5件の平均」を比べる。どちらの窓も
    //   直近10件の中だけで動くので、古い記録が押し出されても判定は変わらない。
    //   その代わり、傾向を言うには最低6件の記録が必要になる(2件では
    //   上昇か偶然かを区別できないため、断定しないのが正しい)。
    const mk = (ratings) => ratings.map((r, i) => ({ date: "d" + i, rating: r }));
    const up = describeRatingTrend(mk([7.0, 7.0, 7.0, 7.0, 7.0, 7.5, 7.5, 7.5, 7.5, 7.5]));
    assert.ok(up.includes("上昇"), up);
    const down = describeRatingTrend(mk([7.5, 7.5, 7.5, 7.5, 7.5, 7.0, 7.0, 7.0, 7.0, 7.0]));
    assert.ok(down.includes("下降"), down);
  });

  await test("describeRatingTrend: 記録が少ないうちは傾向を断定しない(でっち上げ防止)", () => {
    const t = describeRatingTrend([{ date: "a", rating: 7.0 }, { date: "b", rating: 7.3 }]);
    assert.ok(t.includes("7.30"), t);
    assert.ok(!t.includes("上昇") && !t.includes("下降"), "2件だけで傾向を断定してはいけない: " + t);
  });

  await test("describeRatingTrend: 記録が上限(60件)に達しても、評価が動かない日は文面が変わらない", () => {
    // 60件の窓から古い記録が押し出されることで文面が変わる、という
    // 時限式の水増しが再発しないことを確認する。
    let h = [];
    for (let i = 0; i < 60; i++) h.push({ date: "d" + i, rating: 6.5 + i * 0.02 });
    const seen = new Set();
    for (let d = 0; d < 40; d++) {
      h.push({ date: "x" + d, rating: h[h.length - 1].rating });
      h = h.slice(-60);
      seen.add(describeRatingTrend(h));
    }
    assert.strictEqual(seen.size, 1, "窓がずれただけで文面が変わっている: " + Array.from(seen).join(" | "));
  });

  await test("describeRatingTrend: 評価が1件も無ければnull(0.00などをでっち上げない)", () => {
    assert.strictEqual(describeRatingTrend([]), null);
    assert.strictEqual(describeRatingTrend([{ date: "a", rating: null }]), null);
  });

  // ---- 「更新できなかった理由」の検証(ご要望の中心) ----
  await test("buildFieldStatus: 利き足・市場価値・契約はAPIに存在しないため恒久的に取得不可で、理由と代替案が残る", () => {
    const st = buildFieldStatus({ player: TEST_PLAYERS[0], apiPlayer: null, primaryStats: null, realStats: null, transfers: null, injuries: null, recent5: null, recent10: null, ratingHistory: null, notes: {} });
    for (const key of ["foot", "marketValue", "contract"]) {
      assert.strictEqual(st[key].ok, false, `${key} は取得不可のはず`);
      assert.strictEqual(st[key].permanent, true, `${key} は恒久的に取得不可(明日も取れない)と分類されるはず`);
      assert.ok(st[key].reason && st[key].reason.length > 20, `${key} に十分な説明の理由があるはず: ${st[key].reason}`);
      assert.ok(/代替|別データソース|別API/.test(st[key].reason), `${key} の理由に代替案が含まれるはず: ${st[key].reason}`);
    }
  });

  await test("buildFieldStatus: 利き足・契約には、アプリ内の手動登録データが参考値として併記される", () => {
    const st = buildFieldStatus({ player: TEST_PLAYERS[0], apiPlayer: null, primaryStats: null, realStats: null, transfers: null, injuries: null, recent5: null, recent10: null, ratingHistory: null, notes: {} });
    assert.ok(st.foot.reason.includes("左足"), "手動データの利き足が併記されるはず: " + st.foot.reason);
    assert.ok(st.foot.reason.includes("最新性は保証されません"), "手動データであることの注意書きがあるはず");
    assert.ok(st.contract.reason.includes("フリー移籍"), "手動データの契約情報が併記されるはず: " + st.contract.reason);
  });

  await test("buildFieldStatus: 手動データが無い選手には、存在しない参考値をでっち上げない", () => {
    const st = buildFieldStatus({ player: TEST_PLAYERS[3], apiPlayer: null, primaryStats: null, realStats: null, transfers: null, injuries: null, recent5: null, recent10: null, ratingHistory: null, notes: {} });
    assert.ok(!st.contract.reason.includes("アプリ内の手動登録データでは"), "契約の手動データが無いのに併記してはいけない: " + st.contract.reason);
  });

  await test("buildFieldStatus: 取得できた項目には値が入り、理由はnullになる", () => {
    const st = buildFieldStatus({
      player: TEST_PLAYERS[0],
      apiPlayer: { age: 39, height: "170 cm", nationality: "Argentina", injured: false },
      primaryStats: { team: { id: 1, name: "Inter Miami" } },
      realStats: { position: "Attacker", appearances: 20, goals: 12, assists: 8, avgRating: 7.45 },
      transfers: [{ date: "2023-07-15", type: "Free", teams: { out: { name: "PSG" }, in: { name: "Inter Miami" } } }],
      injuries: null,
      recent5: { played: 5, w: 3, d: 1, l: 1, gf: 9, ga: 5 },
      recent10: { played: 10, w: 6, d: 2, l: 2, gf: 18, ga: 10 },
      ratingHistory: [{ date: "2026-08-05", rating: 7.45 }],
      notes: {},
    });
    assert.strictEqual(st.age.ok, true); assert.strictEqual(st.age.value, "39歳"); assert.strictEqual(st.age.reason, null);
    assert.strictEqual(st.club.value, "Inter Miami");
    assert.strictEqual(st.position.value, "Attacker");
    assert.strictEqual(st.height.value, "170 cm");
    assert.strictEqual(st.nationality.value, "Argentina");
    assert.strictEqual(st.appearances.value, "20試合");
    assert.strictEqual(st.goals.value, "12ゴール");
    assert.strictEqual(st.assists.value, "8アシスト");
    assert.ok(st.injury.value.includes("負傷なし"));
    assert.ok(st.transfers.value.includes("PSG→Inter Miami"), st.transfers.value);
    assert.ok(st.recent5.value.includes("3勝1分1敗"), st.recent5.value);
    assert.ok(st.recent10.value.includes("6勝2分2敗"), st.recent10.value);
    assert.ok(st.ratingTrend.value.includes("7.45"), st.ratingTrend.value);
  });

  await test("buildFieldStatus: 負傷中の選手は怪我の詳細(部位・理由)まで記録される", () => {
    const st = buildFieldStatus({
      player: TEST_PLAYERS[0], apiPlayer: { injured: true }, primaryStats: null, realStats: null,
      transfers: null, injuries: [{ player: { type: "Muscle Injury", reason: "Hamstring" } }],
      recent5: null, recent10: null, ratingHistory: null, notes: {},
    });
    assert.strictEqual(st.injury.ok, true);
    assert.ok(st.injury.value.includes("負傷中"), st.injury.value);
    assert.ok(st.injury.value.includes("Hamstring"), st.injury.value);
  });

  await test("buildFieldStatus: APIエラーで取れなかった項目には「明日再試行する」旨の理由が入る(恒久的な不可とは区別される)", () => {
    const st = buildFieldStatus({
      player: TEST_PLAYERS[0], apiPlayer: null, primaryStats: null, realStats: null, transfers: null,
      injuries: null, recent5: null, recent10: null, ratingHistory: null,
      notes: { all: "選手データの取得に失敗しました(HTTP_ERROR)。明日の実行で再試行します。" },
    });
    assert.strictEqual(st.age.ok, false);
    assert.ok(st.age.reason.includes("明日"), st.age.reason);
    assert.notStrictEqual(st.age.permanent, true, "一時的な失敗は恒久的な取得不可と混同してはいけない");
  });

  await test("countFieldStatus: 更新できた数・恒久的に不可の数・再試行対象の数を正しく数える", () => {
    const st = buildFieldStatus({
      player: TEST_PLAYERS[0],
      apiPlayer: { age: 39, height: "170 cm", nationality: "Argentina", injured: false },
      primaryStats: { team: { id: 1, name: "Inter Miami" } },
      realStats: { position: "Attacker", appearances: 20, goals: 12, assists: 8, avgRating: 7.45 },
      transfers: [], injuries: null,
      recent5: { played: 5, w: 3, d: 1, l: 1, gf: 9, ga: 5 },
      recent10: { played: 10, w: 6, d: 2, l: 2, gf: 18, ga: 10 },
      ratingHistory: [{ date: "2026-08-05", rating: 7.45 }],
      notes: {},
    });
    const c = countFieldStatus(st);
    assert.strictEqual(c.total, 16);
    assert.strictEqual(c.permanentlyUnavailable, 3, "利き足・市場価値・契約の3つ");
    assert.strictEqual(c.updated, 13, "残り13項目は更新できるはず, got " + c.updated);
    assert.strictEqual(c.retryable, 0);
  });

  await test("formatPlayerStatement: 文中に日付を埋め込まない(内容が同じなら重複排除できるようにするため)", () => {
    const st = buildFieldStatus({
      player: TEST_PLAYERS[0], apiPlayer: { age: 39, height: "170 cm", nationality: "Argentina", injured: false },
      primaryStats: { team: { id: 1, name: "Inter Miami" } },
      realStats: { position: "Attacker", appearances: 20, goals: 12, assists: 8, avgRating: 7.45 },
      transfers: [], injuries: null, recent5: null, recent10: null,
      ratingHistory: [{ date: "2026-08-05", rating: 7.45 }], notes: {},
    });
    const s = formatPlayerStatement(TEST_PLAYERS[0], st);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(s), "文中にYYYY-MM-DD形式の日付が含まれてはいけない: " + s);
    assert.ok(s.includes("リオネル・メッシ"), s);
    assert.ok(s.includes("年齢:39歳"), s);
  });

  await test("formatPlayerStatement: 1項目も取得できなければnullを返す(空の事実を作らない)", () => {
    const st = buildFieldStatus({ player: TEST_PLAYERS[0], apiPlayer: null, primaryStats: null, realStats: null, transfers: null, injuries: null, recent5: null, recent10: null, ratingHistory: null, notes: { all: "取得失敗" } });
    assert.strictEqual(formatPlayerStatement(TEST_PLAYERS[0], st), null);
  });

  // ---- 結合テスト ----
  await test("collectPlayerKnowledge: 対象選手の情報を取得し、事実として保存する", async () => {
    const calls = [];
    const deps = makeDeps(calls);
    const r = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.strictEqual(r.playersCheckedToday, 2, "cap=2なので2名のはず");
    assert.strictEqual(r.playersUpdatedToday, 2);
    assert.strictEqual(r.playerFactsSavedToday, 2);
    assert.ok(r.fieldsUpdatedToday > 0, "更新できた項目があるはず");
    assert.strictEqual(r.fieldsPermanentlyUnavailable, 6, "2名×3項目(利き足/市場価値/契約)のはず, got " + r.fieldsPermanentlyUnavailable);
  });

  await test("collectPlayerKnowledge: 「更新できなかった理由」が項目名つきで必ず残る", async () => {
    const calls = [];
    const deps = makeDeps(calls);
    const r = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.ok(r.unavailableReasonsToday.length >= 6, "少なくとも恒久的に不可な6件は残るはず, got " + r.unavailableReasonsToday.length);
    for (const row of r.unavailableReasonsToday) {
      assert.ok(row.playerJa, "どの選手かが分かるはず");
      assert.ok(row.fieldJa, "どの項目かが分かるはず");
      assert.ok(row.reason && row.reason.length > 10, "理由の文章があるはず: " + JSON.stringify(row));
      assert.strictEqual(typeof row.permanent, "boolean", "恒久的か一時的かが区別されているはず");
    }
    const footRow = r.unavailableReasonsToday.find((x) => x.fieldJa === "利き足");
    assert.ok(footRow, "利き足の理由が含まれるはず");
    assert.strictEqual(footRow.permanent, true);
  });

  await test("collectPlayerKnowledge: 同じ日に再実行すると重複として扱われ、知識ベースが膨らまない", async () => {
    const calls = [];
    const mock = createMockRedis();
    const deps = makeDeps(calls, null, mock);
    const r1 = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    const r2 = await collectPlayerKnowledge(deps, new Date("2026-08-05T15:00:00Z"), "2026-08-05");
    assert.ok(r1.playerFactsSavedToday > 0);
    assert.strictEqual(r2.playerFactsSavedToday, 0, "同じ内容の再実行は新規保存されないはず");
    assert.strictEqual(r2.playerFactsDuplicateToday, r1.playerFactsSavedToday);
  });

  await test("collectPlayerKnowledge: 成績が変われば新しい事実として保存される(本当に変化した時だけ増える)", async () => {
    const calls = [];
    const mock = createMockRedis();
    let goals = 12;
    const overrides = {
      "/players": (params) => {
        if (params.search) return { response: [{ player: { id: 500 }, statistics: [] }] };
        return { response: [{
          player: { id: params.id, name: "Mock", age: 27, height: "181 cm", nationality: "Argentina", injured: false },
          statistics: [{ team: { id: 9001, name: "Mock FC" }, games: { position: "Attacker", appearences: 20, minutes: 1700, rating: "7.45" }, goals: { total: goals, assists: 8 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {} }],
        }] };
      },
    };
    const deps = makeDeps(calls, overrides, mock);
    const r1 = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.ok(r1.playerFactsSavedToday > 0);
    goals = 14; // 2ゴール増えた
    const r2 = await collectPlayerKnowledge(deps, new Date("2026-08-06T09:00:00Z"), "2026-08-05");
    assert.ok(r2.playerFactsSavedToday > 0, "得点が変わったので新しい事実として保存されるはず");
  });

  await test("collectPlayerKnowledge: API予算が尽きたら、黙って失敗せず正直な理由を残して見送る", async () => {
    const calls = [];
    const budget = createApiBudget({ dailyBudget: 21, userReserve: 20 }); // 実質1件しか使えない
    await budget.init("2026-08-05");
    const deps = makeDeps(calls, null, null, budget);
    const r = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    const budgetReasons = r.unavailableReasonsToday.filter((x) => x.reason.includes("予算"));
    assert.ok(budgetReasons.length > 0, "予算不足の理由が残るはず");
    assert.ok(budgetReasons.every((x) => x.permanent === false), "予算不足は恒久的な取得不可ではないはず(明日は取れる)");
    assert.ok(r.errors.every((e) => !/unhandled|undefined/i.test(e)), "予算切れで例外を投げてはいけない: " + JSON.stringify(r.errors));
  });

  await test("collectPlayerKnowledge: 1人の選手でAPIが失敗しても、他の選手の処理は継続する", async () => {
    const calls = [];
    let first = true;
    const overrides = {
      "/players": (params) => {
        if (params.search) return { response: [{ player: { id: 600 }, statistics: [] }] };
        if (first) { first = false; const e = new Error("boom"); e.code = "HTTP_ERROR"; throw e; }
        return { response: [{
          player: { id: params.id, name: "Mock", age: 27, height: "181 cm", nationality: "Spain", injured: false },
          statistics: [{ team: { id: 9001, name: "Mock FC" }, games: { position: "Midfielder", appearences: 15, minutes: 1200, rating: "7.10" }, goals: { total: 4, assists: 6 }, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: {} }],
        }] };
      },
    };
    const deps = makeDeps(calls, overrides);
    const r = await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.strictEqual(r.playersCheckedToday, 2);
    assert.ok(r.playersUpdatedToday >= 1, "2人目は成功しているはず, got " + r.playersUpdatedToday);
    assert.ok(r.errors.some((e) => e.includes("player_fetch_failed")), "失敗は正直にerrorsへ記録されるはず");
  });

  await test("collectPlayerKnowledge: 評価推移がUpstashへ日々積み上がる(明日は今日より情報が多い)", async () => {
    const calls = [];
    const mock = createMockRedis();
    const deps = makeDeps(calls, null, mock);
    await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    const targets = pickTodaysPlayers("2026-08-05", 2, TEST_PLAYERS);
    const hist1 = await mock.upstashGetJSON(`learn:playerhistory:${targets[0].key}`);
    assert.ok(Array.isArray(hist1) && hist1.length === 1, "1日目は1件, got " + JSON.stringify(hist1));

    // 同じ選手が対象になる日付を探して2日目を実行する
    let day2 = null;
    for (let d = 6; d <= 30; d++) {
      const dk = `2026-08-${String(d).padStart(2, "0")}`;
      if (pickTodaysPlayers(dk, 2, TEST_PLAYERS).some((p) => p.key === targets[0].key)) { day2 = dk; break; }
    }
    assert.ok(day2, "同じ選手が再度対象になる日が見つかるはず");
    await collectPlayerKnowledge(deps, new Date(`${day2}T09:00:00Z`), day2);
    const hist2 = await mock.upstashGetJSON(`learn:playerhistory:${targets[0].key}`);
    assert.strictEqual(hist2.length, 2, "2日目には2件に増えているはず(昨日より情報が多い), got " + JSON.stringify(hist2));
    assert.strictEqual(hist2[1].date, day2);
  });

  await test("collectPlayerKnowledge: 同じ日の再実行では評価推移が二重に積み上がらない", async () => {
    const calls = [];
    const mock = createMockRedis();
    const deps = makeDeps(calls, null, mock);
    await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    await collectPlayerKnowledge(deps, new Date("2026-08-05T15:00:00Z"), "2026-08-05");
    const targets = pickTodaysPlayers("2026-08-05", 2, TEST_PLAYERS);
    const hist = await mock.upstashGetJSON(`learn:playerhistory:${targets[0].key}`);
    assert.strictEqual(hist.length, 1, "同じ日は1件のままのはず, got " + JSON.stringify(hist));
  });

  await test("collectPlayerKnowledge: 選手IDは一度解決したらキャッシュされ、翌日はAPIを呼ばない", async () => {
    const calls = [];
    const mock = createMockRedis();
    const deps = makeDeps(calls, null, mock);
    await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    const searchCalls1 = calls.filter((c) => c.endpoint === "/players" && c.params.search).length;
    assert.ok(searchCalls1 > 0, "初回はID解決のため検索するはず");
    calls.length = 0;
    await collectPlayerKnowledge(deps, new Date("2026-08-05T15:00:00Z"), "2026-08-05");
    const searchCalls2 = calls.filter((c) => c.endpoint === "/players" && c.params.search).length;
    assert.strictEqual(searchCalls2, 0, "2回目はキャッシュを使い検索しないはず");
  });

  await test("collectPlayerKnowledge: 負傷していない選手には/injuriesを呼ばない(予算節約)", async () => {
    const calls = [];
    const deps = makeDeps(calls);
    await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    assert.strictEqual(calls.filter((c) => c.endpoint === "/injuries").length, 0, "injured=falseなら怪我の詳細は取りに行かないはず");
  });

  await test("collectPlayerKnowledge: 同じクラブの選手が複数いても、クラブの直近試合は1回しか取得しない", async () => {
    const calls = [];
    const deps = makeDeps(calls);
    await collectPlayerKnowledge(deps, new Date("2026-08-05T09:00:00Z"), "2026-08-05");
    const fixtureCalls = calls.filter((c) => c.endpoint === "/fixtures");
    // モックでは全選手が同じteam(9001)に所属するため、1回で済むはず
    assert.strictEqual(fixtureCalls.length, 1, "クラブ単位でキャッシュされるはず, got " + fixtureCalls.length);
  });

  console.log(failures === 0 ? "\nAll player-daily-update (優先順位⑦) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
