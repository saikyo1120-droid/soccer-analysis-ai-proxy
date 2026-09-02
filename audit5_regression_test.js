/**
 * scripts/audit5_regression_test.js
 * ------------------------------------------------
 * 2026年8月・第5次監査で発見した欠陥に対する回帰テスト。
 *
 * 目的は「同じ間違いを二度としない」ことです。各テストの説明文には、
 * その欠陥が**実際に利用者に何をしていたか**を書いてあります。
 * 単に「動く」ことではなく「嘘をつかない」ことを検証します。
 *
 * 実行方法: node scripts/audit5_regression_test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const {
  computeMatchFeatures, computeFeatureAvailability, isSaneWeights,
  predictOutcomeV2, fitWeightsGradientDescent, EXTENDED_DEFAULT_WEIGHTS,
} = require(path.join(ROOT, "server/learning/predictionModel"));
const { buildMatchFeatures } = require(path.join(ROOT, "server/learning/featureEngine"));
const { createApiBudget } = require(path.join(ROOT, "server/learning/apiBudget"));
const { rankHypotheses, TYPE_WEIGHT } = require(path.join(ROOT, "server/reasoning/evidenceRanking"));
const {
  deliberate, assessDataAvailability, buildCounterArgument, compareHypotheses,
} = require(path.join(ROOT, "server/reasoning/deliberation"));
const { assembleReasoning } = require(path.join(ROOT, "server/reasoning/reasoningEngine"));
const { describeRatingTrend } = require(path.join(ROOT, "server/learning/playerDailyUpdate"));
const { createClubProfileEngine } = require(path.join(ROOT, "server/knowledge/clubProfileEngine"));
const { createKnowledgeStore } = require(path.join(ROOT, "server/knowledge/knowledgeStore"));

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ---- テスト用のごく簡易なRedisモック ----
function createMockRedis() {
  const store = new Map();
  const lists = new Map();
  async function upstashCmd(cmd) {
    const [op, key, ...rest] = cmd;
    if (op === "GET") return store.has(key) ? store.get(key) : null;
    if (op === "SET") { store.set(key, rest[0]); return "OK"; }
    if (op === "INCRBY") {
      const next = (Number(store.get(key)) || 0) + Number(rest[0]);
      store.set(key, String(next));
      return next;
    }
    if (op === "EXPIRE") return 1;
    if (op === "RPUSH") { const l = lists.get(key) || []; l.push(rest[0]); lists.set(key, l); return l.length; }
    if (op === "LRANGE") return (lists.get(key) || []).slice();
    if (op === "LTRIM") return "OK";
    if (op === "LREM") return 0;
    return null;
  }
  return {
    upstashCmd,
    upstashGetJSON: async (k) => { const v = store.get(k); return v === undefined ? null : JSON.parse(v); },
    upstashSetJSON: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
    _store: store,
  };
}

// =====================================================================
// ① 特徴量のでっち上げ(片側だけ取得に失敗すると嘘の差が生まれる)
// =====================================================================

test("★欠陥1: 片方のチームの怪我人データが取れなかったとき、出場停止を「0人」と断定しない", () => {
  // 【この欠陥が実際にしていたこと】
  //   ホームの/injuriesが成功して「出場停止2人」、アウェイが予算切れで失敗した場合、
  //   アウェイを「出場停止0人」と断定し、suspensionDiff = -2 という嘘の差を作っていた。
  //   学習済みの重みが掛かると、**勝敗の予想そのものが反転する**ことがあった。
  const homeSrc = {
    teamId: 1,
    form: { currentFormScore: 1, avgGoalsFor: 2, avgGoalsAgainst: 1, matchesLast7Days: 1, fixtures: [] },
    injuries: { injuryCount: 3, suspendedPlayers: [{ name: "A" }, { name: "B" }] },
    standings: { played: 10, points: 20 },
  };
  const awaySrcFailed = {
    teamId: 2,
    form: { currentFormScore: 1, avgGoalsFor: 2, avgGoalsAgainst: 1, matchesLast7Days: 1, fixtures: [] },
    injuries: { injuryCount: null, error: "BUDGET_EXHAUSTED" }, // 取得失敗
    standings: { played: 10, points: 20 },
  };
  const built = buildMatchFeatures(homeSrc, awaySrcFailed, null);
  assert.strictEqual(built.awayCtx.suspensionCount, null, "取得に失敗した側の出場停止者数はnull(不明)であるべき");
  assert.strictEqual(built.features.suspensionDiff, 0, "片側が不明なら差は0(=予測に影響させない)であるべき");
  assert.strictEqual(built.supplied.suspensionDiff, false, "供給できなかったことを正直に申告すべき");
});

test("★欠陥2: 順位データが片側だけ取れないとき、相手を「1試合0勝点」扱いにしない", () => {
  // 【この欠陥が実際にしていたこと】
  //   リーグIDを特定できなかったチームを「1試合あたり0勝点」として扱い、
  //   standingsDiff に最大級の下駄を履かせていた。しかも画面には
  //   「順位データは考慮されていません」と表示していたため、
  //   **利用者への説明そのものが事実と違っていた**。
  const strong = { formScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, pointsPerGame: 2.1, matchesLast7Days: 1, injuryCount: 0, suspensionCount: 0 };
  const unknown = { formScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, pointsPerGame: null, matchesLast7Days: 1, injuryCount: 0, suspensionCount: 0 };
  const f = computeMatchFeatures(strong, unknown, null);
  assert.strictEqual(f.standingsDiff, 0, "片側の順位が不明なら差は0であるべき(2.1という嘘の差を作らない)");
  const avail = computeFeatureAvailability(strong, unknown, null);
  assert.strictEqual(avail.standingsDiff, false);
});

test("★欠陥2b: 怪我人・得点力・疲労・フォームも片側欠損なら0にする", () => {
  const full = { formScore: 2, avgGoalsFor: 2, avgGoalsAgainst: 0.5, pointsPerGame: 2, matchesLast7Days: 3, injuryCount: 4, suspensionCount: 1 };
  const empty = { formScore: null, avgGoalsFor: null, avgGoalsAgainst: null, pointsPerGame: null, matchesLast7Days: null, injuryCount: null, suspensionCount: null };
  const f = computeMatchFeatures(full, empty, null);
  for (const key of ["formDiff", "goalRateDiff", "injuryDiff", "standingsDiff", "fatigueDiff", "suspensionDiff"]) {
    assert.strictEqual(f[key], 0, `${key} は片側欠損時に0であるべき(実測: ${f[key]})`);
  }
});

test("両方そろっている場合は、これまで通り正しく差が計算される(既存機能を壊していない)", () => {
  // 2026-09-02監査での更新: audit5以後にv47(市場エッジ)・v50(レーティング)・
  // v57(クラブElo)が正当追加された。全特徴の「供給できた」申告を検証するため、
  // 追加分の入力も与える(与えなければfalse=正直な申告、はそれ自体正しい挙動)。
  const home = { formScore: 2, avgGoalsFor: 2, avgGoalsAgainst: 0.5, pointsPerGame: 2.2, matchesLast7Days: 1, injuryCount: 1, suspensionCount: 0, homeVenueWinRate: 0.8, xgNet: 0.9, topScorerGoals: 15, ratingExpGoals: 1.8, clubElo: 1900 };
  const away = { formScore: -1, avgGoalsFor: 1, avgGoalsAgainst: 1.5, pointsPerGame: 1.0, matchesLast7Days: 3, injuryCount: 4, suspensionCount: 2, awayVenueWinRate: 0.2, xgNet: -0.4, topScorerGoals: 5, ratingExpGoals: 1.2, clubElo: 1700 };
  const f = computeMatchFeatures(home, away, { homeSideWins: 3, awaySideWins: 1 });
  assert.strictEqual(f.formDiff, 3);
  assert.strictEqual(Math.round(f.goalRateDiff * 100) / 100, 2);
  assert.strictEqual(f.injuryDiff, 3);
  assert.strictEqual(Math.round(f.standingsDiff * 100) / 100, 1.2);
  assert.strictEqual(f.headToHeadDiff, 2);
  assert.strictEqual(f.fatigueDiff, 2);
  assert.strictEqual(Math.round(f.venueDiff * 100) / 100, 0.6);
  assert.strictEqual(f.suspensionDiff, 2);
  assert.strictEqual(Math.round(f.xgDiff * 100) / 100, 1.3);
  assert.strictEqual(f.topScorerDiff, 10);
  const avail = computeFeatureAvailability(home, away, { homeSideWins: 3, awaySideWins: 1 }, { homePct: 55, drawPct: 25, awayPct: 20 });
  for (const k of Object.keys(avail)) assert.strictEqual(avail[k], true, `${k} は供給できたと申告されるべき`);
});

// =====================================================================
// ② 重み学習の安全性(NaN汚染・発散)
// =====================================================================

test("★欠陥3: 壊れた記録が1件混ざっても、NaNの重みを保存しない", () => {
  // 【この欠陥が実際にしていたこと】
  //   Math.max(-1, Math.min(1, NaN)) は NaN をそのまま通す。1件でも特徴量が
  //   数値でない記録があると重みがNaNになり、しかも predictOutcomeV2 の
  //   `(w[wKey] || 0)` が NaN を静かに0へ落とすため、**その特徴量が二度と
  //   使われない状態が、エラーも出ないまま永久に続いていた**。
  const goodRecord = (i) => ({
    actualWinner: i % 2 === 0 ? "home" : "away",
    features: { formDiff: i % 2 === 0 ? 2 : -2, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 },
  });
  const records = [];
  for (let i = 0; i < 10; i++) records.push(goodRecord(i));
  // 壊れた1件(APIの応答が想定外の形だったケース)
  records.push({ actualWinner: "home", features: { formDiff: "こわれた値", goalRateDiff: 0 } });

  const fitted = fitWeightsGradientDescent(records, EXTENDED_DEFAULT_WEIGHTS);
  if (fitted !== null) {
    for (const [k, v] of Object.entries(fitted)) {
      if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} が有限な数値でない: ${v}`);
    }
  }
  // どちらにせよ「NaNを含む重み」は保存前の検査で必ず弾かれること
  assert.strictEqual(isSaneWeights({ ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: NaN }), false);
  assert.strictEqual(isSaneWeights({ ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: Infinity }), false);
  assert.strictEqual(isSaneWeights({ ...EXTENDED_DEFAULT_WEIGHTS, homeBase: -1 }), false, "基礎得点が負の重みを保存してはいけない");
  assert.strictEqual(isSaneWeights({ ...EXTENDED_DEFAULT_WEIGHTS, homeBase: 99 }), false, "発散した基礎得点を保存してはいけない");
  assert.strictEqual(isSaneWeights(EXTENDED_DEFAULT_WEIGHTS), true, "正常な重みは通るべき");
});

test("正常なデータでは、これまで通り重みが学習される(既存機能を壊していない)", () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    const homeStrong = i % 2 === 0;
    records.push({
      actualWinner: homeStrong ? "home" : "away",
      features: { formDiff: homeStrong ? 3 : -3, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 },
    });
  }
  const fitted = fitWeightsGradientDescent(records, { ...EXTENDED_DEFAULT_WEIGHTS, sensitivity: 0.02 });
  assert.ok(fitted, "学習結果が返るべき");
  assert.ok(isSaneWeights(fitted), "学習結果は保存可能な値であるべき");
  assert.ok(fitted.sensitivity > 0.02, `フォーム差の重みが学習で上がるべき(実測: ${fitted.sensitivity})`);
});

// =====================================================================
// ③ 予算ガード(日付またぎ・原子的カウンター)
// =====================================================================

test("★欠陥4: 予算カウンターは上書き(SET)ではなく加算(INCRBY)で記録する", async () => {
  // 【この欠陥が実際にしていたこと】
  //   SET key {spent: 合計} で書いていたため、2つのプロセスが同時に書き戻すと
  //   後から書いた方の値で上書きされ、**実際に使ったリクエストが消えて
  //   無かったことになる**(=1日の上限を超過しうる)。
  const mock = createMockRedis();
  const a = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
  const b = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
  await a.init("2026-08-05");
  await b.init("2026-08-05");
  for (let i = 0; i < 40; i++) a.tryReserveUser(1, "x");
  for (let i = 0; i < 3; i++) b.tryReserveUser(1, "y");
  await a.flush();
  await b.flush();
  const stored = Number(await mock.upstashCmd(["GET", "learn:apibudget:n:2026-08-05"]));
  assert.strictEqual(stored, 43, `両プロセスの消費が合算されるべき(実測: ${stored})`);

  // 3つ目のプロセスが起動したら、43件消費済みの状態から始まること
  const c = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
  await c.init("2026-08-05");
  assert.strictEqual(c.summary().spentBeforeThisRun, 43);
});

test("★欠陥5: API-Footballが返す「本日の残り」で自前カウンターを補正できる", async () => {
  // タイムアウトや強制終了で自前カウンターは必ず実態からズレる。
  // 本家が毎回教えてくれる残量で補正し、自己修復するようにした。
  const mock = createMockRedis();
  const budget = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
  await budget.init("2026-08-05");
  budget.tryReserveUser(5, "x"); // 自前では5件のつもり
  // 実際にはAPI-Football側で30件使われていた(残り70)
  const changed = budget.reconcileFromRemaining(70);
  assert.strictEqual(changed, true);
  assert.strictEqual(budget.totalSpent(), 30, "本家の数字に合わせて増える方向へ補正されるべき");
  // 減らす方向には決して動かさない(過小報告=上限超過事故になるため)
  assert.strictEqual(budget.reconcileFromRemaining(95), false);
  assert.strictEqual(budget.totalSpent(), 30);
});

test("★欠陥6: 日付が変わったら、前日の予算インスタンスを必ず捨てる(server.jsの実装検査)", () => {
  // 【この欠陥が実際にしていたこと】
  //   globalApiBudgetDate だけを新しい日付へ書き換え、globalApiBudget を
  //   消していなかったため、UTC 0時をまたぐと**日付は今日・中身は昨日**という
  //   状態がプロセスが生きている間ずっと続きえた。前日に使い切っていれば
  //   新しい日なのに1日中APIが使えない。
  //   予測自動収集の cron は "0 */6 * * *"、つまりちょうどUTC 0時に発火する。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const fn = src.slice(src.indexOf("async function getApiBudget()"), src.indexOf("async function maybeFlushBudget"));
  assert.ok(/globalApiBudget = null;/.test(fn), "日付が変わったら古いインスタンスをnullにしていない");
  assert.ok(/if \(globalApiBudgetDate === today\)/.test(fn), "init完了後に日付を再確認していない");
});

