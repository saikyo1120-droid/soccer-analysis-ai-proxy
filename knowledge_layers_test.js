/**
 * Knowledge Engine 4層構造(Layer2固定知識・Layer3 AIの見解・Layer4振り返り)
 * および Prediction Engine v2(拡張特徴量・勾配降下法による重み学習)の
 * ユニット/統合テスト。実際のUpstash Redis / Anthropic APIの代わりに、
 * 既存テスト(learning_daily_job_test.js)と同じインメモリRedisモックと、
 * 固定応答を返すgenerateLLMモックを使う。
 */
const assert = require("assert");
const { runDailyLearning, REGISTERED_TEAMS, buildReflectionText } = require("../server/learning/dailyJob");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");
const { createClubProfileEngine } = require("../server/knowledge/clubProfileEngine");
const features = require("../server/learning/features");
const model = require("../server/learning/predictionModel");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "INCR") { const cur = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(cur + 1)); return cur + 1; }
    if (op === "RPUSH") { const [key, val] = args; const list = store.get(key) || []; list.push(val); store.set(key, list); return list.length; }
    if (op === "LRANGE") {
      const [key, startS, endS] = args; const list = store.get(key) || [];
      let start = parseInt(startS, 10), end = parseInt(endS, 10);
      if (start < 0) start = Math.max(0, list.length + start);
      if (end < 0) end = list.length + end;
      return list.slice(start, end + 1);
    }
    if (op === "LREM") { const [key, , val] = args; const list = store.get(key) || []; store.set(key, list.filter((v) => v !== val)); return 1; }
    if (op === "LTRIM") {
      const [key, startS, endS] = args; const list = store.get(key) || [];
      let start = parseInt(startS, 10), end = parseInt(endS, 10);
      if (start < 0) start = Math.max(0, list.length + start);
      if (end < 0) end = list.length + end;
      store.set(key, list.slice(start, end + 1)); return "OK";
    }
    throw new Error("mock does not implement: " + op);
  }
  async function upstashGetJSON(key) { const raw = await upstashCmd(["GET", key]); return raw === null || raw === undefined ? null : JSON.parse(raw); }
  async function upstashSetJSON(key, value) { await upstashCmd(["SET", key, JSON.stringify(value)]); return true; }
  return { upstashCmd, upstashGetJSON, upstashSetJSON, store };
}

let fakeTeamIdCounter = 1000;
const teamIdByName = new Map();
function makeTeamId(nameEn) { if (!teamIdByName.has(nameEn)) teamIdByName.set(nameEn, fakeTeamIdCounter++); return teamIdByName.get(nameEn); }
async function resolveTeamId(nameEn) { return makeTeamId(nameEn); }

function makeFixtureList(teamId, n, dateBase, homeGoals, awayGoals) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      fixture: { id: 5000 + teamId * 100 + i, date: new Date(dateBase - i * 86400e3).toISOString(), status: { short: "FT" } },
      league: { id: 39 },
      teams: { home: { id: teamId, name: "T" + teamId }, away: { id: 9999, name: "Opponent" } },
      goals: { home: homeGoals ?? 2, away: awayGoals ?? 1 },
    });
  }
  return list;
}

async function baseApiFootball(endpoint, params) {
  if (endpoint === "/fixtures" && params.team && params.last) return { response: makeFixtureList(params.team, params.last, Date.now()) };
  if (endpoint === "/fixtures" && params.team && params.next) {
    const fixtureId = 8000 + params.team;
    return { response: [{ fixture: { id: fixtureId, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } }, league: { id: 39 }, teams: { home: { id: params.team, name: "T" + params.team }, away: { id: 42, name: "RivalFC" } }, goals: { home: null, away: null } }] };
  }
  if (endpoint === "/fixtures" && params.id) return { response: [{ fixture: { id: Number(params.id), status: { short: "NS" } }, goals: { home: null, away: null } }] };
  if (endpoint === "/injuries") return { response: [] };
  if (endpoint === "/standings") return { response: [] };
  if (endpoint === "/fixtures/headtohead") return { response: [] };
  return { response: [] };
}

