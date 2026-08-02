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

function createKnowledgeSource({
  callApiFootball, resolveTeamId, guessSeason, getRecentFacts, getActiveKnowledge, setRelation,
  // 2026年8月・知識拡張フェーズで追加(すべて任意注入。未指定でも従来通り動く):
  //   ensureClubProfile   … Knowledge Engine Layer2(固定知識)をオンデマンドで生成・キャッシュ
  //   fetchCoachCareer    … 監督遍歴(/coachs)を取得
  //   saveKnowledgeItem   … 監督遍歴等の新しい実データをKnowledge EngineのLayer1事実として保存
  ensureClubProfile, fetchCoachCareer, saveKnowledgeItem,
}) {
  /**
   * @param {string} teamNameEnglish - API-Football側の検索に使う英語クラブ名
   * @param {Set<string>|string[]} needs - Plannerが決めた必要な知識の種類
   *   ("recentForm" | "formation" | "coach" | "injuries" | "transfers")
   *   未指定の場合はすべて取得する(後方互換のため)。
   * @param {string} [teamNameJapanese] - Layer2プロフィール生成時の表示用日本語名
   *   (未指定の場合はteamNameEnglishをそのまま使う。既存呼び出し元との後方互換のため任意)。
   */
  async function gatherClubKnowledge(teamNameEnglish, needs, teamNameJapanese) {
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
      // 毎日学習エンジン(server/learning/dailyJob.js)が過去に蓄積した「事実」
      // (例: 直近フォームの変化)。API-Football呼び出しではなくRedisからの読み取り
      // だけなのでコストはかからない。学習エンジン未実行・Upstash未設定の場合は
      // 常に空配列(正直に「まだ学んだことがない」を表す。架空の事実は作らない)。
      learnedFacts: [],
      // Knowledge Engine(server/knowledge/knowledgeStore.js)に蓄積されている、
      // このクラブについて現在「有効」な知識(事実/分析/意見)。上のlearnedFactsと
      // 重なる場合があるが、こちらは失効管理・重複排除を経た正式な知識ベースの
      // ビューであり、Reasoning Engineの根拠プール(server/reasoning/evidencePool.js)
      // が優先的に参照する。Knowledge Engine未設定・データ無しの場合は正直に空。
      knowledgeEngine: { facts: [], analyses: [], opinions: [], totalStored: 0, totalActive: 0 },
      fetchedTypes: [], errors: [],
    };

    const teamId = await resolveTeamId(teamNameEnglish);
    result.teamId = teamId;
    if (!teamId) {
      result.errors.push("team_not_found");
      return result;
    }
    const season = guessSeason();

    if (typeof getRecentFacts === "function") {
      try {
        result.learnedFacts = (await getRecentFacts(teamNameEnglish)) || [];
        if (result.learnedFacts.length) result.fetchedTypes.push("learnedFacts");
      } catch (e) { result.errors.push("learned_facts_failed"); }
    }

    if (typeof getActiveKnowledge === "function") {
      try {
        const active = await getActiveKnowledge(teamNameEnglish);
        if (active) {
          result.knowledgeEngine = active;
          if (active.totalActive > 0) result.fetchedTypes.push("knowledgeEngine");
        }
      } catch (e) { result.errors.push("knowledge_engine_failed"); }
    }

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
          // Knowledge Graph(最小限の関係インデックス): 「このクラブの現在の監督は誰か」
          // 「このクラブの直近フォーメーションは何か」という一方向の関係を記録する。
          // 失敗しても回答生成自体は継続する(あくまで補助的な蓄積)。
          if (typeof setRelation === "function") {
            if (result.coachName) setRelation("team", teamNameEnglish, "manager", "person", result.coachName).catch(() => {});
            if (result.formation) setRelation("team", teamNameEnglish, "formation", "formation", result.formation).catch(() => {});
          }
        }
      } catch (e) { result.errors.push("lineup_failed"); }
    }
    // ---- 2026年8月・知識拡張フェーズ: 監督遍歴(Layer1事実+Knowledge Graph) ----
    // 同じクラブについて何度も聞かれるたびに/coachsを呼び直さないよう、既に
    // 有効な"managerHistory"事実が無い場合だけ取得する(getActiveKnowledgeで
    // 既に取得済みのresult.knowledgeEngine.factsをそのまま流用してチェックする
    // ため、追加のRedis読み取りは発生しない)。
    result.managerCareer = null;
    if (needSet.has("coach") && result.coachName && typeof fetchCoachCareer === "function") {
      const hasRecentManagerHistoryFact = (result.knowledgeEngine.facts || []).some((f) => f.category === "managerHistory");
      if (!hasRecentManagerHistoryFact) {
        try {
          const career = await fetchCoachCareer(teamId);
          if (career && career.career && career.career.length) {
            result.managerCareer = career;
            result.fetchedTypes.push("managerCareer");
            const previousClub = career.career.find((c) => c.teamId !== teamId && c.end);
            const statement = previousClub
              ? `${career.currentCoachName || result.coachName}監督の在籍歴: 現在${teamNameEnglish}(${(career.career.find((c) => c.teamId === teamId) || {}).start || "不明"}〜)、前職${previousClub.teamName}(${previousClub.start || "不明"}〜${previousClub.end})。`
              : `${career.currentCoachName || result.coachName}監督のクラブ在籍歴データを取得しました(前職の記録は見つかりませんでした)。`;
            if (typeof saveKnowledgeItem === "function") {
              saveKnowledgeItem({
                teamEn: teamNameEnglish, category: "managerHistory", type: "fact",
                statement, detail: career, computedAt: new Date().toISOString(),
                source: "API-Footballの実データ(/coachs)",
              }).catch(() => {});
            }
            if (previousClub && typeof setRelation === "function") {
              setRelation("person", career.currentCoachName || result.coachName, "previousClub", "team", previousClub.teamName).catch(() => {});
            }
          }
        } catch (e) { result.errors.push("coach_career_failed"); }
      }
    }

    // ---- 2026年8月・知識拡張フェーズ: Layer2固定知識(クラブプロフィール)を
    // オンデマンドで生成・キャッシュする。これまで毎日学習エンジンの登録
    // 11クラブでしか作られなかったが、ここに置くことで「議論モードで実際に
    // 質問されたクラブ」から知識が蓄積されていく(主要リーグ全クラブへの
    // 現実的な対応方法。README参照)。既に有効なプロフィールがあれば
    // 内部で自動的にスキップされるため、追加コストは初回のみ。
    if (typeof ensureClubProfile === "function") {
      try {
        const groundingFacts = [];
        if (result.goalsForTrend && result.goalsForTrend.length) {
          const avgGf = result.goalsForTrend.reduce((a, b) => a + b, 0) / result.goalsForTrend.length;
          groundingFacts.push(`直近試合の平均得点: ${Math.round(avgGf * 100) / 100}`);
        }
        if (result.coachName) groundingFacts.push(`現在の監督: ${result.coachName}`);
        if (result.formation) groundingFacts.push(`直近のフォーメーション: ${result.formation}`);
        if (result.learnedFacts && result.learnedFacts.length) {
          result.learnedFacts.slice(0, 3).forEach((f) => groundingFacts.push(f.statement));
        }
        const profileResult = await ensureClubProfile(teamNameEnglish, teamNameJapanese || teamNameEnglish, groundingFacts, new Date().toISOString(), result.coachName);
        if (profileResult && profileResult.profile) {
          result.clubProfile = profileResult.profile;
          if (profileResult.generated) result.fetchedTypes.push("clubProfileGenerated");
          // 今回のリクエストで初めて生成された場合、getActiveKnowledgeは生成前の
          // 時点のスナップショットのままなので、根拠プールにすぐ反映されるよう
          // ここで直接追加しておく(次回以降は自然にgetActiveKnowledge経由で入る)。
          if (profileResult.generated && result.knowledgeEngine && Array.isArray(result.knowledgeEngine.profiles)) {
            result.knowledgeEngine.profiles.push(profileResult.profile);
          }
        }
      } catch (e) { result.errors.push("club_profile_failed"); }
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