test("★欠陥7: fetchが失敗しても、消費した1件を必ず書き戻し対象に含める(server.jsの実装検査)", () => {
  // 失敗時に maybeFlushBudget へ到達しないと、未書き戻し件数が0のままになり、
  // プロセス終了時の書き戻しも行われず、消費が丸ごと記録から消えていた。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const fn = src.slice(src.indexOf("async function callApiFootball"), src.indexOf("async function callApiFootball") + 4000);
  assert.ok(/finally\s*\{\s*await maybeFlushBudget\(budget\);/.test(fn),
    "fetchをtry/finallyで囲み、失敗時も必ず書き戻し対象にすべき");
});

test("★欠陥8: 書き戻しに失敗したら「書き戻し済み」にしない(server.jsの実装検査)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const fn = src.slice(src.indexOf("async function maybeFlushBudget"), src.indexOf("process.on(\"beforeExit\""));
  assert.ok(/if \(ok !== false\) budgetWritesPending = 0;/.test(fn),
    "flushの成否を確認してから未書き戻し件数をリセットすべき");
});

// =====================================================================
// ④ 推論の正直さ(でっち上げ防止)
// =====================================================================

test("★欠陥9: AIが推定しただけの内容は、実データより軽く扱う", () => {
  // 【この欠陥が実際にしていたこと】
  //   実データが1件も無いときにLLMへ「一般的なサッカーの知識のみに基づいて
  //   推定してください」と書かせた文章が、analysis(1.5)として
  //   **実データ(1.0)より重く**採点されていた。
  assert.ok(TYPE_WEIGHT.aiEstimate < TYPE_WEIGHT.fact, "AI推定は実データより軽くすべき");
  assert.ok(TYPE_WEIGHT.aiEstimate < TYPE_WEIGHT.opinion, "AI推定は意見よりさらに軽くてよい");
});

