"use strict";
/**
 * v102(2026年11月17日)・自己修復の修正の検証
 * ----------------------------------------------------------------------------
 *   本番実測(11/17): 自己修復で始まった毎日の学習が、デプロイの再起動で途中(③-b)で消えた。
 *   実行中の印(90分で切れる)が残ったままなので、次の確認は「印が取れない」で終わり、印が切れるまで学習が始まらなかった。
 *   従来の「止まっている学習の拾い直し」は、最後の完走が新しい(26時間未満)ときしか通らない分岐にあり、この場合を拾えなかった。
 *   v102: 「最後の完走から26時間以上」の経路でも、印が取れず・進捗が未完了のまま35分以上止まっていれば、
 *         落ちた実行の印を片づけて取り直す(1日の回数の上限は従来の拾い直しと共通)。
 *   ここで確かめること:
 *     1. 落ちた実行の印が残っている → 片づけて学習を始める
 *     2. 進捗が動いている(35分未満)→ 動いている学習かもしれないので、印を外さない
 *     3. 進捗の記録が無い・完了になっている・読めない → 印を外さない
 *     4. 1日の回数の上限を超えたら、印を外さない
 *     5. 従来の動き(印が無ければそのまま始める・完走が新しければ始めない)は変わらない
 */
const assert = require("assert");
const path = require("path");
const S_DIR = __dirname;

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockStore() {
  const store = new Map(); const calls = []; const m = { failGetKeys: new Set() };
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(cmd.slice());
    if (op === "GET" && m.failGetKeys.has(a[0])) { const e = new Error("read failed (test)"); e.code = "TIMEOUT"; throw e; }
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { if (a.includes("NX") && store.has(a[0])) return null; store.set(a[0], a[1]); return "OK"; }
    if (op === "DEL") { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "HGETALL") return [];
    if (op === "LRANGE") return [];
    if (op === "LLEN") return 0;
    if (op === "EXPIRE" || op === "PEXPIRE") return 1;
    return null;
  }
  const upstashGetJSON = async (k) => { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  return { store, calls, m, upstashCmd, upstashGetJSON, upstashSetJSON };
}

