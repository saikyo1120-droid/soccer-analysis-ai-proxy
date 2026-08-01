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
 */
const { REGISTERED_TEAMS } = require("./registeredTeams");

// ---- 調整可能な上限(API-Football無料プランの1日100リクエスト枠を守るため) ----
const OWN_PREDICT_LOG_CAP = 5; // 1回の実行で新しく記録する自社予測の件数上限
const OWN_PREDICT_RESOLVE_CAP = 10; // 1回の実行で解決を試みる保留中予測の件数上限
const MIN_RESOLVED_FOR_RECALIBRATION = 10; // これ未満の検証データしかない場合は再調整しない(過学習防止)
const FORM_FACT_DELTA_THRESHOLD = 0.3; // このゲーム差分以上変化した場合だけ「事実」として記録する
const RECENT_FACTS_KEEP = 60;
const OWN_PRED_RECENT_KEEP = 30;

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

async function runDailyLearning(deps) {
  const {
    callApiFootball, resolveTeamId,
    upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON,
    now,
  } = deps;
  const nowFn = typeof now === "function" ? now : () => new Date();
  const runAt = nowFn();
  const dateKey = runAt.toISOString().slice(0, 10); // YYYY-MM-DD

  if (!upstashEnabled) {
    return { ok: false, reason: "NO_UPSTASH", message: "Upstash未設定のため学習エンジンは記録できません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }

  const errors = [];
  const factsToday = [];
  let matchesResolvedToday = 0;
  let newPredictionsLogged = 0;

  // ---- ① 登録クラブの実結果から「事実」を抽出 ----
  const teamFormCache = new Map(); // nameEn -> { teamId, currentFormScore, sampleSize }
  for (const team of REGISTERED_TEAMS) {
    try {
      const teamId = await resolveTeamId(team.nameEn);
      if (!teamId) { errors.push(`team_not_found:${team.nameEn}`); continue; }
      const data = await callApiFootball("/fixtures", { team: teamId, last: 10 });
      const fixtures = (data && data.response) || [];
      const form = computeFormScore(fixtures, teamId);
      teamFormCache.set(team.nameEn, { teamId, ...form });
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
    } catch (e) {
      errors.push(`form_failed:${team.nameEn}:${e.message}`);
    }
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
      if (!opponentForm) {
        const oppData = await callApiFootball("/fixtures", { team: opponentId, last: 10 });
        const oppFixtures = (oppData && oppData.response) || [];
        opponentForm = computeFormScore(oppFixtures, opponentId);
      }
      const homeForm = isHome ? cached || teamFormCache.get(team.nameEn) : opponentForm;
      const awayForm = isHome ? opponentForm : cached || teamFormCache.get(team.nameEn);
      const homeFormScore = (homeForm && homeForm.currentFormScore) || 0;
      const awayFormScore = (awayForm && awayForm.currentFormScore) || 0;

      const weights = (await upstashGetJSON("learn:weights")) || DEFAULT_WEIGHTS;
      const { predictedWinner } = predictOutcome(homeFormScore, awayFormScore, weights);

      const record = {
        fixtureId, homeTeamEn: isHome ? team.nameEn : opponentName, awayTeamEn: isHome ? opponentName : team.nameEn,
        homeFormScore, awayFormScore, predictedWinner,
        kickoff: fx.fixture.date, loggedAt: runAt.toISOString(),
        resolved: false, actualWinner: null, correct: null, resolvedAt: null,
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
      if (best.weights !== currentWeights && best.result.accuracy > currentBacktest.accuracy) {
        const newWeights = { ...best.weights, version: (currentWeights.version || 0) + 1, updatedAt: runAt.toISOString() };
        await upstashSetJSON("learn:weights", newWeights);
        weightsUpdated = true;
        ownAccuracyAfter = best.result.accuracy;
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: true, oldWeights: currentWeights, newWeights,
          oldAccuracy: currentBacktest.accuracy, newAccuracy: best.result.accuracy, sampleSize: currentBacktest.sampleSize,
        })]).catch(() => {});
      } else {
        await upstashCmd(["RPUSH", "learn:weights:history", JSON.stringify({
          date: dateKey, adopted: false, oldWeights: currentWeights, newWeights: null,
          oldAccuracy: currentBacktest.accuracy, newAccuracy: null, sampleSize: currentBacktest.sampleSize,
          note: "既存の重みを上回る候補が見つからなかったため更新なし",
        })]).catch(() => {});
      }
      await upstashCmd(["LTRIM", "learn:weights:history", "-30", "-1"]).catch(() => {});
    }
  }

  // ---- ⑤ 今日の知識ベース更新と成長ログ ----
  if (factsToday.length) {
    await upstashSetJSON(`learn:facts:${dateKey}`, factsToday);
    for (const f of factsToday) {
      await upstashCmd(["RPUSH", "learn:facts:recent", JSON.stringify(f)]).catch(() => {});
    }
    await upstashCmd(["LTRIM", "learn:facts:recent", String(-RECENT_FACTS_KEEP), "-1"]).catch(() => {});
  }

  const growthLog = {
    date: dateKey,
    ranAt: runAt.toISOString(),
    teamsAnalyzed: REGISTERED_TEAMS.length,
    factsAddedToday: factsToday.length,
    facts: factsToday,
    matchesResolvedToday,
    newPredictionsLogged,
    ownAccuracyBefore, ownAccuracyAfter,
    weightsUpdated,
    totalOwnPredictionsResolved: totalResolved,
    errors,
  };
  await upstashSetJSON(`learn:growthlog:${dateKey}`, growthLog);
  await upstashSetJSON("learn:growthlog:latest", growthLog);

  return { ok: true, ...growthLog };
}

async function getGrowthLog(deps) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) {
    return { configured: false, message: "Upstash未設定のため学習ログはまだありません(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)。" };
  }
  const latest = await upstashGetJSON("learn:growthlog:latest");
  if (!latest) {
    return { configured: true, ranYet: false, message: "学習エンジンはまだ一度も実行されていません。" };
  }
  return { configured: true, ranYet: true, ...latest };
}

// RAG(gatherClubKnowledge)がこのクラブに関する「学習済みの事実」を回答の根拠に
// 使えるように、直近の蓄積済みfactsから該当クラブの分だけを取り出す。
async function getRecentFactsForTeam(deps, teamNameEnglish) {
  const { upstashEnabled, upstashCmd } = deps;
  if (!upstashEnabled || !teamNameEnglish) return [];
  try {
    const raw = (await upstashCmd(["LRANGE", "learn:facts:recent", "0", "-1"])) || [];
    return raw
      .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter((f) => f && f.teamEn === teamNameEnglish);
  } catch (e) {
    return [];
  }
}

module.exports = {
  runDailyLearning, getGrowthLog, getRecentFactsForTeam,
  computeFormScore, predictOutcome, backtestAccuracy, outcomeFromScore,
  DEFAULT_WEIGHTS, REGISTERED_TEAMS,
};
