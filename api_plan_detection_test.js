/**
 * 2026年8月・優先順位⑪で追加した「契約プランの自動判定」のテスト。
 *
 * API-Footballは全レスポンスに x-ratelimit-requests-limit ヘッダーで
 * 「そのAPIキーの1日あたり上限」を返してくる(公式ドキュメント
 * "HOW RATELIMIT WORKS" に記載)。これを読むことで、利用者が
 * API_DAILY_BUDGET を手で設定しなくても、日次ジョブが実際の契約プランに
 * 自動追従できる(設定し忘れ・設定間違いによる予算超過事故を防ぐ)。
 */
const assert = require("assert");
const path = require("path");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

process.env.API_FOOTBALL_KEY = "test-key";
process.env.PORT = "0";
delete process.env.API_DAILY_BUDGET;

// callApiFootball 経由でも本当にヘッダーが記録されるか(結線されているか)を
// 確かめるためのモック。キャッシュを避けるためリーグIDは呼び出しごとに変える。
let mockHeaders = {};
const realFetch = global.fetch;
global.fetch = async (urlArg) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(urlArg);
  return {
    ok: true,
    headers: { get: (k) => (mockHeaders[String(k).toLowerCase()] ?? null) },
    json: async () => ({ errors: [], response: [] }),
  };
};

const srv = require(path.join(__dirname, "..", "server", "server.js"));
const { getApiPlanInfo, recordRateLimitHeaders, handleFixturesToday, server } = srv;

// ヘッダーだけを持つ疑似レスポンスを作るヘルパー(単体テスト用)
const fakeRes = (headers) => ({ headers: { get: (k) => (headers[String(k).toLowerCase()] ?? null) } });

(async () => {
  await test("API呼び出し前は、契約プランを自動判定できていないことを正直に返す(0件だと嘘をつかない)", () => {
    const info = getApiPlanInfo();
    assert.strictEqual(info.detectedDailyLimit, null);
    assert.strictEqual(info.planNameJa, null);
    assert.ok(info.noteJa.includes("自動判定できていません"), info.noteJa);
  });

  await test("無料プラン(上限100)のヘッダーから Free と判定する", () => {
    recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "88" }));
    const info = getApiPlanInfo();
    assert.strictEqual(info.detectedDailyLimit, 100);
    assert.strictEqual(info.detectedRemaining, 88);
    assert.ok(info.planNameJa.includes("Free"), info.planNameJa);
    assert.ok(info.observedAt, "観測時刻が記録されるはず");
    assert.ok(info.noteJa.includes("自動判定しました"), info.noteJa);
  });

  await test("Proプラン(上限7500)のヘッダーから Pro($19/月) と判定する", () => {
    recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": "7500", "x-ratelimit-requests-remaining": "7412" }));
    const info = getApiPlanInfo();
    assert.strictEqual(info.detectedDailyLimit, 7500);
    assert.strictEqual(info.detectedRemaining, 7412);
    assert.ok(info.planNameJa.includes("Pro"), info.planNameJa);
  });

  await test("Ultra(75000)/Mega(150000)/Custom も公開価格表どおりに判定する", () => {
    for (const [limit, expected] of [["75000", "Ultra"], ["150000", "Mega"], ["500000", "Custom"]]) {
      recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": limit }));
      assert.ok(getApiPlanInfo().planNameJa.includes(expected), `${limit} は ${expected} と判定されるはず, got ${getApiPlanInfo().planNameJa}`);
    }
  });

  await test("ヘッダーが返らない場合(RapidAPI経由等)は、直前の判定結果を壊さない", () => {
    recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": "7500", "x-ratelimit-requests-remaining": "100" }));
    assert.strictEqual(getApiPlanInfo().detectedDailyLimit, 7500);
    recordRateLimitHeaders(fakeRes({})); // ヘッダー無し
    assert.strictEqual(getApiPlanInfo().detectedDailyLimit, 7500, "ヘッダーが取れない呼び出しで判定結果を壊してはいけない");
  });

  await test("不正な値(0・負数・数値でない文字列)は判定結果として採用しない", () => {
    recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": "7500" }));
    for (const bad of ["0", "-5", "abc", ""]) {
      recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": bad }));
      assert.strictEqual(getApiPlanInfo().detectedDailyLimit, 7500, `"${bad}" は不正値として無視されるはず`);
    }
  });

  await test("レスポンスがnull/headersが無い場合でも例外を投げない(本処理を止めない)", () => {
    assert.doesNotThrow(() => recordRateLimitHeaders(null));
    assert.doesNotThrow(() => recordRateLimitHeaders({}));
    assert.doesNotThrow(() => recordRateLimitHeaders({ headers: {} }));
  });

  await test("callApiFootball経由でも実際にヘッダーが記録される(結線の確認)", async () => {
    recordRateLimitHeaders(fakeRes({ "x-ratelimit-requests-limit": "100" })); // いったんFreeに戻す
    assert.strictEqual(getApiPlanInfo().detectedDailyLimit, 100);
    mockHeaders = { "x-ratelimit-requests-limit": "7500", "x-ratelimit-requests-remaining": "7000" };
    // キャッシュに当たらないよう、このテスト専用のリーグIDで呼び出す
    await handleFixturesToday(new URLSearchParams({ leagues: "9911" })).catch(() => {});
    const info = getApiPlanInfo();
    assert.strictEqual(info.detectedDailyLimit, 7500, "実際のAPI呼び出しでヘッダーが読まれているはず");
    assert.ok(info.planNameJa.includes("Pro"), info.planNameJa);
  });

  try { server.close(); } catch (e) { /* noop */ }
  console.log(failures === 0 ? "\nAll api-plan-detection (優先順位⑪) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
