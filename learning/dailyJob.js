/**
 * server/learning/dailyJob.js
 * ------------------------------------------------
 * 「毎日学習エンジン(Learning Engine)」の本体。
 *
 * これは何をする仕組みか(正直な説明):
 *   このプロジェクトでLLM自体を毎日再学習させることは現実的ではありません
 *   (莫大な計算資源が必要で、Node.jsの単一プロキシサーバーで行えるものでは
 *   ありません)。代わりにここで実装しているのは、
 *     ①毎日、登録クラブの実際の試合結果をAPI-Footballから取得する
 *     ②そこから「事実」(客観的に計算できる数値の変化)を抽出して知識ベースに蓄積する
 *     ③このアプリ独自の勝敗予測モデル(自社モデル。API-Footballの/predictions
 *       エンドポイントを使うホーム画面の「AI予測の実績」とは別物です)が、
 *       登録クラブの試合について自分で予測を立てる
 *     ④試合が終わったら、その予測が本当に当たったかどうかを検証する
 *     ⑤十分な検証データが溜まったら、予測モデルの少数のパラメータ(ホーム
 *       アドバンテージの大きさ・フォーム差への感度)を、実際の的中率が
 *       「今までより良くなる場合に限り」更新する(悪化する変更は採用しない)
 *   という、透明で説明可能な「統計モデルの自己改善サイクル」です。ディープ
 *   ラーニングではありませんが、架空の数字ではなく実データに基づいて本当に
 *   動く仕組みです。
 *
 * なぜ既存の「AI予測の実績」(pred:*, handleAccuracyStats)と別扱いにしているか:
 *   既存の仕組みは、あえて「当たるかどうか分からない自作ロジック」を検証対象に
 *   せず、API-Footballが公表している本物の予測(/predictions)の的中率だけを
 *   記録する設計でした(server.js内のコメント参照)。この学習エンジンはその
 *   設計方針とは目的が異なり、「このアプリ自身の予測モデルを、実データで
 *   検証しながら育てる」ことが目的です。混同を避けるため、Redisキーの名前空間を
 *   完全に分け(pred:* ではなく learn:*)、ホーム画面でも「AI予測の実績」とは
 *   別の指標として明示的にラベルを分けて表示します。
 *
 * 依存はすべて呼び出し側から注入されます(server.js自身をrequireしない設計。
 * server/rag/knowledgeSource.js の createKnowledgeSource と同じ方針)。
 *
 * Stage E以降の変更点(リファクタリング):
 *   従来この学習エンジンは「事実」を learn:facts:* というアドホックなRedisの
 *   キーに直接読み書きしていました(重複排除も失効管理も無い簡易な実装)。
 *   Stage Eで実装した server/knowledge/knowledgeStore.js(Knowledge Engine)が
 *   同じ役割(事実/分析/意見の分離保存・重複排除・失効管理)をより正式に担うため、
 *   このファイルの「事実」保存はKnowledge Engine経由に置き換えました
 *   (学習エンジン自身をrequire("../knowledge/knowledgeStore")し、注入された
 *   Upstashの基本関数から自分でインスタンスを作る、既存のDI方針を踏襲)。
 *
 *   また、⑥として「Hypothesis Engine」を追加しました: 自社予測モデルが新しい
 *   予測を立てる際、「なぜその予測なのか」という状態仮説(stateHypothesis)を
 *   一緒に記録し、試合結果が出て予測を検証するタイミングで、その仮説が
 *   当たっていたかどうかも検証します。当たっていればKnowledge Engineに
 *   「検証済みの分析(analysis)」として昇格させ、外れていれば正直に破棄します
 *   (知識として保存しない)。
 */
const { REGISTERED_TEAMS } = require("./registeredTeams");
const { createKnowledgeStore } = require("../knowledge/knowledgeStore");
const { createMemoryStore } = require("../memory/memoryStore");
const { createRelationshipIndex } = require("../knowledge/relationshipIndex");
const { createClubProfileEngine } = require("../knowledge/clubProfileEngine");
const { summarizeTransfers } = require("../rag/knowledgeSource");
const { collectLeagueKnowledge } = require("./leagueKnowledge");
const { collectPlayerKnowledge, PLAYER_UPDATE_CAP_DEFAULT } = require("./playerDailyUpdate");
const { buildMatchFeatures } = require("./featureEngine");
const { createApiBudget, DEFAULT_DAILY_BUDGET, DEFAULT_USER_RESERVE } = require("./apiBudget");
// 2026年8月・優先順位⑫: 「何でも保存する」のをやめ、AI自身が学ぶ価値を判断する
const { assessImportance, summarizeImportance } = require("./importanceEngine");
// 2026年8月・「知識量を大幅に増やす」フェーズ: UEFA上位100クラブの日次収集
const { collectUniverse } = require("./universeCollector");
const { createClubDossier } = require("../knowledge/clubDossier");
const { buildDailySnapshot, saveDailyMetrics, compareSnapshots, METRICS_KEY_PREFIX } = require("./dailyMetrics");
const {
  computeGoalRateFeatures, computeFatigueFeature,
  fetchInjuryCountFeature, fetchStandingsFeature, fetchHeadToHeadFeature,
  inferLeagueIdFromFixtures, computeHomeAwaySplit, fetchCoachCareer,
  fetchTeamXgAverage, fetchTeamTopScorer,
} = require("./features");
const {
  EXTENDED_DEFAULT_WEIGHTS, computeMatchFeatures, predictOutcomeV2, isSaneWeights,
  computeFactorImportance, backtestAccuracyV2, fitWeightsGradientDescent,
  buildLearningSummary, classifyFailureReasons, summarizeFailureReasons,
  classifySuccessReasons, summarizeSuccessReasons, classifyContextualFailureReasons,
  computeFeatureEffectiveness, buildAblationCandidates, mostLikelyScoreline,
} = require("./predictionModel");
// ---- 2026年8月・「本当に毎日賢くなるAI」フェーズ ----
// ⑨ 予測精度の毎日測定(勝敗/BTTS/Over-Under、Brier・LogLoss・較正)
const { scorePrediction, buildDailyAccuracy, saveDailyAccuracy, getAccuracyTrend } = require("./accuracyTracker");
// ---- 2026年8月・AI知能計測ラウンド(ご指示①〜⑨) ----
// 考察の質・RAG使用率の日次保存、エンジン別成長率、Knowledgeの寄与ランキング、
// 精度低下の自己分析、そして毎日の自己評価「今日のAIは昨日より賢くなったか?」
const {
  flushIntelDaily, getIntelTrend, computeHypothesisStats, buildEngineGrowth,
  buildKnowledgeContributionRanking, buildAccuracyDiagnosis, buildSelfAssessment,
  collectAnswerabilityFromBuffer, processAnswerability,
  INTEL_KEY_PREFIX, INTEL_REPORT_KEY_PREFIX,
} = require("./intelligenceMetrics");
// ---- 2026年8月・精度証明ラウンド ----
// ② 較正に基づく自信の自動補正(実測のズレで翌日の表示勝率を補正)
const { buildCalibrationMap } = require("./calibrationCorrection");
// ⑤ オッズ比較・ROI(市場という最も厳しい採点者との毎日比較)
const { extractMatchWinnerOdds, impliedProbsPct, scoreRoiForRecord, emptyRoiDaily, saveDailyRoi, getRoiTrend, ROI_KEY_PREFIX } = require("./roiTracker");
// ① RAG強化(似たクラブ索引・似た試合の検索)
const { clubVectorFromDossier, clubTraitsFromDossier, buildClubSimilarityIndex, findSimilarResolvedMatches, summarizeSimilarMatchesJa, saveClubSimilarityIndex, SIMILAR_CLUBS_KEY } = require("./similarityIndex");
// 自己改善ループ: 診断→提案→安全な実行→効果測定→履歴
const {
  loadTuneConfig, saveTuneConfig, appendHistory,
  buildSelfDiagnosis, buildImprovementProposals, applyProposals, evaluateDueChanges,
  TUNABLE_KNOBS, EVAL_AFTER_DAYS,
} = require("./selfImprovement");
const { computeMarketProbs } = require("./accuracyTracker");
const { CLUB_UNIVERSE, clubsForPrediction } = require("./clubUniverse");
// 2026年8月: 過去試合を使ったモデル調整(λの独立化・Dixon-Coles・採用ゲート)
const { tuneModelOnHistory, getTuningHistory } = require("./modelTuning");
// ① 学習によって「予測がどう変わったか」の記録
const { computePredictionShift } = require("./predictionShift");
// ⑩ AIが自分で「次に何を学ぶか」を決める
const { buildLearningAgenda, priorityClubsOf, saveAgenda, loadLatestAgenda } = require("./learningAgenda");
// ⑤ データの信頼度(出所×鮮度)。信頼度の高いデータほど強く学習する
const { sampleWeightOf, buildFeatureTrust } = require("./trustEngine");

// ---- 調整可能な上限(API-Football無料プランの1日100リクエスト枠を守るため) ----
// ---- 2026年8月・「TOP100の試合が漏れていないか」調査での引き上げ ----
// 旧値5は、API-Football無料プラン(1日100リクエスト)時代の名残り。
// 現在はProプラン(7,500件/日)で、日次学習の実測消費は約3,400件/日のため
// 4,000件以上の余力がある。予測1件あたりの実測コストは概ね10〜20リクエスト
// (次の試合・相手の直近10試合・怪我人×2・順位×2・過去対戦・xG・得点王)なので、
// 20件でも最大400件程度。最終方針③「精度>コスト。無駄だけ削る」に沿って
// **学習データの供給量を増やす**方向へ引き上げる。
// 予算が逼迫している日は下のループ内で apiBudget を見て自動的に止まる。
const OWN_PREDICT_LOG_CAP = Number(process.env.OWN_PREDICT_LOG_CAP) || 20; // 1回の実行で新しく記録する自社予測の件数上限
// 予測を1件立てるのに必要な最低リクエスト数の目安。これを下回ったら打ち切る。
const OWN_PREDICT_MIN_BUDGET = 25;
// ---- 2026年8月・上の引き上げと必ずセットで直す必要がある値 ----
// 記録を20件/日に増やしたのに解決が10件/日のままだと、保留キューが毎日
// 10件ずつ伸び続け、**答え合わせが永久に追いつかない**(正答率が古い試合の
// ものしか反映されなくなる)。記録上限を上回る値にし、溜まった分も消化できる
// ようにする。解決1件=/fixtures 1リクエストなので費用はごく小さい。
const OWN_PREDICT_RESOLVE_CAP = Math.max(30, OWN_PREDICT_LOG_CAP * 1.5); // 1回の実行で解決を試みる保留中予測の件数上限
const MIN_RESOLVED_FOR_RECALIBRATION = 10; // これ未満の検証データしかない場合は再調整しない(過学習防止)
const FORM_FACT_DELTA_THRESHOLD = 0.3; // このゲーム差分以上変化した場合だけ「事実」として記録する
// 2026年8月・監査で発見された「頭打ち」の直接原因のひとつを修正:
// 以前は30件固定だったため、試合を100件・1000件と積み重ねても、
// バックテスト(backtestAccuracy/backtestAccuracyV2)と重み学習
// (fitWeightsGradientDescent)は常に「直近30件」しか見ておらず、
// 古い検証結果は無条件で捨てられていた。これでは蓄積した実績が
// 統計的な確からしさの向上に一切つながらず、直近の少数データの
// ノイズに毎回振り回されるだけになる(=改善しているように見えて
// 実際には安定しない/頭打ちになる設計上のバグ)。300件に拡大し、
// 積み上がったデータが実際に学習の安定性・精度向上に寄与するようにする。
const OWN_PRED_RECENT_KEEP = 300;
// 2026年8月・「議論できるAI」強化フェーズ(ご要望②・Knowledge Engineの毎日成長):
// 監督交代・補強の確認(/coachs, /transfers)を全11クラブ毎日行うと+22リクエスト/日
// となり、既存の新規予測ロジック(最大約30リクエスト/日)と合わせてAPI-Football
// 無料枠(1日100リクエスト)を圧迫するリスクがあるため、日付ベースでずらした
// ローテーションで少数クラブずつ確認する(全クラブを数日かけて一巡する設計。
// Layer2プロフィール生成の「必要なクラブだけ」方式と同じ、予算重視の考え方)。
const COACH_TRANSFER_CHECK_CAP = 4;
// 移籍情報は「直近何日以内の移籍か」を区切って事実化する(既存のRAG層
// summarizeTransfersの既定と同じ180日ではなく、「今日追加した知識」欄が
// 埋もれないよう30日に絞る)。
const TRANSFER_FACT_WINDOW_DAYS = 30;

const DEFAULT_WEIGHTS = { homeBase: 1.35, awayBase: 1.15, sensitivity: 0.18, version: 0, updatedAt: null };

function outcomeFromScore(homeGoals, awayGoals) {
  if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) return null;
  if (homeGoals > awayGoals) return "home";
  if (homeGoals < awayGoals) return "away";
  return "draw";
}

// 直近最大10試合の「得失点差」から、直近5試合 vs その前の5試合のフォーム変化を計算する。
// 全て実際の試合結果(goals.home/away)から算出する客観的な数値であり、AIの推測は含まない。
function computeFormScore(fixtures, teamId) {
  const withDiff = [...(fixtures || [])]
    .filter((f) => f && f.fixture && f.fixture.date && f.goals && f.goals.home !== null && f.goals.home !== undefined && f.goals.away !== null && f.goals.away !== undefined)
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .map((f) => {
      const isHome = f.teams && f.teams.home && f.teams.home.id === teamId;
      const gf = isHome ? f.goals.home : f.goals.away;
      const ga = isHome ? f.goals.away : f.goals.home;
      return gf - ga;
    });
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100 : null);
  const last5 = withDiff.slice(0, 5);
  const prev5 = withDiff.slice(5, 10);
  const last5Avg = avg(last5);
  const prev5Avg = avg(prev5);
  return {
    currentFormScore: last5Avg,
    delta: last5Avg !== null && prev5Avg !== null ? Math.round((last5Avg - prev5Avg) * 100) / 100 : null,
    sampleSize: withDiff.length,
  };
}

// 自社予測モデル: フォームスコア(得失点差の実データ)を根拠に、ホームアドバンテージと
// フォーム差への感度という、少数の解釈可能なパラメータだけで勝敗を予測する。
function predictOutcome(homeFormScore, awayFormScore, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  const diff = (homeFormScore || 0) - (awayFormScore || 0);
  const homeLambda = Math.max(0.4, w.homeBase + diff * w.sensitivity);
  const awayLambda = Math.max(0.4, w.awayBase - diff * w.sensitivity);
  const lambdaDiff = homeLambda - awayLambda;
  let predictedWinner = "draw";
  if (lambdaDiff > 0.15) predictedWinner = "home";
  else if (lambdaDiff < -0.15) predictedWinner = "away";
  return { homeLambda, awayLambda, predictedWinner };
}

// 実際に解決済みの過去記録(record.homeFormScore/awayFormScore/actualWinnerを保持)に対して、
// 与えられた重みでの的中率を計算する(=本物のバックテスト。架空の精度ではない)。
function backtestAccuracy(records, weights) {
  const usable = (records || []).filter((r) => r && r.actualWinner && typeof r.homeFormScore === "number" && typeof r.awayFormScore === "number");
  if (!usable.length) return null;
  const correct = usable.filter((r) => predictOutcome(r.homeFormScore, r.awayFormScore, weights).predictedWinner === r.actualWinner).length;
  return { accuracy: Math.round((correct / usable.length) * 1000) / 10, sampleSize: usable.length };
}

// Knowledge Engine Layer4(振り返り)の本文を機械的に組み立てる。LLMは使わない
// (試合結果と、予測時点で実際に使った特徴量・重みの数値だけから導出するため、
// でっち上げの余地がない)。
// 2026年8月・Failure Learning(ご要望①): 外れた場合はclassifyFailureReasons()の
// 出力(failureReasons)を必ず理由文に織り込む。「モデルが重視していた要素だけ
// では説明できませんでした」という曖昧な表現から、「過去対戦を重視しすぎた」
// 「怪我人を軽視した」のような具体的な原因の言語化に置き換える。
function buildReflectionText(record, weightsUsed, failureReasons) {
  const outcomeLabelJa = (w) => (w === "home" ? "ホームチームの勝利" : w === "away" ? "アウェイチームの勝利" : "引き分け");
  const importance = record && record.features ? computeFactorImportance(record.features, weightsUsed || EXTENDED_DEFAULT_WEIGHTS) : [];
  const weighted = importance.filter((i) => i.stars > 0);
  const top = weighted[0];

  if (record && record.correct) {
    const why = top
      ? `予想(${outcomeLabelJa(record.predictedWinner)})が的中しました。最も影響が大きかったと考えられる要素は「${top.labelJa}」です。`
      : `予想(${outcomeLabelJa(record.predictedWinner)})が的中しましたが、この予測が立てられた時点ではモデルはまだどの特徴量も強くは学習していませんでした(基本のフォーム差のみで判断)。`;
    const improvement = "この的中パターンを引き続きバックテストに使い、重みの再学習(fitWeightsGradientDescent)にも反映します。";
    return { why, improvement };
  }

  const reasons = failureReasons || [];
  const why = `予想は${outcomeLabelJa(record ? record.predictedWinner : null)}でしたが、実際は${outcomeLabelJa(record ? record.actualWinner : null)}でした。` +
    (reasons.length
      ? `外れた理由: ${reasons.map((r) => r.labelJa).join("、")}。`
      : weighted.length
      ? `モデルが重視していた要素(${weighted.map((i) => i.labelJa).join("、")})だけでは、この結果を十分に説明できませんでした。`
      : `この予測の時点ではモデルがどの特徴量も強く重視していなかった(学習データがまだ少ない)ため、精度が低い状態でした。`);
  const improvement = reasons.length
    ? `次回以降は、${reasons.map((r) => r.labelJa).join("・")}という傾向を踏まえて重みの再学習(fitWeightsGradientDescent)を行い、同じ理由で外れる頻度が下がるか検証します。`
    : "スタメン発表・直前の怪我人情報・監督采配など、現在のモデルにまだ組み込まれていない要因が結果に影響した可能性があります。継続してデータを蓄積し、重みの再学習で改善を試みます。";
  return { why, improvement };
}