test("★欠陥10: AI推定しか根拠が無いとき「私は○○が最も重要だと考えます」と断言しない", () => {
  // 【この欠陥が実際にしていたこと】
  //   データ充足率0%でも、AIが自分で書いた推定文を根拠として
  //   自信を持って断言し、しかもそれを「実データ」と呼んでいた。
  const aiOnly = [{
    id: "tactics_formation", label: "戦術・フォーメーションの変化が原因という仮説",
    statement: "戦術が影響している可能性がある。",
    evidence: [{ category: "clubProfile", type: "aiEstimate", isAiGenerated: true, statement: "【AIによる推定】…" }],
  }];
  const ranked = rankHypotheses(aiOnly);
  const r = deliberate({ ranked, dataAvailability: {} });
  assert.ok(!r.finalConclusionJa.includes("最も重要だと考えます"),
    "AI推定だけで断言してはいけない: " + r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("確かなことを申し上げられない"), r.finalConclusionJa);
});

test("実データが1件でもあれば、これまで通り結論を述べる(既存機能を壊していない)", () => {
  const withFact = [{
    id: "recent_form", label: "直近フォームが原因という仮説",
    statement: "直近の得失点差が改善している。",
    evidence: [{ category: "recentFormTrend", type: "fact", statement: "得失点差が+0.8改善しました。" }],
  }];
  const ranked = rankHypotheses(withFact);
  const r = deliberate({ ranked, dataAvailability: { form: true, goals: true, venue: true }, requiredKeys: ["form", "goals", "venue"] });
  assert.ok(r.finalConclusionJa.startsWith("私は「"), r.finalConclusionJa);
  assert.ok(r.finalConclusionJa.includes("最も重要だと考えます"), r.finalConclusionJa);
});

