"use strict";
/**
 * v104.1(2026年11月14日): GitHub Actions の「毎日届く失敗メール」の原因2件の修正テスト
 * ----------------------------------------------------------------------------
 * 本番実測(11/14):
 *   ① Daily Learning Engine: 学習は 27分 で14段階すべて完走していたのに、ワークフローは
 *      「22分待っても更新されない」と毎日失敗(偽の失敗)。待ち時間が学習より短く、さらに
 *      完了の判定の基準時刻が「待機ステップの開始」だった(判定に使う ranAt は学習の開始時刻)。
 *   ② ClubElo Relay: 提供元(api.clubelo.com)が 8/31 から停止しており、1日3回の実行が毎回失敗。
 *
 * このテストは、ワークフローの YAML から実際のシェルスクリプトを取り出し、
 * 手元の偽サーバー(本番の応答の形を模したもの)に向けて**本当に実行**して結果を確かめる。
 *   ・sleep は一瞬で終わる偽物に差し替える(60分ぶんの待機を数秒で回す)
 *   ・api.clubelo.com への通信は偽の curl に差し替える(外部へは一切出ない)
 * jq・bash・curl が無い環境ではシミュレーションを飛ばし、YAML の内容確認だけ行う。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

let pass = 0, fail = 0, skipped = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const WF_DIR = path.join(__dirname, ".github", "workflows");
const dailyYml = fs.readFileSync(path.join(WF_DIR, "daily-learning.yml"), "utf8");
const eloYml = fs.readFileSync(path.join(WF_DIR, "clubelo-relay.yml"), "utf8");

/** YAML から「- name: <前方一致>」のステップの run: | ブロックを取り出す(字下げを外す) */
function extractRun(yml, namePrefix) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("- name: " + namePrefix));
  assert.ok(start >= 0, "ステップが見つからない: " + namePrefix);
  let i = start + 1;
  while (i < lines.length && !/^\s*run:\s*\|\s*$/.test(lines[i])) {
    assert.ok(!lines[i].trim().startsWith("- name: "), "run: が見つからない: " + namePrefix);
    i++;
  }
  const indent = lines[i].match(/^\s*/)[0].length;
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "") { body.push(""); continue; }
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= indent) break;
    body.push(l);
  }
  const minInd = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return body.map((l) => l.slice(minInd)).join("\n");
}

const have = (bin) => spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
const CAN_SIMULATE = have("jq") && have("curl") && have("bash") && spawnSync("date", ["-d", "2026-11-14T00:19:17.616Z", "+%s"], { encoding: "utf8" }).status === 0;

/** 偽の本番サーバー */
function startFake(handlers) {
  const log = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const u = new URL(req.url, "http://127.0.0.1");
        log.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), bodyBytes: raw.length });
        const h = handlers[u.pathname];
        const out = typeof h === "function" ? h(req, u, raw, log) : h;
        const status = (out && out.__status) || (out ? 200 : 404);
        if (out && out.__status) delete out.__status;
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out || { ok: false }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, log, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

/** スクリプトを実行する(sleep は偽物・必要なら curl も偽物)。非同期(偽サーバーが同じプロセスにいるため) */
function runScript(script, env, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  if (opts && opts.fakeElo) {
    const realCurl = spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(bin, "curl"), [
      "#!/bin/bash",
      "# テスト用: api.clubelo.com への通信だけ偽装し、それ以外は本物の curl に渡す",
      'ELO=""; for a in "$@"; do case "$a" in *api.clubelo.com*) ELO=1;; esac; done',
      `if [ -z "$ELO" ]; then exec ${realCurl} "$@"; fi`,
      'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
      'if [ "$FAKE_ELO" = "up" ]; then for i in $(seq 1 150); do echo "$i,Club$i,ENG,1,1800.5,2026-11-01,2026-11-14"; done > "$out"; printf "200"; exit 0; fi',
      'if [ "$FAKE_ELO" = "http502" ]; then echo "<html>502 Bad Gateway</html>" > "$out"; printf "502"; exit 0; fi',
      ': > "$out"; echo "curl: (28) Connection timed out" >&2; printf "000"; exit 28',
      "",
    ].join("\n"), { mode: 0o755 });
  }
  const outFile = path.join(dir, "github_output");
  const sumFile = path.join(dir, "step_summary");
  fs.writeFileSync(outFile, ""); fs.writeFileSync(sumFile, "");
  const file = path.join(dir, "step.sh");
  fs.writeFileSync(file, script);
  return new Promise((resolve) => {
    const child = spawn("bash", ["-e", file], {
      cwd: dir,
      env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { /* 終了済み */ } }, 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const outputs = {};
      for (const l of fs.readFileSync(outFile, "utf8").split("\n")) { const m = l.match(/^([A-Za-z_]+)=(.*)$/); if (m) outputs[m[1]] = m[2]; }
      resolve({ status: code, stdout, stderr, outputs, summary: fs.readFileSync(sumFile, "utf8") });
    });
  });
}
const closeSrv = (srv) => new Promise((r) => srv.close(() => r()));

