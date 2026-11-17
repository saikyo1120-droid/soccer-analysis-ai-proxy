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
const {
  backfillSeasons, buildTrainingRows, saveDataset, loadDataset, DEFAULT_BACKFILL_LEAGUES, ROWS_VERSION, buildTeamNamesById,
  ensureLeagueChecks, summarizeLeagueChecks, seasonsForLeague, activateFromMeta, // v102 ★2: リーグの照合・有効化・リーグ別のシーズン
} = require("./historicalBackfill");
const { noteVia } = require("./warnings"); // v92: 黙って続行した失敗の痕跡(deps.noteWarning があれば記録)
const { timeDecayWeight } = require("./historicalBackfill");
// v47「予測モデルの根本強化」: 過去試合データセットで**全特徴量の重み**を
// 勾配降下法で学習するために追加(従来はattackSum/concededSum/rhoの3個だけを
// グリッド探索しており、formDiff等の差の重みは過去試合から一切学べていなかった)。
const {
  computeMatchFeatures, fitWeightsGradientDescent,
  FEATURE_WEIGHT_MAP, FEATURE_SUM_WEIGHT_MAP, LEARNABLE_KEYS,
  predictOutcomeV2, computeMatchProbabilitiesRaw, isSaneWeights, // v102(B): 交差検証の関門で1件ごとの損失を測る
} = require("./predictionModel");
const { timeBlocks, crossValidate, decideCvGate, summarizeCv, pairedStats } = require("./cvGate"); // v102(B)
// v50「チームの地力レーティング」: 過去試合からチーム別の攻撃力・守備力を学習し、
// 期待得点(λ̂)を特徴量として既存モデルへ渡す(重みは実測で学習・初期0)。
const { fitTeamRatings, expGoalsFromRatings, RATINGS_KEY, XI_DEFAULT } = require("./teamRatings");
// v59「派生指標」: 同じデータセットからBTTS率・クリーンシート率・荒れやすさを
// 1回だけ集計して保存する(利用者の質問時は読み出すだけ。方針⑥)。
const { buildTeamStats, TEAM_STATS_KEY } = require("./teamStats");

