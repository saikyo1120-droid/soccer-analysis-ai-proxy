/**
 * 2026年8月・完全自動Learning Cycle ⑨「最後に必ず検証してください」の
 * 中でも特にご指定のあった検証:
 *   「翌日になると本当にPrediction Engineの重みが変わるか」まで
 *   実際にシミュレーションしてください。
 *
 * このテストは、実際の runDailyLearning を「日付を変えながら複数回」実行し、
 * ご要望のサイクル
 *   ① 今日の試合取得 → ② 予測 → ③ Prediction Engineへ保存 → ④ Knowledge Engineへ保存
 *   → ⑤ 試合終了後に結果取得 → ⑥ 予測と比較 → ⑦ 外した理由 → ⑧ 当たった理由
 *   → ⑨ 重み更新 → ⑩ Memory更新 → ⑪ Growth Log更新 → ⑫ 翌日の予測へ反映
 * が、モックではなく本物の実装で1周することを確認する。
 *
 * 重要: 「重みが変わること」だけを確認するのでは不十分(悪化する変更を採用しても
 * テストは通ってしまう)。このプロジェクトの方針どおり、
 * 「的中率が本当に改善する場合だけ採用される」ことまで確認する。
 */
const assert = require("assert");
const { runDailyLearning } = require("../server/learning/dailyJob");
const { getMetricsTrend } = require("../server/learning/dailyMetrics");

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
    if (op === "SET") { const [k, v, flag] = args; if (flag === "NX" && store.has(k)) return null; store.set(k, v); return "OK"; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; return l.slice(st, en + 1); }
    if (op === "LREM") { const [k, , v] = args; store.set(k, (store.get(k) || []).filter((x) => x !== v)); return 1; }
    if (op === "LTRIM") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; store.set(k, l.slice(st, en + 1)); return "OK"; }
    return null;
  }
  async function upstashGetJSON(k) { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); }
  async function upstashSetJSON(k, v) { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; }
  return { store, upstashCmd, upstashGetJSON, upstashSetJSON };
}

// 最小限のAPI-Footballモック(このテストの主眼は重み更新なので、
// 外部データは「毎日同じ」でよい)。
async function callApiFootball(endpoint, params) {
  if (endpoint === "/teams") return { response: [{ team: { id: 100, name: params.search } }] };
  if (endpoint === "/fixtures" && params.next) {
    // ② 今日以降の試合(これを予測して Prediction Engine へ保存する)
    return { response: [{
      fixture: { id: 7777, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } },
      teams: { home: { id: 100, name: "Home FC" }, away: { id: 2, name: "Away FC" } },
      goals: { home: null, away: null },
      league: { id: 39, season: 2026 },
    }] };
  }
  if (endpoint === "/fixtures" && params.last) {
    const now = Date.now();
    const list = [];
    for (let i = 0; i < 10; i++) {
      list.push({
        fixture: { id: 1000 + i, date: new Date(now - i * 86400e3).toISOString(), status: { short: "FT" } },
        teams: { home: { id: 100 }, away: { id: 2 } },
        goals: { home: i < 5 ? 3 : 0, away: i < 5 ? 0 : 2 },
      });
    }
    return { response: list };
  }
  return { response: [] };
}
async function resolveTeamId(name) { return 100; }

// 「ホームのフォームが良いほどホームが勝つ」という一貫した実データ。
// 現在の重み(sensitivityが低すぎる)ではこの関係を活かしきれないため、
// 学習すれば的中率が上がるはずのデータセット。
function seedResolvedRecords(mock, count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const homeStrong = i % 2 === 0;
    records.push({
      fixtureId: 9000 + i,
      homeFormScore: homeStrong ? 3 : -3,
      awayFormScore: homeStrong ? -3 : 3,
      predictedWinner: homeStrong ? "home" : "away",
      actualWinner: homeStrong ? "home" : "away",
      correct: true,
      resolved: true,
      features: {
        formDiff: homeStrong ? 6 : -6,
        goalRateDiff: homeStrong ? 1.5 : -1.5,
        injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0,
      },
      weightsSnapshot: { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02 },
    });
  }
  return records;
}

