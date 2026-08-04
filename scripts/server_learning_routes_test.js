/**
 * POST /api/learning/run-daily と GET /api/growth-log のエンドポイントレベルの
 * テスト。server.js経由でHTTPリクエストとして叩き、シークレット保護・レスポンス
 * 形状・Upstash未設定時の正直な応答を確認する。
 * Upstashへのfetch呼び出しは、コマンド体系(GET/SET/INCR/RPUSH/LRANGE/LREM/LTRIM)
 * を実装したインメモリモックで代替する(このサンドボックスは実Upstashに到達できない)。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.AUTO_COLLECT_SECRET = "secret123";
process.env.PORT = "0";

const redisStore = new Map();
function handleRedisCommand(cmd) {
  const [op, ...args] = cmd;
  if (op === "GET") return redisStore.has(args[0]) ? redisStore.get(args[0]) : null;
  if (op === "SET") {
    const [key, value, flag] = args;
    if (flag === "NX" && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return "OK";
  }
  if (op === "INCR") {
    const cur = parseInt(redisStore.get(args[0]), 10) || 0;
    redisStore.set(args[0], String(cur + 1));
    return cur + 1;
  }
  if (op === "RPUSH") {
    const [key, val] = args;
    const list = redisStore.get(key) || [];
    list.push(val);
    redisStore.set(key, list);
    return list.length;
  }
  if (op === "LRANGE") {
    const [key, startS, endS] = args;
    const list = redisStore.get(key) || [];
    let start = parseInt(startS, 10), end = parseInt(endS, 10);
    if (start < 0) start = Math.max(0, list.length + start);
    if (end < 0) end = list.length + end;
    return list.slice(start, end + 1);
  }
  if (op === "LREM") {
    const [key, , val] = args;
    const list = redisStore.get(key) || [];
    redisStore.set(key, list.filter((v) => v !== val));
    return 1;
  }
  if (op === "LTRIM") {
    const [key, startS, endS] = args;
    const list = redisStore.get(key) || [];
    let start = parseInt(startS, 10), end = parseInt(endS, 10);
    if (start < 0) start = Math.max(0, list.length + start);
    if (end < 0) end = list.length + end;
    redisStore.set(key, list.slice(start, end + 1));
    return "OK";
  }
  return null;
}

global.fetch = async (urlArg, opts) => {
  const u = new URL(urlArg.toString());
  if (u.hostname === "fake-upstash.example.com") {
    const cmd = JSON.parse(opts.body);
    const result = handleRedisCommand(cmd);
    return { ok: true, json: async () => ({ result }) };
  }
  if (u.pathname === "/teams") {
    return { ok: true, json: async () => ({ errors: [], response: [{ team: { id: 100 + (u.searchParams.get("search") || "").length, name: u.searchParams.get("search") } }] }) };
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("last")) {
    return { ok: true, json: async () => ({ errors: [], response: [] }) }; // 空 -> 事実は生成されない(architecture上、素直な経路)
  }
  if (u.pathname === "/fixtures" && u.searchParams.get("next")) {
    return { ok: true, json: async () => ({ errors: [], response: [] }) }; // 今回は新規予測なしのシンプルな経路
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function req(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); } });
    });
    r.on("error", reject);
    r.end();
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  const noKey = await req(port, "POST", "/api/learning/run-daily");
  ok(noKey.status === 403, "シークレット無しでのrun-daily呼び出しは403で拒否される, got " + noKey.status);

  // 2026年8月・本番調査で発見された不具合(GitHub Actionsのcurlが2分の制限時間で
  // 待ちきれずexit code 28で失敗し続けた件)の修正確認: run-dailyは処理完了を
  // 待たず、即座に「開始しました」と応答するようになった(fire-and-forget)。
  const startedAt = Date.now();
  const withKey = await req(port, "POST", "/api/learning/run-daily?key=secret123");
  const respondedInMs = Date.now() - startedAt;
  ok(withKey.status === 200, "正しいシークレットならrun-dailyが200を返す, got " + withKey.status);
  ok(withKey.json && withKey.json.ok === true, "run-dailyの応答にok:trueが含まれる, got " + JSON.stringify(withKey.json && withKey.json.ok));
  ok(withKey.json.started === true, "即座に started:true を返す(バックグラウンド実行), got " + JSON.stringify(withKey.json));
  ok(respondedInMs < 2000, `応答は処理完了を待たず即座に返るはず(2秒未満). got ${respondedInMs}ms`);

  // バックグラウンドの学習ジョブが実際に完了し、growth-logに反映されるまで待つ
  // (このテストのモックはインメモリで高速に応答するため、通常は数十ms〜数百ms で終わる)。
  async function waitForBackgroundJob(maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const g = await req(port, "GET", "/api/growth-log");
      if (g.json && g.json.ranYet === true) return g;
      await new Promise((r) => setTimeout(r, 50));
    }
    return req(port, "GET", "/api/growth-log");
  }

  const growth = await waitForBackgroundJob(5000);
  ok(growth.status === 200, "growth-logは200を返す");
  ok(growth.json && growth.json.configured === true && growth.json.ranYet === true, "バックグラウンドジョブ完了後はranYet:trueになる, got " + JSON.stringify(growth.json));
  ok(growth.json.date, "日付が含まれる");

  // ?sync=1 を付けた場合は従来通り、処理完了まで待ってから完全な結果を返す
  // (デバッグ用の同期モード)。
  // 2026年8月・多重起動防止ロックの導入により、直前の非同期実行のロックがまだ
  // 残っているため、意図的な再実行であることを示す force=1 を付ける(本番で
  // GitHub Actionsのcurl再送により学習ジョブが多重起動し、API-Footballの
  // 使用量が想定の8倍に膨らんでいた不具合の対策)。
  const syncResult = await req(port, "POST", "/api/learning/run-daily?key=secret123&sync=1&force=1");
  ok(syncResult.status === 200, "sync=1でもrun-dailyが200を返す, got " + syncResult.status);
  ok(syncResult.json && syncResult.json.ok === true, "sync=1の応答にok:trueが含まれる");
  ok(typeof syncResult.json.teamsAnalyzed === "number", "sync=1では従来通りteamsAnalyzedが数値で同期的に返る");

  server.close();
  console.log(failures === 0 ? "\nLearning routes tests PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
