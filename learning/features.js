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
 *   - ローテーション(疲労による選手起用の変化): スタメンと同じ理由で保留。
 *     代わりに「直近の試合間隔(過密日程かどうか)」を疲労の代理指標として
 *     採用した(下記 computeFatigueFeature)。
 *
 * 【2026年8月・知識拡張フェーズで追加】監督交代後の成績について: 前回は
 * 「いつ監督が交代したか」を確実に取れるクリーンなフィールドが無いとして見送って
 * いましたが、API-Footballに/coachsという専用エンドポイントがあり、監督ごとの
 * career(在籍クラブ・在任開始日・終了日)を取得できることが分かったため、
 * fetchCoachCareer/computeCoachCareerとして実装しました(下記)。ただし正直な
 * 注意点として、このcareerデータの正確性・最新性はAPI-Football側のデータベース
 * 更新頻度に依存します(監督交代の翌日には反映されていない可能性があります)。
 * 「監督交代後の成績」(交代前後で的中率がどう変わったか、まで)は本ラウンドでは
 * 実装しておらず、career情報を知識として保存するところまでが今回の範囲です。
 *
 * 実装した特徴量(すべて実データから計算。AIの推測は混ぜない):
 *   - computeGoalRateFeatures: 直近試合の平均得点・平均失点(既に取得済みの
 *     fixturesデータから追加のAPI呼び出しなしで計算できる)
 *   - computeFatigueFeature: 直近7日以内の試合数(過密日程の代理指標)
 *   - computeHomeAwaySplit: ホーム/アウェイ別の勝率・平均得点・平均失点(既に
 *     取得済みのfixturesデータから追加のAPI呼び出しなしで計算できる)
 *   - fetchInjuryCountFeature: 現在の負傷者数(/injuries)
 *   - fetchStandingsFeature: 現在の順位・勝点(/standings)
 *   - fetchHeadToHeadFeature: 過去の直接対戦成績(/fixtures/headtohead)
 *   - fetchCoachCareer: 監督遍歴(在籍クラブ・在任期間)(/coachs)
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

// 2026年8月・本番監査(⑦情報拡張)対応: これまでは人数(injuryCount)だけを
// 返し、実際には取得できていた「誰が」「どんな理由で」(負傷/出場停止)を
// 捨てていた。API-Footballの/injuriesは負傷・出場停止の両方をまとめて
// 返すため(player.reasonに"Suspended"等が入る)、ここで種別も分けて返す。
// 実データにある情報をそのまま構造化するだけで、AIの推測は加えない。
function computeInjuryCountFeature(injuriesResponse) {
  const list = injuriesResponse || [];
  const seen = new Map(); // name -> {name, reason, type}
  for (const r of list) {
    const name = r && r.player && r.player.name;
    if (!name || seen.has(name)) continue;
    const reason = (r.player && r.player.reason) || null;
    // 2026年8月・優先順位②の実装中に発見した既存バグの修正:
    // 従来は /suspend/i だったが、これは "Suspended" にはマッチする一方で
    // "Suspension"(API-Footballが返す代表的な表記。例: "Red Card Suspension")
    // には**マッチしない**(suspend の d と suspension の s が違うため)。
    // その結果、出場停止の選手が「負傷者」として数えられていた。
    // 出場停止は「確実に出られない」ため負傷とは意味が違い、予測にも影響する。
    const isSuspension = !!(reason && /suspen(d|s)/i.test(reason));
    seen.set(name, { name, reason, type: isSuspension ? "suspension" : "injury" });
  }
  const players = [...seen.values()];
  return {
    injuryCount: players.length,
    injuredPlayers: players.filter((p) => p.type === "injury").map((p) => p.name),
    suspendedPlayers: players.filter((p) => p.type === "suspension").map((p) => p.name),
  };
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

// ホーム/アウェイでの成績差(ご要望「ホームとアウェイの差」への回答)。既に
// 取得済みのfixturesデータから追加のAPI呼び出し無しで計算できる、実データのみの
// 客観的な数値(勝率・平均得点・平均失点をホーム/アウェイ別に集計するだけ)。
function computeHomeAwaySplit(fixtures, teamId) {
  const withGoals = (fixtures || []).filter(
    (f) => f && f.fixture && f.teams && f.goals && f.goals.home !== null && f.goals.home !== undefined && f.goals.away !== null && f.goals.away !== undefined
  );
  const summarize = (list) => {
    if (!list.length) return { sampleSize: 0, winRate: null, avgGoalsFor: null, avgGoalsAgainst: null };
    let wins = 0, gf = 0, ga = 0;
    for (const f of list) {
      const isHome = f.teams.home && f.teams.home.id === teamId;
      const goalsFor = isHome ? f.goals.home : f.goals.away;
      const goalsAgainst = isHome ? f.goals.away : f.goals.home;
      gf += goalsFor; ga += goalsAgainst;
      if (goalsFor > goalsAgainst) wins++;
    }
    return {
      sampleSize: list.length,
      winRate: Math.round((wins / list.length) * 100) / 100,
      avgGoalsFor: Math.round((gf / list.length) * 100) / 100,
      avgGoalsAgainst: Math.round((ga / list.length) * 100) / 100,
    };
  };
  const homeGames = withGoals.filter((f) => f.teams.home && f.teams.home.id === teamId);
  const awayGames = withGoals.filter((f) => f.teams.away && f.teams.away.id === teamId);
  return { home: summarize(homeGames), away: summarize(awayGames) };
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

// 監督遍歴(ご要望「監督遍歴」への回答)。API-Footballの/coachsエンドポイントは
// 監督ごとに career(在籍クラブとstart/end)の配列を返す(endがnullなら現職)。
// これにより「いつ監督が交代したか」を、日々のラインナップ突き合わせのような
// 複雑な検出ロジック無しで、実データからそのまま取得できる。
function computeCoachCareer(coachsResponse, teamId) {
  const empty = { currentCoachName: null, career: [] };
  const list = coachsResponse || [];
  // teamIdが在籍クラブ一覧(career)に含まれる監督を優先して選ぶ(通常は1名のみ該当)。
  const coach = list.find((c) => (c.career || []).some((entry) => entry.team && entry.team.id === teamId)) || list[0];
  if (!coach) return empty;
  const career = (coach.career || [])
    .map((entry) => ({
      teamName: entry.team ? entry.team.name : null,
      teamId: entry.team ? entry.team.id : null,
      start: entry.start || null,
      end: entry.end || null,
    }))
    .filter((e) => e.teamName)
    .sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0));
  return {
    currentCoachName: coach.name || null,
    career,
  };
}

