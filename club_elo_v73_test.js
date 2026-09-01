/**
 * scripts/club_elo_v73_test.js — v73「クラブElo接続強化(依存ゼロ)」の検証。
 *
 * ■ 経緯の正直な記録
 *   2026年9月1日、開発環境の再起動でそれまでの回帰テスト群(サーバー側130ファイル)が
 *   失われた(本番・GitHubのコードは無傷)。このファイルはその後に書かれた
 *   v73専用の自己完結テストで、外部のテスト基盤に依存しない。
 *   今後はテストもGitHubリポジトリ(scripts/)に保存して、同じ消失を二度と起こさない。
 *
 * ■ v73が守る約束
 *   ① 自前トランスポート(Node標準https/http)が動き、生のエラーコード+所要msが残る
 *   ② リトライは日次一覧(1日1リクエスト)だけ。既定は3ラウンド・最悪約2.5分で諦める
 *   ③ クラブ別の履歴取得はリトライしない(v69遮断器=3クラブ連続失敗で中断、を維持)
 *   ④ 診断プローブが試行ごとの実測を返す(保存はしない)
 *   ⑤ /api/diag/clubelo が10分キャッシュ付きで動く
 */
const path = require("path");
const http = require("http");
const clubElo = require(path.join(__dirname, "..", "server", "learning", "clubElo"));

let passed = 0, failed = 0;
const ck = (n, ok, d) => { if (ok) { console.log("  ✅ " + n); passed++; } else { console.log("  ❌ " + n + (d ? "\n     " + d : "")); failed++; } };