// generateLLMモック: club profile用(tacticalStyle等のJSON)とdaily view用({view,changeReason})の
// どちらの呼び出しかをsystemPromptの内容で判定して、それらしいJSONを返す。
function makeGenerateLLMMock() {
  let calls = 0;
  return {
    calls: () => calls,
    fn: async ({ systemPrompt, userPrompt }) => {
      calls++;
      if (systemPrompt.includes("戦術傾向")) {
        return { text: JSON.stringify({ tacticalStyle: "ポゼッション重視", formationTendency: "4-3-3", strengths: ["攻撃力"], weaknesses: ["守備の裏"], buildUp: "丁寧な組み立て", pressing: "高い位置から", setPieces: "強み" }) };
      }
      // daily view
      return { text: JSON.stringify({ view: "このクラブは調子が良いと考えます。", changeReason: "直近の得失点差が改善したため" }) };
    },
  };
}

(async () => {
  // ---- Layer2: clubProfileEngine ----
  await test("clubProfileEngine: プロフィールが無い場合はLLMで生成して保存する(AI生成ラベル付き)", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const llmMock = makeGenerateLLMMock();
    const engine = createClubProfileEngine({ generateLLM: llmMock.fn, knowledgeStore });
    const result = await engine.ensureClubProfile("Test FC", "テストFC", ["直近フォームスコア: 1.2"], new Date().toISOString());
    assert.strictEqual(result.generated, true);
    assert.strictEqual(result.saved, true);
    assert.ok(result.profile.isAiGenerated === true, "AI生成であることが明示されているはず");
    assert.ok(result.profile.statement.includes("AIによる推定"), "統計文言に「AIによる推定」の明示があるはず(捏造と誤認させない)");
  });

  await test("clubProfileEngine: 既にプロフィールがあれば再生成しない(コスト節約)", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const llmMock = makeGenerateLLMMock();
    const engine = createClubProfileEngine({ generateLLM: llmMock.fn, knowledgeStore });
    await engine.ensureClubProfile("Test FC", "テストFC", [], new Date().toISOString());
    const callsAfterFirst = llmMock.calls();
    const second = await engine.ensureClubProfile("Test FC", "テストFC", [], new Date().toISOString());
    assert.strictEqual(second.generated, false, "既にプロフィールがある場合は再生成しないはず");
    assert.strictEqual(llmMock.calls(), callsAfterFirst, "LLMは追加で呼ばれていないはず");
  });

  await test("clubProfileEngine: generateLLM未設定なら正直にスキップする(捏造しない)", async () => {
    const mock = createMockRedis();
    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const engine = createClubProfileEngine({ generateLLM: null, knowledgeStore });
    const result = await engine.ensureClubProfile("Test FC", "テストFC", [], new Date().toISOString());
    assert.strictEqual(result.generated, false);
    assert.strictEqual(result.reason, "LLM_NOT_CONFIGURED");
  });

  // ---- Layer2/3: runDailyLearning全体への統合(generateLLMあり/なし) ----
  await test("runDailyLearning: generateLLM未設定ならLayer2/3は正直にスキップされる(llmSkippedReasonsに記録)", async () => {
    const mock = createMockRedis();
    const result = await runDailyLearning({ callApiFootball: baseApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.ok(result.llmSkippedReasons.includes("LLM_NOT_CONFIGURED"));
    assert.strictEqual(result.profilesGenerated, 0);
    assert.strictEqual(result.aiViewsChanged + result.aiViewsUnchanged, 0);
  });

  await test("runDailyLearning: generateLLM設定時はLayer2(プロフィール)とLayer3(AIの見解)が生成される", async () => {
    const mock = createMockRedis();
    const llmMock = makeGenerateLLMMock();
    const result = await runDailyLearning({ callApiFootball: baseApiFootball, resolveTeamId, upstashEnabled: true, ...mock, generateLLM: llmMock.fn, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.ok(result.profilesGenerated > 0, "Layer2のプロフィールが少なくとも1件生成されるはず");
    assert.ok(result.aiViewsChanged + result.aiViewsUnchanged > 0, "Layer3のAIの見解が少なくとも1件生成されるはず");

    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    const teamEn = REGISTERED_TEAMS[0].nameEn;
    // 2026-09-02監査での更新: 学習の固定時刻で保存した知識を実時刻で読むと、失効(fact14日/opinion7日/analysis30日/reflection90日)により日付経過でテストが壊れる時限爆弾だった。読み出しにも同じ基準時刻を渡す。
    const active = await knowledgeStore.getActiveKnowledge(teamEn, new Date("2026-08-01T04:00:00Z").getTime());
    assert.ok(active.profiles.length >= 1, "Knowledge EngineにLayer2(profile)が保存されているはず");
    assert.ok(active.opinions.some((o) => o.category === "dailyAiView"), "Knowledge EngineにLayer3(AIの見解)がミラーされているはず");
  });

  await test("runDailyLearning: 2回目の実行でAIの見解が変わらなければUNCHANGED、Memory Engineに履歴が残る", async () => {
    const mock = createMockRedis();
    const llmMock = makeGenerateLLMMock();
    await runDailyLearning({ callApiFootball: baseApiFootball, resolveTeamId, upstashEnabled: true, ...mock, generateLLM: llmMock.fn, now: () => new Date("2026-08-01T03:00:00Z") });
    const second = await runDailyLearning({ callApiFootball: baseApiFootball, resolveTeamId, upstashEnabled: true, ...mock, generateLLM: llmMock.fn, now: () => new Date("2026-08-02T03:00:00Z") });
    // モックは毎回同じview文言を返すので、2回目はUNCHANGED(変化なし)になるはず。
    assert.ok(second.aiViewsUnchanged > 0, "同じ見解が続く場合はUNCHANGEDとして扱われるはず");
  });

  // ---- Layer4: 振り返り(当たり/外れ両方) ----
  await test("buildReflectionText: 的中した場合も外れた場合も、必ず理由と改善点の文章を返す", () => {
    const correctRecord = { predictedWinner: "home", actualWinner: "home", correct: true, features: { formDiff: 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 } };
    const wrongRecord = { predictedWinner: "home", actualWinner: "away", correct: false, features: { formDiff: 1, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 } };
    const r1 = buildReflectionText(correctRecord, model.EXTENDED_DEFAULT_WEIGHTS);
    const r2 = buildReflectionText(wrongRecord, model.EXTENDED_DEFAULT_WEIGHTS);
    assert.ok(r1.why && r1.improvement, "的中時も理由・改善点の両方が生成されるはず");
    assert.ok(r2.why && r2.improvement, "外れた場合も理由・改善点の両方が生成されるはず(以前は外れた場合に何も記録していなかった)");
    assert.ok(r2.why.includes("実際は"), "外れた場合は実際の結果との違いに言及するはず");
  });

  await test("runDailyLearning: 解決した予測は的中/不的中を問わず必ずKnowledge EngineにLayer4(reflection)を保存する", async () => {
    const mock = createMockRedis();
    // 未解決の予測を1件、手動でセットアップし(次のrunDailyLearning実行で解決させる)、
    // 「不的中」になるようにモックのAPIレスポンスを仕込む。
    const teamEn = REGISTERED_TEAMS[0].nameEn;
    const teamId = makeTeamId(teamEn);
    const fixtureId = 77001;
    const record = {
      fixtureId, homeTeamEn: teamEn, awayTeamEn: "RivalFC",
      homeFormScore: 1, awayFormScore: -1, predictedWinner: "home",
      features: { formDiff: 2, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 },
      weightsSnapshot: model.EXTENDED_DEFAULT_WEIGHTS,
      kickoff: new Date().toISOString(), loggedAt: new Date().toISOString(),
      resolved: false, actualWinner: null, correct: null, resolvedAt: null,
      originTeamEn: teamEn, stateHypothesis: "テスト仮説",
    };
    await mock.upstashSetJSON(`learn:ownpred:${fixtureId}`, record);
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]);

    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id && Number(params.id) === fixtureId) {
        // 実際はaway勝利(予想はhome)=不的中にする
        return { response: [{ fixture: { id: fixtureId, status: { short: "FT" } }, goals: { home: 0, away: 2 } }] };
      }
      return baseApiFootball(endpoint, params);
    };

    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.matchesResolvedToday >= 1, true);
    assert.ok(result.reflectionsSaved >= 1, "不的中の予測でもreflectionsSavedが増えるはず");

    const knowledgeStore = createKnowledgeStore({ upstashEnabled: true, ...mock });
    // 2026-09-02監査での更新: 学習の固定時刻で保存した知識を実時刻で読むと、失効(fact14日/opinion7日/analysis30日/reflection90日)により日付経過でテストが壊れる時限爆弾だった。読み出しにも同じ基準時刻を渡す。
    const active = await knowledgeStore.getActiveKnowledge(teamEn, new Date("2026-08-01T04:00:00Z").getTime());
    const reflection = active.reflections.find((r) => r.detail && r.detail.correct === false);
    assert.ok(reflection, "不的中だった予測についても、Knowledge EngineにLayer4(reflection)が保存されているはず(以前は保存していなかった実際のギャップ)");
    assert.ok(reflection.statement.includes("不的中"), "振り返り文言に不的中であることが明示されているはず");
  });

  // ---- Prediction Engine v2: features.js 純粋関数 ----
  await test("features.computeGoalRateFeatures: 直近試合の平均得点・平均失点を正しく計算する", () => {
    const fixtures = [
      { fixture: {}, teams: { home: { id: 1 }, away: { id: 2 } }, goals: { home: 3, away: 1 } },
      { fixture: {}, teams: { home: { id: 2 }, away: { id: 1 } }, goals: { home: 2, away: 0 } }, // team1がアウェイで0-2負け
    ];
    const r = features.computeGoalRateFeatures(fixtures, 1);
    assert.strictEqual(r.sampleSize, 2);
    assert.strictEqual(r.avgGoalsFor, 1.5); // (3+0)/2
    assert.strictEqual(r.avgGoalsAgainst, 1.5); // (1+2)/2
  });

  await test("features.computeFatigueFeature: 直近7日以内の試合数を正しく数える(過密日程の代理指標)", () => {
    const now = Date.now();
    const fixtures = [
      { fixture: { date: new Date(now - 2 * 86400e3).toISOString() } }, // 2日前(含む)
      { fixture: { date: new Date(now - 6 * 86400e3).toISOString() } }, // 6日前(含む)
      { fixture: { date: new Date(now - 10 * 86400e3).toISOString() } }, // 10日前(含まない)
    ];
    const r = features.computeFatigueFeature(fixtures, now);
    assert.strictEqual(r.matchesLast7Days, 2);
  });

  await test("features.computeStandingsFeature: ネストしたグループ構造からも対象チームを見つけて順位・勝点を返す", () => {
    const standingsResponse = [{ league: { standings: [[{ team: { id: 55 }, rank: 3, points: 40, all: { played: 20, goals: { for: 30, against: 15 } } }]] } }];
    const r = features.computeStandingsFeature(standingsResponse, 55);
    assert.strictEqual(r.position, 3);
    assert.strictEqual(r.points, 40);
    assert.strictEqual(r.goalsForAvg, 1.5);
  });

  await test("features.computeHeadToHeadFeature: 過去対戦成績からチームごとの勝敗数を集計する", () => {
    const h2h = [
      { teams: { home: { id: 10 }, away: { id: 20 } }, goals: { home: 2, away: 0 } }, // 10勝ち
      { teams: { home: { id: 20 }, away: { id: 10 } }, goals: { home: 1, away: 1 } }, // 引き分け
      { teams: { home: { id: 20 }, away: { id: 10 } }, goals: { home: 0, away: 2 } }, // 10勝ち(アウェイでも)
    ];
    const r = features.computeHeadToHeadFeature(h2h, 10, 20);
    assert.strictEqual(r.homeSideWins, 2);
    assert.strictEqual(r.draws, 1);
    assert.strictEqual(r.sampleSize, 3);
  });

  // ---- Prediction Engine v2: predictionModel.js ----
  await test("predictionModel: 新しい特徴量の重みが全て0のとき、v2はv1と完全に同じ予測を返す(安全な後方互換性)", () => {
    const dailyJob = require("../server/learning/dailyJob");
    for (const [hf, af] of [[1.2, 0.3], [0, 0], [-0.8, 1.1]]) {
      const v1 = dailyJob.predictOutcome(hf, af, dailyJob.DEFAULT_WEIGHTS);
      const f = { formDiff: hf - af, goalRateDiff: 0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 };
      const v2 = model.predictOutcomeV2(f, model.EXTENDED_DEFAULT_WEIGHTS);
      assert.strictEqual(v1.predictedWinner, v2.predictedWinner);
      assert.strictEqual(v1.homeLambda, v2.homeLambda);
      assert.strictEqual(v1.awayLambda, v2.awayLambda);
    }
  });

  await test("predictionModel.computeMatchProbabilities: 勝ち/引き分け/負けの確率の合計はほぼ100%になる", () => {
    const p = model.computeMatchProbabilities(1.6, 1.1);
    const sum = p.homeWinPct + p.drawPct + p.awayWinPct;
    assert.ok(Math.abs(sum - 100) < 0.5, `合計は100%に近いはず、実際: ${sum}`);
    assert.ok(p.homeWinPct > p.awayWinPct, "ホーム側のlambdaが高いのでホーム勝率の方が高いはず");
  });

  await test("predictionModel.fitWeightsGradientDescent: 明確に情報のある特徴量の重みを実際に学習し、的中率が改善する", () => {
    const records = [];
    for (let i = 0; i < 15; i++) records.push({ features: { formDiff: 0, goalRateDiff: 1.0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 }, actualWinner: "home" });
    for (let i = 0; i < 15; i++) records.push({ features: { formDiff: 0, goalRateDiff: -1.0, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 }, actualWinner: "away" });
    const before = model.backtestAccuracyV2(records, model.EXTENDED_DEFAULT_WEIGHTS);
    const fitted = model.fitWeightsGradientDescent(records, model.EXTENDED_DEFAULT_WEIGHTS);
    const after = model.backtestAccuracyV2(records, fitted);
    assert.ok(after.accuracy > before.accuracy, `学習後は的中率が改善するはず(前:${before.accuracy} 後:${after.accuracy})`);
    assert.notStrictEqual(fitted.goalRateSensitivity, 0, "情報のある特徴量の重みは0から動くはず");
  });

  await test("predictionModel.fitWeightsGradientDescent: データが少なすぎる場合は学習を試みない(過学習防止)", () => {
    const records = [{ features: { formDiff: 1 }, actualWinner: "home" }];
    const fitted = model.fitWeightsGradientDescent(records, model.EXTENDED_DEFAULT_WEIGHTS);
    assert.strictEqual(fitted, null);
  });

  await test("predictionModel.computeFactorImportance: 重みが0(未学習)の特徴量は★0として正直に区別する", () => {
    const f = { formDiff: 1, goalRateDiff: 5, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0 };
    const stars = model.computeFactorImportance(f, model.EXTENDED_DEFAULT_WEIGHTS); // goalRateSensitivity=0のまま
    const goalRateItem = stars.find((s) => s.key === "goalRateDiff");
    assert.strictEqual(goalRateItem.stars, 0, "重み0(未学習)の特徴量は、実際の値が大きくても★0にするべき(でっち上げの重要度を出さない)");
  });

  console.log(failures === 0 ? "\nAll Knowledge Engine 4-layer / Prediction Engine v2 tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