async function fetchCoachCareer(teamId, callApiFootball) {
  try {
    const data = await callApiFootball("/coachs", { team: teamId });
    return computeCoachCareer(data.response, teamId);
  } catch (e) {
    return { currentCoachName: null, career: [], error: e.message };
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

// 2026年8月・本番監査(⑦情報拡張)対応: 「フォーメーション相性」への正直な
// 回答。試合前の予想スタメン・フォーメーションはAPI-Football側でもキックオフ
// 直前(約1時間前)まで確定しないため取得できない。代わりに「直近の実際の
// 試合で採用したフォーメーション」を/fixtures/lineupsから取得する(これは
// 実際にプレーされた試合の事実であり、AIの推測ではない)。試合中止・
// ラインナップ未登録などで取得できない場合はnullを正直に返す。
function computeFixtureFormation(lineupsResponse, teamId) {
  const mine = (lineupsResponse || []).find((t) => t.team && t.team.id === teamId);
  if (!mine) return { formation: null, coachName: null };
  return { formation: mine.formation || null, coachName: mine.coach ? mine.coach.name : null };
}

async function fetchLatestFormation(fixtures, teamId, callApiFootball) {
  const sorted = [...(fixtures || [])]
    .filter((f) => f && f.fixture && f.fixture.date && f.fixture.status && f.fixture.status.short === "FT")
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  const latest = sorted[0];
  if (!latest) return { formation: null, coachName: null, error: "no_finished_fixture" };
  try {
    const data = await callApiFootball("/fixtures/lineups", { fixture: latest.fixture.id });
    return { ...computeFixtureFormation(data.response, teamId), sourceFixtureId: latest.fixture.id, sourceFixtureDate: latest.fixture.date };
  } catch (e) {
    return { formation: null, coachName: null, error: e.message };
  }
}

// 2026年8月・本番監査(⑦情報拡張)対応: 「勝敗を左右する選手」への正直な
// 回答。「この選手が勝敗を決める」と断定できる根拠はAI-Footballには無いため、
// 代わりに「今シーズンのその選手の得点ランキング上位」という、実データで
// 裏付けられる客観的な事実を返す(架空の"キーマン診断"にはしない)。
function pickTeamTopScorer(topscorersResponse, teamId) {
  const list = topscorersResponse || [];
  const mine = list.find((row) => (row.statistics || []).some((s) => s.team && s.team.id === teamId));
  if (!mine) return null;
  const stat = (mine.statistics || []).find((s) => s.team && s.team.id === teamId) || mine.statistics[0];
  return {
    name: mine.player ? mine.player.name : null,
    goals: (stat && stat.goals && stat.goals.total) || 0,
    assists: (stat && stat.goals && stat.goals.assists) || 0,
  };
}

async function fetchTeamTopScorer(leagueId, season, teamId, callApiFootball) {
  if (!leagueId) return { player: null, error: "no_league_id" };
  try {
    const data = await callApiFootball("/players/topscorers", { league: leagueId, season });
    const player = pickTeamTopScorer(data.response, teamId);
    // そのチームの選手がリーグ得点ランキング上位(トップ20程度)に一人もいない
    // ことは普通にあり得る(それ自体は正直な「該当なし」)。
    return { player: player || null };
  } catch (e) {
    return { player: null, error: e.message };
  }
}

module.exports = {
  computeGoalRateFeatures,
  computeFatigueFeature,
  computeInjuryCountFeature,
  computeStandingsFeature,
  computeHeadToHeadFeature,
  computeHomeAwaySplit,
  computeCoachCareer,
  fetchInjuryCountFeature,
  fetchStandingsFeature,
  fetchHeadToHeadFeature,
  fetchCoachCareer,
  inferLeagueIdFromFixtures,
  computeFixtureFormation,
  fetchLatestFormation,
  pickTeamTopScorer,
  fetchTeamTopScorer,
};