// 2026年8月・本番で実際に発生したバグの修正(「今日追加した知識0件」の根本原因):
// Renderの無料プランはアクセスが無いとスリープし、起床に時間がかかる。
// GitHub Actions側のワークフロー(.github/workflows/daily-learning.yml)は
// 最初のリクエストがタイムアウトすると60秒待って自動的にもう一度呼び出す設計に
// なっており、かつ1回目のリクエストがクライアント側(GitHub Actions)ではタイム
// アウトしていても、Render側では処理が実際に最後まで完了していることがある。
// この場合、同じ日に学習エンジンが実質2回実行されることになる。
// 従来はrun-dailyを実行するたびにgrowthLog(learn:growthlog:*)をまるごと
// 上書きしていたため、1回目の実行で実際に新しい知識が保存されていても、
// 2回目の実行(内容は同じなので大半が「重複」と正しく判定される)の結果で
// 上書きされ、「今日追加した知識0件」という誤解を招く表示になっていた
// (Knowledge Engine自体の重複排除ロジックは正しく機能しており、データが
// 壊れていたわけではない。「その日の実行の合計」ではなく「直近1回の実行結果」
// を見せていた集計・表示側の設計ミス)。
// 同じ日付の既存ログがあれば、件数を合算し、一覧は内容(statement)で重複排除
// して連結し、モデルの状態を表す値(的中率・重み更新の有無等)だけは最新の
// 実行の値を使う。
function mergeGrowthLogs(previous, current) {
  if (!previous || previous.date !== current.date) return { ...current, runsToday: 1, firstRanAt: current.ranAt };
  const dedupeByStatement = (a, b) => {
    const seen = new Set((a || []).map((f) => f && f.statement));
    return [...(a || []), ...(b || []).filter((f) => !(f && seen.has(f.statement)))];
  };
  // 2026年8月・アップロード後の実機確認で判明: 同じ日に2回実行されると
  //   (日次学習は4:17と、取りこぼし用の8:43の2本立て)この合算処理が
  //   明示した項目しか引き継がないため、**新しく足した項目が消えていた**。
  //   予測カバー率と、無駄削減の実測値を引き継ぐ。
  const mergedFacts = dedupeByStatement(previous.facts, current.facts);
  const mergedOtherFacts = dedupeByStatement(previous.otherFactsToday, current.otherFactsToday);
  const mergedLeagueFacts = dedupeByStatement(previous.leagueFactsToday, current.leagueFactsToday);
  const mergedPlayerFacts = dedupeByStatement(previous.playerFactsToday, current.playerFactsToday);
  const sum = (a, b) => (a || 0) + (b || 0);
  // 優先順位⑦: 「更新できなかった理由」は、同じ選手・同じ項目の重複を除いて合算する
  // (同日に複数回実行しても同じ理由が並ぶだけなので)。
  const mergedUnavailable = (() => {
    const out = [];
    const seen = new Set();
    for (const row of [...(previous.playerUnavailableReasonsToday || []), ...(current.playerUnavailableReasonsToday || [])]) {
      if (!row) continue;
      const k = `${row.playerJa}|${row.fieldJa}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    return out;
  })();
  return {
    ...current, // 的中率・重み更新有無などの「状態」は最新の実行の値をそのまま使う
    ranAt: current.ranAt,
    firstRanAt: previous.firstRanAt || previous.ranAt,
    runsToday: (previous.runsToday || 1) + 1,
    // 2026年8月・本番確認で気づいた取りこぼし: ...current の展開だけだと、
    //   2回目の実行でこれらが取れなかった日に前回の値まで消える。
    //   また実行中の重複削減の実測は「置き換え」ではなく「合算」が正しい。
    predictionCoverage: current.predictionCoverage || previous.predictionCoverage || null,
    modelTuning: current.modelTuning || previous.modelTuning || null,
    apiRunMemo: (() => {
      const a = previous.apiRunMemo, b = current.apiRunMemo;
      if (!a) return b || null;
      if (!b) return a;
      const hits = (a.hits || 0) + (b.hits || 0);
      return {
        hits, misses: (a.misses || 0) + (b.misses || 0), savedRequests: hits,
        noteJa: hits > 0
          ? `本日の実行で同じ問い合わせが${hits}回発生したため、APIリクエストを${hits}件節約しました(取得データの量・鮮度は変わりません)。`
          : "重複した問い合わせはありませんでした。",
      };
    })(),
    facts: mergedFacts,
    factsAddedToday: mergedFacts.length,
    otherFactsToday: mergedOtherFacts,
    coachChangesDetectedToday: sum(previous.coachChangesDetectedToday, current.coachChangesDetectedToday),
    transferFactsAddedToday: sum(previous.transferFactsAddedToday, current.transferFactsAddedToday),
    knowledgeItemsSavedToday: sum(previous.knowledgeItemsSavedToday, current.knowledgeItemsSavedToday),
    knowledgeItemsDuplicateToday: sum(previous.knowledgeItemsDuplicateToday, current.knowledgeItemsDuplicateToday),
    // 2026年8月・優先順位⑥: リーグ単位の日次蓄積も、同日複数回実行された場合は
    // 合算する(既存のcoachChangesDetectedToday等と同じ方針)。
    // 日付ベースのローテーションのため、同日に複数回実行しても対象リーグの
    // 顔ぶれは変わらない(=足し算すると二重計上になる)。実際に処理できた
    // リーグ数として、実行間の最大値を採用する。
    leaguesAnalyzedToday: Math.max(previous.leaguesAnalyzedToday || 0, current.leaguesAnalyzedToday || 0),
    mandatoryLeaguesAnalyzedToday: Math.max(previous.mandatoryLeaguesAnalyzedToday || 0, current.mandatoryLeaguesAnalyzedToday || 0),
    extendedLeaguesAnalyzedToday: Math.max(previous.extendedLeaguesAnalyzedToday || 0, current.extendedLeaguesAnalyzedToday || 0),
    leagueFactsAddedToday: mergedLeagueFacts.length,
    leagueFactsDuplicateToday: sum(previous.leagueFactsDuplicateToday, current.leagueFactsDuplicateToday),
    leagueFactsToday: mergedLeagueFacts,
    // 2026年8月・優先順位⑦: 選手の日次更新。対象選手は日付ベースのローテーションで
    // 決まるため、同日の再実行では顔ぶれが変わらない(=最大値を採用する)。
    // 事実の件数・項目数は、リーグと同じく重複排除したうえで数える。
    playersCheckedToday: Math.max(previous.playersCheckedToday || 0, current.playersCheckedToday || 0),
    playersUpdatedToday: Math.max(previous.playersUpdatedToday || 0, current.playersUpdatedToday || 0),
    playerFactsAddedToday: mergedPlayerFacts.length,
    playerFactsDuplicateToday: sum(previous.playerFactsDuplicateToday, current.playerFactsDuplicateToday),
    playerFactsToday: mergedPlayerFacts,
    playerFieldsUpdatedToday: Math.max(previous.playerFieldsUpdatedToday || 0, current.playerFieldsUpdatedToday || 0),
    playerFieldsPermanentlyUnavailable: Math.max(previous.playerFieldsPermanentlyUnavailable || 0, current.playerFieldsPermanentlyUnavailable || 0),
    playerFieldsRetryableToday: Math.max(previous.playerFieldsRetryableToday || 0, current.playerFieldsRetryableToday || 0),
    playerUnavailableReasonsToday: mergedUnavailable,
    matchesResolvedToday: sum(previous.matchesResolvedToday, current.matchesResolvedToday),
    newPredictionsLogged: sum(previous.newPredictionsLogged, current.newPredictionsLogged),
    hypothesesConfirmed: sum(previous.hypothesesConfirmed, current.hypothesesConfirmed),
    hypothesesDiscarded: sum(previous.hypothesesDiscarded, current.hypothesesDiscarded),
    reflectionsSaved: sum(previous.reflectionsSaved, current.reflectionsSaved),
    profilesGenerated: sum(previous.profilesGenerated, current.profilesGenerated),
    // 第8次監査(Low)の修正: 「見解が変わった/変わらなかったクラブ数」は同じ11クラブを
    // 実行のたびに数え直すため、sumすると14回実行で154クラブ分に水増しされていた。
    // 同日の再実行では最大値を採用する(リーグ・選手と同じ規則)。
    aiViewsChanged: Math.max(previous.aiViewsChanged || 0, current.aiViewsChanged || 0),
    aiViewsUnchanged: Math.max(previous.aiViewsUnchanged || 0, current.aiViewsUnchanged || 0),
    // 第8次監査(Medium)の修正: 同日の1回目で重みが更新され(true)、2回目が更新なし(false)
    // だと、`...current`の上書きでtrueが消え、「重みを更新しました」の実績が
    // メトリクスとダッシュボードから消えていた。その日一度でも更新されていれば残す。
    weightsUpdated: !!(previous.weightsUpdated || current.weightsUpdated),
    weightsUpdatedV2: !!(previous.weightsUpdatedV2 || current.weightsUpdatedV2),
    v2AccuracyBefore: current.v2AccuracyBefore ?? previous.v2AccuracyBefore ?? null,
    v2AccuracyAfter: current.v2AccuracyAfter ?? previous.v2AccuracyAfter ?? null,
    // 第5次監査で発見した「成長ログの肥大化」の修正。
    //   この3項目だけが重複排除も上限も無いまま単純連結されていた。
    //   API-Footballが落ちている日は1回の実行で約100件のエラー文字列が出るため、
    //   同日に何度も実行されると learn:growthlog:<date> という**1つのJSON値**に
    //   千件以上の文字列が積み上がる。この値は実行のたびに読み込み→結合→
    //   2つのキーへ書き戻すため転送量が二乗で増え、さらに
    //   learn:growthlog:latest はトップページを開くたびに取得される。
    //   同じ内容を何度も並べても情報は増えないので、重複排除したうえで上限を設ける。
    failureReasonsToday: capList([...(previous.failureReasonsToday || []), ...(current.failureReasonsToday || [])]),
    successReasonsToday: capList([...(previous.successReasonsToday || []), ...(current.successReasonsToday || [])]),
    llmSkippedReasons: Array.from(new Set([...(previous.llmSkippedReasons || []), ...(current.llmSkippedReasons || [])])),
    // 優先順位⑫: 同日に複数回実行された場合、重要度の内訳は合算し、
    // 「今日いちばん学ぶ価値があったこと」は重要な方を残す。
    importanceSummary: mergeImportanceSummaries(previous.importanceSummary, current.importanceSummary),
    // 宇宙収集は輪番のため、同日の再実行では対象が同じ=最大値を採用する。
    // 変化の一覧は内容で重複排除する。
    universe: (() => {
      const p = previous.universe; const c = current.universe;
      if (!p) return c || null;
      if (!c) return p;
      const seen = new Set();
      const changes = [...(p.changesDetected || []), ...(c.changesDetected || [])]
        .filter((x) => { const k = `${x.club}|${x.changeJa}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 20);
      return {
        coreClubsPlanned: Math.max(p.coreClubsPlanned || 0, c.coreClubsPlanned || 0),
        coreClubsUpdated: Math.max(p.coreClubsUpdated || 0, c.coreClubsUpdated || 0),
        squadsUpdated: Math.max(p.squadsUpdated || 0, c.squadsUpdated || 0),
        playersUpdated: Math.max(p.playersUpdated || 0, c.playersUpdated || 0),
        xgClubsUpdated: Math.max(p.xgClubsUpdated || 0, c.xgClubsUpdated || 0),
        standingsLeaguesUpdated: Math.max(p.standingsLeaguesUpdated || 0, c.standingsLeaguesUpdated || 0),
        changesDetected: changes,
        skipped: capList([...(p.skipped || []), ...(c.skipped || [])]),
        errors: capList([...(p.errors || []), ...(c.errors || [])]),
        errorCount: (p.errorCount || 0) + (c.errorCount || 0),
        playersIndexed: Math.max(p.playersIndexed || 0, c.playersIndexed || 0),
        playersFromSquadSync: Math.max(p.playersFromSquadSync || 0, c.playersFromSquadSync || 0),
        playersFromDetailStats: Math.max(p.playersFromDetailStats || 0, c.playersFromDetailStats || 0),
        agendaClubsApplied: Array.from(new Set([...(p.agendaClubsApplied || []), ...(c.agendaClubsApplied || [])])),
        unresolvedClubs: (() => {
          const seen = new Set(); const out = [];
          for (const u of [...(p.unresolvedClubs || []), ...(c.unresolvedClubs || [])]) {
            if (u && u.nameEn && !seen.has(u.nameEn)) { seen.add(u.nameEn); out.push(u); }
          }
          return out;
        })(),
      };
    })(),
    // ---- 2026年8月・「本当に毎日賢くなるAI」フェーズの項目の合算規則 ----
    // 答え合わせ件数は実行ごとに別の試合なので合算。予測変化・特徴量有効性・
    // 学習計画・学習証明は「その日最後に計算できた値」を残す(後の実行がnullでも
    // 前の実行の実測を消さない)。
    accuracyScoredToday: sum(previous.accuracyScoredToday, current.accuracyScoredToday),
    predictionShift: current.predictionShift || previous.predictionShift || null,
    featureEffectiveness: current.featureEffectiveness || previous.featureEffectiveness || null,
    learningAgenda: current.learningAgenda || previous.learningAgenda || null,
    agendaAppliedToday: current.agendaAppliedToday || previous.agendaAppliedToday || null,
    learningProof: current.learningProof || previous.learningProof || null,
    // AI知能計測ラウンド(ご指示①〜⑨): 知能レポート(自己評価・成長率など)も
    // 「その日最後に計算できた値」を残す(後の実行がまだ計算していなくても
    // 前の実行の実測を消さない)。
    intelligence: current.intelligence || previous.intelligence || null,
    // 成長可視化ラウンド: カテゴリ別の学習内訳(その日最後に保存できた累計値)
    knowledgeByCategoryToday: current.knowledgeByCategoryToday || previous.knowledgeByCategoryToday || null,
    errors: capList([...(previous.errors || []), ...(current.errors || [])]),
  };
}

