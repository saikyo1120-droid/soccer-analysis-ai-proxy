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
const { createApiBudget, DEFAULT_DAILY_BUDGET, DEFAULT_USER_RESERVE } = require("./apiBudget");
const { buildDailySnapshot, saveDailyMetrics } = require("./dailyMetrics");
const {
  computeGoalRateFeatures, computeFatigueFeature,
  fetchInjuryCountFeature, fetchStandingsFeature, fetchHeadToHeadFeature,
  inferLeagueIdFromFixtures, computeHomeAwaySplit, fetchCoachCareer,
} = require("./features");
const {
  EXTENDED_DEFAULT_WEIGHTS, computeMatchFeatures, predictOutcomeV2,
  computeFactorImportance, backtestAccuracyV2, fitWeightsGradientDescent,
  buildLearningSummary, classifyFailureReasons, summarizeFailureReasons,
  classifySuccessReasons, summarizeSuccessReasons,
} = require("./predictionModel");

// ---- 調整可能な上限(API-Football無料プランの1日100リクエスト枠を守るため) ----
const OWN_PREDICT_LOG_CAP = 5; // 1回の実行で新しく記録する自社予測の件数上限
const OWN_PREDICT_RESOLVE_CAP = 10; // 1回の実行で解決を試みる保留中予測の件数上限
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
    aiViewsChanged: sum(previous.aiViewsChanged, current.aiViewsChanged),
    aiViewsUnchanged: sum(previous.aiViewsUnchanged, current.aiViewsUnchanged),
    failureReasonsToday: [...(previous.failureReasonsToday || []), ...(current.failureReasonsToday || [])],
    successReasonsToday: [...(previous.successReasonsToday || []), ...(current.successReasonsToday || [])],
    llmSkippedReasons: Array.from(new Set([...(previous.llmSkippedReasons || []), ...(current.llmSkippedReasons || [])])),
    errors: [...(previous.errors || []), ...(current.errors || [])],
  };
}