test("★欠陥11: 他の見方にデータが無いことを「根拠の強さ」として提示しない", () => {
  const ca = buildCounterArgument(compareHypotheses(rankHypotheses([{
    id: "a", label: "A", statement: "A", evidence: [{ category: "recentFormTrend", type: "fact", statement: "x" }],
  }])));
  assert.strictEqual(ca.hasCounter, false);
  assert.ok(!ca.statementJa.includes("根拠の強さを示します"), ca.statementJa);
  assert.ok(ca.statementJa.includes("正しい証拠にはなりません"), ca.statementJa);
});

test("★欠陥12: 質問に必要なデータだけを点検する(取得しない項目で永久に減点しない)", () => {
  // 【この欠陥が実際にしていたこと】
  //   クラブ単体の質問では取得しないxG・過去対戦成績まで常に「必要」と
  //   していたため、**どれだけ完璧にデータが揃っても自信度が永久に★4止まり**
  //   になっていた(しかも画面に出ていた星は別計算で★5。本文と星が矛盾)。
  const all = assessDataAvailability({ form: true, goals: true, coach: true, injuries: true, venue: true });
  assert.ok(all.coveragePct < 100, "点検対象を指定しない場合は従来通り8項目すべてを見る");

  const scoped = assessDataAvailability(
    { form: true, goals: true, coach: true, injuries: true, venue: true },
    ["form", "goals", "coach", "injuries", "venue"]
  );
  assert.strictEqual(scoped.coveragePct, 100, "この質問に必要な項目がすべて揃えば100%であるべき");
  assert.strictEqual(scoped.missing.length, 0);
  assert.ok(scoped.notRequired.includes("xG(チャンスの質)"), "必須ではないが未取得の項目は別枠で正直に示すべき");
  assert.ok(scoped.summaryJa.includes("取得していません"), scoped.summaryJa);
});

