/**
 * server/learning/lineupWatch.js
 * ------------------------------------------------
 * 2026年8月19日・v57「スタメン確定ウォッチ(直前情報)」(利用者のご要望①)。
 *
 * ■ 何をするか
 *   朝の学習で立てた予想は「誰が出るか」を知らない。キックオフの
 *   約10〜70分前になった対象試合について、
 *     ①確定スタメン(/fixtures/lineups)
 *     ②直前の市場オッズ(コンセンサス優先・無ければAPI-Football 1社)
 *   を取り、学習済みの市場ブレンド比率(w)で**直前版の判定**を計算して
 *   record.preKick に記録する。画面には「⚡ 直前情報」として表示する。
 *
 * ■ 一番大事な設計判断(公平性と学習の整合性)
 *   **朝の予想(record.predictedWinner)は絶対に書き換えない。**
 *   ・対決(Beat the AI)は「利用者が朝の予想と勝負する」遊びであり、
 *     ピック後にAIの答えが変わるのは後出しと同じ(構造的に禁止)。
 *   ・的中率・学習・ストリークもすべて朝の予想で測り続ける(測る対象が
 *     途中で変わると、学習の検証が壊れる)。
 *   直前情報はあくまで「追加のレイヤー」。ただし朝版と直前版の成績は
 *   答え合わせのたびに両方採点して learn:lineupwatch:score に貯める。
 *   直前版が実測で明確に上回る日が続けば、正式採用をデータで判断できる。
 *
 * ■ 上限と作法
 *   ・きっかけは利用者のアクセス(裏で実行・応答は1msも遅らせない=方針⑥)。
 *   ・3分に1回まで・1回の実行で最大5試合・1試合の試行は最大3回。
 *   ・スタメンが未発表の回は「未確定」を正直に記録して次の回に再挑戦。
 */

const { applyMarketBlend, computeMatchProbabilitiesRaw } = require("./predictionModel");
const { namesMatch } = require("./oddsApi");

const WINDOW_MIN_MS = 10 * 60 * 1000;   // キックオフ10分前まで(それ以降は市場も締まる)
const WINDOW_MAX_MS = 70 * 60 * 1000;   // 70分前から見始める(スタメン発表は通常60分前)
const MAX_TRIES = 3;
const MAX_PER_TICK = 5;
const SCORE_KEY = "learn:lineupwatch:score"; // { n, morningBrierSum, preKickBrierSum }

/** 監視対象の抽出(純関数)。kickoffが窓内・未解決・未確定・試行3回未満。 */
function findCandidates(records, nowMs, cap) {
  const out = [];
  for (const r of records || []) {
    if (!r || r.resolved) continue;
    const ko = r.kickoff ? Date.parse(r.kickoff) : NaN;
    if (!Number.isFinite(ko)) continue;
    const until = ko - nowMs;
    if (until < WINDOW_MIN_MS || until > WINDOW_MAX_MS) continue;
    if (r.preKick && r.preKick.confirmed) continue;      // 確定済みは再取得しない
    if ((r.preKickTries || 0) >= MAX_TRIES) continue;    // 試行上限(枠の保護)
    out.push(r);
    if (out.length >= (cap || MAX_PER_TICK)) break;
  }
  return out;
}

/**
 * /fixtures/lineups の応答からスタメンを取り出す(純関数)。
 * 側の特定: チームID → チーム名(表記ゆらぎ照合) → 応答の並び、の順で決める。
 */
function extractLineups(resp, homeTeamId, awayTeamId, homeName, awayName) {
  const list = (resp && resp.response) || [];
  const shape = (entry) => (entry ? {
    formation: entry.formation || null,
    startXI: (entry.startXI || []).map((p) => p && p.player && p.player.name).filter(Boolean),
  } : null);
  const findSide = (teamId, teamName, fallbackIndex) => {
    let entry = null;
    if (Number.isFinite(teamId)) entry = list.find((x) => x && x.team && x.team.id === teamId) || null;
    if (!entry && teamName) entry = list.find((x) => x && x.team && x.team.name && namesMatch(x.team.name, teamName)) || null;
    if (!entry && !Number.isFinite(teamId) && !teamName) entry = list[fallbackIndex] || null;
    return shape(entry);
  };
  const home = findSide(homeTeamId, homeName, 0);
  const away = findSide(awayTeamId, awayName, 1);
  const available = !!(home && home.startXI.length >= 7 && away && away.startXI.length >= 7);
  return { available, home, away };
}

