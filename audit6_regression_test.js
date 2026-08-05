/**
 * scripts/audit6_regression_test.js
 * ------------------------------------------------
 * 2026年8月・第6次監査で発見した欠陥に対する回帰テスト。
 *
 * 第6次監査は「第5次の修正そのものを疑う」ための検証でした。実際に、
 * 第5次で入れた修正が別の場所で破られていたり、修正自体が新しい不具合
 * (成長ログの失敗理由がまるごと消える等)を作っていたことが分かりました。
 *
 * 各テストの説明文には、その欠陥が**実際に利用者に何をしていたか**を
 * 書いてあります。単に「動く」ことではなく「嘘をつかない」ことを検証します。
 *
 * 実行方法: node scripts/audit6_regression_test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { buildMatchFeatures } = require(path.join(ROOT, "server/learning/featureEngine"));
const { computeFeatureAvailability } = require(path.join(ROOT, "server/learning/predictionModel"));
const {
  computeFatigueFeature, fetchHeadToHeadFeature,
} = require(path.join(ROOT, "server/learning/features"));
const { mergeGrowthLogs } = require(path.join(ROOT, "server/learning/dailyJob"));
const { createKnowledgeStore, isExpired } = require(path.join(ROOT, "server/knowledge/knowledgeStore"));
const { compareSnapshots } = require(path.join(ROOT, "server/learning/dailyMetrics"));
const { describeRatingTrend } = require(path.join(ROOT, "server/learning/playerDailyUpdate"));
const { describeEvaluationChange } = require(path.join(ROOT, "server/memory/predictionMemory"));
const { leagueEntityKeyFromId, leagueEntityKey, EXTENDED_LEAGUES } = require(path.join(ROOT, "server/learning/leagueConfig"));

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function createMockRedis() {
  const store = new Map();
  const lists = new Map();
  let failGet = false;
  async function upstashCmd(cmd) {
    const [op, key, ...rest] = cmd;
    if (op === "GET") {
      if (failGet) throw new Error("simulated upstash failure");
      return store.has(key) ? store.get(key) : null;
    }
    if (op === "SET") { store.set(key, rest[0]); return "OK"; }
    if (op === "INCR") { const n = (Number(store.get(key)) || 0) + 1; store.set(key, String(n)); return n; }
    if (op === "INCRBY") { const n = (Number(store.get(key)) || 0) + Number(rest[0]); store.set(key, String(n)); return n; }
    if (op === "EXPIRE") return 1;
    if (op === "RPUSH") { const l = lists.get(key) || []; l.push(rest[0]); lists.set(key, l); return l.length; }
    if (op === "LRANGE") return (lists.get(key) || []).slice();
    if (op === "LTRIM") {
      const l = lists.get(key) || [];
      const start = Number(rest[0]);
      lists.set(key, start < 0 ? l.slice(start) : l.slice(start));
      return "OK";
    }
    if (op === "LREM") return 0;
    return null;
  }
  return {
    upstashCmd,
    upstashGetJSON: async (k) => { const v = store.get(k); return v === undefined ? null : JSON.parse(v); },
    upstashSetJSON: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
    _store: store, _lists: lists,
    _setFailGet: (v) => { failGet = v; },
  };
}

// =====================================================================
// ① 第5次の修正が別の場所で破られていた(特徴量のでっち上げの残り)
// =====================================================================

test("★欠陥30: 直近試合が1件も取れなかったチームを「フォーム0」と断定しない", () => {
  // 【この欠陥が実際にしていたこと】
  //   第5次監査で computeMatchFeatures の `?? 0` は消したが、その手前の
  //   buildTeamContext に `form.currentFormScore ?? form.formScore ?? 0` が
  //   残っていた。/fixtures が空応答(200だが0件)を返す昇格直後のクラブなどは
  //   「フォームスコア0」と断定され、相手に一方的な差を与えていた。
  const good = {
    teamId: 1,
    form: { currentFormScore: 1.4, avgGoalsFor: 2, avgGoalsAgainst: 0.6, matchesLast7Days: 2, fixtures: [{}] },
    injuries: { injuryCount: 1, suspendedPlayers: [] },
    standings: { played: 10, points: 20 },
  };
  const noFixtures = {
    teamId: 2,
    form: { currentFormScore: null, avgGoalsFor: null, avgGoalsAgainst: null, matchesLast7Days: null, fixtures: [] },
    injuries: { injuryCount: 1, suspendedPlayers: [] },
    standings: { played: 10, points: 20 },
  };
  const built = buildMatchFeatures(good, noFixtures, null);
  assert.strictEqual(built.awayCtx.formScore, null, "取れなかったフォームはnullであるべき");
  assert.strictEqual(built.features.formDiff, 0, "片側が不明ならformDiffは0であるべき");
  assert.strictEqual(built.supplied.formDiff, false, "供給できなかったと正直に申告すべき");
});

test("★欠陥31: 試合データが取れないチームを「完全に休養十分(0試合)」と断定しない", () => {
  // computeFatigueFeature は常に数値を返していたため、取得失敗時まで
  // 「直近7日間の試合数は0」と断定し、fatigueDiff に嘘の差を作っていた。
  assert.strictEqual(computeFatigueFeature([], Date.now()).matchesLast7Days, null,
    "試合データが1件も無ければ「不明」であるべき");
  const now = Date.now();
  const withFixtures = computeFatigueFeature(
    [{ fixture: { date: new Date(now - 2 * 86400000).toISOString() } }], now);
  assert.strictEqual(withFixtures.matchesLast7Days, 1, "データがあれば従来通り数える");
});

test("★欠陥32: 勝点がnullの順位データを「1試合あたり0勝点」に化けさせない", () => {
  // `standings.points / standings.played` は、points が null のとき
  // **null / 38 === 0** となり、「1試合あたり0勝点」という嘘の値になっていた。
  const src = {
    teamId: 1,
    form: { currentFormScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, matchesLast7Days: 1, fixtures: [{}] },
    injuries: { injuryCount: 0, suspendedPlayers: [] },
    standings: { points: null, played: 38 },
  };
  const built = buildMatchFeatures(src, { ...src, teamId: 2, standings: { points: 80, played: 38 } }, null);
  assert.strictEqual(built.homeCtx.pointsPerGame, null, "勝点が不明ならnullであるべき(0にしない)");
  assert.strictEqual(built.features.standingsDiff, 0);
});

test("★欠陥33: 過去対戦の取得に失敗したのに「考慮した」と申告しない", async () => {
  // 取得失敗時に 0勝0敗 を返していたため、「両方0でそろっている」と判定され、
  // **取れなかったのに『過去対戦成績を考慮した』**ことになっていた。
  // しかも画面には「見つかりませんでした」と表示され、1つの回答の中で矛盾していた。
  const failing = async () => { throw new Error("simulated failure"); };
  const h2h = await fetchHeadToHeadFeature(1, 2, failing);
  assert.strictEqual(h2h.homeSideWins, null, "取得失敗時の勝敗数はnullであるべき");
  const ctx = { formScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, pointsPerGame: 1, matchesLast7Days: 1, injuryCount: 0, suspensionCount: 0 };
  const avail = computeFeatureAvailability(ctx, ctx, h2h);
  assert.strictEqual(avail.headToHeadDiff, false, "取れていないのに「考慮した」と申告してはいけない");
});

// =====================================================================
// ② 第5次の修正そのものが作り出した後退
// =====================================================================

test("★欠陥34: 同じ日に2回実行しても、今日分析した失敗理由・成功理由が消えない", () => {
  // 【この欠陥が実際にしていたこと】
  //   第5次監査で入れた capList は文字列だけを想定して
  //   `typeof s === "string"` で絞り込んでいたが、failureReasonsToday /
  //   successReasonsToday は**オブジェクトの配列**だった。そのため
  //   同じ日の2回目の実行で、その日分析した理由が**まるごと消えていた**。
  //   Renderのスリープ復帰や6時間ごとのcronで同日2回目は日常的に起きる。
  const run = () => ({
    ranAt: "t", facts: [], errors: ["e1", "e1", "e2"],
    failureReasonsToday: [{ id: "a", labelJa: "怪我人を軽視した", detail: "d", teamEn: "X" }],
    successReasonsToday: [{ id: "s", labelJa: "フォームを正しく評価した", detail: "d", teamEn: "X" }],
  });
  let merged = null;
  for (let i = 0; i < 4; i++) merged = mergeGrowthLogs(merged, run());
  assert.strictEqual(merged.failureReasonsToday.length, 1, "失敗理由が消えている: " + JSON.stringify(merged.failureReasonsToday));
  assert.strictEqual(merged.successReasonsToday.length, 1, "成功理由が消えている");
  assert.strictEqual(merged.failureReasonsToday[0].labelJa, "怪我人を軽視した", "内容が保たれているべき");
  assert.strictEqual(merged.failureReasonsToday[0].occurrences, 4, "出現回数が正しく積み上がるべき");
});

test("★欠陥35: エラー一覧の「回数」の注記が入れ子にならない", () => {
  // capList が「(N件)」を文面に書き足していたため、次の実行でもう一度
  // 通すと「(2件)(2件)」と入れ子になり、件数そのものも誤りになっていた。
  const run = () => ({ ranAt: "t", facts: [], errors: ["e1", "e1"] });
  let merged = null;
  for (let i = 0; i < 5; i++) merged = mergeGrowthLogs(merged, run());
  for (const e of merged.errors) {
    assert.ok(!/【\d+回】.*【\d+回】/.test(e), "回数の注記が入れ子になっている: " + e);
  }
  assert.strictEqual(merged.errors.length, 1, "同じエラーは1行にまとまるべき: " + JSON.stringify(merged.errors));
  assert.ok(/【10回】$/.test(merged.errors[0]), "回数が正しく積み上がるべき: " + merged.errors[0]);
});

test("★欠陥36: 検証用データが用意できないときは、見せかけの検証をせず重みを変えない", () => {
  // 検証用に取り置けるデータが足りないとき、trainSetとvalidSetに**同じ配列**を
  // 入れていたため、「学習用でも検証用でも改善した候補だけを採用する」という
  // 二重の関門が実質1回に潰れていた。それどころか採用理由には
  // 「取り置いた検証用N件でも改善したため採用しました」と書かれ、
  // **やっていない検証をやったと記録に残していた**。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyJob.js"), "utf8");
  assert.ok(/const validSet = canHoldout \? usable\.slice\(usable\.length - holdoutSize\) : \[\];/.test(src),
    "検証用データが用意できない場合は空にすべき");
  assert.ok(/const fitSet = canHoldout \? usable\.slice\(0, usable\.length - holdoutSize\) : usable;/.test(src),
    "学習用は検証用と重ならない範囲にすべき");
  assert.ok(/skipped_insufficient_holdout/.test(src),
    "見送った本当の理由を記録すべき");
});

test("★欠陥37: 記録が上限に達して窓がずれても、評価が動かない日は文面が変わらない", () => {
  // 第5次で「記録N回」は消したが、基準にしていた「初回の値」は記録が
  // 60件に達すると窓がずれて毎日変わる。評価が1ミリも動いていなくても
  // 文面が毎日変わり、知識件数が毎日1ずつ水増しされ続ける
  // (60日後に必ず発火する、時限式の同じ欠陥)。
  let h = [];
  for (let i = 0; i < 60; i++) h.push({ date: "d" + i, rating: 6.5 + i * 0.02 });
  const seen = new Set();
  for (let d = 0; d < 60; d++) {
    h.push({ date: "x" + d, rating: h[h.length - 1].rating });
    h = h.slice(-60);
    seen.add(describeRatingTrend(h));
  }
  assert.strictEqual(seen.size, 1, "窓がずれただけで文面が変わっている: " + Array.from(seen).join(" | "));
});

// =====================================================================
// ③ 成長の偽装(保存層・指標層)
// =====================================================================

test("★欠陥38: 保存先の読み取りに失敗したとき「新しい知識」として数えない", async () => {
  // 【この欠陥が実際にしていたこと】
  //   重複判定に upstashGetJSON を使っていたが、この関数は失敗を握りつぶして
  //   null を返す。Upstashが一瞬でも不調だと、何ヶ月も前からある知識が
  //   「今日新しく覚えた知識」として数えられ、累計カウンターが二重に増え、
  //   成長レポートが「昨日より賢くなりました」と表示していた。
  //   何も学んでいないのに学んだと報告する状態だった。
  const mock = createMockRedis();
  const store = createKnowledgeStore({ upstashEnabled: true, ...mock });
  const item = { teamEn: "Test FC", category: "recentFormTrend", type: "fact", statement: "得失点差が改善しました。", computedAt: new Date().toISOString() };
  const first = await store.saveKnowledgeItem(item);
  assert.strictEqual(first.saved, true);

  mock._setFailGet(true);
  const duringOutage = await store.saveKnowledgeItem(item);
  mock._setFailGet(false);
  assert.strictEqual(duringOutage.saved, false, "読み取りに失敗したときに「新しく保存した」と報告してはいけない");
  assert.strictEqual(duringOutage.reason, "LOOKUP_FAILED");
  const counter = Number(mock._store.get("knowledge:totalItemsSavedCounter"));
  assert.strictEqual(counter, 1, "累計カウンターが水増しされている: " + counter);
});

test("★欠陥39: 一覧から溢れて消えた知識を、次に同じ内容が来たときに復帰させる", async () => {
  // 一覧(byTeam)の上限から溢れると本体だけが残り、重複判定でヒットするため
  // 一覧へ戻る機会が永久に来ない=二度と読み出せない幽霊知識になっていた。
  const mock = createMockRedis();
  const store = createKnowledgeStore({ upstashEnabled: true, ...mock });
  const item = { teamEn: "Test FC", category: "recentFormTrend", type: "fact", statement: "ある事実。", computedAt: new Date().toISOString() };
  await store.saveKnowledgeItem(item);
  // 一覧から人為的に取り除く(上限で押し出された状態を再現)
  mock._lists.set("knowledge:byTeam:Test FC", []);
  const again = await store.saveKnowledgeItem(item);
  assert.strictEqual(again.reason, "DUPLICATE_RELINKED", "一覧へ復帰させるべき: " + again.reason);
  const active = await store.getActiveKnowledge("Test FC");
  assert.strictEqual(active.facts.length, 1, "復帰後は読み出せるべき");
});

test("★欠陥40: 観測日時が壊れた知識を、永久に有効な根拠として使わない", () => {
  // 日時をパースできないレコードを「失効していない」として扱っていたため、
  // いつのものか分からない知識が永久に根拠として使われ続けていた。
  assert.strictEqual(isExpired({ type: "fact", computedAt: "こわれた日付" }, Date.now()), true,
    "いつのものか分からない知識は根拠にできない");
  assert.strictEqual(isExpired({ type: "fact", computedAt: new Date().toISOString() }, Date.now()), false,
    "正常な日時の知識は有効なままであるべき");
});

test("★欠陥41: 失敗を分析した「活動量」だけで「昨日より賢くなりました」と言わない", () => {
  // 【この欠陥が実際にしていたこと】
  //   failureReasonsToday はその日の**外れた予測の件数**なのに、
  //   これが0より大きいだけで improved=true(緑の📈「昨日より賢くなりました」)に
  //   なっていた。知識が1件も増えず、記憶も増えず、的中率が8ポイント下がった日でも
  //   「昨日より賢くなりました: 外れた理由を3件分析しました」と表示されていた。
  const yesterday = { date: "2026-08-03", knowledgeTotal: 100, memoryTotal: 50, predictionAccuracy: 60 };
  const today = {
    date: "2026-08-04", knowledgeTotal: 100, memoryTotal: 50, predictionAccuracy: 52,
    failureReasonsToday: 3, weightsUpdated: false,
  };
  const c = compareSnapshots(today, yesterday);
  assert.notStrictEqual(c.improved, true, "悪化した日を「賢くなった」と言ってはいけない: " + c.verdictJa);
  assert.ok(c.verdictJa.includes("下がりました"), c.verdictJa);

  // 実際に知識が増えた日は、これまで通り improved=true になる
  const better = compareSnapshots({ ...today, knowledgeTotal: 112, predictionAccuracy: 60 }, yesterday);
  assert.strictEqual(better.improved, true, better.verdictJa);
  assert.ok(better.verdictJa.includes("知識が12件増えました"), better.verdictJa);
});

test("★欠陥42: 連続していない2日を比べて「昨日より」と言わない(実装検査)", () => {
  // recorded[0]/recorded[1] は「記録がある直近2日」であって、必ずしも
  // 連続した2日ではない。日次ジョブが1日休むと、2日分の増加を
  // 「昨日より知識が12件増えました」と表示していた。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/dailyMetrics.js"), "utf8");
  assert.ok(/daysApart/.test(src), "比較した2日が何日離れているかを見ていない");
  assert.ok(/adjacentDays/.test(src), "連続した2日かどうかを呼び出し側へ伝えていない");
});

// =====================================================================
// ④ 表示・診断の正直さ
// =====================================================================

test("★欠陥43: 実績の読み出し失敗を「記録を開始したばかり」と表示しない(index.html検査)", () => {
  // 保存先の読み取りに失敗した場合も total/resolved が0で返るため、
  // 何ヶ月も実績を積み上げた後の一時的な通信障害で
  // 「記録を開始したばかりです」と表示されていた。
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(/if \(stats\.error\)/.test(html), "読み出し失敗を区別していない");
  assert.ok(/記録を読み出せませんでした/.test(html), "読み出せなかったことを伝える文言が無い");
});

test("★欠陥44: 古い記録で「的中率: undefined%」と表示しない(index.html検査)", () => {
  // `!== null` は undefined を通してしまうため、これらのフィールドを持たない
  // 古い記録では「的中率: undefined%」と表示されていた。
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(/Number\.isFinite\(accBefore\) && Number\.isFinite\(accAfter\)/.test(html),
    "数値かどうかで判定していない");
  assert.ok(/log\.matchesResolvedToday \?\? 0/.test(html), "未定義の件数がそのまま描画される");
});

test("★欠陥45: 比較できなかったことを、ゼロと見分けのつかないダッシュで表示しない", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(/const fmtDelta = /.test(html), "差分の表示用フォーマッタが無い");
  assert.ok(/"比較不可"/.test(html), "比較できなかったことを言葉で示していない");
});

test("★欠陥46: 「すべて正常」と言うとき、確認できていない項目を無視しない(server.js検査)", () => {
  // buildEngineStatuses は "unknown"(確認できなかった)も返すのに、集計では
  // error でも warn でもないため無視され、確認できていない項目があるのに
  // 「すべての構成要素が正常に動作しています」と表示していた。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(/const unknownCount = engines\.filter\(\(e\) => e\.status === "unknown"\)\.length;/.test(src),
    "unknownを数えていない");
  assert.ok(/状態を確認できていません/.test(src), "確認できていないことを伝える文言が無い");
});

test("★欠陥47: 保存先が本当に読めているか確認せずに「読み書きできています」と言わない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/learning/healthCheck.js"), "utf8");
  assert.ok(!/接続設定が有効です。実際に読み書きできています/.test(src),
    "環境変数の有無だけで「読み書きできている」と断言してはいけない");
  assert.ok(/実際に学習記録を読み出せています/.test(src), "実際に読めた場合の表現が無い");
});

test("★欠陥48: 重みを更新しなかった理由を推測で説明しない", () => {
  // 「更新すると精度が悪化すると判定した」と断言していたが、実際の理由は
  // 4通りあり、うち3つは**比較そのものを行っていない**のに、
  // 行ったうえで見送ったと報告していた。
  const src = fs.readFileSync(path.join(ROOT, "server/learning/healthCheck.js"), "utf8");
  assert.ok(!/「更新すると精度が悪化する」と判定したため/.test(src),
    "確認していない理由を断言してはいけない");
  assert.ok(/weightsHistoryNoteJa/.test(src), "実際に記録された理由を読んでいない");
});

test("★欠陥49: 選手が0人のチームを、固定値62で比較しない(server.js検査)", () => {
  // 選手が0人の側があると teamAvgSrv が固定値62を返すため、
  // 「◯◯は攻撃力で相手を上回っており(平均62.0 対 62.0)」という、
  // 定数から作った(しかも両者同値の)比較文が生成されていた。
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(/if \(!homeP\.length \|\| !awayP\.length\)/.test(src), "空ロースターを弾いていない");
  assert.ok(/架空の平均値で比較することはしません/.test(src), "断る理由を日本語で伝えていない");
});

test("★欠陥50: 選手情報の一時的な取得失敗を「見つからない」としてキャッシュしない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const fn = src.slice(src.indexOf("async function resolvePlayerId"), src.indexOf("async function handlePlayerSeasonStats"));
  assert.ok(/hadTransientError/.test(fn), "一時障害を記録していない");
  assert.ok(/TRANSIENT_ERROR/.test(fn), "一時障害を「見つからない」と区別していない");
});

test("★欠陥51: 中身が欠けた「試合後の振り返り」を1週間キャッシュしない", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  assert.ok(/subFetchFailed/.test(src), "サブ取得の失敗を記録していない");
  assert.ok(/dataIncompleteNoteJa/.test(src), "欠けていることを利用者へ伝えていない");
});

// =====================================================================
// ⑤ 「作ったのに使われていなかった」機能
// =====================================================================

test("★欠陥52: 前回との比較(⑤⑳)が実際に画面へ表示される", () => {
  // サーバー側で組み立てて memoryComparison として返していたのに、
  // 画面のどこからも参照しておらず、利用者は一度も見たことがなかった
  // (リクエストのたびにUpstashを1回読む費用だけ払っていた)。
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.ok(/data\.memoryComparison/.test(html), "memoryComparisonを画面が読んでいない");
  assert.ok(/前回この対戦を見たときとの違い/.test(html), "表示用の見出しが無い");
});

test("★欠陥53: IDを動的に解決するリーグの知識も読み出せる", async () => {
  // 拡張5リーグのうち4つは静的な設定にIDを持たず、実行時に解決して
  // Upstashへキャッシュしている。読み出し側は静的な設定のIDとしか
  // 照合していなかったため、その4リーグの知識は毎日集めているのに
  // 一度も読み出せなかった。
  const dynamicLeague = EXTENDED_LEAGUES.find((l) => !l.id);
  assert.ok(dynamicLeague, "動的解決のリーグが設定に存在するはず");
  const cacheKey = `learn:leagueid:${dynamicLeague.nameEn}:${dynamicLeague.searchCountry || dynamicLeague.countryJa}`;
  const upstashGetJSON = async (k) => (k === cacheKey ? { id: 9999 } : null);
  const entity = await leagueEntityKeyFromId(9999, { upstashGetJSON, upstashEnabled: true });
  assert.strictEqual(entity, leagueEntityKey(dynamicLeague),
    "動的に解決したIDから知識のキーを逆引きできるべき");
});

test("★欠陥54: リーグの得点/アシストランキングが仮説の根拠として使われる", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/reasoning/hypothesisGenerator.js"), "utf8");
  assert.ok(/leagueTopScorers/.test(src), "得点ランキングがどの仮説の根拠にもなっていない");
  assert.ok(/leagueTopAssists/.test(src), "アシストランキングがどの仮説の根拠にもなっていない");
});

// =====================================================================
// ⑥ 記憶の説明の正直さ
// =====================================================================

test("★欠陥55: データが取れなくなっただけの変化を、サッカー的な理由として説明しない", () => {
  const base = {
    predictedWinner: "home", homeWinPct: 55,
    features: { formDiff: 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0.8, topScorerDiff: 0 },
    supplied: { xgDiff: true, formDiff: true },
  };
  const now = {
    predictedWinner: "away", homeWinPct: 40,
    features: { ...base.features, xgDiff: 0 },
    supplied: { xgDiff: false, formDiff: true },
  };
  const c = describeEvaluationChange(base, now);
  const joined = c.reasonsJa.join(" ");
  assert.ok(!/xG.*動きました/.test(joined), "データ障害をサッカー的な理由として述べてはいけない: " + joined);
  assert.ok(joined.includes("取得できませんでした"), "取得できなかったことを正直に伝えるべき: " + joined);
});

test("★欠陥56: 重みが更新されたか確認せずに「学習したから」と断定しない", () => {
  const mk = (winner, version) => ({
    predictedWinner: winner, homeWinPct: winner === "home" ? 55 : 45,
    features: { formDiff: 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0 },
    supplied: {}, weightsVersion: version,
  });
  const same = describeEvaluationChange(mk("home", 3), mk("away", 3));
  assert.ok(!same.reasonsJa.join(" ").includes("学習して重み"),
    "重みが同じなのに「学習したから」と述べてはいけない: " + same.reasonsJa.join(" "));
  const changed = describeEvaluationChange(mk("home", 3), mk("away", 4));
  assert.ok(changed.reasonsJa.join(" ").includes("学習して重み"),
    "実際に更新されている場合は説明すべき: " + changed.reasonsJa.join(" "));
});

test("★欠陥57: 予測自動収集が、失敗しても成功を報告しない(server.js検査)", () => {
  const src = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  // 第7次監査での是正に追随: `/error/i` は個々の試合の注記にも一致するため、
  // 8件中1件だけ失敗した日でも ok:false になり、cronがエンドポイントを
  // もう一度叩いて(さらにAPIを消費して)失敗通知を出していた。
  // 報告すべきは「処理そのものが立ち上がらなかった」場合だけ。
  assert.ok(/const hadFatalError = notes\.some\(\(n\) => \/\^\(resolve\|log\) phase error:\/\.test\(n\)\);/.test(src),
    "処理そのものの失敗を ok に反映していない(監視が障害に気づけない)");
  assert.ok(/ok: !hadFatalError/.test(src), "okの算出に反映されていない");
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
    ? `\nAll audit-6 regression tests PASSED (${queue.length} tests).`
    : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