test("★欠陥13: 「実データ◯件」と言うとき、AI推定を数に入れない", () => {
  const mixed = rankHypotheses([{
    id: "a", label: "A", statement: "A",
    evidence: [
      { category: "recentFormTrend", type: "fact", statement: "実データ1" },
      { category: "clubProfile", type: "aiEstimate", isAiGenerated: true, statement: "AI推定1" },
      { category: "clubProfile", type: "aiEstimate", isAiGenerated: true, statement: "AI推定2" },
    ],
  }]);
  assert.strictEqual(mixed[0].factualCount, 1, "実データの件数は1であるべき(AI推定2件は数えない)");
  const r = deliberate({ ranked: mixed, dataAvailability: { form: true }, requiredKeys: ["form"] });
  assert.ok(!r.confidence.reasonJa.includes("実データが3件"), r.confidence.reasonJa);
});

test("★欠陥14: 根拠があるのに全仮説が0点なら、配線ミスとして検知・警告する", () => {
  // 【この欠陥が実際にしていたこと】
  //   知識のカテゴリ名と仮説側が探すカテゴリ名がズレていて、蓄積した知識が
  //   すべて無視されていた。例外も出ず画面も普通に見えるため、2回の監査で
  //   同じ種類の欠陥が繰り返し見つかっていた。
  const pool = [
    { category: "存在しないカテゴリA", type: "fact", statement: "x" },
    { category: "存在しないカテゴリB", type: "fact", statement: "y" },
  ];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const bundle = assembleReasoning(pool, { teamJa: "テスト", teamEn: "Test" });
    assert.ok(bundle.orphanCategories.includes("存在しないカテゴリA"), JSON.stringify(bundle.orphanCategories));
    assert.ok(warnings.some((w) => w.includes("すべての仮説のスコアが0")), warnings.join(" | "));
  } finally { console.warn = originalWarn; }
});

test("正常な配線では警告を出さない(誤検知しない)", () => {
  const pool = [{ category: "recentFormTrend", type: "fact", statement: "得失点差が改善しました。" }];
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const bundle = assembleReasoning(pool, { teamJa: "テスト", teamEn: "Test" });
    assert.strictEqual(warnings.length, 0, "正しく配線されているのに警告を出してはいけない");
    assert.strictEqual(bundle.orphanCategories.length, 0);
  } finally { console.warn = originalWarn; }
});

test("★欠陥15: 監督遍歴(managerHistory)が監督仮説の根拠として使われる", () => {
  const pool = [{ category: "managerHistory", type: "fact", statement: "A監督の前職はBクラブ(2023〜2025)。" }];
  const bundle = assembleReasoning(pool, { teamJa: "テスト", teamEn: "Test" });
  const coach = bundle.hypotheses.find((h) => h.id === "coach");
  assert.ok(coach && coach.score > 0, "実データである監督遍歴が0点のまま捨てられている");
});

