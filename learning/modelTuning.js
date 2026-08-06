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

const { evaluate, compare, shouldAdopt, splitByTime, formatComparisonJa } = require("./modelBacktest");
const { backfillSeasons, buildTrainingRows, saveDataset, loadDataset, DEFAULT_BACKFILL_LEAGUES } = require("./historicalBackfill");

const TUNING_LOG_KEY = "learn:modeltuning:log";
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
  const found = searchParams(train, base);
  const oldEval = evaluate(test, base);
  const newEval = evaluate(test, found.weights);
  const cmp = compare(oldEval, newEval);
  const decision = shouldAdopt(cmp, { minSample: 200 });

  const record = {
    date: runAt.toISOString().slice(0, 10),
    ranAt: runAt.toISOString(),
    datasetSize: ds.rows.length,
    trainSize: train.length,
    testSize: test.length,
    combinationsEvaluated: found.evaluated,
    adopted: decision.adopt,
    reasonJa: decision.reasonJa,
    oldEval, newEval,
    comparisonJa: formatComparisonJa(cmp),
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
    reasonJa: record.reasonJa,
    datasetSize: ds.rows.length,
    datasetNoteJa: ds.reasonJa,
    trainSize: train.length,
    testSize: test.length,
    oldEval, newEval,
    comparison: cmp,
    comparisonJa: record.comparisonJa,
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
  TUNING_LOG_KEY, REFRESH_DAYS, COARSE_GRID,
  seasonsToFetch, ensureDataset, searchParams, tuneModelOnHistory, getTuningHistory,
};
