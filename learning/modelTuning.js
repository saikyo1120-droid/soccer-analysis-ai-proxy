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
};
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
  const NEEDED = (DEFAULT_BACKFILL_LEAGUES.length * 5) + 2; // v58: 12大会×5シーズン+予備 ≒ 62件(週1回/構成変更時のみ)
  if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(NEEDED)) {
    return {
      ...existing, refreshed: false,
      reasonJa: `過去試合の取り直しに必要な約${NEEDED}リクエストの余裕が無いため、今回は見送りました(既存の${existing.rows.length}件で学習します)。`,
    };
  }

  // v58: 3→5シーズンへ拡張(利用者のご要望「ここ何年かの過去データを全て」)。
  // 時間減衰(ξ=0.0065/日)により古いシーズンの影響は自然に小さくなる
  // (それが正しい設計: 3年前の強さは今の強さではない)が、リーグ間較正の
  // 実対戦サンプルと、直近データが薄いクラブの土台としては効く。
  const seasons = seasonsToFetch(runAt, 5);
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

async function tuneModelOnHistory(deps, currentWeights, runAt) {
  const { upstashEnabled, upstashCmd, upstashSetJSON } = deps;
  const ds = await ensureDataset(deps, runAt);

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
  // ---- v57: xGブレンド率αの選択(xG付き試合が300件以上のときだけ) ----
  //   各αで学習用データだけからレーティングを学習し、検証用データのLogLossで
  //   比較する(リークなし)。改善しなければα=0のまま(=従来と完全同一)。
  if (xgRowsCount >= 300) {
    const candidates = [0, 0.3, 0.5, 0.7];
    const scores = [];
    for (const a of candidates) {
      const rt = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: a });
      const testCopy = test.map((r) => ({ ...r }));
      attachRatings(testCopy, rt);
      const ev = evaluate(testCopy, base);
      scores.push({ alpha: a, logLoss: ev.measurable ? ev.logLoss : Infinity });
    }
    scores.sort((x, y) => x.logLoss - y.logLoss);
    if (Number.isFinite(scores[0].logLoss) && scores[0].alpha !== 0) xgAlphaChosen = scores[0].alpha;
    xgAlphaDetail = { candidates: scores, chosen: xgAlphaChosen, xgRows: xgRowsCount };
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
    for (const x of xiCandidates) {
      const rt = fitTeamRatings(train, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: x });
      const testCopy = test.map((r) => ({ ...r }));
      attachRatings(testCopy, rt);
      const ev = evaluate(testCopy, base);
      xiScores.push({ xi: x, logLoss: ev.measurable ? ev.logLoss : Infinity, rt });
    }
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
  const gradWon = !!(best3 && best3.viaGradient && Number.isFinite(best3.loss));
  let candidateWeights = best3 ? best3.weights : found.weights;
  const candidateFormDetail = {
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
  const DRAW_BAND_DEFAULT = 0.15;
  const DRAW_BAND_ADOPT_MARGIN_PT = 0.4;
  let drawBandChosen = DRAW_BAND_DEFAULT;
  let drawBandDetail = null;
  if (test.length >= 300) {
    const bandCandidates = [0.06, 0.10, DRAW_BAND_DEFAULT, 0.20, 0.25];
    const scoredBands = bandCandidates.map((b) => {
      const ev = evaluate(test, { ...candidateWeights, drawBand: b });
      return {
        band: b,
        accuracyPct: ev && ev.measurable ? ev.accuracyPct : null,
        drawPredictedCount: ev && ev.measurable ? ev.drawPredictedCount : null,
        drawRecallPct: ev && ev.measurable ? ev.drawRecallPct : null,
      };
    });
    const defBand = scoredBands.find((s) => s.band === DRAW_BAND_DEFAULT);
    const eligible = scoredBands.filter((s) => s.accuracyPct !== null && (s.drawPredictedCount || 0) > 0);
    eligible.sort((a, b) => b.accuracyPct - a.accuracyPct);
    const bestBand = eligible[0] || null;
    if (bestBand && defBand && defBand.accuracyPct !== null
      && bestBand.band !== DRAW_BAND_DEFAULT
      && bestBand.accuracyPct >= defBand.accuracyPct + DRAW_BAND_ADOPT_MARGIN_PT) {
      drawBandChosen = bestBand.band;
    }
    drawBandDetail = {
      candidates: scoredBands,
      chosen: drawBandChosen, default: DRAW_BAND_DEFAULT,
      noteJa: drawBandChosen === DRAW_BAND_DEFAULT
        ? `検証${test.length}件の的中率で既定帯±${DRAW_BAND_DEFAULT}を+${DRAW_BAND_ADOPT_MARGIN_PT}pt以上上回る帯が無かったため、既定値を維持しました。`
        : `検証${test.length}件の的中率が既定帯より+${DRAW_BAND_ADOPT_MARGIN_PT}pt以上高かった帯±${drawBandChosen}を採用しました(既定: ±${DRAW_BAND_DEFAULT})。`,
    };
  } else {
    drawBandDetail = {
      chosen: DRAW_BAND_DEFAULT, default: DRAW_BAND_DEFAULT,
      reasonJa: `検証用の過去試合が${test.length}件で、引き分け帯の探索に必要な300件に達していません(それまで既定値±${DRAW_BAND_DEFAULT}で判定します)。`,
    };
  }
  // 選ばれた帯を候補weightsに載せる(門番を通らなければ既定値0.15が明示的に載る
  // だけで、従来の挙動と完全に同一)。この後の新旧比較・一貫性検証・採否も、
  // この帯込みの候補で判定される(採用されなければ帯も従来のまま)。
  candidateWeights = { ...candidateWeights, drawBand: drawBandChosen };

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
      clubEloRows: clubEloRowsCount, // v57: Elo付きで学習に使えた試合数(実測)
      xgAlpha: xgAlphaChosen, xgAlphaDetail, xgRows: xgRowsCount, // v57: xGブレンドの実測
      xi: xiChosen, xiDetail, // v71③: 時間減衰ξの実測(候補ごとの検証LogLossと選ばれた値)
      drawBand: drawBandChosen, drawBandDetail, // v78(案1): 引き分け帯の実測(候補ごとの検証的中率と選ばれた帯)
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
    method: gradWon ? "history_gradient_descent" : "grid_search",
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
    const ratingsFull = fitTeamRatings(ds.rows, { nowMs: nowMsForRatings, xgAlpha: xgAlphaChosen, decayXiPerDay: xiChosen }); // v71③: 本番保存用も選ばれたξで学習
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
      } catch (e) { /* 採集名簿が無くても続行 */ }
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
      } catch (e) { /* スナップショットはベストエフォート(ランキング表示は変動なしで出る) */ }
    }
    record.teamRatings.fullFit = { available: ratingsFull.available, teams: ratingsFull.teamsRated, matches: ratingsFull.matchesUsed, saved: ratingsSaved, reasonJa: ratingsFull.reasonJa || null };
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
    teamStats: record.teamStats, // v59: 派生指標の集計結果(実測)
    modelFormDetail: record.modelFormDetail, // v66: 加法/乗法の比較実測と選ばれた形
    xi: record.xi, xiDetail: record.xiDetail, // v71③: 時間減衰ξの実測
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
