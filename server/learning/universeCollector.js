/**
 * server/learning/universeCollector.js
 * ------------------------------------------------
 * 2026年8月・「知識量を大幅に増やす」フェーズ(ご指示①②③)の実行部。
 * UEFA上位100クラブ(clubUniverse.js)について、取得可能な実データを
 * 毎日・輪番で取得し、クラブ調査ファイル(clubDossier.js)へ構造化して保存する。
 *
 * ■ 更新頻度の階層(ご指示の「追加のおすすめ」どおり)
 *   毎日        : tier A(上位40)のフォーム・怪我・監督/布陣・移籍
 *   2日に1回     : tier B(41〜100位)の同上(輪番)
 *   7日で一巡    : 全クラブの選手名簿(squad)、tier AのxG
 *   28日で一巡   : ほぼ変わらない基本情報(スタジアム・創設年など)
 *   毎日(予算内) : 選手の詳細成績(名簿から輪番で1日あたり上限N人)
 *
 * ■ API予算(Pro=7500/日)の見積もり
 *   コア更新: 約70クラブ × 4リクエスト(試合・怪我・布陣・移籍) ≒ 280
 *   順位表  : リーグ単位でまとめて取得 ≒ 10〜20
 *   名簿    : 約15クラブ × 1 ≒ 15
 *   xG      : 約6クラブ × 5 ≒ 30
 *   選手詳細: 上限300人 × 1 = 300(UNIVERSE_PLAYER_CAP で調整可)
 *   合計 ≒ 650/日。既存の学習(登録11クラブ・リーグ・107選手)と合わせても
 *   Proの7500/日に対して十分な余裕がある。
 *   予算が減ってきたら(残量がしきい値未満)、その日の残り処理は正直に見送り、
 *   何を見送ったかを記録する(黙って減らさない)。
 *
 * ■ でっち上げ防止
 *   ・保存するのは実測値のみ。取得に失敗したセクションは更新しない
 *     (前回の実測値と computedAt がそのまま残る=古さが分かる)。
 *   ・「昨日から何が変わったか」は dossier の差分検出からのみ生成する。
 */

const {
  CLUB_UNIVERSE, tierOf, clubsForCoreUpdate, clubsForSquadSync,
  clubsForXgUpdate, clubsForBasicInfo, UEFA_SNAPSHOT_NOTE_JA,
} = require("./clubUniverse");
const {
  computeGoalRateFeatures, computeFatigueFeature, computeHomeAwaySplit,
  computeInjuryCountFeature, computeStandingsFeature, inferLeagueIdFromFixtures,
  fetchTeamXgAverage,
} = require("./features");
const { computePlayerRealStats } = require("./playerFeatures");
const { summarizeTransfers } = require("../rag/knowledgeSource");

// 予算の安全弁: 残りがこの件数を下回ったら、その日の宇宙収集は打ち切る
// (既存の学習ジョブや利用者のリクエストを圧迫しないため)。
const BUDGET_FLOOR = Number(process.env.UNIVERSE_BUDGET_FLOOR) || 150;
const PLAYER_CAP_DEFAULT = Number(process.env.UNIVERSE_PLAYER_CAP) || 300;

function seasonOf(runAt) {
  const m = runAt.getMonth() + 1;
  return m >= 7 ? runAt.getFullYear() : runAt.getFullYear() - 1;
}

// dailyJob.js の computeFormScore と同じ計算(依存の向きの都合でここに複製せず、
// 引数として受け取る)。
/**
 * @param {object} deps - {
 *   callApiFootball, apiBudget, clubDossier, knowledgeStore, knowledgeGraph,
 *   thoughtTimeline, computeFormScore, recordLearned(item, extraSignals),
 * }
 * @returns 集計(処理クラブ数・保存選手数・見送った処理と理由 など)
 */