const TUNING_LOG_KEY = "learn:modeltuning:log";
// 採用後も「最初のモデルと比べてどれだけ良くなったか」を毎日残すための基準。
// 一度だけ保存し、以後は上書きしない(基準が動くと比較の意味が無くなる)。
const BASELINE_KEY = "learn:model:baseline";
const LEAGUE_NAMES_JA = {
  39: "プレミアリーグ", 140: "ラ・リーガ", 78: "ブンデスリーガ", 135: "セリエA", 61: "リーグ・アン",
  // v47で拡張した4リーグ(historicalBackfill.jsのDEFAULT_BACKFILL_LEAGUESと対応)
  88: "エールディヴィジ", 94: "プリメイラ・リーガ", 203: "シュペル・リグ", 144: "ベルギー・プロ・リーグ",
  // v58で追加した欧州カップ戦(リーグ間の実対戦=レーティングの相互較正用)
  2: "チャンピオンズリーグ", 3: "ヨーロッパリーグ", 848: "カンファレンスリーグ",
  // v87③で追加した3リーグ(historicalBackfill.jsのDEFAULT_BACKFILL_LEAGUESと対応)
  98: "J1リーグ", 40: "チャンピオンシップ(イングランド2部)", 71: "ブラジル全国選手権",
};
// v102 ★2: 新しく足した16リーグの名前は、リーグの一覧(historicalBackfill)から取る(名前の二重管理をしない)
for (const l of DEFAULT_BACKFILL_LEAGUES) { if (!LEAGUE_NAMES_JA[l.id]) LEAGUE_NAMES_JA[l.id] = l.nameJa; }
const TUNING_LOG_KEEP = 60;
// データセットを作り直す間隔。
// v78(案3・利用者の指示「商品化まで予算の余りは全て学習へ」): 週1回→3日ごとへ短縮。
// シーズン進行中は新しい試合が毎週増えるため、学習データの鮮度が上がる
// (1回あたり約62リクエスト。Proプランの余裕内)。
const REFRESH_DAYS = 3;

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
async function ensureDataset(deps, runAt, opts) {
  const { upstashEnabled, upstashGetJSON, apiBudget } = deps;
  if (!upstashEnabled) {
    return { rows: [], meta: null, refreshed: false, reasonJa: "保存先(Upstash)が未設定のため、過去試合を蓄積できません。" };
  }
  // v102: 「軽い設定」(前回 ④-b の途中で落ちたあとの数日間)では、新しいほうのブロックだけを読む
  const safeMode = !!(opts && opts.safeMode);
  const collect = opts && typeof opts.collect === "function" ? opts.collect : () => {};
  let existing = await loadDataset(deps, safeMode ? { lastShards: SAFE_MODE_LAST_SHARDS } : undefined);
  // v102: 保存済みのデータセットの一部のブロックを読めなかったときは、黙って続けずに記録に残す
  //   (その日は読めた分だけで学習する。次の取り直しで元に戻る)
  if (existing.failedShards && existing.failedShards.length) {
    noteVia(deps, "backfill_shard_read_failed", new Error(`blocks=${existing.failedShards.join(",")}`));
  }
  const meta = existing.meta;
  const ageDays = meta && meta.builtAt
    ? (runAt.getTime() - Date.parse(meta.builtAt)) / 86400000
    : Infinity;

  // ---- v102 ★2: 新しく足したリーグは、IDを照合してから使う ----
  //   /leagues?id= で国・種別・名前が想定どおりだったリーグだけを取り込む(結果は30日保存。通信はリーグごとに1回)。
  //   照合に通らなかった・まだ照合できていないリーグは取り込まず、理由を目次(meta.leagueChecks)に残す。
  let leagueChecks = { byId: {}, okIds: new Set(), requests: 0, errors: [] };
  try { leagueChecks = await ensureLeagueChecks(deps, runAt); }
  catch (e) { leagueChecks.errors.push(`league_check_error:${(e && e.message) || e}`); noteVia(deps, "league_check_failed", e); }
  const wantLeagues = DEFAULT_BACKFILL_LEAGUES.filter((l) => !l.verify || leagueChecks.okIds.has(l.id));
  // 保存済みのデータセットに入っているリーグを「学習した大会」に反映する(作り直す前の時点の事実)
  activateFromMeta(meta);

  // v47: 設定上のリーグ構成が保存済みデータと違う場合(リーグを増やした直後)は、
  // 週1回の更新日を待たずに作り直す。そうしないと拡張が最長7日間反映されない。
  const wantIds = wantLeagues.map((l) => l.id);
  const haveIds = (meta && Array.isArray(meta.leagues)) ? meta.leagues : [];
  const leagueSetChanged = existing.rows.length > 0 && wantIds.some((id) => !haveIds.includes(id));
  // v50/v53: 行フォーマットが古い(チームIDやチーム名対応表が無い)場合も
  // 更新日を待たずに作り直す(1回だけ約29リクエスト。以降は週1回に戻る)。
  const rowsFormatOld = existing.rows.length > 0 && (!meta || meta.rowsVersion !== ROWS_VERSION);

  const leagueCheckSummary = summarizeLeagueChecks(leagueChecks.byId);
  // v102: 軽い設定のあいだは取り直さない(取り直しは全部の試合をメモリに載せるため)。
  //   保存済みの過去試合を1件も読めなかった日(保存先の不調など)も、取り直さずに、その回の調整を見送る
  //   (軽い設定は「前回この段階で処理ごと止まった」あとの状態なので、いちばん重い処理を、印を置かずに走らせない)。
  if (safeMode) {
    return {
      ...existing, refreshed: false, leagueChecks: leagueCheckSummary, leagueCheckErrors: leagueChecks.errors.slice(0, 10),
      reasonJa: existing.rows.length > 0
        ? `軽い設定で動かしているため、保存済みの過去試合のうち新しい${existing.rows.length}件だけを使い、取り直しは見送りました。`
        : "軽い設定で動かしていますが、保存済みの過去試合を読み出せなかったため、今回の過去試合によるモデル調整は見送りました。",
    };
  }
  if (existing.rows.length > 0 && ageDays < REFRESH_DAYS && !leagueSetChanged && !rowsFormatOld) {
    return { ...existing, refreshed: false, reasonJa: null, leagueChecks: leagueCheckSummary, leagueCheckErrors: leagueChecks.errors.slice(0, 10) };
  }

  // 取り直しに必要なリクエスト数 = リーグごとのシーズン数の合計+予備(v102: 31大会なら約160件。3日に1回/構成変更時のみ)。
  // 余裕が無ければ次回に回す。
  const seasonsOf = (l) => seasonsForLeague(l, runAt, 5);
  const NEEDED = wantLeagues.reduce((sum, l) => sum + seasonsOf(l).length, 0) + 2;
  if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(NEEDED)) {
    return {
      ...existing, refreshed: false, leagueChecks: leagueCheckSummary, leagueCheckErrors: leagueChecks.errors.slice(0, 10),
      reasonJa: `過去試合の取り直しに必要な約${NEEDED}リクエストの余裕が無いため、今回は見送りました(既存の${existing.rows.length}件で学習します)。`,
    };
  }

  // v58: 3→5シーズンへ拡張(利用者のご要望「ここ何年かの過去データを全て」)。
  // 時間減衰(ξ=0.0065/日)により古いシーズンの影響は自然に小さくなる
  // (それが正しい設計: 3年前の強さは今の強さではない)が、リーグ間較正の
  // 実対戦サンプルと、直近データが薄いクラブの土台としては効く。
  const seasons = seasonsToFetch(runAt, 5);
  // v102 ★2: 照合に通ったリーグだけを、リーグごとのシーズンの数え方で取得する(暦年のリーグは年の数え方が違う)
  const fetched = await backfillSeasons(deps, { leagues: wantLeagues, seasonsOf });
  if (!fetched.matches.length) {
    return {
      ...existing, refreshed: false, leagueChecks: leagueCheckSummary, leagueCheckErrors: leagueChecks.errors.slice(0, 10),
      reasonJa: `過去試合を取得できませんでした(${(fetched.errors[0] || "理由不明")})。既存の${existing.rows.length}件で学習します。`,
    };
  }
  // v102: ここから先は、保存済みの古い行を使わない。新しい行を作る前に手放して、古い行と新しい行を同時に持たないようにする
  existing = null;
  collect();
  const rows = buildTrainingRows(fetched.matches, 10);
  const fetchedCount = fetched.matches.length;
  const newMeta = {
    builtAt: runAt.toISOString(),
    // v53: 地力ランキングの表示用(teamId→チーム名)。約200件・数KB。
    namesById: buildTeamNamesById(fetched.matches),
    seasons,
    // v102 ★2: 実際に取り込んだリーグ(照合に通ったものだけ)。これが「学習した大会」の根拠になる
    leagues: wantIds,
    matchesFetched: fetchedCount,
    trainingRows: rows.length,
    apiRequests: fetched.requests + leagueChecks.requests,
    errors: fetched.errors.slice(0, 10),
    skipped: fetched.skipped,
    droppedOldest: fetched.droppedOldest || 0,           // 上限を超えて使わなかった古い試合の数(0 が正常)
    leagueChecks: leagueCheckSummary,                    // 新リーグの照合の結果(通った/通らなかった/まだ)
    leagueCheckErrors: leagueChecks.errors.slice(0, 10),
  };
  // ---- 検証で判明した欠陥の修正 ----
  //   保存の成否を捨てていたため、1件も保存できていない日でも
  //   「作りました」と成功を報告し、翌日また15リクエストを使っていた。
  // v102: 取得した試合の一覧も、行を作り終えたら手放す(件数だけ残す)
  fetched.matches = null;
  collect();
  const saveRes = await saveDataset(deps, rows, newMeta);
  const saved = saveRes && saveRes.saved === true;
  // 保存できたら、取り込んだ新リーグを「学習した大会」に反映する(保存できていなければ反映しない)
  if (saved) activateFromMeta(newMeta);
  return {
    rows, meta: { ...newMeta, ...(saveRes && saveRes.meta ? saveRes.meta : {}) },
    refreshed: saved,
    saved,
    leagueChecks: leagueCheckSummary, leagueCheckErrors: leagueChecks.errors.slice(0, 10),
    reasonJa: saved
      ? `過去${seasons.length}シーズン×${wantLeagues.length}リーグから${fetchedCount}試合を取得し、${rows.length}件の学習データを作りました(APIリクエスト${fetched.requests}件)。`
        + ((saveRes && saveRes.reasonJa) ? saveRes.reasonJa : "")
      // v102: 1文ずつ独立した形にした(かっこの中に別の文を埋めない。強調の記号 ** は画面にそのまま出てしまうので使わない)
      : `過去試合${fetchedCount}件から${rows.length}件の学習データを作りましたが、保存に失敗しました。${(saveRes && saveRes.reasonJa) || "理由は記録できませんでした。"}今日の学習には使いますが、次回は取り直しになります。`,
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
      features: computeMatchFeatures(r.homeCtx, r.awayCtx, r.h2h || null), // v102(B): 行が持つ対戦成績を使う
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
    // v61: ホーム/アウェイの基礎得点も、特徴量ではないが常に学習対象にする。
    //   これが固定値だったために「常にホーム」にすら負ける状態が続いていた。
    presentKeys.add("homeBase");
    presentKeys.add("awayBase");
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

/* ============================================================================
 * v102(2026年11月17日)・B「過去試合を主な教材に」: 前向きの交差検証で採否を決める
 * ----------------------------------------------------------------------------
 * ■ これまで(legacy)
 *   過去試合を古い7割・新しい3割に1回だけ分け、7割で候補を作り、3割で多指標の比較をしていた。
 *   学習用の行に付けるレーティングは、その行自身の結果も使って学習したもの(標本内)だった。
 *
 * ■ ここでやること(CORPUS_GATE_MODE=cv・既定)
 *   過去試合を時系列の順に5つのかたまりに分ける。
 *     ・かたまりk の行には「かたまり1〜k-1 だけで学習したレーティング」を付ける(その試合の結果を見ていない=標本外)。
 *       最初のかたまりにはレーティングを付けない(それより前の試合が無いため)。
 *     ・折k: かたまり1〜k-1 だけで重みを学習し(時間減衰の基準はかたまりk の始まり)、かたまりk で現行の重みと比べる。
 *   後ろ4つのかたまり(全体の約8割)の試合1件ごとの「現行の損失 − 候補の損失」を束ねて、平均・標準誤差・z を出す。
 *   関門(改善の大きさ・z・改善した折の数・的中率)を通ったら、全件で学習し直した重みを候補にする。
 *   さらに、その重みが**自社予想の記録(本番と同じ特徴量。市場オッズ・怪我なども入っている)でも悪化しない**ことを確かめる。
 *   学習するのは「過去試合に実際に値がある特徴量」の重みだけ(市場オッズ・怪我・xG・出場停止・主力評価点は動かさない)。
 * ========================================================================== */
const CORPUS_CV_DEFAULTS = { folds: 5, minGain: 0.001, minZ: 1.64, accTolPt: 0.5, minN: 1000, iterations: 25, guardMinRecords: 100, guardMaxLoss: 0.002 };
function corpusGateOptions(opts) {
  const env = (name, def) => (process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : def);
  const o = (opts && opts.corpusGate) || {};
  const pick = (k, envName) => (Number.isFinite(o[k]) ? o[k] : env(envName, CORPUS_CV_DEFAULTS[k]));
  const modeRaw = String((opts && opts.gateMode) || process.env.CORPUS_GATE_MODE || "cv").toLowerCase();
  return {
    mode: modeRaw === "legacy" ? "legacy" : "cv",
    folds: Math.max(3, Math.min(10, Math.floor(pick("folds", "CORPUS_GATE_CV_FOLDS")))),
    minGain: pick("minGain", "CORPUS_GATE_MIN_LOGLOSS_GAIN"),
    minZ: pick("minZ", "CORPUS_GATE_MIN_Z"),
    accTolPt: pick("accTolPt", "CORPUS_GATE_ACCURACY_TOLERANCE_PT"),
    minN: Number.isFinite(o.minN) ? o.minN : CORPUS_CV_DEFAULTS.minN,
    iterations: Number.isFinite(o.iterations) ? o.iterations : CORPUS_CV_DEFAULTS.iterations,
    guardMinRecords: Number.isFinite(o.guardMinRecords) ? o.guardMinRecords : CORPUS_CV_DEFAULTS.guardMinRecords,
    guardMaxLoss: Number.isFinite(o.guardMaxLoss) ? o.guardMaxLoss : CORPUS_CV_DEFAULTS.guardMaxLoss,
  };
}
/** 1件の損失(学習の損失と同じ下限 0.005)と的中(本番と同じ「引き分け帯」の判定) */
function recordLoss(rec, w) {
  const po = predictOutcomeV2(rec.features, w);
  const rho = w && Number.isFinite(w.rho) ? w.rho : 0;
  const pr = computeMatchProbabilitiesRaw(po.homeLambda, po.awayLambda, undefined, rho);
  const pFrac = rec.actualWinner === "home" ? pr.homeWin : rec.actualWinner === "away" ? pr.awayWin : pr.draw;
  return { nll: -Math.log(Math.max(0.005, pFrac)), hit: po.predictedWinner === rec.actualWinner ? 1 : 0 };
}
/**
 * 過去試合の前向き交差検証。
 * @param {Array} rows 日付の昇順の行(buildTrainingRows の形。クラブElo・xG は呼び出し側で付けてあってよい)
 * @param {object} base 現行の重み
 * @param {Date} runAt
 * @param {{ xgAlpha, xi, perLeagueHomeAdv }} ratingOpts 選ばれたレーティングの設定(従来の選び方のまま)
 * @param {object} gate corpusGateOptions の戻り値
 * @returns {{ cv, decision, prepared, keys, finalWeights, foldWeights, blocks, ratingFits, fitMs }}
 */
function corpusForwardCv(rows, base, runAt, ratingOpts, gate) {
  const t0 = Date.now();
  const ro = ratingOpts || {};
  // v102: 区切り(時期ごとのレーティング学習・折ごとの重みの学習)のたびに呼ぶ合図。呼び出し側がメモリの片づけに使う(計算の結果には関わらない)
  const step = typeof gate.onStep === "function" ? gate.onStep : () => {};
  const blocks = timeBlocks(rows.length, gate.folds);
  const prepared = new Array(rows.length);
  const ratingFits = [];
  for (let f = 0; f < blocks.length; f++) {
    const [bs, be] = blocks[f];
    step();
    let ratings = null, fitError = null;
    if (f > 0 && bs > 0) {
      const startMs = Date.parse(rows[bs].date);
      const nowMs = Number.isFinite(startMs) ? startMs : runAt.getTime();
      const past = rows.slice(0, bs);
      try {
        ratings = fitTeamRatings(past, { nowMs, xgAlpha: ro.xgAlpha || 0, decayXiPerDay: ro.xi, perLeagueHomeAdv: !!ro.perLeagueHomeAdv });
        // リーグ別ホームの学習だけが失敗したかたまりは、全体共通値で作り直す(レーティング無しのかたまりを作らない)
        if (!(ratings && ratings.available) && ro.perLeagueHomeAdv) ratings = fitTeamRatings(past, { nowMs, xgAlpha: ro.xgAlpha || 0, decayXiPerDay: ro.xi });
      } catch (e) { ratings = null; fitError = String((e && e.message) || e).slice(0, 120); } // 失敗した時期はレーティング無しで続ける(理由は記録に残す)
      ratingFits.push({ block: f, rows: past.length, available: !!(ratings && ratings.available), teams: ratings && ratings.available ? ratings.teamsRated : 0, ...(fitError ? { error: fitError } : {}) });
    }
    for (let i = bs; i < be; i++) {
      const r = rows[i];
      // 行に既に付いているレーティング由来の値(全体・学習用で学習したもの=その試合の結果を見ている)は使わない
      const hc = { ...(r.homeCtx || {}) }, ac = { ...(r.awayCtx || {}) };
      delete hc.ratingExpGoals; delete ac.ratingExpGoals;
      if (ratings && ratings.available) {
        const eg = expGoalsFromRatings(ratings, r.homeId, r.awayId, r.leagueId);
        if (eg) { hc.ratingExpGoals = eg.home; ac.ratingExpGoals = eg.away; }
      }
      prepared[i] = { features: computeMatchFeatures(hc, ac, r.h2h || null), actualWinner: r.actualWinner, date: r.date, leagueId: r.leagueId ?? null };
    }
  }
  // 学習するのは、過去試合に実際に値がある特徴量の重みだけ(fitHistoryWeights と同じ決め方)
  const presentKeys = new Set();
  const maps = { ...FEATURE_WEIGHT_MAP, ...FEATURE_SUM_WEIGHT_MAP };
  for (const [fKey, wKey] of Object.entries(maps)) {
    if (prepared.some((r) => r && r.features && r.features[fKey])) presentKeys.add(wKey);
  }
  presentKeys.add("rho"); presentKeys.add("homeBase"); presentKeys.add("awayBase");
  const keys = [...presentKeys];
  const fitOn = (records, refMs) => fitWeightsGradientDescent(records, base, {
    keys, iterations: gate.iterations,
    sampleWeightOf: (r) => timeDecayWeight(r.date, refMs, 0.0065),
  });
  const foldWeights = {};
  const cv = crossValidate(prepared, {
    folds: gate.folds, scheme: "forward", minValid: 200, minTrain: 500,
    procedure: (train, info) => {
      step();
      const startMs = Date.parse(rows[info.validStart].date);
      const w = fitOn(train, Number.isFinite(startMs) ? startMs : runAt.getTime());
      if (w) foldWeights[info.fold] = w;
      return w;
    },
    lossOf: recordLoss, baseWeights: base,
    groupOf: (r) => r.leagueId ?? 0, // リーグ別の内訳(画面の表と、新しく足したリーグの確認用)
  });
  const decision = decideCvGate(cv, { minN: gate.minN, minGain: gate.minGain, minZ: gate.minZ, accTolPt: gate.accTolPt });
  // 通ったときだけ、全件で学習し直す(時間減衰の基準は「いま」)
  let finalWeights = null;
  if (decision.pass) {
    step();
    finalWeights = fitOn(prepared, runAt.getTime());
    if (finalWeights && !isSaneWeights(finalWeights)) finalWeights = null;
  }
  return { cv, decision, prepared, keys, finalWeights, foldWeights, blocks, ratingFits, fitMs: Date.now() - t0 };
}
/**
 * 交差検証のリーグ別の内訳を、画面にそのまま出せる表にする(v101 までの「リーグ別の比較表」の代わり)。
 * 判定は、そのリーグの試合だけで束ねた z による(試合が少ないリーグは「判定不可」)。
 */
function cvLeagueRows(cv) {
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  return ((cv && cv.byGroup) || []).map((g) => ({
    leagueId: g.key, leagueJa: LEAGUE_NAMES_JA[g.key] || `リーグ${g.key}`,
    n: g.n, baseLogLoss: r4(g.baseNll), candLogLoss: r4(g.candNll), gain: r4(g.gain), z: r2(g.z),
    baseAccuracyPct: g.accBasePct, candAccuracyPct: g.accCandPct,
    verdictJa: g.n < 100 ? "判定不可(試合が少ない)" : (g.z >= 1.64 ? "改善" : (g.z <= -1.64 ? "悪化" : "差は誤差の範囲")),
  }));
}
function formatCvLeagueTableJa(rows, cvSummary) {
  if (!rows || !rows.length) return "リーグ別の比較はできませんでした。";
  const lines = ["| リーグ | 試合数 | LogLoss(現行→候補) | 的中率(現行→候補) | 判定 |", "|---|---|---|---|---|"];
  for (const l of rows) {
    lines.push(`| ${l.leagueJa} | ${l.n} | ${l.baseLogLoss}→${l.candLogLoss} | ${l.baseAccuracyPct}%→${l.candAccuracyPct}% | ${l.verdictJa} |`);
  }
  lines.push("");
  lines.push("各リーグの数字は、時系列の前向き検証(その試合より前の試合だけで学習したレーティングと重み)で測ったものです。");
  if (cvSummary && Number.isFinite(cvSummary.pooledGain)) {
    lines.push(`全体: 検証${cvSummary.n}件・LogLoss ${cvSummary.baseLogLoss}→${cvSummary.candLogLoss}(改善 ${cvSummary.pooledGain}・z=${cvSummary.z})`);
  }
  return lines.join("\n");
}

/**
 * 過去試合の交差検証の結果を、画面に出す理由の文にまとめる(純関数)。
 * 文は「1文ずつ独立した形」で並べる(画面は「。」で区切って1文ずつ訳すため。文の中に別の文を埋め込まない)。
 */
function composeCorpusCvReasonJa({ rows, folds, decision, hasFinalWeights, guard }) {
  const introJa = `過去試合${rows}件を、古い順に${folds}つの時期に分け、前の時期だけで学習した重みを次の時期で確かめました(前向きの交差検証)。`;
  const d = (decision && decision.reasonJa) || "";
  if (!decision || !decision.pass) return `${introJa}${d}モデルは変更しません。`;
  if (!hasFinalWeights) return `${introJa}${d}交差検証は通りましたが、全件での学習が収束しなかった(または結果が保存基準を満たさなかった)ため、モデルは変更しません。`;
  const g = (guard && guard.reasonJa) || "";
  return guard && guard.ok ? `${introJa}${d}${g}全件で学習し直した重みを採用します。` : `${introJa}${d}${g}そのため採用しません。`;
}

/** 自社予想の記録(本番と同じ特徴量)で、候補の重みが現行より悪くなっていないか */
function ownRecordsGuard(records, base, cand, gate) {
  const usable = (records || []).filter((r) => r && r.actualWinner && r.features && typeof r.features === "object");
  if (usable.length < gate.guardMinRecords) {
    return { checked: false, ok: true, n: usable.length, reasonJa: `自社予想の記録が${usable.length}件で、確認に必要な${gate.guardMinRecords}件に達していないため、この確認は行っていません。` };
  }
  const diffs = []; let bHit = 0, cHit = 0, bSum = 0, cSum = 0;
  for (const r of usable) {
    const b = recordLoss(r, base), c = recordLoss(r, cand);
    diffs.push(b.nll - c.nll); bHit += b.hit; cHit += c.hit; bSum += b.nll; cSum += c.nll;
  }
  const st = pairedStats(diffs);
  const n = usable.length;
  const accDeltaPt = Math.round(((cHit - bHit) / n) * 1000) / 10;
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const ok = st.gain !== null && st.gain >= -gate.guardMaxLoss && accDeltaPt >= -gate.accTolPt;
  return {
    checked: true, ok, n, gain: r4(st.gain), z: Number.isFinite(st.z) ? Math.round(st.z * 100) / 100 : null,
    baseLogLoss: r4(bSum / n), candLogLoss: r4(cSum / n), accDeltaPt,
    reasonJa: ok
      ? `自社予想の記録${n}件でも悪化していません(LogLoss ${r4(bSum / n)}→${r4(cSum / n)}・的中率の変化 ${accDeltaPt >= 0 ? "+" : ""}${accDeltaPt}pt)。`
      : `自社予想の記録${n}件では悪化しました(LogLoss ${r4(bSum / n)}→${r4(cSum / n)}・的中率の変化 ${accDeltaPt >= 0 ? "+" : ""}${accDeltaPt}pt/許容は LogLoss +${gate.guardMaxLoss} まで・的中率 −${gate.accTolPt}pt まで)。`,
  };
}

/**
 * v102(B): 交差検証の関門の1回ぶん(同期の関数。中身は、以前 tuneModelOnHistory の中に直接書いていたものと同じ)。
 *   前向きの交差検証 → 自社予想の記録での確認 → 引き分け帯 → 記録用の要約 までを行い、小さな結果だけを返す。
 *   全試合ぶんの特徴量(res.prepared)などの大きなデータは、この関数が戻るときに手放される。
 */
function corpusCvGateStep(a) {
  const { rows, base, runAt, ratingOpts, corpusGate, guardRecords, chooseDrawBand, drawBandDefault, onStep } = a;
  const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const res = corpusForwardCv(rows, base, runAt, ratingOpts, { ...corpusGate, onStep });
  const cv = res.cv;
  let ownGuard = null;
  let adoptW = null;
  if (res.decision.pass && res.finalWeights) {
    ownGuard = ownRecordsGuard(guardRecords, base, res.finalWeights, corpusGate);
    if (ownGuard.ok) adoptW = res.finalWeights;
  }
  const reasonJa = composeCorpusCvReasonJa({
    rows: rows.length, folds: corpusGate.folds, decision: res.decision, hasFinalWeights: !!res.finalWeights, guard: ownGuard,
  });
  const cvLeagues = cvLeagueRows(cv);
  const corpusCv = {
    ...summarizeCv(cv, res.decision), keys: res.keys, ratingFits: res.ratingFits, ms: res.fitMs,
    minGain: corpusGate.minGain, minZ: corpusGate.minZ, accTolPt: corpusGate.accTolPt,
    byLeague: cvLeagues,
    noteJa: `時系列${corpusGate.folds}ブロックの前向き検証。各ブロックの試合には、それより前の試合だけで学習したレーティングと重みを当てています(標本外)。`,
  };
  const cvLeagueTableJa = formatCvLeagueTableJa(cvLeagues, corpusCv);
  // 引き分け帯: 重みを採用するときだけ、最後の折(それより前だけで学習した重み × 最後のかたまり)で従来と同じ門番にかける
  const baseBand = Number.isFinite(base.drawBand) ? base.drawBand : drawBandDefault;
  let drawBandChosen, drawBandDetail;
  if (adoptW) {
    const lastFold = res.blocks.length - 1;
    const lastW = res.foldWeights[lastFold] || adoptW;
    const lastRows = res.prepared.slice(res.blocks[lastFold][0], res.blocks[lastFold][1]);
    const round1 = (x) => Math.round(x * 10) / 10;
    const cvScoreBand = (b) => {
      let n = 0, correct = 0, drawPred = 0, drawAct = 0, drawHit = 0;
      const wb = { ...lastW, drawBand: b };
      for (const r of lastRows) {
        const p = predictOutcomeV2(r.features, wb).predictedWinner;
        n++; if (p === r.actualWinner) correct++;
        if (p === "draw") drawPred++;
        if (r.actualWinner === "draw") { drawAct++; if (p === "draw") drawHit++; }
      }
      return { band: b, accuracyPct: n ? round1((correct / n) * 100) : null, drawPredictedCount: n ? drawPred : null, drawRecallPct: drawAct ? round1((drawHit / drawAct) * 100) : null };
    };
    const db = chooseDrawBand(cvScoreBand, lastRows.length);
    drawBandChosen = db.chosen; drawBandDetail = db.detail;
  } else {
    drawBandChosen = baseBand;
    drawBandDetail = { chosen: baseBand, default: drawBandDefault, reasonJa: "重みを採用しなかったため、引き分け帯は変更していません。" };
  }
  const candidateWeights = adoptW ? { ...adoptW, drawBand: drawBandChosen } : { ...base };
  // 記録に残す成績は「束ねた検証」(後ろ4ブロック)での値。測っていない指標は null(compare が「測定できませんでした」と書く)
  const evalOf = (nll, accPct) => ({
    measurable: cv.n > 0, sampleSize: cv.n, accuracyPct: accPct, logLoss: r4(nll), brier: null,
    scorelineTop1Pct: null, scorelineTop3Pct: null, bttsAccuracyPct: null, overUnderAccuracyPct: null, totalGoalsMae: null,
    drawRecallPct: null, drawPrecisionPct: null, drawPredictedCount: null, drawActualCount: null,
  });
  return {
    ownGuard, corpusCv, cvLeagueTableJa, drawBandChosen, drawBandDetail, candidateWeights,
    oldEval: evalOf(cv.baseNll, cv.accBasePct),
    newEval: evalOf(cv.candNll, cv.accCandPct),
    decision: { adopt: !!adoptW, consistencyChecked: false, reasonJa, secondaryGains: null },
    gradFit: { detail: { ran: true, keys: res.keys, rows: rows.length, iterations: corpusGate.iterations, decayXiPerDay: 0.0065, ms: res.fitMs,
      noteJa: `過去試合${rows.length}件を${corpusGate.folds}つのかたまりに分け、前のかたまりだけで${res.keys.length}個の重みを学習して次のかたまりで確かめました(所要${(res.fitMs / 1000).toFixed(1)}秒)。` } },
    candidateFormDetail: { gridLogLoss: null, gradAddLogLoss: null, gradMultLogLoss: null, chosenForm: base.modelForm === "mult" ? "mult" : "add",
      noteJa: "交差検証の関門では、現行のモデルの形(加法/乗法)のまま重みを学習します。" },
  };
}

/* ============================================================================
 * v102: 交差検証に入る前の、メモリの余裕の確認
 * ----------------------------------------------------------------------------
 *   前向きの交差検証は、④-b の中でいちばんメモリを使う(全試合ぶんの特徴量を、行とは別に持つ)。
 *   この環境の実測(合成 31大会・51,925行):
 *     ・交差検証の中で増える「生きているメモリ」は 約20MB(特徴量 1行あたり約376バイト)+学習の作業領域
 *     ・片づけ(GC)が空回りしないための余白が、さらに 十数MB 要る(余白が足りないと、Node は「片づけても空かない」と判断して止まる)
 *     ・Node の上限(heap_size_limit)には、新しいオブジェクト用の領域(48MB)も含まれる
 *   そこで、検証の直前に測った値から
 *       Node の空き   = Node の上限 − 使用中                  … 目安 = 64MB + 行数 × 0.00048MB(51,925行で 89MB)
 *       サーバーの空き = 入れ物の上限 −(使用中 − Node が確保済みで空いている量) … 目安 = 40MB + 行数 × 0.0008MB(51,925行で 82MB)
 *   を出し、どちらかが目安に届かない回は、検証を見送る(落ちる前にやめる。重みは変えない。理由と数字を記録に残す)。
 *   目安の確かめ(この環境・Node 22・同じ 51,925行): 確認を止めて上限を変えながら走らせると、Node の空きが 83MB 以上なら完走し、
 *   76MB では途中で止まった。目安の 89MB は、止まった条件より 13MB 上・完走できた最小の条件より 6MB 上(少し厳しめ)。
 *   上限を読めない環境では、その項目は確かめられない(null。見送らない)。片づけ(GC)を呼べない環境でも確かめない(使用中の量が当てにならないため)。
 *   環境変数 TUNE_MEMORY_CHECK=off で確認そのものを止められる。
 *   これで防げないもの(上限を読めない環境での不足など)は、下の安全弁が受ける。
 * ========================================================================== */
const CV_MEMORY_RULE = { heapBaseMb: 64, heapPerRowMb: 0.00048, rssBaseMb: 40, rssPerRowMb: 0.0008 };
function cvMemoryCheck(rowCount, snap, limits, ruleOverride, measuredAfterGc) {
  const rule = { ...CV_MEMORY_RULE, ...(ruleOverride || {}) };
  const disabled = String(process.env.TUNE_MEMORY_CHECK || "").toLowerCase() === "off";
  const num = (x) => Number.isFinite(x);
  const heapNeedMb = Math.ceil(rule.heapBaseMb + rowCount * rule.heapPerRowMb);
  const rssNeedMb = Math.ceil(rule.rssBaseMb + rowCount * rule.rssPerRowMb);
  // 片づけ(GC)を呼べなかった環境では、「使用中」に片づけ前のごみが含まれる(この環境の実測: 片づけたあと 37MB のところ、片づけないと 94MB)。
  // その値で空きを出すと小さく見積もってしまい、要らない見送りになるので、確かめない(null。安全弁が受ける)。
  const gcUnavailable = measuredAfterGc === false;
  const heapFreeMb = !gcUnavailable && limits && num(limits.heapLimitMb) && snap && num(snap.heapUsedMb) ? limits.heapLimitMb - snap.heapUsedMb : null;
  const reusableMb = snap && num(snap.heapTotalMb) && num(snap.heapUsedMb) ? Math.max(0, snap.heapTotalMb - snap.heapUsedMb) : 0;
  const rssFreeMb = !gcUnavailable && limits && num(limits.constrainedMb) && snap && num(snap.rssMb) ? limits.constrainedMb - (snap.rssMb - reusableMb) : null;
  const heapOk = heapFreeMb === null || heapFreeMb >= heapNeedMb;
  const rssOk = rssFreeMb === null || rssFreeMb >= rssNeedMb;
  const ok = disabled || (heapOk && rssOk);
  let reasonJa = null;
  if (!ok) {
    reasonJa = !heapOk
      ? `メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました(Node の空き ${heapFreeMb}MB・必要の目安 ${heapNeedMb}MB)。`
      : `メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました(サーバーの空き ${rssFreeMb}MB・必要の目安 ${rssNeedMb}MB)。`;
  }
  return {
    ok, checked: !disabled && (heapFreeMb !== null || rssFreeMb !== null), ...(disabled ? { disabled: true } : {}),
    ...(gcUnavailable ? { gcUnavailable: true } : {}),
    rows: rowCount, heapFreeMb, heapNeedMb, rssFreeMb, rssNeedMb, reasonJa,
  };
}

/* ============================================================================
 * v102: ④-b の安全弁(処理ごと止まっても、次の実行が自分で軽い設定に切り替えて完走する)
 * ----------------------------------------------------------------------------
 *   学習リーグを増やすと、④-b が同時に持つ試合の数は約2倍になる。本番の機械のメモリの上限は外から測れないので、
 *   上の「余裕の確認」で防げなかった場合(上限を読めない環境・取り直しの最中の不足など)に備える:
 *     ・④-b の重い処理のあいだだけ、保存先に「実行中の印」(learn:tuning:inflight)を置く。段階が進むたびに書き直す
 *       (どの段階まで進んでいたか・そのときのメモリの実測が残る)。正常に終わったとき・例外で終わったときは消す。
 *       処理ごと止まったとき(メモリ不足で強制終了されたときなど)だけ、印が残る。
 *     ・次に ④-b に来たとき、印が残っていたら「前回はこの段階の途中で処理ごと止まった」と分かる。そこから3日間は軽い設定で動かす:
 *         - 保存済みの過去試合のうち、新しいほうの 20 ブロック(24,000行)だけを読む(学習リーグを増やす前と同じくらいの量)
 *         - 重みの交差検証はしない(重みは変えない)。地力レーティングの更新など、ほかの処理は続ける
 *         - 過去試合の取り直しはしない
 *     ・3日たつと、通常の設定で1回確かめる。走り切れたら記録を消す(元どおり)。そこでも止まったら、今度は14日間、軽い設定にする
 *       (確かめるたびに止まるのを、3日おきに繰り返さないため)。
 *     ・次のものは「止まった」と数えない(軽い設定にしない):
 *         - 印を置いたときとプログラムの版が違う(そのあいだに配備があった = 配備による再起動)
 *         - 終了の合図(SIGTERM / SIGINT)を受けて終わった(server.js が、終わる前に印を消す)
 *         - この処理自身が置いた印が、消す操作の失敗で残っていただけ
 *         - 例外で終わった(処理は生きている)
 *       ただし、終了の合図を受けても、重い計算の最中で30秒以内に応じられなかったときは印が残る(版が同じなら、軽い設定で3日動く。害はない)。
 *     ・状態は記録(crashGuard)・成長ログ・健康診断に残る。黙って切り替えない。
 * ========================================================================== */
const TUNE_INFLIGHT_KEY = "learn:tuning:inflight";
const TUNE_SAFEMODE_KEY = "learn:tuning:safemode";
const SAFE_MODE_DAYS = 3;          // 1回め: 3日間
const SAFE_MODE_DAYS_REPEAT = 14;  // 通常の設定に戻して確かめた回でも止まったとき: 14日間
const SAFE_MODE_LAST_SHARDS = 20;  // 20ブロック = 24,000行
const TUNE_INFLIGHT_TTL_SEC = 7 * 86400;
const TUNE_SAFEMODE_TTL_SEC = 45 * 86400;
// この処理(プロセス)の目印。起動のたびに変わる
const PROCESS_BOOT_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** いま動いているプログラムの版(Render が入れる、配備したコミットの番号の先頭12文字。無い環境では null) */
function codeCommit() {
  const c = process.env.RENDER_GIT_COMMIT;
  return typeof c === "string" && c ? c.slice(0, 12) : null;
}
const jstStampOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ") : String(iso || "不明");
};

