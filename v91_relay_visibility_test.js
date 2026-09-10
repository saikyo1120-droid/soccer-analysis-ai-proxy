"use strict";
/** v91: クラブElo中継が「届いたのか、提供元が落ちているのか」を判別できるようにする修正のテスト。
 *  (利用者の指示「クラブElo中継が届いていません。重大な欠陥なので今すぐ直してください」)
 *
 *  本当の欠陥: 中継が失敗した日、サーバー側に痕跡が1つも残らなかった。そのため11日間
 *  「GitHubが動いていないのか、api.clubelo.comが落ちているのか」を実測で切り分けられなかった。
 *
 *  検証すること:
 *   ① 失敗報告(?status=failed)を受け取り、データを壊さずに記録だけする
 *   ② 成功時も記録する(「最後に中継が成功したのはいつか」が残る)
 *   ③ 半端なCSVで拒否したときも記録する(中継は届いた/中身が駄目、の区別)
 *   ④ /api/diag/clubelo が lastRelayAttempt と stateJa を開示する
 *   ⑤ 失敗報告にも鍵が必要(第三者に偽の記録を書かせない)
 *   ⑥ ワークフローが「HTTPコードで判定」「今日/昨日/一昨日」「成否とも報告」になっている */
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

function httpReq(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const CSV_HEADER = "Rank,Club,Country,Level,Elo,From,To";
const bigCsv = [CSV_HEADER].concat(Array.from({ length: 594 }, (_, i) => `${i + 1},Club${i + 1},XX,1,${1500 + (i % 300)},2026-09-10,2026-09-10`)).join("\n");

(async () => {
  const kv = new Map();
  const setCalls = [];
  const mockUpstash = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let cmds = [];
      try { const j = JSON.parse(body); cmds = Array.isArray(j[0]) ? j : [j]; } catch (e) {}
      const results = cmds.map((c) => {
        if (c[0] === "SET") { setCalls.push(c); kv.set(c[1], c[2]); return { result: "OK" }; }
        if (c[0] === "GET") return { result: kv.has(c[1]) ? kv.get(c[1]) : null };
        return { result: null };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url.includes("pipeline") ? JSON.stringify(results) : JSON.stringify(results[0] || { result: null }));
    });
  });
  await new Promise((r) => mockUpstash.listen(8901, "127.0.0.1", r));
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env, PORT: "8902",
      UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8901", UPSTASH_REDIS_REST_TOKEN: "t",
      AUTO_COLLECT_SECRET: "v91secret", API_FOOTBALL_KEY: "", ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relayKey = "learn:clubelo:relay:last";
  const readRelay = () => (kv.has(relayKey) ? JSON.parse(kv.get(relayKey)) : null);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server boot timeout")), 15000);
      const poll = async () => {
        try { const r = await httpReq("GET", "http://127.0.0.1:8902/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
        setTimeout(poll, 300);
      };
      poll();
    });
    const base = "http://127.0.0.1:8902/api/clubelo/ingest";
    const today = new Date().toISOString().slice(0, 10);

    await t("⑤ 失敗報告にも鍵が必要(第三者に偽の記録を書かせない)", async () => {
      const r = await httpReq("POST", `${base}?key=wrong&status=failed&stage=fetch&code=502`);
      assert.strictEqual(r.status, 403, "鍵違いが403でない: " + r.status);
      assert.strictEqual(readRelay(), null, "鍵違いなのに記録された");
    });

    await t("① 失敗報告を受け取り、データは壊さず記録だけする", async () => {
      const r = await httpReq("POST", `${base}?key=v91secret&status=failed&stage=fetch&code=502&detail=no_csv_from_provider`);
      assert.strictEqual(r.status, 200, "失敗報告が200でない: " + r.status + " " + r.body.slice(0, 150));
      const rec = readRelay();
      assert.ok(rec, "中継の記録が残っていない");
      assert.strictEqual(rec.ok, false);
      assert.strictEqual(rec.stage, "fetch");
      assert.strictEqual(rec.httpCode, "502");
      assert.strictEqual(rec.detail, "no_csv_from_provider");
      assert.ok(rec.at && rec.at.length >= 10, "時刻が無い");
      assert.ok(rec.messageJa && rec.messageJa.includes("中継"), "日本語の説明が無い");
      // データ本体(learn:clubelo:daily)には一切書いていない
      assert.strictEqual(kv.has("learn:clubelo:daily"), false, "失敗報告でデータを書いてしまっている");
    });

    await t("③ 半端なCSVでの拒否も記録される(中継は届いた/中身が駄目、の区別)", async () => {
      const r = await httpReq("POST", `${base}?key=v91secret`, CSV_HEADER + "\n1,Only,XX,1,1500,,", { "Content-Type": "text/csv" });
      assert.strictEqual(r.status, 400);
      const rec = readRelay();
      assert.strictEqual(rec.ok, false);
      assert.strictEqual(rec.stage, "validate", "段階がvalidateでない: " + rec.stage);
      assert.strictEqual(rec.rowsSeen, 1);
    });

    await t("② 成功時も記録される(最後に中継が成功した時刻が残る)", async () => {
      const r = await httpReq("POST", `${base}?key=v91secret&date=${today}`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(r.status, 200, "正常系が200でない: " + r.status + " " + r.body.slice(0, 150));
      const rec = readRelay();
      assert.strictEqual(rec.ok, true, "成功が記録されていない");
      assert.strictEqual(rec.stage, "saved");
      assert.strictEqual(rec.dateTried, today);
      assert.strictEqual(rec.rowsSeen, 594);
      // データ本体も正しく保存されている(既存の動作を壊していない)
      const saved = JSON.parse(kv.get("learn:clubelo:daily"));
      assert.strictEqual(saved.source, "gh-relay");
      assert.strictEqual(saved.list.length, 594);
    });

    await t("④ /api/diag/clubelo が lastRelayAttempt と stateJa を開示する", async () => {
      const r = await httpReq("GET", "http://127.0.0.1:8902/api/diag/clubelo?d=v91test");
      assert.strictEqual(r.status, 200);
      const b = JSON.parse(r.body);
      assert.ok(b.lastRelayAttempt, "lastRelayAttempt が無い");
      assert.strictEqual(b.lastRelayAttempt.ok, true, "最新の試行(成功)が反映されていない");
      assert.ok(typeof b.stateJa === "string" && b.stateJa.length > 10, "stateJa が無い");
      assert.ok(b.stateJa.includes("中継"), "stateJaに中継の状態が入っていない: " + b.stateJa);
      assert.ok(b.stateJa.includes("保存されている最新データ"), "stateJaに保存状態が入っていない: " + b.stateJa);
      assert.ok(b.savedDaily && b.savedDaily.source === "gh-relay", "savedDailyの来歴が出ていない");
    });
  } finally {
    srv.kill("SIGKILL");
    await new Promise((r) => mockUpstash.close(r));
  }

  await t("⑥ ワークフローがHTTPコード判定・複数日・成否とも報告になっている", async () => {
    const cands = [path.join(__dirname, "..", ".github", "workflows", "clubelo-relay.yml"),
      path.join(__dirname, ".github", "workflows", "clubelo-relay.yml")];
    const p = cands.find((c) => fs.existsSync(c));
    assert.ok(p, "clubelo-relay.yml が見つからない");
    const y = fs.readFileSync(p, "utf8");
    // ② 終了コードではなくHTTPコードで判定する(-sS単体では502でもexit 0になる)
    assert.ok(y.includes('-w "%{http_code}"'), "HTTPコードを明示的に見ていない");
    assert.ok(y.includes('[ "${CODE}" = "200" ]'), "HTTP 200の確認が無い");
    // ③ 今日・昨日・一昨日
    assert.ok(y.includes("for BACK in 0 1 2"), "複数日の試行が無い");
    assert.ok(y.includes('date -u -d "-${BACK} day" +%F'), "日付の逆算が無い");
    // ① 成否どちらも報告
    assert.ok(y.includes("report_failure ()"), "失敗報告の関数が無い");
    assert.ok(y.includes("status=failed"), "失敗報告のパラメータが無い");
    assert.ok(y.includes('report_failure "fetch"') && y.includes('report_failure "post"'),
      "取得失敗・中継失敗の両方を報告していない");
    // 手動実行できる(今すぐ検証するため)
    assert.ok(y.includes("workflow_dispatch"), "手動実行の口が無い");
    // 接続タイムアウトを分けて指定
    assert.ok(y.includes("--connect-timeout"), "接続タイムアウトの指定が無い");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