(async () => {
  process.env.PORT = String(43000 + Math.floor(Math.random() * 1500));
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.API_FOOTBALL_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.LINEUP_WATCH = "0";
  process.env.LEARN_SWEEP_CHECK_INTERVAL_MS = "0";
  process.env.STORE_QUOTA_STICKY_MS = "0";
  process.env.SELF_HEAL_DAILY_LEARNING = "1";
  delete process.env.LEARN_STALLED_MS; delete process.env.LEARN_SWEEP_STALE_MS; delete process.env.LEARN_STALLED_RETRY_CAP_PER_DAY;
  const srv = require(path.join(S_DIR, "server.js"));
  const S = srv.__storeForTest, V = srv.__v102ForTest;
  const m = mockStore();
  const learnSpy = { calls: 0 };
  srv.__setTestHooks({
    upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON,
    runDailyLearning: async () => { learnSpy.calls++; return { ok: true }; },
    callApiFootball: async () => ({ response: [] }),
  });
  await sleep(300);
  const now = Date.now();
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  const today = jst(now);
  const LOCK = `learn:runlock:${today}`, RETRY = `learn:stalledretry:${today}`;
  const waitIdle = async () => { for (let i = 0; i < 100 && S.isLearningRunning(); i++) await sleep(50); };
  const reset = () => { m.store.clear(); m.calls.length = 0; m.m.failGetKeys.clear(); S.resetForTest(); learnSpy.calls = 0; };
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const MIN = 60000, HOUR = 3600000;
  /** 最後の完走が hoursAgo 時間前・落ちた実行の印あり・進捗が stalledMin 分前で止まっている、という状態を作る */
  const arrange = (o) => {
    reset();
    if (o.lastRunHoursAgo !== null) m.store.set("learn:growthlog:latest", JSON.stringify({ date: jst(now - o.lastRunHoursAgo * HOUR), ranAt: iso(o.lastRunHoursAgo * HOUR), runsToday: 1 }));
    if (o.lock !== false) m.store.set(LOCK, "dead-process:123");
    if (o.progress) m.store.set("learn:progress", JSON.stringify(o.progress));
    // 選手の索引は「ある」ことにする(索引の修復を走らせない)
    m.store.set("kb:player:index:meta", JSON.stringify({ count: 10, builtAt: iso(HOUR) }));
  };
  const deadProgress = (stalledMin) => ({ date: today, finished: false, stage: "③-b TOP100クラブの収集(選手索引もここ)", stageIndex: 10, startedAt: iso((stalledMin + 5) * MIN), at: iso(stalledMin * MIN) });

  console.log("■ 前提");
  await t("止まったとみなす時間は35分・「古い」とみなすのは26時間(既定)", () => {
    assert.strictEqual(V.LEARN_STALLED_MS, 35 * 60 * 1000); assert.strictEqual(V.LEARN_SWEEP_STALE_MS, 26 * 60 * 60 * 1000);
    assert.strictEqual(typeof V.stalledRetryAllowed, "function");
  });

  console.log("■ 1. 落ちた実行の印が残っている");
  await t("最後の完走から27時間・印あり・進捗は③-bで40分止まっている → 印を片づけて学習を始める(回数を1回数える)", async () => {
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(40) });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 1, "学習が始まらなかった(印が切れるまで待ってしまう)");
    assert.strictEqual(m.store.get(RETRY), "1");
    assert.ok(m.calls.some((c) => c[0] === "DEL" && c[1] === LOCK), "落ちた実行の印を片づけていない");
  });
  await t("11/17 の実測と同じ形(完走から27時間16分・印の残り時間あり・進捗は86分止まっている)でも始まる", async () => {
    arrange({ lastRunHoursAgo: 27.27, progress: deadProgress(86) });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 1);
  });
  await t("完走の記録が1つも無い(初回)+落ちた実行の印+止まった進捗 → 同じく片づけて始める", async () => {
    arrange({ lastRunHoursAgo: null, progress: deadProgress(50) });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 1);
  });

  console.log("■ 2. 動いている学習かもしれないときは、印を外さない");
  await t("進捗が34分前に更新されている → 始めない・印もそのまま・回数も数えない", async () => {
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(34) });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123"); assert.strictEqual(m.store.has(RETRY), false);
    assert.ok(!m.calls.some((c) => c[0] === "DEL" && c[1] === LOCK));
  });
  await t("進捗が1分前(心拍が打たれている)→ 始めない", async () => {
    arrange({ lastRunHoursAgo: 30, progress: { ...deadProgress(1), detail: "過去試合の取得 40件め" } });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123");
  });

  console.log("■ 3. 進捗から「落ちた」と言えないときは、印を外さない");
  await t("進捗の記録が無い → 始めない(印の寿命に任せる)", async () => {
    arrange({ lastRunHoursAgo: 27, progress: null });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123"); assert.strictEqual(m.store.has(RETRY), false);
  });
  await t("進捗が「完了」になっている・時刻が無い・時刻が壊れている → 始めない", async () => {
    for (const progress of [{ ...deadProgress(90), finished: true }, { date: today, finished: false, stage: "x" }, { date: today, finished: false, at: "not-a-date" }]) {
      arrange({ lastRunHoursAgo: 27, progress });
      await S.maybeSelfHealDailyLearning();
      await waitIdle(); await sleep(100);
      assert.strictEqual(learnSpy.calls, 0, JSON.stringify(progress)); assert.strictEqual(m.store.get(LOCK), "dead-process:123");
    }
  });
  await t("進捗を読めなかった(保存先の一時的な失敗)→ 始めない・印も外さない", async () => {
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(60) });
    m.m.failGetKeys.add("learn:progress");
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123");
  });

  console.log("■ 4. 1日の回数の上限");
  await t("今日すでに上限(2回)まで拾い直している → 3回めは印を外さない(壊れていて何度やっても完走しない場合の暴走防止)", async () => {
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(60) });
    m.store.set(RETRY, "2");
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123"); assert.strictEqual(m.store.get(RETRY), "3");
    // 1回めの残りがあるうちは始まる
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(60) });
    m.store.set(RETRY, "1");
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 1); assert.strictEqual(m.store.get(RETRY), "2");
  });

  console.log("■ 5. 従来の動きは変わらない");
  await t("最後の完走から27時間・印なし → そのまま始める(回数は数えない)", async () => {
    arrange({ lastRunHoursAgo: 27, lock: false, progress: deadProgress(90) });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 1); assert.strictEqual(m.store.has(RETRY), false);
  });
  await t("最後の完走から5時間(新しい)・進捗も完了 → 始めない", async () => {
    arrange({ lastRunHoursAgo: 5, lock: false, progress: { date: today, finished: true, at: iso(5 * HOUR), startedAt: iso(5.5 * HOUR) } });
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0);
  });
  await t("保存先が止まっているあいだは何もしない(v94 の動きのまま)", async () => {
    arrange({ lastRunHoursAgo: 27, progress: deadProgress(60) });
    m.m.failGetKeys.add("learn:growthlog:latest");
    await S.maybeSelfHealDailyLearning();
    await waitIdle(); await sleep(150);
    assert.strictEqual(learnSpy.calls, 0); assert.strictEqual(m.store.get(LOCK), "dead-process:123");
    assert.ok(/^read_failed/.test(S.selfHealSkipped().lastReason || ""), JSON.stringify(S.selfHealSkipped()));
  });

  console.log("■ 6. 健康診断(予測モデルの項目)");
  const { buildEngineStatuses } = require(path.join(S_DIR, "learning", "healthCheck.js"));
  const predOf = (growthLog) => buildEngineStatuses({ growthLog, runHistory: { available: true, days: [] }, upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true, engineTotals: {} }).find((e) => e.id === "prediction");
  await t("過去試合の交差検証で重みを採用した日は「更新していません」と言わない(④ の関門が通らなくても、重みは更新されている)", () => {
    const base = { date: today, ranAt: iso(HOUR), totalOwnPredictionsResolvedSoFar: 1601, minResolvedForRecalibration: 10 };
    const corpus = predOf({ ...base, weightsUpdated: false, weightsUpdatedV2: false, modelTuning: { adopted: true }, weightsHistoryNoteJa: "交差検証(5分割・記録1601件)で、どの手続きの候補も関門を通らなかったため、重みは変更しませんでした。" });
    assert.strictEqual(corpus.messageJa, "本日、過去試合の検証に基づいて重みを更新しました。"); assert.strictEqual(corpus.status, "ok");
    const own = predOf({ ...base, weightsUpdated: true, modelTuning: { adopted: true } });
    assert.strictEqual(own.messageJa, "本日、実データに基づいて重みを更新しました。");
    const none = predOf({ ...base, weightsUpdated: false, modelTuning: { adopted: false }, weightsHistoryNoteJa: "理由X。" });
    assert.strictEqual(none.messageJa, "検証済み1601件。本日は重みを更新していません。理由: 理由X。");
    const noTuning = predOf({ ...base, weightsUpdated: false, weightsHistoryNoteJa: null });
    assert.ok(/本日は重みを更新していません\(その理由は学習履歴に記録されています\)。$/.test(noTuning.messageJa), noTuning.messageJa);
  });
  await t("「更新していない理由」は、今日の記録のうち「更新しなかった」ものから取る(同じ日に後ろへ入った別の採用の説明を、理由として出さない)", async () => {
    const src = require("fs").readFileSync(path.join(S_DIR, "server.js"), "utf8");
    // 読み出しは直近6件・新しい順に「今日・更新しなかった・理由あり」の最初の1件
    assert.ok(src.includes('const hist = (await upstashCmd(["LRANGE", "learn:weights:history", "-6", "-1"])) || [];'));
    assert.ok(src.includes("if (entry && entry.date === todayDateKey && entry.adopted === false && entry.note) { growthLog.weightsHistoryNoteJa = entry.note; break; }"));
    // 実際に健康診断の入口を叩いて確かめる(保存先は模擬)
    reset();
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: today, ranAt: iso(30 * MIN), runsToday: 1, weightsUpdated: false, totalOwnPredictionsResolvedSoFar: 1601, minResolvedForRecalibration: 10, engineTotals: {} }));
    m.store.set(`learn:growthlog:${today}`, m.store.get("learn:growthlog:latest"));
    m.store.set("learn:ownpred:resolved", "1601"); m.store.set("learn:ownpred:correct", "880"); // 答え合わせ済みの件数(健康診断はこの数え方を読む)
    const hist = [
      { date: jst(now - 86400000), adopted: false, method: "cv_validated", note: "きのうの理由。" },
      { date: today, adopted: false, method: "cv_validated", note: "きょうの本当の理由。" },
      { date: today, adopted: true, method: "market_blend", note: "検証1005件でブレンド(市場85%+AI15%)がNLL 0.98→0.95へ改善したため採用しました。" },
    ].map((x) => JSON.stringify(x));
    const origCmd = m.upstashCmd;
    // この模擬の LRANGE は空を返す作りなので、重みの変更履歴だけ中身を返す
    srv.__setTestHooks({ upstashCmd: async (c) => (c[0] === "LRANGE" && c[1] === "learn:weights:history" ? hist.slice(Number(c[2])) : origCmd(c)) });
    const http = require("http");
    const body = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: Number(process.env.PORT), path: "/api/learning/health?days=3" }, (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } }); }).on("error", reject);
    });
    srv.__setTestHooks({ upstashCmd: origCmd });
    const pred = (body.engines || []).find((e) => e.id === "prediction");
    assert.ok(pred, "予測モデルの項目が無い: " + JSON.stringify(Object.keys(body)).slice(0, 200));
    assert.ok(pred.messageJa.includes("理由: きょうの本当の理由。"), pred.messageJa);
    assert.ok(!/ブレンド/.test(pred.messageJa) && !/きのう/.test(pred.messageJa), pred.messageJa);
  });

  console.log("■ 7. 回答AIの失敗(残高切れ)が、記録と健康診断から読める(本番実測 11/17)");
  const dj = require(path.join(S_DIR, "learning", "dailyJob.js"));
  const hc = require(path.join(S_DIR, "learning", "healthCheck.js"));
  const creditErr = Object.assign(new Error('Anthropic API HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), { code: "HTTP_ERROR", httpStatus: 400, bodyText: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}' });
  await t("失敗の記録に、状態コードと原因の種類が残る(鍵や本文は残さない)。HTTP 以外の失敗の書き方は従来のまま", () => {
    assert.strictEqual(dj.llmErrorTag(creditErr), "HTTP_ERROR(http=400・credit_balance_too_low)");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("Anthropic API HTTP 401: invalid x-api-key"), { code: "HTTP_ERROR", httpStatus: 401 })), "HTTP_ERROR(http=401・invalid_api_key)");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("Anthropic API HTTP 429: slow down"), { code: "HTTP_ERROR", httpStatus: 429 })), "HTTP_ERROR(http=429・rate_limited)");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("Anthropic API HTTP 529: overloaded"), { code: "HTTP_ERROR", httpStatus: 529 })), "HTTP_ERROR(http=529・overloaded)");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("Anthropic API HTTP 500: oops"), { code: "HTTP_ERROR", httpStatus: 500 })), "HTTP_ERROR(http=500)");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("x"), { code: "HTTP_ERROR" })), "HTTP_ERROR");
    // 従来のまま
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("t"), { code: "TIMEOUT" })), "TIMEOUT");
    assert.strictEqual(dj.llmErrorTag(Object.assign(new Error("empty (stop_reason=max_tokens, blocks=thinking)"), { code: "EMPTY_RESPONSE", retriedAfterEmpty: true })), "EMPTY_RESPONSE(stop_reason=max_tokens, blocks=thinking・再試行も空)");
    assert.strictEqual(dj.llmErrorTag(new Error("LLM出力がJSON形式ではありませんでした")), "LLM出力がJSON形式ではありませんでした");
    // 本文(利用者の鍵が混ざり得る)は記録に入れない
    const withKey = Object.assign(new Error("Anthropic API HTTP 400: sk-ant-SECRETKEY123 credit balance is too low"), { code: "HTTP_ERROR", httpStatus: 400, bodyText: "sk-ant-SECRETKEY123" });
    assert.ok(!/sk-ant|SECRET/.test(dj.llmErrorTag(withKey)), dj.llmErrorTag(withKey));
  });
  await t("失敗の分類: 残高切れは「回答AIの利用料の残高が不足しています」(影響あり・直し方つき)。ほかの見解の失敗も「提供元からの取得が失敗」に混ぜない", () => {
    const errs = ["daily_view_failed:Arsenal:" + dj.llmErrorTag(creditErr), "daily_view_failed:Chelsea:" + dj.llmErrorTag(creditErr), "daily_view_failed:Barcelona:EMPTY_RESPONSE(stop_reason=max_tokens)", "daily_view_failed:Milan:HTTP_ERROR", "standings_failed:39:HTTP_ERROR"];
    const c = hc.classifyLearnErrors(errs);
    const g = (id) => c.groups.find((x) => x.id === id);
    assert.strictEqual(g("llmCredit").items.length, 2); assert.strictEqual(g("llmCredit").level, "impact");
    assert.ok(/残高を追加すると、追加の操作なしで戻ります/.test(g("llmCredit").effectJa) && /データ提供元の失敗ではありません/.test(g("llmCredit").meaningJa));
    assert.strictEqual(g("dailyViewLlm").items.length, 2, "残高切れ以外の見解の失敗"); assert.strictEqual(g("dailyViewLlm").level, "minor");
    assert.deepStrictEqual(g("fetchFailed").items, ["standings_failed:39:HTTP_ERROR"], "データ提供元の失敗だけが「取得に失敗」に入る");
    // 規則の順番: 回答AIの規則が、受け皿(fetchFailed)より前にある
    const ids = hc.LEARN_ERROR_RULES.map((r) => r.id);
    assert.ok(ids.indexOf("llmCredit") < ids.indexOf("dailyViewLlm") && ids.indexOf("dailyViewLlm") < ids.indexOf("fetchFailed"), ids.join(","));
  });
  await t("健康診断の「LLM」: 鍵が設定されているだけで正常と言わない。残高切れ=エラー・鍵が無効=エラー・見解が全滅=注意・問題なし=正常・未設定=注意", () => {
    const base = { date: today, ranAt: iso(HOUR), totalOwnPredictionsResolvedSoFar: 1834, minResolvedForRecalibration: 10 };
    const llmOf = (growthLog, llmConfigured) => hc.buildEngineStatuses({ growthLog, runHistory: { available: true, days: [] }, upstashEnabled: true, apiKeyConfigured: true, llmConfigured: llmConfigured !== false, engineTotals: {} }).find((e) => e.id === "llm");
    const credit = llmOf({ ...base, errors: Array.from({ length: 11 }, (_, i) => `daily_view_failed:Club${i}:HTTP_ERROR(http=400・credit_balance_too_low)`).concat(["odds_failed:x"]) });
    assert.strictEqual(credit.status, "error"); assert.ok(/残高が不足しています/.test(credit.messageJa) && /11件/.test(credit.messageJa), credit.messageJa);
    assert.ok(/console\.anthropic\.com/.test(credit.actionJa) && /再デプロイをしなくても戻ります/.test(credit.actionJa));
    const badKey = llmOf({ ...base, errors: ["daily_view_failed:A:HTTP_ERROR(http=401・invalid_api_key)"] });
    assert.strictEqual(badKey.status, "error"); assert.ok(/ANTHROPIC_API_KEY/.test(badKey.actionJa));
    const allFailed = llmOf({ ...base, aiViewsChanged: 0, aiViewsUnchanged: 0, errors: ["daily_view_failed:A:HTTP_ERROR(http=500)", "daily_view_failed:B:TIMEOUT", "daily_view_failed:C:HTTP_ERROR"] });
    assert.strictEqual(allFailed.status, "warn"); assert.ok(/3件すべて失敗/.test(allFailed.messageJa) && /\/api\/diag\/llm/.test(allFailed.actionJa));
    // 一部だけ失敗(ほかは作れている)→ 正常のまま(個別の失敗は「失敗の分類」に出る)
    const partial = llmOf({ ...base, aiViewsChanged: 6, aiViewsUnchanged: 2, errors: ["daily_view_failed:A:TIMEOUT", "daily_view_failed:B:TIMEOUT", "daily_view_failed:C:TIMEOUT"] });
    assert.strictEqual(partial.status, "ok"); assert.strictEqual(partial.messageJa, "APIキーが設定されています。");
    assert.strictEqual(llmOf({ ...base, errors: [] }).status, "ok"); assert.strictEqual(llmOf({ ...base }).status, "ok");
    const off = llmOf({ ...base, errors: ["daily_view_failed:A:HTTP_ERROR(http=400・credit_balance_too_low)"] }, false);
    assert.strictEqual(off.status, "warn"); assert.ok(/未設定です/.test(off.messageJa));
  });

  await new Promise((r) => srv.server.close(r));
  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
