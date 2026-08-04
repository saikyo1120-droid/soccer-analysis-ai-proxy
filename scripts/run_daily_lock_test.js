/**
 * 2026年8月・本番調査で発見した「学習ジョブの多重起動」の修正テスト。
 *
 * 本番の /api/learning/health で growthLog に「本日13回実行」と記録され、
 * API-Footballの使用量が想定(80〜100)の8倍(801)に膨らんでいた。
 * 原因は GitHub Actions 側の curl --retry とフォールバック再呼び出しにより
 * 1回のワークフローで最大4回このエンドポイントが叩かれること、そして
 * Renderのコールドスタート待ちでそれが起こりやすいこと。
 * プロセス内フラグではデプロイ・スリープ復帰をまたげないため、
 * Upstash上の期限つきロックで多重起動を防ぐ。
 */
const assert = require("assert");
const path = require("path");
const http = require("http");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

process.env.API_FOOTBALL_KEY = "test-key";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.PORT = "0";
delete process.env.AUTO_COLLECT_SECRET;

// SET ... NX EX を正しく再現するモック(NXは既存キーがあれば書き込まない)
const redisStore = new Map();
let setNxCalls = [];
function handleRedisCommand(cmd) {
  const [op, ...args] = cmd;
  if (op === "GET") return redisStore.has(args[0]) ? redisStore.get(args[0]) : null;
  if (op === "SET") {
    const [k, v, ...flags] = args;
    if (flags.includes("NX")) {
      setNxCalls.push(k);
      if (redisStore.has(k)) return null; // 既に存在 → 書き込まない
      redisStore.set(k, v);
      return "OK";
    }
    redisStore.set(k, v);
    return "OK";
  }
  if (op === "DEL") { const had = redisStore.delete(args[0]); return had ? 1 : 0; }
  if (op === "INCR") { const c = parseInt(redisStore.get(args[0]), 10) || 0; redisStore.set(args[0], String(c + 1)); return c + 1; }
  if (op === "RPUSH") { const [k, v] = args; const l = redisStore.get(k) || []; l.push(v); redisStore.set(k, l); return l.length; }
  if (op === "LRANGE") { const [k, s, e] = args; const l = redisStore.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; return l.slice(st, en + 1); }
  if (op === "LREM") { const [k, , v] = args; redisStore.set(k, (redisStore.get(k) || []).filter((x) => x !== v)); return 1; }
  if (op === "LTRIM") { const [k, s, e] = args; const l = redisStore.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; redisStore.set(k, l.slice(st, en + 1)); return "OK"; }
  return null;
}

let apiCallCount = 0;
const realFetch = global.fetch;
global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return realFetch(urlArg, opts);
  if (u.hostname === "fake-upstash.example.com") {
    return { ok: true, json: async () => ({ result: handleRedisCommand(JSON.parse(opts.body)) }) };
  }
  apiCallCount++;
  return { ok: true, headers: { get: () => null }, json: async () => ({ errors: [], response: [] }) };
};

const srv = require(path.join(__dirname, "..", "server", "server.js"));
const { server, tryAcquireDailyRunLock } = srv;