/**
 * 直前情報レイヤーを組み立てる(純関数)。
 * 何も新しい材料が無ければ null(空のレイヤーは書かない)。
 * 朝の予想には一切触れない。
 */
function buildPreKick({ record, lineups, freshImplied, oddsSource, nowMs }) {
  const hasLineups = !!(lineups && lineups.available);
  const hasMarket = !!(freshImplied && Number.isFinite(freshImplied.homePct));
  if (!hasLineups && !hasMarket) return null;
  const w = record && record.weightsSnapshot && Number.isFinite(record.weightsSnapshot.marketBlend)
    ? record.weightsSnapshot.marketBlend : 0;
  const rho = record && record.weightsSnapshot && Number.isFinite(record.weightsSnapshot.rho)
    ? record.weightsSnapshot.rho : 0;
  let blended = null;
  if (hasMarket && w > 0 && Number.isFinite(record.homeLambda) && Number.isFinite(record.awayLambda)) {
    const b = applyMarketBlend(record.homeLambda, record.awayLambda, rho, freshImplied, w);
    if (b && b.blendUsed) {
      blended = {
        predictedWinner: b.predictedWinner,
        probsPct: {
          homeWinPct: Math.round(b.probs.home * 100),
          drawPct: Math.round(b.probs.draw * 100),
          awayWinPct: Math.round(b.probs.away * 100),
        },
        marketPct: b.blendUsed.marketPct,
        aiPct: b.blendUsed.aiPct,
        changedFromMorning: b.predictedWinner !== record.predictedWinner,
      };
    }
  }
  return {
    at: new Date(nowMs).toISOString(),
    confirmed: hasLineups,
    formations: hasLineups ? { home: lineups.home.formation, away: lineups.away.formation } : null,
    startXICount: hasLineups ? { home: lineups.home.startXI.length, away: lineups.away.startXI.length } : null,
    marketImplied: hasMarket ? freshImplied : null,
    oddsSource: hasMarket ? (oddsSource || null) : null,
    blended, // 学習済みブレンドで再計算した直前版の判定(w=0の環境ではnull)
    noteJa: hasLineups
      ? "スタメン確定後の市場オッズで再計算した参考判定です。公式の予想(対決・的中率の対象)は朝の予想のまま変わりません。"
      : "スタメンはまだ未発表です(直前の市場オッズのみ更新)。公式の予想は朝の予想のまま変わりません。",
  };
}

/** 答え合わせ時: 朝版と直前版のBrierを両方採点する(直前版が無い記録はnull)。 */
function scoreResolvedPreKick(record) {
  if (!record || !record.resolved || !record.actualWinner) return null;
  const pk = record.preKick;
  if (!pk || !pk.blended || !pk.blended.probsPct) return null;
  if (!Number.isFinite(record.homeLambda) || !Number.isFinite(record.awayLambda)) return null;
  const rho = record.weightsSnapshot && Number.isFinite(record.weightsSnapshot.rho) ? record.weightsSnapshot.rho : 0;
  // 朝版: 記録済みのλ+当時のブレンド(blendUsed)そのまま。ブレンド無しなら生モデル確率
  let morning;
  if (record.blendUsed && record.marketImplied && Number.isFinite(record.blendUsed.w)) {
    const b = applyMarketBlend(record.homeLambda, record.awayLambda, rho, record.marketImplied, record.blendUsed.w);
    morning = b.probs;
  } else {
    const p = computeMatchProbabilitiesRaw(record.homeLambda, record.awayLambda, undefined, rho);
    morning = { home: p.homeWin, draw: p.draw, away: p.awayWin };
  }
  const pre = {
    home: pk.blended.probsPct.homeWinPct / 100,
    draw: pk.blended.probsPct.drawPct / 100,
    away: pk.blended.probsPct.awayWinPct / 100,
  };
  const brier = (probs) => ["home", "draw", "away"].reduce((sum, o) => {
    const actual = record.actualWinner === o ? 1 : 0;
    const p = Number.isFinite(probs[o]) ? probs[o] : 1 / 3;
    return sum + Math.pow(p - actual, 2);
  }, 0);
  return { morningBrier: brier(morning), preKickBrier: brier(pre) };
}

module.exports = {
  WINDOW_MIN_MS, WINDOW_MAX_MS, MAX_TRIES, MAX_PER_TICK, SCORE_KEY,
  findCandidates, extractLineups, buildPreKick, scoreResolvedPreKick,
};