/** この機械と Node のメモリの上限(記録用)。読めない値は null */
function memoryLimits() {
  const mb = (x) => (Number.isFinite(x) && x > 0 && x < 2 ** 50 ? Math.round(x / 1048576) : null);
  let heapLimit = null, constrained = null, total = null;
  try { heapLimit = require("v8").getHeapStatistics().heap_size_limit; } catch (e) { heapLimit = null; }
  try { constrained = typeof process.constrainedMemory === "function" ? process.constrainedMemory() : null; } catch (e) { constrained = null; }
  try { total = require("os").totalmem(); } catch (e) { total = null; }
  // heapLimitMb = Node(V8)が自分に許している上限 / constrainedMb = 入れ物(コンテナ)の上限(制限なし・不明は null) / totalMemMb = 機械から見えているメモリ
  return { node: process.version, heapLimitMb: mb(heapLimit), constrainedMb: mb(constrained), totalMemMb: mb(total) };
}
/** いまのメモリの実測(記録用)。取れない値は null。maxRssMb は、この処理が起動してからの最大値 */
function memorySnapshot() {
  const mb = (x) => (Number.isFinite(x) ? Math.round(x / 1048576) : null);
  let m = null, maxRssKb = null;
  try { m = process.memoryUsage(); } catch (e) { m = null; }
  try { maxRssKb = process.resourceUsage().maxRSS; } catch (e) { maxRssKb = null; }
  return {
    rssMb: m ? mb(m.rss) : null, heapUsedMb: m ? mb(m.heapUsed) : null, heapTotalMb: m ? mb(m.heapTotal) : null,
    externalMb: m ? mb(m.external) : null,
    maxRssMb: Number.isFinite(maxRssKb) && maxRssKb > 0 ? Math.round(maxRssKb / 1024) : null,
  };
}
// ---- メモリの片づけ(GC)を、こちらの決めた区切りで行う ----
//   Node は普段、片づけの時期を自分で決める。入れ物(コンテナ)のメモリの上限を Node が読めている環境では、上限に近づく前に
//   片づけが走るが、読めていない環境では「まだ余裕がある」と見て片づけを後回しにし、使う量が大きく膨らむことがある
//   (この環境の実測・合成 31大会 51,925行・Node に上限を知らせない場合: ④-b の最大使用量は、片づけを呼ばないと 333MB、呼ぶと 263MB)。
//   そこで、④-b の段階の切れ目で片づけを明示的に呼ぶ(1回の調整で15回前後・合計1秒未満)。計算の結果には関わらない
//   (呼ぶ場合と呼ばない場合で、採否・理由・検証の数字が同じになることをテストで確かめている)。環境変数 TUNE_EXPLICIT_GC=off で止められる。
let gcResolved = false, gcFn = null;
function resolveGc() {
  if (gcResolved) return gcFn;
  gcResolved = true;
  gcFn = null;
  if (String(process.env.TUNE_EXPLICIT_GC || "").toLowerCase() === "off") return gcFn;
  try {
    if (typeof global.gc === "function") { gcFn = global.gc; return gcFn; }
    const v8 = require("v8");
    v8.setFlagsFromString("--expose-gc");
    const f = require("vm").runInNewContext("typeof gc === 'function' ? gc : null");
    v8.setFlagsFromString("--no-expose-gc");
    gcFn = typeof f === "function" ? f : null;
  } catch (e) { gcFn = null; } // 片づけを呼べない環境では、何もしない(Node 任せ = これまでどおり)
  return gcFn;
}
/** ④-b の1回ぶんの、メモリの記録係(段階ごとの実測と、片づけの回数・時間) */
function createMemoryProbe() {
  const marks = {};
  let calls = 0, ms = 0;
  const gc = resolveGc();
  return {
    snap(name) { marks[name] = memorySnapshot(); return marks[name]; },
    collect() {
      if (!gc) return false;
      const t = Date.now();
      try { gc(); } catch (e) { return false; }
      calls++; ms += Date.now() - t;
      return true;
    },
    report() { return { ...memoryLimits(), ...marks, gc: { available: !!gc, calls, ms } }; },
  };
}

