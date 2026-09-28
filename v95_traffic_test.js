"use strict";
/** v95(2026年9月28日): 利用者の指示「どこから何人・どれだけ残ったかを数える機能」のテスト。
 *
 *  方針: ・訪問者ごとの記録は持たない(匿名・集計のみ) ・1件のビーコンはプロセス内カウンターを増やすだけ(O(1))
 *        ・保存先へは1時間に1回、増えたぶんだけ HINCRBY(0は送らない・止まっていれば持ち越し)
 *        ・レポートは 保存先の値 + 未保存の増分(二重に数えない) ・でっち上げない(読めない日は readFailures に出す)
 *  検証は差し替え保存先で実サーバーを動かし、往復するコマンドと戻り値で確かめる。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const findUp = (...names) => {
  for (const n of names) { for (const base of [path.join(__dirname, ".."), __dirname]) { const f = path.join(base, n); if (fs.existsSync(f)) return f; } }
  return path.join(__dirname, "..", names[0]);
};
const INDEX_HTML = findUp("index.html");
const SW_JS = findUp("sw.js");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HINCRBY / HGETALL / EXPIRE に対応した保存先モック(全コマンドを記録・停止モードあり) */
function mockStore() {
  const store = new Map(); const hashes = new Map(); const calls = []; const m = { mode: "ok" };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (m.mode === "quota") throw new Error("Upstash error: ERR max requests limit exceeded. Limit: 500000, Usage: 500000");
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { store.delete(a[0]); hashes.delete(a[0]); return 1; }
    if (op === "HINCRBY") { const h = hashes.get(a[0]) || new Map(); const v = (h.get(a[1]) || 0) + (parseInt(a[2], 10) || 0); h.set(a[1], v); hashes.set(a[0], h); return v; }
    if (op === "HGETALL") { const h = hashes.get(a[0]); if (!h) return []; const flat = []; for (const [k, v] of h) { flat.push(k, String(v)); } return flat; }
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "LRANGE") { const l = store.get(a[0]) || []; return l.slice(); }
    if (op === "LLEN") { const l = store.get(a[0]) || []; return l.length; }
    if (op === "EXPIRE") return 1;
    if (op === "INCRBY" || op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + (op === "INCR" ? 1 : (parseInt(a[1], 10) || 0)); store.set(a[0], String(v)); return v; }
    return null;
  }
  const upstashGetJSON = async (k) => { try { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); } catch (e) { return null; } };
  const upstashSetJSON = async (k, v) => { try { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; } catch (e) { return false; } };
  const count = (op) => calls.filter((c) => c[0] === op).length;
  return { store, hashes, calls, count, m, upstashCmd, upstashGetJSON, upstashSetJSON };
}

const PORT = 8912;
const request = (method, p, body, headers) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
  const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(headers || {}) } }, (res) => {
    let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch (e) { j = { raw: d }; } resolve({ status: res.statusCode, body: j, raw: d, headers: res.headers }); });
  });
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});
const jst = (offsetDays) => new Date(Date.now() + 9 * 3600000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);

