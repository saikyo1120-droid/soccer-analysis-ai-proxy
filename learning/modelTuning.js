/**
 * server/learning/modelTuning.js
 * ------------------------------------------------
 * 2026年8月・共同開発者レビューを受けて新設。
 *
 * ■ 役割
 *   過去試合(historicalBackfill)を使って、
 *     ・λの独立化のための「和の重み」
 *     ・Dixon-Coles の低スコア補正 ρ
 *     ・時間減衰 ξ
 *   を学習し、**旧モデルと新モデルを多指標で比較して、改善したときだけ採用する。**
 *
 * ■ 既存の重み学習(dailyJob内)との役割分担
 *   既存: 自社が予測した試合(learn:ownpred:recent)で「差の重み」を勾配降下。
 *   本件: 過去5,000試合規模で「和の重み・ρ」を探索。データ量が2桁違う。
 *   どちらも採用ゲートを通す点は同じ。
 *
 * ■ 探索方法について正直な注記
 *   外部ライブラリを使わない方針のため、粗いグリッド探索 + 局所改善に留める。
 *   最適化としては素朴だが、パラメータが5個程度と少なく、
 *   かつ**学習用データだけで探索し、検証用データで採否を決める**ため、
 *   過学習は採用ゲートで弾ける。より高度な最適化は、
 *   データが1万件を超えてから検討する(共同開発者と合意済みの方針)。
 */

const {
  evaluate, compare, shouldAdopt, splitByTime, formatComparisonJa,
  consistencyReport, shouldAdoptWithConsistency, formatLeagueTableJa,
} = require("./modelBacktest");
const { backfillSeasons, buildTrainingRows, saveDataset, loadDataset, DEFAULT_BACKFILL_LEAGUES } = require("./historicalBackfill");

const TUNING_LOG_KEY = "learn:modeltuning:log";
// 採用後も「最初のモデルと比べてどれだけ良くなったか」を毎日残すための基準。
// 一度だけ保存し、以後は上書きしない(基準が動くと比較の意味が無くなる)。
const BASELINE_KEY = "learn:model:baseline";
const LEAGUE_NAMES_JA = { 39: "プレミアリーグ", 140: "ラ・リーガ", 78: "ブンデスリーガ", 135: "セリエA", 61: "リーグ・アン" };
const TUNING_LOG_KEEP = 60;
// データセットを作り直す間隔。毎日15リクエスト使う必要はない(過去試合は増えない)。
const REFRESH_DAYS = 7;

/** 探索するパラメータの候補。粗→細の2段階。 */
const COARSE_GRID = {
  attackSumSensitivity: [0, 0.1, 0.2, 0.3],
  concededSumSensitivity: [0, 0.1, 0.2, 0.3],
  rho: [0, -0.05, -0.1, -0.15],
};

function seasonsToFetch(runAt, count) {
  const m = runAt.getUTCMonth() + 1;
  const current = m >= 7 ? runAt.getUTCFullYear() : runAt.getUTCFullYear() - 1;
  const out = [];
  for (let i = 0; i < (count || 3); i++) out.push(current - i);
  return out;
}

/**
 * データセットが無い、または古い場合だけ取得し直す。
 * 予算が足りなければ取得せず、理由を返す(黙って0件にしない)。
 */
async function ensureDataset(deps, runAt) {
  const { upstashEnabled, upstashGetJSON, apiBudget } = deps;
  if (!upstashEnabled) {
    return { rows: [], meta: null, refreshed: false, reasonJa: "保存先(Upstash)が未設定のため、過去試合を蓄積できません。" };
  }
  const existing = await loadDataset(deps);
  const meta = existing.meta;
  const ageDays = meta && meta.builtAt
    ? (runAt.getTime() - Date.parse(meta.builtAt)) / 86400000
    : Infinity;

  if (existing.rows.length > 0 && ageDays < REFRESH_DAYS) {
    return { ...existing, refreshed: false, reasonJa: null };
  }

  // 15リクエスト程度。余裕が無ければ次回に回す。
  const NEEDED = (DEFAULT_BACKFILL_LEAGUES.length * 3) + 2;
  if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(NEEDED)) {
    return {
      ...existing, refreshed: false,
      reasonJa: `過去試合の取り直しに必要な約${NEEDED}リクエストの余裕が無いため、今回は見送りました(既存の${existing.rows.length}件で学習します)。`,
    };
  }

  const seasons = seasonsToFetch(runAt, 3);
  const fetched = await backfillSeasons(deps, { seasons });
  if (!fetched.matches.length) {
    return {
      ...existing, refreshed: false,
      reasonJa: `過去試合を取得できませんでした(${(fetched.errors[0] || "理由不明")})。既存の${existing.rows.length}件で学習します。`,
    };
  }
  const rows = buildTrainingRows(fetched.matches, 10);
  const newMeta = {
    builtAt: runAt.toISOString(),
    seasons,
    leagues: DEFAULT_BACKFILL_LEAGUES.map((l) => l.id),
    matchesFetched: fetched.matches.length,
    trainingRows: rows.length,
    apiRequests: fetched.requests,
    errors: fetched.errors.slice(0, 10),
    skipped: fetched.skipped,
  };
  await saveDataset(deps, rows, newMeta);
  return {
    rows, meta: newMeta, refreshed: true,
    reasonJa: `過去${seasons.length}シーズン×${DEFAULT_BACKFILL_LEAGUES.length}リーグから${fetched.matches.length}試合を取得し、${rows.length}件の学習データを作りました(APIリクエスト${fetched.requests}件)。`,
  };
}