(async () => {
  console.log("v104.1 GitHub Actions(日次学習の完了待ち・ClubElo 中継)の修正");

  // ================= A. YAML の内容 =================
  await t("A1 日次学習: 待ち時間は最大60分(30秒×120回)・ジョブの上限80分・基準は呼び出す直前の時刻・旧い基準(待機ステップの開始)は残っていない", () => {
    assert.ok(/timeout-minutes:\s*80/.test(dailyYml));
    assert.ok(/max_attempts=120\b/.test(dailyYml) && !/max_attempts=44\b/.test(dailyYml));
    assert.ok(dailyYml.includes('call_epoch=$(date +%s)') && dailyYml.includes('echo "call_epoch=${call_epoch}" >> "$GITHUB_OUTPUT"'));
    assert.ok(dailyYml.indexOf("call_epoch=$(date +%s)") < dailyYml.indexOf('curl -sS -X POST "${LEARNING_ENDPOINT_URL}?key=${LEARNING_SECRET_KEY}"'), "時刻の記録は呼び出しの前");
    assert.ok(dailyYml.includes('CALL_EPOCH="${{ steps.call.outputs.call_epoch }}"'));
    assert.ok(!dailyYml.includes("job_started_epoch"), "旧い基準が残っている");
    assert.ok(!/::error::[^\n]*22分/.test(dailyYml) && /::error::[^\n]*60分待っても/.test(dailyYml), "失敗時の文言が旧いまま");
    assert.ok(dailyYml.includes("if: steps.call.outputs.already_completed != 'true'"), "完走済みの日は待たない(v99)を保つ");
    assert.ok(/cron: "17 19 \* \* \*"/.test(dailyYml) && /cron: "43 23 \* \* \*"/.test(dailyYml), "予約の時刻は変えていない");
  });

  await t("A2 ClubElo 中継: 提供元から取れない日は notice+本番への報告+正常終了。本番が受け取れないときだけ失敗(exit 1)", () => {
    const run = extractRun(eloYml, "Fetch ClubElo CSV");
    const noCsv = run.slice(run.indexOf('if [ -z "${FOUND}" ]; then'), run.indexOf('echo "取得成功: ${FOUND}'));
    assert.ok(noCsv.includes("::notice::") && !noCsv.includes("::error::"), "提供元の停止は error にしない");
    assert.ok(noCsv.includes('report_failure "fetch" "${LAST_CODE}" "no_csv_from_provider"'), "本番への報告は続ける");
    assert.ok(/exit 0\s*\n\s*fi/.test(noCsv) && !/exit 1/.test(noCsv));
    const post = run.slice(run.indexOf('echo "取得成功: ${FOUND}'));
    assert.ok(post.includes("::error::本番への中継に失敗しました") && /exit 1/.test(post), "こちら側の問題は従来どおり失敗");
    assert.ok(/cron: "51 18 \* \* \*"/.test(eloYml) && /cron: "21 23 \* \* \*"/.test(eloYml) && /cron: "37 11 \* \* \*"/.test(eloYml), "予約の時刻は変えていない");
    assert.ok(!run.includes('|| echo "000")'), "HTTPコードが 000000 になる書き方が残っている");
  });

  if (!CAN_SIMULATE) {
    skipped++;
    console.log("  - (jq / curl / bash / GNU date が無いため、スクリプトの実行シミュレーションは省略)");
  } else {
    const callScript = extractRun(dailyYml, "Call the daily learning engine endpoint");
    const waitTpl = extractRun(dailyYml, "Wait for the background job");
    const waitScript = (callEpoch, alreadyRunning) => waitTpl
      .replace("${{ steps.call.outputs.call_epoch }}", String(callEpoch))
      .replace("${{ steps.call.outputs.already_running }}", alreadyRunning ? "true" : "false");
    const eloScript = extractRun(eloYml, "Fetch ClubElo CSV");

    // ================= B. 日次学習: 呼び出しステップ =================
    await t("B1 呼び出し: 起動できた日は call_epoch を記録し、already_completed/already_running は false", async () => {
      const f = await startFake({ "/api/learning/run-daily": { ok: true, started: true } });
      const before = Math.floor(Date.now() / 1000);
      const r = await runScript(callScript, { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k" });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.ok(Number(r.outputs.call_epoch) >= before && Number(r.outputs.call_epoch) <= before + 30, JSON.stringify(r.outputs));
      assert.strictEqual(r.outputs.already_completed, "false"); assert.strictEqual(r.outputs.already_running, "false");
      assert.strictEqual(f.log.filter((x) => x.path === "/api/learning/run-daily" && x.method === "POST" && x.query.key === "k").length, 1);
    });
    await t("B2 呼び出し: 完走済み(alreadyCompleted)と実行中(alreadyRunning)を出力に反映。ok:true が無ければ1回だけ再試行して失敗", async () => {
      const f1 = await startFake({ "/api/learning/run-daily": { ok: true, started: false, skipped: true, alreadyCompleted: true, completedAt: "2026-11-14T00:46:40.000Z" } });
      const r1 = await runScript(callScript, { LEARNING_ENDPOINT_URL: `${f1.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k" });
      await closeSrv(f1.srv);
      assert.strictEqual(r1.status, 0); assert.strictEqual(r1.outputs.already_completed, "true"); assert.ok(r1.summary.includes("完走済みのためスキップ"));
      const f2 = await startFake({ "/api/learning/run-daily": { ok: true, started: false, alreadyRunning: true, reason: "RUN_LOCK_HELD" } });
      const r2 = await runScript(callScript, { LEARNING_ENDPOINT_URL: `${f2.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k" });
      await closeSrv(f2.srv);
      assert.strictEqual(r2.status, 0); assert.strictEqual(r2.outputs.already_completed, "false"); assert.strictEqual(r2.outputs.already_running, "true");
      // curl 自身の再試行(--retry)が働かない 200 応答で、スクリプトの再試行だけを数える
      const f3 = await startFake({ "/api/learning/run-daily": { ok: false, reason: "STORE_UNAVAILABLE" } });
      const r3 = await runScript(callScript, { LEARNING_ENDPOINT_URL: `${f3.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k" });
      await closeSrv(f3.srv);
      assert.strictEqual(r3.status, 1, "起動できなかった日は本当の失敗"); assert.ok(r3.stdout.includes("::error::"));
      assert.strictEqual(f3.log.filter((x) => x.path === "/api/learning/run-daily").length, 2, "1回だけ再試行する");
    });

    // ================= C. 日次学習: 完了待ち =================
    const growthFake = (ranAtFn, extra) => startFake({
      "/api/growth-log": (req, u, raw, log) => ({ configured: true, ranYet: true, ranAt: ranAtFn(log.filter((x) => x.path === "/api/growth-log").length) }),
      "/api/learning/progress": { ok: true, verdictJa: "いま「③-b TOP100クラブの収集(選手索引もここ)」の段階を実行中です(開始から600秒)。", secondsSinceLastStage: 20, dailyLearningRunning: true, progress: { stage: "③-b", finished: false } },
      ...(extra || {}),
    });
    await t("C1 本番と同じ並び(呼び出しの100秒後に待機を開始・学習は27分): 途中までは前日の記録、完了後に今日の記録 → 合格。旧い判定では絶対に合格できなかった並び", async () => {
      const now = Math.floor(Date.now() / 1000);
      const callEpoch = now - 100;                               // 自動収集ステップに100秒かかった
      const ranAtToday = new Date((callEpoch + 2) * 1000).toISOString(); // 学習の開始=呼び出しの2秒後
      const ranAtYesterday = new Date((callEpoch - 86400) * 1000).toISOString();
      const f = await growthFake((n) => (n <= 54 ? ranAtYesterday : ranAtToday)); // 54回(=27分)は前日のまま
      const r = await runScript(waitScript(callEpoch, false), { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily` });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0, r.stdout.slice(-600) + r.stderr.slice(-300));
      assert.ok(r.stdout.includes("学習ジョブの完了を確認しました"));
      assert.strictEqual(f.log.filter((x) => x.path === "/api/growth-log").length, 55, "55回目(27.5分相当)で検知");
      assert.ok(r.summary.includes("完了を確認しました") && r.summary.includes(ranAtToday));
      assert.ok(f.log.filter((x) => x.path === "/api/learning/progress").length >= 5, "5分ごとに進み具合を表示");
      // 旧い判定(基準=待機ステップの開始−10秒)では、ranAt(呼び出しの2秒後)は基準より98秒前=不合格だったことを数で確かめる
      assert.ok((callEpoch + 2) < (now - 10), "前提: 旧い基準では ranAt が基準より前");
    });
    await t("C2 完了しないまま60分: 120回確かめて失敗(exit 1)。どの段階で止まっているかを表示する", async () => {
      const callEpoch = Math.floor(Date.now() / 1000);
      const f = await growthFake(() => new Date((callEpoch - 86400) * 1000).toISOString());
      const r = await runScript(waitScript(callEpoch, false), { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily` });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 1);
      assert.strictEqual(f.log.filter((x) => x.path === "/api/growth-log").length, 120);
      assert.ok(r.stdout.includes("::error::") && r.stdout.includes("60分待っても") && r.stdout.includes("学習の進捗"), r.stdout.slice(-500));
      assert.ok(r.stdout.includes("③-b"), "止まっている段階が出る");
    });
    await t("C3 既に実行中だった日(alreadyRunning): 25分前に始まった学習の完了を合格にする。新しく起動した日は同じ記録を合格にしない", async () => {
      const callEpoch = Math.floor(Date.now() / 1000);
      const ranAt = new Date((callEpoch - 1500) * 1000).toISOString();
      const f1 = await growthFake(() => ranAt);
      const r1 = await runScript(waitScript(callEpoch, true), { LEARNING_ENDPOINT_URL: `${f1.base}/api/learning/run-daily` });
      await closeSrv(f1.srv);
      assert.strictEqual(r1.status, 0, r1.stdout.slice(-400));
      const f2 = await growthFake(() => ranAt);
      const r2 = await runScript(waitScript(callEpoch, false), { LEARNING_ENDPOINT_URL: `${f2.base}/api/learning/run-daily` });
      await closeSrv(f2.srv);
      assert.strictEqual(r2.status, 1, "新しく起動した日に、25分前の記録で合格にしてはいけない");
      // 5時間前の記録(前の実行)は、実行中の日でも合格にしない
      const f3 = await growthFake(() => new Date((callEpoch - 18000) * 1000).toISOString());
      const r3 = await runScript(waitScript(callEpoch, true), { LEARNING_ENDPOINT_URL: `${f3.base}/api/learning/run-daily` });
      await closeSrv(f3.srv);
      assert.strictEqual(r3.status, 1);
    });
    await t("C4 成長ログが読めない・壊れている間は合格にせず待ち続け、読めるようになったら合格", async () => {
      const callEpoch = Math.floor(Date.now() / 1000);
      const ok = new Date((callEpoch + 1) * 1000).toISOString();
      const f = await startFake({
        "/api/growth-log": (req, u, raw, log) => { const n = log.filter((x) => x.path === "/api/growth-log").length; return n <= 3 ? { __status: 503, error: "down" } : (n <= 5 ? { configured: true, ranYet: null, readFailed: true } : { ranAt: ok }); },
        "/api/learning/progress": { ok: true, verdictJa: "実行中" },
      });
      const r = await runScript(waitScript(callEpoch, false), { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily` });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0, r.stdout.slice(-400));
      assert.strictEqual(f.log.filter((x) => x.path === "/api/growth-log").length, 6);
    });

    // ================= D. ClubElo 中継 =================
    await t("D1 提供元が応答しない日: 正常終了(exit 0)。::error:: を出さず、本番へ「取得できなかった」を報告し、要約に残す", async () => {
      const f = await startFake({ "/api/clubelo/ingest": { ok: true, recorded: "failed" } });
      const r = await runScript(eloScript, { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k", FAKE_ELO: "down" }, { fakeElo: true });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0, r.stdout.slice(-500) + r.stderr.slice(-300));
      assert.ok(r.stdout.includes("::notice::") && !r.stdout.includes("::error::"), r.stdout.slice(-400));
      const rep = f.log.filter((x) => x.path === "/api/clubelo/ingest");
      assert.strictEqual(rep.length, 1); assert.strictEqual(rep[0].query.status, "failed"); assert.strictEqual(rep[0].query.stage, "fetch");
      assert.strictEqual(rep[0].query.code, "000", "HTTPコードは 000(従来は 000000 になっていた): " + rep[0].query.code);
      assert.ok(r.summary.includes("提供元が応答しないため見送り"));
    });
    await t("D2 提供元が 502 を返す日(エラーページをCSVと取り違えない): 正常終了・報告のコードは 502", async () => {
      const f = await startFake({ "/api/clubelo/ingest": { ok: true } });
      const r = await runScript(eloScript, { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k", FAKE_ELO: "http502" }, { fakeElo: true });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0);
      const rep = f.log.filter((x) => x.path === "/api/clubelo/ingest");
      assert.strictEqual(rep.length, 1); assert.strictEqual(rep[0].query.code, "502"); assert.strictEqual(rep[0].bodyBytes, 0, "エラーページを中継しない");
    });
    await t("D3 提供元が復旧した日: CSV を本番へ中継して正常終了", async () => {
      const f = await startFake({ "/api/clubelo/ingest": { ok: true, ingested: 150 } });
      const r = await runScript(eloScript, { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "k", FAKE_ELO: "up" }, { fakeElo: true });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 0, r.stdout.slice(-400));
      const posts = f.log.filter((x) => x.path === "/api/clubelo/ingest");
      assert.strictEqual(posts.length, 1); assert.ok(posts[0].bodyBytes > 3000 && /^\d{4}-\d{2}-\d{2}$/.test(posts[0].query.date) && !posts[0].query.status);
      assert.ok(r.stdout.includes("中継完了"));
    });
    await t("D4 こちら側の問題(本番が中継を受け取れない): 従来どおり失敗(exit 1)として知らせる", async () => {
      const f = await startFake({ "/api/clubelo/ingest": (req, u) => (u.searchParams.get("status") === "failed" ? { ok: true } : { __status: 403, ok: false, reason: "forbidden" }) });
      const r = await runScript(eloScript, { LEARNING_ENDPOINT_URL: `${f.base}/api/learning/run-daily`, LEARNING_SECRET_KEY: "wrong", FAKE_ELO: "up" }, { fakeElo: true });
      await closeSrv(f.srv);
      assert.strictEqual(r.status, 1);
      assert.ok(r.stdout.includes("::error::本番への中継に失敗しました"));
      assert.ok(f.log.some((x) => x.path === "/api/clubelo/ingest" && x.query.status === "failed" && x.query.stage === "post"), "失敗も本番へ報告する");
    });
  }

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗${skipped ? `(省略 ${skipped})` : ""}`);
  process.exit(fail ? 1 : 0);
})();