async function collectUniverse(deps, runAt, dateKey) {
  const {
    callApiFootball, apiBudget, clubDossier, knowledgeStore, knowledgeGraph,
    thoughtTimeline, computeFormScore, recordLearned,
  } = deps;
  const season = seasonOf(runAt);
  // 2026年8月・ご指示⑩: AIが前日に決めた学習計画の「優先クラブ」。
  // 該当クラブは輪番を待たずに、今日のコア更新・xG更新の対象に加わる
  // (計画を立てるだけでなく、実際の収集行動を変える)。
  const priorityClubs = (deps.priorityClubs || [])
    .map((nameEn) => CLUB_UNIVERSE.find((c) => c.nameEn.toLowerCase() === String(nameEn).toLowerCase()))
    .filter(Boolean);
  const stats = {
    coreClubsPlanned: 0, coreClubsUpdated: 0,
    squadsPlanned: 0, squadsUpdated: 0,
    playersUpdated: 0, playersPlanned: 0,
    xgClubsUpdated: 0, basicClubsUpdated: 0,
    standingsLeaguesUpdated: 0,
    changesDetected: [],
    skipped: [], // { stage, reasonJa } — 予算などで見送ったもの(正直に記録)
    agendaClubsApplied: priorityClubs.map((c) => c.nameEn), // 学習計画で優先したクラブ(実行の証拠)
    errors: [],
  };
  const canSpend = (n) => (apiBudget ? apiBudget.remainingForJob() >= BUDGET_FLOOR + n : true);
  const skip = (stage, reasonJa) => { stats.skipped.push({ stage, reasonJa }); };

  // ---- teamId の解決(調査ファイルに保存済みならAPIを呼ばない) ----
  async function resolveTeam(club) {
    const dossier = await clubDossier.getDossier(club.nameEn);
    if (dossier && dossier.teamId) return { teamId: dossier.teamId, dossier };
    if (!canSpend(1)) return { teamId: null, dossier, skipped: true };
    try {
      const data = await callApiFootball("/teams", { search: club.nameEn });
      const row = (data.response || [])[0];
      if (!row || !row.team) return { teamId: null, dossier };
      // /teams の応答には基本情報も含まれるので、同じ1リクエストで保存する
      await clubDossier.updateSection(club.nameEn, "basic", {
        founded: row.team.founded ?? null,
        countryEn: row.team.country ?? null,
        venueName: (row.venue && row.venue.name) || null,
        venueCity: (row.venue && row.venue.city) || null,
        venueCapacity: (row.venue && row.venue.capacity) || null,
        logo: row.team.logo || null,
      }, metaOf(club, row.team.id, runAt));
      return { teamId: row.team.id, dossier };
    } catch (e) {
      stats.errors.push(`universe_resolve_failed:${club.nameEn}:${e.code || e.message}`);
      return { teamId: null, dossier };
    }
  }

  function metaOf(club, teamId, at) {
    return {
      nameJa: club.nameJa, teamId, uefaRankSnapshot: club.rank,
      tier: tierOf(club), computedAt: at.toISOString(),
    };
  }

  // ============================================================
  // ① コア更新(フォーム・怪我・監督/布陣・移籍)
  // ============================================================
  // 優先クラブを先頭に置く(予算切れで打ち切られる場合も優先クラブは必ず処理される)。
  const coreRotation = clubsForCoreUpdate(dateKey);
  const coreClubs = [
    ...priorityClubs.filter((p) => !coreRotation.includes(p)),
    ...coreRotation.sort((a, b) => {
      const ap = priorityClubs.includes(a) ? 0 : 1;
      const bp = priorityClubs.includes(b) ? 0 : 1;
      return ap - bp || a.rank - b.rank;
    }),
  ];
  stats.coreClubsPlanned = coreClubs.length;
  // 順位表はリーグ単位でまとめて取るため、クラブ→リーグIDをここで集める
  const leagueTeams = new Map(); // leagueId -> [{club, teamId}]

  for (const club of coreClubs) {
    if (!canSpend(4)) { skip("core", `予算残量が安全ラインを下回ったため、${club.nameJa}以降のコア更新を見送りました。`); break; }
    try {
      const { teamId } = await resolveTeam(club);
      if (!teamId) { stats.errors.push(`universe_team_not_found:${club.nameEn}`); continue; }
      const meta = metaOf(club, teamId, runAt);

      // --- 直近試合 → フォーム・得点傾向・過密日程・ホームアウェイ ---
      let fixtures = [];
      try {
        const fx = await callApiFootball("/fixtures", { team: teamId, last: 10 });
        fixtures = fx.response || [];
        const form = computeFormScore(fixtures, teamId);
        const goals = computeGoalRateFeatures(fixtures, teamId);
        const fatigue = computeFatigueFeature(fixtures, runAt.getTime());
        const ha = computeHomeAwaySplit(fixtures, teamId);
        const recentResults = fixtures
          .filter((f) => f && f.fixture && f.fixture.status && f.fixture.status.short === "FT")
          .slice(0, 5)
          .map((f) => {
            const isHome = f.teams && f.teams.home && f.teams.home.id === teamId;
            const opp = isHome ? f.teams.away : f.teams.home;
            return {
              date: f.fixture.date ? f.fixture.date.slice(0, 10) : null,
              opponent: opp ? opp.name : null,
              homeAway: isHome ? "H" : "A",
              goalsFor: isHome ? f.goals.home : f.goals.away,
              goalsAgainst: isHome ? f.goals.away : f.goals.home,
            };
          });
        const r = await clubDossier.updateSection(club.nameEn, "form", {
          currentFormScore: form.currentFormScore, delta: form.delta, sampleSize: form.sampleSize,
          avgGoalsFor: goals.avgGoalsFor, avgGoalsAgainst: goals.avgGoalsAgainst,
          matchesLast7Days: fatigue.matchesLast7Days,
          homeWinRate: ha.home.winRate, awayWinRate: ha.away.winRate,
          homeSample: ha.home.sampleSize, awaySample: ha.away.sampleSize,
          recentResults,
        }, meta);
        await noteChanges(club, r.changesJa, "recentFormTrend", { formDelta: form.delta });
        // リーグID(静的に持っていなければ直近試合から逆算)
        const leagueId = club.leagueId || inferLeagueIdFromFixtures(fixtures);
        if (leagueId) {
          if (!leagueTeams.has(leagueId)) leagueTeams.set(leagueId, []);
          leagueTeams.get(leagueId).push({ club, teamId });
        }
      } catch (e) { stats.errors.push(`universe_form_failed:${club.nameEn}:${e.code || e.message}`); }

      // --- 怪我・出場停止 ---
      try {
        const inj = await callApiFootball("/injuries", { team: teamId, season });
        const injuryInfo = computeInjuryCountFeature(inj.response);
        const prevDossier = await clubDossier.getDossier(club.nameEn);
        const prevCount = prevDossier && prevDossier.sections.injuries
          ? prevDossier.sections.injuries.injuryCount : null;
        const r = await clubDossier.updateSection(club.nameEn, "injuries", {
          injuryCount: injuryInfo.injuryCount,
          injuredPlayers: injuryInfo.injuredPlayers || [],
          suspendedPlayers: injuryInfo.suspendedPlayers || [],
        }, meta);
        await noteChanges(club, r.changesJa, "injuries", {
          injuryCount: injuryInfo.injuryCount, previousInjuryCount: prevCount,
        });
      } catch (e) { stats.errors.push(`universe_injuries_failed:${club.nameEn}:${e.code || e.message}`); }

      // --- 監督・布陣(直近の終了済み試合のラインナップから) ---
      try {
        const finished = fixtures
          .filter((f) => f && f.fixture && f.fixture.status && f.fixture.status.short === "FT")
          .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))[0];
        if (finished) {
          const lu = await callApiFootball("/fixtures/lineups", { fixture: finished.fixture.id });
          const mine = (lu.response || []).find((row) => row.team && row.team.id === teamId);
          if (mine) {
            const r = await clubDossier.updateSection(club.nameEn, "coach", {
              coachName: (mine.coach && mine.coach.name) || null,
              formation: mine.formation || null,
              sourceFixtureDate: finished.fixture.date ? finished.fixture.date.slice(0, 10) : null,
            }, meta);
            await noteChanges(club, r.changesJa, "coachChange", {
              coachChanged: r.changesJa.some((c) => c.includes("監督が交代")),
              formationChanged: r.changesJa.some((c) => c.includes("布陣が変わり")),
            });
            if (knowledgeGraph && mine.coach && mine.coach.name) {
              await knowledgeGraph.addEdge({
                fromType: "team", fromId: club.nameEn, fromLabelJa: club.nameJa,
                relation: "manager", toType: "coach", toId: mine.coach.name,
              }).catch(() => {});
            }
          }
        }
      } catch (e) { stats.errors.push(`universe_lineup_failed:${club.nameEn}:${e.code || e.message}`); }

      // --- 移籍(直近30日) ---
      try {
        const tr = await callApiFootball("/transfers", { team: teamId });
        const since = new Date(runAt.getTime() - 30 * 86400000);
        const recent = summarizeTransfers(tr.response, teamId, 5, since);
        const r = await clubDossier.updateSection(club.nameEn, "transfers", {
          recent: recent.map((t) => ({ playerName: t.playerName, direction: t.direction, counterpart: t.counterpart, date: t.date ? String(t.date).slice(0, 10) : null })),
          countLast30Days: recent.length,
        }, meta);
        await noteChanges(club, r.changesJa, "transferImpact", {});
      } catch (e) { stats.errors.push(`universe_transfers_failed:${club.nameEn}:${e.code || e.message}`); }

      stats.coreClubsUpdated++;
    } catch (e) {
      stats.errors.push(`universe_core_failed:${club.nameEn}:${e.message}`);
    }
  }

  // ============================================================
  // ② 順位表(リーグ単位でまとめて1回ずつ)
  // ============================================================
  for (const [leagueId, entries] of leagueTeams) {
    if (!canSpend(1)) { skip("standings", "予算残量が安全ラインを下回ったため、残りのリーグの順位表更新を見送りました。"); break; }
    try {
      const data = await callApiFootball("/standings", { league: leagueId, season });
      for (const { club, teamId } of entries) {
        const st = computeStandingsFeature(data.response, teamId);
        if (st && st.position !== null) {
          const r = await clubDossier.updateSection(club.nameEn, "standings", {
            position: st.position, points: st.points, played: st.played,
            goalsForAvg: st.goalsForAvg, goalsAgainstAvg: st.goalsAgainstAvg,
            leagueId,
          }, metaOf(club, teamId, runAt));
          await noteChanges(club, r.changesJa, "standings", {});
        }
      }
      stats.standingsLeaguesUpdated++;
    } catch (e) { stats.errors.push(`universe_standings_failed:league${leagueId}:${e.code || e.message}`); }
  }

  // ============================================================
  // ③ 選手名簿(7日で全クラブ一巡)
  // ============================================================
  const squadClubs = clubsForSquadSync(dateKey);
  stats.squadsPlanned = squadClubs.length;
  for (const club of squadClubs) {
    if (!canSpend(1)) { skip("squad", `予算残量が安全ラインを下回ったため、${club.nameJa}以降の名簿更新を見送りました。`); break; }
    try {
      const { teamId } = await resolveTeam(club);
      if (!teamId) continue;
      const sq = await callApiFootball("/players/squads", { team: teamId });
      const row = (sq.response || [])[0];
      const players = ((row && row.players) || []).map((p) => ({
        id: p.id, name: p.name, age: p.age ?? null,
        number: p.number ?? null, position: p.position || null, photo: p.photo || null,
      }));
      if (players.length) {
        const r = await clubDossier.updateSection(club.nameEn, "squad", { players, count: players.length }, metaOf(club, teamId, runAt));
        await noteChanges(club, r.changesJa, "transferImpact", {});
        // 名簿の基本情報(ポジション・年齢)を選手記録にも反映する
        for (const p of players) {
          await clubDossier.savePlayer({
            id: p.id, name: p.name, teamEn: club.nameEn, teamJa: club.nameJa,
            position: p.position, age: p.age, number: p.number,
          }).then((res) => { if (res.saved) stats.playersUpdated++; }).catch(() => {});
        }
      }
      stats.squadsUpdated++;
    } catch (e) { stats.errors.push(`universe_squad_failed:${club.nameEn}:${e.code || e.message}`); }
  }

  // ============================================================
  // ④ 選手の詳細成績(名簿から輪番。予算内で1日あたり上限N人)
  // ============================================================
  // 保存済みの名簿から、更新が最も古い選手を優先して選ぶ。
  // 1人=1リクエスト。UNIVERSE_PLAYER_CAP(既定300)まで。
  try {
    const cap = PLAYER_CAP_DEFAULT;
    const candidates = [];
    for (const club of CLUB_UNIVERSE) {
      const d = await clubDossier.getDossier(club.nameEn);
      const squad = d && d.sections.squad && d.sections.squad.players;
      if (!squad) continue;
      for (const p of squad) candidates.push({ club, playerId: p.id, name: p.name });
    }
    stats.playersPlanned = Math.min(cap, candidates.length);
    // 更新の古い順に並べる(記録が無い選手を最優先)
    const withAge = [];
    for (const c of candidates) {
      const rec = await clubDossier.getPlayer(c.playerId);
      withAge.push({ ...c, updatedAt: rec && rec.statsUpdatedAt ? rec.statsUpdatedAt : "" });
    }
    withAge.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    let done = 0;
    for (const c of withAge) {
      if (done >= cap) break;
      if (!canSpend(1)) { skip("playerStats", `予算残量が安全ラインを下回ったため、選手の詳細成績の更新を${done}人で打ち切りました(残り${withAge.length - done}人は明日以降)。`); break; }
      try {
        const data = await callApiFootball("/players", { id: c.playerId, season });
        const entry = (data.response || [])[0];
        if (!entry || !entry.statistics || !entry.statistics.length) { done++; continue; }
        const best = entry.statistics.reduce((acc, cur) =>
          (((cur.games && cur.games.appearences) || 0) > ((acc.games && acc.games.appearences) || 0) ? cur : acc), entry.statistics[0]);
        const real = computePlayerRealStats(best) || {};
        await clubDossier.savePlayer({
          id: c.playerId, name: c.name, teamEn: c.club.nameEn, teamJa: c.club.nameJa,
          nationality: (entry.player && entry.player.nationality) || null,
          height: (entry.player && entry.player.height) || null,
          birthDate: (entry.player && entry.player.birth && entry.player.birth.date) || null,
          position: real.position || null,
          stats: {
            appearances: (best.games && best.games.appearences) ?? null,
            minutes: (best.games && best.games.minutes) ?? null,
            rating: best.games && best.games.rating ? Math.round(parseFloat(best.games.rating) * 100) / 100 : null,
            goals: (best.goals && best.goals.total) ?? null,
            assists: (best.goals && best.goals.assists) ?? null,
            keyPasses: real.keyPasses ?? null,
            passAccuracyPct: real.passAccuracyPct ?? null,
            dribbleSuccessRatePct: real.dribbleSuccessRatePct ?? null,
            defensiveActions: real.defensiveActions ?? null,
            duelWinRatePct: real.duelWinRatePct ?? null,
            season,
          },
          statsUpdatedAt: runAt.toISOString(),
        });
        stats.playersUpdated++;
        done++;
      } catch (e) {
        if (e && e.code === "BUDGET_EXHAUSTED") { skip("playerStats", "APIの1日予算に達したため、選手の詳細成績の更新を打ち切りました。"); break; }
        stats.errors.push(`universe_player_failed:${c.name}:${e.code || e.message}`);
        done++;
      }
    }
  } catch (e) { stats.errors.push(`universe_players_failed:${e.message}`); }

  // ============================================================
  // ⑤ xG(tier Aのみ・7日で一巡。1クラブ5リクエストと高価)
  // ============================================================
  // ご指示⑩: 学習計画の優先クラブは、tier Bでも輪番外でも今日のxG更新に加える
  // (xGは1クラブ5リクエストと高価なため、優先追加は最大3クラブに制限)。
  const xgRotation = clubsForXgUpdate(dateKey);
  const xgClubs = [
    ...priorityClubs.filter((p) => !xgRotation.includes(p)).slice(0, 3),
    ...xgRotation,
  ];
  for (const club of xgClubs) {
    if (!canSpend(5)) { skip("xg", `予算残量が安全ラインを下回ったため、${club.nameJa}以降のxG更新を見送りました。`); break; }
    try {
      const { teamId } = await resolveTeam(club);
      if (!teamId) continue;
      const fx = await callApiFootball("/fixtures", { team: teamId, last: 10 });
      const xg = await fetchTeamXgAverage(fx.response || [], teamId, callApiFootball, { limit: 5 });
      if (xg && xg.xgNet !== null) {
        await clubDossier.updateSection(club.nameEn, "xg", {
          xgNet: xg.xgNet, xgFor: xg.xgFor ?? null, xgAgainst: xg.xgAgainst ?? null,
          sampleSize: xg.sampleSize ?? null,
        }, metaOf(club, teamId, runAt));
        stats.xgClubsUpdated++;
      }
    } catch (e) { stats.errors.push(`universe_xg_failed:${club.nameEn}:${e.code || e.message}`); }
  }

  // ============================================================
  // ⑥ 基本情報(28日で一巡。resolveTeamの/teams応答で自動更新されるため、
  //    ここでは「調査ファイルがまだ無いクラブ」を拾う役割)
  // ============================================================
  for (const club of clubsForBasicInfo(dateKey)) {
    if (!canSpend(1)) { skip("basic", "予算残量が安全ラインを下回ったため、基本情報の更新を見送りました。"); break; }
    const d = await clubDossier.getDossier(club.nameEn);
    if (d && d.sections.basic) continue; // 既にある(resolveTeamで更新される)
    await resolveTeam(club).catch(() => {});
    stats.basicClubsUpdated++;
  }

  return stats;

  // ---- 差分を知識・重要度・時系列へ流す共通処理 ----
  async function noteChanges(club, changesJa, category, extraSignals) {
    for (const changeJa of changesJa || []) {
      stats.changesDetected.push({ club: club.nameJa, changeJa });
      // 文章の知識として保存(変化があった時だけなので重複しない)
      if (typeof recordLearned === "function") {
        await recordLearned({
          teamEn: club.nameEn, teamJa: club.nameJa, category, type: "fact",
          statement: changeJa + "。",
          computedAt: runAt.toISOString(), source: "API-Footballの実データ(日次の宇宙収集)",
        }, extraSignals).catch(() => {});
      }
      // 大きな変化(監督交代・怪我の急増)は「考えが変わったきっかけ」として時系列へ
      if (thoughtTimeline && (changeJa.includes("監督が交代") || /負傷.*増え/.test(changeJa))) {
        await thoughtTimeline.append(`team:${club.nameEn}:beliefs`, {
          kind: "trigger", statementJa: changeJa, evidence: [changeJa], at: runAt.toISOString(),
        }).catch(() => {});
      }
    }
  }
}

module.exports = { collectUniverse, BUDGET_FLOOR, PLAYER_CAP_DEFAULT, seasonOf };