(async () => {
  console.log("\n=== v73 クラブElo接続強化(依存ゼロ) ===\n");

  /* ---------- ① 自前トランスポート(実ソケットでの実測) ---------- */
  {
    // ローカルにテスト用HTTPサーバーを立てて、本物のソケット経由で検証する
    const srv = http.createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: "/final" }); res.end(); return; }
      if (req.url === "/slow") { /* 応答しない(タイムアウト検証用) */ return; }
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end("Rank,Club,Country,Level,Elo,From,To\n1,TestFC,JP,1,1500,2026-08-01,2026-09-01");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const okRes = await clubElo.httpGetRaw(`http://127.0.0.1:${port}/final`, { timeoutMs: 3000 });
    ck("① 通常取得: ok/status/本文/所要msが返る",
      okRes.ok === true && okRes.status === 200 && Number.isFinite(okRes.elapsedMs) && /TestFC/.test(await okRes.text()),
      JSON.stringify({ status: okRes.status, ms: okRes.elapsedMs }));

    const redir = await clubElo.httpGetRaw(`http://127.0.0.1:${port}/redirect`, { timeoutMs: 3000 });
    ck("① 302転送を追いかける(clubeloのhttp→https転送に相当)",
      redir.ok === true && /TestFC/.test(await redir.text()), JSON.stringify({ status: redir.status }));

    const t0 = Date.now();
    let slowErr = null;
    try { await clubElo.httpGetRaw(`http://127.0.0.1:${port}/slow`, { timeoutMs: 1200 }); } catch (e) { slowErr = e; }
    const slowMs = Date.now() - t0;
    ck("① 無応答は指定時間で必ず打ち切り、TIMEOUTコードが残る",
      slowErr && /^TIMEOUT_1200MS$/.test(slowErr.code) && slowMs >= 1100 && slowMs < 3000,
      JSON.stringify({ code: slowErr && slowErr.code, ms: slowMs }));

    srv.close();

    // 閉じたポート → 生のECONNREFUSEDがそのまま取れる(undiciの「fetch failed」包みが無い)
    let refErr = null;
    const t1 = Date.now();
    try { await clubElo.httpGetRaw(`http://127.0.0.1:${port}/`, { timeoutMs: 3000 }); } catch (e) { refErr = e; }
    ck("① 接続拒否は生のコードが直接残る(環境によりECONNREFUSED/ECONNRESET)",
      refErr && /ECONNREFUSED|ECONNRESET/.test(refErr.code) && (Date.now() - t1) < 1500,
      JSON.stringify({ code: refErr && refErr.code }));
  }

  /* ---------- ② リトライ(日次一覧のみ・試行ログ付き) ---------- */
  {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls <= 2) { const e = new Error("boom"); e.code = "ETIMEDOUT"; e.elapsedMs = 5; throw e; }
      return { ok: true, status: 200, elapsedMs: 7, text: async () => "Rank,Club,Country,Level,Elo,From,To\n1,A FC,JP,1,1500,2026-08-01," };
    };
    const res = await clubElo.fetchWithScheme(flaky, "2026-09-01", { rounds: 3, timeoutsMs: [100], backoffMs: [0, 0] });
    ck("② 1ラウンド目全滅→2ラウンド目で回復できる(呼び出し3回)",
      res.ok === true && calls === 3, `calls=${calls}`);
    ck("② 試行ごとの{ラウンド,方式,コード,ms}が全部残る",
      Array.isArray(res.__attempts) && res.__attempts.length === 3
        && res.__attempts[0].code === "ETIMEDOUT" && res.__attempts[2].code === "OK",
      JSON.stringify(res.__attempts));

    // 全ラウンド失敗: 旧形式の先頭+全試行の要約がエラー文に入る
    let allFail = null; let calls2 = 0;
    const dead = async () => { calls2++; const e = new Error("x"); e.code = "ECONNREFUSED"; e.elapsedMs = 3; throw e; };
    try { await clubElo.fetchWithScheme(dead, "2026-09-01", { rounds: 2, timeoutsMs: [100], backoffMs: [0] }); } catch (e) { allFail = e; }
    ck("② 全滅時: 呼び出しは ラウンド×2方式(=4回)で止まる", calls2 === 4, `calls=${calls2}`);
    ck("② 全滅時: 旧形式(https:コード/http:コード)互換+全試行の要約が残る",
      allFail && /^https:ECONNREFUSED\/http:ECONNREFUSED \| r1 /.test(allFail.message) && allFail.attempts.length === 4,
      allFail && allFail.message);

    // 既定(retryOpts無し)は従来どおり1ラウンド=2回で止まる(クラブ別履歴の経路)
    let calls3 = 0; let single = null;
    const dead3 = async () => { calls3++; const e = new Error("x"); e.code = "ETIMEDOUT"; throw e; };
    try { await clubElo.fetchWithScheme(dead3, "SomeClub"); } catch (e) { single = e; }
    ck("② 既定は1ラウンド(2回)のまま=クラブ別経路の挙動は不変", calls3 === 2 && single && /^https:ETIMEDOUT\/http:ETIMEDOUT$/.test(single.message),
      JSON.stringify({ calls3, msg: single && single.message }));
  }

  /* ---------- ②b getDailyElo がリトライ計画を使う+attemptsを開示する ---------- */
  {
    const store = new Map();
    const deps = {
      upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null),
      upstashSetJSON: async (k, v) => { store.set(k, v); return true; },
      dailyRetryPlan: { rounds: 3, timeoutsMs: [100], backoffMs: [0, 0] },
    };
    let calls = 0;
    deps.fetchFn = async () => {
      calls++;
      if (calls <= 3) { const e = new Error("boom"); e.code = "ETIMEDOUT"; e.elapsedMs = 4; throw e; }
      return { ok: true, status: 200, elapsedMs: 6, text: async () => "Rank,Club,Country,Level,Elo,From,To\n1,B FC,DE,1,1600,2026-08-01," };
    };
    const d = await clubElo.getDailyElo(deps, Date.parse("2026-09-01T05:00:00Z"));
    ck("②b 日次取得はリトライで粘って成功する(4回目で回復)",
      d.rows.length === 1 && d.fetchedFresh === true && calls === 4, JSON.stringify({ calls, rows: d.rows.length }));
    ck("②b 成功時も試行ログが返る(何回目で取れたかが分かる)",
      Array.isArray(d.attempts) && d.attempts.length === 4 && d.attempts[3].code === "OK", JSON.stringify(d.attempts && d.attempts.length));

    // 全滅日: error に試行の要約が入り、attemptsも返る
    const deps2 = { ...deps, fetchFn: async () => { const e = new Error("x"); e.code = "UND_ERR_CONNECT_TIMEOUT"; throw e; }, dailyRetryPlan: { rounds: 2, timeoutsMs: [100], backoffMs: [0] } };
    const d2 = await clubElo.getDailyElo(deps2, Date.parse("2026-09-02T05:00:00Z"));
    ck("②b 全滅日はエラーに全試行の要約が残る(次回から正体が特定できる)",
      d2.rows.length === 1 && d2.staleDays === 1 && /r2 http:UND_ERR_CONNECT_TIMEOUT/.test(d2.error || "") && d2.attempts.length === 4,
      JSON.stringify({ error: d2.error, stale: d2.staleDays }));
  }

  /* ---------- ③ v69遮断器の維持(クラブ別はリトライしない) ---------- */
  {
    const store = new Map();
    store.set("learn:clubelo:daily", { date: "2026-09-01", list: [["Arsenal", "ENG", 1900], ["Chelsea", "ENG", 1850], ["Liverpool", "ENG", 1880], ["Real Madrid", "ESP", 1950]] });
    const lists = new Map();
    let fetchCalls = 0;
    const deps = {
      fetchFn: async () => { fetchCalls++; const e = new Error("boom"); e.code = "ETIMEDOUT"; e.elapsedMs = 2; throw e; },
      upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null),
      upstashSetJSON: async (k, v) => { store.set(k, v); return true; },
      upstashCmd: async (cmd) => {
        const [op, key, ...rest] = cmd;
        if (op === "SET") { if (String(rest[1]).toUpperCase() === "NX" && lists.has(key)) return null; lists.set(key, rest[0]); return "OK"; }
        if (op === "DEL") { lists.delete(key); return 1; }
        return null;
      },
    };
    const teams = [
      { id: 1, name: "Arsenal" }, { id: 2, name: "Chelsea" }, { id: 3, name: "Liverpool" }, { id: 4, name: "Real Madrid" },
    ];
    const r = await clubElo.backfillHistory(deps, teams, 0, Date.parse("2026-09-01T05:00:00Z"));
    ck("③ 接続失敗3クラブ連続で中断(4クラブ目へ突撃しない)= 呼び出しは3クラブ×2方式=6回",
      r.abortedForHostDown === true && fetchCalls === 6, JSON.stringify({ fetchCalls, reason: r.reasonJa }));
    ck("③ 空の履歴を保存しない+ロックを返す(回復後に自動で再試行できる)",
      r.saved === false && !store.has("learn:clubelo:hist") && !lists.has("learn:clubelo:hist:lock"),
      JSON.stringify({ saved: r.saved }));
  }

  /* ---------- ④ 診断プローブ ---------- */
  {
    const probe = await clubElo.probeDaily({
      fetchFn: async () => { const e = new Error("x"); e.code = "EHOSTUNREACH"; e.elapsedMs = 11; throw e; },
      nowMs: Date.parse("2026-09-01T05:00:00Z"),
      timeoutMs: 500,
    });
    ck("④ プローブ: 失敗時も試行ごとのコード+msを返す(推測で埋めない)",
      probe.ok === false && probe.attempts.length === 2 && probe.attempts.every((a) => a.code === "EHOSTUNREACH" && Number.isFinite(a.ms)),
      JSON.stringify(probe.attempts));
    const probe2 = await clubElo.probeDaily({
      fetchFn: async () => ({ ok: true, status: 200, elapsedMs: 9, text: async () => "Rank,Club,Country,Level,Elo,From,To\n1,C FC,FR,1,1700,2026-08-01," }),
      nowMs: Date.parse("2026-09-01T05:00:00Z"),
    });
    ck("④ プローブ: 成功時は行数とサンプルが返る", probe2.ok === true && probe2.rowCount === 1 && probe2.sample[0] === "C FC",
      JSON.stringify(probe2));
  }

  /* ---------- ⑤ /api/diag/clubelo(サーバー実起動) ---------- */
  {
    process.env.PORT = "0";
    process.env.API_FOOTBALL_KEY = "k";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "t";
    process.env.RATE_LIMIT_PER_MINUTE = "100000";
    process.env.SELF_HEAL_DAILY_LEARNING = "0";
    process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000";
    const realFetch = global.fetch;
    global.fetch = async (u, o) => {
      const url = new URL(String(u));
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(u, o);
      if (url.hostname === "upstash.test") {
        const body = JSON.parse(o.body);
        if (url.pathname.endsWith("/pipeline")) return { ok: true, json: async () => body.map(() => ({ result: null })) };
        return { ok: true, json: async () => ({ result: null }) };
      }
      const e = new Error("blocked in test"); e.name = "AbortError"; throw e;
    };
    const { server } = require(path.join(__dirname, "..", "server", "server.js"));
    await new Promise((r) => server.on("listening", r));
    const port = server.address().port;
    const get = (p) => new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: p }, (res) => {
        let b = ""; res.on("data", (d) => b += d);
        res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
      }).on("error", (e) => resolve({ status: 0, json: null, err: String(e) }));
    });
    // この環境からclubeloへの実接続は失敗してよい(コードは環境依存)。形だけを検証する。
    const a = await get("/api/diag/clubelo");
    ck("⑤ 200で返り、probe.attempts(方式・コード・ms)が入る",
      a.status === 200 && a.json && a.json.probe && Array.isArray(a.json.probe.attempts) && a.json.probe.attempts.length >= 1
        && a.json.probe.attempts.every((x) => x.scheme && x.code && Number.isFinite(x.ms)),
      JSON.stringify(a.json && a.json.probe && a.json.probe.attempts));
    const b = await get("/api/diag/clubelo");
    ck("⑤ 2回目はキャッシュから返す(10分間は実接続しない)",
      b.status === 200 && b.json && b.json.cached === true && b.json.generatedAt === a.json.generatedAt,
      JSON.stringify({ cached: b.json && b.json.cached }));
    server.close();
  }

  console.log(`\n=== 結果: ${passed}件成功 / ${failed}件失敗 ===`);
  process.exit(failed ? 1 : 0);
})();