/**
 * 安全弁の印・状態の読み書き用: 失敗したら、少し待ってもう1回だけ試す(どれも「同じことを2回やっても結果が変わらない」コマンドだけに使う)。
 *   長い計算の直後は、待機中に相手から切られていた接続に当たって、最初の1回だけ通信が失敗することがある
 *   (模擬世界の通し稽古で実際に起きた: 印の書き直しが "fetch failed")。印を消しそこねると、次の実行が
 *   「前回は途中で止まった」と見誤るので、1回の通信の失敗では諦めない。
 */
async function storeCmdRetryOnce(upstashCmd, cmd) {
  try { return await upstashCmd(cmd); }
  catch (e) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return upstashCmd(cmd);
  }
}

/**
 * 軽い設定で動かすかどうかを決める。
 *   ・軽い設定の期間中 → 軽い設定
 *   ・前回の「実行中の印」が残っている → 途中で処理ごと止まった。ただし次の2つは数えない:
 *       - 印を置いたのがこの処理自身(消す操作が失敗しただけ)
 *       - 印を置いたときとプログラムの版が違う(そのあいだに配備があった = 配備による再起動)
 *     それ以外は、軽い設定の期間を始める(1回め 3日。通常の設定に戻して確かめた回でも止まったら 14日)
 */
