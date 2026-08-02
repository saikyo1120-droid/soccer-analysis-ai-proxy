/**
 * server/learning/features.js
 * ------------------------------------------------
 * Prediction Engine(自社予測モデル)の特徴量(feature)を計算するモジュール。
 *
 * これまでの予測モデルは「ホームアドバンテージ」と「直近フォームの得失点差」
 * だけを使っていた(server/learning/dailyJob.jsのcomputeFormScore/predictOutcome)。
 * ここでは、ご要望に基づき「実際にAPI-Footballから取得できる」特徴量を追加する。
 *
 * 正直な範囲(重要): ご要望にあった項目のうち、次のものはこのラウンドでは
 * 実装していない(理由と代替案はREADME/納品メッセージに明記):
 *   - スタメン(先発メンバー): キックオフの約1時間前にならないと確定しないため、
 *     「1日1回のバッチ処理」という現在のLearning Engineの実行方式と原理的に
 *     噛み合わない(試合当日の早い時間に予測を作るため、その時点ではまだ
 *     スタメンが発表されていない)。
 *   - 移籍の試合への影響度: API-Footballの/transfersは移籍の記録はあるが
 *     「その移籍が今の実力にどれだけ影響しているか」を表す数値ではないため、
 *     安易に数値化すると根拠のない特徴量になってしまう。
 *   - 監督交代後の成績: 「いつ監督が交代したか」を確実に取れるクリーンな
 *     フィールドがAPI-Footballに無く、/fixtures/lineupsのcoach名の変化を
 *     日々突き合わせるような複雑な検出ロジックが必要になるため今回は見送り。
 *   - ローテーション(疲労による選手起用の変化): スタメンと同じ理由で保留。
 *     代わりに「直近の試合間隔(過密日程かどうか)」を疲労の代理指標として
 *     採用した(下記 computeFatigueFeature)。
 *
 * 実装した特徴量(すべて実データから計算。AIの推測は混ぜない):
 *   - computeGoalRateFeatures: 直近試合の平均得点・平均失点(既に取得済みの
 *     fixturesデータから追加のAPI呼び出しなしで計算できる)
 *   - computeFatigueFeature: 直近7日以内の試合数(過密日程の代理指標)
 *   - fetchInjuryCountFeature: 現在の負傷者数(/injuries)
 *   - fetchStandingsFeature: 現在の順位・勝点(/standings)
 *   - fetchHeadToHeadFeature: 過去の直接対戦成績(/fixtures/headtohead)
 */

// ---- 純粋関数(すでに取得済みのデータから計算するもの。追加のAPI呼び出し無し) ----

function computeGoalRateFeatures(fixtures, teamId) {
  const withGoals = (fixtures || []).filter(
    (f) => f && f.fixture && f.goals && f.goals.home !== null && f.goals.home !== undefined && f.goals.away !== null && f.goals.away !== undefined
  );
  if (!withGoals.length) return { avgGoalsFor: null, avgGoalsAgainst: null, sampleSize: 0 };
  let gf = 0;
  let ga = 0;
  for (const f of withGoals) {
    const isHome = f.teams && f.teams.home && f.teams.home.id === teamId;
    gf += isHome ? f.goals.home : f.goals.away;
    ga += isHome ? f.goals.away : f.goals.home;
  }
  return {
    avgGoalsFor: Math.round((gf / withGoals.length) * 100) / 100,
    avgGoalsAgainst: Math.round((ga / withGoals.length) * 100) / 100,
    sampleSize: withGoals.length,
  };
}

// 直近7日以内に行われた試合数を「過密日程(疲労の代理指標)」として使う。
// referenceDateMsを起点に、過去7日以内のfixtureをカウントする。
function computeFatigueFeature(fixtures, referenceDateMs) {
  const refMs = referenceDateMs || Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const recentCount = (fixtures || []).filter((f) => {
    const d = f && f.fixture && f.fixture.date ? new Date(f.fixture.date).getTime() : null;
    return d !== null && !Number.isNaN(d) && d < refMs && refMs - d <= sevenDaysMs;
  }).length;
  return { matchesLast7Days: recentCount };
}

function computeInjuryCountFeature(injuriesResponse) {
  const list = injuriesResponse || [];
  const names = new Set();
  for (const r of list) {
    const name = r && r.player && r.player.name;
    if (name) names.add(name);
  }
  return { injuryCount: names.size };
}