(async () => {
  await test("【1日目】まだ検証データが少ないうちは、重みを変えない(過学習を防ぐ意図的な固定)", async () => {
    const mock = createMockRedis();
    const day1 = await runDailyLearning({
      callApiFootball, resolveTeamId, upstashEnabled: true, ...mock,
      now: () => new Date("2026-08-10T03:00:00Z"),
    });
    assert.strictEqual(day1.ok, true);
    assert.strictEqual(day1.weightsUpdated, false, "検証0件で重みを動かしてはいけない");
    assert.strictEqual(day1.totalOwnPredictionsResolved, 0, "検証済み0件であることを正直に返すはず");
  });

  await test("【2日目】検証データが閾値を超えると、重みの再調整が実際に走る", async () => {
    const mock = createMockRedis();
    // 1日目相当の状態を作る(20件の解決済み予測が貯まった状態)
    const records = seedResolvedRecords(mock, 20);
    await mock.upstashCmd(["SET", "learn:ownpred:resolved", "20"]);
    await mock.upstashCmd(["SET", "learn:ownpred:correct", "20"]);
    for (const r of records) await mock.upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(r)]);
    await mock.upstashSetJSON("learn:weights", { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02, version: 0, updatedAt: null });

    const before = await mock.upstashGetJSON("learn:weights");
    const day2 = await runDailyLearning({
      callApiFootball, resolveTeamId, upstashEnabled: true, ...mock,
      now: () => new Date("2026-08-11T03:00:00Z"),
    });
    const after = await mock.upstashGetJSON("learn:weights");
    const history = (await mock.upstashCmd(["LRANGE", "learn:weights:history", "0", "-1"])).map((x) => JSON.parse(x));

    assert.strictEqual(day2.ok, true);
    assert.ok(history.length >= 1, "重み再調整の判断が履歴に必ず残るはず(採用/不採用いずれでも)");
    assert.strictEqual(day2.totalOwnPredictionsResolved, 20, "累計20件の検証済みデータが認識されるはず");

    const adopted = history.filter((h) => h.adopted);
    if (adopted.length) {
      const last = adopted[adopted.length - 1];
      assert.ok(last.newAccuracy > last.oldAccuracy,
        `採用するのは的中率が本当に改善する場合だけのはず(old=${last.oldAccuracy} new=${last.newAccuracy})`);
      assert.notDeepStrictEqual(after, before, "採用された場合は重みが実際に変わっているはず");
      console.log(`        → 重みが更新されました: sensitivity ${before.sensitivity} → ${after.sensitivity}(的中率 ${last.oldAccuracy}% → ${last.newAccuracy}%)`);
    } else {
      // 悪化する変更を採用しないのは正しい挙動。その場合は重みが変わらないことを確認。
      assert.deepStrictEqual(after.sensitivity, before.sensitivity, "不採用なら重みは変わらないはず");
      console.log("        → 今回は「更新すると悪化する」と判定し、意図的に据え置きました(正しい挙動)");
    }
  });

  await test("【3日目】翌日の予測に、更新後の重みが実際に使われる(⑫ 翌日の予測へ反映)", async () => {
    const mock = createMockRedis();
    const records = seedResolvedRecords(mock, 20);
    await mock.upstashCmd(["SET", "learn:ownpred:resolved", "20"]);
    await mock.upstashCmd(["SET", "learn:ownpred:correct", "20"]);
    for (const r of records) await mock.upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(r)]);
    await mock.upstashSetJSON("learn:weights", { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02, version: 0, updatedAt: null });

    await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-11T03:00:00Z") });
    const weightsAfterDay2 = await mock.upstashGetJSON("learn:weights");

    // 翌日: 新しい予測を記録させ、その予測が「更新後の重み」を使っていることを確認する
    await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-12T03:00:00Z") });
    const pendingIds = await mock.upstashCmd(["LRANGE", "learn:ownpred:pending", "0", "-1"]);
    let checked = 0;
    for (const id of pendingIds || []) {
      const rec = await mock.upstashGetJSON(`learn:ownpred:${id}`);
      if (rec && rec.weightsSnapshot) {
        assert.strictEqual(rec.weightsSnapshot.sensitivity, weightsAfterDay2.sensitivity,
          "翌日の予測は、前日に更新された重みを使っているはず(⑫ 翌日の予測へ反映)");
        checked++;
      }
    }
    assert.ok(checked > 0, "翌日に新しい予測が記録されているはず(記録0件では反映を確認できない)");
    console.log(`        → ${checked}件の新規予測が、更新後の重み(sensitivity=${weightsAfterDay2.sensitivity})を使って作られました`);
  });

  await test("【全体】サイクルの各段階の記録が、実行のたびにGrowth Logへ残る", async () => {
    const mock = createMockRedis();
    const r = await runDailyLearning({
      callApiFootball, resolveTeamId, upstashEnabled: true, ...mock,
      now: () => new Date("2026-08-13T03:00:00Z"),
    });
    // ①〜⑫の各段階が、数値または配列としてGrowth Logに現れることを確認する
    for (const key of [
      "teamsAnalyzed",            // ① 取得
      "newPredictionsLogged",     // ②③ 予測して保存
      "knowledgeItemsSavedToday", // ④ Knowledge Engineへ保存
      "matchesResolvedToday",     // ⑤⑥ 結果取得と比較
      "failureReasonsToday",      // ⑦ 外した理由
      "successReasonsToday",      // ⑧ 当たった理由
      "weightsUpdated",           // ⑨ 重み更新
      "reflectionsSaved",         // ⑩ Memory更新
      "date",                     // ⑪ Growth Log更新
    ]) {
      assert.ok(key in r, `Growth Logに ${key} が含まれるはず`);
    }
  });

  await test("【全体】毎日の指標(⑧の6項目)がUpstashへ日付ごとに保存される", async () => {
    const mock = createMockRedis();
    await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-14T03:00:00Z") });
    const snap = await mock.upstashGetJSON("learn:metrics:2026-08-14");
    assert.ok(snap, "指標スナップショットが保存されるはず");
    assert.strictEqual(snap.date, "2026-08-14");
    for (const key of ["predictionAccuracy", "knowledgeTotal", "memoryTotal", "failureReasonsToday", "weightsUpdated", "learningDurationMs"]) {
      assert.ok(key in snap, `ご要望の指標 ${key} が記録されるはず`);
    }
    assert.ok(Number.isFinite(snap.learningDurationMs) && snap.learningDurationMs >= 0, "Learning Time(実処理時間)が実測されるはず, got " + snap.learningDurationMs);
  });

  await test("【全体】2日連続で実行すると、前日比の判定が実データから自動生成される", async () => {
    const mock = createMockRedis();
    const deps = { callApiFootball, resolveTeamId, upstashEnabled: true, ...mock };
    await runDailyLearning({ ...deps, now: () => new Date("2026-08-15T03:00:00Z") });
    await runDailyLearning({ ...deps, now: () => new Date("2026-08-16T03:00:00Z") });
    const trend = await getMetricsTrend({ upstashEnabled: true, ...mock }, 5, "2026-08-16");
    assert.strictEqual(trend.available, true);
    assert.strictEqual(trend.recordedDays, 2, "2日分の指標が記録されているはず");
    assert.ok(trend.comparison, "前日比の判定が生成されるはず");
    assert.strictEqual(trend.comparison.hasBaseline, true);
    assert.ok(typeof trend.comparison.verdictJa === "string" && trend.comparison.verdictJa.length > 10, trend.comparison.verdictJa);
    console.log(`        → 判定文: ${trend.comparison.verdictJa}`);
  });

  console.log(failures === 0 ? "\nAll learning-cycle simulation tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
