/**
 * 2026年8月・優先順位⑨(Learning Engine総点検)のテスト。
 * server/learning/healthCheck.js が、「今日追加した知識0件」の
 * 正常な0件(前回から変化なし)と異常な0件(未実行・キー未設定・予算切れ・エラー)を
 * 正しく区別できるかを重点的に検証する。
 */
const assert = require("assert");
const {
  diagnoseZeroKnowledge, diagnoseZeroVerification, getRunHistory, buildEngineStatuses, ZERO_CAUSE,
} = require("../server/learning/healthCheck");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

const codesOf = (d) => d.causes.map((c) => c.code);

(async () => {
  // ---- 「0件」の理由判定 ----
  await test("正常な0件: 確認はしたが前回から変化が無かった場合、healthy=trueと判定する", () => {
    const d = diagnoseZeroKnowledge({
      date: "2026-08-05", ranAt: "2026-08-05T09:00:00Z",
      knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 21, errors: [],
    });
    assert.strictEqual(d.isZero, true);
    assert.strictEqual(d.healthy, true, "これは正常な0件のはず");
    assert.deepStrictEqual(codesOf(d), [ZERO_CAUSE.HEALTHY_NO_CHANGE]);
    assert.ok(d.causes[0].titleJa.includes("21"), "実際に確認した件数が根拠として示されるはず: " + d.causes[0].titleJa);
    assert.strictEqual(d.causes[0].severity, "ok");
  });

  await test("異常な0件: まだ一度も実行されていない場合はerrorとGitHub Actionsの確認を促す", () => {
    const d = diagnoseZeroKnowledge({ ranYet: false });
    assert.strictEqual(d.healthy, false);
    assert.deepStrictEqual(codesOf(d), [ZERO_CAUSE.NOT_RUN_YET]);
    assert.ok(d.causes[0].detailJa.includes("GitHub Actions"), d.causes[0].detailJa);
  });

  await test("異常な0件: Upstash未設定はerrorとして、設定すべき環境変数名まで示す", () => {
    const d = diagnoseZeroKnowledge({ date: "2026-08-05", ranAt: "x", reason: "NO_UPSTASH" });
    assert.strictEqual(d.healthy, false);
    assert.deepStrictEqual(codesOf(d), [ZERO_CAUSE.NO_UPSTASH]);
    assert.ok(d.causes[0].detailJa.includes("UPSTASH_REDIS_REST_URL"), d.causes[0].detailJa);
  });

  await test("異常な0件: NO_KEYエラーが並んでいる場合は、キー未設定として件数つきで指摘する", () => {
    const d = diagnoseZeroKnowledge({
      date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 0,
      errors: ["daily_view_failed:Bayern Munich:NO_KEY", "daily_view_failed:Arsenal:NO_KEY"],
    });
    assert.strictEqual(d.healthy, false);
    assert.ok(codesOf(d).includes(ZERO_CAUSE.NO_API_KEY));
    assert.ok(d.causes[0].titleJa.includes("2件"), d.causes[0].titleJa);
  });

  await test("API予算切れは警告として検出され、解決方法(API_DAILY_BUDGET)まで示す", () => {
    const d = diagnoseZeroKnowledge({
      date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 0, errors: [],
      apiBudget: { dailyBudget: 100, userReserve: 20, totalSpent: 80, remainingForJob: 0 },
    });
    assert.ok(codesOf(d).includes(ZERO_CAUSE.BUDGET_EXHAUSTED));
    const c = d.causes.find((x) => x.code === ZERO_CAUSE.BUDGET_EXHAUSTED);
    assert.strictEqual(c.severity, "warn");
    assert.ok(c.detailJa.includes("API_DAILY_BUDGET"), c.detailJa);
  });

  await test("予算に余裕がある場合は、予算切れとして誤検出しない", () => {
    const d = diagnoseZeroKnowledge({
      date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 5, errors: [],
      apiBudget: { dailyBudget: 100, userReserve: 20, totalSpent: 22, remainingForJob: 58 },
    });
    assert.ok(!codesOf(d).includes(ZERO_CAUSE.BUDGET_EXHAUSTED));
    assert.strictEqual(d.healthy, true);
  });

  await test("一般的なエラーがある場合は、代表的なエラー内容まで示す", () => {
    const d = diagnoseZeroKnowledge({
      date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 0,
      errors: ["league_standings_failed:Premier League:HTTP_ERROR"],
    });
    assert.ok(codesOf(d).includes(ZERO_CAUSE.ERRORS));
    assert.ok(d.causes[0].detailJa.includes("Premier League"), d.causes[0].detailJa);
  });

  await test("知識が実際に増えている日は isZero=false になる", () => {
    const d = diagnoseZeroKnowledge({ date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 14, knowledgeItemsDuplicateToday: 3, errors: [] });
    assert.strictEqual(d.isZero, false);
  });

  await test("エラーも重複も0件で説明がつかない場合は、正直に「特定できない」と返す(健全だと嘘をつかない)", () => {
    const d = diagnoseZeroKnowledge({ date: "2026-08-05", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 0, errors: [] });
    assert.deepStrictEqual(codesOf(d), [ZERO_CAUSE.UNKNOWN]);
    assert.strictEqual(d.healthy, false);
  });

  // ---- 「検証した試合0件」の理由判定 ----
  await test("検証0件でも、今日新しく予測を記録していれば正常(試合が終わってから検証する設計)", () => {
    const d = diagnoseZeroVerification({ matchesResolvedToday: 0, newPredictionsLogged: 6 });
    assert.strictEqual(d.isZero, true);
    assert.strictEqual(d.healthy, true);
    assert.ok(d.titleJa.includes("6件"), d.titleJa);
    assert.ok(d.detailJa.includes("後出し"), "後出しで予測を書き換えない設計であることを説明するはず");
  });

  await test("検証0件・新規予測0件でも、累計検証実績があれば正常(試合が無い日)", () => {
    const d = diagnoseZeroVerification({ matchesResolvedToday: 0, newPredictionsLogged: 0, totalOwnPredictionsResolvedSoFar: 42 });
    assert.strictEqual(d.healthy, true);
    assert.ok(d.titleJa.includes("42"), d.titleJa);
  });

  await test("一度も検証できていない場合は異常として扱う", () => {
    const d = diagnoseZeroVerification({ matchesResolvedToday: 0, newPredictionsLogged: 0, totalOwnPredictionsResolvedSoFar: 0 });
    assert.strictEqual(d.healthy, false);
  });

  await test("検証できている日は isZero=false", () => {
    const d = diagnoseZeroVerification({ matchesResolvedToday: 3 });
    assert.strictEqual(d.isZero, false);
    assert.strictEqual(d.healthy, true);
  });

  // ---- 実行履歴(「毎日動いている」ことの実証) ----
  await test("getRunHistory: 実行があった日と無かった日を実データで区別する(推測で埋めない)", async () => {
    const store = new Map();
    store.set("learn:growthlog:2026-08-05", { knowledgeItemsSavedToday: 5, knowledgeItemsDuplicateToday: 2, matchesResolvedToday: 1, errors: [], runsToday: 1 });
    store.set("learn:growthlog:2026-08-04", { knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 9, matchesResolvedToday: 0, errors: ["x"], runsToday: 2 });
    const deps = { upstashEnabled: true, upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null) };
    const h = await getRunHistory(deps, 3, "2026-08-05");
    assert.strictEqual(h.available, true);
    assert.strictEqual(h.days.length, 3);
    assert.strictEqual(h.days[0].date, "2026-08-05");
    assert.strictEqual(h.days[0].ran, true);
    assert.strictEqual(h.days[0].knowledgeItemsSavedToday, 5);
    assert.strictEqual(h.days[1].date, "2026-08-04");
    assert.strictEqual(h.days[1].errorCount, 1);
    assert.strictEqual(h.days[2].date, "2026-08-03");
    assert.strictEqual(h.days[2].ran, false, "記録が無い日は正直にran:falseのはず");
    assert.strictEqual(h.ranDays, 2);
    // 8/3が最古の実行記録なので、8/3より前(8/3の1日ぶんだけ遡る範囲)は運用開始前として対象外
    assert.strictEqual(h.trackedDays, 2, "運用開始以降の2日だけを対象にするはず");
    assert.deepStrictEqual(h.missingDays, [], "運用開始以降に欠けている日は無いはず");
    assert.strictEqual(h.days[2].beforeStart, true, "運用開始前の日は beforeStart で明示するはず");
  });

  await test("getRunHistory: 運用開始前の期間を「動いていない日」として誤検出しない(本番で出た誤警告の修正)", async () => {
    // 本番の実例: 8/2から運用開始。それ以前は API キーすら無く実行しようがなかった。
    const store = new Map();
    for (const d of ["2026-08-04", "2026-08-03", "2026-08-02"]) {
      store.set(`learn:growthlog:${d}`, { knowledgeItemsSavedToday: 1, errors: [] });
    }
    const deps = { upstashEnabled: true, upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null) };
    const h = await getRunHistory(deps, 14, "2026-08-04");
    assert.strictEqual(h.trackedDays, 3, "運用開始以降は3日だけのはず");
    assert.deepStrictEqual(h.missingDays, [], "その3日はすべて実行済みなので欠落なしのはず");
    assert.ok(h.everyDayJa.includes("毎日欠かさず"), "誤って警告せず、毎日動いていると言い切るはず: " + h.everyDayJa);
    assert.ok(h.everyDayJa.includes("運用開始前"), "対象外にした日があることは正直に明示するはず: " + h.everyDayJa);
  });

  await test("運用開始以降に本当に欠けている日があれば、その日付を挙げて警告する", async () => {
    const store = new Map();
    for (const d of ["2026-08-04", "2026-08-02"]) store.set(`learn:growthlog:${d}`, { errors: [] });
    const deps = { upstashEnabled: true, upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null) };
    const h = await getRunHistory(deps, 14, "2026-08-04");
    assert.deepStrictEqual(h.missingDays, ["2026-08-03"], "実際に欠けている日だけを挙げるはず");
    assert.ok(h.everyDayJa.includes("2026-08-03"), "どの日が欠けたか具体的に示すはず: " + h.everyDayJa);
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x" }, runHistory: h,
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
    });
    assert.strictEqual(s.find((x) => x.id === "githubActions").status, "warn");
  });

  await test("getRunHistory: 毎日実行されていれば「毎日欠かさず実行されています」と言い切る", async () => {
    const deps = { upstashEnabled: true, upstashGetJSON: async () => ({ knowledgeItemsSavedToday: 1, errors: [] }) };
    const h = await getRunHistory(deps, 7, "2026-08-05");
    assert.strictEqual(h.ranDays, 7);
    assert.deepStrictEqual(h.missingDays, []);
    assert.ok(h.everyDayJa.includes("毎日欠かさず"), h.everyDayJa);
  });

  await test("getRunHistory: Upstash未設定なら、実行履歴を読めないことを正直に返す", async () => {
    const h = await getRunHistory({ upstashEnabled: false }, 14, "2026-08-05");
    assert.strictEqual(h.available, false);
    assert.ok(h.reasonJa.includes("Upstash"), h.reasonJa);
    assert.deepStrictEqual(h.days, []);
  });

  // ---- 9つの構成要素の状態判定 ----
  await test("buildEngineStatuses: ご要望の構成要素を漏れなく点検する", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "2026-08-05", ranAt: "x", teamsAnalyzed: 11, knowledgeItemsSavedToday: 5, engineTotals: { knowledgeItemsTotal: 100, memoryConclusionsTotal: 10 } },
      runHistory: { available: true, ranDays: 14, totalDays: 14, everyDayJa: "直近14日間、毎日欠かさず実行されています。" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
    });
    const ids = s.map((x) => x.id);
    for (const id of ["githubActions", "render", "upstash", "apiFootball", "llm", "learning", "knowledge", "prediction", "memory", "hypothesis"]) {
      assert.ok(ids.includes(id), `${id} が点検対象に含まれるはず`);
    }
    assert.ok(s.every((x) => x.messageJa && x.messageJa.length > 5), "すべての項目に説明があるはず");
  });

  await test("buildEngineStatuses: Upstash/APIキー未設定は error として、対処法つきで報告する", () => {
    const s = buildEngineStatuses({
      growthLog: { ranYet: false }, runHistory: { available: false, reasonJa: "x" },
      upstashEnabled: false, apiKeyConfigured: false, llmConfigured: false,
    });
    const upstash = s.find((x) => x.id === "upstash");
    assert.strictEqual(upstash.status, "error");
    assert.ok(upstash.actionJa.includes("UPSTASH_REDIS_REST_URL"), upstash.actionJa);
    const api = s.find((x) => x.id === "apiFootball");
    assert.strictEqual(api.status, "error");
    assert.ok(api.actionJa.includes("API_FOOTBALL_KEY"), api.actionJa);
    const llm = s.find((x) => x.id === "llm");
    assert.strictEqual(llm.status, "warn", "LLM未設定は致命的ではない(実データ蓄積は続く)ので警告どまりのはず");
  });

  await test("buildEngineStatuses: 新規0件でも重複確認できていればKnowledge Engineは正常と判定する", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x", knowledgeItemsSavedToday: 0, knowledgeItemsDuplicateToday: 21, engineTotals: { knowledgeItemsTotal: 300 } },
      runHistory: { available: true, ranDays: 14, totalDays: 14, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
    });
    const k = s.find((x) => x.id === "knowledge");
    assert.strictEqual(k.status, "ok", "確認したうえで変化なしなら正常のはず");
    assert.ok(k.messageJa.includes("21件"), k.messageJa);
  });

  await test("buildEngineStatuses: 実行記録が1日も無ければGitHub Actionsをerrorとして報告する", () => {
    const s = buildEngineStatuses({
      growthLog: { ranYet: false },
      runHistory: { available: true, ranDays: 0, totalDays: 14, everyDayJa: "直近14日間のうち0日で実行されています(14日は実行記録がありません)。" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
    });
    const g = s.find((x) => x.id === "githubActions");
    assert.strictEqual(g.status, "error");
    assert.ok(g.actionJa.includes("daily-learning.yml"), g.actionJa);
  });

  await test("buildEngineStatuses: 検証件数が閾値未満のPrediction Engineは、故障ではなく意図的な固定として説明する", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x", totalOwnPredictionsResolvedSoFar: 3, minResolvedForRecalibration: 10, weightsUpdated: false },
      runHistory: { available: true, ranDays: 1, totalDays: 1, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
    });
    const p = s.find((x) => x.id === "prediction");
    assert.strictEqual(p.status, "ok", "データ待ちは異常ではない");
    assert.ok(p.messageJa.includes("過学習"), p.messageJa);
  });

  // ---- 契約プランの状態判定(優先順位⑪の安全網) ----
  await test("契約プラン: Proとして判定できていれば ok として残量まで示す", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x" }, runHistory: { available: true, ranDays: 1, totalDays: 1, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
      apiPlan: { detectedDailyLimit: 7500, detectedRemaining: 6699, planNameJa: "Pro($19/月)" },
      configuredCaps: { playerUpdateCap: 107, extendedLeagueCap: 5 },
    });
    const p = s.find((x) => x.id === "apiPlan");
    assert.strictEqual(p.status, "ok");
    assert.ok(p.messageJa.includes("Pro"), p.messageJa);
    assert.ok(p.messageJa.includes("6699"), "本日の残りも示すはず: " + p.messageJa);
    assert.ok(p.actionJa.includes("自動更新されない"), "自動更新されない仕様を必ず伝えるはず");
  });

  await test("契約プラン: 有料向け設定のまま無料へ戻っていたら error として「期限切れの可能性」を示す", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x" }, runHistory: { available: true, ranDays: 1, totalDays: 1, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
      apiPlan: { detectedDailyLimit: 100, detectedRemaining: 3, planNameJa: "Free(無料)" },
      configuredCaps: { playerUpdateCap: 107, extendedLeagueCap: 5 },
    });
    const p = s.find((x) => x.id === "apiPlan");
    assert.strictEqual(p.status, "error", "原因不明の不調ではなく、契約切れとしてはっきり示すはず");
    assert.ok(p.messageJa.includes("期限が切れて"), p.messageJa);
    assert.ok(p.actionJa.includes("再契約"), p.actionJa);
  });

  await test("契約プラン: 無料プランかつ無料向け設定なら、誤って警告を出さない", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x" }, runHistory: { available: true, ranDays: 1, totalDays: 1, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
      apiPlan: { detectedDailyLimit: 100, detectedRemaining: 50, planNameJa: "Free(無料)" },
      configuredCaps: { playerUpdateCap: 3, extendedLeagueCap: 2 },
    });
    assert.strictEqual(s.find((x) => x.id === "apiPlan").status, "ok", "無料プランのまま無料向け設定なら正常のはず");
  });

  await test("契約プラン: まだ判定できていない場合は unknown として正直に返す", () => {
    const s = buildEngineStatuses({
      growthLog: { date: "x", ranAt: "x" }, runHistory: { available: true, ranDays: 1, totalDays: 1, everyDayJa: "" },
      upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true,
      apiPlan: { detectedDailyLimit: null, noteJa: "まだAPI-Footballを1度も呼べていないため、契約プランを自動判定できていません。" },
    });
    const p = s.find((x) => x.id === "apiPlan");
    assert.strictEqual(p.status, "unknown");
    assert.ok(p.messageJa.includes("自動判定できていません"), p.messageJa);
  });

  console.log(failures === 0 ? "\nAll health-check (優先順位⑨) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