test("★欠陥16: ホーム/アウェイ差の事実が、ホーム/アウェイ仮説の根拠として使われる", () => {
  // 従来はすべての事実が recentFormTrend で保存されていたため、
  // ホーム/アウェイの得意不得意が「直近の調子」の根拠として数えられ、
  // 本来の home_away 仮説の根拠には一切ならなかった。
  const pool = [{ category: "homeAway", type: "fact", statement: "ホームでの勝率がアウェイより40ポイント高い。" }];
  const bundle = assembleReasoning(pool, { teamJa: "テスト", teamEn: "Test" });
  const ha = bundle.hypotheses.find((h) => h.id === "home_away");
  assert.ok(ha && ha.score > 0, "ホーム/アウェイの事実が該当仮説の根拠になっていない");
});

test("★欠陥16b: dailyJob が事実の種類ごとに正しいカテゴリで保存する(実装検査)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/KNOWLEDGE_CATEGORY_BY_FACT/.test(src), "事実の種類→知識カテゴリの対応表が無い");
  assert.ok(/"ホームアウェイ差":\s*"homeAway"/.test(src), "ホームアウェイ差がhomeAwayカテゴリで保存されていない");
});

// =====================================================================
// ⑤ 「毎日賢くなった」の水増し防止
// =====================================================================

test("★欠陥17: 選手の評価が変わらない日は、知識の文面も変わらない", () => {
  // 【この欠陥が実際にしていたこと】
  //   文面に「記録N回」という毎日1ずつ増えるカウンターが入っていたため、
  //   成績がまったく動いていない日でも文面のハッシュが変わり、
  //   **毎日「新しい知識を1件獲得した」と記録され続けていた**。
  //   これが「昨日より知識が◯件増えました」という報告の中身だった。
  const history = [];
  const seen = new Set();
  for (let day = 1; day <= 10; day++) {
    history.push({ date: `2026-08-${String(day).padStart(2, "0")}`, rating: 7.2 });
    const t = describeRatingTrend(history);
    assert.ok(!/記録\d+回/.test(t), "記録回数を文面に入れてはいけない: " + t);
    seen.add(t);
  }
  assert.strictEqual(seen.size, 1, "評価が変わらないのに文面が変わっている: " + Array.from(seen).join(" | "));
});

test("評価が実際に動いた日には、ちゃんと文面が変わる(変化を見逃さない)", () => {
  // 第6次監査での設計変更に追随: 傾向の判定には最低6件の記録が必要
  // (2件では上昇か偶然かを区別できないため、断定しないのが正しい)。
  const mk = (ratings) => ratings.map((r, i) => ({ date: "d" + i, rating: r }));
  const flat = describeRatingTrend(mk([7.2, 7.2, 7.2, 7.2, 7.2, 7.2, 7.2, 7.2, 7.2, 7.2]));
  const up = describeRatingTrend(mk([7.2, 7.2, 7.2, 7.2, 7.2, 7.6, 7.6, 7.6, 7.6, 7.6]));
  assert.notStrictEqual(flat, up);
  assert.ok(up.includes("上昇"), up);
});