async function readCrashGuard(deps, runAt) {
  const { upstashEnabled, upstashCmd } = deps;
  const off = { safeMode: false, since: null, until: null, reasonJa: null, strikes: 0, previousAttempt: null };
  if (!upstashEnabled || typeof upstashCmd !== "function") return off;
  const nowMs = runAt.getTime();
  const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
  try {
    const state = parse(await storeCmdRetryOnce(upstashCmd, ["GET", TUNE_SAFEMODE_KEY]));
    const strikesSoFar = state && Number.isFinite(state.strikes) ? state.strikes : 0;
    if (state && Number.isFinite(Date.parse(state.until)) && Date.parse(state.until) > nowMs) {
      return { safeMode: true, since: state.since || null, until: state.until, reasonJa: state.reasonJa || null, strikes: strikesSoFar, previousAttempt: state.previousAttempt || null };
    }
    // 期間が終わった記録が残っている = 今回は「通常の設定に戻して確かめる回」。走り切れたら、この記録は消す(呼び出し側)
    const trial = state ? { staleState: true, strikes: strikesSoFar } : {};
    const prev = parse(await storeCmdRetryOnce(upstashCmd, ["GET", TUNE_INFLIGHT_KEY]));
    if (!prev || !prev.startedAt) return { ...off, ...trial };
    const prevInfo = {
      startedAt: prev.startedAt, date: prev.date || null, phase: prev.phase || null, at: prev.at || null,
      memory: prev.memory || null, limits: prev.limits || null, commit: prev.commit || null,
    };
    if (prev.boot && prev.boot === PROCESS_BOOT_ID) {
      return { ...off, ...trial, previousAttempt: { ...prevInfo, endedBy: "marker_not_cleared" }, noteJa: "前回の実行の印が、消せずに残っていました(処理は止まっていません)。通常の設定で続けます。" };
    }
    const nowCommit = codeCommit();
    if (prev.commit && nowCommit && prev.commit !== nowCommit) {
      return { ...off, ...trial, previousAttempt: { ...prevInfo, endedBy: "deploy" }, noteJa: "前回の実行は途中で止まっていましたが、そのあとでプログラムの版が替わっているため、配備による再起動とみなして、通常の設定で続けます。" };
    }
    const strikes = strikesSoFar + 1;
    const days = strikes >= 2 ? SAFE_MODE_DAYS_REPEAT : SAFE_MODE_DAYS;
    const until = new Date(nowMs + days * 86400000).toISOString();
    const reasonJa = (strikes >= 2
      ? `過去試合によるモデル調整が、通常の設定に戻して確かめた回でも、途中で処理ごと止まりました(${strikes}回め)。`
      : `前回(日本時間 ${jstStampOf(prev.startedAt)} に開始)の過去試合によるモデル調整は、途中で処理ごと止まっていました。`)
      + `そのため、日本時間 ${jstStampOf(until).slice(0, 10)} までは軽い設定で動かします(新しいほうの過去試合だけを使い、重みの検証は行いません)。`;
    const next = { since: runAt.toISOString(), until, strikes, previousAttempt: { ...prevInfo, endedBy: "process_ended" }, reasonJa };
    await storeCmdRetryOnce(upstashCmd, ["SET", TUNE_SAFEMODE_KEY, JSON.stringify(next), "EX", String(TUNE_SAFEMODE_TTL_SEC)]);
    await storeCmdRetryOnce(upstashCmd, ["DEL", TUNE_INFLIGHT_KEY]);
    return { safeMode: true, ...next };
  } catch (e) {
    noteVia(deps, "tuning_crashguard_read_failed", e); // 読めなかったら通常の設定で進める(記録は残す)
  }
  return off;
}
// この処理が ④-b の「実行中の印」を置いているあいだだけ入っている(終了の合図を受けたときに、印を消してから終わるため)
let inflightHere = null;
/**
 * 終了の合図(SIGTERM / SIGINT)を受けたときに server.js が呼ぶ。④-b の最中なら「実行中の印」を消す。
 * 配備・再起動での終了は「メモリが足りずに落ちた」のとは違うので、次の実行を軽い設定にしない。
 */
