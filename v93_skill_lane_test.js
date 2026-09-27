"use strict";
/** v93(2026年9月24日): Capafy等の「共有出口IP」から来る正規のSkill呼び出しに専用の枠を与える。
 *
 *  背景: 本番は「1IP=1分30回」「1IP=1日の重い呼び出し枠(既定120)」で守られている。Capafy の Run Online は
 *  利用者全員が同じ出口IPを共有する可能性が高く、そのままだと利用者が増えた瞬間に全員がまとめて制限に当たる。
 *
 *  検証すること(実サーバーをHTTPで叩く):
 *   ① 鍵なし: 従来どおりIPの枠(上限を3にして4回目が429)
 *   ② 正しい鍵: IPの枠が尽きていても通る=別レーン。レーン自身の上限(6)で7回目が429
 *   ③ 間違った鍵: 403にせず従来のIP枠で扱う(鍵の有無を漏らさない)。診断で不一致回数が数えられる
 *   ④ 鍵が未設定の環境: ヘッダーは無視=従来と完全に同じ(/api/health の skillLane は "off")
 *   ⑤ 診断 /api/diag/skill-lane: AUTO_COLLECT_SECRET 設定時は ?key= 必須。鍵の値・長さは出さない
 *   ⑥ 重い呼び出しの日次枠もレーン別(単体関数で: レーンに1000回引くとレーンだけ止まり、IPは止まらない)
 *   ⑦ 鍵の比較は定時間比較を使い、SKILL.md には鍵が書かれていない(ソース検査) */
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); } };

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method: "GET", headers: headers || {} }, (res) => {
      let data = ""; res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject); req.end();
  });
}
async function bootServer(port, extraEnv) {
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env, PORT: String(port), API_FOOTBALL_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "",
      ANTHROPIC_API_KEY: "", SELF_HEAL_DAILY_LEARNING: "0", LINEUP_WATCH: "0", RATE_LIMIT_PER_MINUTE: "3", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; srv.stderr.on("data", (c) => { stderr += c; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server boot timeout: " + stderr.slice(0, 300))), 15000);
    const poll = async () => {
      try { const r = await get(port, "/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
      setTimeout(poll, 300);
    };
    poll();
  });
  return { srv, getStderr: () => stderr };
}

const KEY = "test-skill-key-0123456789abcdef";

(async () => {
  // ---------------- 鍵あり・診断保護ありのサーバー ----------------
  const A = await bootServer(8907, { SKILL_API_KEY: KEY, SKILL_RATE_LIMIT_PER_MINUTE: "6", AUTO_COLLECT_SECRET: "diag-secret" });
  try {
    await t("① 鍵なし: 従来どおりIPの枠(3回まで・4回目は429・レーン表示は shared)", async () => {
      // 起床確認で1回使っているので、残り2回が通り、その次が429
      const r1 = await get(8907, "/api/health"); const r2 = await get(8907, "/api/health"); const r3 = await get(8907, "/api/health");
      assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
      assert.strictEqual(r3.status, 429, "4回目が429でない: " + r3.status);
      assert.strictEqual(r1.headers["x-skill-lane"], "shared");
      assert.ok(JSON.parse(r3.body).error.includes("レート制限"));
    });

    await t("② 正しい鍵: IPの枠が尽きていても通る(別レーン)。レーンの上限6で7回目が429", async () => {
      const h = { "X-Skill-Key": KEY };
      for (let i = 1; i <= 6; i++) {
        const r = await get(8907, "/api/health", h);
        assert.strictEqual(r.status, 200, `専用レーン${i}回目が通らない: ${r.status}`);
        assert.strictEqual(r.headers["x-skill-lane"], "dedicated");
        assert.strictEqual(JSON.parse(r.body).skillLane, "configured");
      }
      const r7 = await get(8907, "/api/health", h);
      assert.strictEqual(r7.status, 429, "レーン上限の7回目が429でない: " + r7.status);
      // IPの枠は依然として尽きている(レーンの成功がIPの枠を消費していないことの裏返し)
      const rIp = await get(8907, "/api/health");
      assert.strictEqual(rIp.status, 429);
    });

    await t("③ 間違った鍵: 403にせず従来のIP枠で扱う(=いまは429)。鍵の有無を応答で漏らさない", async () => {
      const r = await get(8907, "/api/health", { "X-Skill-Key": KEY + "x" });
      assert.strictEqual(r.status, 429, "間違った鍵がIP枠以外で扱われた: " + r.status);
      assert.strictEqual(r.headers["x-skill-lane"], "shared");
      assert.ok(!r.body.includes("key") || !r.body.includes("invalid"), "鍵の判定結果が本文に漏れている");
      const r2 = await get(8907, "/api/health", { "X-Skill-Key": "" }); // 空文字も不一致扱い
      assert.strictEqual(r2.headers["x-skill-lane"], "shared");
    });

  } finally { A.srv.kill("SIGKILL"); }

  // ---------------- 診断の中身(枠を消費していない新しいサーバー) ----------------
  const B = await bootServer(8908, { SKILL_API_KEY: KEY, SKILL_RATE_LIMIT_PER_MINUTE: "50", RATE_LIMIT_PER_MINUTE: "50", AUTO_COLLECT_SECRET: "diag-secret" });
  try {
    await t("⑤ 診断: 秘密なしは403(他の診断と同じ ?key= 保護)。秘密ありで本日の件数と不一致回数が見え、鍵の値・長さは出ない", async () => {
      await get(8908, "/api/health", { "X-Skill-Key": KEY });
      await get(8908, "/api/health", { "X-Skill-Key": KEY });
      await get(8908, "/api/health", { "X-Skill-Key": "wrong-key-value-000000" });
      const denied = await get(8908, "/api/diag/skill-lane");
      assert.strictEqual(denied.status, 403, "秘密なしで診断が見えてしまう: " + denied.status);
      const d = await get(8908, "/api/diag/skill-lane?key=diag-secret");
      assert.strictEqual(d.status, 200);
      const j = JSON.parse(d.body);
      assert.strictEqual(j.configured, true); assert.strictEqual(j.keyLooksStrong, true);
      assert.strictEqual(j.limits.perMinute, 50); assert.strictEqual(j.limits.heavyCallsPerDay, 1000);
      assert.strictEqual(j.today.requests, 2, "レーンの件数: " + j.today.requests);
      assert.strictEqual(j.today.mismatchedKey, 1, "不一致回数: " + j.today.mismatchedKey);
      assert.ok(!d.body.includes(KEY), "診断に鍵の値が含まれている");
      assert.ok(!/keyLength|"length"/.test(d.body), "鍵の長さが出ている");
      assert.ok(j.stateJa.includes("2件"), "stateJa: " + j.stateJa);
    });
  } finally { B.srv.kill("SIGKILL"); }

  // ---------------- 鍵が未設定のサーバー(従来と完全に同じ) ----------------
  const C = await bootServer(8909, {});
  try {
    await t("④ 鍵未設定: ヘッダーは無視され従来のIP枠(4回目429)。/api/health の skillLane は off・診断も無効を明示", async () => {
      const h = { "X-Skill-Key": KEY };
      const r1 = await get(8909, "/api/health", h); const r2 = await get(8909, "/api/health", h); const r3 = await get(8909, "/api/health", h);
      assert.strictEqual(r1.status, 200); assert.strictEqual(JSON.parse(r1.body).skillLane, "off");
      assert.strictEqual(r1.headers["x-skill-lane"], "shared");
      assert.strictEqual(r2.status, 200); assert.strictEqual(r3.status, 429, "未設定環境で従来の枠が効いていない");
    });
  } finally { C.srv.kill("SIGKILL"); }

  // ---------------- 単体: 重い呼び出しの日次枠がレーン別 ----------------
  await t("⑥ 重い呼び出しの日次枠: レーンに1000回引くとレーンだけ止まり、IPは止まらない。文面も上限を反映", async () => {
    process.env.PORT = "8910"; process.env.UPSTASH_REDIS_REST_URL = ""; process.env.API_FOOTBALL_KEY = "";
    process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.LINEUP_WATCH = "0";
    const mod = require("./server.js");
    try {
      const L = mod.__skillLaneForTest;
      L.chargeHeavyBudget(L.SKILL_LANE_KEY, 1000, "/api/x-heavy");
      L.chargeHeavyBudget("1.2.3.4|", 5, "/api/x-heavy");
      const lane = L.heavyBudgetPrecheck(L.SKILL_LANE_KEY, "/api/x-heavy", 1000);
      const ip = L.heavyBudgetPrecheck("1.2.3.4|", "/api/x-heavy", 120);
      assert.strictEqual(lane.allowed, false, "レーンが止まっていない");
      assert.ok(lane.messageJa.includes("1000回"), "文面にレーンの上限が無い: " + lane.messageJa);
      assert.strictEqual(ip.allowed, true, "IPが巻き添えで止まった");
      assert.strictEqual(L.heavyBudgetExceeded(L.SKILL_LANE_KEY, 1000), true);
      assert.strictEqual(L.heavyBudgetExceeded(L.SKILL_LANE_KEY, 5000), false, "上限を大きくすれば通る");
      assert.strictEqual(L.heavyBudgetExceeded("1.2.3.4|"), false);
      // 判定関数: ヘッダー無し / 未設定環境(このプロセスは SKILL_API_KEY 無し)
      assert.deepStrictEqual(L.skillLaneFor({ headers: {} }), { dedicated: false });
      assert.deepStrictEqual(L.skillLaneFor({ headers: { "x-skill-key": "anything" } }), { dedicated: false, ignored: true });
      // 分あたり: 上限の引数が効く
      for (let i = 0; i < 3; i++) assert.strictEqual(L.rateLimited("bucket-a", 3), false);
      assert.strictEqual(L.rateLimited("bucket-a", 3), true);
      assert.strictEqual(L.rateLimited("bucket-b"), false, "既定の上限が壊れた");
    } finally { mod.server.close(); }
  });

  await t("⑦ ソース検査: 定時間比較・ヘッダー名・CORS許可・SKILL.md/参照に鍵の値が無い", async () => {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(src.includes("crypto.timingSafeEqual(a, b)"), "定時間比較が無い");
    assert.ok(src.includes('req.headers["x-skill-key"]'), "ヘッダー名が違う");
    assert.ok(src.includes('"Content-Type, X-Skill-Key"'), "CORSの許可ヘッダーに無い");
    assert.ok(src.includes("store.ip = budgetKey; store.pathname = pathname; store.heavyLimit = heavyLimit;"), "実測課金の宛先がレーンに揃っていない");
    assert.ok(src.includes("heavyBudgetExceeded(store.ip, store.heavyLimit)"), "処理中の日次ガードがレーンの上限を見ていない");
    assert.ok(!/SKILL_API_KEY\s*=\s*"[A-Za-z0-9]{8,}"/.test(src), "鍵の値がソースに直書きされている");
    // Skill草案(存在すれば)に鍵の値が無いこと・ヘッダー名が一致すること
    for (const cand of [path.join(__dirname, "..", "..", "capafy_skill", "soccer-ai-skill", "SKILL.md"), "/tmp/capafy_skill/soccer-ai-skill/SKILL.md"]) {
      if (fs.existsSync(cand)) {
        const sk = fs.readFileSync(cand, "utf8");
        assert.ok(sk.includes("X-Skill-Key") && sk.includes("SOCCER_AI_SKILL_KEY"), "SKILL.md のヘッダー/環境変数名が違う");
        assert.ok(!/[A-Za-z0-9]{24,}/.test(sk.replace(/https?:\/\/\S+/g, "")), "SKILL.md に鍵らしき長い英数字列がある");
        break;
      }
    }
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
