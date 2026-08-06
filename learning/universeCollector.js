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
 *   コア更新: 100クラブ × 4リクエスト(試合・怪我・布陣・移籍) = 400
 *             (2026年8月・最終方針: tier Bも毎日へ格上げ。旧: 約70クラブ≒280)
 *   順位表  : リーグ単位でまとめて取得 ≒ 10〜20
 *   名簿    : 約15クラブ × 1 ≒ 15
 *   xG      : 約6クラブ × 5 ≒ 30
 *   選手詳細: 上限300人 × 1 = 300(UNIVERSE_PLAYER_CAP で調整可)
 *   合計 ≒ 770/日。既存の学習(登録11クラブ・リーグ・107選手)と合わせても
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
  searchVariantsOf, pickBestTeamMatch,
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
    playersIndexed: 0, // 画面の選手検索から引ける状態になった人数(実測)
    // 2026年8月・第三者監査の指摘: playersUpdated は「名簿同期」と「詳細成績」の
    //   両方が加算していたため、自己改善ループが playerDetailCap の効果を測るとき、
    //   その日たまたま輪番に当たった名簿の人数(数百人)に完全に埋もれていた。
    //   内訳を分け、効果測定には詳細成績ぶんだけを使う。
    playersFromSquadSync: 0,
    playersFromDetailStats: 0,
    xgClubsUpdated: 0, basicClubsUpdated: 0,
    standingsLeaguesUpdated: 0,
    changesDetected: [],
    skipped: [], // { stage, reasonJa } — 予算などで見送ったもの(正直に記録)
    unresolvedClubs: [], // 名前が照合できず収集できなかったクラブ(データ提供元の表記差。正直に開示)
    agendaClubsApplied: priorityClubs.map((c) => c.nameEn), // 学習計画で優先したクラブ(実行の証拠)
    errors: [],
  };
  const canSpend = (n) => (apiBudget ? apiBudget.remainingForJob() >= BUDGET_FLOOR + n : true);
  const skip = (stage, reasonJa) => { stats.skipped.push({ stage, reasonJa }); };

  // ---- 第8次監査(Medium)の修正: 同日の再実行ガード ----
  // 輪番は日付で決まるため、同日に再実行すると全く同じ収集(コア約70クラブ×4
  // リクエスト等)を丸ごと繰り返し、同じデータの取り直しにAPI予算を浪費していた
  // (1日14回実行の実績あり)。同日2回目以降はコア/順位/名簿/xG/基本情報を見送り、
  // 選手詳細(更新の古い順に前進する)だけを続行する。
  let alreadyRanToday = false;
  if (deps.upstashGetJSON) {
    const ran = await deps.upstashGetJSON(`kb:universe:ran:${dateKey}`).catch(() => null);
    if (ran && ran.ranAt) {
      alreadyRanToday = true;
      stats.sameDayRerun = true;
      skip("core", `本日${String(ran.ranAt).slice(11, 16)}(UTC)に収集済みのため、コア更新・順位表・名簿・xG・基本情報の再取得を見送りました(選手詳細の輪番のみ続行)。`);
    }
  }
  // 同一実行内での/fixtures二度取り防止(コア更新で取得した直近試合をxGステージが再利用)
  const fixturesCache = new Map(); // teamId -> fixtures[]

  // ---- teamId の解決(調査ファイルに保存済みならAPIを呼ばない) ----
  // ---- 2026年8月・本番エラー調査で判明した欠陥の修正(+第三者監査での再修正) ----
  //   従来は club.nameEn をそのまま1回だけ /teams?search= に渡し、結果の先頭を
  //   無条件に採用していた。本番で3クラブが恒久的に収集不能になっていた:
  //     ・"Bodo/Glimt" / "Union St. Gilloise" … "/" "." をAPI側が受け付けずAPI_ERROR
  //     ・"Red Star Belgrade" … API-Football側の表記が "Crvena Zvezda" のため0件
  //   しかも失敗を覚えないため、毎日同じ失敗を繰り返して予算を消費していた。
  //   ①APIが受け付ける表記の候補を順に試す(すべて英数字と空白のみ)
  //   ②B/女子/ユースを除外し、名前が一致するクラブを選ぶ
  //   ③「検索は成立したが一致が無い」場合だけ7日間の否定キャッシュで再試行を止める
  //     (通信・API障害は一時的なものなのでキャッシュしない=自己修復する)
  const unresolvedSeen = new Set(); // 同一実行内で同じクラブを二重に数えない
  function markUnresolved(club, reasonJa) {
    if (unresolvedSeen.has(club.nameEn)) return;
    unresolvedSeen.add(club.nameEn);
    stats.unresolvedClubs.push({ nameEn: club.nameEn, nameJa: club.nameJa, reasonJa });
  }

  async function resolveTeam(club) {
    const dossier = await clubDossier.getDossier(club.nameEn);
    if (dossier && dossier.teamId) return { teamId: dossier.teamId, dossier };

    // 否定キャッシュ(直近7日以内に全候補で照合できなかったクラブは再試行しない)
    const failKey = `kb:club:resolvefail:${club.nameEn}`;
    if (deps.upstashGetJSON) {
      const failed = await deps.upstashGetJSON(failKey).catch(() => null);
      if (failed) {
        markUnresolved(club, "直近7日以内に名前を照合できなかったため、今日は再試行を見送りました(7日後に自動で再挑戦します)。");
        return { teamId: null, dossier, unresolved: true };
      }
    }

    const variants = searchVariantsOf(club);
    let sawSuccessfulSearch = false; // 1度でも検索が成立したか(=API側は正常)
    let lastError = null;
    for (const term of variants) {
      if (!canSpend(1)) {
        skip("resolve", `API予算の残量が安全ラインを下回ったため、${club.nameJa}の照合を見送りました。`);
        return { teamId: null, dossier, skipped: true };
      }
      try {
        const data = await callApiFootball("/teams", { search: term });
        sawSuccessfulSearch = true;
        const row = pickBestTeamMatch(data.response, club);
        if (!row) continue; // この表記では見つからなかった → 次の候補へ
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
        lastError = e;
        if (e && e.code === "BUDGET_EXHAUSTED") {
          skip("resolve", `API予算を使い切ったため、${club.nameJa}の照合を見送りました。`);
          return { teamId: null, dossier, skipped: true };
        }
      }
    }

    if (!sawSuccessfulSearch) {
      // 一度も検索が成立しなかった = 通信・API側の一時的な問題。
      // 否定キャッシュには入れない(次回そのまま再挑戦して自己修復する)。
      stats.errors.push(`universe_resolve_failed:${club.nameEn}:${(lastError && (lastError.code || lastError.message)) || "unknown"}`);
      return { teamId: null, dossier };
    }
    // 検索は成立したのに一致が無い = データ提供元の表記差。エラーではなく
    // 「照合できないクラブ」として明示し、7日間は再試行しない。
    markUnresolved(club, `データ提供元(API-Football)で「${club.nameEn}」に一致するクラブを見つけられませんでした(表記差の可能性)。7日後に自動で再挑戦します。`);
    if (deps.upstashCmd) {
      // SETとEXPIREを分けると、間で失敗した場合にTTLの無いキーが残り
      // 「7日後に再挑戦」の約束が守られない(監査での指摘)。必ず一括で書く。
      await deps.upstashCmd(["SET", failKey, JSON.stringify({ failedAt: runAt.toISOString(), nameEn: club.nameEn }), "EX", String(7 * 86400)]).catch(() => {});
    }
    return { teamId: null, dossier, unresolved: true };
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
  const coreRotation = alreadyRanToday ? [] : clubsForCoreUpdate(dateKey);
  const coreClubs = alreadyRanToday ? [] : [
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
      // 未解決(表記差)・予算切れは resolveTeam 側で正直に記録済みのため、
      // ここで重ねてエラーにはしない(同じ事象が二重に「エラー」と数えられ、
      // 「エラーが原因で件数が少ない」という誤った表示につながっていた)。
      if (!teamId) continue;
      const meta = metaOf(club, teamId, runAt);

      // --- 直近試合 → フォーム・得点傾向・過密日程・ホームアウェイ ---
      let fixtures = [];
      try {
        const fx = await callApiFootball("/fixtures", { team: teamId, last: 10 });
        fixtures = fx.response || [];
        fixturesCache.set(teamId, fixtures); // xGステージが再利用(同一実行内の二度取り防止)
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
  const squadClubs = alreadyRanToday ? [] : clubsForSquadSync(dateKey);
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
          }).then((res) => { if (res.saved) { stats.playersUpdated++; stats.playersFromSquadSync++; } }).catch(() => {});
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
    // 自己改善ループ: 上限はAI自身が150〜400の安全範囲で調整できる(既定300)
    const cap = (deps.tune && Number.isFinite(deps.tune.playerDetailCap))
      ? Math.max(150, Math.min(400, deps.tune.playerDetailCap))
      : PLAYER_CAP_DEFAULT;
    const candidates = [];
    // ---- 2026年8月・「選手スカウティングへの登録」調査での追加 ----
    // 収集済みの選手を画面から名前で引けるようにする索引をここで作る。
    // 名簿(squad)は既に全クラブぶんこのループで読んでいるので、
    // **追加のAPI呼び出しもRedis読み出しも一切増えない**。
    const searchIndex = {};
    for (const club of CLUB_UNIVERSE) {
      const d = await clubDossier.getDossier(club.nameEn);
      const squad = d && d.sections.squad && d.sections.squad.players;
      if (!squad) continue;
      for (const p of squad) {
        candidates.push({ club, playerId: p.id, name: p.name });
        if (p.id && p.name) {
          // 圧縮形式 "name|teamEn|teamJa|position"(区切り文字は名前から除去済み)
          searchIndex[p.id] = [
            String(p.name).replace(/\|/g, " "),
            club.nameEn, club.nameJa || "", p.position || "",
          ].join("|");
        }
      }
    }
    stats.playersIndexed = Object.keys(searchIndex).length;
    if (stats.playersIndexed > 0) {
      const savedIdx = await clubDossier.saveSearchIndex(searchIndex);
      if (!savedIdx) stats.errors.push("universe_player_index_save_failed");
    }
    stats.playersPlanned = Math.min(cap, candidates.length);
    // ---- 第8次監査(Critical)の修正 ----
    // 従来は「更新の古い順」を知るためだけに候補全員(数千人)の記録を
    // 1件ずつ読んでいた(1日数千Redisコマンド。選手3万人規模では無料枠を
    // 単独で超過)。playerId→statsUpdatedAtの索引1キー(読み1回・書き1回)に変更。
    const statsIndex = await clubDossier.getStatsIndex();
    const withAge = candidates.map((c) => ({ ...c, updatedAt: statsIndex[c.playerId] || "" }));
    withAge.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    let done = 0;
    let indexDirty = false;
    for (const c of withAge) {
      if (done >= cap) break;
      if (!canSpend(1)) { skip("playerStats", `予算残量が安全ラインを下回ったため、選手の詳細成績の更新を${done}人で打ち切りました(残り${withAge.length - done}人は明日以降)。`); break; }
      try {
        const data = await callApiFootball("/players", { id: c.playerId, season });
        const entry = (data.response || [])[0];
        if (!entry || !entry.statistics || !entry.statistics.length) {
          // 統計が無い選手(第3GK等)も輪番を前進させる(毎日同じ選手で空振りしないため)。
          // 選手記録そのものには「無い統計」を書かない(でっち上げ防止)。
          statsIndex[c.playerId] = runAt.toISOString();
          indexDirty = true;
          done++; continue;
        }
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
        statsIndex[c.playerId] = runAt.toISOString();
        indexDirty = true;
        stats.playersUpdated++;
        stats.playersFromDetailStats++;
        done++;
      } catch (e) {
        if (e && e.code === "BUDGET_EXHAUSTED") { skip("playerStats", "APIの1日予算に達したため、選手の詳細成績の更新を打ち切りました。"); break; }
        stats.errors.push(`universe_player_failed:${c.name}:${e.code || e.message}`);
        done++;
      }
    }
    if (indexDirty) await clubDossier.saveStatsIndex(statsIndex);
  } catch (e) { stats.errors.push(`universe_players_failed:${e.message}`); }

  // ============================================================
  // ⑤ xG(tier Aのみ・7日で一巡。1クラブ5リクエストと高価)
  // ============================================================
  // ご指示⑩: 学習計画の優先クラブは、tier Bでも輪番外でも今日のxG更新に加える
  // (xGは1クラブ5リクエストと高価なため、優先追加は最大3クラブに制限)。
  const xgRotation = alreadyRanToday ? [] : clubsForXgUpdate(dateKey, deps.tune && deps.tune.xgRotationDays);
  const xgClubs = alreadyRanToday ? [] : [
    ...priorityClubs.filter((p) => !xgRotation.includes(p)).slice(0, 3),
    ...xgRotation,
  ];
  for (const club of xgClubs) {
    if (!canSpend(5)) { skip("xg", `予算残量が安全ラインを下回ったため、${club.nameJa}以降のxG更新を見送りました。`); break; }
    try {
      const { teamId } = await resolveTeam(club);
      if (!teamId) continue;
      // 第8次監査(Medium)の修正: xG対象(tier A)は同日のコア更新で/fixturesを取得済み。
      // 同一実行内の二度取りをやめ、キャッシュを再利用する(無ければ取得)。
      let xgFixtures = fixturesCache.get(teamId);
      if (!xgFixtures) {
        const fx = await callApiFootball("/fixtures", { team: teamId, last: 10 });
        xgFixtures = fx.response || [];
      }
      const xg = await fetchTeamXgAverage(xgFixtures, teamId, callApiFootball, { limit: 5 });
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
  for (const club of (alreadyRanToday ? [] : clubsForBasicInfo(dateKey))) {
    if (!canSpend(1)) { skip("basic", "予算残量が安全ラインを下回ったため、基本情報の更新を見送りました。"); break; }
    const d = await clubDossier.getDossier(club.nameEn);
    if (d && d.sections.basic) continue; // 既にある(resolveTeamで更新される)
    await resolveTeam(club).catch(() => {});
    stats.basicClubsUpdated++;
  }

  // 同日再実行ガード用の実施記録(2日で自動失効)。初回実行時のみ書く。
  if (!alreadyRanToday) {
    try {
      if (deps.upstashCmd) {
        await deps.upstashCmd(["SET", `kb:universe:ran:${dateKey}`, JSON.stringify({ ranAt: runAt.toISOString() }), "EX", "172800"]);
      } else if (deps.upstashSetJSON) {
        await deps.upstashSetJSON(`kb:universe:ran:${dateKey}`, { ranAt: runAt.toISOString() });
      }
    } catch (e) { /* 記録できなくても収集自体は完了している */ }
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
