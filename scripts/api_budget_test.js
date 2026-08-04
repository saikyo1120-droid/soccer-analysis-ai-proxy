/**
 * 2026年8月・優先順位⑦で新設したAPIリクエスト予算ガード(server/learning/
 * apiBudget.js)のテスト。「予算が尽きたときに黙って失敗するのではなく、
 * 正直な理由を残して見送る」ことを重点的に検証する。
 */
const assert = require("assert");
const { createApiBudget, DEFAULT_DAILY_BUDGET, DEFAULT_USER_RESERVE } = require("../server/learning/apiBudget");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  async function upstashGetJSON(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; }
  async function upstashSetJSON(key, value) { store.set(key, JSON.stringify(value)); return true; }
  return { upstashGetJSON, upstashSetJSON, store };
}

(async () => {
  await test("既定値は無料プラン(100/日)と利用者用予約(20)である", () => {
    assert.strictEqual(DEFAULT_DAILY_BUDGET, 100);
    assert.strictEqual(DEFAULT_USER_RESERVE, 20);
  });

  await test("予算内のリクエストは許可され、残量が正しく減る", async () => {
    const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    assert.strictEqual(b.remainingForJob(), 80, "100-20=80から始まるはず");
    const r = b.tryReserve(30, "テスト処理");
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.reason, null);
    assert.strictEqual(b.remainingForJob(), 50);
  });

  await test("予算を超えるリクエストは拒否され、利用者向けの正直な理由が返る", async () => {
    const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    b.tryReserve(70, "先に使う処理");
    const r = b.tryReserve(30, "選手データ更新");
    assert.strictEqual(r.allowed, false, "残り10件しか無いので30件は拒否されるはず");
    assert.ok(r.reason, "理由が必ず入っているはず");
    assert.ok(r.reason.includes("選手データ更新"), "何を見送ったのかが理由に含まれるはず: " + r.reason);
    assert.ok(r.reason.includes("API_DAILY_BUDGET"), "どうすれば解決するかが理由に含まれるはず: " + r.reason);
    assert.strictEqual(b.remainingForJob(), 10, "拒否された分は消費されないはず");
  });

  await test("利用者用の予約分は日次ジョブが食い潰せない", async () => {
    const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    const r = b.tryReserve(81, "全部使おうとする処理");
    assert.strictEqual(r.allowed, false, "80件までしか使えないはず(利用者用に20件残す)");
  });

  await test("同じ日の2回目の実行では、1回目の消費が引き継がれる(Upstash)", async () => {
    const mock = createMockRedis();
    const b1 = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
    await b1.init("2026-08-05");
    b1.tryReserve(50, "1回目");
    await b1.flush();

    const b2 = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
    await b2.init("2026-08-05");
    assert.strictEqual(b2.remainingForJob(), 30, "1回目の50件が引き継がれて 80-50=30 のはず");
    assert.strictEqual(b2.summary().spentBeforeThisRun, 50);
  });

  await test("日付が変われば予算はリセットされる", async () => {
    const mock = createMockRedis();
    const b1 = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
    await b1.init("2026-08-05");
    b1.tryReserve(70, "前日");
    await b1.flush();

    const b2 = createApiBudget({ upstashEnabled: true, ...mock, dailyBudget: 100, userReserve: 20 });
    await b2.init("2026-08-06");
    assert.strictEqual(b2.remainingForJob(), 80, "翌日は満額から始まるはず");
  });

  await test("Upstash未設定でも動作し、その旨をsummaryで正直に示す", async () => {
    const b = createApiBudget({ upstashEnabled: false, dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    assert.strictEqual(b.tryReserve(10, "x").allowed, true);
    assert.strictEqual(b.summary().persistent, false, "日をまたいだ累積ができないことを正直に示すはず");
    assert.strictEqual(await b.flush(), false);
  });

  await test("refund: 予約したが使わなかった分を返却できる", async () => {
    const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    b.tryReserve(30, "予約");
    assert.strictEqual(b.remainingForJob(), 50);
    b.refund(30);
    assert.strictEqual(b.remainingForJob(), 80, "返却後は元に戻るはず");
  });

  await test("canAfford: 予算を消費せずに残量を判定できる", async () => {
    const b = createApiBudget({ dailyBudget: 100, userReserve: 20 });
    await b.init("2026-08-05");
    assert.strictEqual(b.canAfford(80), true);
    assert.strictEqual(b.canAfford(81), false);
    assert.strictEqual(b.remainingForJob(), 80, "canAffordは消費しないはず");
  });

  await test("有料プラン想定(予算7500)ではより多くの処理が許可される", async () => {
    const b = createApiBudget({ dailyBudget: 7500, userReserve: 500 });
    await b.init("2026-08-05");
    assert.strictEqual(b.tryReserve(5000, "大量更新").allowed, true, "有料プランなら環境変数を変えるだけで自動的に増えるはず");
  });

  console.log(failures === 0 ? "\nAll api-budget tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
