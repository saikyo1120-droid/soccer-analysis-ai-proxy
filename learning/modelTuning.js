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
const { backfillSeasons, buildTrainingRows, saveDataset, loadDataset, DEFAULT_BACKFILL_LEAGUES, ROWS_VERSION, buildTeamNamesById } = require("./historicalBackfill");
const { timeDecayWeight } = require("./historicalBackfill");
// v47「予測モデルの根本強化」: 過去試合データセットで**全特徴量の重み**を
// 勾配降下法で学習するために追加(従来はattackSum/concededSum/rhoの3個だけを
// グリッド探索しており、formDiff等の差の重みは過去試合から一切学べていなかった)。
const {
  computeMatchFeatures, fitWeightsGradientDescent,
  FEATURE_WEIGHT_MAP, FEATURE_SUM_WEIGHT_MAP, LEARNABLE_KEYS,
} = require("./predictionModel");
// v50「チームの地力レーティング」: 過去試合からチーム別の攻撃力・守備力を学習し、
// 期待得点(λ̂)を特徴量として既存モデルへ渡す(重みは実測で学習・初期0)。
const { fitTeamRatings, expGoalsFromRatings, RATINGS_KEY } = require("./teamRatings");

const TUNING_LOG_KEY = "learn:modeltuning:log";
// 採用後も「最初のモデルと比べてどれだけ良くなったか」を毎日残すための基準。
// 一度だけ保存し、以後は上書きしない(基準が動くと比較の意味が無くなる)。
const BASELINE_KEY = "learn:model:baseline";
const LEAGUE_NAMES_JA = {
  39: "プレミアリーグ", 140: "ラ・リーガ", 78: "ブンデスリーガ", 135: "セリエA", 61: "リーグ・アン",
  // v47で拡張した4リーグ(historicalBackfill.jsのDEFAULT_BACKFILL_LEAGUESと対応)
  88: "エールディヴィジ", 94: "プリメイラ・リーガ", 203: "シュペル・リグ", 144: "ベルギー・プロ・リーグ",
};
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

  // v47: 設定上のリーグ構成が保存済みデータと違う場合(リーグを増やした直後)は、
  // 週1回の更新日を待たずに作り直す。そうしないと拡張が最長7日間反映されない。
  const wantIds = DEFAULT_BACKFILL_LEAGUES.map((l) => l.id);
  const haveIds = (meta && Array.isArray(meta.leagues)) ? meta.leagues : [];
  const leagueSetChanged = existing.rows.length > 0 && wantIds.some((id) => !haveIds.includes(id));
  // v50/v53: 行フォーマットが古い(チームIDやチーム名対応表が無い)場合も
  // 更新日を待たずに作り直す(1回だけ約29リクエスト。以降は週1回に戻る)。
  const rowsFormatOld = existing.rows.length > 0 && (!meta || meta.rowsVersion !== ROWS_VERSION);

  if (existing.rows.length > 0 && ageDays < REFRESH_DAYS && !leagueSetChanged && !rowsFormatOld) {
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
    // v53: 地力ランキングの表示用(teamId→チーム名)。約200件・数KB。
    namesById: buildTeamNamesById(fetched.matches),
    seasons,
    leagues: DEFAULT_BACKFILL_LEAGUES.map((l) => l.id),
    matchesFetched: fetched.matches.length,
    trainingRows: rows.length,
    apiRequests: fetched.requests,
    errors: fetched.errors.slice(0, 10),
    skipped: fetched.skipped,
  };
  // ---- 検証で判明した欠陥の修正 ----
  //   保存の成否を捨てていたため、1件も保存できていない日でも
  //   「作りました」と成功を報告し、翌日また15リクエストを使っていた。
  const saveRes = await saveDataset(deps, rows, newMeta);
  const saved = saveRes && saveRes.saved === true;
  return {
    rows, meta: { ...newMeta, ...(saveRes && saveRes.meta ? saveRes.meta : {}) },
    refreshed: saved,
    saved,
    reasonJa: saved
      ? `過去${seasons.length}シーズン×${DEFAULT_BACKFILL_LEAGUES.length}リーグから${fetched.matches.length}試合を取得し、${rows.length}件の学習データを作りました(APIリクエスト${fetched.requests}件)。`
        + ((saveRes && saveRes.reasonJa) ? saveRes.reasonJa : "")
      : `過去試合${fetched.matches.length}件から${rows.length}件の学習データを作りましたが、**保存に失敗しました**(${(saveRes && saveRes.reasonJa) || "理由不明"})。今日の学習には使いますが、明日は取り直しになります。`,
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
/**
 * v47「予測モデルの根本強化」の中核: 過去試合データセットで勾配降下法を回し、
 * グリッド探索(3パラメータ)では学べなかった「差の重み」(formDiff・goalRateDiff・
 * standingsDiff・venueDiff など)を実試合数千件から学習する。
 *
 * ■ でっち上げ防止・劣化禁止の設計
 *   ・学習対象キーは「データセット内で実際に非ゼロ値が存在する特徴量」だけ。
 *     過去試合に無いデータ(怪我人・出場停止・xG・市場オッズ等)の重みは
 *     一切動かさない(勾配が厳密に0なので動かせもしない。計算だけ省く)。
 *   ・古い試合ほど学習への影響を減衰(Dixon-Coles ξ=0.0065/日 ≒ 半減期107日)。
 *   ・失敗したら null を返し、呼び出し側は従来のグリッド候補のみで続行する
 *     (この関数がどんな失敗をしても、従来より悪くなる経路は存在しない)。
 */
function fitHistoryWeights(trainRows, initialWeights, runAt) {
  try {
    if (!Array.isArray(trainRows) || trainRows.length < 200) {
      return { weights: null, detail: { ran: false, reasonJa: `学習用の過去試合が${(trainRows || []).length}件で、勾配学習に必要な200件未満のため実施しませんでした。` } };
    }
    // 特徴量は1回だけ前計算する(勾配降下法は同じ試合を何百回も評価するため)
    const fitRows = trainRows.map((r) => ({
      features: computeMatchFeatures(r.homeCtx, r.awayCtx, null),
      actualWinner: r.actualWinner,
      date: r.date,
    }));
    // データセット内に実在する特徴量だけを学習対象にする(動的判定)
    const presentKeys = new Set();
    const maps = { ...FEATURE_WEIGHT_MAP, ...FEATURE_SUM_WEIGHT_MAP };
    for (const [fKey, wKey] of Object.entries(maps)) {
      if (fitRows.some((r) => r.features && r.features[fKey])) presentKeys.add(wKey);
    }
    presentKeys.add("rho"); // ρは特徴量ではなくスコア分布の補正なので常に対象
    const keys = [...presentKeys];
    const refMs = runAt instanceof Date ? runAt.getTime() : Date.parse(runAt) || 0;
    const t0 = Date.now(); // v49: 実行時間を実測して記録に残す(説明責任・本番の観測用)
    const fitted = fitWeightsGradientDescent(fitRows, initialWeights, {
      keys,
      iterations: 25, // 数千件×毎日実行のためのバランス。学習ジョブ内でのみ実行(方針⑥)
      sampleWeightOf: (r) => timeDecayWeight(r.date, refMs, 0.0065),
    });
    const fitMs = Date.now() - t0;
    if (!fitted) {
      return { weights: null, detail: { ran: true, keys, reasonJa: "勾配学習が収束しなかった(または結果が保存基準を満たさなかった)ため、グリッド探索の候補のみで判定します。" } };
    }
    return {
      weights: fitted,
      detail: {
        ran: true,
        keys,
        rows: fitRows.length,
        iterations: 25,
        decayXiPerDay: 0.0065,
        ms: fitMs, // 実測の所要時間(ミリ秒)
        noteJa: `過去試合${fitRows.length}件(時間減衰つき)で${keys.length}個の重みを勾配降下法で学習しました(所要${(fitMs / 1000).toFixed(1)}秒)。`,
      },
    };
  } catch (e) {
    return { weights: null, detail: { ran: false, reasonJa: `勾配学習でエラーが発生したため見送りました(${e && e.message})。` } };
  }
}

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

  // ---- v50: チーム別レーティングの学習と、特徴量への注入 ----
  //   評価の公正のため、検証(test)に使うレーティングは**学習用(train)だけ**で
  //   学習する(testの結果を知っているレーティングでtestを評価しない)。
  //   本番保存用は最後に全データで学習し直す(使えるデータは全部使う)。
  const nowMsForRatings = runAt.getTime();
  const ratingsTrain = fitTeamRatings(train, { nowMs: nowMsForRatings });
  const attachRatings = (rows, ratings) => {
    if (!ratings || !ratings.available) return 0;
    let attached = 0;
    for (const r of rows) {
      const eg = expGoalsFromRatings(ratings, r.homeId, r.awayId);
      if (eg) {
        r.homeCtx = { ...r.homeCtx, ratingExpGoals: eg.home };
        r.awayCtx = { ...r.awayCtx, ratingExpGoals: eg.away };
        attached++;
      }
    }
    return attached;
  };
  const ratingsAttachedTrain = attachRatings(train, ratingsTrain);
  const ratingsAttachedTest = attachRatings(test, ratingsTrain);

  const found = searchParams(train, base);

  // ---- v47「予測モデルの根本強化」: 過去試合で全特徴量の重みを学習する ----
  //   これまで過去試合データセット(数千件)は attackSum/concededSum/rho の
  //   3パラメータのグリッド探索にしか使われず、formDiff・goalRateDiff・
  //   standingsDiff・venueDiff などの「差の重み」は自分の予測記録
  //   (数百件)からしか学べなかった。数千件の実試合で勾配降下法を回し、
  //   差の重みも学習する。
  //   ・学習対象キーは「データセット内に実際に値が存在する特徴量」だけに
  //     動的に絞る(過去試合には怪我人・オッズ等が無い→それらの勾配は
  //     厳密に0で動かないため、計算を省いても結果は1ビットも変わらない)。
  //   ・古い試合ほど影響を弱める(Dixon-Colesの時間減衰 ξ=0.0065/日)。
  //   ・候補の優劣は学習用データのLogLossで決め、採否は従来どおり
  //     検証用データの関門(shouldAdoptWithConsistency)が判断する。
  const gradFit = fitHistoryWeights(train, found.weights, runAt);
  const trainEvalGrid = evaluate(train, found.weights);
  const trainEvalGrad = gradFit.weights ? evaluate(train, gradFit.weights) : null;
  const gradWon = !!(trainEvalGrad && trainEvalGrad.measurable && trainEvalGrid.measurable
    && trainEvalGrad.logLoss < trainEvalGrid.logLoss);
  const candidateWeights = gradWon ? gradFit.weights : found.weights;

  const oldEval = evaluate(test, base);
  const newEval = evaluate(test, candidateWeights);
  const cmp = compare(oldEval, newEval);

  // ---- リーグ別・統計的一貫性の検証 ----
  const consistency = consistencyReport(test, base, candidateWeights, LEAGUE_NAMES_JA);
  const decision = shouldAdoptWithConsistency(cmp, consistency, { minSample: 200 });

  // ---- 基準モデルとの比較(採用の可否にかかわらず毎日記録する) ----
  //   「今日のモデルは、改修前と比べてどれだけ良いか」を継続的に残す。
  const adoptedWeights = decision.adopt ? candidateWeights : base;
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
    // v47の修正: 従来はグリッド探索の3パラメータだけを保存していた。
    // 勾配降下法の候補が勝った場合、formDiff等の学習結果が保存時に
    // 静かに捨てられてしまうため、学習対象キー全部を保存する
    // (グリッド候補が勝った場合も同じキー集合で、値が3個以外は元のまま)。
    newParams: decision.adopt
      ? Object.fromEntries(LEARNABLE_KEYS
          .filter((k) => Number.isFinite(candidateWeights[k]))
          .map((k) => [k, candidateWeights[k]]))
      : null,
    // どちらの候補が勝ったか(実測の記録。gradFit.detailは学習の中身の説明)
    method: gradWon ? "history_gradient_descent" : "grid_search",
    gradientFit: gradFit.detail,
    // v50: レーティング学習の実測記録
    teamRatings: {
      trainFit: { available: ratingsTrain.available, teams: ratingsTrain.teamsRated, matches: ratingsTrain.matchesUsed, reasonJa: ratingsTrain.reasonJa || null },
      attachedTrain: ratingsAttachedTrain, attachedTest: ratingsAttachedTest,
    },
  };

  // ---- v50: 本番用レーティングは全データで学習して保存する ----
  //   これは「重み」ではなく「データから測ったチームの状態」なので、重みの
  //   採否とは独立に、毎回最新へ更新する(古いレーティングを使い続けない)。
  //   保存に失敗したら既存のレーティングが残る(読み出し側は無ければ影響0)。
  let ratingsSaved = false;
  try {
    const ratingsFull = fitTeamRatings(ds.rows, { nowMs: nowMsForRatings });
    if (ratingsFull.available && upstashEnabled) {
      ratingsFull.builtAt = runAt.toISOString();
      // v53: 表示用のチーム名(データセットのメタから。無ければ省略=IDのみ)
      if (ds.meta && ds.meta.namesById) {
        const names = {};
        for (const id of Object.keys(ratingsFull.byTeam)) {
          if (ds.meta.namesById[id]) names[id] = ds.meta.namesById[id];
        }
        ratingsFull.namesById = names;
      }
      ratingsSaved = (await upstashSetJSON(RATINGS_KEY, ratingsFull)) !== false;
      // ---- v53「地力ランキング」の週次スナップショット(↑↓表示用) ----
      //   今週の順位表を learn:ratings:ranks:latest に保存し、週が替わった最初の
      //   保存時に、前週分を learn:ratings:ranks:prev へ退避する。
      try {
        const { lastCompletedWeekRange, weekKeyOf } = require("./weeklyDigest");
        const curWeekKey = weekKeyOf(lastCompletedWeekRange(nowMsForRatings).endMs); // 今週の月曜
        const ranked = Object.entries(ratingsFull.byTeam)
          .map(([id, t]) => ({ id, strength: t.att + t.def }))
          .sort((a, b) => b.strength - a.strength);
        const ranks = {};
        ranked.forEach((t, i) => { ranks[t.id] = i + 1; });
        const latest = await deps.upstashGetJSON("learn:ratings:ranks:latest").catch(() => null);
        if (latest && latest.weekKey && latest.weekKey !== curWeekKey) {
          await upstashSetJSON("learn:ratings:ranks:prev", latest);
        }
        await upstashSetJSON("learn:ratings:ranks:latest", { weekKey: curWeekKey, ranks, savedAt: runAt.toISOString() });
      } catch (e) { /* スナップショットはベストエフォート(ランキング表示は変動なしで出る) */ }
    }
    record.teamRatings.fullFit = { available: ratingsFull.available, teams: ratingsFull.teamsRated, matches: ratingsFull.matchesUsed, saved: ratingsSaved, reasonJa: ratingsFull.reasonJa || null };
  } catch (e) {
    record.teamRatings.fullFit = { available: false, saved: false, reasonJa: `レーティング学習でエラー(${e && e.message})` };
  }

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
    teamRatings: record.teamRatings,
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
  seasonsToFetch, ensureDataset, searchParams, tuneModelOnHistory, getTuningHistory, fitHistoryWeights,
};
