/**
 * RAG知識ソース ― 議論エンジンが「根拠」として使う実データを集める層。
 * ----------------------------------------------------------------
 * ここで集めた情報だけが最終的にLLMへ渡され、LLMはこれ以外の具体的な数字・
 * 固有名詞(スコア・日付・移籍額など)を新たに作ってはいけない、というのが
 * このプロジェクト全体の大前提です(ハルシネーション対策)。
 *
 * このファイル自体は「API-Footballにどう接続するか」を知りません。server.js
 * 側に既にある callApiFootball / resolveTeamId / guessSeason をそのまま
 * 注入して使う設計(依存性注入)にすることで、二重実装によるズレを防いでいます。
 *
 * 正直な注記: 「監督コメント・采配評価」は、現在接続しているAPI-Football
 * (試合結果・選手成績中心のデータAPI)では取得できません。実際のニュース記事や
 * 会見内容が必要になるためで、Stage D以降でニュースソースを追加する場合の
 * 検討事項です。ここでは無理に埋めず、明示的に「取得できていない」ことを
 * 返します(信頼度スコアがこれを正直に反映します)。
 */

function summarizeRecentForm(fixtures, teamId) {
  return fixtures
    .map((f) => {
      const isHome = f.teams.home.id === teamId;
      const opp = isHome ? f.teams.away : f.teams.home;
      const goalsFor = isHome ? f.goals.home : f.goals.away;
      const goalsAgainst = isHome ? f.goals.away : f.goals.home;
      let result = "不明";
      if (goalsFor !== null && goalsFor !== undefined && goalsAgainst !== null && goalsAgainst !== undefined) {
        result = goalsFor > goalsAgainst ? "勝ち" : goalsFor < goalsAgainst ? "負け" : "分け";
      }
      return {
        fixtureId: f.fixture.id,
        date: f.fixture.date,
        opponent: opp ? opp.name : "不明",
        homeAway: isHome ? "ホーム" : "アウェイ",
        goalsFor, goalsAgainst, result,
        competition: f.league ? f.league.name : null,
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function summarizeInjuries(rawList, maxCount) {
  const seen = new Set();
  const items = [];
  const sorted = (rawList || []).slice().sort((a, b) => new Date((b.fixture && b.fixture.date) || 0) - new Date((a.fixture && a.fixture.date) || 0));
  for (const r of sorted) {
    const name = r.player && r.player.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({
      playerName: name,
      type: (r.player && r.player.type) || null,
      reason: (r.player && r.player.reason) || null,
      date: r.fixture ? r.fixture.date : null,
    });
    if (items.length >= maxCount) break;
  }
  return items;
}

function summarizeTransfers(rawList, teamId, maxCount, sinceDate) {
  const items = [];
  for (const entry of rawList || []) {
    const name = entry.player && entry.player.name;
    for (const t of entry.transfers || []) {
      const d = t.date ? new Date(t.date) : null;
      if (!d || (sinceDate && d < sinceDate)) continue;
      const inTeamId = t.teams && t.teams.in && t.teams.in.id;
      const outTeamId = t.teams && t.teams.out && t.teams.out.id;
      if (inTeamId !== teamId && outTeamId !== teamId) continue;
      items.push({
        playerName: name,
        date: t.date,
        direction: inTeamId === teamId ? "加入" : "退団",
        counterpart: inTeamId === teamId ? (t.teams.out && t.teams.out.name) : (t.teams.in && t.teams.in.name),
        type: t.type || null,
      });
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, maxCount);
}

const MANAGER_QUOTE_UNAVAILABLE_REASON =
  "監督コメント・采配評価は、現時点で接続している実データソース(API-Football)では取得できません。";

function createKnowledgeSource({ callApiFootball, resolveTeamId, guessSeason }) {
  /**
   * @param {string} teamNameEnglish - API-Football側の検索に使う英語クラブ名
   * @param {Set<string>|string[]} needs - Plannerが決めた必要な知識の種類
   *   ("recentForm" | "formation" | "coach" | "injuries" | "transfers")
   *   未指定の場合はすべて取得する(後方互換のため)。
   */
  async function gatherClubKnowledge(teamNameEnglish, needs) {
    const needSet = needs ? new Set(needs) : new Set(["recentForm", "formation", "coach", "injuries", "transfers"]);
    // フォーメーション・監督名は直近試合のラインナップに依存するため、
    // どちらかが必要なら直近成績も最低限(1試合分)は取得する。
    const wantsRecentForm = needSet.has("recentForm") || needSet.has("formation") || needSet.has("coach");

    const result = {
      teamNameEnglish, teamId: null,
      recentForm: [], goalsForTrend: null, goalsAgainstTrend: null,
      formation: null, coachName: null,
      injuries: [], transfers: [],
      managerQuote: null, managerQuoteUnavailableReason: MANAGER_QUOTE_UNAVAILABLE_REASON,
      fetchedTypes: [], errors: [],
    };

    const teamId = await resolveTeamId(teamNameEnglish);
    result.teamId = teamId;
    if (!teamId) {
      result.errors.push("team_not_found");
      return result;
    }
    const season = guessSeason();

    if (wantsRecentForm) {
      try {
        const lastN = needSet.has("recentForm") ? 10 : 1;
        const data = await callApiFootball("/fixtures", { team: teamId, last: lastN });
        const list = (data.response || []).filter((f) => f.goals && f.goals.home !== null && f.goals.away !== null);
        result.recentForm = summarizeRecentForm(list, teamId);
        if (needSet.has("recentForm") && result.recentForm.length) {
          result.goalsForTrend = result.recentForm.map((m) => m.goalsFor);
          result.goalsAgainstTrend = result.recentForm.map((m) => m.goalsAgainst);
        }
        result.fetchedTypes.push("recentForm");
      } catch (e) { result.errors.push("recent_form_failed"); }
    }

    if ((needSet.has("formation") || needSet.has("coach")) && result.recentForm.length) {
      try {
        const latestFixtureId = result.recentForm[0].fixtureId;
        const data = await callApiFootball("/fixtures/lineups", { fixture: latestFixtureId });
        const mine = (data.response || []).find((t) => t.team && t.team.id === teamId);
        if (mine) {
          if (needSet.has("formation")) { result.formation = mine.formation || null; result.fetchedTypes.push("formation"); }
          if (needSet.has("coach")) { result.coachName = mine.coach ? mine.coach.name : null; result.fetchedTypes.push("coach"); }
        }
      } catch (e) { result.errors.push("lineup_failed"); }
    }
    // 直近成績を「フォーメーション/監督名のためだけ」に最小取得した場合(last=1)は、
    // 直近成績そのものは要求されていないので結果には含めない。
    if (!needSet.has("recentForm")) result.recentForm = [];

    if (needSet.has("injuries")) {
      try {
        const data = await callApiFootball("/injuries", { team: teamId, season });
        result.injuries = summarizeInjuries(data.response, 8);
        result.fetchedTypes.push("injuries");
      } catch (e) { result.errors.push("injuries_failed"); }
    }

    if (needSet.has("transfers")) {
      try {
        const data = await callApiFootball("/transfers", { team: teamId });
        const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
        result.transfers = summarizeTransfers(data.response, teamId, 8, since);
        result.fetchedTypes.push("transfers");
      } catch (e) { result.errors.push("transfers_failed"); }
    }

    return result;
  }

  return { gatherClubKnowledge };
}

module.exports = { createKnowledgeSource, summarizeRecentForm, summarizeInjuries, summarizeTransfers, MANAGER_QUOTE_UNAVAILABLE_REASON };
