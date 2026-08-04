/**
 * server/learning/leagueKnowledge.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑥「主要リーグのKnowledge Engine日次蓄積を拡張」。
 *
 * ご要望原文: 「順位/日程/試合結果/選手/監督/移籍/怪我/得点ランキング/
 * アシストランキング などをKnowledge Engineへ蓄積してください」。
 *
 * 正直な実装範囲(なぜ全項目を文字通り実装していないか):
 *   - 順位(standings)・得点ランキング(topscorers)・アシストランキング
 *     (topassists) は、リーグ単位で1回のAPI呼び出しで取得できるため、
 *     今回すべてのリーグに対して実装した。
 *   - 日程・試合結果は、standingsレスポンス自体に各チームの消化試合数
 *     (played)と直近5試合の結果(form、例:"WWDLW")が含まれているため、
 *     追加のAPI呼び出し無しで順位表の事実にまとめて含めている。加えて、
 *     ホーム画面の「📡 本日の実際の試合」カード(優先順位②④)が、今日
 *     行われる/行われた試合の日程・結果をリアルタイムに(無料で)表示
 *     するため、そちらと役割分担している。
 *   - 選手・監督・移籍・怪我をリーグ全チーム(5〜10リーグ×約20チーム=
 *     100〜200チーム分)について毎日取得することは、API-Football無料プラン
 *     (1日100リクエスト)は言うまでもなく、有料プランでも現実的なコストでは
 *     ない。得点/アシストランキングは「選手」情報の実質的な代替(そのリーグで
 *     今シーズン最も活躍している選手の実データ)として機能させ、「監督/移籍/
 *     怪我」は既存の登録クラブ単位の日次確認(server/learning/dailyJob.js の
 *     ①-d、ローテーション方式)の対象範囲に留めている(この点は残課題として
 *     READMEに明記する)。
 */
const { MANDATORY_LEAGUES, EXTENDED_LEAGUES, leagueEntityKey, resolveLeagueId } = require("./leagueConfig");

// 拡張5リーグ(ご要望にあったが必須ではないリーグ)を1回の実行で何件確認するか。
// API-Football無料プラン(1日100リクエスト)を守るため、必須5リーグ(15リクエスト
// /日)は毎日確実に取得しつつ、拡張リーグはローテーションで少しずつ確認する
// (5リーグを2件/日なら3日弱で一巡する)。
// 2026年8月・優先順位⑪: 有料プランへ移行したときにコードを書き換えずに
// 拡張リーグも毎日すべて取得できるよう、環境変数で上書きできるようにした
// (EXTENDED_LEAGUE_CAP=5 にすれば、ご要望の10リーグすべてが毎日更新になる)。
const EXTENDED_LEAGUE_CHECK_CAP = Number(process.env.EXTENDED_LEAGUE_CAP) || 2;

function seasonForDate(runAt) {
  const m = runAt.getUTCMonth() + 1; // 欧州シーズンは7月開始想定(既存のguessSeasonと同じ考え方)
  return m >= 7 ? runAt.getUTCFullYear() : runAt.getUTCFullYear() - 1;
}

// API-Footballの/standingsは大会によって配列がグループ分けされてネストする
// ことがある(server/learning/features.jsのcomputeStandingsFeatureと同じ前提)。
// 注意: 文面に日付を埋め込まない(既存のfactsToday系の事実と同じ規約)。
// Knowledge Engineの重複排除は「statementの内容」で判定するため、もし日付を
// 文中に含めてしまうと、実際には順位表が前日と一切変わっていなくても毎日
// 「新しい事実」として扱われてしまい、「本当に変化があった時だけ知識が増える」
// という設計が壊れる。「いつ時点の情報か」はcomputedAt/firstSeenAt/lastSeenAt
// という既存のメタデータ側で管理する。
function formatStandingsStatement(league, standingsResponse) {
  const leagues = (standingsResponse || []).map((r) => r.league).filter(Boolean);
  if (!leagues.length) return null;
  const groups = leagues[0].standings || [];
  const flat = groups.reduce((acc, g) => acc.concat(Array.isArray(g) ? g : [g]), []);
  if (!flat.length) return null;
  const sorted = [...flat].sort((a, b) => (a.rank || 999) - (b.rank || 999));
  const rowText = (r) => `${r.rank}位${r.team ? r.team.name : "?"}(${r.points}pt・${r.all && r.all.played != null ? r.all.played : "?"}試合${r.form ? "・直近" + r.form : ""})`;
  // 表全体を書くと長くなりすぎるため、上位陣+下位(降格圏想定)だけを抜粋する。
  const topN = sorted.slice(0, 6).map(rowText);
  const bottomN = sorted.length > 9 ? sorted.slice(-3).map(rowText) : [];
  const parts = bottomN.length ? [...topN, "…", ...bottomN] : topN;
  return `${league.nameJa}(${league.countryJa})の現在の順位表: ${parts.join("、")}。`;
}

// topscorers/topassistsは同じ{player, statistics:[{team, goals:{total, assists}}]}
// 形式を返す(server/learning/features.jsのpickTeamTopScorerと同じ前提)。
// formatStandingsStatementと同じ理由で、文面に日付は埋め込まない。
function formatTopListStatement(league, playersResponse, kind) {
  const list = playersResponse || [];
  const rows = list.slice(0, 5).map((row, i) => {
    const stat = (row.statistics && row.statistics[0]) || {};
    const teamName = stat.team ? stat.team.name : "?";
    const count = kind === "goals" ? ((stat.goals && stat.goals.total) || 0) : ((stat.goals && stat.goals.assists) || 0);
    const unitJa = kind === "goals" ? "ゴール" : "アシスト";
    return `${i + 1}位${row.player ? row.player.name : "?"}(${teamName}・${count}${unitJa})`;
  });
  if (!rows.length) return null;
  const kindJa = kind === "goals" ? "得点ランキング" : "アシストランキング";
  return `${league.nameJa}(${league.countryJa})の現在の${kindJa}(上位5): ${rows.join("、")}。`;
}