(async () => {
  console.log("v95 流入計測(どこから何人・どれだけ残ったか)テスト");
  process.env.PORT = String(PORT);
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.SELF_HEAL_DAILY_LEARNING = "0";
  process.env.LINEUP_WATCH = "0";
  process.env.STORE_QUOTA_STICKY_MS = "0";
  process.env.TRAFFIC_FLUSH_MS = "3600000";
  const srvMod = require("./server.js");
  const T = srvMod.__trafficForTest;
  const S = srvMod.__storeForTest;
  const m = mockStore();
  m.store.set("pred:autocollect:lastrun", JSON.stringify({ at: new Date().toISOString() }));
  m.store.set("learn:growthlog:latest", JSON.stringify({ date: jst(0), ranAt: new Date().toISOString(), errors: [] }));
  srvMod.__setTestHooks({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
  await sleep(300);
  const today = jst(0), yesterday = jst(-1), threeDaysAgo = jst(-3);

  await t("① 経路名の正規化: 大小文字・空・記号・長すぎ", () => {
    assert.strictEqual(T.trafficNormalizeSource("X"), "x");
    assert.strictEqual(T.trafficNormalizeSource(" youtube "), "youtube");
    assert.strictEqual(T.trafficNormalizeSource(""), "direct");
    assert.strictEqual(T.trafficNormalizeSource(null), "direct");
    assert.strictEqual(T.trafficNormalizeSource("Twitter Ads!!"), "other");
    assert.strictEqual(T.trafficNormalizeSource("a".repeat(25)), "other");
    assert.strictEqual(T.trafficNormalizeSource("note_2026-09"), "note_2026-09");
  });

  await t("② ビーコン(POST /api/visit)が 204 で受理され、到着/新規/再訪/残った が経路別に数えられる(保存先は触らない)", async () => {
    T.resetForTest(); S.resetForTest();
    const before = m.calls.length;
    const r1 = await request("POST", "/api/visit", { type: "land", from: "x", firstFrom: "x", firstDay: today, isNew: true, returning: false });
    assert.strictEqual(r1.status, 204, JSON.stringify(r1.body));
    const r2 = await request("POST", "/api/visit", { type: "land", from: "youtube", firstFrom: "youtube", firstDay: today, isNew: true, returning: false });
    assert.strictEqual(r2.status, 204);
    const r3 = await request("POST", "/api/visit", { type: "land", from: "x", firstFrom: "x", firstDay: yesterday, isNew: false, returning: true });
    assert.strictEqual(r3.status, 204);
    const r4 = await request("POST", "/api/visit", { type: "engage", from: "x" });
    assert.strictEqual(r4.status, 204);
    const r5 = await request("POST", "/api/visit", { type: "land", from: "x", isNew: false, returning: false }); // 同日2回目(再訪でも新規でもない)
    assert.strictEqual(r5.status, 204);
    await sleep(100);
    const storeCmds = m.calls.slice(before).filter((c) => /^growth:/.test(String(c[1] || "")));
    assert.strictEqual(storeCmds.length, 0, "ビーコンの処理で保存先へコマンドが出た: " + JSON.stringify(storeCmds));
    const st = T.state();
    const todayPending = Object.fromEntries(st.pending)[today];
    assert.deepStrictEqual(todayPending, { "l:x": 3, "n:x": 1, "l:youtube": 1, "n:youtube": 1, "r:x": 1, [`c:${yesterday}|x`]: 1, "e:x": 1 }, JSON.stringify(todayPending));
    assert.strictEqual(st.accepted, 5);
  });

  await t("③ レポート(未保存の増分だけ): 経路別の合計・残った%・summaryJa", async () => {
    const r = await request("GET", "/api/growth/traffic?days=7");
    assert.strictEqual(r.status, 200);
    const b = r.body;
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(b.total, { landings: 4, newVisitors: 2, returning: 1, engaged: 1 });
    const x = b.sources.find((s) => s.source === "x");
    assert.deepStrictEqual({ landings: x.landings, newVisitors: x.newVisitors, returning: x.returning, engaged: x.engaged, engagedPct: x.engagedPct }, { landings: 3, newVisitors: 1, returning: 1, engaged: 1, engagedPct: 33.3 });
    assert.strictEqual(b.sources[0].source, "x", "到着の多い順になっていない");
    assert.ok(b.summaryJa[0].includes("到着4回") && b.summaryJa[0].includes("新規2人") && b.summaryJa[0].includes("残った(45秒以上か操作あり)1回(25%)"), b.summaryJa[0]);
    assert.ok(b.summaryJa.some((l) => l.startsWith("x: 到着3 / 新規1 / 再訪1 / 残った1(33.3%)")), JSON.stringify(b.summaryJa));
    assert.strictEqual(b.pendingUnflushed, 9);
    assert.ok(b.definitionsJa && b.limitsJa.length >= 3);
  });

  await t("④ 定着(コホート): 昨日の新規10人(x)のうち今日1人が戻った → d1=1(10%)。sizeが無い到着日は割合を出さない", async () => {
    // 昨日の新規10人は保存先にある(以前のプロセスが足したもの)
    await m.upstashCmd(["HINCRBY", `growth:traffic:${yesterday}`, "n:x", "10"]);
    await m.upstashCmd(["HINCRBY", `growth:traffic:${yesterday}`, "l:x", "12"]);
    T.resetForTest(); // レポートキャッシュも捨てる
    // 増分を再現(② と同じ)
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: yesterday, isNew: false, returning: true });
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: threeDaysAgo, isNew: false, returning: true }); // 3日前のコホート(sizeは保存先に無い)
    const r = await request("GET", "/api/growth/traffic?days=7");
    const b = r.body;
    const coh = b.retention.find((c) => c.cohortDate === yesterday);
    assert.ok(coh, "昨日のコホートが無い: " + JSON.stringify(b.retention));
    const row = coh.rows.find((x) => x.source === "x");
    assert.deepStrictEqual({ size: row.size, d1: row.d1, d1Pct: row.d1Pct, d3: row.d3, d7: row.d7, within7: row.returnVisitDays7 }, { size: 10, d1: 1, d1Pct: 10, d3: null, d7: null, within7: 1 });
    assert.ok(!b.retention.find((c) => c.cohortDate === threeDaysAgo), "新規人数が分からない到着日を定着表に出している(でっち上げ)");
    // 合計は 保存先(昨日 到着12) + 増分(今日 到着2)
    assert.strictEqual(b.total.landings, 14);
    assert.strictEqual(b.byDay.find((d) => d.date === yesterday).landings, 12);
    assert.strictEqual(b.readMode, "store");
    assert.strictEqual(b.readFailures, 0);
  });

  await t("⑤ 保存先への積み上げ: 増えたぶんだけ HINCRBY(0は送らない)・EXPIRE は日キーごとに1回・1時間以内の2回目は送らない", async () => {
    const before = m.calls.length;
    const r = await T.maybeFlushTraffic(true);
    const cmds = m.calls.slice(before);
    const hinc = cmds.filter((c) => c[0] === "HINCRBY");
    const exp = cmds.filter((c) => c[0] === "EXPIRE");
    assert.strictEqual(r.sent, hinc.length, JSON.stringify(r));
    assert.strictEqual(hinc.length, 4, "HINCRBYの本数: " + JSON.stringify(hinc)); // l:x=2, r:x=2, c:昨日|x=1, c:3日前|x=1
    assert.ok(hinc.every((c) => Number(c[3]) > 0), "0の増分を送っている");
    assert.strictEqual(exp.length, 1, "EXPIREが日キーごとに1回でない: " + exp.length);
    assert.strictEqual(exp[0][2], String(100 * 86400));
    assert.deepStrictEqual(T.state().pending, [], "送った増分が残っている: " + JSON.stringify(T.state().pending));
    // 保存先の値に反映されている
    const h = m.hashes.get(`growth:traffic:${today}`);
    assert.strictEqual(h.get("l:x"), 2);
    assert.strictEqual(h.get(`c:${yesterday}|x`), 1);
    // 2回目(増分なし・1時間以内)は何も送らない
    T.recordVisit({ type: "land", from: "note", isNew: true });
    const before2 = m.calls.length;
    const r2 = await T.maybeFlushTraffic(false);
    assert.strictEqual(r2.skipped, "interval");
    assert.strictEqual(m.calls.slice(before2).filter((c) => c[0] === "HINCRBY").length, 0);
    // 強制すると、その日キーには EXPIRE を付け直さない
    const before3 = m.calls.length;
    await T.maybeFlushTraffic(true);
    const cmds3 = m.calls.slice(before3);
    assert.strictEqual(cmds3.filter((c) => c[0] === "EXPIRE").length, 0, "同じ日キーに EXPIRE を2回付けている");
    assert.strictEqual(cmds3.filter((c) => c[0] === "HINCRBY").length, 2); // l:note, n:note
  });

  await t("⑥ 積み上げ後のレポートは二重に数えない(保存先の値 + 残り増分0 = 送る前と同じ数字)", async () => {
    const r = await request("GET", "/api/growth/traffic?days=7");
    const b = r.body;
    assert.strictEqual(b.pendingUnflushed, 0);
    assert.strictEqual(b.total.landings, 15, JSON.stringify(b.total)); // 12(昨日) + 2(x) + 1(note)
    assert.strictEqual(b.sources.find((s) => s.source === "note").newVisitors, 1);
    assert.strictEqual(b.retention.find((c) => c.cohortDate === yesterday).rows[0].d1, 1);
  });

  await t("⑦ 保存先が止まっていると積み上げは持ち越し(増分は消えない)・レポートは増分だけを readMode=store_down で返す・復旧後に足せる", async () => {
    T.resetForTest(); S.resetForTest();
    m.m.mode = "quota";
    await S.upstashGetJSONOrThrow("x").catch(() => {}); // 上限エラーを1回観測 → down
    assert.strictEqual(S.storeIsDown(), true);
    T.recordVisit({ type: "land", from: "tiktok", isNew: true });
    const r = await T.maybeFlushTraffic(true);
    assert.strictEqual(r.skipped, "store_down");
    assert.deepStrictEqual(Object.fromEntries(T.state().pending)[today], { "l:tiktok": 1, "n:tiktok": 1 });
    const rep = await request("GET", "/api/growth/traffic?days=3");
    assert.strictEqual(rep.body.readMode, "store_down");
    assert.strictEqual(rep.body.readFailures, 3);
    assert.strictEqual(rep.body.total.landings, 1, "止まっている間は未保存の増分だけが見える");
    m.m.mode = "ok";
    await S.upstashGetJSONOrThrow("x"); // 復旧を観測
    const r2 = await T.maybeFlushTraffic(true);
    assert.strictEqual(r2.sent, 2);
    assert.strictEqual(m.hashes.get(`growth:traffic:${today}`).get("l:tiktok"), 1);
  });

  await t("⑧ 不正なビーコンは 400 で数えない・大きすぎる本文は 413・GET は 405", async () => {
    const acc0 = T.state().accepted;
    const r1 = await request("POST", "/api/visit", { type: "hack", from: "x" });
    assert.strictEqual(r1.status, 400);
    const r2 = await request("POST", "/api/visit", "not json");
    assert.strictEqual(r2.status, 400);
    const r3 = await request("POST", "/api/visit", { type: "land", from: "x", junk: "z".repeat(3000) });
    assert.strictEqual(r3.status, 413);
    const r4 = await request("GET", "/api/visit");
    assert.strictEqual(r4.status, 405);
    assert.strictEqual(T.state().accepted, acc0, "不正なビーコンが数えられた");
    assert.ok(T.state().rejected >= 3);
  });

  await t("⑨ 経路名の種類は1日40までで、それ以上は other にまとめる", async () => {
    T.resetForTest();
    for (let i = 0; i < 45; i++) T.recordVisit({ type: "land", from: `src${i}`, isNew: true });
    const pend = Object.fromEntries(T.state().pending)[today];
    const srcs = new Set(Object.keys(pend).filter((k) => k.startsWith("l:")).map((k) => k.slice(2)));
    assert.strictEqual(srcs.size, 41, "40種類+other になっていない: " + srcs.size); // 40 + other
    assert.strictEqual(pend["l:other"], 5);
  });

  await t("⑩ 初回日が今日/未来/壊れている再訪はコホートに数えない・60日より古い初回は older", async () => {
    T.resetForTest();
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: today, isNew: false, returning: true });
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: jst(3), isNew: false, returning: true });
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: "20xx-01-01", isNew: false, returning: true });
    T.recordVisit({ type: "land", from: "x", firstFrom: "x", firstDay: jst(-90), isNew: false, returning: true });
    const pend = Object.fromEntries(T.state().pending)[today];
    assert.strictEqual(pend["r:x"], 4, "再訪そのものは数える");
    const cohortKeys = Object.keys(pend).filter((k) => k.startsWith("c:"));
    assert.deepStrictEqual(cohortKeys, ["c:older|x"], JSON.stringify(cohortKeys));
  });

  await t("⑪ 管理ページ /growth が返り、/api/growth/traffic を読む作りになっている(noindex)", async () => {
    const r = await request("GET", "/growth");
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers["content-type"]));
    assert.strictEqual(r.headers["x-robots-tag"], "noindex");
    assert.ok(r.raw.includes("/api/growth/traffic?days=") && r.raw.includes("どこから何人・どれだけ残ったか"));
    assert.ok(r.raw.includes('id="retention"') && r.raw.includes('id="sources"'));
  });

  await t("⑫ GROWTH_REPORT_PUBLIC=0 + AUTO_COLLECT_SECRET で鍵が必要になる(鍵あり=200・鍵なし=403)。既定は公開", async () => {
    process.env.GROWTH_REPORT_PUBLIC = "0";
    process.env.AUTO_COLLECT_SECRET = "s3cret";
    try {
      const r1 = await request("GET", "/api/growth/traffic?days=3");
      assert.strictEqual(r1.status, 403);
      const r2 = await request("GET", "/api/growth/traffic?days=3&key=s3cret");
      assert.strictEqual(r2.status, 200);
    } finally {
      delete process.env.GROWTH_REPORT_PUBLIC;
      delete process.env.AUTO_COLLECT_SECRET;
    }
    const r3 = await request("GET", "/api/growth/traffic?days=3");
    assert.strictEqual(r3.status, 200);
  });

  await t("⑬ 画面(index.html): ビーコン送信・?from= と参照元の判定・端末側の新規/再訪判定・45秒/操作での engage / sw.js は v95以上", () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(html.includes("function trackVisitSource()"), "計測関数が無い");
    assert.ok(html.includes("`${API_PROXY_BASE}/visit`"), "ビーコン先が /api/visit でない");
    assert.ok(html.includes('url.searchParams.get("from")'), "?from= を読んでいない");
    assert.ok(html.includes('localStorage.getItem("visitAttribution")'), "端末側の初回記録が無い");
    assert.ok(html.includes('type: "land"') && html.includes('type: "engage"'));
    assert.ok(html.includes("visibleMs >= 45000"), "45秒の判定が無い");
    assert.ok(/trackVisitSource\(\);\s*$/m.test(html), "起動時に呼ばれていない");
    assert.ok(html.includes('if (src === "internal") return;'), "サイト内の移動を除外していない");
    const idx = html.indexOf("function trackVisitSource()");
    const fnSrc = html.slice(idx, html.indexOf("\nrenderMyClubCard();", idx));
    assert.ok(!/[ぁ-んァ-ン一-龥]/.test(fnSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "計測コードに表示用の日本語が入っている(翻訳対象になる)");
    const sw = fs.readFileSync(SW_JS, "utf8");
    const swVer = Number((sw.match(/CACHE_NAME = "soccer-ai-shell-v(\d+)"/) || [])[1]);
    assert.ok(swVer >= 95, "sw.js が v95 以上でない: " + swVer);
  });

  await t("⑭ 最後のビーコンのあと誰も来なくても、TRAFFIC_FLUSH_MS 後にタイマーで1回積み上げる(別プロセス・300ms設定)", async () => {
    const { execFileSync } = require("child_process");
    const script = `
      process.env.PORT = "8913"; process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
      process.env.API_FOOTBALL_KEY = ""; process.env.ANTHROPIC_API_KEY = ""; process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.LINEUP_WATCH = "0";
      process.env.TRAFFIC_FLUSH_MS = "300";
      const http = require("http");
      const srv = require(${JSON.stringify(path.join(__dirname, "server.js"))});
      const hashes = new Map(); const calls = [];
      srv.__setTestHooks({ upstashCmd: async (cmd) => { calls.push(cmd[0]); if (cmd[0] === "HINCRBY") { const h = hashes.get(cmd[1]) || new Map(); h.set(cmd[2], (h.get(cmd[2]) || 0) + Number(cmd[3])); hashes.set(cmd[1], h); return h.get(cmd[2]); } if (cmd[0] === "GET") return cmd[1] === "pred:autocollect:lastrun" ? JSON.stringify({ at: new Date().toISOString() }) : null; if (cmd[0] === "EXPIRE") return 1; if (cmd[0] === "LRANGE") return []; return null; },
        upstashGetJSON: async () => null, upstashSetJSON: async () => true });
      setTimeout(() => {
        const body = JSON.stringify({ type: "land", from: "x", isNew: true });
        const req = http.request({ host: "127.0.0.1", port: 8913, path: "/api/visit", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
          res.resume();
          // 以後リクエストを一切送らずに待つ → タイマーが積み上げるはず
          setTimeout(() => {
            const h = hashes.get("growth:traffic:" + new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10));
            console.log(JSON.stringify({ status: res.statusCode, flushed: h ? Object.fromEntries(h) : null, hincrby: calls.filter((c) => c === "HINCRBY").length }));
            srv.server.close(); process.exit(0);
          }, 1200);
        });
        req.write(body); req.end();
      }, 300);
    `;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] });
    const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
    const r = JSON.parse(line);
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual(r.flushed, { "l:x": 1, "n:x": 1 }, "タイマーで積み上がっていない: " + JSON.stringify(r));
    assert.strictEqual(r.hincrby, 2);
  });

  srvMod.server.close();
  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
