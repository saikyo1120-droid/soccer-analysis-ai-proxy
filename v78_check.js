/**
 * scripts/v78_check.js — v78(賢さ強化4点)の自己完結テスト。
 *   案1: 引き分け帯の学習化(±0.15固定→weights.drawBand・完全後方互換・
 *        バックテスト判定を本番と同一ルールへ統一)
 *   案2: 選手の質問への6段階の熟考の拡張(観点・根拠プール・データ種別)
 *   案4: リーグ別の常設実測表(的中率+引き分けの実際/予想/的中)
 *   案3: 学習への予算投入(選手更新の既定20名/日・データセット更新3日ごと)
 * 実行: node scripts/v78_check.js(ネットワーク不要)
 */
"use strict";
const path = require("path");
const fs = require("fs");

// 配置の自動判別(2026-09-02監査): 開発配置(scripts/../server/)でも、リポジトリの
// フラット配置(テストと同じ階層または親にserver.jsとlearning/)でも実行できるようにする。
// リポジトリに保管したテストが、保管先(フラット配置)ではそのまま実行できなかった問題の修正。
const ROOT = (() => {
  if (fs.existsSync(path.join(__dirname, "..", "server", "server.js"))) return path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(__dirname, "server.js")) && fs.existsSync(path.join(__dirname, "learning"))) return __dirname;
  if (fs.existsSync(path.join(__dirname, "..", "server.js")) && fs.existsSync(path.join(__dirname, "..", "learning"))) return path.resolve(__dirname, "..");
  return path.resolve(__dirname, "..", "..");
})();
const SERVER_DIR = fs.existsSync(path.join(ROOT, "server", "server.js")) ? path.join(ROOT, "server") : ROOT;
const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 300) : ""}`); };

// ============ 案1: 引き分け帯 ============
const pm = require(path.join(SERVER_DIR, "learning", "predictionModel.js"));
const dj = require(path.join(SERVER_DIR, "learning", "dailyJob.js"));
const mb = require(path.join(SERVER_DIR, "learning", "modelBacktest.js"));

{
  // predictOutcomeV2: 帯なしweights=従来0.15と同一(後方互換)
  const f = pm.computeMatchFeatures({ formScore: 10 }, { formScore: 0 }, null);
  const noBand = pm.predictOutcomeV2(f, {});
  ck("案1: drawBand未指定は従来の±0.15で判定(後方互換)",
    Math.abs((noBand.homeLambda - noBand.awayLambda)) > 0.15 ? noBand.predictedWinner !== "draw" : noBand.predictedWinner === "draw",
    JSON.stringify(noBand));
  // 巨大な帯→必ず引き分け / 極小の帯→差があれば勝敗
  const wide = pm.predictOutcomeV2(f, { drawBand: 99 });
  ck("案1: 帯を広げると引き分け判定になる(λ・確率は不変)",
    wide.predictedWinner === "draw" && wide.homeLambda === noBand.homeLambda && wide.awayLambda === noBand.awayLambda, JSON.stringify(wide));
  const narrow = pm.predictOutcomeV2(f, { drawBand: 0.0001 });
  ck("案1: 帯を狭めると僅差でも勝敗を出す",
    narrow.predictedWinner === (narrow.homeLambda > narrow.awayLambda ? "home" : "away"), JSON.stringify(narrow));
}
{
  // dailyJob側の簡易predictOutcomeも同じ帯規約
  const a = dj.predictOutcome(10, 0, { homeBase: 1.35, awayBase: 1.15, sensitivity: 0.18 });
  const b = dj.predictOutcome(10, 0, { homeBase: 1.35, awayBase: 1.15, sensitivity: 0.18, drawBand: 99 });
  ck("案1: dailyJob.predictOutcomeもdrawBandに従う(未指定=従来)",
    a.predictedWinner === "home" && b.predictedWinner === "draw", JSON.stringify({ a, b }));
}
{
  // バックテスト(predictRow)が本番と同一の帯ルールで判定する(argmax廃止の確認)
  const row = { homeCtx: { formScore: 3 }, awayCtx: { formScore: 0 } };
  const w = { homeBase: 1.35, awayBase: 1.15, sensitivity: 0.18 };
  const pr = mb.predictRow ? mb.predictRow(row, w) : null;
  if (pr) {
    const f2 = pm.computeMatchFeatures(row.homeCtx, row.awayCtx, null);
    const live = pm.predictOutcomeV2(f2, w);
    ck("案1: バックテストの勝敗判定=本番の判定(ルール統一)", pr.predicted === live.predictedWinner, JSON.stringify({ pr: pr.predicted, live: live.predictedWinner }));
    const prWide = mb.predictRow(row, { ...w, drawBand: 99 });
    ck("案1: バックテストも帯の変更に追随する", prWide.predicted === "draw", prWide.predicted);
  } else {
    // predictRowが未exportならevaluate経由で確認
    const rows = [{ homeCtx: { formScore: 3 }, awayCtx: { formScore: 0 }, actualWinner: "draw", actualHomeGoals: 1, actualAwayGoals: 1 }];
    const evNarrow = mb.evaluate(rows, w);
    const evWide = mb.evaluate(rows, { ...w, drawBand: 99 });
    ck("案1: evaluate経由で帯の変更が的中率に反映される",
      evWide.accuracyPct === 100 && evNarrow.accuracyPct === 0, JSON.stringify({ evNarrow, evWide }));
  }
}
{
  // modelTuningの結線(静的確認): 門番つき探索・引き分け0件ガード・採用時の保存
  const src = fs.readFileSync(path.join(SERVER_DIR, "learning", "modelTuning.js"), "utf8");
  ck("案1: modelTuningに門番つき帯探索がある", src.includes("DRAW_BAND_ADOPT_MARGIN_PT") && src.includes("drawBandDetail"), "");
  ck("案1: 「引き分け0件へ退化する帯は採用しない」ガードがある", src.includes("drawPredictedCount || 0) > 0"), "");
  ck("案1: 採用時にdrawBandがnewParams(保存対象)へ入る", /newParams[\s\S]{0,700}drawBand: Number\.isFinite/.test(src), "");
  ck("案3: データセット更新が3日ごとになっている", src.includes("REFRESH_DAYS = 3"), "");
}

// ============ 案2: 選手の熟考 ============
const { buildPlayerEvidencePool } = require(path.join(SERVER_DIR, "reasoning", "evidencePool.js"));
const { PLAYER_HYPOTHESIS_FACTORS, HYPOTHESIS_FACTORS, generateHypotheses } = require(path.join(SERVER_DIR, "reasoning", "hypothesisGenerator.js"));
const { assembleReasoning } = require(path.join(SERVER_DIR, "reasoning", "reasoningEngine.js"));
const { deliberate, PLAYER_DATA_SPECS, assessDataAvailability } = require(path.join(SERVER_DIR, "reasoning", "deliberation.js"));

const FULL_STATS = { appearances: 20, goals: 8, assists: 5, avgRating: 7.4, keyPasses: 30, passAccuracyPct: 85, dribbleSuccessRatePct: 60, defensiveActions: 25, duelWinRatePct: 55 };
{
  const pool = buildPlayerEvidencePool({ playerKey: "player:1", season: 2026, stats: FULL_STATS, clubItems: ["クラブは直近5戦3勝。"], playerKnowledge: null });
  const cats = new Set(pool.map((e) => e.category));
  ck("案2: フル実績から6カテゴリの根拠が組める",
    ["playerOpportunity", "playerScoring", "playerRating", "playerCreation", "playerDefense", "clubContext"].every((c) => cats.has(c)), Array.from(cats).join(","));
  const poolMin = buildPlayerEvidencePool({ playerKey: "player:2", stats: { appearances: 5, goals: 1, assists: null, avgRating: null }, clubItems: [] });
  const catsMin = new Set(poolMin.map((e) => e.category));
  ck("案2: 取得できなかった指標のitemは作らない(でっち上げ防止)",
    catsMin.has("playerOpportunity") && catsMin.has("playerScoring") && !catsMin.has("playerRating") && !catsMin.has("playerCreation") && !catsMin.has("playerDefense"), Array.from(catsMin).join(","));
  // プロフィール(AI生成)はaiEstimate扱い+蓄積側と重複させない
  const poolProf = buildPlayerEvidencePool({ playerKey: "player:3", stats: FULL_STATS, profileStatement: "【AIによる推定】攻撃的なMF。", playerKnowledge: { profiles: [] } });
  const profItem = poolProf.find((e) => e.category === "playerProfile");
  ck("案2: このターン生成のプロフィールはaiEstimate(実データ扱いにしない)", !!profItem && profItem.type === "aiEstimate", JSON.stringify(profItem));
  const poolDup = buildPlayerEvidencePool({ playerKey: "player:3", stats: FULL_STATS, profileStatement: "同文", playerKnowledge: { profiles: [{ statement: "同文", isAiGenerated: true }] } });
  ck("案2: 蓄積済みと同文のプロフィールは重複させない", poolDup.filter((e) => e.statement === "同文").length === 1, "");
}
{
  // 配線不一致(過去の監査で頻発)の構造的防止: 選手観点のカテゴリは、
  // 根拠プールが実際に生成し得るカテゴリの中にしか無いことを固定する
  const producible = new Set(["playerOpportunity", "playerScoring", "playerRating", "playerCreation", "playerDefense", "clubContext", "playerSeasonStats", "playerProfile"]);
  const orphans = [];
  for (const f of PLAYER_HYPOTHESIS_FACTORS) for (const c of f.relevantCategories) if (!producible.has(c)) orphans.push(`${f.id}:${c}`);
  ck("案2: 選手観点のカテゴリ名は根拠プールと厳密対応(孤児カテゴリなし)", orphans.length === 0, orphans.join(","));
}
{
  const pool = buildPlayerEvidencePool({ playerKey: "player:1", season: 2026, stats: FULL_STATS, clubItems: ["クラブは好調。"] });
  const bundle = assembleReasoning(pool, { teamJa: "テスト選手", teamEn: "player:1" }, { factors: PLAYER_HYPOTHESIS_FACTORS });
  ck("案2: 選手用の観点で仮説が立ち、根拠つきで選ばれる",
    bundle.hypotheses.length === PLAYER_HYPOTHESIS_FACTORS.length && !!bundle.selected && bundle.selected.evidence.length > 0 && (bundle.orphanCategories || []).length === 0,
    JSON.stringify({ selected: bundle.selected && bundle.selected.label, orphan: bundle.orphanCategories }));
  const d = deliberate({
    ranked: bundle.hypotheses,
    dataAvailability: { playerScoring: true, playerOpportunity: true, playerRating: true, playerCreation: true, playerDefense: true, playerClubContext: true },
    requiredKeys: ["playerScoring", "playerOpportunity", "playerRating", "playerClubContext"],
    dataSpecs: PLAYER_DATA_SPECS,
  });
  ck("案2: 選手用データ種別で6段階が完走し、選手の言葉で説明する",
    !!d.finalConclusionJa && d.stages.step1_dataGathering.summaryJa.includes("4種類") && !d.stages.step1_dataGathering.summaryJa.includes("監督"),
    d.stages.step1_dataGathering.summaryJa);
}
{
  // クラブ側の劣化なし: dataSpecs未指定は従来のクラブ8種のまま、選手用語が混ざらない
  const g = assessDataAvailability({ form: true, goals: true }, ["form", "goals", "injuries"]);
  ck("案2: クラブの充足率計算は従来どおり(選手用語が混入しない)",
    g.summaryJa.includes("2/3種類") && !JSON.stringify(g).includes("得点関与"), JSON.stringify(g).slice(0, 200));
  const clubHyp = generateHypotheses([{ category: "injuries", type: "fact", statement: "負傷者2名。" }], { teamJa: "テストFC" });
  ck("案2: 観点省略時はクラブ用9観点のまま(既存呼び出しの挙動不変)", clubHyp.length === HYPOTHESIS_FACTORS.length, String(clubHyp.length));
}
{
  // server.jsの結線(静的確認)
  const src = fs.readFileSync(path.join(SERVER_DIR, "server.js"), "utf8");
  ck("案2: handleDiscussの選手分岐に熟考の結線がある",
    src.includes("buildPlayerEvidencePool({") && src.includes("factors: PLAYER_HYPOTHESIS_FACTORS") && src.includes("dataSpecs: PLAYER_DATA_SPECS"), "");
  ck("案2: Stage Eの保存先が選手/クラブで正しく分かれる(stageE変数)",
    src.includes("stageEIsPlayer") && src.includes("stageETimelineKey") && src.includes("teamEn: stageEEntityEn"), "");
}

// ============ 案4: リーグ別の実測表 ============
const si = require(path.join(SERVER_DIR, "learning", "selfImprovement.js"));
{
  const mk = (league, predicted, actual) => ({ resolved: true, league, predictedWinner: predicted, actualWinner: actual, correct: predicted === actual, featureTrust: null });
  const records = [
    mk("リーグA", "home", "home"), mk("リーグA", "draw", "draw"), mk("リーグA", "home", "draw"), mk("リーグA", "draw", "away"),
    mk("リーグB", "home", "home"), mk("リーグB", "away", "away"), mk("リーグB", "home", "away"),
    mk("リーグC", "home", "home"), // n=1 → 表に出ない
  ];
  const diag = si.buildSelfDiagnosis({ recentRecords: records, featureEffectiveness: null, apiCallStats: null, errors: [], accuracyTrend: null });
  const lt = diag.leagueTable || [];
  const a = lt.find((r) => r.league === "リーグA");
  const b = lt.find((r) => r.league === "リーグB");
  ck("案4: リーグ別表が件数の多い順・n≥3のみで出る",
    lt.length === 2 && lt[0].league === "リーグA" && !lt.find((r) => r.league === "リーグC"), JSON.stringify(lt));
  ck("案4: 的中率・引分実際/予想/的中の計算が正しい(リーグA: 4件中2的中・実際の引分2件50%・予想2件50%・的中1件)",
    !!a && a.n === 4 && a.hitRatePct === 50 && a.drawActualPct === 50 && a.drawPredictedPct === 50 && a.drawHitN === 1, JSON.stringify(a));
  ck("案4: 引分予想が無いリーグは0%と正直に出る", !!b && b.drawPredictedPct === 0 && b.drawHitN === 0, JSON.stringify(b));
  ck("案4: 注記(実測範囲の説明)が付く", typeof diag.leagueTableNoteJa === "string" && diag.leagueTableNoteJa.includes("実測"), "");
}
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ck("案4: 裏側タブにリーグ別実測表の描画がある", html.includes("リーグ別の実測") && html.includes("leagueTable") && html.includes("引分実際"), "");
  const djSrc = fs.readFileSync(path.join(SERVER_DIR, "learning", "dailyJob.js"), "utf8");
  ck("案4: 夜間レポートにleagueTableが載る結線がある", djSrc.includes("leagueTable: diagnosis.leagueTable"), "");
}

// ============ 案3: 予算→学習 ============
{
  const pdu = require(path.join(SERVER_DIR, "learning", "playerDailyUpdate.js"));
  ck("案3: 選手評価更新の既定が20名/日(一巡約5日)", pdu.PLAYER_UPDATE_CAP_DEFAULT === 20, String(pdu.PLAYER_UPDATE_CAP_DEFAULT));
}

const okCount = results.filter(([, v]) => v).length;
const ngCount = results.length - okCount;
console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
process.exit(ngCount ? 1 : 0);