// 依存を増やさない小さな安定ハッシュ(knowledgeStore.js の stableHash と同じ方式)。
// 「前回と根拠が1文字も変わっていないか」の比較だけに使う。
function stableTextHash(input) {
  const s = String(input || "");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

// 優先順位⑫: 同じ日に複数回実行されたときの、重要度内訳の合算。
// 件数は足し算、ハイライトは重要度の高い順に最大5件だけ残す。
function mergeImportanceSummaries(prev, cur) {
  if (!prev) return cur || null;
  if (!cur) return prev;
  const IMP_ORDER = { critical: 4, high: 3, medium: 2, low: 1, routine: 0 };
  const counts = {};
  for (const k of ["critical", "high", "medium", "low", "routine"]) {
    counts[k] = ((prev.counts && prev.counts[k]) || 0) + ((cur.counts && cur.counts[k]) || 0);
  }
  const seen = new Set();
  const highlights = [...(prev.highlights || []), ...(cur.highlights || [])]
    .filter((h) => { const k = `${h.teamJa}|${h.statement}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (IMP_ORDER[b.level] || 0) - (IMP_ORDER[a.level] || 0))
    .slice(0, 5);
  const notableCount = counts.critical + counts.high;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    counts, notableCount, highlights,
    summaryJa: notableCount > 0
      ? `本日学んだ${total}件のうち、${counts.critical}件が最重要、${counts.high}件が重要でした。`
      : `本日学んだ${total}件は、いずれも日常的な更新の範囲でした(特筆すべき変化はありませんでした)。`,
  };
}

// 成長ログに載せるリストの上限。重複を除いたうえで先頭N件だけ残し、
// 打ち切った場合は「何件省略したか」を正直に記す(黙って捨てない)。
//
// ■ 第6次監査(第5次の修正内容そのものの検証)で発見した2つの不具合の修正
//   (1) この関数は最初、文字列だけを想定して `typeof s === "string"` で
//       絞り込んでいた。ところが failureReasonsToday / successReasonsToday は
//       **オブジェクトの配列**({id, labelJa, detail, teamEn})である。
//       その結果、同じ日に2回目の実行が走ると、今日分析した失敗理由・成功理由が
//       **まるごと消える**という深刻な後退を招いていた
//       (Renderのスリープ復帰や6時間ごとのcronで、同日2回目は日常的に起きる)。
//   (2) 重複を「(N件)」と文面に書き足していたため、次の実行でその文字列を
//       もう一度この関数に通すと「(2件)(2件)」と入れ子になり、
//       件数そのものも誤りになっていた。
//   対策: 文字列でもオブジェクトでも扱えるようにし、件数は文面に書き足さず
//   別フィールド(occurrences)として持つ。文面は決して書き換えない。
const GROWTH_LOG_LIST_CAP = 60;
function capList(list, cap = GROWTH_LOG_LIST_CAP) {
  const items = (list || []).filter((v) => v !== null && v !== undefined && v !== "");
  // 同じ内容が何度出たかは残す価値があるので、内容をキーにまとめる。
  // 文字列はそのまま、オブジェクトはJSONを鍵にする(文面は一切変えない)。
  const COUNT_SUFFIX = /【(\d+)回】$/;
  const byKey = new Map();
  for (const v of items) {
    // 前回の実行で付けた「【N回】」を一度はがしてから数え直す。
    // これをしないと再実行のたびに入れ子になり、件数も誤りになる。
    const isStr = typeof v === "string";
    const m = isStr ? v.match(COUNT_SUFFIX) : null;
    const base = isStr ? (m ? v.slice(0, m.index) : v) : v;
    const n = m ? Number(m[1]) : (!isStr && v && Number.isFinite(v.occurrences) ? v.occurrences : 1);
    let bare = base;
    if (!isStr && base && typeof base === "object" && "occurrences" in base) {
      bare = { ...base }; delete bare.occurrences;
    }
    let key;
    try { key = isStr ? bare : JSON.stringify(bare); } catch (e) { key = String(bare); }
    const hit = byKey.get(key);
    if (hit) hit.occurrences += n;
    else byKey.set(key, { value: bare, occurrences: n });
  }
  const unique = Array.from(byKey.values()).map(({ value, occurrences }) => {
    if (occurrences <= 1) return value;
    // 文字列は別フィールドを持てないため、末尾に一度だけ回数を付ける。
    if (typeof value === "string") return `${value}【${occurrences}回】`;
    return { ...value, occurrences };
  });
  if (unique.length <= cap) return unique;
  return [...unique.slice(0, cap), `…ほか${unique.length - cap}種類を省略しました(表示件数の上限${cap}件)`];
}

async function runDailyLearning(deps) {
  const {
    callApiFootball: rawCallApiFootball, resolveTeamId,
    upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON,
    now, generateLLM, getApiPlanInfo, getSharedApiBudget,
    // 第7次監査で追加: 日付キーの基準となるタイムゾーンを呼び出し側から渡す。
    // これが無いとUTC基準になり、日本の利用者が「今朝動いた」と感じる実行が
    // 前日の記録として保存され、健康診断が一日中「実行記録がありません」と
    // 誤報していた。未指定なら従来通りUTC(既存のテストとの後方互換)。
    appDateKey: appDateKeyFn,
    // 2026年8月・優先順位⑲/⑳で追加(いずれも任意。未指定でも従来通り動く)
    //   knowledgeGraph  … クラブ→監督→戦術→選手→怪我→布陣→試合→分析→学習結果 を
    //                     相互に辿れる知識グラフ
    //   thoughtTimeline … 見立て→きっかけ→予測→結果→学び を1本の線として記録する
    knowledgeGraph, thoughtTimeline,
  } = deps;
  // ---- 2026年8月・全機能監査での実測にもとづく無駄の削減 ----
  //   1回の日次学習で同じAPIを同じ引数で何度も呼んでいた(実測: 1,063回のうち
  //   ユニークは832回 = **231回・22%が完全な重複**)。特に
  //   /standings は42回、/players/topscorers は22回、同一試合の
  //   /fixtures/statistics は各20回、同じ引数で呼ばれていた。
  //   予測対象をTOP100へ広げたことで、この重複はさらに増えていた。
  //
  //   1回の実行(数分)の中では、これらの応答は変化しない。
  //   **実行中だけ有効な記憶**を挟むことで、取得するデータ量・鮮度・
  //   更新頻度は一切減らさずに、無駄な通信だけを消す
  //   (最終方針③「精度>コスト。無駄だけ削る」に沿う)。
  const RUN_MEMO_ENDPOINTS = new Set([
    "/standings", "/players/topscorers", "/players/topassists",
    "/injuries", "/fixtures/statistics", "/fixtures/headtohead",
    "/teams", "/players/squads", "/leagues", "/coachs", "/fixtures/lineups",
    // /fixtures も1回の実行の中では変わらない(直近10試合・次の試合・特定ID)。
    // フォーム計算ループと予測ループが同じクラブを二度取りに行っていた。
    "/fixtures",
  ]);
  const RUN_MEMO_MAX = 4000; // 暴走時の安全弁(1回の実行でこれを超えることは無い想定)
  const runMemo = new Map();
  let runMemoHits = 0, runMemoMisses = 0;
  const callApiFootball = async (endpoint, params, opts) => {
    if (!RUN_MEMO_ENDPOINTS.has(endpoint) || runMemo.size >= RUN_MEMO_MAX) {
      return rawCallApiFootball(endpoint, params, opts);
    }
    const key = endpoint + "?" + JSON.stringify(params || {});
    if (runMemo.has(key)) { runMemoHits++; return runMemo.get(key); }
    runMemoMisses++;
    // 失敗はキャッシュしない(次の呼び出しでちゃんと再試行させる)
    const result = await rawCallApiFootball(endpoint, params, opts);
    runMemo.set(key, result);
    return result;
  };

  const nowFn = typeof now === "function" ? now : () => new Date();
  const runAt = nowFn();
  const dateKey = typeof appDateKeyFn === "function"
    ? appDateKeyFn(runAt)
    : runAt.toISOString().slice(0, 10); // YYYY-MM-DD(利用者のいる地域の「今日」)
  // 2026年8月・完全自動Learning Cycle ⑧「Learning Time」: 学習にかかった実時間を計測する。
  const learningStartedAtMs = Date.now();

  if (!upstashEnabled) {
    return { ok: false, reason: "NO_UPSTASH", message: "Upstash未設定のため学習エンジンは記録できません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }

  const knowledgeStore = createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
  // 2026年8月・優先順位⑫: その日に学んだ内容を「重要度つき」で集める。
  // 単に件数を数えるのではなく、何が最重要だったかを利用者へ伝えるため。
  const learnedWithImportance = [];
  // 実データから拾った手がかりを、クラブごとに集約しておく
  // (重要度の判定は、1つの事実だけでなく「そのクラブに今日何が起きたか」を
  //  まとめて見た方が正確になるため)。
  const teamSignals = new Map();
  const signalOf = (nameEn) => {
    if (!teamSignals.has(nameEn)) teamSignals.set(nameEn, {});
    return teamSignals.get(nameEn);
  };
  /**
   * 知識を保存し、同時に「なぜ学ぶ価値があると判断したか」を記録する。
   * 既存の saveKnowledgeItem をそのまま使うので、保存の挙動は変えていない。
   */
  // どのカテゴリの知識に、どの手がかりを使ってよいか。
  //
  // ■ 監査で発見した重大な欠陥の修正
  //   当初はクラブ単位で集めた手がかり(監督交代・移籍件数など)を、
  //   **そのクラブの全ての知識に無条件で適用**していた。その結果、
  //   「直近5試合の得失点差が上昇しました(+0.31)」という何でもない事実に対して
  //   「監督が交代しました。だから最優先で学ぶべきと判断しました」という
  //   **その項目とは無関係な理由**が付き、しかもそれが画面の最も目立つ場所に
  //   「AIがこれを学ぶべきと判断した理由」として表示されていた。
  //   理由が事実と食い違っている以上、これはでっち上げそのものだった。
  //   知識の種類ごとに、その項目について語ってよい手がかりだけを使う。
  const SIGNALS_ALLOWED_BY_CATEGORY = {
    coachChange: ["coachChanged"],
    transferImpact: ["transferCount"],
    injuries: ["injuryCount", "previousInjuryCount"],
    recentFormTrend: ["formDelta", "streak"],
    homeAway: ["formDelta"],
    matchReflection: ["predictionMissMargin"],
    predictionFailureReason: ["predictionMissMargin"],
    predictionContextualFailure: ["predictionMissMargin"],
    predictionSuccessReason: [],
  };
  const saveWithImportance = async (item, extraSignals) => {
    const result = await knowledgeStore.saveKnowledgeItem(item);
    if (result.saved) {
      const allowed = SIGNALS_ALLOWED_BY_CATEGORY[item.category] || [];
      const clubSignals = teamSignals.get(item.teamEn) || {};
      const picked = {};
      for (const k of allowed) if (clubSignals[k] !== undefined) picked[k] = clubSignals[k];
      const importance = assessImportance({
        category: item.category,
        ...picked,
        ...(extraSignals || {}),
      });
      learnedWithImportance.push({
        teamEn: item.teamEn, teamJa: item.teamJa || item.teamEn,
        category: item.category, statement: item.statement, importance,
      });
      // 重要度と判断理由は知識そのものにも書き戻す(後から検証できるように)
      // 監査の指摘への対応: 上限もTTLも無いまま書き続けていた。
      // 知識そのものの失効(最長60日)より長く残す意味は無いので、90日で消す。
      await upstashSetJSON(`knowledge:importance:${result.hash}`, {
        level: importance.level, score: importance.score,
        reasonJa: importance.reasonJa, signals: importance.signals,
        recordedAt: runAt.toISOString(),
      }).catch(() => {});
      await upstashCmd(["EXPIRE", `knowledge:importance:${result.hash}`, "7776000"]).catch(() => {});
    }
    return result;
  };
  // 2026年8月・優先順位⑦: APIリクエスト予算ガード。1日の上限に静かに突き当たって
  // 「エラーだらけで知識0件」になる事故(優先順位⑨のご指摘)を防ぐため、消費量を
  // 記録し、予算が尽きそうなときはオプション扱いの処理を理由つきで見送る。
  // 2026年8月・優先順位⑪: 1日の上限は、次の優先順位で決める。
  //   1. API-Footballのレスポンスヘッダーから自動判定した実際の契約プランの上限
  //      (Pro加入後にAPI_DAILY_BUDGETを設定し忘れても自動的に追従する)
  //   2. 環境変数 API_DAILY_BUDGET(自動判定より小さく抑えたい場合の手動指定)
  //   3. 既定値100(無料プラン想定)
  // 「自動判定より手動設定の方が大きい」場合は、実際には使えない量を使おうとして
  // 大量のエラーになるため、安全側(小さい方)を採用する。
  const detectedPlan = (typeof getApiPlanInfo === "function") ? getApiPlanInfo() : null;
  const detectedLimit = detectedPlan && detectedPlan.detectedDailyLimit;
  const manualLimit = Number(process.env.API_DAILY_BUDGET) || null;
  let effectiveDailyBudget;
  let budgetSourceJa;
  if (detectedLimit && manualLimit) {
    effectiveDailyBudget = Math.min(detectedLimit, manualLimit);
    budgetSourceJa = detectedLimit <= manualLimit
      ? `API-Footballから自動判定した実際の上限(${detectedLimit}件/日・${detectedPlan.planNameJa})を採用しました(API_DAILY_BUDGET=${manualLimit}は実際の上限を超えているため、安全のため自動判定値を使います)。`
      : `手動設定のAPI_DAILY_BUDGET=${manualLimit}件/日を採用しました(実際の契約上限は${detectedLimit}件/日・${detectedPlan.planNameJa})。`;
  } else if (detectedLimit) {
    effectiveDailyBudget = detectedLimit;
    budgetSourceJa = `API-Footballから自動判定した実際の上限(${detectedLimit}件/日・${detectedPlan.planNameJa})を採用しました。手動設定は不要です。`;
  } else if (manualLimit) {
    effectiveDailyBudget = manualLimit;
    budgetSourceJa = `手動設定のAPI_DAILY_BUDGET=${manualLimit}件/日を採用しました(まだAPI-Footballを呼べていないため、実際の契約プランは自動判定できていません)。`;
  } else {
    effectiveDailyBudget = DEFAULT_DAILY_BUDGET;
    budgetSourceJa = `既定値(${DEFAULT_DAILY_BUDGET}件/日・無料プラン想定)を採用しました。`;
  }
  // 2026年8月・API予算ガードの構造的修正:
  // 予算チェックは callApiFootball の内部へ移した(どこから呼んでも必ず通る)。
  // ここで別インスタンスを作ると二重計上になるため、server.js が持つ
  // 共有インスタンスを使う。注入されていない場合(単体テスト等)だけ自前で作る。
  const usingSharedBudget = (typeof getSharedApiBudget === "function");
  const apiBudget = usingSharedBudget
    ? await getSharedApiBudget()
    : createApiBudget({
      upstashEnabled, upstashGetJSON, upstashSetJSON,
      dailyBudget: effectiveDailyBudget,
      userReserve: Number(process.env.API_USER_RESERVE) || DEFAULT_USER_RESERVE,
    });
  if (typeof getSharedApiBudget !== "function") await apiBudget.init(dateKey);
  const memoryStore = createMemoryStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
  const relationshipIndex = createRelationshipIndex({ upstashEnabled, upstashGetJSON, upstashSetJSON });
  const clubProfileEngine = createClubProfileEngine({ generateLLM, knowledgeStore, setRelation: relationshipIndex.setRelation });

  const errors = [];
  const factsToday = [];
  const failureReasonsToday = []; // Failure Learning(ご要望①): 今日外れた予測の理由一覧
  const successReasonsToday = []; // 2026年8月・完全自動Learning Cycle ⑧: 今日当たった予測の理由一覧
  let matchesResolvedToday = 0;
  let newPredictionsLogged = 0;
  let hypothesesConfirmed = 0; // Hypothesis Engine: 検証の結果、当たっていた状態仮説の件数
  let hypothesesDiscarded = 0; // Hypothesis Engine: 検証の結果、外れて破棄した状態仮説の件数
  const roiAggToday = emptyRoiDaily(); // 精度証明ラウンド⑤: 本日のROI集計(オッズつきの答え合わせ)
  let reflectionsSaved = 0; // Layer4: 当たり/外れ問わず「振り返り」を保存した件数
  let profilesGenerated = 0; // Layer2: 新しく生成した固定知識(クラブプロフィール)の件数
  let aiViewsChanged = 0; // Layer3: 前日から見解が変わったクラブの件数
  let aiViewsUnchanged = 0;
  const llmSkippedReasons = [];

  // ---- ① 登録クラブの実結果から「事実」を抽出(Layer1)+ v2特徴量の下地を計算 ----
  const teamFormCache = new Map();
  // 2026年8月・優先順位②: 同じリーグ・同じチームの得点ランキング取得を
  // 1回の実行内で重複させないためのキャッシュ(APIリクエストの節約)。
  const teamTopScorerCache = new Map(); // nameEn -> { teamId, currentFormScore, sampleSize, avgGoalsFor, avgGoalsAgainst, matchesLast7Days, fixtures }
  for (const team of REGISTERED_TEAMS) {
    try {
      const teamId = await resolveTeamId(team.nameEn);
      if (!teamId) { errors.push(`team_not_found:${team.nameEn}`); continue; }
      const data = await callApiFootball("/fixtures", { team: teamId, last: 10 });
      const fixtures = (data && data.response) || [];
      const form = computeFormScore(fixtures, teamId);
      // Prediction Engine v2の追加特徴量のうち、既に取得済みのfixturesデータだけで
      // 計算できるもの(追加のAPI呼び出し無し)。
      const goalRates = computeGoalRateFeatures(fixtures, teamId);
      const fatigue = computeFatigueFeature(fixtures, runAt.getTime());
      teamFormCache.set(team.nameEn, { teamId, ...form, ...goalRates, ...fatigue, fixtures });
      if (form.delta !== null && Math.abs(form.delta) >= FORM_FACT_DELTA_THRESHOLD) {
        const direction = form.delta > 0 ? "上昇" : "低下";
        factsToday.push({
          date: dateKey,
          category: "フォーム",
          type: "fact",
          teamEn: team.nameEn,
          teamJa: team.nameJa,
          statement: `${team.nameJa}の直近5試合の1試合平均得失点差が、その前の5試合と比べて${direction}しました(${form.delta > 0 ? "+" : ""}${form.delta})。`,
          delta: form.delta,
          source: "API-Footballの実試合結果(直近10試合)から算出",
        });
      }

      // ---- 2026年8月・知識拡張フェーズ: ホーム/アウェイの差(実データ) ----
      // 既に取得済みのfixturesデータから追加のAPI呼び出し無しで計算できる。
      // 勝率差が明確な場合(20ポイント以上)だけ「事実」として記録する
      // (毎日ほぼ変わらない/僅差の場合まで記録すると知識ベースが埋もれるため)。
      const homeAway = computeHomeAwaySplit(fixtures, teamId);
      if (homeAway.home.sampleSize >= 2 && homeAway.away.sampleSize >= 2 && homeAway.home.winRate !== null && homeAway.away.winRate !== null) {
        const winRateDiff = homeAway.home.winRate - homeAway.away.winRate;
        if (Math.abs(winRateDiff) >= 0.2) {
          factsToday.push({
            date: dateKey,
            category: "ホームアウェイ差",
            type: "fact",
            teamEn: team.nameEn,
            teamJa: team.nameJa,
            statement: `${team.nameJa}は直近${homeAway.home.sampleSize}試合のホーム勝率${Math.round(homeAway.home.winRate * 100)}%に対し、直近${homeAway.away.sampleSize}試合のアウェイ勝率は${Math.round(homeAway.away.winRate * 100)}%と、${winRateDiff > 0 ? "ホームでの強さ" : "アウェイでの粘り強さ"}が目立ちます。`,
            source: "API-Footballの実試合結果(直近10試合、ホーム/アウェイ別集計)から算出",
          });
        }
      }
    } catch (e) {
      errors.push(`form_failed:${team.nameEn}:${e.message}`);
    }
  }

  // ---- ①-b Knowledge Engine Layer2(固定知識)の自動補完 ----
  // 既に有効なプロフィールがあるクラブはスキップされる(ensureClubProfile内部で
  // 判定)ため、実際にLLM呼び出しが発生するのは「まだプロフィールが無い/失効した」
  // クラブだけ(想定コストは低い。既定60日に1回程度)。
  for (const team of REGISTERED_TEAMS) {
    try {
      const cached = teamFormCache.get(team.nameEn);
      const groundingFacts = [];
      if (cached) {
        groundingFacts.push(`直近フォームスコア(得失点差): ${cached.currentFormScore ?? "不明"}`);
        groundingFacts.push(`直近試合の平均得点: ${cached.avgGoalsFor ?? "不明"}、平均失点: ${cached.avgGoalsAgainst ?? "不明"}`);
      }
      const result = await clubProfileEngine.ensureClubProfile(team.nameEn, team.nameJa, groundingFacts, runAt.toISOString());
      if (result.generated && result.saved) profilesGenerated++;
      if (result.reason === "LLM_NOT_CONFIGURED" && !llmSkippedReasons.includes("LLM_NOT_CONFIGURED")) {
        llmSkippedReasons.push("LLM_NOT_CONFIGURED");
      }
    } catch (e) {
      errors.push(`profile_failed:${team.nameEn}:${e.message}`);
    }
  }

  // ---- ①-c Knowledge Engine Layer3(AIの現在の見解)を毎日生成 ----
  // 「昨日何を考えていたか・今日何を考えているか・その理由」をMemory Engineに
  // 記録する(Memory Engineは変化検知・変化理由の保存を既に実装済みなので、
  // ここでは「今日の見解」をLLMに生成させて渡すだけでよい)。
  if (typeof generateLLM === "function") {
    for (const team of REGISTERED_TEAMS) {
      try {
        const cached = teamFormCache.get(team.nameEn);
        if (!cached) continue; // フォームデータが取れていないクラブは見解生成の根拠が無いためスキップ
        const previous = await memoryStore.getLastConclusion(`team:${team.nameEn}:dailyView`);
        const factsBlock = [
          `直近フォームスコア(得失点差): ${cached.currentFormScore ?? "不明"}`,
          `直近試合の平均得点: ${cached.avgGoalsFor ?? "不明"}、平均失点: ${cached.avgGoalsAgainst ?? "不明"}`,
          `直近7日間の試合数(過密日程の目安): ${cached.matchesLast7Days ?? "不明"}`,
        ].join("\n");

        // ---- 第5次監査で発見した「知識の水増し」への対策 ----
        //   LLMは同じ入力を与えても毎回わずかに違う文面を返す。Knowledge Engineの
        //   重複排除は文面のハッシュで判定するため、**実データがまったく
        //   変わっていない日でも「新しい知識を獲得した」と記録され続けていた**。
        //   さらに同日に複数回実行されると、その水増しが足し算されていた。
        //   結果として「昨日より賢くなりましたか?」という問いに、この仕組みは
        //   構造的に「はい」としか答えられなくなっていた。
        //
        //   対策: 根拠となる実データが前回と1文字も変わっていない場合は、
        //   LLMを呼ばずにスキップする。API/LLMのコストも同時に下がる。
        //   実データが動いた日にだけ見解を作り直すので、
        //   「知識が増えた=実際に何かが変わった」が成り立つようになる。
        const groundingKey = `learn:aiview:grounding:${team.nameEn}`;
        const groundingHash = stableTextHash(factsBlock);
        const prevGrounding = await upstashCmd(["GET", groundingKey]).catch(() => null);
        if (prevGrounding && String(prevGrounding) === groundingHash) {
          aiViewsUnchanged++;
          continue;
        }
        const systemPrompt = [
          "あなたはサッカークラブを毎日観察しているアナリストAIです。",
          "与えられた最新の実データだけを根拠に、このクラブについて今日のあなたの見解を1文(60文字以内)で述べてください。",
          "前回の見解(あれば)と比べて考えが変わった場合は、変わった理由も1文(60文字以内)で述べてください。",
          "さらに、直近の得点・失点の数値傾向から読み取れる、このクラブの得点パターン・失点パターン・プレースタイルについてのあなたの見解を1文(70文字以内)で述べてください。",
          "この見解はAPI-Footballの実データそのものではなく、あなた自身の分析であることが分かる書き方をしてください(数字を新しく作ってはいけません)。",
          '出力は次のJSON形式のみ: {"view": "...", "changeReason": "...", "playstyleNote": "..."}(変化が無い、または前回の見解が無い場合はchangeReasonは空文字列でよい)',
        ].join("\n");
        const userPrompt = [
          `クラブ: ${team.nameJa}`,
          `今日の実データ:\n${factsBlock}`,
          previous ? `前回(${previous.computedAt})の見解: ${previous.statement}` : "前回の見解: (まだありません)",
        ].join("\n\n");
        const { text } = await generateLLM({ systemPrompt, userPrompt, maxTokens: 260 });
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start === -1 || end === -1) throw new Error("LLM出力がJSON形式ではありませんでした");
        const parsed = JSON.parse(text.slice(start, end + 1));
        const viewStatement = String(parsed.view || "").slice(0, 200).trim();
        if (!viewStatement) continue;
        // 実データが動いたので、次回の比較用に今回の根拠を記録しておく
        // (48時間で自動削除。復活しても最悪もう一度生成されるだけで害はない)
        await upstashCmd(["SET", groundingKey, groundingHash, "EX", "172800"]).catch(() => {});

        const saveResult = await memoryStore.saveConclusion(
          `team:${team.nameEn}:dailyView`,
          { statement: viewStatement, computedAt: runAt.toISOString(), reasoning: "毎日学習エンジンによる自動生成(実データを根拠にLLMが要約)" },
          String(parsed.changeReason || "").slice(0, 200) || null
        );
        if (saveResult.changed) aiViewsChanged++; else aiViewsUnchanged++;

        // Knowledge Engineにもミラーしておく(RAG・議論モードから検索できるように)。
        await knowledgeStore.saveKnowledgeItem({
          teamEn: team.nameEn, teamJa: team.nameJa, category: "dailyAiView", type: "opinion",
          statement: `【AIの現在の見解】${viewStatement}`, isAiGenerated: true,
          computedAt: runAt.toISOString(), source: "毎日学習エンジンが実データを根拠に生成したAIの主観的な見解",
        });

        // ---- ご要望②: 戦術・プレースタイル・得点パターン・失点パターン ----
        // API-Footballには「戦術」「プレースタイル」を表す実データが存在しない
        // ため、実データ(得点・失点の数値傾向)を根拠にAIが分析した見解として
        // 「AI見解」ラベル付きで保存する(取得できるものはAPI、取得できない
        // ものはAIの分析として保存、というご指示への対応)。
        const playstyleNote = String((parsed && parsed.playstyleNote) || "").slice(0, 200).trim();
        if (playstyleNote) {
          await knowledgeStore.saveKnowledgeItem({
            teamEn: team.nameEn, teamJa: team.nameJa, category: "playstyleAnalysis", type: "opinion",
            statement: `【AI見解・戦術/得点失点パターン】${playstyleNote}`, isAiGenerated: true,
            computedAt: runAt.toISOString(),
            source: "実データ(得点・失点の数値傾向)を根拠にしたAIの分析(API-Footballにこの項目自体は存在しません)",
          });
        }
      } catch (e) {
        errors.push(`daily_view_failed:${team.nameEn}:${e.code || e.message}`);
      }
    }
  } else {
    llmSkippedReasons.push("LLM_NOT_CONFIGURED");
  }

  // ---- ①-d Knowledge Engine: 監督交代・補強の影響を毎日確認する(ご要望②) ----
  // 「監督交代による変化」「補強の影響」はいずれもAPI-Footballの実データ
  // (/coachs, /transfers)で取得できるため、AIの推測ではなく事実として記録する。
  // 全11クラブを毎日確認すると+22リクエスト/日となりAPI予算を圧迫するため、
  // COACH_TRANSFER_CHECK_CAP件/日のローテーションで少しずつ全クラブを巡回する。
  const coachTransferStartOffset = Math.abs((dateKey.split("-").join("") * 7) % REGISTERED_TEAMS.length) || 0;
  const coachTransferRotated = REGISTERED_TEAMS.slice(coachTransferStartOffset).concat(REGISTERED_TEAMS.slice(0, coachTransferStartOffset));
  let coachChangesDetectedToday = 0;
  let transferFactsAddedToday = 0;
  const otherFactsToday = []; // growthLogの表示専用(factsToday/既存の保存ループとは別経路で保存済みのため二重保存しない)
  for (const team of coachTransferRotated.slice(0, COACH_TRANSFER_CHECK_CAP)) {
    try {
      const cached = teamFormCache.get(team.nameEn);
      const teamId = cached ? cached.teamId : await resolveTeamId(team.nameEn);
      if (!teamId) continue;

      // 監督交代の検知: Memory Engineに「現在の監督名」を保持し、前回との差分で判定する
      // (INITIAL=初回記録は「交代」とは扱わない。比較対象が無いため)。
      try {
        const coachInfo = await fetchCoachCareer(teamId, callApiFootball);
        if (coachInfo.currentCoachName) {
          const coachSaveResult = await memoryStore.saveConclusion(
            `team:${team.nameEn}:coachName`,
            { statement: coachInfo.currentCoachName, computedAt: runAt.toISOString(), reasoning: "毎日学習エンジンによる自動記録(API-Footballの実データ)" },
            "監督交代を検知しました(API-Footballの実データ)。"
          );
          if (coachSaveResult.changed && coachSaveResult.reason === "CHANGED") {
            coachChangesDetectedToday++;
            const statement = `${team.nameJa}の監督が交代しました: ${coachSaveResult.previousStatement} → ${coachInfo.currentCoachName}。`;
            signalOf(team.nameEn).coachChanged = true;
            await saveWithImportance({
              teamEn: team.nameEn, teamJa: team.nameJa, category: "coachChange", type: "fact",
              statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/coachs)",
            });
            // 優先順位⑲: 知識グラフへ「クラブ→監督」の辺を張る(逆方向も辿れる)
            if (knowledgeGraph) {
              await knowledgeGraph.addEdge({
                fromType: "team", fromId: team.nameEn, fromLabelJa: team.nameJa,
                relation: "manager", toType: "coach", toId: coachInfo.currentCoachName,
                toLabelJa: coachInfo.currentCoachName, sinceAt: runAt.toISOString(),
                meta: { source: "API-Football /coachs" },
              }).catch(() => {});
            }
            otherFactsToday.push({ teamEn: team.nameEn, teamJa: team.nameJa, statement, category: "coachChange" });
          }
        }
      } catch (e) { errors.push(`coach_check_failed:${team.nameEn}:${e.message}`); }

      // 補強の影響: 直近30日以内の加入・退団をそのまま事実として記録する
      // (完全に同一内容の事実は knowledgeStore の重複排除により二重登録されない)。
      try {
        const transfersData = await callApiFootball("/transfers", { team: teamId });
        const sinceDate = new Date(runAt.getTime() - TRANSFER_FACT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const recentTransfers = summarizeTransfers(transfersData && transfersData.response, teamId, 5, sinceDate);
        for (const t of recentTransfers) {
          const statement = `${team.nameJa}: ${t.playerName}が${t.counterpart || "不明"}${t.direction === "加入" ? "から加入" : "へ退団"}しました(${t.date ? t.date.slice(0, 10) : "日付不明"})。`;
          // 監査で発見した欠陥の修正:
          //   /transfers は直近30日ぶんを返すため、同じ移籍が30日間ずっと数えられ、
          //   「直近で3件の移籍がありました。最優先で学ぶべき」という判定が
          //   1か月間毎日続いていた。新しく保存できたもの(=初めて知ったもの)
          //   だけを数える。件数の加算は保存の成否が分かった後に行う。
          const sig = signalOf(team.nameEn);
          const saveResult = await saveWithImportance({
            teamEn: team.nameEn, teamJa: team.nameJa, category: "transferImpact", type: "fact",
            statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/transfers)",
          });
          // 優先順位⑲: 「クラブ→加入/退団した選手」の辺(選手側から逆引きもできる)
          if (knowledgeGraph && t.playerName) {
            await knowledgeGraph.addEdge({
              fromType: "team", fromId: team.nameEn, fromLabelJa: team.nameJa,
              relation: t.direction === "加入" ? "transferredIn" : "transferredOut",
              toType: "player", toId: t.playerName, toLabelJa: t.playerName,
              sinceAt: t.date || null, meta: { counterpart: t.counterpart || null },
            }).catch(() => {});
          }
          if (saveResult.saved) {
            sig.transferCount = (sig.transferCount || 0) + 1;
            transferFactsAddedToday++;
            otherFactsToday.push({ teamEn: team.nameEn, teamJa: team.nameJa, statement, category: "transferImpact" });
          }
        }
      } catch (e) { errors.push(`transfer_check_failed:${team.nameEn}:${e.message}`); }
    } catch (e) {
      errors.push(`coach_transfer_check_failed:${team.nameEn}:${e.message}`);
    }
  }

  // ---- ①-e 主要リーグのKnowledge Engine日次蓄積(2026年8月・優先順位⑥) ----
  // 登録クラブ単位(REGISTERED_TEAMS)とは別に、リーグ単位で順位表・得点/
  // アシストランキングを毎日取得し蓄積する。欧州5大リーグは毎日必ず、それ
  // 以外のご要望にあった5リーグはローテーションで確認する(詳細は
  // server/learning/leagueKnowledge.jsのコメント参照)。
  let leagueResult = { leaguesProcessed: 0, mandatoryLeaguesProcessed: 0, extendedLeaguesProcessed: 0, leagueFactsSavedToday: 0, leagueFactsDuplicateToday: 0, leagueFactsToday: [], errors: [] };
  try {
    leagueResult = await collectLeagueKnowledge({ callApiFootball, knowledgeStore, upstashEnabled, upstashGetJSON, upstashSetJSON }, runAt, dateKey);
    if (leagueResult.errors && leagueResult.errors.length) errors.push(...leagueResult.errors);
  } catch (e) {
    errors.push(`league_knowledge_failed:${e.message}`);
  }

  // ---- ①-f 選手情報の日次更新(2026年8月・優先順位⑦) ----
  // 「聞かれた時だけ取得」から「毎日更新」へ。16項目それぞれについて、
  // 取得できた値、または取得できなかった理由を必ず記録する
  // (詳細は server/learning/playerDailyUpdate.js のコメント参照)。
  let playerResult = {
    playersCheckedToday: 0, playersUpdatedToday: 0, playerFactsSavedToday: 0,
    playerFactsDuplicateToday: 0, playerFactsToday: [], fieldsUpdatedToday: 0,
    fieldsPermanentlyUnavailable: 0, fieldsRetryableToday: 0,
    unavailableReasonsToday: [], errors: [],
  };
  try {
    playerResult = await collectPlayerKnowledge({
      callApiFootball, knowledgeStore, upstashEnabled, upstashGetJSON, upstashSetJSON,
      apiBudget,
      playerUpdateCap: Number(process.env.PLAYER_UPDATE_CAP) || PLAYER_UPDATE_CAP_DEFAULT,
      searchLeagues: (process.env.SEARCH_LEAGUES || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean),
    }, runAt, dateKey);
    if (playerResult.errors && playerResult.errors.length) errors.push(...playerResult.errors);
  } catch (e) {
    errors.push(`player_daily_update_failed:${e.message}`);
  }

  // ---- ② 保留中の自社予測を解決(試合が終わっていれば的中/不的中を確定) ----
  // 2026年8月・ご指示⑨: 解決した予測はその場で全市場(勝敗/BTTS/Over-Under/
  // スコア)の採点を行い、日次の精度記録(learn:accuracy:<date>)に積む。
  const resolvedScoredToday = [];
  const pendingIds = (await upstashCmd(["LRANGE", "learn:ownpred:pending", "0", String(OWN_PREDICT_RESOLVE_CAP - 1)]).catch(() => [])) || [];
  for (const fixtureIdStr of pendingIds) {
    try {
      const record = await upstashGetJSON(`learn:ownpred:${fixtureIdStr}`);
      if (!record || record.resolved) { await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {}); continue; }
      // ---- 第8次監査(High)の修正: 解決処理の多重実行ロック ----
      // 再デプロイ時の新旧プロセス並走や実行ロック(10分)失効後の再突入で、
      // 同じ試合を2つのプロセスが同時に解決すると、resolved/correctカウンタの
      // 二重INCR・learn:ownpred:recentへの二重RPUSH(=学習データ汚染)・
      // 精度記録(learn:accuracy)の加算マージ倍加が起きていた。
      // server.js の pred:resolvelock(第7次監査)と同じ SET NX 方式で防ぐ。
      // Upstash障害時は可用性を優先して通す(既存の実行ロックと同じ方針)。
      const resolveLock = await upstashCmd(["SET", `learn:ownpred:resolvelock:${fixtureIdStr}`, runAt.toISOString(), "NX", "EX", "3600"]).catch(() => "OK");
      if (resolveLock !== "OK") continue; // 別プロセスが処理中
      const data = await callApiFootball("/fixtures", { id: fixtureIdStr });
      const fx = (data && data.response && data.response[0]) || null;
      // 2026年8月・総点検で発見した重大な欠陥の修正:
      // 従来は「FT(終了)以外は continue」だったため、延期(PST)・中止(CANC)・
      // 放棄(ABD)になった試合のIDが保留キューから**永久に削除されなかった**。
      // このキューは先頭10件しか見ないため、そうしたIDが10件たまると
      // 以降どの予測も検証されなくなり(matchesResolvedTodayが永久に0)、
      // 毎日10回ぶんのAPIリクエストを無駄に消費し続ける状態だった。
      const shortStatus = fx && fx.fixture && fx.fixture.status ? fx.fixture.status.short : null;
      const UNRESOLVABLE_STATUSES = ["PST", "CANC", "ABD", "AWD", "WO"]; // 延期・中止・放棄・裁定勝ち・不戦勝
      if (UNRESOLVABLE_STATUSES.includes(shortStatus)) {
        // この試合は結果が出ないので、検証対象から外して先頭詰まりを解消する
        await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {});
        errors.push(`prediction_unresolvable:${fixtureIdStr}:${shortStatus}`);
        continue;
      }
      // 第5次監査で発見した「もう一つの先頭詰まり」の修正:
      //   上のステータス判定は fx が取れている場合しか働かない。
      //   /fixtures?id=… が**空の応答を返す**(試合IDが振り直された・
      //   シーズン移行で消えた等)場合、fx は null のまま下の continue に落ち、
      //   そのIDは保留キューから永久に消えなかった。これが10件たまると
      //   検証が完全に止まり、通算検証数が10件に届かないため
      //   **重みの学習が二度と実行されない**(=もう賢くならない)。
      //   しかも毎日10件のAPIリクエストを無駄に使い続ける。
      //   何度確認しても存在しない試合は、確認回数を記録したうえで打ち切る。
      if (!fx || !fx.fixture) {
        const attempts = (Number(record.resolveAttempts) || 0) + 1;
        record.resolveAttempts = attempts;
        await upstashSetJSON(`learn:ownpred:${fixtureIdStr}`, record);
        if (attempts >= 3) {
          await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {});
          errors.push(`prediction_fixture_missing:${fixtureIdStr}:${attempts}回確認しても試合が見つからないため検証を打ち切りました`);
        } else {
          errors.push(`prediction_fixture_not_found:${fixtureIdStr}:${attempts}`);
        }
        continue;
      }
      // ---- 第8次監査(High)の修正: 延長(AET)・PK決着(PEN)の試合が永久に未解決だった ----
      // 従来は「FT以外はcontinue」だったため、カップ戦などで延長・PKまで行った
      // 試合はUNRESOLVABLE(中止等)にも該当せず、保留キューに永遠に残った。
      // キューは先頭10件しか処理しないため、PK決着が10件たまると**全予測の検証が
      // 恒久停止し、重み学習への新データ供給が止まる**(過去にPST/CANCで修正したのと
      // 同じバグクラスの残存。server.jsのFINISHED_STATUSES=FT/AET/PENと基準を揃える)。
      const FINISHED_SHORT_STATUSES = ["FT", "AET", "PEN"];
      if (!FINISHED_SHORT_STATUSES.includes(shortStatus)) continue; // まだ終わっていない
      // AET/PENは「90分時点のスコア」(score.fulltime)で採点する。勝敗予測は90分の
      // 結果を対象としており、延長・PKの決着を90分の勝敗として学習するとラベルが
      // 濁るため。fulltimeが取れない応答形式では正直にgoals(延長込み)を使う。
      const scoreForGrading = (shortStatus !== "FT"
        && fx.score && fx.score.fulltime
        && Number.isFinite(fx.score.fulltime.home) && Number.isFinite(fx.score.fulltime.away))
        ? fx.score.fulltime : fx.goals;
      const actualWinner = outcomeFromScore(scoreForGrading.home, scoreForGrading.away);
      if (!actualWinner) continue;
      record.resolved = true;
      record.actualWinner = actualWinner;
      record.correct = actualWinner === record.predictedWinner;
      record.resolvedAt = runAt.toISOString();
      if (shortStatus !== "FT") record.finishedStatus = shortStatus; // 延長/PK決着だったことを正直に残す
      // 2026年8月・ご指示⑨: 実スコアを保存する(BTTS・Over/Under・スコア一致の
      // 採点に必要。従来は勝敗しか残しておらず、市場別の精度が測れなかった)。
      record.actualScore = { home: scoreForGrading.home, away: scoreForGrading.away };
      // 全市場の採点(Brier・LogLoss・的中)。予測時のポアソンλから機械的に導出。
      try {
        record.marketScores = scorePrediction(record);
        if (record.marketScores) resolvedScoredToday.push(record.marketScores);
      } catch (e) { errors.push(`accuracy_scoring_failed:${fixtureIdStr}:${e.message}`); }

      // ---- Failure Learning(ご要望①): 外れた場合は「何故外れたのか」を分類して保存する ----
      // 従来は正解/不正解のカウントだけで、原因は一切記録していなかった。
      // 予測時点の特徴量(record.features)と重み(record.weightsSnapshot)だけを
      // 根拠に機械的に分類する(LLM不使用・でっち上げ防止)。
      const failureReasons = record.correct ? [] : classifyFailureReasons(record, record.weightsSnapshot);
      record.failureReasons = failureReasons;
      // 2026年8月・完全自動Learning Cycle ⑧: 当たった時も「なぜ当たったのか」を
      // 分析する(従来は外れた時しか言語化していなかった)。失敗分析と完全に
      // 対称な条件でのみ判定し、決め手が無ければ正直にそう返す。
      const successReasons = record.correct ? classifySuccessReasons(record, record.weightsSnapshot) : [];
      record.successReasons = successReasons;

      // ---- 2026年8月・優先順位③: モデルの外側にある原因を特定する ----
      // 監督交代・フォーメーション変更・スタメンの大幅入れ替えは、予測モデルの
      // 特徴量に入っていないため classifyFailureReasons では永久に
      // 「数値化していない要因」としか言えなかった。外れた試合に限って
      // /fixtures/lineups を1回だけ取得し、予測時点の文脈と突き合わせる
      // (当たった試合では取得しない=API予算の節約)。
      let contextualFailureReasons = [];
      if (!record.correct) {
        let resolvedContext = null;
        // 予算はcallApiFootball内で確保されるため、ここでは消費せず残量だけ確認する(二重計上の防止)
        const canSpendLineup = apiBudget ? apiBudget.canAfford(1) : true;
        if (canSpendLineup) {
          try {
            const lu = await callApiFootball("/fixtures/lineups", { fixture: fixtureIdStr });
            const rows = (lu && lu.response) || [];
            const homeRow = rows[0] || null;
            const awayRow = rows[1] || null;
            const names = (row) => (row && Array.isArray(row.startXI))
              ? row.startXI.map((p) => (p && p.player && p.player.name) || null).filter(Boolean)
              : null;
            resolvedContext = {
              homeCoachName: (homeRow && homeRow.coach && homeRow.coach.name) || null,
              awayCoachName: (awayRow && awayRow.coach && awayRow.coach.name) || null,
              homeFormation: (homeRow && homeRow.formation) || null,
              awayFormation: (awayRow && awayRow.formation) || null,
              homeLineupNames: names(homeRow),
              awayLineupNames: names(awayRow),
            };
          } catch (e) {
            errors.push(`lineup_fetch_failed:${fixtureIdStr}:${e.code || e.message}`);
          }
        } else {
          // 第8次監査(Low)の修正: 予算不足でラインナップ照合を見送った事実が
          // どこにも残らず、「監督交代を検出できなかった」のか「交代が無かった」のか
          // 区別できなかった。「黙って減らさない」方針(universeCollectorと同じ)に揃える。
          errors.push(`lineup_check_skipped_budget:${fixtureIdStr}:予算残量が少ないため、外れ原因の文脈照合(監督交代・スタメン入替)を見送りました`);
        }
        contextualFailureReasons = classifyContextualFailureReasons(record, resolvedContext);
        record.contextualFailureReasons = contextualFailureReasons;
        record.resolvedContext = resolvedContext;
      }
      await upstashSetJSON(`learn:ownpred:${fixtureIdStr}`, record);
      // 第8次監査(High)の修正: 解決済みの個別レコードは学習用の写し(learn:ownpred:recent)
      // に引き継がれるため、本体は180日で自動失効させる(Redisキーの無限成長を止める。
      // 未解決レコードは解決に必要なのでTTLを付けない)。
      await upstashCmd(["EXPIRE", `learn:ownpred:${fixtureIdStr}`, String(180 * 86400)]).catch(() => {});
      await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {});
      await upstashCmd(["INCR", "learn:ownpred:resolved"]).catch(() => {});
      if (record.correct) await upstashCmd(["INCR", "learn:ownpred:correct"]).catch(() => {});
      await upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(record)]).catch(() => {});
      await upstashCmd(["LTRIM", "learn:ownpred:recent", String(-OWN_PRED_RECENT_KEEP), "-1"]).catch(() => {});
      matchesResolvedToday++;

      // ---- 精度証明ラウンド⑤: ROI採点(オッズが記録されている試合のみ) ----
      // 「AIの予想勝敗に毎回1単位を賭けたら」という仮想収支で市場と比較する。
      // オッズの無い試合は正直に集計外として件数だけ数える(でっち上げない)。
      const roiScore = scoreRoiForRecord(record);
      if (roiScore) {
        roiAggToday.bets++;
        roiAggToday.staked++;
        roiAggToday.profitSum = Math.round((roiAggToday.profitSum + roiScore.profit) * 10000) / 10000;
        if (roiScore.win) roiAggToday.wins++;
        if (Number.isFinite(record.marketEdgePt)) { roiAggToday.edgeSumPt = Math.round((roiAggToday.edgeSumPt + record.marketEdgePt) * 10) / 10; roiAggToday.edgeN++; }
      } else {
        roiAggToday.oddsMissing++;
      }

      // ---- Hypothesis Engine: 予測を立てた時点の「状態仮説」を実際の結果で検証する ----
      // ご要望の「AI自身が毎日仮説を立てる→次の試合で検証→当たれば知識として採用、
      // 外れたら破棄」をこの自社予測モデルの枠組みで実装したもの。
      if (record.stateHypothesis && record.originTeamEn) {
        if (record.correct) {
          try {
            await knowledgeStore.saveKnowledgeItem({
              teamEn: record.originTeamEn, category: "predictionHypothesis", type: "analysis",
              statement: `${record.stateHypothesis} → 実際の試合結果と一致し、この仮説は正しいことが確認されました。`,
              computedAt: runAt.toISOString(),
            });
            hypothesesConfirmed++;
          } catch (e) { errors.push(`hypothesis_promote_failed:${fixtureIdStr}:${e.message}`); }
        } else {
          // Layer4導入以前は、外れた仮説は「破棄してカウントするだけ」で、なぜ
          // 外れたかは一切記録していなかった(ご指摘の通りの実際のギャップ)。
          hypothesesDiscarded++;
        }
      }

      // ---- Knowledge Engine Layer4(振り返り): 当たった/外れた両方を記録する ----
      // 「予想→結果→何故当たったか/何故外れたか→改善点」を、当たり外れ問わず
      // 必ず保存する(以前はハズレた仮説を保存していなかった=正直な弱点だった)。
      // LLMを使わず、実際に計算した特徴量・重みから機械的に導く(でっち上げ防止)。
      try {
        const reflection = buildReflectionText(record, record.weightsSnapshot, failureReasons);
        const outcomeLabelJa = (w) => (w === "home" ? "ホーム勝利" : w === "away" ? "アウェイ勝利" : "引き分け");

        // ---- 優先順位⑫: 「大きく外した予測ほど学びが大きい」を数値で判定する ----
        // 予測時に、勝つと思っていた側へ何%の確率を与えていたか。
        // 自信を持っていたほど、外れたときの学びが大きい。
        const confidenceOnPick = (() => {
          const p = record.winProbability || record.probabilities || null;
          if (!p) return null;
          if (record.predictedWinner === "home" && Number.isFinite(p.homeWinPct)) return p.homeWinPct / 100;
          if (record.predictedWinner === "away" && Number.isFinite(p.awayWinPct)) return p.awayWinPct / 100;
          if (record.predictedWinner === "draw" && Number.isFinite(p.drawPct)) return p.drawPct / 100;
          return null;
        })();
        const missMargin = (!record.correct && Number.isFinite(confidenceOnPick)) ? confidenceOnPick : null;

        // ---- 優先順位⑳: 「予測 → 結果 → 答え合わせ → 学んだこと」を時系列へ ----
        // これまでは知識として1件保存するだけで、因果の並びは残っていなかった。
        if (thoughtTimeline && record.originTeamEn) {
          // 監査で発見した欠陥の修正:
          //   予測・結果・学びを「見立て」と同じキーへ書いていたため、
          //   1試合につき3件ずつ積まれ、上限60件で**過去の見立てが押し出されて
          //   消えていた**(約20試合で全滅)。そうなると「以前と比べて考えが
          //   変わった理由」が永久に説明できなくなる。試合の答え合わせは別の線にする。
          const tlKey = `team:${record.originTeamEn}:matches`;
          await thoughtTimeline.recordOutcome(tlKey, {
            predictionJa: `${record.homeTeamEn} vs ${record.awayTeamEn} は${outcomeLabelJa(record.predictedWinner)}と予測しました。`,
            resultJa: `実際は${outcomeLabelJa(record.actualWinner)}でした(${record.correct ? "的中" : "不的中"})。`,
            correct: record.correct,
            lessonJa: reflection.improvement,
            evidence: [reflection.why].filter(Boolean),
            at: runAt.toISOString(),
          }).catch(() => {});
        }
        const statement = [
          `【振り返り】${record.homeTeamEn} vs ${record.awayTeamEn}`,
          `予想: ${outcomeLabelJa(record.predictedWinner)} / 結果: ${outcomeLabelJa(record.actualWinner)}(${record.correct ? "的中" : "不的中"})`,
          `理由: ${reflection.why}`,
          `改善点: ${reflection.improvement}`,
        ].join(" ");
        await saveWithImportance({
          teamEn: record.originTeamEn || record.homeTeamEn, category: "matchReflection", type: "reflection",
          statement, detail: { predicted: record.predictedWinner, actual: record.actualWinner, correct: record.correct, failureReasons, ...reflection },
          computedAt: runAt.toISOString(), source: "試合結果と予測時点の特徴量・重みから機械的に生成(LLM不使用)",
        }, { predictionMissMargin: missMargin });
        // 優先順位⑲: 「クラブ→試合→分析」の連鎖を知識グラフへ張る
        if (knowledgeGraph && record.originTeamEn) {
          const matchId = `${record.homeTeamEn} vs ${record.awayTeamEn}#${fixtureIdStr}`;
          await knowledgeGraph.addEdge({
            fromType: "team", fromId: record.originTeamEn, relation: "playedMatch",
            toType: "match", toId: matchId, toLabelJa: `${record.homeTeamEn} vs ${record.awayTeamEn}`,
            sinceAt: runAt.toISOString(),
            meta: { predicted: record.predictedWinner, actual: record.actualWinner, correct: record.correct },
          }).catch(() => {});
          await knowledgeGraph.addEdge({
            fromType: "match", fromId: matchId, relation: "learnedFrom",
            toType: "lesson", toId: `${fixtureIdStr}:${record.correct ? "hit" : "miss"}`,
            toLabelJa: reflection.improvement ? String(reflection.improvement).slice(0, 60) : (record.correct ? "的中" : "不的中"),
            sinceAt: runAt.toISOString(),
          }).catch(() => {});
        }
        reflectionsSaved++;

        // ---- Failure Learning(ご要望①続き): 外れた理由を単独のKnowledge Engine
        // 項目(analysis)としても保存する。これにより議論モードの根拠プール
        // (evidencePool.js→ke.analyses)からも参照でき、「次回の予測へ反映」の
        // 一部として、同じクラブについて話す際にAIが過去の予測ミスの傾向を
        // 踏まえられるようになる(数値としては、この失敗パターンはfeatures/weights
        // 経由で勾配降下法による重み再学習にも既に反映されている。§④のv2重み更新参照)。
        if (record.correct && successReasons.length) {
          successReasonsToday.push(...successReasons.map((r) => ({ ...r, teamEn: record.originTeamEn || record.homeTeamEn })));
          try {
            await knowledgeStore.saveKnowledgeItem({
              teamEn: record.originTeamEn || record.homeTeamEn, category: "predictionSuccessReason", type: "analysis",
              statement: `【予測が当たった理由】${record.homeTeamEn} vs ${record.awayTeamEn}: ${successReasons.map((r) => r.labelJa).join("、")}。${successReasons[0].detail}`,
              detail: { fixtureId: fixtureIdStr, successReasons },
              computedAt: runAt.toISOString(), source: "予測時点の特徴量・重みから機械的に分類(LLM不使用)",
            });
          } catch (e) { errors.push(`success_reason_save_failed:${fixtureIdStr}:${e.message}`); }
        }
        if (!record.correct && contextualFailureReasons.length) {
          failureReasonsToday.push(...contextualFailureReasons.map((r) => ({ ...r, teamEn: record.originTeamEn || record.homeTeamEn })));
          try {
            await knowledgeStore.saveKnowledgeItem({
              teamEn: record.originTeamEn || record.homeTeamEn, category: "predictionContextualFailure", type: "analysis",
              statement: `【予測が外れた理由(モデル外の要因)】${record.homeTeamEn} vs ${record.awayTeamEn}: ${contextualFailureReasons.map((r) => r.labelJa).join("、")}。${contextualFailureReasons[0].detail}`,
              detail: { fixtureId: fixtureIdStr, contextualFailureReasons },
              computedAt: runAt.toISOString(),
              source: "予測時点に記録した文脈と、試合後に判明した事実(/fixtures/lineups)の突き合わせ",
            });
          } catch (e) { errors.push(`contextual_failure_save_failed:${fixtureIdStr}:${e.message}`); }
        }
        if (!record.correct && failureReasons.length) {
          failureReasonsToday.push(...failureReasons.map((r) => ({ ...r, teamEn: record.originTeamEn || record.homeTeamEn })));
          try {
            await knowledgeStore.saveKnowledgeItem({
              teamEn: record.originTeamEn || record.homeTeamEn, category: "predictionFailureReason", type: "analysis",
              statement: `【予測が外れた理由】${record.homeTeamEn} vs ${record.awayTeamEn}: ${failureReasons.map((r) => r.labelJa).join("、")}。${failureReasons[0].detail}`,
              detail: { fixtureId: fixtureIdStr, failureReasons },
              computedAt: runAt.toISOString(), source: "予測時点の特徴量・重みから機械的に分類(LLM不使用)",
            });
          } catch (e) { errors.push(`failure_reason_save_failed:${fixtureIdStr}:${e.message}`); }
        }

        // ---- Memory Engine(ご要望④続き): 「試合予測」自体を、前回の予測・結果・
        // 外れた理由・学んだこと・次回改善点まで含めて記憶する。
        // memoryStore.saveConclusion()は「前回の内容と異なれば、前回の内容を
        // memory:history:*へ退避してから今回の内容で上書きする」という既存の
        // 変化検知の仕組みをそのまま持っているため、対戦カードが変わるたびに
        // 自動的に「前回の予測」が履歴として保存されていく(新しい仕組みを
        // 増やさず、既存のMemory Engineの仕組みを再利用しただけ)。
        try {
          const predictionMemoryStatement = [
            `${record.homeTeamEn} vs ${record.awayTeamEn}: 予測は${outcomeLabelJa(record.predictedWinner)}`,
            `結果は${outcomeLabelJa(record.actualWinner)}(${record.correct ? "的中" : "不的中"})`,
            failureReasons.length ? `外れた理由: ${failureReasons.map((r) => r.labelJa).join("、")}` : null,
            `学んだこと: ${reflection.why}`,
            `次回改善点: ${reflection.improvement}`,
          ].filter(Boolean).join(" / ");
          await memoryStore.saveConclusion(
            `team:${record.originTeamEn || record.homeTeamEn}:predictionMemory`,
            {
              statement: predictionMemoryStatement, confidence: record.correct ? 1 : 0,
              reasoning: "毎日学習エンジンによる自動記録(試合結果と予測時点の特徴量・重みから機械的に生成)",
              computedAt: runAt.toISOString(),
            },
            null
          );
        } catch (e) { errors.push(`prediction_memory_failed:${fixtureIdStr}:${e.message}`); }
      } catch (e) { errors.push(`reflection_failed:${fixtureIdStr}:${e.message}`); }
    } catch (e) {
      errors.push(`resolve_failed:${fixtureIdStr}:${e.message}`);
    }
  }

  // ---- ②-b 今日答え合わせした予測の精度を市場別に記録する(ご指示⑨) ----
  // 的中率だけでなくBrier Score・Log Loss・較正の材料を日次で保存し、
  // 昨日・先週・先月との比較を可能にする。答え合わせが0件の日は保存しない
  // (存在しない測定値を作らない)。
  if (resolvedScoredToday.length) {
    try {
      const aggToday = buildDailyAccuracy(resolvedScoredToday);
      await saveDailyAccuracy({ upstashEnabled, upstashGetJSON, upstashSetJSON }, dateKey, aggToday);
    } catch (e) { errors.push(`accuracy_save_failed:${e.message}`); }
  }

  // 2026年8月・「本当に毎日賢くなるAI」フェーズで追加した記録用の変数。
  let weightsMetaUsedToday = null; // 今日の予測が実際に使った重みのversion/更新時刻(ご指示①③④の証明)
  let featureEffectivenessToday = null; // ご指示⑧: 特徴量ごとの有効性の実測
  let predictionShiftToday = null; // ご指示①: 学習で予測がどう変わったか
  let agendaAppliedToday = null; // ご指示⑩: 前回の学習計画を今日の収集に反映した内容
  // 自己改善ループ③: AIが自分で調整した設定(安全な上下限つき)を読み、
  // 今日の収集(xG周期・選手詳細上限・優先クラブ数)へ実際に反映する。
  const selfTuneConfig = await loadTuneConfig({ upstashEnabled, upstashGetJSON });

  // 精度証明ラウンド: 直近の解決済み予測(似た試合の検索と重み学習で共有し、
  // 同一実行内で learn:ownpred:recent を二度読みしない。第8次監査の方針を維持)
  let recentRecordsShared = null;
  async function loadRecentRecordsOnce() {
    if (recentRecordsShared) return recentRecordsShared;
    const raw = (await upstashCmd(["LRANGE", "learn:ownpred:recent", "0", "-1"]).catch(() => [])) || [];
    recentRecordsShared = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    return recentRecordsShared;
  }

  // ---- ③ TOP100クラブの直近の試合について、新しく自社予測を立てる ----
  // 2026年8月の調査で修正: 旧実装はここを REGISTERED_TEAMS(11クラブ)で回して
  // いたため、知識収集は毎日100クラブ回っているのに **予測はTOP100のうち9クラブ
  // にしか立たない**(残り91クラブは構造上、永久に予測対象外)状態だった。
  // TOP100 + 利用者が登録した TOP100外クラブ を、日付で安定的に回転させる。
  const predictionPool = clubsForPrediction(dateKey, REGISTERED_TEAMS, OWN_PREDICT_LOG_CAP);
  const predictionClubsSeen = [];
  let predictionPoolScanned = 0;
  let predictionStoppedReason = null;
  for (const team of predictionPool) {
    if (newPredictionsLogged >= OWN_PREDICT_LOG_CAP) { predictionStoppedReason = "cap"; break; }
    // 予算が尽きかけている日は、ここで打ち切って利用者向けの余力を守る
    if (apiBudget && !apiBudget.canAfford(OWN_PREDICT_MIN_BUDGET)) { predictionStoppedReason = "budget"; break; }
    predictionPoolScanned++;
    try {
      const cached = teamFormCache.get(team.nameEn);
      const teamId = cached ? cached.teamId : await resolveTeamId(team.nameEn);
      if (!teamId) continue;
      const upcoming = await callApiFootball("/fixtures", { team: teamId, next: 1 });
      const fx = upcoming && upcoming.response && upcoming.response[0];
      if (!fx || !fx.fixture) continue;
      const fixtureId = fx.fixture.id;
      const already = await upstashGetJSON(`learn:ownpred:${fixtureId}`);
      if (already) continue; // 冪等性: 既に記録済みなら重複させない

      const isHome = fx.teams.home.id === teamId;
      const opponentName = isHome ? fx.teams.away.name : fx.teams.home.name;
      const opponentId = isHome ? fx.teams.away.id : fx.teams.home.id;
      // ---- 2026年8月・第三者監査が発見した重大な欠陥の修正 ----
      //   teamFormCache は上流のループ①(REGISTERED_TEAMS=11クラブ)でしか
      //   埋められない。予測対象をTOP100へ広げた際、それ以外のクラブでは
      //   subjectForm が undefined のまま `.teamId` を参照して TypeError となり、
      //   loop の catch に飲まれていた。つまり
      //   **「TOP100に広げた」はずが、実際には11クラブのままだった**
      //   (しかも失敗するたびに /fixtures を2回ぶん無駄に消費していた)。
      //   相手チームと同じ方法で、対象クラブのフォームもその場で計算する。
      const formOf = async (name, id) => {
        // 検証での指摘: teamFormCache には「このアプリの英語名」と
        // 「API-Football側の表記」の2系統が入るため、表示名がたまたま同じで
        // 中身が別クラブ、という取り違えが起こり得る。IDまで一致した時だけ使う。
        const hit = teamFormCache.get(name);
        if (hit && hit.teamId === id) return hit;
        const data = await callApiFootball("/fixtures", { team: id, last: 10 });
        const list = (data && data.response) || [];
        const form = computeFormScore(list, id);
        const goalRates = computeGoalRateFeatures(list, id);
        const fatigue = computeFatigueFeature(list, runAt.getTime());
        const built = { teamId: id, ...form, ...goalRates, ...fatigue, fixtures: list };
        teamFormCache.set(name, built); // 同じ実行内で同じクラブを二度取りに行かない
        return built;
      };
      const subjectForm = cached || await formOf(team.nameEn, teamId);
      const opponentForm = await formOf(opponentName, opponentId);
      if (!subjectForm || !opponentForm) {
        errors.push(`predict_skipped_no_form:${team.nameEn}`);
        continue;
      }
      const homeForm = isHome ? subjectForm : opponentForm;
      const awayForm = isHome ? opponentForm : subjectForm;
      // 第6次監査の修正: `|| 0` だと、実際に得失点差が0だった場合と
      // データが取れなかった場合を区別できず、後者を「0」として記録に残していた。
      // 記録には正直にnullを入れる(v1バックテストは typeof === "number" で
      // 絞り込むため、nullの記録は自動的に対象外になる)。
      const homeFormScore = (homeForm && Number.isFinite(homeForm.currentFormScore)) ? homeForm.currentFormScore : null;
      const awayFormScore = (awayForm && Number.isFinite(awayForm.currentFormScore)) ? awayForm.currentFormScore : null;

      // ---- Prediction Engine v2: 追加特徴量(怪我人・順位・過去対戦)を取得する ----
      // このループはOWN_PREDICT_LOG_CAP(既定20)件/回に絞られているため、ここで
      // 追加のAPI呼び出しが発生してもAPI-Footballの利用上限への影響は限定的。
      const homeTeamId = homeForm.teamId;
      const awayTeamId = awayForm.teamId;
      const homeFixturesForLeague = homeForm.fixtures || [];
      const leagueId = inferLeagueIdFromFixtures(homeFixturesForLeague) || inferLeagueIdFromFixtures(awayForm.fixtures || []);
      const season = new Date(runAt).getUTCMonth() + 1 >= 7 ? runAt.getUTCFullYear() : runAt.getUTCFullYear() - 1;
      const [homeInjuries, awayInjuries, homeStandings, awayStandings, h2h] = await Promise.all([
        fetchInjuryCountFeature(homeTeamId, season, callApiFootball),
        fetchInjuryCountFeature(awayTeamId, season, callApiFootball),
        // 第4次監査で発見した欠陥の修正: 両チームの順位を同じリーグIDで引いていたため、
        // アウェイチームがそのリーグの順位表に載っていない場合(別リーグ・カップ戦の
        // 相手など)に points/played が0扱いになり、standingsDiff が
        // 「ホームの勝点/試合 − 0」という誤った大きな差になっていた。
        // オンデマンド分析側(server.js)は既にチームごとにリーグIDを推定しているので、
        // 日次ジョブ側も同じ扱いに揃える。
        fetchStandingsFeature(leagueId, season, homeTeamId, callApiFootball),
        fetchStandingsFeature(inferLeagueIdFromFixtures(awayForm.fixtures || []) || leagueId, season, awayTeamId, callApiFootball),
        fetchHeadToHeadFeature(homeTeamId, awayTeamId, callApiFootball),
      ]);
      // ---- 2026年8月・優先順位②: Proプラン移行に伴う特徴量の拡張 ----
      // 追加のAPI呼び出しを一切増やさずに使える情報を、まず確実に取り込む。
      //   ・ホーム/アウェイ別の成績 … 既に取得済みのfixtures(直近10試合)から算出
      //   ・出場停止者数           … 既に取得済みの/injuriesのレスポンスから算出
      //     (computeInjuryCountFeatureは以前からsuspendedPlayersを分離していたが、
      //      予測モデルには渡されておらず、負傷者と一緒くたにされていた)
      // 2026年8月・優先順位③: 監督名は①-dで既にMemory Engineへ保存済みなので、
      // それを読み出すだけ(追加のAPI呼び出しは発生しない)。試合後にもう一度
      // 照合することで「監督交代を考慮できなかった」を検出できるようにする。
      const readCoachName = async (teamEn) => {
        if (!teamEn) return null;
        try {
          const c = await memoryStore.getLastConclusion(`team:${teamEn}:coachName`);
          return (c && c.statement) || null;
        } catch (e) { return null; }
      };
      const homeCoachNameAtPrediction = await readCoachName(isHome ? team.nameEn : opponentName);
      const opponentCoachNameAtPrediction = await readCoachName(isHome ? opponentName : team.nameEn);

      // ---- 2026年8月・ご指示③: 共通Feature Engineで特徴量を組み立てる ----
      // オンデマンド分析(server.js)と同じ関数を通すことで、
      // 「片方だけ新特徴量が0」というズレが構造的に起きないようにする。
      const XG_SAMPLE_FIXTURES = Number(process.env.XG_SAMPLE_FIXTURES) || 5;
      const canSpendXg = () => (apiBudget ? apiBudget.canAfford(1) : true);
      const [homeXg, awayXg, homeTop, awayTop] = await Promise.all([
        fetchTeamXgAverage(homeForm.fixtures || [], homeTeamId, callApiFootball, { limit: XG_SAMPLE_FIXTURES, canSpend: canSpendXg }).catch(() => ({ xgNet: null })),
        fetchTeamXgAverage(awayForm.fixtures || [], awayTeamId, callApiFootball, { limit: XG_SAMPLE_FIXTURES, canSpend: canSpendXg }).catch(() => ({ xgNet: null })),
        (async () => {
          const key = `${leagueId}:${homeTeamId}`;
          if (teamTopScorerCache.has(key)) return teamTopScorerCache.get(key);
          const r = await fetchTeamTopScorer(leagueId, season, homeTeamId, callApiFootball).catch(() => ({ player: null }));
          teamTopScorerCache.set(key, r); return r;
        })(),
        (async () => {
          const key = `${leagueId}:${awayTeamId}`;
          if (teamTopScorerCache.has(key)) return teamTopScorerCache.get(key);
          const r = await fetchTeamTopScorer(leagueId, season, awayTeamId, callApiFootball).catch(() => ({ player: null }));
          teamTopScorerCache.set(key, r); return r;
        })(),
      ]);
      const built = buildMatchFeatures(
        { teamId: homeTeamId, form: homeForm, injuries: homeInjuries, standings: homeStandings, xg: homeXg, topScorer: homeTop },
        { teamId: awayTeamId, form: awayForm, injuries: awayInjuries, standings: awayStandings, xg: awayXg, topScorer: awayTop },
        h2h
      );
      const homeCtx = built.homeCtx;
      const awayCtx = built.awayCtx;
      const features = built.features;

      // ---- 第8次監査の修正: 重みの読み取り失敗を「学習前の初期重み」と区別する ----
      // upstashGetJSONは失敗を握りつぶしてnullを返すため、Upstash一時障害の日に
      // 初期重み(未学習状態)で予測が記録され、learningProofの「必ず反映されます」
      // という説明と食い違っていた。読み取れない日は正直に予測を見送る
      // (/api/match-analysis側の第5次修正と同じ方針)。
      let storedWeightsRaw = null;
      try {
        const rawStr = await upstashCmd(["GET", "learn:weights"]); // 失敗時はthrowする生コマンドで読む
        storedWeightsRaw = rawStr ? JSON.parse(rawStr) : {}; // null=キー未作成(初回)は正当な初期状態
      } catch (e) {
        errors.push(`weights_read_failed_prediction_skipped:${team.nameEn}:保存済みの重みを読み出せなかったため、学習前の重みでの予測記録を避けて今回は見送りました`);
        continue;
      }
      const weights = { ...EXTENDED_DEFAULT_WEIGHTS, ...storedWeightsRaw }; // 過去バージョンの重みにも新しいキーを補完
      // 2026年8月・ご指示①③④の証明: 「昨日の学習が今日の予測に反映された」を
      // ログで示せるよう、今日の予測が実際に使った重みのversion/更新時刻を記録する。
      // 重みは予測のたびにストレージから読み直すため、昨日更新された重みは
      // 今日の最初の予測から必ず使われる(古い重みを使い続ける経路は存在しない)。
      weightsMetaUsedToday = { version: weights.version ?? 0, updatedAt: weights.updatedAt || null };
      const { predictedWinner, homeLambda, awayLambda } = predictOutcomeV2(features, weights);
      const importance = computeFactorImportance(features, weights);
      const topFactor = importance.find((i) => i.stars > 0);

      // Hypothesis Engine: 「なぜこの予測なのか」を、実際に計算した特徴量の
      // 差から言語化しておく(予測ロジックそのものから導けるので、でっち上げではない)。
      // 試合終了後、この仮説が実際に当たっていたかどうかを検証する(上の②参照)。
      const favoredSide = predictedWinner === "home" ? (isHome ? team.nameJa : `${team.nameJa}の対戦相手`)
        : predictedWinner === "away" ? (isHome ? `${team.nameJa}の対戦相手` : team.nameJa)
        : null;
      const stateHypothesis = favoredSide
        ? `${team.nameJa}(直近フォームスコア${(cached && cached.currentFormScore) ?? "不明"})と対戦相手の差(最も影響した要素: ${topFactor ? topFactor.labelJa : "フォーム"})から、${favoredSide}が優位という仮説`
        : `${team.nameJa}と対戦相手は拮抗しており、互角(引き分けに近い)という仮説`;

      // ---- 精度証明ラウンド⑤: オッズの記録(市場比較・ROIの材料) ----
      // 取得できなければ正直にnull(架空のオッズは作らない。ROI集計から除外される)。
      let matchOdds = null, marketImplied = null, marketEdgePt = null;
      try {
        const oddsData = await callApiFootball("/odds", { fixture: fixtureId });
        matchOdds = extractMatchWinnerOdds(oddsData);
        if (matchOdds) {
          marketImplied = impliedProbsPct(matchOdds);
          const probsForEdge = computeMarketProbs(homeLambda, awayLambda);
          if (probsForEdge && marketImplied) {
            const ourPct = predictedWinner === "home" ? probsForEdge.homeWin * 100 : predictedWinner === "away" ? probsForEdge.awayWin * 100 : probsForEdge.draw * 100;
            const mktPct = predictedWinner === "home" ? marketImplied.homePct : predictedWinner === "away" ? marketImplied.awayPct : marketImplied.drawPct;
            marketEdgePt = Math.round((ourPct - mktPct) * 10) / 10;
          }
        }
      } catch (e) {
        // 2026年8月・第三者監査の指摘: ここだけ例外を完全に捨てていたため、
        //   「この試合にオッズが無い」と「APIが失敗している/プランに含まれない」が
        //   区別できず、ROIの説明が永久に
        //   「オッズつきで答え合わせできた予測がまだありません」のままになる。
        //   他のステージと同じく理由を残す(件数は capList で抑制される)。
        errors.push(`odds_failed:${fixtureId}:${e.code || e.message}`);
      }

      // ---- 精度証明ラウンド①: 「似た試合」の検索(答え合わせ済みの実結果から) ----
      // 特徴量の距離で似た過去試合を探し、予測記録に添える(でっち上げ無しの実測)。
      let similarPast = [];
      try {
        const recentForSimilarity = await loadRecentRecordsOnce();
        similarPast = findSimilarResolvedMatches(features, recentForSimilarity, 3);
      } catch (e) { /* 似た試合が無くても予測自体は記録する */ }

      const record = {
        fixtureId, homeTeamEn: isHome ? team.nameEn : opponentName, awayTeamEn: isHome ? opponentName : team.nameEn,
        // 自己改善ループ①: リーグ別の精度診断のためにリーグ名も記録する
        league: (fx.league && fx.league.name) ? fx.league.name : null,
        homeFormScore, awayFormScore, predictedWinner, // v1互換フィールド(既存のバックテスト・テストとの互換性のため維持)
        homeLambda, awayLambda, features, weightsSnapshot: weights, factorImportance: importance,
        kickoff: fx.fixture.date, loggedAt: runAt.toISOString(),
        resolved: false, actualWinner: null, correct: null, resolvedAt: null,
        originTeamEn: team.nameEn, stateHypothesis,
        // 精度証明ラウンド: オッズ(市場比較・ROI用)と「似た試合」(RAG強化)
        odds: matchOdds, marketImplied, marketEdgePt,
        similarPast: similarPast.length ? similarPast : null,
        similarPastJa: summarizeSimilarMatchesJa(similarPast),
        // 2026年8月・ご指示⑨: 最終スコア予想(ポアソン分布の最頻値)も記録し、
        // 試合後にスコア一致まで採点できるようにする。
        predictedScoreline: mostLikelyScoreline(homeLambda, awayLambda),
        // ご指示③④の証明: この予測がどのversionの重みで行われたか。
        weightsVersion: weights.version ?? 0,
        // ご指示⑤: この予測に使ったデータの信頼度(出所×鮮度)。
        // 第8次監査の修正: 取得できなかったデータを「信頼度0.95で使った」と
        // 記録しないよう、両側の実値が取れている特徴量だけを計上する。
        featureTrust: buildFeatureTrust([
          ...((homeCtx.formScore ?? null) !== null && (awayCtx.formScore ?? null) !== null
            ? [{ key: "form", source: "derived", kind: "form", computedAt: runAt.toISOString() }] : []),
          ...((homeCtx.injuryCount ?? null) !== null && (awayCtx.injuryCount ?? null) !== null
            ? [{ key: "injuries", source: "api-football", kind: "injuries", computedAt: runAt.toISOString() }] : []),
          ...((homeCtx.pointsPerGame ?? null) !== null && (awayCtx.pointsPerGame ?? null) !== null
            ? [{ key: "standings", source: "api-football", kind: "standings", computedAt: runAt.toISOString() }] : []),
          ...(homeXg && homeXg.xgNet !== null && awayXg && awayXg.xgNet !== null
            ? [{ key: "xg", source: "api-football", kind: "xg", computedAt: runAt.toISOString() }] : []),
        ], runAt.getTime()),
        // 2026年8月・優先順位③: モデルの外側にある原因(監督交代・スタメン変更等)を
        // 試合後に特定できるよう、予測時点の文脈を保存しておく。
        // ここでは追加のAPI呼び出しを増やさず、既に取得済みの情報だけを記録する
        // (フォーメーション・スタメンは解決時に/fixtures/lineupsで照合する)。
        predictionContext: {
          homeCoachName: (isHome ? homeCoachNameAtPrediction : opponentCoachNameAtPrediction) || null,
          awayCoachName: (isHome ? opponentCoachNameAtPrediction : homeCoachNameAtPrediction) || null,
          homeFormation: null, awayFormation: null,
          homeLineupNames: null, awayLineupNames: null,
          capturedAt: runAt.toISOString(),
        },
      };
      await upstashSetJSON(`learn:ownpred:${fixtureId}`, record);
      await upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]).catch(() => {});
      await upstashCmd(["INCR", "learn:ownpred:total"]).catch(() => {});
      newPredictionsLogged++;
      predictionClubsSeen.push(team.nameEn);
      // 「どのクラブがいつ予測されたか」を残し、TOP100のカバー率を後から実測できるようにする
      // (説明責任: 「漏れていないか」を推測ではなく数字で答えられるようにするため)
      await upstashCmd(["HSET", "learn:ownpred:clubcoverage", team.nameEn, dateKey]).catch(() => {});
    } catch (e) {
      errors.push(`predict_failed:${team.nameEn}:${e.message}`);
    }
  }

  // ---- 予測カバー率の実測(推測ではなく数字で説明できるようにする) ----
  let predictionCoverage = null;
  try {
    const cov = (await upstashCmd(["HGETALL", "learn:ownpred:clubcoverage"]).catch(() => null)) || [];
    // UpstashのHGETALLは [field, value, field, value, ...] 形式で返る
    const map = new Map();
    if (Array.isArray(cov)) {
      for (let i = 0; i + 1 < cov.length; i += 2) map.set(String(cov[i]), String(cov[i + 1]));
    } else if (cov && typeof cov === "object") {
      for (const k of Object.keys(cov)) map.set(k, String(cov[k]));
    }
    const top100Covered = CLUB_UNIVERSE.filter((c) => map.has(c.nameEn));
    const never = CLUB_UNIVERSE.filter((c) => !map.has(c.nameEn)).map((c) => c.nameEn);
    predictionCoverage = {
      poolSize: predictionPool.length,
      scannedToday: predictionPoolScanned,
      loggedToday: newPredictionsLogged,
      clubsToday: predictionClubsSeen,
      stoppedReason: predictionStoppedReason,
      top100Covered: top100Covered.length,
      top100Total: CLUB_UNIVERSE.length,
      top100CoveredPct: CLUB_UNIVERSE.length ? Math.round((top100Covered.length / CLUB_UNIVERSE.length) * 1000) / 10 : null,
      neverPredictedSample: never.slice(0, 10),
      neverPredictedCount: never.length,
      noteJa: `予測の対象は全${predictionPool.length}クラブ(UEFA上位100 + 登録クラブ)。本日は${predictionPoolScanned}クラブを確認し${newPredictionsLogged}件を新規記録。上位100のうち${top100Covered.length}クラブは過去に1回以上予測済み(${never.length}クラブは未実施)。`,
    };
  } catch (e) {
    predictionCoverage = { error: e.message, noteJa: "予測カバー率を取得できませんでした(Upstashの読み出しに失敗)" };
  }

  // ---- ③-b UEFA上位100クラブの知識収集(2026年8月・知識拡大フェーズ) ----
  // ご指示①②③: 上位100クラブとその選手の実データを、更新頻度の階層つきで
  // 毎日収集し、クラブ調査ファイル(kb:club:*)へ構造化して保存する。
  // 自社予測の記録・検証(②③)より後に置くのは、監査で判明した
  // 「学習の中核が予算切れで飢える」事故を繰り返さないため。
  let universeStats = null;
  try {
    const clubDossier = createClubDossier({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
    // 2026年8月・ご指示⑩: 前回の学習計画(AIが自分で決めた「次に学ぶテーマ」)を
    // 読み、優先クラブを今日の収集で実際に優先させる(決めるだけで終わらせない)。
    let priorityClubs = [];
    try {
      const latestAgenda = await loadLatestAgenda({ upstashEnabled, upstashGetJSON });
      // 自己改善ループ③: 優先クラブ数の上限はAI自身が調整(3〜10の安全範囲)
      priorityClubs = priorityClubsOf(latestAgenda).slice(0, selfTuneConfig.priorityClubsMax);
      if (priorityClubs.length) {
        agendaAppliedToday = {
          generatedAt: latestAgenda.generatedAt || null,
          priorityClubs,
          noteJa: `前回の学習計画に基づき、${priorityClubs.length}クラブ(苦手と実測されたクラブ)を今日の収集で優先しました(優先枠の上限${selfTuneConfig.priorityClubsMax}はAIの自己改善ループが管理)。`,
        };
      }
    } catch (e) { /* 計画が無ければ通常の輪番のみ */ }
    universeStats = await collectUniverse({
      callApiFootball, apiBudget, clubDossier, knowledgeStore,
      knowledgeGraph, thoughtTimeline, computeFormScore,
      recordLearned: saveWithImportance,
      priorityClubs,
      // 自己改善ループ③: AIが調整した収集設定(xG周期・選手詳細上限)を反映
      tune: { xgRotationDays: selfTuneConfig.xgRotationDays, playerDetailCap: selfTuneConfig.playerDetailCap },
      // 第8次監査: 同日再実行ガード(kb:universe:ran:<date>)の読み書きに使う
      upstashCmd, upstashGetJSON, upstashSetJSON,
    }, runAt, dateKey);
    if (universeStats.errors && universeStats.errors.length) errors.push(...universeStats.errors);
  } catch (e) {
    errors.push(`universe_collection_failed:${e.message}`);
  }

  // ---- ④ 十分な検証データが溜まっていれば、モデルの重みを再調整する ----
  const totalResolvedRaw = await upstashCmd(["GET", "learn:ownpred:resolved"]).catch(() => null);
  const totalCorrectRaw = await upstashCmd(["GET", "learn:ownpred:correct"]).catch(() => null);
  const totalResolved = parseInt(totalResolvedRaw, 10) || 0;
  const totalCorrect = parseInt(totalCorrectRaw, 10) || 0;
  const ownAccuracyBefore = totalResolved > 0 ? Math.round((totalCorrect / totalResolved) * 1000) / 10 : null;
  let weightsUpdated = false;
  // 第5次監査で発見した「単位のすり替え」の修正。
  //   ownAccuracyBefore は**通算**の的中率(累計正解 ÷ 累計検証済み)である。
  //   ところが従来は、重みを更新した日にかぎって ownAccuracyAfter を
  //   **その日のバックテストの的中率**で上書きしていた。まったく別の指標なので、
  //   dailyMetrics が両者を引き算して「的中率がNポイント改善しました」と
  //   表示していた数字は、単位の違いによる見かけの変化でしかなかった。
  //   通算的中率は過去にさかのぼって良くなることはないので、重みの更新では
  //   動かさない。モデルの良し悪しは v2AccuracyBefore/After(バックテスト)で
  //   別枠で報告する。
  let ownAccuracyAfter = ownAccuracyBefore;
  let weightsUpdatedV2 = false; // Prediction Engine v2(拡張特徴量)の重みが更新されたか
  let v2AccuracyBefore = null;
  let v2AccuracyAfter = null;
  let v1BacktestReference = null; // 旧v1モデルの的中率(参考値。採否の判定には使わない)

  // 2026年8月・第5次監査での設計変更(ご指示「より良い設計を積極的に提案・実装して
  // ください」に基づく)。
  //
  // ■ これまでの重大な設計上の誤り
  //   重みの学習は2段構えになっていた。
  //     ④-a グリッドサーチ(v1): sensitivity と homeBase を振ってみる
  //     ④-b 勾配降下法(v2): 拡張特徴量10項目の重みを学習する
  //   ところが両者は**同じ learn:weights キーへ書き込む**のに、
  //   ④-a の採否は「v1モデル(フォームスコアだけを見る旧モデル)」の的中率で
  //   判定していた。利用者に見えている予測は v2 モデルなのに、である。
  //   その結果、v1の物差しでだけ良く見える重みが v2 の予測へ無検証で流し込まれ、
  //   実測で**v2の的中率が 88.3% → 83.3% へ悪化した状態が、
  //   「重みを更新しました。的中率が改善しました」という表示とともに保存される**
  //   ことがシミュレーションで再現できた。
  //
  // ■ 変更後の設計
  //   1) 物差しを1本にする。採否の判定は**必ず利用者が見ている v2 モデル**
  //      (backtestAccuracyV2)で行う。v1の的中率は参考値としてのみ記録する。
  //   2) ホールドアウト検証を導入する。直近30%を検証用に取り置き、残り70%で
  //      学習・探索し、**検証用データでも改善している場合だけ採用**する。
  //      これまでは同じデータで探して同じデータで採点していたため、
  //      「改善」の多くは選択によるまぐれ(過学習)だった。
  //   3) 保存の直前に isSaneWeights() を必ず通す。NaN・発散した値を弾く。
  //   4) 書き込みの成否を確認してから「更新した」と報告する。
  //      これまでは Upstash への書き込みが失敗しても成功表示をしていた。
  //
  // ■ 全体を try/catch で包む理由
  //   このブロックが例外を投げると、後続の⑤(知識の保存)・成長ログ・
  //   メトリクスまで丸ごと失われ、外からは「その日はジョブが動かなかった」と
  //   しか見えなくなる(健康診断も「GitHub Actionsが動いていない可能性」と
  //   誤った原因を表示する)。学習に失敗しても、その日の知識は必ず残す。
  // 第8次監査: 二度読み防止 — recentRecordsSharedは上の予測ステージ(似た試合の
  // 検索)と共有(loadRecentRecordsOnce)。既に読み込み済みならそれを再利用する。
  if (totalResolved >= MIN_RESOLVED_FOR_RECALIBRATION) {
    try {
      const recentRecords = await loadRecentRecordsOnce();
      const storedWeights = await upstashGetJSON("learn:weights");
      const currentWeights = { ...EXTENDED_DEFAULT_WEIGHTS, ...DEFAULT_WEIGHTS, ...(storedWeights || {}) };

      // ---- ホールドアウト分割(直近30%を検証用に取り置く) ----
      // learn:ownpred:recent は古い順に並んでいるため、末尾が新しい。
      // 「過去で学び、未来で検証する」という時系列的に正しい分割になる。
      const HOLDOUT_RATIO = 0.3;
      const usable = recentRecords.filter((r) => r && r.actualWinner && r.features);
      const holdoutSize = Math.floor(usable.length * HOLDOUT_RATIO);
      const canHoldout = holdoutSize >= 3 && usable.length - holdoutSize >= 5;
      // 第6次監査で発見した「見せかけのホールドアウト」の修正:
      //   検証用に取り置けるデータが足りないとき、従来は trainSet と validSet に
      //   **同じ配列**を入れていた。すると「学習用でも検証用でも改善した候補だけを
      //   採用する」という二重の関門が、実質1回の判定に潰れてしまう(過学習を
      //   まったく防げない)。それどころか採用理由には
      //   「取り置いた検証用N件でも改善したため採用しました」と書かれるため、
      //   **やっていない検証をやったと記録に残していた**。
      //   検証用データを用意できないなら、重みは変更しない。
      const validSet = canHoldout ? usable.slice(usable.length - holdoutSize) : [];
      const fitSet = canHoldout ? usable.slice(0, usable.length - holdoutSize) : usable;

      // 採否の判定に使う唯一の物差し(利用者が実際に見ているモデル)
      const scoreOn = (records, w) => (records && records.length ? backtestAccuracyV2(records, w) : null);
      const baseTrain = scoreOn(fitSet, currentWeights);
      const baseValid = scoreOn(validSet, currentWeights);
      // 参考値として旧v1モデルの的中率も残す(表示には使わない)
      const v1Reference = backtestAccuracy(recentRecords, currentWeights);

      // 2026年8月・ご指示⑤: 信頼度の高いデータで行った予測ほど強く学習する。
      const trustOpts = { sampleWeightOf };
      // 2026年8月・ご指示⑧: どの特徴量が当たりに寄与し、どれが不要かを実測する。
      // (重みを1つずつ0にしたときの損失変化 = その特徴量の実際の寄与)
      try {
        featureEffectivenessToday = computeFeatureEffectiveness(usable, currentWeights, trustOpts);
        if (featureEffectivenessToday && featureEffectivenessToday.measurable) {
          await upstashSetJSON(`learn:features:report:${dateKey}`, featureEffectivenessToday).catch(() => {});
        }
      } catch (e) { errors.push(`feature_effectiveness_failed:${e.message}`); }

      const adopt = async (candidate, method, note) => {
        // ---- 保存前の安全確認(第5次監査で追加) ----
        if (!isSaneWeights(candidate)) {
          errors.push(`weights_rejected_insane:${method}`);
          await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
            date: dateKey, adopted: false, method, oldWeights: currentWeights, newWeights: null,
            oldAccuracy: baseValid ? baseValid.accuracy : null, newAccuracy: null,
            sampleSize: validSet.length,
            note: "学習結果に数値として異常な値(NaNや発散)が含まれていたため、安全のため採用しませんでした。",
          })]).catch(() => {});
          return false;
        }
        const newWeights = { ...candidate, version: (currentWeights.version || 0) + 1, updatedAt: runAt.toISOString() };
        const written = await upstashSetJSON("learn:weights", newWeights);
        if (written === false) {
          // 書き込み失敗を「更新できた」と報告しない(第5次監査の指摘)
          errors.push(`weights_write_failed:${method}`);
          return false;
        }
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: true, method, oldWeights: currentWeights, newWeights,
          oldAccuracy: baseValid ? baseValid.accuracy : null,
          newAccuracy: scoreOn(validSet, newWeights) ? scoreOn(validSet, newWeights).accuracy : null,
          sampleSize: validSet.length,
          holdout: canHoldout, note,
        })]).catch(() => {});
        return true;
      };

      if (baseTrain && baseValid) {
        v2AccuracyBefore = baseValid.accuracy;
        v2AccuracyAfter = baseValid.accuracy;

        // ---- 候補①: ホーム補正と感度の近傍探索(旧グリッドサーチ) ----
        // 探索そのものは残すが、**採点はv2モデルで行う**。homeBase は
        // LEARNABLE_KEYS に含まれないため、これが唯一のホーム補正の調整手段になる。
        const gridCandidates = [
          { ...currentWeights, sensitivity: currentWeights.sensitivity * 1.2 },
          { ...currentWeights, sensitivity: currentWeights.sensitivity * 0.8 },
          { ...currentWeights, homeBase: Math.min(3, currentWeights.homeBase + 0.1) },
          { ...currentWeights, homeBase: Math.max(0.8, currentWeights.homeBase - 0.1) },
        ];
        // ---- 候補②: 勾配降下法で拡張特徴量の重みを学習する ----
        // ご指示⑤: 信頼度による加重(trustOpts)つき。信頼度の記録が無い
        // 古い記録は重み1.0として扱われるため、従来の挙動を壊さない。
        const fitted = fitWeightsGradientDescent(fitSet, currentWeights, trustOpts);

        // ---- 候補③(ご指示⑧): 実測で「有害」と出た特徴量を外した候補 ----
        // 第8次監査(Low)の修正: 候補の選定を全データ(検証用込み)で行うと、
        // 検証用でたまたま悪く見えた特徴量の0化候補が同じ検証用の関門を通り
        // やすくなる選択バイアスがあった。候補の選定は**学習用データのみ**で行い、
        // 検証用データは関門(採否判定)でだけ使う(表示用のレポートは全データのまま)。
        const effectivenessForCandidates = computeFeatureEffectiveness(fitSet, currentWeights, trustOpts);
        const ablationCandidates = buildAblationCandidates(effectivenessForCandidates, currentWeights);

        const allCandidates = [
          ...gridCandidates.map((w) => ({ w, method: "grid_search_v1" })),
          ...(fitted ? [{ w: fitted, method: "gradient_descent_v2" }] : []),
          ...ablationCandidates.map((c) => ({ w: c.w, method: c.method })),
        ];

        let best = null;
        for (const c of allCandidates) {
          const trainScore = scoreOn(fitSet, c.w);
          const validScore = scoreOn(validSet, c.w);
          if (!trainScore || !validScore) continue;
          // **学習用でも検証用でも改善している候補だけ**を採用対象にする。
          // 検証用だけで良く見える候補は、たまたま当たっただけの可能性が高い。
          if (trainScore.accuracy <= baseTrain.accuracy) continue;
          if (validScore.accuracy <= baseValid.accuracy) continue;
          if (!best || validScore.accuracy > best.validScore.accuracy) best = { ...c, trainScore, validScore };
        }

        if (best) {
          const ok = await adopt(best.w, best.method,
            `学習用${fitSet.length}件で${baseTrain.accuracy}%→${best.trainScore.accuracy}%、` +
            `取り置いた検証用${validSet.length}件でも${baseValid.accuracy}%→${best.validScore.accuracy}%と改善したため採用しました。`);
          if (ok) {
            weightsUpdated = true;
            weightsUpdatedV2 = best.method === "gradient_descent_v2";
            v2AccuracyAfter = best.validScore.accuracy;
            // ---- 2026年8月・ご指示①: 「その学習によって予測がどう変わったか」 ----
            // 直近の検証済み試合に旧重み・新重みの両方で予測を計算し、
            // ホーム勝率±%・引き分け確率±%・期待得点±・自信±% の実測差を保存する。
            try {
              predictionShiftToday = computePredictionShift(usable.slice(-30), currentWeights, best.w);
              if (predictionShiftToday) {
                await upstashCmd(["RPUSH", "learn:weights:impact", JSON.stringify({
                  date: dateKey, at: runAt.toISOString(), method: best.method,
                  weightsVersionFrom: currentWeights.version || 0,
                  weightsVersionTo: (currentWeights.version || 0) + 1,
                  shift: predictionShiftToday,
                })]).catch(() => {});
                await upstashCmd(["LTRIM", "learn:weights:impact", "-30", "-1"]).catch(() => {});
                // Memory Engineの時系列にも「AIの判断が変わった」として残す
                if (thoughtTimeline) {
                  await thoughtTimeline.append("model:weights:beliefs", {
                    kind: "belief",
                    statementJa: predictionShiftToday.summaryJa,
                    evidence: [`重みversion ${(currentWeights.version || 0)}→${(currentWeights.version || 0) + 1}(${best.method})`],
                    at: runAt.toISOString(),
                  }).catch(() => {});
                }
              }
            } catch (e) { errors.push(`prediction_shift_failed:${e.message}`); }
          }
        } else {
          await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
            date: dateKey, adopted: false, method: "holdout_validated", oldWeights: currentWeights, newWeights: null,
            oldAccuracy: baseValid.accuracy, newAccuracy: null, sampleSize: validSet.length, holdout: canHoldout,
            note: canHoldout
              ? "学習用と検証用の両方で改善する候補が見つからなかったため、重みは変更しませんでした(過学習の防止)。"
              : "検証用に取り置けるだけのデータがまだ無いため、慎重を期して重みは変更しませんでした。",
          })]).catch(() => {});
        }
      } else {
        // 重みを見直せなかった場合。黙って何もしないと「学習が動いていない」のか
        // 「動いた結果変更なし」なのか区別できないため、**本当の理由**を必ず残す。
        // 第6次監査の指摘への対応: 従来はどの理由でも一律に
        // 「拡張特徴量がまだ含まれていないため」と記録しており、
        // 健康診断の画面が誤った原因を表示していた。
        const skipReason = !usable.length
          ? { method: "skipped_no_v2_records", note: "予測の記録に拡張特徴量(features)がまだ含まれていないため、現在の予測モデルでの検証ができませんでした。新しい形式で記録された予測が溜まり次第、自動的に再開します。" }
          : !canHoldout
            ? { method: "skipped_insufficient_holdout", note: `検証用に取り置けるだけのデータがまだありません(検証可能な記録${usable.length}件)。同じデータで探して同じデータで採点すると「たまたま当たっただけ」を改善と誤認するため、慎重を期して重みは変更していません。` }
            : { method: "skipped_not_scorable", note: "検証データの採点ができなかったため、重みは変更していません。" };
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: false, method: skipReason.method,
          oldWeights: currentWeights, newWeights: null,
          oldAccuracy: v1Reference ? v1Reference.accuracy : null, newAccuracy: null,
          sampleSize: usable.length, holdout: canHoldout,
          note: skipReason.note,
        })]).catch(() => {});
      }
      if (v1Reference) {
        // 旧v1モデルの数字は参考値であることを記録に残す(表示には使わない)
        v1BacktestReference = v1Reference.accuracy;
      }
      await upstashCmd(["LTRIM", "learn:weights:history", "-30", "-1"]).catch(() => {});
    } catch (e) {
      // 学習に失敗しても、その日の知識・成長ログは必ず残す
      errors.push(`weight_learning_failed:${e && (e.code || e.message)}`);
    }
  }

  // ---- ④-b 過去試合によるモデル調整(2026年8月・共同開発者レビュー対応) ----
  //   上の重み学習は「自社が予測した試合」だけを使うため、本番でも36件しか
  //   貯まらず、11特徴量のうち10個の重みが初期値0のままだった。
  //   モデルの学習に必要なのは「自分が予測したか」ではなく
  //   「特徴量と結果のペア」なので、過去シーズンの実試合を取得して使う
  //   (Backfill / Historical Training)。5リーグ×3シーズン=約15リクエストで
  //   数千試合。ここで λ の独立化(和の重み)と Dixon-Coles の ρ を学習し、
  //   **多指標のバックテストで改善したときだけ採用する。**
  let modelTuning = null;
  try {
    const storedForTune = await upstashGetJSON("learn:weights");
    const baseForTune = { ...EXTENDED_DEFAULT_WEIGHTS, ...DEFAULT_WEIGHTS, ...(storedForTune || {}) };
    modelTuning = await tuneModelOnHistory(
      { upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON, callApiFootball, apiBudget },
      baseForTune, runAt
    );
  } catch (e) {
    errors.push(`model_tuning_failed:${e && (e.code || e.message)}`);
    modelTuning = { ran: false, adopted: false, reasonJa: `過去試合によるモデル調整でエラーが発生しました(${e && e.message})。` };
  }

  // ---- ⑤ 今日の知識ベース更新と成長ログ ----
  // Stage E以降: 「事実」の保存先はKnowledge Engine(knowledgeStore.js)に一本化。
  // 重複した内容(前日と全く同じ事実)は正直に「重複」として扱われ、二重に
  // カウントしない(knowledgeStore.jsのハッシュベース重複排除による)。
  let knowledgeItemsSavedToday = 0;
  let knowledgeItemsDuplicateToday = 0;
  for (const f of factsToday) {
    try {
      // 第5次監査で発見した「事実の取り違え」の修正:
      //   factsToday には category:"フォーム" と category:"ホームアウェイ差" の
      //   2種類が入るのに、保存時に**全部 recentFormTrend で上書き**していた。
      //   そのためホーム/アウェイの得意不得意という事実が、推論エンジンでは
      //   「直近の調子」の根拠として数えられ、本来の
      //   「ホーム/アウェイ(home_away)」仮説の根拠には一切ならなかった。
      const KNOWLEDGE_CATEGORY_BY_FACT = {
        "ホームアウェイ差": "homeAway",
        "フォーム": "recentFormTrend",
      };
      const saveResult = await saveWithImportance({
        teamEn: f.teamEn, teamJa: f.teamJa,
        category: KNOWLEDGE_CATEGORY_BY_FACT[f.category] || "recentFormTrend", type: "fact",
        statement: f.statement, computedAt: runAt.toISOString(),
      }, { formDelta: Number.isFinite(f.delta) ? f.delta : null });
      if (saveResult.saved) knowledgeItemsSavedToday++;
      else if (saveResult.reason === "DUPLICATE" || saveResult.reason === "DUPLICATE_RELINKED") knowledgeItemsDuplicateToday++;
      // 第7次監査での追加: 保存先の読み取りに失敗した場合(第6次の修正で
      // 「新しい知識」として数えるのはやめたが)、そのまま黙って消えると
      // 「今日は変化が無かった」と区別がつかない。理由として残す。
      else if (saveResult.reason === "LOOKUP_FAILED") errors.push(`knowledge_lookup_failed:${f.teamEn}`);
    } catch (e) {
      errors.push(`knowledge_save_failed:${f.teamEn}:${e.message}`);
    }
  }
  // ①-d(監督交代・補強)、①-e(リーグ単位の順位表・ランキング)は既に個別に
  // 保存済みなので、ここでは「今日追加した知識」の合計件数にだけ加算する
  // (二重保存はしない)。
  knowledgeItemsSavedToday += transferFactsAddedToday + coachChangesDetectedToday + leagueResult.leagueFactsSavedToday + playerResult.playerFactsSavedToday;
  knowledgeItemsDuplicateToday += leagueResult.leagueFactsDuplicateToday + playerResult.playerFactsDuplicateToday;

  // ---- 「昨日より知識が増えていることが分かるようにする」ための集計 ----
  // 全登録クラブ横断で、今日新しく覚えた知識・更新された知識・古くなった
  // (失効した)知識の件数を数える(Knowledge Engine全体、Layer1〜4合算)。
  let knowledgeNewToday = 0;
  let knowledgeUpdatedToday = 0;
  let knowledgeStaleTotal = 0;
  for (const team of REGISTERED_TEAMS) {
    try {
      const diff = await knowledgeStore.getKnowledgeDiffForTeam(team.nameEn, dateKey, runAt.getTime());
      knowledgeNewToday += diff.newItems.length;
      knowledgeUpdatedToday += diff.updatedItems.length;
      knowledgeStaleTotal += diff.staleCount;
    } catch (e) { /* ベストエフォート */ }
  }

  // ---- Failure Learning(ご要望①): 直近の外れた理由を頻度順に集計する ----
  // 「今日」だけでなく直近の傾向も分かるよう、learn:ownpred:recent(既に
  // failureReasonsを保持している解決済みレコード)から機械的に集計する。
  let topFailureReasonsRecent = [];
  let topSuccessReasonsRecent = []; // 2026年8月: 最近うまくいっている判断基準
  let agendaToday = null; // ご指示⑩: AIが自分で決めた「次に学ぶテーマ」
  try {
    // 第8次監査(Medium)の修正: learn:ownpred:recent(最大300件×数KB)を同一実行内で
    // 二度全件読みしていた。重み学習の段(④)で読んだ結果を再利用する。
    // 精度証明ラウンドで一本化: 共有ローダー(既に読み込み済みなら再利用)を使う
    const recentForFailures = await loadRecentRecordsOnce();
    topFailureReasonsRecent = summarizeFailureReasons(recentForFailures, 5);
    topSuccessReasonsRecent = summarizeSuccessReasons(recentForFailures, 5);
    // ---- 2026年8月・ご指示⑩: 次に何を学ぶかをAI自身が決める ----
    // 実測(どのクラブで外しているか・何が原因で外れているか)から優先順位つきの
    // 学習計画を作り、保存する。明日の収集(上の③-b)がこれを読んで実行する。
    try {
      agendaToday = buildLearningAgenda(recentForFailures, topFailureReasonsRecent, { nowIso: runAt.toISOString() });
      await saveAgenda({ upstashEnabled, upstashSetJSON }, dateKey, agendaToday);
    } catch (e) { errors.push(`agenda_build_failed:${e.message}`); }
  } catch (e) { /* ベストエフォート */ }

  const growthLog = {
    date: dateKey,
    ranAt: runAt.toISOString(),
    teamsAnalyzed: REGISTERED_TEAMS.length,
    factsAddedToday: factsToday.length,
    facts: factsToday,
    // ②(ご要望②・Knowledge Engineの毎日成長): 監督交代・補強はfactsToday(フォーム系)
    // とは別経路で保存済みのため、表示専用の配列として別フィールドで返す。
    otherFactsToday, coachChangesDetectedToday, transferFactsAddedToday,
    knowledgeItemsSavedToday, knowledgeItemsDuplicateToday,
    // 2026年8月・優先順位⑥: リーグ単位(順位表・得点/アシストランキング)の日次蓄積。
    leaguesAnalyzedToday: leagueResult.leaguesProcessed,
    mandatoryLeaguesAnalyzedToday: leagueResult.mandatoryLeaguesProcessed,
    extendedLeaguesAnalyzedToday: leagueResult.extendedLeaguesProcessed,
    leagueFactsAddedToday: leagueResult.leagueFactsSavedToday,
    leagueFactsDuplicateToday: leagueResult.leagueFactsDuplicateToday,
    leagueFactsToday: leagueResult.leagueFactsToday,
    // 2026年8月・優先順位⑦: 選手情報の日次更新。「更新できなかった項目の理由」まで含めて返す。
    playersCheckedToday: playerResult.playersCheckedToday,
    playersUpdatedToday: playerResult.playersUpdatedToday,
    playerFactsAddedToday: playerResult.playerFactsSavedToday,
    playerFactsDuplicateToday: playerResult.playerFactsDuplicateToday,
    playerFactsToday: playerResult.playerFactsToday,
    playerFieldsUpdatedToday: playerResult.fieldsUpdatedToday,
    playerFieldsPermanentlyUnavailable: playerResult.fieldsPermanentlyUnavailable,
    playerFieldsRetryableToday: playerResult.fieldsRetryableToday,
    playerUnavailableReasonsToday: playerResult.unavailableReasonsToday,
    // 2026年8月・優先順位⑦: APIリクエスト予算の使用状況(優先順位⑨の診断用)。
    // 優先順位⑪: どうやってその予算値を決めたか(自動判定/手動設定/既定値)も併記する。
    // 欠陥Cの修正: 共有インスタンスを使う場合、ローカルで計算した
    // effectiveDailyBudget は採用されていない。実際に使われている値と
    // 食い違う説明を表示しないよう、共有時は実インスタンスの状態を正とする。
    apiBudget: {
      ...apiBudget.summary(),
      sourceJa: usingSharedBudget
        ? `サーバー共有の予算インスタンスを使用しています(実際の上限: ${apiBudget.summary().dailyBudget}件/日)。すべてのAPI呼び出しがこの1つの予算を通ります。`
        : budgetSourceJa,
      // 2026年8月・本番の表示ズレの修正: detectedPlan は実行開始時点(=まだ
      // 1度もAPIを呼んでいない時点)のスナップショットだったため、実際には
      // Proの7,500件/日で動いているのに「まだ判定できていません」と表示されて
      // いた。ログを書く時点で読み直し、実行中に判明した値を正しく残す。
      detectedPlan: ((typeof getApiPlanInfo === "function") ? getApiPlanInfo() : null) || detectedPlan || null,
    },
    matchesResolvedToday,
    newPredictionsLogged,
    // 2026年8月・「TOP100の試合が漏れていないか」への回答を、推測ではなく
    // 実測値で返すための集計(どのクラブが未予測かまで含む)
    predictionCoverage,
    // 過去試合を使ったモデル調整の結果(採用/不採用と、その理由・比較表)
    modelTuning: modelTuning ? {
      ran: modelTuning.ran, adopted: modelTuning.adopted, reasonJa: modelTuning.reasonJa,
      datasetSize: modelTuning.datasetSize ?? null,
      datasetNoteJa: modelTuning.datasetNoteJa ?? null,
      trainSize: modelTuning.trainSize ?? null, testSize: modelTuning.testSize ?? null,
      oldEval: modelTuning.oldEval ?? null, newEval: modelTuning.newEval ?? null,
      comparisonJa: modelTuning.comparisonJa ?? null,
      newParams: modelTuning.newParams ?? null,
    } : null,
    // 実行中の重複APIをどれだけ削れたか(実測)。データ量は減らしていない。
    apiRunMemo: {
      hits: runMemoHits, misses: runMemoMisses,
      savedRequests: runMemoHits,
      noteJa: runMemoHits > 0
        ? `1回の実行の中で同じ問い合わせが${runMemoHits}回発生したため、実際のAPIリクエストを${runMemoHits}件節約しました(取得したデータの量・鮮度は変わりません)。`
        : "実行中の重複した問い合わせはありませんでした。",
    },
    hypothesesConfirmed, hypothesesDiscarded,
    reflectionsSaved, // Layer4: 当たり/外れ問わず保存した振り返りの件数
    failureReasonsToday, // Failure Learning: 今日外れた予測それぞれの理由(配列)
    topFailureReasonsRecent, // Failure Learning: 直近の解決済み予測全体での頻出理由(頻度順)
    successReasonsToday, // 2026年8月: 今日当たった予測それぞれの理由(配列)
    topSuccessReasonsRecent, // 2026年8月: 最近うまくいっている判断基準(頻度順)
    profilesGenerated, // Layer2: 今日新しく生成した固定知識(クラブプロフィール)の件数
    aiViewsChanged, aiViewsUnchanged, // Layer3: AIの見解が変わった/変わらなかったクラブ数
    llmSkippedReasons, // Layer2/3がLLM未設定でスキップされた場合の理由(空配列なら正常実行)
    ownAccuracyBefore, ownAccuracyAfter,
    weightsUpdated, // v1(フォーム差のみ)モデルの重みが更新されたか
    weightsUpdatedV2, v2AccuracyBefore, v2AccuracyAfter, // v2(拡張特徴量)モデルの重みが更新されたか
    totalOwnPredictionsResolved: totalResolved,
    knowledgeNewToday, knowledgeUpdatedToday, knowledgeStaleTotal, // 「昨日より知識が増えている」ことの可視化用
    v1BacktestReference, // 旧v1モデルの的中率(参考値。採否の判定には使っていない)
    // ---- 2026年8月・優先順位⑫: 「何を、なぜ学ぶ価値があると判断したか」 ----
    // 「今日は知識が34件増えました」だけでは中身の重みが分からなかったため、
    // 重要度別の内訳と、その日いちばん学ぶ価値があった出来事を添える。
    importanceSummary: summarizeImportance(learnedWithImportance),
    // 知識拡大フェーズ: 上位100クラブの収集状況(何を更新し、何を見送ったか)
    universe: universeStats ? {
      coreClubsPlanned: universeStats.coreClubsPlanned,
      coreClubsUpdated: universeStats.coreClubsUpdated,
      squadsUpdated: universeStats.squadsUpdated,
      playersUpdated: universeStats.playersUpdated,
      xgClubsUpdated: universeStats.xgClubsUpdated,
      standingsLeaguesUpdated: universeStats.standingsLeaguesUpdated,
      changesDetected: (universeStats.changesDetected || []).slice(0, 20),
      skipped: universeStats.skipped || [],
      // ---- 2026年8月・全機能監査で判明した開示漏れ ----
      //   収集中に発生したエラー(universe_squad_failed など)は
      //   universeStats.errors に貯まっていたのに、**この報告に含まれておらず**
      //   利用者にも運用にも一切見えなかった。他のステージと同じく開示する。
      errors: (universeStats.errors || []).slice(0, 20),
      errorCount: (universeStats.errors || []).length,
      // 選手の内訳(自己改善ループの効果測定が名簿同期に埋もれないよう分離した値)
      playersIndexed: universeStats.playersIndexed ?? null,
      playersFromSquadSync: universeStats.playersFromSquadSync ?? null,
      playersFromDetailStats: universeStats.playersFromDetailStats ?? null,
      agendaClubsApplied: universeStats.agendaClubsApplied || [],
      // 本番エラー調査: 名前を照合できず収集できなかったクラブ(正直に開示)
      unresolvedClubs: universeStats.unresolvedClubs || [],
    } : null,
    // ---- 2026年8月・「本当に毎日賢くなるAI」フェーズ ----
    // ご指示⑨: 今日答え合わせして市場別に採点できた件数(詳細は learn:accuracy:<date>)
    accuracyScoredToday: resolvedScoredToday.length,
    // ご指示①: 学習によって予測がどう変わったか(採用があった日のみ。実計算の差分)
    predictionShift: predictionShiftToday,
    // ご指示⑧: 特徴量ごとの有効性の実測(有効/有害/未学習)
    featureEffectiveness: featureEffectivenessToday ? {
      measurable: featureEffectivenessToday.measurable,
      sampleSize: featureEffectivenessToday.sampleSize,
      reasonJa: featureEffectivenessToday.reasonJa || null,
      features: (featureEffectivenessToday.features || []).map((f) => ({ labelJa: f.labelJa, weight: f.weight, contribution: f.contribution, verdictJa: f.verdictJa })),
    } : null,
    // ご指示⑩: AIが自分で決めた「次に学ぶテーマ」と、前回の計画を今日反映した内容
    learningAgenda: agendaToday,
    agendaAppliedToday,
    // ご指示①③④の証明: 今日の予測が実際に使った重みのversion。
    // 昨日重みが更新されていれば、このversionが昨日より増えている=
    // 「昨日の学習が今日の予測に反映された」ことがこのログだけで確認できる。
    learningProof: weightsMetaUsedToday ? {
      weightsVersionUsedForTodaysPredictions: weightsMetaUsedToday.version,
      weightsLastUpdatedAt: weightsMetaUsedToday.updatedAt,
      noteJa: `本日の新規予測${newPredictionsLogged}件は、重みversion ${weightsMetaUsedToday.version}(最終更新: ${weightsMetaUsedToday.updatedAt || "初期値のまま"})を使用しました。予測のたびに保存済みの最新重みを読み直すため、前日までの学習は必ず当日の予測に反映されます。`,
    } : null,
    // 1回の実行ぶんでも、エラーが大量に出た日にログが肥大化しないよう上限を設ける
    errors: capList(errors),
  };

  // 同じ日付の既存ログがあれば合算する(上のmergeGrowthLogsのコメント参照)。
  // これにより、Renderのスリープ起床待ち等で同じ日に複数回実行されても、
  // 「今日追加した知識」が最後の実行結果だけで上書きされて0件に見えてしまう
  // ことを防ぐ。
  // 2026年8月・優先順位⑦: 今回の実行で使ったAPIリクエスト数を確定保存する
  // (同じ日に複数回実行されても、1日の合計として正しく積み上がるようにするため)。
  await apiBudget.flush();

  const existingToday = await upstashGetJSON(`learn:growthlog:${dateKey}`).catch(() => null);
  const mergedGrowthLog = mergeGrowthLogs(existingToday, growthLog);
  await upstashSetJSON(`learn:growthlog:${dateKey}`, mergedGrowthLog);
  await upstashSetJSON("learn:growthlog:latest", mergedGrowthLog);
  // 第8次監査(High)の修正: 日付つきキーは削除経路が無く無限成長していた。
  // 比較・履歴表示に十分な120日で自動失効させる(learn:*:latest は残す)。
  // (注: SETはTTLを消すため、EXPIREは必ず「そのキーの最後の書き込みの後」に置く。
  //  metricsはこの後で書くため、EXPIREも書き込み直後に別途行う)
  for (const k of [
    `learn:growthlog:${dateKey}`, `learn:accuracy:${dateKey}`,
    `learn:agenda:${dateKey}`, `learn:features:report:${dateKey}`,
  ]) {
    await upstashCmd(["EXPIRE", k, String(120 * 86400)]).catch(() => {});
  }

  // 2026年8月・完全自動Learning Cycle ⑧「毎日賢くなっていることを証明する」:
  // 日をまたいで比較できる軽量な指標だけを別キーに保存する。growthLogは項目が
  // 多く増減が読み取りにくいため、比較専用のスナップショットを分けている。
  // 2026年8月・総点検で発見した重大な欠陥の修正:
  // engineTotals は getGrowthLog() 側でしか組み立てられておらず、
  // runDailyLearning() が返す growthLog には含まれていなかった。そのため
  // buildDailySnapshot が読む knowledgeTotal / memoryTotal / predictionsTotal が
  // **毎日0のまま保存され**、「昨日より賢くなったか」の判定が永久に
  // 「変化がありませんでした」になっていた(このプロジェクトの最重要目標が
  // 数値で証明できない状態だった)。ここで実際の累計を読み出して同梱する。
  let engineTotalsForMetrics = { knowledgeItemsTotal: 0, memoryConclusionsTotal: 0, predictionsTotal: 0 };
  try {
    const [kRaw, mRaw, pRaw] = await Promise.all([
      upstashCmd(["GET", "knowledge:totalItemsSavedCounter"]).catch(() => null),
      upstashCmd(["GET", "memory:totalConclusionsSavedCounter"]).catch(() => null),
      upstashCmd(["GET", "learn:ownpred:total"]).catch(() => null),
    ]);
    engineTotalsForMetrics = {
      knowledgeItemsTotal: parseInt(kRaw, 10) || 0,
      memoryConclusionsTotal: parseInt(mRaw, 10) || 0,
      predictionsTotal: parseInt(pRaw, 10) || 0,
    };
  } catch (e) { /* ベストエフォート */ }
  const metricsSnapshot = buildDailySnapshot({ ...mergedGrowthLog, engineTotals: engineTotalsForMetrics }, {
    learningDurationMs: Date.now() - learningStartedAtMs,
  });
  await saveDailyMetrics({ upstashEnabled, upstashSetJSON }, metricsSnapshot);
  await upstashCmd(["EXPIRE", `learn:metrics:${dateKey}`, String(120 * 86400)]).catch(() => {});

  // 最終方針「Knowledge Engineは使用回数まで管理」: その日メモリに貯めた
  // 知識の使用回数を1日1回まとめて保存する(質問時にはRedisへ書かない設計)。
  try { await knowledgeStore.flushUsageCounters(); } catch (e) { /* ベストエフォート */ }

  // ---- 2026年8月・AI知能計測ラウンド(ご指示①〜⑨) ----
  // 1日の最後に「AIの脳」の測定をまとめて行う(重い読み書きはすべて夜間バッチの
  // ここで行い、利用者の質問時には一切行わない。最終方針⑥)。
  try {
    const intelDeps = { upstashEnabled, upstashGetJSON, upstashSetJSON };
    // 成長可視化ラウンド⑥: 「答えられるようになった」台帳の更新。
    // フラッシュでバッファが消える前に、対象ごとの最高星を回収してから処理する。
    const answerabilitySubjects = collectAnswerabilityFromBuffer();
    await processAnswerability({ ...intelDeps, upstashCmd }, answerabilitySubjects, runAt.toISOString());
    // ③⑤ 考察の質・RAG使用率: メモリ集計をその日のキーへ保存
    await flushIntelDaily(intelDeps, dateKey);
    await upstashCmd(["EXPIRE", `${INTEL_KEY_PREFIX}${dateKey}`, String(120 * 86400)]).catch(() => {});

    // 成長可視化ラウンド①②: 「今日なにを覚えたか」のカテゴリ別集計を保存し、
    // growthLogにも同梱する(何のカテゴリを何件採用・何件重複除外したか)。
    let knowledgeByCategoryToday = null;
    try {
      const catFlush = await knowledgeStore.flushCategoryCounters(dateKey);
      knowledgeByCategoryToday = catFlush.categories && Object.keys(catFlush.categories).length ? catFlush.categories : null;
      await upstashCmd(["EXPIRE", `learn:knowledge:categories:${dateKey}`, String(120 * 86400)]).catch(() => {});
    } catch (e) { /* ベストエフォート */ }

    // ---- 精度証明ラウンド⑤: 本日のROIを保存(オッズつきの答え合わせがあった日のみ加算) ----
    if (roiAggToday.bets || roiAggToday.oddsMissing) {
      await saveDailyRoi(intelDeps, dateKey, roiAggToday);
      await upstashCmd(["EXPIRE", `${ROI_KEY_PREFIX}${dateKey}`, String(120 * 86400)]).catch(() => {});
    }

    // ---- 精度証明ラウンド①: 「似たクラブ」索引を毎晩再構築(実測ベクトルの距離) ----
    // 質問時はこの1キーを読むだけになる(重い計算は全部ここ=夜間バッチ)。
    try {
      const dossierForSim = createClubDossier({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
      const clubsForSim = [];
      for (const c of CLUB_UNIVERSE) {
        const d = await dossierForSim.getDossier(c.nameEn).catch(() => null);
        if (d) clubsForSim.push({ teamEn: c.nameEn, teamJa: c.nameJa, vector: clubVectorFromDossier(d), traits: clubTraitsFromDossier(d) });
      }
      const simIndex = buildClubSimilarityIndex(clubsForSim, runAt.toISOString());
      await saveClubSimilarityIndex(intelDeps, simIndex);
    } catch (e) { errors.push(`similarity_index_failed:${e.message}`); }

    // 測定材料を読み出す(すべて保存済みの実測値)
    const yesterdayKey = new Date(new Date(`${dateKey}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    const [accuracyTrendNow, intelTrendNow, yesterdayMetrics, topUsedNow] = await Promise.all([
      getAccuracyTrend(intelDeps, dateKey).catch(() => ({ available: false })),
      getIntelTrend(intelDeps, dateKey).catch(() => ({ available: false })),
      upstashGetJSON(`${METRICS_KEY_PREFIX}${yesterdayKey}`).catch(() => null),
      knowledgeStore.getTopUsedKnowledge(10).catch(() => []),
    ]);

    // ⑧ エンジン別の成長率(実測の前日差分のみ)
    const engineGrowth = buildEngineGrowth({
      todayMetrics: metricsSnapshot, yesterdayMetrics,
      accuracyTrend: accuracyTrendNow, intelTrend: intelTrendNow,
    });
    // ① Knowledgeの寄与ランキング(特徴量寄与の実測×知識の対応+使用実績)
    const knowledgeContribution = buildKnowledgeContributionRanking({
      featureEffectiveness: featureEffectivenessToday, topUsedKnowledge: topUsedNow,
    });
    // ⑦ 「最近精度が落ちている原因」の自己分析(実測シグナルからの機械的な特定)
    const accuracyDiagnosis = buildAccuracyDiagnosis({
      accuracyTrend: accuracyTrendNow, featureEffectiveness: featureEffectivenessToday, agenda: agendaToday,
    });
    // ⑨ 毎日の自己評価「今日のAIは昨日より賢くなったか?」(YES/NO/判定不能)
    const selfAssessment = buildSelfAssessment({
      accuracyTrend: accuracyTrendNow,
      metricsComparison: compareSnapshots(metricsSnapshot, yesterdayMetrics),
      intelTrend: intelTrendNow,
      agenda: agendaToday,
      hypothesisStats: computeHypothesisStats(hypothesesConfirmed, hypothesesDiscarded),
      weightsUpdated: !!(weightsUpdated || weightsUpdatedV2),
    });

    // ---- 精度証明ラウンド②: 較正マップ(自信の自動補正の材料)を毎晩更新 ----
    // 直近30日の実測ズレ(ECE)から作る。測定できない期間は「補正なし」を正直に保存。
    const calibrationMap = buildCalibrationMap(
      accuracyTrendNow && accuracyTrendNow.last30Days && accuracyTrendNow.last30Days.markets
        && accuracyTrendNow.last30Days.markets.oneX2 && accuracyTrendNow.last30Days.markets.oneX2.ece,
      runAt.toISOString()
    );
    await upstashSetJSON("learn:calibration:map", calibrationMap);

    // ---- 自己改善ループ: 診断 → 効果測定 → 提案 → 安全な実行 → 履歴 ----
    let selfImprovementReport = null;
    try {
      const budgetSummary = apiBudget.summary();
      const budgetUsagePct = (budgetSummary.dailyBudget > 0)
        ? Math.round((budgetSummary.totalSpent / budgetSummary.dailyBudget) * 1000) / 10 : null;
      // ① 自己診断(保存済みの実測のみ。deps.getApiCallStatsはserver経由の実行時だけ存在)
      const diagnosis = buildSelfDiagnosis({
        recentRecords: await loadRecentRecordsOnce(),
        featureEffectiveness: featureEffectivenessToday,
        apiCallStats: (typeof deps.getApiCallStats === "function") ? deps.getApiCallStats() : null,
        errors,
        accuracyTrend: accuracyTrendNow,
      });
      const xgGapEntry = (diagnosis.dataGaps || []).find((g) => g.key === "xg");
      const metricsNow = {
        xgMissingRatePct: xgGapEntry ? xgGapEntry.missingRatePct : null,
        // 2026年8月・第三者監査の指摘への対応:
        //   playersUpdated には「名簿同期(7日輪番で数百人)」が混ざるため、
        //   playerDetailCap という*詳細成績の上限*の効果を測る指標としては
        //   その日の輪番の当たり外れに完全に埋もれていた。
        //   効果測定には詳細成績ぶんの実測値だけを使う。
        playersUpdatedToday: universeStats
          ? (Number.isFinite(universeStats.playersFromDetailStats) ? universeStats.playersFromDetailStats : universeStats.playersUpdated)
          : null,
        budgetUsagePct,
        hit7dPct: diagnosis.hit7dPct,
      };
      // ④ まず「評価日が来た過去の変更」を効果測定する(悪化していれば自動差し戻し)
      const evaluations = evaluateDueChanges(selfTuneConfig, metricsNow, runAt.toISOString());
      // ② 提案 → ③ 安全な範囲で実行(1日最大2件・評価待ちのノブは触らない)
      const proposals = buildImprovementProposals(diagnosis, selfTuneConfig, { budgetUsagePct });
      const applied = applyProposals(selfTuneConfig, proposals, runAt.toISOString());
      // 新しく登録された評価待ちに、改善前の実測(基準値)を刻む
      for (const pe of selfTuneConfig.pendingEvaluations || []) {
        if (pe.baseline === null || pe.baseline === undefined) {
          pe.baseline = Number.isFinite(metricsNow[pe.metricName]) ? metricsNow[pe.metricName] : null;
        }
      }
      await saveTuneConfig(intelDeps, selfTuneConfig);
      // ⑤ 履歴(診断→提案→変更→評価のすべてを記録)
      const historyEvents = [];
      historyEvents.push({
        at: runAt.toISOString(), type: "diagnosis",
        summaryJa: `診断: ${diagnosis.leagueAccuracy.length ? `最も弱いリーグ=${diagnosis.leagueAccuracy[0].league}(的中率${diagnosis.leagueAccuracy[0].hitRatePct}%)` : "リーグ別は判定不能"} / ${diagnosis.dataGaps.length ? `欠損最大=${diagnosis.dataGaps[0].labelJa}(${diagnosis.dataGaps[0].missingRatePct}%)` : "欠損率は判定不能"} / API成功率${diagnosis.apiFailures.successRatePct !== null ? diagnosis.apiFailures.successRatePct + "%" : "計測前"}`,
      });
      for (const p of proposals) {
        historyEvents.push({ at: runAt.toISOString(), type: "proposal", targetJa: p.targetJa, summaryJa: p.proposalJa, executed: applied.some((a) => p.action && a.knob === p.action.knob) });
      }
      for (const a of applied) {
        historyEvents.push({ at: runAt.toISOString(), type: "change", knob: a.knob, labelJa: a.labelJa, from: a.from, to: a.to, summaryJa: `${a.labelJa}を${a.from}→${a.to}へ変更(${EVAL_AFTER_DAYS}日後に効果測定)` });
      }
      for (const ev of evaluations) {
        historyEvents.push({ at: ev.at, type: ev.type, knob: ev.knob, verdict: ev.verdict, summaryJa: ev.detailJa });
      }
      await appendHistory({ upstashEnabled, upstashCmd }, historyEvents);
      selfImprovementReport = {
        diagnosis: {
          overallHitPct: diagnosis.overallHitPct,
          worstLeague: diagnosis.leagueAccuracy[0] || null,
          leagueAccuracy: diagnosis.leagueAccuracy.slice(0, 5),
          leagueAccuracyNoteJa: diagnosis.leagueAccuracyNoteJa,
          dataGaps: diagnosis.dataGaps,
          dataGapsNoteJa: diagnosis.dataGapsNoteJa,
          ineffectiveFeatures: diagnosis.ineffectiveFeatures,
          apiFailures: diagnosis.apiFailures,
        },
        proposals: proposals.map((p) => ({ targetJa: p.targetJa, proposalJa: p.proposalJa, executed: !!(p.action && applied.some((a) => a.knob === p.action.knob)) })),
        applied,
        evaluations,
        currentConfig: Object.fromEntries(Object.keys(TUNABLE_KNOBS).map((k) => [k, selfTuneConfig[k]])),
        noteJa: "AIが毎晩、自分の弱点を診断→改善を提案→安全な範囲(上下限つき・1日2件まで)で実行→数日後に改善前後を数値比較し、悪化していれば自動で差し戻します。全記録が履歴に残ります。",
      };
    } catch (e) {
      errors.push(`self_improvement_failed:${e.message}`);
    }

    const intelligenceReport = {
      date: dateKey,
      generatedAt: new Date().toISOString(),
      selfImprovement: selfImprovementReport, // 自己改善ループ(診断→提案→実行→効果測定)
      selfAssessment,                    // ⑨ 自己評価(数値の証明つき)
      engineGrowth,                      // ⑧ エンジン別成長率
      knowledgeContribution,             // ① 知識の寄与ランキング(方法論つき)
      accuracyDiagnosis,                 // ⑦ 精度低下の自己分析
      reasoningTrend: intelTrendNow,     // ③ 考察の質の推移・⑤ RAG使用率
      hypothesisStats: computeHypothesisStats(hypothesesConfirmed, hypothesesDiscarded), // 仮説的中率
      // 精度証明ラウンド: ROI(市場比較)と較正補正の状態
      roi: await getRoiTrend(intelDeps, dateKey).catch(() => ({ available: false })),
      calibration: { available: calibrationMap.available, reasonJa: calibrationMap.reasonJa || null, noteJa: calibrationMap.noteJa || null },
    };
    await upstashSetJSON(`${INTEL_REPORT_KEY_PREFIX}${dateKey}`, intelligenceReport);
    await upstashSetJSON("learn:intel:report:latest", intelligenceReport);
    await upstashCmd(["EXPIRE", `${INTEL_REPORT_KEY_PREFIX}${dateKey}`, String(120 * 86400)]).catch(() => {});

    // growthLogにも同梱して再保存する(daily-report/growth-logの両方から読めるように)。
    // 注: SETはTTLを消すため、日付つきキーは再保存の後で必ずEXPIREを付け直す。
    mergedGrowthLog.intelligence = intelligenceReport;
    mergedGrowthLog.knowledgeByCategoryToday = knowledgeByCategoryToday || mergedGrowthLog.knowledgeByCategoryToday || null;
    await upstashSetJSON(`learn:growthlog:${dateKey}`, mergedGrowthLog);
    await upstashSetJSON("learn:growthlog:latest", mergedGrowthLog);
    await upstashCmd(["EXPIRE", `learn:growthlog:${dateKey}`, String(120 * 86400)]).catch(() => {});
  } catch (e) {
    // 知能計測は日次学習の成果を壊してはいけない(ベストエフォート)。
    // ただし黙って消えると「測定していないのに測定済みに見える」ため、errorsに残す。
    mergedGrowthLog.errors = capList([...(mergedGrowthLog.errors || []), `intelligence_report_failed:${e.message}`]);
    await upstashSetJSON(`learn:growthlog:${dateKey}`, mergedGrowthLog).catch(() => {});
    await upstashSetJSON("learn:growthlog:latest", mergedGrowthLog).catch(() => {});
    await upstashCmd(["EXPIRE", `learn:growthlog:${dateKey}`, String(120 * 86400)]).catch(() => {});
  }

  return { ok: true, ...mergedGrowthLog };
}

// 「昨日の学習」ウィジェット用に、実際に採用された重み変更の履歴を人が読める
// 日本語の箇条書きに変換して添える(ご要望⑧への対応。実データからの機械的な
// 生成であり、LLMによるでっち上げではない)。重みが一度も更新されていない
// 場合は空配列を返す(「まだ検証データが足りません」も正直に区別できるよう、
// hasEnoughDataForLearningフラグも合わせて返す)。
async function getGrowthLog(deps) {
  const { upstashEnabled, upstashGetJSON, upstashCmd } = deps;
  if (!upstashEnabled) {
    return { configured: false, message: "Upstash未設定のため学習ログはまだありません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }
  const latest = await upstashGetJSON("learn:growthlog:latest");
  let learningSummary = [];
  try {
    const historyRaw = (await upstashCmd(["LRANGE", "learn:weights:history", "-10", "-1"]).catch(() => [])) || [];
    const historyEntries = historyRaw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    learningSummary = buildLearningSummary(historyEntries, 5);
  } catch (e) { /* ベストエフォート: 失敗しても成長ログ本体は返す */ }
  const totalResolvedRaw = await upstashCmd(["GET", "learn:ownpred:resolved"]).catch(() => null);
  const totalResolved = parseInt(totalResolvedRaw, 10) || 0;
  const hasEnoughDataForLearning = totalResolved >= MIN_RESOLVED_FOR_RECALIBRATION;

  // ---- 「AIの成長レポート」ウィジェット(ご要望⑦)向け: Knowledge/Prediction/
  // Memory各エンジンの累計件数。ホーム画面が読み込まれるたびに登録クラブ全件を
  // ループするのは重すぎるため(/debug.htmlの開発者向け集計とは別に)、
  // knowledgeStore.js/memoryStore.jsが保存の都度INCRしている軽量カウンターを
  // そのまま読むだけ(O(1))。失効しても減らない「累計保存件数」である点は
  // 呼び出し側(index.html)で正直にラベルする。
  const [knowledgeTotalCounterRaw, memoryTotalCounterRaw, predictionTotalCounterRaw] = await Promise.all([
    upstashCmd(["GET", "knowledge:totalItemsSavedCounter"]).catch(() => null),
    upstashCmd(["GET", "memory:totalConclusionsSavedCounter"]).catch(() => null),
    upstashCmd(["GET", "learn:ownpred:total"]).catch(() => null),
  ]);
  const engineTotals = {
    knowledgeItemsTotal: parseInt(knowledgeTotalCounterRaw, 10) || 0,
    memoryConclusionsTotal: parseInt(memoryTotalCounterRaw, 10) || 0,
    predictionsTotal: parseInt(predictionTotalCounterRaw, 10) || 0,
  };

  if (!latest) {
    return {
      configured: true, ranYet: false, message: "学習エンジンはまだ一度も実行されていません。",
      learningSummary, hasEnoughDataForLearning, totalOwnPredictionsResolvedSoFar: totalResolved,
      minResolvedForRecalibration: MIN_RESOLVED_FOR_RECALIBRATION, engineTotals,
    };
  }
  return {
    configured: true, ranYet: true, ...latest,
    learningSummary, hasEnoughDataForLearning, totalOwnPredictionsResolvedSoFar: totalResolved,
    minResolvedForRecalibration: MIN_RESOLVED_FOR_RECALIBRATION, engineTotals,
  };
}

// RAG(gatherClubKnowledge)がこのクラブに関する「学習済みの事実」を回答の根拠に
// 使えるように、Knowledge Engineに蓄積されている当該クラブの「事実」だけを
// 取り出す(Stage E以降、learn:facts:* ではなくKnowledge Engine経由に統一)。
// 後方互換のため戻り値の形は従来通り { date, statement, teamEn, ... } の配列。
async function getRecentFactsForTeam(deps, teamNameEnglish) {
  const { upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON } = deps;
  if (!upstashEnabled || !teamNameEnglish) return [];
  try {
    const knowledgeStore = createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
    const active = await knowledgeStore.getActiveKnowledge(teamNameEnglish);
    return active.facts
      .filter((f) => f.category === "recentFormTrend")
      .map((f) => ({
        date: f.firstSeenAt ? String(f.firstSeenAt).slice(0, 10) : null,
        category: f.category, type: f.type, teamEn: f.teamEn, teamJa: f.teamJa,
        statement: f.statement,
      }));
  } catch (e) {
    return [];
  }
}

module.exports = {
  runDailyLearning, getGrowthLog, getRecentFactsForTeam,
  computeFormScore, predictOutcome, backtestAccuracy, outcomeFromScore,
  DEFAULT_WEIGHTS, REGISTERED_TEAMS,
  buildReflectionText, mergeGrowthLogs,
  MIN_RESOLVED_FOR_RECALIBRATION, OWN_PRED_RECENT_KEEP, OWN_PREDICT_LOG_CAP,
  getTuningHistory,
};