/** 学習用データで最良のパラメータ組み合わせを粗く探す(LogLoss最小化)。 */
function searchParams(trainRows, baseWeights, grid) {
  const g = grid || COARSE_GRID;
  let best = { weights: { ...baseWeights }, logLoss: Infinity, evaluated: 0 };
  const baseEval = evaluate(trainRows, baseWeights);
  if (baseEval.measurable) best = { weights: { ...baseWeights }, logLoss: baseEval.logLoss, evaluated: 1 };

  for (const atk of g.attackSumSensitivity) {
    for (const con of g.concededSumSensitivity) {
      for (const rho of g.rho) {
        const w = { ...baseWeights, attackSumSensitivity: atk, concededSumSensitivity: con, rho };
        const ev = evaluate(trainRows, w);
        best.evaluated++;
        if (ev.measurable && ev.logLoss < best.logLoss) best = { weights: w, logLoss: ev.logLoss, evaluated: best.evaluated };
      }
    }
  }
  return best;
}

/**
 * 本体。過去試合でパラメータを探索し、多指標で比較し、改善したときだけ採用する。
 * 採用しない場合も、なぜ採用しなかったかを必ず記録する。
 */
async function tuneModelOnHistory(deps, currentWeights, runAt) {
  const { upstashEnabled, upstashCmd, upstashSetJSON } = deps;
  const ds = await ensureDataset(deps, runAt);

  if (!ds.rows.length) {
    return {
      ran: false, adopted: false,
      reasonJa: ds.reasonJa || "過去試合の学習データがまだありません。",
      datasetSize: 0,
    };
  }

  const { train, test } = splitByTime(ds.rows, 0.7);
  if (test.length < 200) {
    return {
      ran: false, adopted: false,
      reasonJa: `検証に使える過去試合が${test.length}件で、判断に必要な200件に達していないため、モデルは変更しません(蓄積: ${ds.rows.length}件)。`,
      datasetSize: ds.rows.length,
      datasetNoteJa: ds.reasonJa,
    };
  }

  const base = { ...currentWeights };

  // ---- 基準モデルの固定(共同開発者の要求:採用後も毎日、旧モデルと比較し続ける) ----
  //   一度だけ「改修前のモデル」を保存し、以後この基準と比べ続ける。
  //   基準を毎日更新すると「昨日比」しか分からず、
  //   「最初と比べてどれだけ良くなったか」が永久に分からなくなる。
  let baseline = upstashEnabled ? await (deps.upstashGetJSON(BASELINE_KEY).catch(() => null)) : null;
  if (!baseline) {
    // 和の重みとρを0にしたもの = λ独立化より前の挙動と完全に同一
    baseline = {
      ...base,
      attackSumSensitivity: 0, concededSumSensitivity: 0,
      fatigueSumSensitivity: 0, xgSumSensitivity: 0, rho: 0,
    };
    if (upstashEnabled) await upstashSetJSON(BASELINE_KEY, baseline);
  }

  const found = searchParams(train, base);
  const oldEval = evaluate(test, base);
  const newEval = evaluate(test, found.weights);
  const cmp = compare(oldEval, newEval);

  // ---- リーグ別・統計的一貫性の検証 ----
  const consistency = consistencyReport(test, base, found.weights, LEAGUE_NAMES_JA);
  const decision = shouldAdoptWithConsistency(cmp, consistency, { minSample: 200 });

  // ---- 基準モデルとの比較(採用の可否にかかわらず毎日記録する) ----
  //   「今日のモデルは、改修前と比べてどれだけ良いか」を継続的に残す。
  const adoptedWeights = decision.adopt ? found.weights : base;
  const baselineEval = evaluate(test, baseline);
  const currentEval = evaluate(test, adoptedWeights);
  const vsBaseline = compare(baselineEval, currentEval);
  const vsBaselineConsistency = consistencyReport(test, baseline, adoptedWeights, LEAGUE_NAMES_JA);

  const record = {
    date: runAt.toISOString().slice(0, 10),
    ranAt: runAt.toISOString(),
    datasetSize: ds.rows.length,
    trainSize: train.length,
    testSize: test.length,
    combinationsEvaluated: found.evaluated,
    adopted: decision.adopt,
    consistencyChecked: decision.consistencyChecked,
    reasonJa: decision.reasonJa,
    oldEval, newEval,
    comparisonJa: formatComparisonJa(cmp),
    leagueTableJa: formatLeagueTableJa(consistency),
    leaguesMeasured: consistency.leaguesMeasured,
    leaguesImproved: consistency.improvedCount,
    significantlyWorseLeagues: consistency.significantlyWorseLeagues,
    overallPairedLogLoss: consistency.overallLogLoss,
    // 改修前の基準モデルとの比較(毎日記録)
    vsBaseline: {
      baselineEval, currentEval,
      comparisonJa: formatComparisonJa(vsBaseline),
      leagueTableJa: formatLeagueTableJa(vsBaselineConsistency),
      overallPairedLogLoss: vsBaselineConsistency.overallLogLoss,
      noteJa: "改修前のモデルと現在のモデルの比較です。採用の可否にかかわらず毎日記録しています。",
    },
    newParams: decision.adopt
      ? {
        attackSumSensitivity: found.weights.attackSumSensitivity,
        concededSumSensitivity: found.weights.concededSumSensitivity,
        rho: found.weights.rho,
      }
      : null,
  };

  if (upstashEnabled) {
    await upstashCmd(["LPUSH", TUNING_LOG_KEY, JSON.stringify(record)]).catch(() => {});
    await upstashCmd(["LTRIM", TUNING_LOG_KEY, "0", String(TUNING_LOG_KEEP - 1)]).catch(() => {});
    if (decision.adopt) {
      const merged = { ...base, ...record.newParams, version: (base.version || 0) + 1 };
      const ok = await upstashSetJSON("learn:weights", merged);
      if (ok === false) {
        record.adopted = false;
        record.reasonJa = "採用条件は満たしましたが、保存に失敗したためモデルは変更されていません。";
      }
    }
  }

  return {
    ran: true,
    adopted: record.adopted,
    consistencyChecked: record.consistencyChecked,
    reasonJa: record.reasonJa,
    datasetSize: ds.rows.length,
    datasetNoteJa: ds.reasonJa,
    trainSize: train.length,
    testSize: test.length,
    oldEval, newEval,
    comparison: cmp,
    comparisonJa: record.comparisonJa,
    leagueTableJa: record.leagueTableJa,
    leaguesMeasured: record.leaguesMeasured,
    leaguesImproved: record.leaguesImproved,
    significantlyWorseLeagues: record.significantlyWorseLeagues,
    overallPairedLogLoss: record.overallPairedLogLoss,
    vsBaseline: record.vsBaseline,
    newParams: record.newParams,
  };
}

async function getTuningHistory(deps, limit) {
  const { upstashEnabled, upstashCmd } = deps;
  if (!upstashEnabled) return { available: false, reasonJa: "保存先(Upstash)が未設定です。", items: [] };
  const raw = (await upstashCmd(["LRANGE", TUNING_LOG_KEY, "0", String((limit || 10) - 1)]).catch(() => [])) || [];
  const items = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  return {
    available: true, items,
    noteJa: items.length
      ? "過去試合を使ったモデル比較の履歴です。採用しなかった日も理由つきで残しています。"
      : "モデル比較はまだ実行されていません(過去試合の蓄積が必要件数に達すると始まります)。",
  };
}

module.exports = {
  TUNING_LOG_KEY, BASELINE_KEY, LEAGUE_NAMES_JA, REFRESH_DAYS, COARSE_GRID,
  seasonsToFetch, ensureDataset, searchParams, tuneModelOnHistory, getTuningHistory,
};