async function runDailyLearning(deps) {
  const {
    callApiFootball, resolveTeamId,
    upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON,
    now, generateLLM, getApiPlanInfo,
  } = deps;
  const nowFn = typeof now === "function" ? now : () => new Date();
  const runAt = nowFn();
  const dateKey = runAt.toISOString().slice(0, 10); // YYYY-MM-DD
  // 2026年8月・完全自動Learning Cycle ⑧「Learning Time」: 学習にかかった実時間を計測する。
  const learningStartedAtMs = Date.now();

  if (!upstashEnabled) {
    return { ok: false, reason: "NO_UPSTASH", message: "Upstash未設定のため学習エンジンは記録できません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }

  const knowledgeStore = createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
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
  const apiBudget = createApiBudget({
    upstashEnabled, upstashGetJSON, upstashSetJSON,
    dailyBudget: effectiveDailyBudget,
    userReserve: Number(process.env.API_USER_RESERVE) || DEFAULT_USER_RESERVE,
  });
  await apiBudget.init(dateKey);
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
  let reflectionsSaved = 0; // Layer4: 当たり/外れ問わず「振り返り」を保存した件数
  let profilesGenerated = 0; // Layer2: 新しく生成した固定知識(クラブプロフィール)の件数
  let aiViewsChanged = 0; // Layer3: 前日から見解が変わったクラブの件数
  let aiViewsUnchanged = 0;
  const llmSkippedReasons = [];

  // ---- ① 登録クラブの実結果から「事実」を抽出(Layer1)+ v2特徴量の下地を計算 ----
  const teamFormCache = new Map(); // nameEn -> { teamId, currentFormScore, sampleSize, avgGoalsFor, avgGoalsAgainst, matchesLast7Days, fixtures }
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
            await knowledgeStore.saveKnowledgeItem({
              teamEn: team.nameEn, teamJa: team.nameJa, category: "coachChange", type: "fact",
              statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/coachs)",
            });
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
          const saveResult = await knowledgeStore.saveKnowledgeItem({
            teamEn: team.nameEn, teamJa: team.nameJa, category: "transferImpact", type: "fact",
            statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/transfers)",
          });
          if (saveResult.saved) {
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
  const pendingIds = (await upstashCmd(["LRANGE", "learn:ownpred:pending", "0", String(OWN_PREDICT_RESOLVE_CAP - 1)]).catch(() => [])) || [];
  for (const fixtureIdStr of pendingIds) {
    try {
      const record = await upstashGetJSON(`learn:ownpred:${fixtureIdStr}`);
      if (!record || record.resolved) { await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {}); continue; }
      const data = await callApiFootball("/fixtures", { id: fixtureIdStr });
      const fx = (data && data.response && data.response[0]) || null;
      if (!fx || !fx.fixture || fx.fixture.status.short !== "FT") continue; // まだ終わっていない
      const actualWinner = outcomeFromScore(fx.goals.home, fx.goals.away);
      if (!actualWinner) continue;
      record.resolved = true;
      record.actualWinner = actualWinner;
      record.correct = actualWinner === record.predictedWinner;
      record.resolvedAt = runAt.toISOString();

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
      await upstashSetJSON(`learn:ownpred:${fixtureIdStr}`, record);
      await upstashCmd(["LREM", "learn:ownpred:pending", "0", fixtureIdStr]).catch(() => {});
      await upstashCmd(["INCR", "learn:ownpred:resolved"]).catch(() => {});
      if (record.correct) await upstashCmd(["INCR", "learn:ownpred:correct"]).catch(() => {});
      await upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(record)]).catch(() => {});
      await upstashCmd(["LTRIM", "learn:ownpred:recent", String(-OWN_PRED_RECENT_KEEP), "-1"]).catch(() => {});
      matchesResolvedToday++;

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
        const statement = [
          `【振り返り】${record.homeTeamEn} vs ${record.awayTeamEn}`,
          `予想: ${outcomeLabelJa(record.predictedWinner)} / 結果: ${outcomeLabelJa(record.actualWinner)}(${record.correct ? "的中" : "不的中"})`,
          `理由: ${reflection.why}`,
          `改善点: ${reflection.improvement}`,
        ].join(" ");
        await knowledgeStore.saveKnowledgeItem({
          teamEn: record.originTeamEn || record.homeTeamEn, category: "matchReflection", type: "reflection",
          statement, detail: { predicted: record.predictedWinner, actual: record.actualWinner, correct: record.correct, failureReasons, ...reflection },
          computedAt: runAt.toISOString(), source: "試合結果と予測時点の特徴量・重みから機械的に生成(LLM不使用)",
        });
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

  // ---- ③ 登録クラブの直近の試合について、新しく自社予測を立てる ----
  // 日付ベースでどのクラブから調べ始めるかをずらし、特定のクラブだけ毎回
  // リクエストが偏らないようにする(単純なローテーション)。
  const startOffset = Math.abs(dateKey.split("-").join("") % REGISTERED_TEAMS.length) || 0;
  const rotated = REGISTERED_TEAMS.slice(startOffset).concat(REGISTERED_TEAMS.slice(0, startOffset));
  for (const team of rotated) {
    if (newPredictionsLogged >= OWN_PREDICT_LOG_CAP) break;
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
      let opponentForm = teamFormCache.get(opponentName);
      let opponentFixtures = null;
      if (!opponentForm) {
        const oppData = await callApiFootball("/fixtures", { team: opponentId, last: 10 });
        opponentFixtures = (oppData && oppData.response) || [];
        const form = computeFormScore(opponentFixtures, opponentId);
        const goalRates = computeGoalRateFeatures(opponentFixtures, opponentId);
        const fatigue = computeFatigueFeature(opponentFixtures, runAt.getTime());
        opponentForm = { teamId: opponentId, ...form, ...goalRates, ...fatigue, fixtures: opponentFixtures };
      }
      const homeForm = isHome ? cached || teamFormCache.get(team.nameEn) : opponentForm;
      const awayForm = isHome ? opponentForm : cached || teamFormCache.get(team.nameEn);
      const homeFormScore = (homeForm && homeForm.currentFormScore) || 0;
      const awayFormScore = (awayForm && awayForm.currentFormScore) || 0;

      // ---- Prediction Engine v2: 追加特徴量(怪我人・順位・過去対戦)を取得する ----
      // このループはOWN_PREDICT_LOG_CAP(既定5)件/回に絞られているため、ここで
      // 追加のAPI呼び出しが発生してもAPI-Footballの利用上限への影響は限定的。
      const homeTeamId = homeForm.teamId;
      const awayTeamId = awayForm.teamId;
      const homeFixturesForLeague = homeForm.fixtures || [];
      const leagueId = inferLeagueIdFromFixtures(homeFixturesForLeague) || inferLeagueIdFromFixtures(awayForm.fixtures || []);
      const season = new Date(runAt).getUTCMonth() + 1 >= 7 ? runAt.getUTCFullYear() : runAt.getUTCFullYear() - 1;
      const [homeInjuries, awayInjuries, homeStandings, awayStandings, h2h] = await Promise.all([
        fetchInjuryCountFeature(homeTeamId, season, callApiFootball),
        fetchInjuryCountFeature(awayTeamId, season, callApiFootball),
        fetchStandingsFeature(leagueId, season, homeTeamId, callApiFootball),
        fetchStandingsFeature(leagueId, season, awayTeamId, callApiFootball),
        fetchHeadToHeadFeature(homeTeamId, awayTeamId, callApiFootball),
      ]);
      // ---- 2026年8月・優先順位②: Proプラン移行に伴う特徴量の拡張 ----
      // 追加のAPI呼び出しを一切増やさずに使える情報を、まず確実に取り込む。
      //   ・ホーム/アウェイ別の成績 … 既に取得済みのfixtures(直近10試合)から算出
      //   ・出場停止者数           … 既に取得済みの/injuriesのレスポンスから算出
      //     (computeInjuryCountFeatureは以前からsuspendedPlayersを分離していたが、
      //      予測モデルには渡されておらず、負傷者と一緒くたにされていた)
      const homeSplit = computeHomeAwaySplit(homeForm.fixtures || [], homeTeamId);
      const awaySplit = computeHomeAwaySplit(awayForm.fixtures || [], awayTeamId);
      const homeCtx = {
        formScore: homeFormScore, avgGoalsFor: homeForm.avgGoalsFor, avgGoalsAgainst: homeForm.avgGoalsAgainst,
        injuryCount: homeInjuries.injuryCount, pointsPerGame: homeStandings.played ? (homeStandings.points / homeStandings.played) : null,
        matchesLast7Days: homeForm.matchesLast7Days,
        // ホームチームは「ホームでの勝率」で評価する(会場を区別しないformScoreとは別の情報)
        homeVenueWinRate: homeSplit.home.winRate,
        suspensionCount: (homeInjuries.suspendedPlayers || []).length,
        xgNet: homeForm.xgNet ?? null,
        topScorerGoals: homeForm.topScorerGoals ?? null,
      };
      const awayCtx = {
        formScore: awayFormScore, avgGoalsFor: awayForm.avgGoalsFor, avgGoalsAgainst: awayForm.avgGoalsAgainst,
        injuryCount: awayInjuries.injuryCount, pointsPerGame: awayStandings.played ? (awayStandings.points / awayStandings.played) : null,
        matchesLast7Days: awayForm.matchesLast7Days,
        // アウェイチームは「アウェイでの勝率」で評価する
        awayVenueWinRate: awaySplit.away.winRate,
        suspensionCount: (awayInjuries.suspendedPlayers || []).length,
        xgNet: awayForm.xgNet ?? null,
        topScorerGoals: awayForm.topScorerGoals ?? null,
      };
      const features = computeMatchFeatures(homeCtx, awayCtx, h2h);

      const storedWeightsRaw = (await upstashGetJSON("learn:weights")) || {};
      const weights = { ...EXTENDED_DEFAULT_WEIGHTS, ...storedWeightsRaw }; // 過去バージョンの重みにも新しいキーを補完
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

      const record = {
        fixtureId, homeTeamEn: isHome ? team.nameEn : opponentName, awayTeamEn: isHome ? opponentName : team.nameEn,
        homeFormScore, awayFormScore, predictedWinner, // v1互換フィールド(既存のバックテスト・テストとの互換性のため維持)
        homeLambda, awayLambda, features, weightsSnapshot: weights, factorImportance: importance,
        kickoff: fx.fixture.date, loggedAt: runAt.toISOString(),
        resolved: false, actualWinner: null, correct: null, resolvedAt: null,
        originTeamEn: team.nameEn, stateHypothesis,
      };
      await upstashSetJSON(`learn:ownpred:${fixtureId}`, record);
      await upstashCmd(["RPUSH", "learn:ownpred:pending", String(fixtureId)]).catch(() => {});
      await upstashCmd(["INCR", "learn:ownpred:total"]).catch(() => {});
      newPredictionsLogged++;
    } catch (e) {
      errors.push(`predict_failed:${team.nameEn}:${e.message}`);
    }
  }

  // ---- ④ 十分な検証データが溜まっていれば、モデルの重みを再調整する ----
  const totalResolvedRaw = await upstashCmd(["GET", "learn:ownpred:resolved"]).catch(() => null);
  const totalCorrectRaw = await upstashCmd(["GET", "learn:ownpred:correct"]).catch(() => null);
  const totalResolved = parseInt(totalResolvedRaw, 10) || 0;
  const totalCorrect = parseInt(totalCorrectRaw, 10) || 0;
  const ownAccuracyBefore = totalResolved > 0 ? Math.round((totalCorrect / totalResolved) * 1000) / 10 : null;
  let weightsUpdated = false;
  let ownAccuracyAfter = ownAccuracyBefore;
  let weightsUpdatedV2 = false; // Prediction Engine v2(拡張特徴量)の重みが更新されたか
  let v2AccuracyBefore = null;
  let v2AccuracyAfter = null;

  if (totalResolved >= MIN_RESOLVED_FOR_RECALIBRATION) {
    const recentRaw = (await upstashCmd(["LRANGE", "learn:ownpred:recent", "0", "-1"]).catch(() => [])) || [];
    const recentRecords = recentRaw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    const currentWeights = (await upstashGetJSON("learn:weights")) || DEFAULT_WEIGHTS;
    const currentBacktest = backtestAccuracy(recentRecords, currentWeights);
    if (currentBacktest) {
      // 実データに対する簡単な近傍探索(グリッドサーチ)。ディープラーニングではなく、
      // 「今の重みの近くを少しだけ振ってみて、実データで的中率が上がるか試す」だけの
      // 単純で説明可能な調整。
      const candidates = [
        currentWeights,
        { ...currentWeights, sensitivity: currentWeights.sensitivity * 1.2 },
        { ...currentWeights, sensitivity: currentWeights.sensitivity * 0.8 },
        { ...currentWeights, homeBase: currentWeights.homeBase + 0.1 },
        { ...currentWeights, homeBase: Math.max(0.8, currentWeights.homeBase - 0.1) },
      ];
      let best = { weights: currentWeights, result: currentBacktest };
      for (const cand of candidates) {
        const result = backtestAccuracy(recentRecords, cand);
        if (result && result.accuracy > best.result.accuracy) best = { weights: cand, result };
      }
      let weightsAfterV1 = currentWeights;
      if (best.weights !== currentWeights && best.result.accuracy > currentBacktest.accuracy) {
        const newWeights = { ...best.weights, version: (currentWeights.version || 0) + 1, updatedAt: runAt.toISOString() };
        await upstashSetJSON("learn:weights", newWeights);
        weightsUpdated = true;
        ownAccuracyAfter = best.result.accuracy;
        weightsAfterV1 = newWeights;
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: true, method: "grid_search_v1", oldWeights: currentWeights, newWeights,
          oldAccuracy: currentBacktest.accuracy, newAccuracy: best.result.accuracy, sampleSize: currentBacktest.sampleSize,
        })]).catch(() => {});
      } else {
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: false, method: "grid_search_v1", oldWeights: currentWeights, newWeights: null,
          oldAccuracy: currentBacktest.accuracy, newAccuracy: null, sampleSize: currentBacktest.sampleSize,
          note: "既存の重みを上回る候補が見つからなかったため更新なし",
        })]).catch(() => {});
      }

      // ---- ④-b Prediction Engine v2: 拡張特徴量(怪我人・順位・過去対戦・過密日程等)の
      // 重要度を、数値微分による勾配降下法で学習する(server/learning/predictionModel.js)。
      // v1のグリッドサーチ(上記)とは独立して動く。record.featuresを持つ「新形式」の
      // レコードがまだ無い/少ないうち(移行期間中)は自動的にスキップされる
      // (backtestAccuracyV2がfeatures無しレコードを除外するため)。
      const extendedCurrentWeights = { ...EXTENDED_DEFAULT_WEIGHTS, ...weightsAfterV1 };
      const v2Backtest = backtestAccuracyV2(recentRecords, extendedCurrentWeights);
      if (v2Backtest && v2Backtest.sampleSize >= 5) {
        const fitted = fitWeightsGradientDescent(recentRecords, extendedCurrentWeights);
        if (fitted) {
          const fittedBacktest = backtestAccuracyV2(recentRecords, fitted);
          if (fittedBacktest && fittedBacktest.accuracy > v2Backtest.accuracy) {
            const newExtendedWeights = { ...fitted, version: (extendedCurrentWeights.version || 0) + 1, updatedAt: runAt.toISOString() };
            await upstashSetJSON("learn:weights", newExtendedWeights);
            weightsUpdatedV2 = true;
            v2AccuracyBefore = v2Backtest.accuracy;
            v2AccuracyAfter = fittedBacktest.accuracy;
            await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
              date: dateKey, adopted: true, method: "gradient_descent_v2", oldWeights: extendedCurrentWeights, newWeights: newExtendedWeights,
              oldAccuracy: v2Backtest.accuracy, newAccuracy: fittedBacktest.accuracy, sampleSize: v2Backtest.sampleSize,
            })]).catch(() => {});
          } else {
            v2AccuracyBefore = v2Backtest.accuracy;
            v2AccuracyAfter = v2Backtest.accuracy;
            await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
              date: dateKey, adopted: false, method: "gradient_descent_v2", oldWeights: extendedCurrentWeights, newWeights: null,
              oldAccuracy: v2Backtest.accuracy, newAccuracy: fittedBacktest ? fittedBacktest.accuracy : null, sampleSize: v2Backtest.sampleSize,
              note: "拡張特徴量での学習を試みたが、既存の重みを上回らなかったため更新なし",
            })]).catch(() => {});
          }
        }
      }
      await upstashCmd(["LTRIM", "learn:weights:history", "-30", "-1"]).catch(() => {});
    }
  }

  // ---- ⑤ 今日の知識ベース更新と成長ログ ----
  // Stage E以降: 「事実」の保存先はKnowledge Engine(knowledgeStore.js)に一本化。
  // 重複した内容(前日と全く同じ事実)は正直に「重複」として扱われ、二重に
  // カウントしない(knowledgeStore.jsのハッシュベース重複排除による)。
  let knowledgeItemsSavedToday = 0;
  let knowledgeItemsDuplicateToday = 0;
  for (const f of factsToday) {
    try {
      const saveResult = await knowledgeStore.saveKnowledgeItem({
        teamEn: f.teamEn, teamJa: f.teamJa, category: "recentFormTrend", type: "fact",
        statement: f.statement, computedAt: runAt.toISOString(),
      });
      if (saveResult.saved) knowledgeItemsSavedToday++;
      else if (saveResult.reason === "DUPLICATE") knowledgeItemsDuplicateToday++;
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
  try {
    const recentForFailuresRaw = (await upstashCmd(["LRANGE", "learn:ownpred:recent", "0", "-1"]).catch(() => [])) || [];
    const recentForFailures = recentForFailuresRaw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    topFailureReasonsRecent = summarizeFailureReasons(recentForFailures, 5);
    topSuccessReasonsRecent = summarizeSuccessReasons(recentForFailures, 5);
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
    apiBudget: { ...apiBudget.summary(), sourceJa: budgetSourceJa, detectedPlan: detectedPlan || null },
    matchesResolvedToday,
    newPredictionsLogged,
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
    errors,
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

  // 2026年8月・完全自動Learning Cycle ⑧「毎日賢くなっていることを証明する」:
  // 日をまたいで比較できる軽量な指標だけを別キーに保存する。growthLogは項目が
  // 多く増減が読み取りにくいため、比較専用のスナップショットを分けている。
  const metricsSnapshot = buildDailySnapshot(mergedGrowthLog, {
    learningDurationMs: Date.now() - learningStartedAtMs,
  });
  await saveDailyMetrics({ upstashEnabled, upstashSetJSON }, metricsSnapshot);

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
  MIN_RESOLVED_FOR_RECALIBRATION, OWN_PRED_RECENT_KEEP,
};