test("★欠陥17b: 記録が上限に達して窓がずれても、評価が動かない日は文面が変わらない", () => {
  // 第6次監査で発見した「時限式の水増し」。基準にしていた初回の値は、
  // 記録が60件に達すると毎日変わるため、評価が1ミリも動いていなくても
  // 文面が毎日変わり、知識件数が毎日1ずつ増え続けていた。
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

test("★欠陥18: 実データが変わっていない日は、AIの見解を作り直さない(実装検査)", () => {
  // 【この欠陥が実際にしていたこと】
  //   LLMは同じ入力でも毎回わずかに違う文面を返すため、実データがまったく
  //   変わっていない日でも「新しい知識」として数えられていた。同日に複数回
  //   実行されるとその水増しが足し算され、「昨日より賢くなりましたか?」に
  //   構造的に「はい」としか答えられなくなっていた。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/learn:aiview:grounding:/.test(src), "根拠データの変化を検知する仕組みが無い");
  assert.ok(/stableTextHash\(factsBlock\)/.test(src), "根拠データをハッシュ化して比較していない");
});

test("★欠陥19: 成長ログのエラー一覧が無制限に膨らまない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/function capList/.test(src), "件数上限の仕組みが無い");
  assert.ok(/errors: capList\(/.test(src), "errorsに上限が掛かっていない");
  assert.ok(/failureReasonsToday: capList\(/.test(src), "failureReasonsTodayに上限が掛かっていない");
  assert.ok(/successReasonsToday: capList\(/.test(src), "successReasonsTodayに上限が掛かっていない");
});

test("★欠陥20: 通算的中率とバックテスト的中率を混同しない(実装検査)", () => {
  // 【この欠陥が実際にしていたこと】
  //   ownAccuracyBefore は通算の的中率なのに、重みを更新した日だけ
  //   ownAccuracyAfter を「その日のバックテストの的中率」で上書きしていた。
  //   まったく別の指標を引き算して「的中率がNポイント改善しました」と
  //   表示していたため、その数字は単位の違いによる見かけの変化でしかなかった。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(!/ownAccuracyAfter = best\.result\.accuracy/.test(src),
    "通算的中率をバックテストの値で上書きしてはいけない");
  assert.ok(/v1BacktestReference/.test(src), "旧モデルの数値は参考値として別枠に持つべき");
});

test("★欠陥21: 重みの採否は、利用者が見ているモデルで判定し、ホールドアウト検証を通す(実装検査)", () => {
  // 【この欠陥が実際にしていたこと】
  //   採否の判定を旧v1モデル(フォームだけを見るモデル)の的中率で行いながら、
  //   結果を利用者向けv2モデルと同じキーへ書き込んでいた。
  //   シミュレーションでは v2 の的中率が 88.3% → 83.3% へ悪化した状態が
  //   「重みを更新しました。的中率が改善しました」という表示とともに保存された。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/backtestAccuracyV2\(records, w\)/.test(src),
    "採否の判定はv2(利用者が見ているモデル)で行うべき");
  assert.ok(/HOLDOUT_RATIO/.test(src), "ホールドアウト検証が無い");
  // 第6次監査での追加: 検証用データを用意できないときに trainSet と validSet へ
  // 同じ配列を入れてしまうと、二重の関門が実質1回に潰れる(見せかけの検証)。
  assert.ok(/const validSet = canHoldout \? usable\.slice\(usable\.length - holdoutSize\) : \[\];/.test(src),
    "検証用データが用意できない場合は空にして、重みを変更しない設計であるべき");
  assert.ok(/skipped_insufficient_holdout/.test(src),
    "検証用データ不足で見送った場合に、その本当の理由を記録すべき");
  assert.ok(/if \(validScore\.accuracy <= baseValid\.accuracy\) continue;/.test(src),
    "取り置いた検証データで改善しない候補を採用してはいけない");
  assert.ok(/if \(!isSaneWeights\(candidate\)\)/.test(src), "保存前の健全性チェックが無い");
  assert.ok(/if \(written === false\)/.test(src), "書き込み失敗を「更新できた」と報告してはいけない");
});

test("★欠陥22: 存在しない試合IDが保留キューの先頭を永久に塞がない(実装検査)", () => {
  // 【この欠陥が実際にしていたこと】
  //   /fixtures?id= が空応答を返す試合ID(振り直し・シーズン移行で消えた等)は
  //   保留キューから永久に消えなかった。これが10件たまると検証が完全に止まり、
  //   通算検証数が10件に届かないため**重みの学習が二度と実行されない**うえ、
  //   毎日10件のAPIリクエストを無駄に使い続けていた。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/resolveAttempts/.test(src), "確認回数の記録が無い");
  assert.ok(/prediction_fixture_missing/.test(src), "打ち切り時の理由が記録されていない");
});

// =====================================================================
// ⑥ その他の正直さ
// =====================================================================

test("★欠陥23: 実データが1件も無いクラブのプロフィールをLLMに推定させない", async () => {
  const mock = createMockRedis();
  const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
  let called = 0;
  const engine = createClubProfileEngine({
    generateLLM: async () => { called++; return { text: '{"tacticalStyle":"x","formationTendency":"y","strengths":[],"weaknesses":[]}' }; },
    knowledgeStore,
  });
  const r = await engine.ensureClubProfile("Test FC", "テストFC", [], new Date().toISOString());
  assert.strictEqual(called, 0, "実データが無いのにLLMへ推定させてはいけない");
  assert.strictEqual(r.generated, false);
  assert.strictEqual(r.reason, "NO_GROUNDING_DATA");

  // 実データがあれば、これまで通り生成する
  const r2 = await engine.ensureClubProfile("Test FC", "テストFC", ["直近5試合の平均得点2.0(API-Footballの実データ)"], new Date().toISOString());
  assert.strictEqual(called, 1);
  assert.strictEqual(r2.generated, true);
});

test("★欠陥24: 怪我人情報が取れなかったときに「負傷者なし」と断言しない(index.htmlの実装検査)", () => {
  // count が null(取得失敗)でも `!side.count` が真になるため、
  // 「負傷・出場停止者なし」と断言していた。同じ画面の下部には
  // 「負傷者情報の取得に失敗しました」と出るので、回答が自己矛盾していた。
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(/side\.count === null \|\| side\.count === undefined/.test(html),
    "0人だった場合と、取得できなかった場合を区別していない");
  assert.ok(/負傷・出場停止の情報を取得できませんでした/.test(html),
    "取得できなかったことを伝える文言が無い");
});

test("★欠陥25: 学習済みの重みが読めなかったことを利用者に伝える(server.jsの実装検査)", () => {
  // upstashGetJSON は失敗を握りつぶして null を返すため、Upstashが一時的に
  // 落ちていると、学習前の初期モデル(全部0)で予測しながら、
  // いつもと変わらない自信満々の回答を返していた。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(/学習済みの予測モデル\(重み\)を読み込めなかったため/.test(src),
    "学習結果を読めなかったことを利用者へ伝えていない");
});

test("★欠陥26: 監督遍歴の取得でcallApiFootballを渡し忘れていない(server/rag実装検査)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/rag/knowledgeSource.js"), "utf8");
  assert.ok(/fetchCoachCareer\(teamId, callApiFootball\)/.test(src),
    "fetchCoachCareerに第2引数(callApiFootball)を渡していない");
});

