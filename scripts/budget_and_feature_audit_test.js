/**
 * 2026年8月・ご指示①②③⑥の検証テスト(監査を自動化したもの)。
 *
 * ご指示⑥で YES/NO の報告を求められた7項目を、**人間の目視ではなく機械的に**
 * 検証する。人が見落とせる種類の欠陥だったため、以後は毎回このテストで担保する。
 *
 *   1. API予算ガードを通らないAPI呼び出しは存在しない
 *   2. totalSpentは実消費と一致する
 *   3. 予算切れ判定は正常
 *   4. Learning Engineの特徴量はPrediction Engineへ反映される
 *   5. AI Match Analysisでも同じ特徴量を利用している
 *   6. 日次学習とオンデマンド分析で特徴量生成は共通化されている
 *   7. 学習結果は翌日の予測へ反映される
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let failures = 0;
const _queue = [];
// 2026年8月・再監査で発見した重大な欠陥の修正:
// 従来は fn() を await していなかったため、async なテストの assertion 失敗が
// Promise の中に取り残され、**失敗しているのに [OK] と表示されていた**。
// 同期・非同期のどちらでも確実に失敗を検出できるよう、必ず await する。
function test(name, fn) { _queue.push({ name, fn }); }
async function runAll() {
  for (const t of _queue) {
    try { await t.fn(); console.log(`  [OK] ${t.name}`); }
    catch (e) { console.error(`  [FAIL] ${t.name}: ${e.message}`); failures++; }
  }
}

// ============================================================
// 1. API予算ガードを通らないAPI呼び出しは存在しないか(静的監査)
// ============================================================
test("★① API-Footballへの実通信は callApiFootball の中の1箇所だけである", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  // API_BASE を使ってURLを組み立てている箇所を数える。1箇所(callApiFootball内)だけのはず。
  const urlBuilds = (serverSrc.match(/new URL\(API_BASE/g) || []).length;
  assert.strictEqual(urlBuilds, 1,
    `API_BASEからURLを組み立てる箇所は1つだけであるべき(callApiFootball内), got ${urlBuilds}`);
});

test("★① 予算チェックが callApiFootball の内部にあり、fetch より前に実行される", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const fnStart = src.indexOf("async function callApiFootball");
  assert.ok(fnStart > 0, "callApiFootballが見つからない");
  const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
  const reservePos = fnBody.indexOf("budget.tryReserve");
  const fetchPos = fnBody.indexOf("fetchWithTimeout");
  assert.ok(reservePos > 0, "callApiFootball内で予算を確保していない");
  assert.ok(fetchPos > 0, "callApiFootball内でfetchしていない");
  assert.ok(reservePos < fetchPos, "予算チェックは実通信より前に行われるべき");
});

test("★① 予算が尽きたら BUDGET_EXHAUSTED を投げ、実通信を行わない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(src.includes('err.code = "BUDGET_EXHAUSTED"'), "予算切れ専用のエラーコードが必要");
  const fnStart = src.indexOf("async function callApiFootball");
  const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
  assert.ok(/if \(!reservation\.allowed\)[\s\S]{0,300}throw err;/.test(fnBody),
    "予算不足なら throw して先へ進まないこと");
});

test("★① 各モジュールは自前で fetch を呼ばず、必ず注入された callApiFootball を使う", () => {
  const modules = [
    "learning/dailyJob.js", "learning/features.js", "learning/leagueKnowledge.js",
    "learning/leagueConfig.js", "learning/playerDailyUpdate.js", "learning/featureEngine.js",
  ];
  for (const rel of modules) {
    const src = fs.readFileSync(path.join(ROOT, "server", rel), "utf8");
    const directFetch = src.match(/(^|[^.\w])fetch\s*\(/g) || [];
    assert.strictEqual(directFetch.length, 0,
      `${rel} が直接 fetch を呼んでいる(予算ガードを迂回してしまう): ${directFetch.length}箇所`);
  }
});

test("★① 日次ジョブは自前の予算インスタンスを作らず、共有インスタンスを使う", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  assert.ok(src.includes("getSharedApiBudget"), "共有インスタンスを受け取る仕組みが必要(二重計上の防止)");
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(serverSrc.includes("getSharedApiBudget: getApiBudget"),
    "server.js が共有インスタンスを注入していること");
});

test("★① 二重計上の防止: 呼び出し側は消費する tryReserve ではなく canAfford で事前確認する", () => {
  for (const rel of ["learning/dailyJob.js", "learning/playerDailyUpdate.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "server", rel), "utf8");
    const reserves = (src.match(/apiBudget\.tryReserve\(/g) || []).length;
    assert.strictEqual(reserves, 0,
      `${rel} が tryReserve を呼んでいる(callApiFootball側でも確保するため二重計上になる)`);
  }
});

// ============================================================
// 2〜3. 予算の計上と、予算切れ判定
// ============================================================
const { createApiBudget } = require("../server/learning/apiBudget");

test("★② 1回の呼び出しにつき正確に1件だけ計上される", async () => {
  const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
  await b.init("2026-08-25");
  const before = b.remainingForJob();
  b.tryReserve(1, "/fixtures");
  assert.strictEqual(b.remainingForJob(), before - 1, "1呼び出し=1消費であるべき");
  assert.strictEqual(b.summary().totalSpent, 1);
});

test("★③ 予算を使い切ったら以降は拒否され、理由が残る", async () => {
  const b = createApiBudget({ dailyBudget: 25, userReserve: 20 });
  await b.init("2026-08-25");
  assert.strictEqual(b.remainingForJob(), 5);
  for (let i = 0; i < 5; i++) assert.strictEqual(b.tryReserve(1, "x").allowed, true);
  const denied = b.tryReserve(1, "/standings");
  assert.strictEqual(denied.allowed, false, "使い切ったら拒否されるべき");
  assert.ok(denied.reason.includes("/standings"), "何を見送ったかが理由に入るべき: " + denied.reason);
  assert.strictEqual(b.remainingForJob(), 0);
});

// ============================================================
// 4〜6. 特徴量の共通化と、Prediction Engineへの反映
// ============================================================
const { buildMatchFeatures, buildTeamContext } = require("../server/learning/featureEngine");
const { EXTENDED_DEFAULT_WEIGHTS, predictOutcomeV2 } = require("../server/learning/predictionModel");

const SRC = (over) => ({
  teamId: 10,
  form: {
    currentFormScore: 2, avgGoalsFor: 2.0, avgGoalsAgainst: 0.8, matchesLast7Days: 1,
    fixtures: [
      { fixture: { id: 1, date: new Date().toISOString() }, teams: { home: { id: 10 }, away: { id: 20 } }, goals: { home: 3, away: 0 } },
      { fixture: { id: 2, date: new Date(Date.now() - 1e5).toISOString() }, teams: { home: { id: 10 }, away: { id: 21 } }, goals: { home: 2, away: 1 } },
      { fixture: { id: 3, date: new Date(Date.now() - 2e5).toISOString() }, teams: { home: { id: 22 }, away: { id: 10 } }, goals: { home: 1, away: 0 } },
    ],
  },
  injuries: { injuryCount: 3, suspendedPlayers: ["S1"], injuredPlayers: ["I1", "I2"] },
  standings: { played: 20, points: 40 },
  xg: { xgNet: 0.9 },
  topScorer: { player: { name: "Ace", goals: 15 } },
  ...over,
});

test("★④⑤ 4つの新特徴量すべてに、実データから0でない値が入る", () => {
  const built = buildMatchFeatures(
    SRC({ teamId: 10 }),
    SRC({ teamId: 20, xg: { xgNet: -0.4 }, topScorer: { player: { name: "B", goals: 5 } }, injuries: { injuryCount: 1, suspendedPlayers: [] } }),
    { homeSideWins: 2, awaySideWins: 1 }
  );
  const f = built.features;
  for (const key of ["venueDiff", "suspensionDiff", "xgDiff", "topScorerDiff"]) {
    assert.notStrictEqual(f[key], undefined, `${key} が undefined`);
    assert.notStrictEqual(f[key], null, `${key} が null`);
    assert.notStrictEqual(f[key], 0, `${key} が0のまま(実データが供給されていない)`);
  }
  assert.ok(Math.abs(f.xgDiff - 1.3) < 1e-9, "xgDiff = 0.9 - (-0.4) = 1.3, got " + f.xgDiff);
  assert.strictEqual(f.topScorerDiff, 10, "15 - 5 = 10");
  assert.strictEqual(f.suspensionDiff, -1, "相手0 - 自分1 = -1");
  console.log(`        → venueDiff=${f.venueDiff} suspensionDiff=${f.suspensionDiff} xgDiff=${f.xgDiff} topScorerDiff=${f.topScorerDiff}`);
});

test("★④ 供給できたかどうかが supplied として自己申告される(ログで確認できる)", () => {
  const built = buildMatchFeatures(SRC({ teamId: 10 }), SRC({ teamId: 20 }), null);
  assert.strictEqual(built.supplied.xgDiff, true);
  assert.strictEqual(built.supplied.topScorerDiff, true);
  assert.strictEqual(built.supplied.venueDiff, true);
  const noXg = buildMatchFeatures(SRC({ teamId: 10, xg: { xgNet: null } }), SRC({ teamId: 20 }), null);
  assert.strictEqual(noXg.supplied.xgDiff, false, "取得できなかったことを正直に申告するはず");
  assert.strictEqual(noXg.features.xgDiff, 0, "取得できなければ0(予測に影響させない)");
});

test("★⑥ 日次学習とオンデマンド分析が、同じ関数(buildMatchFeatures)を使っている", () => {
  const daily = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  const server = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(daily.includes("buildMatchFeatures("), "日次学習が共通Feature Engineを使っていない");
  assert.ok(server.includes("buildMatchFeatures("), "オンデマンド分析が共通Feature Engineを使っていない");
  // 旧来の個別組み立て(computeMatchFeatures直接呼び)が残っていないこと
  assert.ok(!/const features = computeMatchFeatures\(/.test(daily), "日次学習に古い組み立てが残っている");
  assert.ok(!/const features = computeMatchFeatures\(/.test(server), "オンデマンド分析に古い組み立てが残っている");
});

test("★⑥ 同じ素材を渡せば、両者はまったく同じ特徴量になる(ズレが起きない)", () => {
  const h = SRC({ teamId: 10 });
  const a = SRC({ teamId: 20, xg: { xgNet: 0.1 } });
  const first = buildMatchFeatures(h, a, { homeSideWins: 1, awaySideWins: 1 });
  const second = buildMatchFeatures(h, a, { homeSideWins: 1, awaySideWins: 1 });
  assert.deepStrictEqual(first.features, second.features);
});

test("二重計上の解消: injuryCount から出場停止分が差し引かれる", () => {
  const ctx = buildTeamContext({ side: "home", teamId: 10, form: {}, standings: {}, injuries: { injuryCount: 5, suspendedPlayers: ["a", "b"] } });
  assert.strictEqual(ctx.suspensionCount, 2);
  assert.strictEqual(ctx.injuryCount, 3, "5人中2人は出場停止なので、純粋な負傷者は3人");
});

// ============================================================
// 7. 学習結果が翌日の予測へ反映されるか
// ============================================================
test("★⑦ 学習した重みが、共通Feature Engineの出力に対して実際に効く", () => {
  const built = buildMatchFeatures(
    SRC({ teamId: 10 }),
    SRC({ teamId: 20, xg: { xgNet: -0.5 }, topScorer: { player: { goals: 3 } } }),
    null
  );
  const before = predictOutcomeV2(built.features, EXTENDED_DEFAULT_WEIGHTS);
  const learned = { ...EXTENDED_DEFAULT_WEIGHTS, xgSensitivity: 0.4, venueSensitivity: 0.3, topScorerSensitivity: 0.02 };
  const after = predictOutcomeV2(built.features, learned);
  assert.notStrictEqual(before.homeLambda, after.homeLambda,
    "学習した重みが予測に反映されていない(4特徴量が0のままの可能性)");
  console.log(`        → 学習前 homeLambda=${before.homeLambda.toFixed(3)} / 学習後 homeLambda=${after.homeLambda.toFixed(3)}`);
});


// ============================================================
// 再監査(2回目)で発見した欠陥A〜Gの再発防止
// ============================================================
test("★欠陥A: 利用者リクエストは予約枠を含む全体から使える(予約枠が利用者を締め出さない)", async () => {
  const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
  await b.init("2026-08-26");
  assert.strictEqual(b.remainingForUser(), 100, "利用者は全体を使えるべき");
  assert.strictEqual(b.remainingForJob(), 80, "日次ジョブだけが予約枠を残す");
  assert.ok(b.remainingForUser() > b.remainingForJob(), "利用者枠の方が広いはず");
  // 日次ジョブが使い切っても、利用者はまだ予約枠を使える
  for (let i = 0; i < 80; i++) b.tryReserve(1, "job");
  assert.strictEqual(b.tryReserve(1, "job").allowed, false, "ジョブは打ち止め");
  assert.strictEqual(b.tryReserveUser(1, "user").allowed, true, "利用者はまだ使える(これが予約枠の本来の目的)");
});

test("★欠陥B: 契約プランが後から判明したら、予算の上限に反映できる", async () => {
  const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
  await b.init("2026-08-26");
  assert.strictEqual(b.summary().dailyBudget, 100);
  assert.strictEqual(b.updateDailyBudget(7500), true, "後から上限を更新できるべき");
  assert.strictEqual(b.summary().dailyBudget, 7500);
  assert.strictEqual(b.remainingForUser(), 7500);
  assert.strictEqual(b.updateDailyBudget(0), false, "不正値は採用しない");
  assert.strictEqual(b.updateDailyBudget("abc"), false);
});

test("★欠陥B: server.js が API応答後に実際の上限を予算へ反映している", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(src.includes("budget.updateDailyBudget("),
    "判明した契約プランの上限を予算へ反映していない(Proでも100のまま扱われる)");
});

test("★欠陥E: 予算切れは『クラブが見つからない』に化けず、そのまま伝播する", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(/if \(e && e\.code === "BUDGET_EXHAUSTED"\) throw e;/.test(src),
    "resolveTeamId等で予算切れを握り潰してはいけない(利用者に誤った理由が出る)");
});

test("★欠陥G: 負傷データが取れていなければ supplied は false になる", () => {
  const ok = buildMatchFeatures(SRC({ teamId: 10 }), SRC({ teamId: 20 }), null);
  assert.strictEqual(ok.supplied.suspensionDiff, true);
  const ng = buildMatchFeatures(
    SRC({ teamId: 10, injuries: { error: "failed" } }),
    SRC({ teamId: 20 }), null);
  assert.strictEqual(ng.supplied.suspensionDiff, false, "取得失敗を『供給できた』と偽ってはいけない");
});

test("★欠陥F: テストランナーが async の失敗を本当に検出できる(空虚な検査にしない)", () => {
  // 第3次監査の指摘: 自分で作ったPromiseをawaitするだけでは、
  // runAll が await を落としても通ってしまう(意味のない検査)。
  // ランナーのソースを直接読み、fn() が await されていることを確認する。
  const src = fs.readFileSync(__filename, "utf8");
  const runAllBody = src.slice(src.indexOf("async function runAll"), src.indexOf("// ====", src.indexOf("async function runAll")));
  assert.ok(/await\s+t\.fn\(\)/.test(runAllBody),
    "runAll が fn() を await していない(async テストの失敗が握り潰される)");
  assert.ok(!/(?<!await\s)t\.fn\(\)/.test(runAllBody.replace(/await\s+t\.fn\(\)/g, "")),
    "await 無しの t.fn() 呼び出しが残っている");
});

test("★欠陥D: 予算の書き戻し間隔が短く、終了時の取りこぼし対策がある", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.ok(/budgetWritesPending >= 2/.test(src), "書き戻し間隔が長すぎる(消費の記録が失われる)");
  assert.ok(src.includes('process.on("beforeExit"'), "プロセス終了時の書き戻しが必要");
  // 第3次監査の指摘: SIGTERM/SIGINTを握ると既定の終了動作を上書きするため、
  // 書き戻し後に必ず自分で終了させること(Renderの再デプロイが固まらないように)
  assert.ok(/SIGTERM[\s\S]{0,300}process\.exit\(0\)/.test(src),
    "シグナルを握るなら、書き戻し後に自分で終了させる必要がある");
});

test("★欠陥C: 共有予算を使う場合、growthLogに食い違う説明を出さない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  assert.ok(src.includes("usingSharedBudget"), "共有かどうかで説明を分けていない");
  assert.ok(src.includes("サーバー共有の予算インスタンスを使用しています"),
    "実際に使われている上限を説明に反映していない");
});

test("★第4次監査: 予算切れが「選手が見つかりません」に化けない(キャッシュ汚染の防止)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const n = (src.match(/if \(e && e\.code === "BUDGET_EXHAUSTED"\) throw e;/g) || []).length;
  assert.ok(n >= 3, `チーム検索・選手検索(2経路)で予算切れを伝播すべき, got ${n}箇所`);
  const pdu = fs.readFileSync(path.join(ROOT, "server", "learning", "playerDailyUpdate.js"), "utf8");
  assert.ok(pdu.includes('e.code === "BUDGET_EXHAUSTED"'), "選手ID解決でも予算切れを伝播すべき");
});

test("★第4次監査: 定期実行(auto-collect)も jobCall として扱い、利用者予約枠を食わない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const seg = src.slice(src.indexOf("async function handleAutoCollectPredictions"));
  const body = seg.slice(0, seg.indexOf("\n}"));
  const calls = (body.match(/callApiFootball\(/g) || []).length;
  const flagged = (body.match(/jobCall: true/g) || []).length;
  assert.ok(calls === 0 || flagged >= 1, `定期実行のAPI呼び出しに jobCall が付いていない(${calls}件中${flagged}件)`);
});

test("★第4次監査: 両チームの順位を別々のリーグIDで取得する(standingsDiffの歪み防止)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  assert.ok(/fetchStandingsFeature\(inferLeagueIdFromFixtures\(awayForm/.test(src),
    "アウェイチームの順位を、そのチームのリーグから取得していない(0扱いになり差が誇張される)");
});

runAll().then(() => {
  console.log(failures === 0 ? "\nAll budget & feature audit tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
});
