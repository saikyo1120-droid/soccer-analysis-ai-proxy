/**
 * 2026年8月・本番調査で発見された不具合の再現・修正確認テスト。
 *
 * 症状: GitHub Actionsから「Daily Learning Engine」を手動実行しても、
 * 毎回 約7分後に exit code 28(curlのタイムアウト)で失敗し続けた。
 * server.js/learning/dailyJob.js/index.html はすべて正しくGitHubに反映
 * されており、コード自体は最新版だったにもかかわらず再現した。
 *
 * 根本原因: fetch()の呼び出し(API-Football・Upstash・Anthropic LLMの3箇所)
 * に一切タイムアウトが設定されていなかったため、外部API側が応答を返さない
 * 状態(ネットワーク障害・相手サーバーの異常など)に陥ると、そのリクエストは
 * 永遠に待ち続けてしまい、日次学習ジョブ全体がフリーズしていた。
 * resolveTeamIdの「一時的な障害を検知して自動リトライする」ロジック自体は
 * 正しく実装されていても、個々のfetch呼び出しに時間の上限が無ければ
 * 「一時的な障害が発生した」ことを検知すること自体ができない。
 *
 * 修正: fetchWithTimeout()ヘルパーを新設し、AbortControllerで全fetch呼び出し
 * (API-Football・Upstash・Anthropic)に明示的な時間上限を設けた。上限を
 * 超えた場合は err.code = "TIMEOUT" を持つエラーとして確実に失敗するように
 * なり、既存の再試行・エラー収集ロジックが正しく機能するようになる。
 *
 * このテストでは、外部APIが「応答を一切返さない(ハングする)」状況を
 * 疑似的に再現し、(1) 実際に時間内にエラーとして扱われること、
 * (2) resolveTeamIdがフリーズせず「一時的な障害」として扱うこと、
 * (3) Anthropic LLMプロバイダーも同様にタイムアウトすることを確認する。
 * 実際の待ち時間を短くするため、タイムアウト上限は環境変数で短く設定する。
 */
const assert = require("assert");
const path = require("path");

let failures = 0;
async function test(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    console.log(`  [OK] ${name} (${Date.now() - startedAt}ms)`);
  } catch (e) {
    console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`);
    failures++;
  }
}

// 実際のfetch+AbortControllerの挙動を模した「ハングするfetch」モック。
// signalがabortされない限り、永遠にresolve/rejectしない。
function makeHangingFetch() {
  return (urlArg, options) => new Promise((resolve, reject) => {
    const signal = options && options.signal;
    if (signal) {
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    }
    // わざと何も呼ばない = 応答が永遠に返ってこない状態を再現
  });
}

(async () => {
  await test("callApiFootball: 外部APIがハングしても、設定したタイムアウトで確実にエラーになる(無限に待ち続けない)", async () => {
    process.env.API_FOOTBALL_KEY = "test-key-hang";
    process.env.API_FOOTBALL_TIMEOUT_MS = "200"; // テストなので短く設定
    process.env.UPSTASH_TIMEOUT_MS = "200";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-hang.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    process.env.PORT = "0";

    global.fetch = makeHangingFetch();
    delete require.cache[require.resolve(path.join(__dirname, "..", "server", "server.js"))];
    const { learningDeps, server } = require(path.join(__dirname, "..", "server", "server.js"));
    server.close();

    const startedAt = Date.now();
    let caught = null;
    try {
      await learningDeps.callApiFootball("/teams", { search: "Hang FC" });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(caught, "ハングした場合は例外を投げて確実に終わるはず(無限待ちにならない)");
    assert.strictEqual(caught.code, "TIMEOUT", `err.code は "TIMEOUT" のはず。実際: ${caught.code}`);
    // 設定した200msに対して十分な余裕(3秒)を見て、確実にハングしていないことだけを確認する
    assert.ok(elapsed < 3000, `タイムアウトが機能していれば数百ms程度で終わるはず。実際: ${elapsed}ms`);
  });

  await test("resolveTeamId: 外部APIがハングしても全体がフリーズせず、一時的な障害として扱われnullを返す", async () => {
    process.env.API_FOOTBALL_KEY = "test-key-hang2";
    process.env.API_FOOTBALL_TIMEOUT_MS = "150";
    process.env.UPSTASH_TIMEOUT_MS = "150";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash-hang2.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    process.env.PORT = "0";

    global.fetch = makeHangingFetch();
    delete require.cache[require.resolve(path.join(__dirname, "..", "server", "server.js"))];
    const { learningDeps, server } = require(path.join(__dirname, "..", "server", "server.js"));
    server.close();

    const startedAt = Date.now();
    const id = await learningDeps.resolveTeamId("Another Hang FC");
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(id, null, "ハング=一時的な障害として扱われ、nullが返るはず(でっち上げのIDを返してはいけない)");
    // 再試行(2回)分の時間はかかるが、それでも数秒以内に収まるはず(以前は無限に待っていた)
    assert.ok(elapsed < 5000, `再試行を含めても数秒以内に終わるはず。実際: ${elapsed}ms`);
  });

  await test("Anthropic LLMプロバイダー: 応答がハングしても設定したタイムアウトで確実にエラーになる", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.ANTHROPIC_TIMEOUT_MS = "200";

    global.fetch = makeHangingFetch();
    const anthropicPath = path.join(__dirname, "..", "server", "llm", "providers", "anthropic.js");
    delete require.cache[require.resolve(anthropicPath)];
    const anthropic = require(anthropicPath);

    const startedAt = Date.now();
    let caught = null;
    try {
      await anthropic.generate({ systemPrompt: "test", userPrompt: "test", maxTokens: 50 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(caught, "ハングした場合は例外を投げて確実に終わるはず");
    assert.strictEqual(caught.code, "TIMEOUT", `err.code は "TIMEOUT" のはず。実際: ${caught.code}`);
    assert.ok(elapsed < 3000, `タイムアウトが機能していれば数百ms程度で終わるはず。実際: ${elapsed}ms`);
  });

  console.log(failures === 0 ? "\nAll fetch-timeout tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