test("★欠陥27: 毎日ためているリーグの知識が、実際に読み出されている(実装検査)", () => {
  // knowledge:byTeam:league:◯◯ という名前空間へ毎日保存していたのに、
  // それを読み出す処理が本番コードに1つも無く(テストからしか呼ばれていない)、
  // 毎日APIを消費して集めた順位表・得点ランキングは一度も使われていなかった。
  const src = fs.readFileSync(path.join(ROOT, "server/rag/knowledgeSource.js"), "utf8");
  assert.ok(/getActiveKnowledgeForLeague/.test(src), "リーグ知識の読み出しが無い");
  const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(/getActiveKnowledgeForLeague:/.test(server), "リーグ知識の読み出し関数が注入されていない");
});

test("★欠陥28: AI自身の結論を、翌日その同じ仮説の根拠として読み込まない(実装検査)", () => {
  // category に仮説のIDをそのまま入れていたため、coach / fatigue / standings は
  // 知識カテゴリ名と偶然一致し、**AIが昨日出した結論が、翌日その同じ仮説を
  // 支持する根拠として読み込まれる**自己肯定ループになっていた。
  // しかも根拠の重みは analysis(1.5) > fact(1.0) と実データより高かった。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(!/category: selected\.id/.test(src), "仮説IDをそのまま知識カテゴリにしてはいけない");
  assert.ok(/category: "aiLeadingFactor"/.test(src), "専用カテゴリへ保存すべき");
  const hyp = fs.readFileSync(path.join(ROOT, "server/reasoning/hypothesisGenerator.js"), "utf8");
  assert.ok(!/aiLeadingFactor/.test(hyp), "AI自身の結論を仮説の根拠カテゴリに含めてはいけない");
});

test("★欠陥29: 前回の結論を取得してから熟考へ渡す(思考の変化が機能する)", () => {
  // previousConclusion の取得が deliberate() の後ろに書かれていたため、
  // 常に null が渡り、「以前は『…』と考えていました。しかし新しいデータを
  // 学んだ結果…」という説明が一度も出たことがなかった。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const memIdx = src.indexOf("previousConclusion = await memoryStore.getLastConclusion(memorySubjectKey)");
  const delibIdx = src.indexOf("deliberationResult = deliberate({");
  assert.ok(memIdx > 0 && delibIdx > 0, "対象のコードが見つからない");
  assert.ok(memIdx < delibIdx, "前回の結論の取得が deliberate() より後ろにある(常にnullが渡る)");
});

test("前回と考えが変わった場合、その理由に必ず触れる(機能そのものの検証)", () => {
  const ranked = rankHypotheses([{
    id: "recent_form", label: "直近フォームが原因という仮説", statement: "直近の得失点差が改善している。",
    evidence: [{ category: "recentFormTrend", type: "fact", statement: "得失点差が改善しました。" }],
  }]);
  const r = deliberate({
    ranked, dataAvailability: { form: true }, requiredKeys: ["form"],
    previousConclusion: { statement: "移籍による戦力変化が原因である。" },
  });
  assert.ok(r.changedFromPrevious && r.changedFromPrevious.changed === true, JSON.stringify(r.changedFromPrevious));
  assert.ok(r.changedFromPrevious.noteJa.includes("以前は"), r.changedFromPrevious.noteJa);
});

// =====================================================================

(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      console.log(`  [OK] ${t.name}`);
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${t.name}: ${e.message}`);
    }
  }
  console.log(failures === 0
    ? `\nAll audit-5 regression tests PASSED (${queue.length} tests).`
    : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
