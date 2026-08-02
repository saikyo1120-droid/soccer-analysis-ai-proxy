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
const {
  computeGoalRateFeatures, computeFatigueFeature,
  fetchInjuryCountFeature, fetchStandingsFeature, fetchHeadToHeadFeature,
  inferLeagueIdFromFixtures, computeHomeAwaySplit,
} = require("./features");
const {
  EXTENDED_DEFAULT_WEIGHTS, computeMatchFeatures, predictOutcomeV2,
  computeFactorImportance, backtestAccuracyV2, fitWeightsGradientDescent,
  buildLearningSummary,
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
function buildReflectionText(record, weightsUsed) {
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

  const why = `予想は${outcomeLabelJa(record ? record.predictedWinner : null)}でしたが、実際は${outcomeLabelJa(record ? record.actualWinner : null)}でした。` +
    (weighted.length
      ? `モデルが重視していた要素(${weighted.map((i) => i.labelJa).join("、")})だけでは、この結果を十分に説明できませんでした。`
      : `この予測の時点ではモデルがどの特徴量も強く重視していなかった(学習データがまだ少ない)ため、精度が低い状態でした。`);
  const improvement = "スタメン発表・直前の怪我人情報・監督采配など、現在のモデルにまだ組み込まれていない要因が結果に影響した可能性があります。継続してデータを蓄積し、重みの再学習で改善を試みます。";
  return { why, improvement };
}

async function runDailyLearning(deps) {
  const {
    callApiFootball, resolveTeamId,
    upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON,
    now, generateLLM,
  } = deps;
  const nowFn = typeof now === "function" ? now : () => new Date();
  const runAt = nowFn();
  const dateKey = runAt.toISOString().slice(0, 10); // YYYY-MM-DD

  if (!upstashEnabled) {
    return { ok: false, reason: "NO_UPSTASH", message: "Upstash未設定のため学習エンジンは記録できません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }

  const knowledgeStore = createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
  const memoryStore = createMemoryStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON });
  const relationshipIndex = createRelationshipIndex({ upstashEnabled, upstashGetJSON, upstashSetJSON });
  const clubProfileEngine = createClubProfileEngine({ generateLLM, knowledgeStore, setRelation: relationshipIndex.setRelation });

  const errors = [];
  const factsToday = [];
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
          '出力は次のJSON形式のみ: {"view": "...", "changeReason": "..."}(変化が無い、または前回の見解が無い場合はchangeReasonは空文字列でよい)',
        ].join("\n");
        const userPrompt = [
          `クラブ: ${team.nameJa}`,
          `今日の実データ:\n${factsBlock}`,
          previous ? `前回(${previous.computedAt})の見解: ${previous.statement}` : "前回の見解: (まだありません)",
        ].join("\n\n");
        const { text } = await generateLLM({ systemPrompt, userPrompt, maxTokens: 200 });
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
      } catch (e) {
        errors.push(`daily_view_failed:${team.nameEn}:${e.code || e.message}`);
      }
    }
  } else {
    llmSkippedReasons.push("LLM_NOT_CONFIGURED");
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
        const reflection = buildReflectionText(record, record.weightsSnapshot);
        const outcomeLabelJa = (w) => (w === "home" ? "ホーム勝利" : w === "away" ? "アウェイ勝利" : "引き分け");
        const statement = [
          `【振り返り】${record.homeTeamEn} vs ${record.awayTeamEn}`,
          `予想: ${outcomeLabelJa(record.predictedWinner)} / 結果: ${outcomeLabelJa(record.actualWinner)}(${record.correct ? "的中" : "不的中"})`,
          `理由: ${reflection.why}`,
          `改善点: ${reflection.improvement}`,
        ].join(" ");
        await knowledgeStore.saveKnowledgeItem({
          teamEn: record.originTeamEn || record.homeTeamEn, category: "matchReflection", type: "reflection",
          statement, detail: { predicted: record.predictedWinner, actual: record.actualWinner, correct: record.correct, ...reflection },
          computedAt: runAt.toISOString(), source: "試合結果と予測時点の特徴量・重みから機械的に生成(LLM不使用)",
        });
        reflectionsSaved++;
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
      const homeCtx = {
        formScore: homeFormScore, avgGoalsFor: homeForm.avgGoalsFor, avgGoalsAgainst: homeForm.avgGoalsAgainst,
        injuryCount: homeInjuries.injuryCount, pointsPerGame: homeStandings.played ? (homeStandings.points / homeStandings.played) : null,
        matchesLast7Days: homeForm.matchesLast7Days,
      };
      const awayCtx = {
        formScore: awayFormScore, avgGoalsFor: awayForm.avgGoalsFor, avgGoalsAgainst: awayForm.avgGoalsAgainst,
        injuryCount: awayInjuries.injuryCount, pointsPerGame: awayStandings.played ? (awayStandings.points / awayStandings.played) : null,
        matchesLast7Days: awayForm.matchesLast7Days,
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

  const growthLog = {
    date: dateKey,
    ranAt: runAt.toISOString(),
    teamsAnalyzed: REGISTERED_TEAMS.length,
    factsAddedToday: factsToday.length,
    facts: factsToday,
    knowledgeItemsSavedToday, knowledgeItemsDuplicateToday,
    matchesResolvedToday,
    newPredictionsLogged,
    hypothesesConfirmed, hypothesesDiscarded,
    reflectionsSaved, // Layer4: 当たり/外れ問わず保存した振り返りの件数
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
  await upstashSetJSON(`learn:growthlog:${dateKey}`, growthLog);
  await upstashSetJSON("learn:growthlog:latest", growthLog);

  return { ok: true, ...growthLog };
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
  if (!latest) {
    return {
      configured: true, ranYet: false, message: "学習エンジンはまだ一度も実行されていません。",
      learningSummary, hasEnoughDataForLearning, totalOwnPredictionsResolvedSoFar: totalResolved,
      minResolvedForRecalibration: MIN_RESOLVED_FOR_RECALIBRATION,
    };
  }
  return {
    configured: true, ranYet: true, ...latest,
    learningSummary, hasEnoughDataForLearning, totalOwnPredictionsResolvedSoFar: totalResolved,
    minResolvedForRecalibration: MIN_RESOLVED_FOR_RECALIBRATION,
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
  buildReflectionText,
  MIN_RESOLVED_FOR_RECALIBRATION, OWN_PRED_RECENT_KEEP,
};