// API-Footballの/standingsは大会によって配列がグループ分けされてネストする
// ことがあるため(例: グループステージ)、フラット化してから対象チームを探す。
function computeStandingsFeature(standingsResponse, teamId) {
  const empty = { position: null, points: null, played: null, goalsForAvg: null, goalsAgainstAvg: null };
  const leagues = (standingsResponse || []).map((r) => r.league).filter(Boolean);
  for (const league of leagues) {
    const groups = league.standings || [];
    const flat = groups.reduce((acc, g) => acc.concat(Array.isArray(g) ? g : [g]), []);
    const row = flat.find((r) => r && r.team && r.team.id === teamId);
    if (row) {
      const played = row.all && row.all.played;
      const goalsFor = row.all && row.all.goals && row.all.goals.for;
      const goalsAgainst = row.all && row.all.goals && row.all.goals.against;
      return {
        position: row.rank ?? null,
        points: row.points ?? null,
        played: played ?? null,
        goalsForAvg: played ? Math.round((goalsFor / played) * 100) / 100 : null,
        goalsAgainstAvg: played ? Math.round((goalsAgainst / played) * 100) / 100 : null,
      };
    }
  }
  return empty;
}

// 過去の直接対戦(head-to-head)成績から、ホーム側チームの勝率を返す
// (homeTeamIdは「今回の試合でホームになる側」であり、過去の対戦では
// 必ずしもホームだったとは限らない点に注意=ここでは「勝敗数」のみを見る)。
function computeHeadToHeadFeature(h2hFixtures, homeTeamId, awayTeamId) {
  const list = (h2hFixtures || []).filter(
    (f) => f && f.goals && f.goals.home !== null && f.goals.home !== undefined && f.goals.away !== null && f.goals.away !== undefined
  );
  if (!list.length) return { homeSideWins: 0, awaySideWins: 0, draws: 0, sampleSize: 0, homeSideWinRate: null };
  let homeSideWins = 0;
  let awaySideWins = 0;
  let draws = 0;
  for (const f of list) {
    const homeIsHomeTeamId = f.teams && f.teams.home && f.teams.home.id === homeTeamId;
    const homeIsAwayTeamId = f.teams && f.teams.home && f.teams.home.id === awayTeamId;
    const winner = f.goals.home > f.goals.away ? "home" : f.goals.home < f.goals.away ? "away" : "draw";
    if (winner === "draw") { draws++; continue; }
    const winningTeamId = winner === "home" ? (f.teams.home && f.teams.home.id) : (f.teams.away && f.teams.away.id);
    if (winningTeamId === homeTeamId) homeSideWins++;
    else if (winningTeamId === awayTeamId) awaySideWins++;
    // homeIsHomeTeamId/homeIsAwayTeamIdはデバッグ用に計算しているが、勝敗の
    // 判定自体はteam idの一致だけで行う(どちらが今回ホームかは問わない)。
    void homeIsHomeTeamId; void homeIsAwayTeamId;
  }
  return {
    homeSideWins, awaySideWins, draws, sampleSize: list.length,
    homeSideWinRate: Math.round((homeSideWins / list.length) * 100) / 100,
  };
}

// ---- API-Football呼び出しを伴う取得関数 ----

async function fetchInjuryCountFeature(teamId, season, callApiFootball) {
  try {
    const data = await callApiFootball("/injuries", { team: teamId, season });
    return computeInjuryCountFeature(data.response);
  } catch (e) {
    return { injuryCount: null, error: e.message };
  }
}

async function fetchStandingsFeature(leagueId, season, teamId, callApiFootball) {
  if (!leagueId) return { position: null, points: null, played: null, goalsForAvg: null, goalsAgainstAvg: null, error: "no_league_id" };
  try {
    const data = await callApiFootball("/standings", { league: leagueId, season });
    return computeStandingsFeature(data.response, teamId);
  } catch (e) {
    return { position: null, points: null, played: null, goalsForAvg: null, goalsAgainstAvg: null, error: e.message };
  }
}

async function fetchHeadToHeadFeature(homeTeamId, awayTeamId, callApiFootball) {
  try {
    const data = await callApiFootball("/fixtures/headtohead", { h2h: `${homeTeamId}-${awayTeamId}`, last: 10 });
    return computeHeadToHeadFeature(data.response, homeTeamId, awayTeamId);
  } catch (e) {
    return { homeSideWins: 0, awaySideWins: 0, draws: 0, sampleSize: 0, homeSideWinRate: null, error: e.message };
  }
}

// fixturesリスト(last:10取得済みのもの)から、最も新しい試合のleague.idを
// 拾う(standings取得に必要。REGISTERED_TEAMSにリーグIDを持たせる二重管理を
// 避けるため、既に取得済みのfixturesデータから逆算する設計)。
function inferLeagueIdFromFixtures(fixtures) {
  const withLeague = (fixtures || []).find((f) => f && f.league && f.league.id);
  return withLeague ? withLeague.league.id : null;
}

module.exports = {
  computeGoalRateFeatures,
  computeFatigueFeature,
  computeInjuryCountFeature,
  computeStandingsFeature,
  computeHeadToHeadFeature,
  fetchInjuryCountFeature,
  fetchStandingsFeature,
  fetchHeadToHeadFeature,
  inferLeagueIdFromFixtures,
};