function apiReq(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;

  await test("1回目のロック取得は成功する", async () => {
    redisStore.clear();
    const r = await tryAcquireDailyRunLock();
    assert.strictEqual(r.acquired, true);
    assert.strictEqual(r.skipped, false);
  });

  await test("2回目以降のロック取得は失敗する(多重起動を防ぐ)", async () => {
    const r = await tryAcquireDailyRunLock();
    assert.strictEqual(r.acquired, false, "既にロックが取られているので取得できないはず");
  });

  await test("ロックが期限切れ(削除)されれば再び取得できる", async () => {
    redisStore.clear();
    const r = await tryAcquireDailyRunLock();
    assert.strictEqual(r.acquired, true);
  });

  await test("SET には必ず NX と EX(期限)が付く(途中で落ちても永久ロックにならない)", async () => {
    redisStore.clear();
    let captured = null;
    const origFetch = global.fetch;
    global.fetch = async (urlArg, opts) => {
      const u = new URL(urlArg.toString());
      if (u.hostname === "fake-upstash.example.com") {
        const cmd = JSON.parse(opts.body);
        if (cmd[0] === "SET" && String(cmd[1]).includes("runlock")) captured = cmd;
        return { ok: true, json: async () => ({ result: handleRedisCommand(cmd) }) };
      }
      return origFetch(urlArg, opts);
    };
    await tryAcquireDailyRunLock();
    global.fetch = origFetch;
    assert.ok(captured, "runlockのSETが発行されるはず");
    assert.ok(captured.includes("NX"), "NXが付くはず: " + JSON.stringify(captured));
    assert.ok(captured.includes("EX"), "EX(期限)が付くはず: " + JSON.stringify(captured));
    const exIdx = captured.indexOf("EX");
    assert.ok(Number(captured[exIdx + 1]) > 0, "期限秒数が正の数のはず: " + captured[exIdx + 1]);
  });

  await test("実際のエンドポイント: 1回目は開始し、2回目以降はスキップされる(curlの再送対策)", async () => {
    redisStore.clear();
    const first = await apiReq(port, "POST", "/api/learning/run-daily");
    assert.strictEqual(first.json.ok, true);
    assert.notStrictEqual(first.json.started, false, "1回目は開始されるはず: " + JSON.stringify(first.json));

    // GitHub Actionsのcurl --retry 2 + フォールバック = 最大4回叩かれる状況を再現
    const retries = [];
    for (let i = 0; i < 3; i++) retries.push(await apiReq(port, "POST", "/api/learning/run-daily"));
    for (const r of retries) {
      assert.strictEqual(r.json.started, false, "再送はすべてスキップされるはず: " + JSON.stringify(r.json));
      assert.strictEqual(r.json.reason, "RUN_LOCK_HELD");
      assert.ok(r.json.message.includes("二重起動"), r.json.message);
      assert.ok(r.json.message.includes("force=1"), "意図的に再実行する方法も案内するはず");
    }
  });

  await test("?force=1 を付ければ、ロックを無視して意図的に再実行できる(デバッグ用の逃げ道)", async () => {
    const r = await apiReq(port, "POST", "/api/learning/run-daily?force=1");
    assert.notStrictEqual(r.json.started, false, "force=1ならスキップされないはず: " + JSON.stringify(r.json));
  });

  await test("ロックの日付キーは日ごとに分かれる(翌日は必ず実行できる)", async () => {
    redisStore.clear();
    setNxCalls = [];
    await tryAcquireDailyRunLock();
    // 2026年8月・第7次監査での修正に追随:
    //   日付キーはUTCではなく「利用者のいる地域(既定=日本時間)の日付」になった。
    //   UTC基準のままだと、日本時間の朝4時に走る日次ジョブが前日の記録として
    //   保存され、健康診断が一日中「実行記録がありません」と誤報していたため。
    const OFFSET_H = Number(process.env.APP_TIMEZONE_OFFSET_HOURS ?? 9);
    const today = new Date(Date.now() + OFFSET_H * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.ok(setNxCalls.some((k) => k === `learn:runlock:${today}`), "日付入りのキーを使うはず: " + JSON.stringify(setNxCalls));
  });

  await test("Upstashが落ちていても学習は止めない(可用性優先で実行を許可し、その旨を残す)", async () => {
    const origFetch = global.fetch;
    global.fetch = async (urlArg, opts) => {
      const u = new URL(urlArg.toString());
      if (u.hostname === "fake-upstash.example.com") throw new Error("upstash down");
      return origFetch(urlArg, opts);
    };
    const r = await tryAcquireDailyRunLock();
    global.fetch = origFetch;
    assert.strictEqual(r.acquired, true, "ロックの可否が分からない場合は実行を許可するはず");
    assert.strictEqual(r.skipped, true);
    assert.ok(r.reasonJa, "なぜ保護できなかったかを残すはず");
  });

  try { server.close(); } catch (e) { /* noop */ }
  console.log(failures === 0 ? "\nAll run-daily-lock tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