async function releaseInflightMarkerOnShutdown() {
  const cur = inflightHere;
  if (!cur) return false;
  inflightHere = null;
  try { await cur.upstashCmd(["DEL", TUNE_INFLIGHT_KEY]); return true; }
  catch (e) { console.warn("[tuning] inflight_release_on_shutdown_failed:", (e && e.message) || e); return false; }
}
async function tuneModelOnHistory(deps, currentWeights, runAt, opts) {
  const { upstashEnabled, upstashCmd } = deps;
  const mem = createMemoryProbe();
  // 開始時: そのままの値(start)と、片づけたあとの値(startAfterGc = この処理が ④-b の前から持っている量)
  mem.snap("start");
  mem.collect();
  mem.snap("startAfterGc");
  const guard = await readCrashGuard(deps, runAt);
  const marking = !!(upstashEnabled && typeof upstashCmd === "function" && !guard.safeMode);
  const markerBase = { startedAt: runAt.toISOString(), date: (opts && opts.dateKey) || null, commit: codeCommit(), boot: PROCESS_BOOT_ID, limits: memoryLimits() };
  // 段階が進むたびに印を書き直す(途中で止まったとき、どの段階まで進んでいたか・そのときのメモリが残る)
  const markPhase = async (phase) => {
    if (!marking) return;
    try {
      await storeCmdRetryOnce(upstashCmd, ["SET", TUNE_INFLIGHT_KEY, JSON.stringify({ ...markerBase, phase, at: new Date().toISOString(), memory: memorySnapshot() }), "EX", String(TUNE_INFLIGHT_TTL_SEC)]);
    } catch (e) { noteVia(deps, "tuning_inflight_mark_failed", e); }
  };
  // 印を書き始める前に「この処理が印を持っている」と覚えておく(書いている最中に終了の合図が来ても、印を消してから終われるように)
  if (marking) inflightHere = { upstashCmd };
  await markPhase("開始");
  let ranToTheEnd = false;
  try {
    const out = await tuneModelOnHistoryInner(deps, currentWeights, runAt, { ...(opts || {}), safeMode: guard.safeMode, crashGuard: guard, mem, markPhase });
    ranToTheEnd = !!(out && out.ran === true);
    return out;
  } finally {
    // 正常に終わったとき・例外で終わったときは印を消す(処理ごと止まったときだけ残る)
    if (marking) {
      inflightHere = null;
      try { await storeCmdRetryOnce(upstashCmd, ["DEL", TUNE_INFLIGHT_KEY]); }
      catch (e) { noteVia(deps, "tuning_inflight_clear_failed", e); }
      // 通常の設定で最後まで走り切れたら、「止まった回数」の記録を消す(次に止まったときは、また1回めから数える)
      if (ranToTheEnd && guard.staleState) {
        try { await storeCmdRetryOnce(upstashCmd, ["DEL", TUNE_SAFEMODE_KEY]); }
        catch (e) { noteVia(deps, "tuning_safemode_reset_failed", e); }
      }
    }
  }
}
async function tuneModelOnHistoryInner(deps, currentWeights, runAt, opts) {
  const { upstashEnabled, upstashCmd, upstashSetJSON } = deps;
  const safeMode = !!(opts && opts.safeMode);
  const crashGuard = (opts && opts.crashGuard) || { safeMode: false };
  const mem = (opts && opts.mem) || createMemoryProbe();
  const markPhase = opts && typeof opts.markPhase === "function" ? opts.markPhase : async () => {};
  // v104.1: 履歴に残す日付は、学習の「今日」(日本時間の日付。呼び出し側が渡す)に揃える。
  //   従来は実行時刻の UTC 日付だったため、日本時間の早朝(UTC では前日)に動く毎日の学習では、
  //   成長ログ・精度の集計(日本時間の日付)より1日前の日付で記録されていた(中身の計算には影響なし。表示上の日付のずれ)。
  const recordDateKey = (opts && typeof opts.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateKey)) ? opts.dateKey : runAt.toISOString().slice(0, 10);
  const ds = await ensureDataset(deps, runAt, { safeMode, collect: () => mem.collect() });
  mem.collect();
  mem.snap("afterDataset");
  await markPhase("過去試合の読み込みのあと");

  // ---- v57: クラブElo(clubelo.com)の履歴を各試合の文脈へ付与 ----
  //   deps.clubEloLookup(teamId, dateMs) が渡された場合のみ。当時のEloが
  //   両チームぶん引けた試合にだけ付く(引けない試合は特徴量0=影響なし)。
  //   これにより clubEloSensitivity が既存の勾配学習+採用ゲートの中で
  //   自動的に学習対象になる(presentKeysの動的検出)。
  let clubEloRowsCount = 0;
  if (typeof deps.clubEloLookup === "function" && ds.rows.length) {
    ds.rows = ds.rows.map((r) => {
      const dMs = Date.parse(r.date);
      const he = deps.clubEloLookup(r.homeId, dMs);
      const ae = deps.clubEloLookup(r.awayId, dMs);
      if (!Number.isFinite(he) || !Number.isFinite(ae)) return r;
      clubEloRowsCount++;
      return { ...r, homeCtx: { ...r.homeCtx, clubElo: he }, awayCtx: { ...r.awayCtx, clubElo: ae } };
    });
  }
  // ---- v57: xG(前向き収集ぶん)を行へ付与(レーティングの有効ゴール用) ----
  let xgRowsCount = 0;
  if (typeof deps.xgLookup === "function" && ds.rows.length) {
    for (const r of ds.rows) {
      const xg = deps.xgLookup(r.date, r.homeId, r.awayId);
      if (xg && Number.isFinite(xg[0]) && Number.isFinite(xg[1])) {
        r.xgH = xg[0]; r.xgA = xg[1]; xgRowsCount++;
      }
    }
  }
  // αの既定は0(=実ゴールのみ)。選択は後段のグリッドで行う(早期returnでも0を開示)
  let xgAlphaChosen = 0, xgAlphaDetail = null;
  let xiChosen = XI_DEFAULT, xiDetail = null; // v71③: 時間減衰ξ(門番付き探索)

  if (!ds.rows.length) {
    return {
      ran: false, adopted: false,
      reasonJa: ds.reasonJa || "過去試合の学習データがまだありません。",
      datasetSize: 0,
      crashGuard, memory: mem.report(),
      leagueChecks: ds.leagueChecks || null, leagueCheckErrors: ds.leagueCheckErrors || null,
    };
  }

  const { train, test } = splitByTime(ds.rows, 0.7);
  if (test.length < 200) {
    return {
      ran: false, adopted: false,
      reasonJa: `検証に使える過去試合が${test.length}件で、判断に必要な200件に達していないため、モデルは変更しません(蓄積: ${ds.rows.length}件)。`,
      datasetSize: ds.rows.length,
      clubEloRows: clubEloRowsCount, // v57: Elo付きで学習に使えた試合数(実測)
      xgAlpha: xgAlphaChosen, xgAlphaDetail, xgRows: xgRowsCount, // v57: xGブレンドの実測
      xi: xiChosen, xiDetail, // v71③: 時間減衰ξの実測
      drawBand: 0.15, drawBandDetail: null, // v78(案1): 検証不足時は既定帯のまま
      datasetNoteJa: ds.reasonJa,
      crashGuard, memory: mem.report(),
      leagueChecks: ds.leagueChecks || null, leagueCheckErrors: ds.leagueCheckErrors || null,
    };
  }

  const base = { ...currentWeights };

  // ---- 基準モデルの固定(共同開発者の要求:採用後も毎日、旧モデルと比較し続ける) ----
  //   一度だけ「改修前のモデル」を保存し、以後この基準と比べ続ける。
  //   基準を毎日更新すると「昨日比」しか分からず、
  //   「最初と比べてどれだけ良くなったか」が永久に分からなくなる。
  // v97(全体監査): 基準モデルは「一度だけ保存して以後固定」なので、読めなかった日に
  //   「無い」と見なして作り直すと、基準が今日の重みに差し替わり「最初と比べてどれだけ
  //   良くなったか」の比較が壊れる。upstashCmd があれば失敗を区別し、失敗した日は
  //   基準の保存をしない(比較は今日の base 相当で行い、その旨を残す)。
  let baseline = null;
  let baselineReadFailed = false;
  if (upstashEnabled) {
    if (typeof deps.upstashCmd === "function") {
      try {
        const rawB = await deps.upstashCmd(["GET", BASELINE_KEY]);
        baseline = rawB ? JSON.parse(rawB) : null;
      } catch (e) { baselineReadFailed = true; noteVia(deps, "baseline_read_failed", e); }
    } else {
      baseline = await deps.upstashGetJSON(BASELINE_KEY).catch(() => null);
    }
  }
  if (!baseline) {
    // 和の重みとρを0にしたもの = λ独立化より前の挙動と完全に同一
    baseline = {
      ...base,
      attackSumSensitivity: 0, concededSumSensitivity: 0,
      fatigueSumSensitivity: 0, xgSumSensitivity: 0, rho: 0,
    };
    if (upstashEnabled && !baselineReadFailed) await upstashSetJSON(BASELINE_KEY, baseline);
  }

  // ---- v50: チーム別レーティングの学習と、特徴量への注入 ----
  //   評価の公正のため、検証(test)に使うレーティングは**学習用(train)だけ**で
  //   学習する(testの結果を知っているレーティングでtestを評価しない)。
  //   本番保存用は最後に全データで学習し直す(使えるデータは全部使う)。
  const nowMsForRatings = runAt.getTime();
  const attachRatings = (rows, ratings) => {
    if (!ratings || !ratings.available) return 0;
    let attached = 0;
    for (const r of rows) {
      // v87①: 行のリーグIDを渡す(リーグ別ホームアドバンテージ学習時のみ効く。
      // 全体値モードのレーティングでは第4引数は無視され従来と完全に同一)
      const eg = expGoalsFromRatings(ratings, r.homeId, r.awayId, r.leagueId);
      if (eg) {
        r.homeCtx = { ...r.homeCtx, ratingExpGoals: eg.home };
        r.awayCtx = { ...r.awayCtx, ratingExpGoals: eg.away };
        attached++;
      }
    }
    return attached;
  };
  // ---- v57: xGブレンド率αの選択(xG付き試合が300件以上のときだけ) ----
  //   各αで学習用データだけからレーティングを学習し、検証用データのLogLossで
  //   比較する(リークなし)。改善しなければα=0のまま(=従来と完全同一)。
  if (xgRowsCount >= 300) {
    const scoreAlpha = (a) => {
      const rt = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: a });
      const testCopy = test.map((r) => ({ ...r }));
      attachRatings(testCopy, rt);
      const ev = evaluate(testCopy, base);
      return { alpha: a, logLoss: ev.measurable ? ev.logLoss : Infinity };
    };
    const candidates = [0, 0.3, 0.5, 0.7];
    const scores = candidates.map(scoreAlpha);
    scores.sort((x, y) => x.logLoss - y.logLoss);
    // ---- v80(2026年9月1日・利用者の承認 案10): 粗→細の2段階探索 ----
    //   粗い勝者の近傍(±0.1を0.05刻み)をCPUだけで再探索する(APIコスト0)。
    //   「α=0(混ぜない)が最良なら従来どおり0のまま」という規則は変えない。
    const fineScores = [];
    if (Number.isFinite(scores[0].logLoss) && scores[0].alpha !== 0) {
      const center = scores[0].alpha;
      const tried = new Set(candidates);
      for (const a of [center - 0.1, center - 0.05, center + 0.05, center + 0.1]) {
        const rounded = Math.round(a * 100) / 100;
        if (rounded <= 0 || rounded > 0.9 || tried.has(rounded)) continue;
        tried.add(rounded);
        fineScores.push(scoreAlpha(rounded));
      }
      const all = scores.concat(fineScores).sort((x, y) => x.logLoss - y.logLoss);
      if (Number.isFinite(all[0].logLoss) && all[0].alpha !== 0) xgAlphaChosen = all[0].alpha;
    }
    xgAlphaDetail = { candidates: scores, fineCandidates: fineScores, chosen: xgAlphaChosen, xgRows: xgRowsCount };
  } else if (xgRowsCount > 0) {
    xgAlphaDetail = { chosen: 0, xgRows: xgRowsCount, reasonJa: `xG付きの過去試合が${xgRowsCount}件で、α選択に必要な300件に達していません(それまで実ゴールのみで学習)。` };
  }
  // ---- v71③(2026年8月28日・利用者の承認): 時間減衰ξのゲート付き探索 ----
  //   「古い試合をどれだけ割り引くか」(1日あたりの減衰率ξ)はこれまで固定値だった。
  //   xGブレンド率αと同じ門番方式: 学習用データだけで各候補のレーティングを作り、
  //   検証用データのLogLossで比較して、勝った値だけを使う。
  //   ・既定値XI_DEFAULTも必ず候補に入れる(改善しなければ従来と完全同一)
  //   ・αを選んだ後にξを選ぶ(逐次探索。総当たりにしない理由: 学習時間を
  //     増やしすぎない。62分事件の教訓で、追加は候補3件ぶんの再学習に抑える)
  //   ・学習用データが500件未満の日は探索せず既定値(理由を記録)
  let ratingsTrain = null;
  if (train.length >= 500) {
    const xiCandidates = [0.003, XI_DEFAULT, 0.012];
    const xiScores = [];
    // v102: 候補1つぶんを関数にした(中身は同じ)。検証用の行の写し(testCopy)を、この長い関数の中の変数に残さないため
    //   (待ちを挟む関数の中の変数は、使い終わっても関数が終わるまで手放されない。実測で約6MB残っていた)
    const scoreXi = (x) => {
      const rt = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: x });
      const testCopy = test.map((r) => ({ ...r }));
      attachRatings(testCopy, rt);
      const ev = evaluate(testCopy, base);
      return { xi: x, logLoss: ev.measurable ? ev.logLoss : Infinity, rt };
    };
    for (const x of xiCandidates) xiScores.push(scoreXi(x));
    xiScores.sort((a, b) => a.logLoss - b.logLoss);
    // 門番の追加ルール: 既定値をノイズで手放さない。
    //   既定値より 0.0005 以上LogLossが小さいときだけ乗り換える(同点・僅差は既定値)。
    //   (テスト実測で3候補が小数4桁まで同点になる例があった。意味のない乗り換えは
    //    「検証で勝った値だけ採用」の精神に反する)
    const XI_ADOPT_MARGIN = 0.0005;
    const defaultScore = xiScores.find((sc) => sc.xi === XI_DEFAULT);
    const best = xiScores[0];
    if (Number.isFinite(best.logLoss) && defaultScore) {
      if (best.xi !== XI_DEFAULT && Number.isFinite(defaultScore.logLoss)
        && best.logLoss <= defaultScore.logLoss - XI_ADOPT_MARGIN) {
        xiChosen = best.xi;
        ratingsTrain = best.rt;
      } else {
        xiChosen = XI_DEFAULT;
        ratingsTrain = defaultScore.rt;
      }
    }
    xiDetail = {
      candidates: xiScores.map((sc) => ({ xi: sc.xi, logLoss: Number.isFinite(sc.logLoss) ? Math.round(sc.logLoss * 10000) / 10000 : null })),
      chosen: xiChosen, default: XI_DEFAULT,
      noteJa: xiChosen === XI_DEFAULT
        ? "検証データで既定値を意味のある差(LogLoss 0.0005以上)で上回る減衰率が無かったため、従来どおりの値を使います(僅差・同点では乗り換えません)。"
        : `検証データのLogLossが既定値より0.0005以上小さかった減衰率 ${xiChosen}/日 を採用しました(既定値: ${XI_DEFAULT}/日)。`,
    };
  } else {
    xiDetail = { chosen: XI_DEFAULT, default: XI_DEFAULT, reasonJa: `学習用の過去試合が${train.length}件で、減衰率ξの探索に必要な500件に達していません(それまで既定値で学習します)。` };
  }
  if (!ratingsTrain) ratingsTrain = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: xiChosen });

  // ---- v87①(2026年9月9日・利用者の選択): リーグ別ホームアドバンテージの門番付き採用 ----
  //   これまで全リーグ共通だったホームの下駄を、リーグ別に学習した候補と毎日比較する。
  //   α・ξと同じ門番方式: 学習用データだけで両方のレーティングを作り、検証用データの
  //   LogLossで比較して、意味のある差(0.0005以上)で勝ったときだけリーグ別を採用する。
  //   勝てない日は従来どおり全体値のまま(劣化禁止)。逐次探索(α→ξ→本項)にする理由は
  //   v71③と同じ(総当たりで学習時間を爆発させない。62分事件の教訓)。
  let homeAdvModeChosen = "global", homeAdvDetail = null;
  if (train.length >= 500) {
    const scoreRatings = (rt) => {
      const testCopy = test.map((r) => ({ ...r }));
      attachRatings(testCopy, rt);
      const ev = evaluate(testCopy, base);
      return ev.measurable ? ev.logLoss : Infinity;
    };
    const globalLoss = scoreRatings(ratingsTrain);
    let perLoss = Infinity, perLeagueCount = 0, rtPerLeague = null;
    try {
      rtPerLeague = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: xiChosen, perLeagueHomeAdv: true });
      if (rtPerLeague && rtPerLeague.available) {
        perLoss = scoreRatings(rtPerLeague);
        perLeagueCount = rtPerLeague.homeAdvByLeague ? Object.keys(rtPerLeague.homeAdvByLeague).length : 0;
      }
    } catch (e) { noteVia(deps, "homeadv_perleague_fit_failed", e); } // リーグ別学習の失敗は「採用しない」に落ちるだけ(従来と同一動作。v92: 痕跡は残す)
    const HOMEADV_ADOPT_MARGIN = 0.0005; // ξと同じ「僅差・同点では乗り換えない」閾値
    if (Number.isFinite(perLoss) && Number.isFinite(globalLoss) && perLoss <= globalLoss - HOMEADV_ADOPT_MARGIN) {
      homeAdvModeChosen = "perLeague";
      ratingsTrain = rtPerLeague; // 以後の重み学習も勝った方のλで行う
    }
    const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
    homeAdvDetail = {
      chosen: homeAdvModeChosen,
      globalLogLoss: r4(globalLoss), perLeagueLogLoss: r4(perLoss),
      leagues: perLeagueCount,
      noteJa: homeAdvModeChosen === "perLeague"
        ? `検証データのLogLossがリーグ別ホームアドバンテージ(${perLeagueCount}大会分)の方が0.0005以上小さかったため、リーグ別の値を採用しました。`
        : "リーグ別ホームアドバンテージは検証データで全体共通値を意味のある差(LogLoss 0.0005以上)で上回らなかったため、従来どおり全体共通値を使います(僅差・同点では乗り換えません)。",
    };
  } else {
    homeAdvDetail = { chosen: "global", reasonJa: `学習用の過去試合が${train.length}件で、リーグ別ホームアドバンテージの検証に必要な500件に達していません(それまで全体共通値で学習します)。` };
  }

  // ---- v102(B): 関門の種類。cv(既定)= 前向きの交差検証 / legacy = v101 までの「7:3 の1回分割+多指標」 ----
  const corpusGate = corpusGateOptions(opts);
  // v102: 交差検証の関門では、学習用の行(7割)にレーティングを付けない(付けられる件数を数えるだけ)。
  //   交差検証は、各時期の試合に「それより前だけで学習したレーティング」を自分で付けるので、ここで付けた値は使われない。
  //   付けると行ごとに文脈の写しができる(51,925行で約4MB)。従来の関門(legacy)は学習用の行の値を使うので、これまでどおり付ける。
  const countAttachable = (rows, ratings) => {
    if (!ratings || !ratings.available) return 0;
    let n = 0;
    for (const r of rows) if (expGoalsFromRatings(ratings, r.homeId, r.awayId, r.leagueId)) n++;
    return n;
  };
  const ratingsAttachedTrain = corpusGate.mode === "cv" ? countAttachable(train, ratingsTrain) : attachRatings(train, ratingsTrain);
  const ratingsAttachedTest = attachRatings(test, ratingsTrain);

  // ---- 引き分け帯の探索(v78・v80)。v102 で関数にして、関門の種類の分かれ目より前に置いた(中身と門番の条件は同じ) ----
  const DRAW_BAND_DEFAULT = 0.15;
  const DRAW_BAND_ADOPT_MARGIN_PT = 0.4;
  // v102: 探索の本体を関数にした(中身・門番の条件は v78/v80 のまま)。scoreBand = 帯ごとの的中率を返す関数、nValid = 検証の件数
  const chooseDrawBand = (scoreBand, nValid) => {
  let drawBandChosen = DRAW_BAND_DEFAULT;
  let drawBandDetail = null;
  if (nValid >= 300) {
    const bandCandidates = [0.06, 0.10, DRAW_BAND_DEFAULT, 0.20, 0.25];
    const scoredBands = bandCandidates.map(scoreBand);
    // ---- v80(2026年9月1日・利用者の承認 案10): 粗→細の2段階探索 ----
    //   粗い候補の最良帯の近傍(±0.03を0.015刻み)をCPUだけで再探索する
    //   (APIコスト0)。門番の条件(既定帯より+0.4pt・引き分け0件へ退化しない)は
    //   細かい候補にもそのまま適用する。
    const coarseEligible = scoredBands.filter((s) => s.accuracyPct !== null && (s.drawPredictedCount || 0) > 0)
      .sort((a, b) => b.accuracyPct - a.accuracyPct);
    const fineScoredBands = [];
    if (coarseEligible[0]) {
      const center = coarseEligible[0].band;
      const tried = new Set(bandCandidates);
      for (const delta of [-0.03, -0.015, 0.015, 0.03]) {
        const b = Math.round((center + delta) * 1000) / 1000;
        if (b < 0.03 || b > 0.30 || tried.has(b)) continue;
        tried.add(b);
        fineScoredBands.push(scoreBand(b));
      }
    }
    const allBands = scoredBands.concat(fineScoredBands);
    const defBand = allBands.find((s) => s.band === DRAW_BAND_DEFAULT);
    const eligible = allBands.filter((s) => s.accuracyPct !== null && (s.drawPredictedCount || 0) > 0);
    eligible.sort((a, b) => b.accuracyPct - a.accuracyPct);
    const bestBand = eligible[0] || null;
    if (bestBand && defBand && defBand.accuracyPct !== null
      && bestBand.band !== DRAW_BAND_DEFAULT
      && bestBand.accuracyPct >= defBand.accuracyPct + DRAW_BAND_ADOPT_MARGIN_PT) {
      drawBandChosen = bestBand.band;
    }
    drawBandDetail = {
      candidates: scoredBands,
      fineCandidates: fineScoredBands, // v80(案10): 細かい刻みの再探索の実測
      chosen: drawBandChosen, default: DRAW_BAND_DEFAULT,
      noteJa: drawBandChosen === DRAW_BAND_DEFAULT
        ? `検証${nValid}件の的中率で既定帯±${DRAW_BAND_DEFAULT}を+${DRAW_BAND_ADOPT_MARGIN_PT}pt以上上回る帯が無かったため、既定値を維持しました(粗${scoredBands.length}+細${fineScoredBands.length}候補を探索)。`
        : `検証${nValid}件の的中率が既定帯より+${DRAW_BAND_ADOPT_MARGIN_PT}pt以上高かった帯±${drawBandChosen}を採用しました(既定: ±${DRAW_BAND_DEFAULT}・粗${scoredBands.length}+細${fineScoredBands.length}候補を探索)。`,
    };
  } else {
    drawBandDetail = {
      chosen: DRAW_BAND_DEFAULT, default: DRAW_BAND_DEFAULT,
      reasonJa: `検証用の過去試合が${nValid}件で、引き分け帯の探索に必要な300件に達していません(それまで既定値±${DRAW_BAND_DEFAULT}で判定します)。`,
    };
  }
  return { chosen: drawBandChosen, detail: drawBandDetail };
  };

  let found, gradFit, gradWon, candidateWeights, candidateFormDetail, drawBandChosen, drawBandDetail;
  let oldEval, newEval, cmp, consistency, decision;
  let corpusCv = null;      // 交差検証の結果(記録用の要約)
  let cvLeagueTableJa = null; // 交差検証のリーグ別の内訳(画面に出す表)
  let ownGuard = null;      // 自社予想の記録での確認
  let holdoutBaseEval = null; // 従来と同じ「新しい3割」で測った現行の重みの成績(推移を続けて見るため)
  const collectedBeforeGate = mem.collect();
  const snapBeforeGate = mem.snap("beforeGate");
  await markPhase("重みの検証の前");
  // v102: 交差検証に入る前に、メモリの余裕を実測で確かめる(足りないときは、落ちる前にその回の検証を見送る)
  const memoryCheck = corpusGate.mode === "cv" && !safeMode
    ? cvMemoryCheck(ds.rows.length, snapBeforeGate, memoryLimits(), opts && opts.cvMemoryRule, collectedBeforeGate)
    : null;
  const memoryShort = !!(memoryCheck && memoryCheck.ok === false);
  if (corpusGate.mode === "cv" && (safeMode || memoryShort)) {
    // ---- v102: 重みの交差検証をしない回 = 重みは変えない ----
    //   ① 軽い設定(前回 ④-b の途中で処理ごと止まったあとの数日間) ② メモリの余裕が足りない回
    //   どちらも、地力レーティングの更新など、ほかの処理は続ける。
    holdoutBaseEval = evaluate(test, base);
    const baseBand = Number.isFinite(base.drawBand) ? base.drawBand : DRAW_BAND_DEFAULT;
    const whyJa = safeMode ? "軽い設定のため" : "メモリの余裕が足りないため";
    const skipReasonJa = safeMode
      ? `${crashGuard.reasonJa || "前回の過去試合によるモデル調整が途中で止まったため、軽い設定で動かしています。"}モデルは変更しません。`
      : `${memoryCheck.reasonJa}モデルは変更しません。`;
    drawBandChosen = baseBand;
    drawBandDetail = { chosen: baseBand, default: DRAW_BAND_DEFAULT, reasonJa: `${whyJa}、引き分け帯は変更していません。` };
    candidateWeights = { ...base };
    oldEval = holdoutBaseEval; newEval = holdoutBaseEval;
    cmp = compare(oldEval, newEval);
    consistency = null;
    decision = { adopt: false, consistencyChecked: false, reasonJa: skipReasonJa, secondaryGains: null };
    found = { evaluated: null };
    gradFit = { detail: { ran: false, reasonJa: `${whyJa}、重みの学習は行っていません。` } };
    gradWon = false;
    candidateFormDetail = { gridLogLoss: null, gradAddLogLoss: null, gradMultLogLoss: null, chosenForm: base.modelForm === "mult" ? "mult" : "add", noteJa: `${whyJa}、重みの学習は行っていません。` };
  } else if (corpusGate.mode === "cv") {
    holdoutBaseEval = evaluate(test, base);
    if (typeof deps.heartbeat === "function") await deps.heartbeat("過去試合の交差検証");
    // v102: 交差検証の本体は同期の関数(corpusCvGateStep)にした。全試合ぶんの特徴量など、検証の中で使う大きなデータは
    //   その関数の中だけで持ち、戻るときに手放す(ここに置くと、この関数が終わるまで残る。実測で約19.5MB)。
    const step = corpusCvGateStep({
      rows: ds.rows, base, runAt, corpusGate,
      ratingOpts: { xgAlpha: xgAlphaChosen, xi: xiChosen, perLeagueHomeAdv: homeAdvModeChosen === "perLeague" },
      guardRecords: opts && opts.guardRecords, chooseDrawBand, drawBandDefault: DRAW_BAND_DEFAULT,
      onStep: () => mem.collect(),
    });
    if (typeof deps.heartbeat === "function") await deps.heartbeat("過去試合の交差検証のあと");
    ownGuard = step.ownGuard; corpusCv = step.corpusCv; cvLeagueTableJa = step.cvLeagueTableJa;
    drawBandChosen = step.drawBandChosen; drawBandDetail = step.drawBandDetail;
    candidateWeights = step.candidateWeights;
    oldEval = step.oldEval; newEval = step.newEval;
    cmp = compare(oldEval, newEval);
    consistency = null;
    decision = step.decision;
    found = { evaluated: null };
    gradFit = step.gradFit;
    gradWon = true;
    candidateFormDetail = step.candidateFormDetail;
  } else {
  found = searchParams(train, base);

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
  gradFit = fitHistoryWeights(train, found.weights, runAt);
  // ---- v66「乗法モデル」: 加法形と乗法形の両方を毎日学習し、勝った方を候補にする ----
  //   乗法形(λ = base × exp(Σ特徴×重み))はポアソン回帰の標準形で、λが構造的に
  //   壊れない。ただし切り替えは人手では行わず、**同じ学習データで両方を学習し、
  //   同じ検証ゲートで勝った方だけ**が候補になる(負けた日は従来のまま=劣化禁止)。
  //   重みは形ごとに意味が違うため、乗法形は乗法形として一から勾配学習する。
  const gradFitMult = fitHistoryWeights(train, { ...found.weights, modelForm: "mult" }, runAt);
  const trainEvalGrid = evaluate(train, found.weights);
  const trainEvalGrad = gradFit.weights ? evaluate(train, gradFit.weights) : null;
  const trainEvalGradMult = gradFitMult.weights ? evaluate(train, gradFitMult.weights) : null;
  const lossOf = (ev) => (ev && ev.measurable ? ev.logLoss : Infinity);
  // 3候補(グリッド・勾配加法・勾配乗法)から学習用LogLoss最小を選ぶ
  //(採否そのものは従来どおり、この後の検証用データの関門が判断する)
  const candidates3 = [
    { weights: found.weights, loss: lossOf(trainEvalGrid), viaGradient: false, form: "add" },
    { weights: gradFit.weights, loss: lossOf(trainEvalGrad), viaGradient: true, form: "add" },
    { weights: gradFitMult.weights, loss: lossOf(trainEvalGradMult), viaGradient: true, form: "mult" },
  ].filter((c) => c.weights);
  candidates3.sort((a, b) => a.loss - b.loss);
  const best3 = candidates3[0];
  gradWon = !!(best3 && best3.viaGradient && Number.isFinite(best3.loss));
  candidateWeights = best3 ? best3.weights : found.weights;
  candidateFormDetail = {
    gridLogLoss: Number.isFinite(lossOf(trainEvalGrid)) ? Math.round(lossOf(trainEvalGrid) * 10000) / 10000 : null,
    gradAddLogLoss: Number.isFinite(lossOf(trainEvalGrad)) ? Math.round(lossOf(trainEvalGrad) * 10000) / 10000 : null,
    gradMultLogLoss: Number.isFinite(lossOf(trainEvalGradMult)) ? Math.round(lossOf(trainEvalGradMult) * 10000) / 10000 : null,
    chosenForm: candidateWeights && candidateWeights.modelForm === "mult" ? "mult" : "add",
  };

  // ---- v78(2026年9月1日・利用者の承認 案1): 引き分け帯の学習(門番付き) ----
  //   帯は勝敗ラベルの決め方だけを変える(λ・確率・LogLossは不変)ため、
  //   評価は検証データの「的中率」で行う(xi=v71③と同じ、候補比較→門番の流儀)。
  //   門番の条件(すべて満たしたときだけ既定値0.15から動く):
  //     ①検証が300件以上 ②的中率が既定帯より+0.4pt以上良い
  //     ③その帯でも引き分け予想が0件にならない(「絶対引き分けと言わないAI」への
  //       退化は、当たり数が増えても採用しない。evaluateの注記どおりAccuracyだけ
  //       だと引き分けを捨てる方が有利に見えることがあるため)
  {
    // 従来の関門: 検証用3割で、候補の重みに帯を載せて的中率を測る
    const legacyScoreBand = (b) => {
      const ev = evaluate(test, { ...candidateWeights, drawBand: b });
      return {
        band: b,
        accuracyPct: ev && ev.measurable ? ev.accuracyPct : null,
        drawPredictedCount: ev && ev.measurable ? ev.drawPredictedCount : null,
        drawRecallPct: ev && ev.measurable ? ev.drawRecallPct : null,
      };
    };
    const db = chooseDrawBand(legacyScoreBand, test.length);
    drawBandChosen = db.chosen; drawBandDetail = db.detail;
  }
  // 選ばれた帯を候補weightsに載せる(門番を通らなければ既定値0.15が明示的に載る
  // だけで、従来の挙動と完全に同一)。この後の新旧比較・一貫性検証・採否も、
  // この帯込みの候補で判定される(採用されなければ帯も従来のまま)。
  candidateWeights = { ...candidateWeights, drawBand: drawBandChosen };

  oldEval = evaluate(test, base);
  newEval = evaluate(test, candidateWeights);
  cmp = compare(oldEval, newEval);

  // ---- リーグ別・統計的一貫性の検証 ----
  consistency = consistencyReport(test, base, candidateWeights, LEAGUE_NAMES_JA);
  decision = shouldAdoptWithConsistency(cmp, consistency, { minSample: 200 });
  } // ← 従来の関門(legacy)の枝の終わり
  mem.collect();
  mem.snap("afterGate");
  await markPhase("重みの検証のあと");

  // ---- 基準モデルとの比較(採用の可否にかかわらず毎日記録する) ----
  //   「今日のモデルは、改修前と比べてどれだけ良いか」を継続的に残す。
  const adoptedWeights = decision.adopt ? candidateWeights : base;
  const baselineEval = evaluate(test, baseline);
  const currentEval = evaluate(test, adoptedWeights);
  const vsBaseline = compare(baselineEval, currentEval);
  const vsBaselineConsistency = consistencyReport(test, baseline, adoptedWeights, LEAGUE_NAMES_JA);

  const record = {
    date: recordDateKey,
    ranAt: runAt.toISOString(),
    datasetSize: ds.rows.length,
      clubEloRows: clubEloRowsCount, // v57: Elo付きで学習に使えた試合数(実測)
      xgAlpha: xgAlphaChosen, xgAlphaDetail, xgRows: xgRowsCount, // v57: xGブレンドの実測
      xi: xiChosen, xiDetail, // v71③: 時間減衰ξの実測(候補ごとの検証LogLossと選ばれた値)
      homeAdvMode: homeAdvModeChosen, homeAdvDetail, // v87①: リーグ別ホームアドバンテージの検証実測
      drawBand: drawBandChosen, drawBandDetail, // v78(案1): 引き分け帯の実測(候補ごとの検証的中率と選ばれた帯)
    trainSize: train.length,
    testSize: test.length,
    combinationsEvaluated: found.evaluated,
    adopted: decision.adopt,
    consistencyChecked: decision.consistencyChecked,
    reasonJa: decision.reasonJa,
    // v104.1(総点検): 副次的な予測(両チーム得点・Over/Under・スコア・総得点の誤差)の改善幅。
    //   採否の判断(modelBacktest)は毎回これを計算していたが、ここで結果から落としていたため、
    //   日次レポートの「副次的な改善」の行が一度も表示されなかった。実測の文字列のまま渡す。
    secondaryGains: Array.isArray(decision.secondaryGains) ? decision.secondaryGains.slice(0, 6) : null,
    oldEval, newEval,
    comparisonJa: formatComparisonJa(cmp),
    // v102(B): 交差検証の関門ではリーグ別の比較は行わない(null)。代わりに cv(束ねた検定)を残す
    leagueTableJa: consistency ? formatLeagueTableJa(consistency) : cvLeagueTableJa,
    leaguesMeasured: consistency ? consistency.leaguesMeasured : null,
    leaguesImproved: consistency ? consistency.improvedCount : null,
    significantlyWorseLeagues: consistency ? consistency.significantlyWorseLeagues : null,
    overallPairedLogLoss: consistency ? consistency.overallLogLoss : null,
    gateMode: corpusGate.mode,
    cv: corpusCv,
    // v102: ④-b の安全弁の状態(軽い設定で動かしたか・いつまでか)と、メモリの実測(開始・データを読んだあと・終わり)
    crashGuard,
    memoryCheck, // 交差検証の前のメモリの余裕の確認(見送った回は ok:false と数字)
    memory: null, // 最後(レーティングと派生指標の保存のあと)に入れる
    ownRecordsGuard: ownGuard,
    holdoutBaseEval: holdoutBaseEval && holdoutBaseEval.measurable ? { sampleSize: holdoutBaseEval.sampleSize, logLoss: holdoutBaseEval.logLoss, brier: holdoutBaseEval.brier, accuracyPct: holdoutBaseEval.accuracyPct } : null,
    leagueChecks: ds.leagueChecks || (ds.meta && ds.meta.leagueChecks) || null,
    leagueCheckErrors: ds.leagueCheckErrors || (ds.meta && ds.meta.leagueCheckErrors) || null,
    leaguesInDataset: ds.meta && Array.isArray(ds.meta.leagues) ? ds.meta.leagues.length : null,
    droppedOldest: ds.meta ? (ds.meta.droppedOldest ?? null) : null,
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
      ? {
        ...Object.fromEntries(LEARNABLE_KEYS
          .filter((k) => Number.isFinite(candidateWeights[k]))
          .map((k) => [k, candidateWeights[k]])),
        // v66: モデルの形は数値でないため上のfilterで落ちる。**必ず明示して保存**する。
        //   (加法候補が勝った日に、保存済みの"mult"が黙って残ると、加法用に
        //    学習した重みを乗法で解釈してしまう=構造的な壊れ方。テストで固定)
        modelForm: candidateWeights.modelForm === "mult" ? "mult" : "add",
        // v78(案1): 引き分け帯もLEARNABLE_KEYS(勾配学習の対象)には入らないため
        // 明示して保存する。門番を通らなかった日は既定値0.15が明示的に載るだけで
        // 挙動は従来と同一。
        drawBand: Number.isFinite(candidateWeights.drawBand) ? candidateWeights.drawBand : 0.15,
      }
      : null,
    // どちらの候補が勝ったか(実測の記録。gradFit.detailは学習の中身の説明)
    method: corpusGate.mode === "cv" ? "corpus_cv" : (gradWon ? "history_gradient_descent" : "grid_search"),
    // v66: 加法/乗法の比較結果(学習用LogLoss)と選ばれた形を毎日記録する
    modelFormDetail: candidateFormDetail,
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
    // v71③: 本番保存用も選ばれたξで学習。v87①: 門番を通った日はリーグ別ホームアドバンテージ付きで学習
    let ratingsFull = fitTeamRatings(ds.rows, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: xiChosen, perLeagueHomeAdv: homeAdvModeChosen === "perLeague" });
    // v87.1(監査での指摘⑨の予防): リーグ別モードの本番学習だけが失敗した日は、全体値モードで
    // 学習し直してから保存する。これが無いと保存がスキップされ、昨日のレーティングが
    // 黙って残り続ける(リーグ別の導入が「保存されない日」を新たに作ってはならない=劣化禁止)。
    let homeAdvFullFitFallback = false;
    if (!ratingsFull.available && homeAdvModeChosen === "perLeague") {
      const fallbackGlobal = fitTeamRatings(ds.rows, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: xiChosen });
      if (fallbackGlobal.available) { ratingsFull = fallbackGlobal; homeAdvFullFitFallback = true; }
    }
    if (ratingsFull.available && upstashEnabled) {
      ratingsFull.builtAt = runAt.toISOString();
      // v53: 表示用のチーム名(データセットのメタから)。
      // v55: さらに日次巡回が集めた learn:teamnames ともマージする(メタに名前が
      // 無い旧データセットでも、翌日から名前が自己回復する)。
      const names = {};
      try {
        const collected = (await deps.upstashGetJSON("learn:teamnames").catch(() => null)) || {};
        for (const id of Object.keys(ratingsFull.byTeam)) {
          if (collected[id]) names[id] = collected[id];
        }
      } catch (e) { noteVia(deps, "teamnames_read_failed", e); } // 採集名簿が無くても続行(v92: 痕跡は残す)
      if (ds.meta && ds.meta.namesById) {
        for (const id of Object.keys(ratingsFull.byTeam)) {
          if (ds.meta.namesById[id]) names[id] = ds.meta.namesById[id]; // データセット由来を優先
        }
      }
      if (Object.keys(names).length) ratingsFull.namesById = names;
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
      } catch (e) { noteVia(deps, "ratings_rank_snapshot_failed", e); } // スナップショットはベストエフォート(ランキング表示は変動なしで出る。v92: 痕跡は残す)
    }
    record.teamRatings.fullFit = {
      available: ratingsFull.available, teams: ratingsFull.teamsRated, matches: ratingsFull.matchesUsed, saved: ratingsSaved,
      // v87①: 保存したレーティングのホームアドバンテージ方式(説明責任)
      homeAdvMode: ratingsFull.homeAdvMode || "global",
      leaguesWithHomeAdv: ratingsFull.homeAdvByLeague ? Object.keys(ratingsFull.homeAdvByLeague).length : 0,
      // v87.1: リーグ別の本番学習が失敗して全体値で保存し直した日はその旨を正直に残す
      homeAdvFullFitFallback: homeAdvFullFitFallback || undefined,
      reasonJa: ratingsFull.reasonJa || null,
    };
  } catch (e) {
    record.teamRatings.fullFit = { available: false, saved: false, reasonJa: `レーティング学習でエラー(${e && e.message})` };
  }

  // ---- v59: 派生指標(BTTS率・クリーンシート率・荒れやすさ)の事前集計 ----
  //   レーティングと同じく「データから測った事実」なので、重みの採否とは独立に
  //   毎回更新する。ここで1回だけ数えて保存し、利用者の質問時は読み出すだけに
  //   する(方針⑥: 質問した瞬間に重い処理を行わない)。
  let teamStatsResult = { available: false, saved: false, teamsCounted: 0 };
  try {
    const stats = buildTeamStats(ds.rows, { builtAt: runAt.toISOString() });
    let statsSaved = false;
    if (stats.available && upstashEnabled) {
      statsSaved = (await upstashSetJSON(TEAM_STATS_KEY, stats)) !== false;
    }
    teamStatsResult = {
      available: stats.available, saved: statsSaved,
      teamsCounted: stats.teamsCounted, matches: stats.matchesUsed,
      reasonJa: stats.reasonJa || null,
    };
  } catch (e) {
    teamStatsResult = { available: false, saved: false, teamsCounted: 0, reasonJa: `派生指標の集計でエラー(${e && e.message})` };
  }
  record.teamStats = teamStatsResult;

  // v102: ここまでのメモリの実測を記録に入れる(片づけてから測る = このあとサーバーが持ち続ける量)
  mem.collect();
  mem.snap("end");
  record.memory = mem.report();

  if (upstashEnabled) {
    await upstashCmd(["LPUSH", TUNING_LOG_KEY, JSON.stringify(record)]).catch(() => {});
    await upstashCmd(["LTRIM", TUNING_LOG_KEY, "0", String(TUNING_LOG_KEEP - 1)]).catch(() => {});
    if (decision.adopt) {
      // v102(B): 交差検証で採用した日は、重みの最終更新日時も進める(「何日据え置きか」の表示が実態と合うように)
      const merged = { ...base, ...record.newParams, version: (base.version || 0) + 1, ...(corpusGate.mode === "cv" ? { updatedAt: runAt.toISOString() } : {}) };
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
    teamStats: record.teamStats, // v59: 派生指標の集計結果(実測)
    modelFormDetail: record.modelFormDetail, // v66: 加法/乗法の比較実測と選ばれた形
    xi: record.xi, xiDetail: record.xiDetail, // v71③: 時間減衰ξの実測
    homeAdvMode: record.homeAdvMode, homeAdvDetail: record.homeAdvDetail, // v87①: リーグ別ホームアドバンテージの実測
    drawBand: record.drawBand, drawBandDetail: record.drawBandDetail, // v78(案1): 引き分け帯の実測
    consistencyChecked: record.consistencyChecked,
    reasonJa: record.reasonJa,
    datasetSize: ds.rows.length,
      clubEloRows: clubEloRowsCount, // v57: Elo付きで学習に使えた試合数(実測)
      xgAlpha: xgAlphaChosen, xgAlphaDetail, xgRows: xgRowsCount, // v57: xGブレンドの実測
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
    // v102(B / ★2): 関門の種類・交差検証の結果・自社予想の記録での確認・新リーグの照合
    gateMode: record.gateMode, cv: record.cv, ownRecordsGuard: record.ownRecordsGuard, holdoutBaseEval: record.holdoutBaseEval,
    crashGuard: record.crashGuard, memoryCheck: record.memoryCheck, memory: record.memory,
    method: record.method,
    leagueChecks: record.leagueChecks, leagueCheckErrors: record.leagueCheckErrors,
    leaguesInDataset: record.leaguesInDataset, droppedOldest: record.droppedOldest,
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
  // v102(B)
  CORPUS_CV_DEFAULTS, corpusGateOptions, corpusForwardCv, ownRecordsGuard, recordLoss,
  composeCorpusCvReasonJa, cvLeagueRows, formatCvLeagueTableJa,
  TUNE_INFLIGHT_KEY, TUNE_SAFEMODE_KEY, SAFE_MODE_DAYS, SAFE_MODE_DAYS_REPEAT, SAFE_MODE_LAST_SHARDS,
  memorySnapshot, memoryLimits, createMemoryProbe, readCrashGuard, releaseInflightMarkerOnShutdown, PROCESS_BOOT_ID, codeCommit, storeCmdRetryOnce,
  CV_MEMORY_RULE, cvMemoryCheck, corpusCvGateStep,
};