// 拡張5リーグのうち、今日どれを確認するか(日付ベースのローテーション。
// server/learning/dailyJob.jsのCOACH_TRANSFER_CHECK_CAPと同じ考え方)。
function pickTodaysExtendedLeagues(dateKey) {
  if (!EXTENDED_LEAGUES.length) return [];
  const startOffset = Math.abs(dateKey.split("-").join("") % EXTENDED_LEAGUES.length) || 0;
  const rotated = EXTENDED_LEAGUES.slice(startOffset).concat(EXTENDED_LEAGUES.slice(0, startOffset));
  return rotated.slice(0, EXTENDED_LEAGUE_CHECK_CAP);
}

/**
 * 必須5リーグ(毎日)+拡張リーグ(ローテーション)について、順位表・得点/
 * アシストランキングを取得し、Knowledge Engineへリーグ単位の「事実」として
 * 蓄積する。deps: { callApiFootball, upstashEnabled, upstashGetJSON,
 * upstashSetJSON, knowledgeStore(saveKnowledgeItemを持つインスタンス) }。
 */
async function collectLeagueKnowledge(deps, runAt, dateKey) {
  const { callApiFootball, knowledgeStore } = deps;
  const season = seasonForDate(runAt);
  const targets = [
    ...MANDATORY_LEAGUES.map((l) => ({ ...l, mandatory: true })),
    ...pickTodaysExtendedLeagues(dateKey).map((l) => ({ ...l, mandatory: false })),
  ];

  const errors = [];
  let leaguesProcessed = 0;
  let mandatoryLeaguesProcessed = 0;
  let extendedLeaguesProcessed = 0;
  let leagueFactsSavedToday = 0;
  let leagueFactsDuplicateToday = 0;
  const leagueFactsToday = []; // growthLogの表示専用

  for (const league of targets) {
    try {
      const leagueId = league.id || (await resolveLeagueId(league, deps));
      if (!leagueId) {
        errors.push(`league_id_unresolved:${league.nameEn}(${league.countryJa})`);
        continue;
      }
      const entity = leagueEntityKey(league);
      let touchedThisLeague = false;

      // ---- 順位(+実質的に日程・試合結果: played/formを含む) ----
      try {
        const data = await callApiFootball("/standings", { league: leagueId, season });
        const statement = formatStandingsStatement(league, data && data.response);
        if (statement) {
          const result = await knowledgeStore.saveKnowledgeItem({
            leagueEn: entity, category: "leagueStandings", type: "fact",
            statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/standings)",
          });
          if (result.saved) { leagueFactsSavedToday++; leagueFactsToday.push({ leagueJa: league.nameJa, statement, category: "leagueStandings" }); }
          else if (result.reason === "DUPLICATE") leagueFactsDuplicateToday++;
          touchedThisLeague = true;
        }
      } catch (e) { errors.push(`league_standings_failed:${league.nameEn}:${e.code || e.message}`); }

      // ---- 得点ランキング ----
      try {
        const data = await callApiFootball("/players/topscorers", { league: leagueId, season });
        const statement = formatTopListStatement(league, data && data.response, "goals");
        if (statement) {
          const result = await knowledgeStore.saveKnowledgeItem({
            leagueEn: entity, category: "leagueTopScorers", type: "fact",
            statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/players/topscorers)",
          });
          if (result.saved) { leagueFactsSavedToday++; leagueFactsToday.push({ leagueJa: league.nameJa, statement, category: "leagueTopScorers" }); }
          else if (result.reason === "DUPLICATE") leagueFactsDuplicateToday++;
          touchedThisLeague = true;
        }
      } catch (e) { errors.push(`league_topscorers_failed:${league.nameEn}:${e.code || e.message}`); }

      // ---- アシストランキング ----
      try {
        const data = await callApiFootball("/players/topassists", { league: leagueId, season });
        const statement = formatTopListStatement(league, data && data.response, "assists");
        if (statement) {
          const result = await knowledgeStore.saveKnowledgeItem({
            leagueEn: entity, category: "leagueTopAssists", type: "fact",
            statement, computedAt: runAt.toISOString(), source: "API-Footballの実データ(/players/topassists)",
          });
          if (result.saved) { leagueFactsSavedToday++; leagueFactsToday.push({ leagueJa: league.nameJa, statement, category: "leagueTopAssists" }); }
          else if (result.reason === "DUPLICATE") leagueFactsDuplicateToday++;
          touchedThisLeague = true;
        }
      } catch (e) { errors.push(`league_topassists_failed:${league.nameEn}:${e.code || e.message}`); }

      if (touchedThisLeague) {
        leaguesProcessed++;
        if (league.mandatory) mandatoryLeaguesProcessed++; else extendedLeaguesProcessed++;
      }
    } catch (e) {
      errors.push(`league_check_failed:${league.nameEn}:${e.message}`);
    }
  }

  return {
    leaguesProcessed, mandatoryLeaguesProcessed, extendedLeaguesProcessed,
    leagueFactsSavedToday, leagueFactsDuplicateToday, leagueFactsToday, errors,
  };
}

module.exports = {
  collectLeagueKnowledge, formatStandingsStatement, formatTopListStatement,
  pickTodaysExtendedLeagues, seasonForDate, EXTENDED_LEAGUE_CHECK_CAP,
};
