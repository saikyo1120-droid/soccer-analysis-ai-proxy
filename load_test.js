/**
 * scripts/load_test.js
 * ------------------------------------------------
 * 2026年8月・最終方針「必ず提出するもの」対応: 負荷テスト。
 * 実サーバー(server.js)をそのまま起動し、同時多接続で叩いて
 *   RPS / p50 / p95 / p99 / エラー率 / CPU / メモリ / キャッシュヒット率
 * を実測する。外部API・LLM・Upstashは呼ばない構成(未設定のまま起動)で、
 * 「サーバー自身の処理能力」を測る。
 *
 * 対象は「利用者が実際に叩く軽量経路」:
 *   GET  /            (静的index.html配信 — 最頻)
 *   GET  /api/health
 *   POST /api/predict-match (純計算 — CPU負荷の代表)
 *   GET  /api/growth-log    (Upstash未設定時の正直な応答経路)
 *
 * 判定基準(この環境のローカル実測。Render無料プランは別途注記):
 *   ・エラー0件
 *   ・p95 < 300ms
 *   ・全体スループット > 100 RPS
 */

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 8931;
const CONCURRENCY = 50;
const TOTAL_REQUESTS = 2000;

const PREDICT_BODY = JSON.stringify({
  homeLabel: "テストA", awayLabel: "テストB",
  homePlayers: Array.from({ length: 11 }, (_, i) => ({ key: `h${i}`, nameJa: `H${i}`, name: `H${i}`, emoji: "⚽", overall: 80 + (i % 10), position: i === 0 ? "GK" : i < 5 ? "CB" : i < 9 ? "CM" : "ST", attrs: { attack: 80, shooting: 78, dribbling: 82, passing: 81, tactical: 79, speed: 83, physical: 77, defense: 60 } })),
  awayPlayers: Array.from({ length: 11 }, (_, i) => ({ key: `a${i}`, nameJa: `A${i}`, name: `A${i}`, emoji: "⚽", overall: 78 + (i % 10), position: i === 0 ? "GK" : i < 5 ? "CB" : i < 9 ? "CM" : "ST", attrs: { attack: 78, shooting: 76, dribbling: 80, passing: 79, tactical: 77, speed: 81, physical: 75, defense: 58 } })),
});

const TARGETS = [
  { name: "GET /", weight: 4, run: () => reqOnce("GET", "/") },
  { name: "GET /api/health", weight: 2, run: () => reqOnce("GET", "/api/health") },
  { name: "POST /api/predict-match", weight: 3, run: () => reqOnce("POST", "/api/predict-match", PREDICT_BODY) },
  { name: "GET /api/growth-log", weight: 1, run: () => reqOnce("GET", "/api/growth-log") },
];
const WEIGHTED = TARGETS.flatMap((t) => Array.from({ length: t.weight }, () => t));

function reqOnce(method, urlPath, body) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ms: Date.now() - t0, status: res.statusCode }));
    });
    req.on("error", () => resolve({ ms: Date.now() - t0, status: 0 }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ms: Date.now() - t0, status: 0 }); });
    if (body) req.write(body);
    req.end();
  });
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function waitForServer(tries) {
  for (let i = 0; i < tries; i++) {
    const r = await reqOnce("GET", "/api/health");
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

(async () => {
  console.log("負荷テスト: サーバーを起動しています(外部API/LLM/Upstashは未接続=サーバー自身の処理能力の測定)…");
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.js")], {
    env: { ...process.env, PORT: String(PORT), API_FOOTBALL_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", ANTHROPIC_API_KEY: "", RATE_LIMIT_PER_MINUTE: "1000000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  srv.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

  if (!(await waitForServer(40))) {
    console.error("サーバーが起動しませんでした。stderr末尾:", stderrTail);
    srv.kill();
    process.exit(1);
  }

  // ---- ウォームアップ(JITとキャッシュを安定させる) ----
  for (let i = 0; i < 30; i++) await WEIGHTED[i % WEIGHTED.length].run();

  // ---- 本計測 ----
  const results = { all: [], byName: new Map() };
  let errors = 0;
  let sent = 0;
  const t0 = Date.now();
  async function worker() {
    while (sent < TOTAL_REQUESTS) {
      const idx = sent++;
      const target = WEIGHTED[idx % WEIGHTED.length];
      const r = await target.run();
      if (r.status !== 200) errors++;
      results.all.push(r.ms);
      if (!results.byName.has(target.name)) results.byName.set(target.name, []);
      results.byName.get(target.name).push(r.ms);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedMs = Date.now() - t0;
  const rps = Math.round((TOTAL_REQUESTS / elapsedMs) * 1000);

  // ---- サーバー側の実測(perfSnapshot相当)をdebug-statusから取得 ----
  let serverPerf = null;
  try {
    const raw = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/api/debug-status" }, (res) => {
        let buf = ""; res.on("data", (d) => (buf += d)); res.on("end", () => resolve(buf));
      }).on("error", () => resolve(null));
    });
    serverPerf = raw ? (JSON.parse(raw).perf || null) : null;
  } catch (e) { /* 計測の副次情報なので失敗しても本結果は出す */ }

  srv.kill();

  console.log("\n===== 負荷テスト結果(この開発環境でのローカル実測) =====");
  console.log(`総リクエスト: ${TOTAL_REQUESTS}件 / 同時接続: ${CONCURRENCY} / 所要: ${(elapsedMs / 1000).toFixed(1)}秒`);
  console.log(`スループット: ${rps} RPS`);
  console.log(`エラー: ${errors}件`);
  console.log(`応答時間: p50=${pct(results.all, 50)}ms / p95=${pct(results.all, 95)}ms / p99=${pct(results.all, 99)}ms`);
  for (const [name, arr] of results.byName) {
    console.log(`  ${name}: ${arr.length}件 p50=${pct(arr, 50)}ms p95=${pct(arr, 95)}ms`);
  }
  if (serverPerf) {
    console.log(`サーバー側実測: メモリRSS=${serverPerf.memory.rssMb}MB / heap=${serverPerf.memory.heapUsedMb}MB / CPU user=${serverPerf.cpu.userMs}ms sys=${serverPerf.cpu.systemMs}ms`);
    console.log(`キャッシュ: ヒット率=${serverPerf.cache.hitRatePct}% (hit=${serverPerf.cache.hits} / miss=${serverPerf.cache.misses})`);
  }
  console.log("※ 本番(Render無料プラン: 0.1CPU/512MB・スリープあり)はこの実測より遅くなります。目安として、CPU性能比でおよそ1/5〜1/10のスループットを見込んでください。");

  const p95 = pct(results.all, 95);
  const okAll = errors === 0 && p95 !== null && p95 < 300 && rps > 100;
  console.log(okAll ? "\n判定: 合格(エラー0・p95<300ms・>100RPS)" : `\n判定: 不合格(エラー${errors}件 / p95=${p95}ms / ${rps}RPS)`);
  process.exit(okAll ? 0 : 1);
})();
