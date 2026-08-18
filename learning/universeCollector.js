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
const playerSearch = require("../knowledge/playerSearch");

// 予算の安全弁: 残りがこの件数を下回ったら、その日の宇宙収集は打ち切る
// (既存の学習ジョブや利用者のリクエストを圧迫しないため)。
const BUDGET_FLOOR = Number(process.env.UNIVERSE_BUDGET_FLOOR) || 150;
const PLAYER_CAP_DEFAULT = Number(process.env.UNIVERSE_PLAYER_CAP) || 300;

// ---- 2026年8月・「取得した選手をすべて選手スカウティングへ」への対応 ----
// クラブ単位の一括取得 /players?team=&season=&page= は、1リクエストで20人ぶんの
// **成績つき**の選手情報を返す。1クラブ2〜3ページ(=2〜3リクエスト)で
// 全所属選手の成績が揃うため、従来の「1人1リクエスト・1日300人」に比べて
// 桁違いに効率が良い(100クラブ ≒ 250リクエストで約2,500人)。
// 従来の1人ずつの詳細取得は**残したまま**併用する
// (最終方針①劣化禁止・③データ取得量の削減は禁止)。
const BULK_PAGE_LIMIT = Number(process.env.UNIVERSE_BULK_PAGE_LIMIT) || 4;   // 1クラブあたり最大ページ数(=最大80人)
const BULK_CLUB_LIMIT = Number(process.env.UNIVERSE_BULK_CLUB_LIMIT) || 100; // 1日あたり一括取得するクラブ数

function seasonOf(runAt) {
  const m = runAt.getMonth() + 1;
  return m >= 7 ? runAt.getFullYear() : runAt.getFullYear() - 1;
}

// 索引の2行が「実質的に同じ」か。updatedAt など毎日必ず変わる列は無視する。
// ここで differ と判定されたものだけを保存・速報の対象にするため、判定を
// 誤ると Redis のコマンド数がそのまま増える(=判定は保守的に厳密にする)。
const ROW_COMPARE_COLS = (() => {
  const C = playerSearch.COL;
  return [C.name, C.teamEn, C.teamJa, C.leagueId, C.nationality, C.position,
    C.age, C.heightCm, C.minutes, C.goals, C.assists, C.rating, C.injured,
    C.detailedPos, C.appearances, C.number, C.keyPasses, C.passAccuracyPct,
    C.dribbleSuccessRatePct, C.defensiveActions, C.duelWinRatePct,
    C.yellowCards, C.redCards];
})();
function rowsEquivalent(a, b) {
  if (!a || !b) return false;
  for (const c of ROW_COMPARE_COLS) {
    const av = a[c] === undefined ? null : a[c];
    const bv = b[c] === undefined ? null : b[c];
    if (av !== bv) return false;
  }
  return true;
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

  // ---- 2026年8月・選手スカウティング刷新のための「ただ乗り」収集 ----
  //  以下の2つは、**既に毎日取得しているレスポンスの中に入っているのに
  //  捨てていた情報**である。拾うだけなので追加のAPIコールは0件。
  //   ・/injuries    → 負傷者の playerId(これまで名前しか使っていなかった)
  //   ・/fixtures/lineups → スタメンの grid(配置)。細かいポジションの推定に使う
  const injuredIds = new Set();          // 今日、負傷者リストに載っていた選手ID
  const injuryCheckedClubs = new Set();  // 今日、負傷者リストを実際に確認できたクラブ(nameEn)
  const gridUpdates = new Map();         // playerId -> { grid, maxRow }(今日ぶん)
  const savedTodayIds = new Set();       // 今日 savePlayer を通した選手(速報の二重計上を防ぐ)
  const injuryRowsToday = [];            // 怪我の履歴(/injuries の中身。追加コスト0)
  const transferRowsToday = [];          // 移籍の履歴(/transfers の中身。追加コスト0)
  const recent5ByPlayer = new Map();     // playerId -> 直近5試合の実測
  const squadOnlyPending = [];           // 名簿で見つけた選手(一括取得で拾えなければ後で保存する)
  const emittedByPlayer = new Map();     // playerId -> savePlayer が実際に出した速報の種類

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

  // ---- 2026年8月の監査で発見: 同じクラブの調査ファイルを1回の実行で何度も読んでいた ----
  // resolveTeam は コア更新・一括取得・名簿・xG・基本情報 の各ステージから
  // 呼ばれ、そのたびに getDossier(=Redis GET 1回)を発行していた。
  // 100クラブ×5ステージ = 500コマンドが、同じ内容の読み直しに使われていた。
  // 1回の実行の中でクラブの teamId は変わらないので、実行内で覚えておく。
  const teamResolveMemo = new Map(); // nameEn -> { teamId, dossier }
  async function resolveTeam(club) {
    const memo = teamResolveMemo.get(club.nameEn);
    if (memo) return memo;
    const dossier = await clubDossier.getDossier(club.nameEn);
    if (dossier && dossier.teamId) {
      const hit = { teamId: dossier.teamId, dossier };
      teamResolveMemo.set(club.nameEn, hit);
      return hit;
    }

    // 否定キャッシュ(直近7日以内に全候補で照合できなかったクラブは再試行しない)
    const failKey = `kb:club:resolvefail:${club.nameEn}`;
    if (deps.upstashGetJSON) {
      const failed = await deps.upstashGetJSON(failKey).catch(() => null);
      if (failed) {
        markUnresolved(club, "直近7日以内に名前を照合できなかったため、今日は再試行を見送りました(7日後に自動で再挑戦します)。");
        const miss = { teamId: null, dossier, unresolved: true };
        teamResolveMemo.set(club.nameEn, miss);
        return miss;
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
        const hit = { teamId: row.team.id, dossier };
        teamResolveMemo.set(club.nameEn, hit);
        return hit;
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
      const miss = { teamId: null, dossier };
      teamResolveMemo.set(club.nameEn, miss);
      return miss;
    }
    // 検索は成立したのに一致が無い = データ提供元の表記差。エラーではなく
    // 「照合できないクラブ」として明示し、7日間は再試行しない。
    markUnresolved(club, `データ提供元(API-Football)で「${club.nameEn}」に一致するクラブを見つけられませんでした(表記差の可能性)。7日後に自動で再挑戦します。`);
    if (deps.upstashCmd) {
      // SETとEXPIREを分けると、間で失敗した場合にTTLの無いキーが残り
      // 「7日後に再挑戦」の約束が守られない(監査での指摘)。必ず一括で書く。
      await deps.upstashCmd(["SET", failKey, JSON.stringify({ failedAt: runAt.toISOString(), nameEn: club.nameEn }), "EX", String(7 * 86400)]).catch(() => {});
    }
    const miss = { teamId: null, dossier, unresolved: true };
    teamResolveMemo.set(club.nameEn, miss);
    return miss;
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
        // 追加コスト0: 同じレスポンスから選手IDを拾い、検索の「怪我の有無」に使う
        injuryCheckedClubs.add(club.nameEn);
        for (const r of (inj.response || [])) {
          const pid = r && r.player && r.player.id;
          if (!pid) continue;
          injuredIds.add(Number(pid));
          // 怪我の履歴(詳細画面用)。これも同じレスポンスの中にある情報。
          injuryRowsToday.push({
            playerId: Number(pid),
            reasonJa: (r.player && r.player.reason) || null,
            typeJa: (r.player && r.player.type) || null,
            at: (r.fixture && r.fixture.date) ? String(r.fixture.date).slice(0, 10) : dateKey,
            teamEn: club.nameEn, teamJa: club.nameJa,
          });
        }
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
            // 追加コスト0: スタメンの配置(grid "行:列")を拾う。
            // API-Footballのポジションは Goalkeeper/Defender/Midfielder/Attacker の
            // 4分類しか無いため、CB/SB/DMF/CMF/AMF/WG/CF の細分はここからしか作れない。
            const startXI = Array.isArray(mine.startXI) ? mine.startXI : [];
            let maxRow = 0;
            const colsByRow = new Map();  // 行 -> その行に並んだ列番号
            for (const s of startXI) {
              const g = s && s.player && s.player.grid;
              const m = g ? String(g).match(/^(\d+)\s*:\s*(\d+)$/) : null;
              if (!m) continue;
              const r = Number(m[1]), c = Number(m[2]);
              maxRow = Math.max(maxRow, r);
              const arr = colsByRow.get(r) || [];
              arr.push(c);
              colsByRow.set(r, arr);
            }
            for (const s of startXI) {
              const pid = s && s.player && s.player.id;
              const g = s && s.player && s.player.grid;
              const m = g ? String(g).match(/^(\d+)\s*:\s*(\d+)$/) : null;
              if (!pid || !m) continue;
              const r = Number(m[1]), c = Number(m[2]);
              const cols = colsByRow.get(r) || [c];
              // 「端」= その行の最小列か最大列。ただし2人しか並んでいない行は
              // 全員が端になってしまうので判定しない(CBの2枚をSBにしないため)。
              const isEdge = cols.length >= 3 && (c === Math.min(...cols) || c === Math.max(...cols));
              gridUpdates.set(Number(pid), { grid: String(g), maxRow, isEdge, fixtureId: finished.fixture.id });
            }
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
        // 追加コスト0: 選手ごとの移籍履歴(詳細画面用)。同じレスポンスの中にある。
        for (const row of (tr.response || [])) {
          const pid = row && row.player && row.player.id;
          if (!pid) continue;
          for (const mv of (row.transfers || []).slice(0, 6)) {
            transferRowsToday.push({
              playerId: Number(pid),
              date: mv.date ? String(mv.date).slice(0, 10) : null,
              fromEn: (mv.teams && mv.teams.out && mv.teams.out.name) || null,
              toEn: (mv.teams && mv.teams.in && mv.teams.in.name) || null,
              typeJa: mv.type || null,
            });
          }
        }
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
        // 名簿の基本情報(ポジション・年齢)を選手記録にも反映する。
        // ---- 2026年8月の監査を受けた変更 ----
        // ここで即座に savePlayer を呼ぶと、直後のクラブ単位一括取得(③-b)が
        // **同じ選手をより多くの情報で上書きする** ため、1人あたり
        // 「読み+書き」が二重に発生していた(名簿輪番だけで1日約1,300コマンド)。
        // 保存自体はやめず、③-b の結果が出てから「一括取得で拾えなかった選手だけ」
        // を保存する。取得する情報は一切減らしていない。
        for (const p of players) {
          if (p && p.id) {
            squadOnlyPending.push({
              id: p.id, name: p.name, teamEn: club.nameEn, teamJa: club.nameJa,
              leagueId: club.leagueId || null,
              position: p.position, age: p.age, number: p.number,
            });
          }
        }
      }
      stats.squadsUpdated++;
    } catch (e) { stats.errors.push(`universe_squad_failed:${club.nameEn}:${e.code || e.message}`); }
  }

  // ============================================================
  // ③-b 全所属選手の成績を「クラブ単位で一括取得」(2026年8月・新設)
  // ============================================================
  // ご要望①「毎日取得している選手データをすべて選手スカウティングへ自動登録」
  // への対応の中心。従来は /players?id=<選手> を1人1リクエストで回していたため、
  // 1日300人=全選手(約2,500人)を一巡するのに8〜9日かかっていた。
  // /players?team=<クラブ>&season=&page= は **1リクエストで20人ぶんの成績** を返す。
  // 100クラブ × 2〜3ページ ≒ 250リクエストで、全所属選手の成績が**毎日**揃う。
  //
  // ※ 従来の1人ずつの詳細取得(④)は削除せず併用する。
  //    最終方針③「データ取得量・更新頻度・学習量の削減は禁止」に従い、
  //    これは**置き換えではなく追加**である。
  const bulkPlayers = new Map(); // playerId -> { record, club }
  stats.bulkClubsPlanned = 0;
  stats.bulkClubsFetched = 0;
  stats.bulkPlayersFetched = 0;
  stats.bulkRequests = 0;
  const bulkClubs = alreadyRanToday ? [] : CLUB_UNIVERSE.slice(0, Math.max(1, BULK_CLUB_LIMIT));
  stats.bulkClubsPlanned = bulkClubs.length;
  for (const club of bulkClubs) {
    if (!canSpend(2)) {
      skip("bulkPlayers", `予算残量が安全ラインを下回ったため、${club.nameJa}以降の「クラブ単位の選手一括取得」を見送りました(見送ったぶんは翌日に回ります)。`);
      break;
    }
    try {
      const { teamId } = await resolveTeam(club);
      if (!teamId) continue;
      let page = 1;
      let totalPages = 1;
      let fetchedForClub = 0;
      let stoppedReason = null;
      while (page <= Math.min(totalPages, BULK_PAGE_LIMIT)) {
        if (!canSpend(1)) { stoppedReason = "budget"; break; }
        const data = await callApiFootball("/players", { team: teamId, season, page });
        stats.bulkRequests++;
        const paging = data && data.paging;
        const t = paging && Number(paging.total);
        if (Number.isFinite(t) && t > 0) totalPages = t;
        const rows = (data && data.response) || [];
        if (!rows.length) break;
        for (const entry of rows) {
          const pl = entry && entry.player;
          if (!pl || !pl.id) continue;
          const list = Array.isArray(entry.statistics) ? entry.statistics : [];
          // 出場数が最も多い大会の成績を代表値にする(既存④と同じ基準)
          const best = list.length
            ? list.reduce((acc, cur) =>
              (((cur.games && cur.games.appearences) || 0) > ((acc.games && acc.games.appearences) || 0) ? cur : acc), list[0])
            : null;
          const real = best ? (computePlayerRealStats(best) || {}) : {};
          bulkPlayers.set(Number(pl.id), {
            id: Number(pl.id),
            name: pl.name || null,
            teamEn: club.nameEn, teamJa: club.nameJa,
            leagueId: club.leagueId || null,
            nationality: pl.nationality || null,
            height: pl.height || null,
            birthDate: (pl.birth && pl.birth.date) || null,
            age: Number.isFinite(Number(pl.age)) ? Number(pl.age) : null,
            position: real.position || (best && best.games && best.games.position) || null,
            // 成績が1件も無い選手(新加入で未出場など)も **登録はする**。
            // 数値は0で埋めず null のままにして「まだ出場していない/取得できていない」
            // ことが分かるようにする(でっち上げ防止)。
            stats: best ? {
              appearances: (best.games && best.games.appearences) ?? null,
              // スタメン出場数。同じ応答に入っているのに使っていなかった(追加コスト0)
              lineups: (best.games && best.games.lineups) ?? null,
              minutes: (best.games && best.games.minutes) ?? null,
              rating: best.games && best.games.rating ? Math.round(parseFloat(best.games.rating) * 100) / 100 : null,
              goals: (best.goals && best.goals.total) ?? null,
              assists: (best.goals && best.goals.assists) ?? null,
              keyPasses: real.keyPasses ?? null,
              passAccuracyPct: real.passAccuracyPct ?? null,
              dribbleSuccessRatePct: real.dribbleSuccessRatePct ?? null,
              defensiveActions: real.defensiveActions ?? null,
              duelWinRatePct: real.duelWinRatePct ?? null,
              yellowCards: (best.cards && best.cards.yellow) ?? null,
              redCards: (best.cards && best.cards.red) ?? null,
              season,
            } : null,
          });
          fetchedForClub++;
        }
        page++;
      }
      if (fetchedForClub > 0) {
        stats.bulkClubsFetched++;
        stats.bulkPlayersFetched += fetchedForClub;
      }
      // 「黙って減らさない」: 途中で打ち切ったクラブは必ず理由を残す
      if (stoppedReason === "budget") {
        skip("bulkPlayers", `APIの残り予算が不足したため、${club.nameJa}の選手一括取得を${page - 1}ページで打ち切りました(全${totalPages}ページ中)。残りは翌日に回ります。`);
      } else if (totalPages > BULK_PAGE_LIMIT) {
        skip("bulkPlayers", `${club.nameJa}は登録選手が多く(${totalPages}ページ)、1クラブあたりの上限${BULK_PAGE_LIMIT}ページを超えたため、${BULK_PAGE_LIMIT * 20}人目までを取得しました。`);
      }
    } catch (e) {
      if (e && e.code === "BUDGET_EXHAUSTED") {
        skip("bulkPlayers", "APIの1日予算に達したため、クラブ単位の選手一括取得を打ち切りました。");
        break;
      }
      stats.errors.push(`universe_bulk_players_failed:${club.nameEn}:${e.code || e.message}`);
    }
  }

  // ============================================================
  // ③-c 直近5試合の実測(2026年8月・「選手検索」統合で新設)
  // ============================================================
  // ご要望の「直近5試合評価」「最近5試合」「スタメン率の裏づけ」は、
  // シーズン集計だけでは絶対に作れない(1試合ごとの数字が要る)。
  // /fixtures/players?fixture=<id> は **1リクエストで両チーム全員** の
  // その試合の評価・出場時間・得点・アシスト・先発かどうかを返す。
  //
  // 試合IDはコア更新で取得済みの /fixtures(直近10試合)を再利用するので、
  // **試合一覧の取得は追加コスト0**。新たに増えるのは
  // /fixtures/players の呼び出しだけ。TOP100クラブの直近5試合を重複除去すると
  // 実測で200〜300試合程度(同士討ちは1回で両クラブぶん賄える)。
  stats.recentMatches = { planned: 0, fetched: 0, playersCovered: 0 };
  const RECENT_FIXTURE_CAP = Number(process.env.UNIVERSE_RECENT_FIXTURE_CAP) || 260;
  const RECENT_PER_CLUB = Number(process.env.UNIVERSE_RECENT_PER_CLUB) || 5;
  if (!alreadyRanToday) {
    try {
      // 直近5試合(終了済み)の試合IDを、全クラブぶん集めて重複を除く
      const wanted = new Map(); // fixtureId -> date
      for (const [, fixtures] of fixturesCache) {
        const finished = (fixtures || [])
          .filter((f) => f && f.fixture && f.fixture.status && f.fixture.status.short === "FT")
          .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
          .slice(0, RECENT_PER_CLUB);
        for (const f of finished) {
          if (!wanted.has(f.fixture.id)) wanted.set(f.fixture.id, f.fixture.date);
        }
      }
      const ids = [...wanted.entries()]
        .sort((a, b) => new Date(b[1]) - new Date(a[1]))   // 新しい試合から
        .slice(0, RECENT_FIXTURE_CAP);
      stats.recentMatches.planned = ids.length;
      if (wanted.size > ids.length) {
        skip("recentMatches", `直近試合の取得は1日${RECENT_FIXTURE_CAP}試合までとしているため、${wanted.size - ids.length}試合は次回に回しました。`);
      }
      for (const [fid, fdate] of ids) {
        if (!canSpend(1)) {
          skip("recentMatches", `APIの残り予算が不足したため、直近試合の取得を${stats.recentMatches.fetched}試合で打ち切りました。`);
          break;
        }
        try {
          const data = await callApiFootball("/fixtures/players", { fixture: fid });
          stats.recentMatches.fetched++;
          const sides = data.response || [];
          for (let si = 0; si < sides.length; si++) {
            const side = sides[si];
            // 対戦相手は「もう一方の側」。side.team は選手自身のクラブなので、
            // それを相手として記録すると、画面に事実と違う対戦相手が出てしまう。
            // 2チームぶん揃っていないレスポンスでは相手を null(=未取得)にする。
            const other = sides.length === 2 ? sides[1 - si] : null;
            const opponentEn = (other && other.team && other.team.name) || null;
            for (const p of (side.players || [])) {
              const pid = p && p.player && p.player.id;
              const st0 = p && p.statistics && p.statistics[0];
              if (!pid || !st0) continue;
              const g = st0.games || {};
              const rating = g.rating ? Math.round(parseFloat(g.rating) * 100) / 100 : null;
              const minutes = Number.isFinite(Number(g.minutes)) ? Number(g.minutes) : null;
              const arr = recent5ByPlayer.get(Number(pid)) || [];
              arr.push({
                fixtureId: fid,
                date: fdate ? String(fdate).slice(0, 10) : null,
                teamEn: (side.team && side.team.name) || null,
                opponentEn,
                rating, minutes,
                started: g.substitute === false ? 1 : (g.substitute === true ? 0 : null),
                goals: (st0.goals && Number.isFinite(Number(st0.goals.total))) ? Number(st0.goals.total) : null,
                assists: (st0.goals && Number.isFinite(Number(st0.goals.assists))) ? Number(st0.goals.assists) : null,
              });
              recent5ByPlayer.set(Number(pid), arr);
            }
          }
        } catch (e) {
          if (e && e.code === "BUDGET_EXHAUSTED") {
            skip("recentMatches", "APIの1日予算に達したため、直近試合の取得を打ち切りました。");
            break;
          }
          stats.errors.push(`universe_recent_fixture_failed:${fid}:${e.code || e.message}`);
        }
      }
      // 新しい順に5件へ切り詰める
      for (const [pid, arr] of recent5ByPlayer) {
        arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
        recent5ByPlayer.set(pid, arr.slice(0, 5));
      }
      stats.recentMatches.playersCovered = recent5ByPlayer.size;
    } catch (e) {
      stats.errors.push(`universe_recent_matches_failed:${e.message}`);
    }
  }

  // ---- 名簿でしか見つからなかった選手の保存 ----
  // 一括取得(③-b)で成績つきで拾えた選手は、そちらの保存に任せる。
  // ここで保存するのは「名簿にはいるが一括取得の対象外だった選手」だけ。
  stats.squadOnlySaved = 0;
  for (const p of squadOnlyPending) {
    if (bulkPlayers.has(Number(p.id))) continue;   // 一括取得のほうが情報量が多い
    try {
      const res = await clubDossier.savePlayer(p);
      if (res && res.saved) {
        stats.playersUpdated++; stats.playersFromSquadSync++; stats.squadOnlySaved++;
        savedTodayIds.add(Number(p.id));
        emittedByPlayer.set(Number(p.id), new Set((res.events || []).map((ev) => ev.type)));
      }
    } catch (e) { /* 1人の失敗で名簿全体を止めない */ }
  }

  // ============================================================
  // ④ 選手の詳細成績(名簿から輪番。予算内で1日あたり上限N人)
  // ============================================================
  // 保存済みの名簿から、更新が最も古い選手を優先して選ぶ。
  // 1人=1リクエスト。UNIVERSE_PLAYER_CAP(既定300)まで。
  const detailPlayers = new Map(); // playerId -> 保存した記録(索引づくりで再利用)
  const squadByClub = new Map();   // nameEn -> { club, players[] }(索引づくりで再利用)
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
      const squad = d && d.sections && d.sections.squad && d.sections.squad.players;
      if (!squad) continue;
      squadByClub.set(club.nameEn, { club, players: squad });
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
    // 連続して取得できなかった選手の記録(毎日同じ失敗を繰り返さないため)
    // このファイルは保存先を deps 経由で受け取る(直接の変数は存在しない)。
    // 無い環境でも動くように、必ず存在確認してから使う。
    const playerFailCounts = (deps.upstashGetJSON
      ? (await deps.upstashGetJSON(PLAYER_FAIL_KEY).catch(() => null)) : null) || {};
    let playerFailDirty = false;
    const nowMsForSkip = runAt.getTime();
    const isSkipped = (playerId) => {
      const v = playerFailCounts[String(playerId)];
      if (!v || typeof v !== "object" || !v.skipUntil) return false;
      const until = Date.parse(v.skipUntil);
      if (!Number.isFinite(until)) return false;
      if (until > nowMsForSkip) return true;
      // 期限が切れたら、もう一度だけ試す(恒久的に切り捨てない)
      delete playerFailCounts[String(playerId)];
      playerFailDirty = true;
      return false;
    };
    // ---- 2026年8月18日・検証で判明した二重処理 ----
    //   候補は各クラブの名簿から作るため、同じ選手が複数回入ることがある
    //   (移籍直後で新旧どちらの名簿にも載っている、など)。
    //   本番のエラーが「Guillem Badia【2回】」と出ていたのはこれ。
    //   1日に同じ選手を2回取りに行くのは、API枠の無駄でしかない。
    const seenPlayerIds = new Set();
    const uniqueCandidates = candidates.filter((c) => {
      const k = String(c.playerId);
      if (seenPlayerIds.has(k)) return false;
      seenPlayerIds.add(k);
      return true;
    });
    stats.playersDeduped = candidates.length - uniqueCandidates.length;
    const withAge = uniqueCandidates
      .filter((c) => !isSkipped(c.playerId))
      .map((c) => ({ ...c, updatedAt: statsIndex[c.playerId] || "" }));
    withAge.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    const skippedCount = uniqueCandidates.length - withAge.length;
    if (skippedCount > 0) {
      stats.playersSkippedUnavailable = skippedCount;
      stats.notesJa = stats.notesJa || [];
      stats.notesJa.push(`提供元から繰り返し取得できなかった選手 ${skippedCount}人 は、当面この輪番から外しています(一定期間後に自動でもう一度試します)。`);
    }
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
        const detailRecord = {
          id: c.playerId, name: c.name, teamEn: c.club.nameEn, teamJa: c.club.nameJa,
          leagueId: c.club.leagueId || null,
          nationality: (entry.player && entry.player.nationality) || null,
          height: (entry.player && entry.player.height) || null,
          birthDate: (entry.player && entry.player.birth && entry.player.birth.date) || null,
          age: Number.isFinite(Number(entry.player && entry.player.age)) ? Number(entry.player.age) : null,
          position: real.position || null,
          stats: {
            appearances: (best.games && best.games.appearences) ?? null,
            lineups: (best.games && best.games.lineups) ?? null,
            minutes: (best.games && best.games.minutes) ?? null,
            rating: best.games && best.games.rating ? Math.round(parseFloat(best.games.rating) * 100) / 100 : null,
            goals: (best.goals && best.goals.total) ?? null,
            assists: (best.goals && best.goals.assists) ?? null,
            keyPasses: real.keyPasses ?? null,
            passAccuracyPct: real.passAccuracyPct ?? null,
            dribbleSuccessRatePct: real.dribbleSuccessRatePct ?? null,
            defensiveActions: real.defensiveActions ?? null,
            duelWinRatePct: real.duelWinRatePct ?? null,
            yellowCards: (best.cards && best.cards.yellow) ?? null,
            redCards: (best.cards && best.cards.red) ?? null,
            season,
          },
          statsUpdatedAt: runAt.toISOString(),
        };
        const detailRes = await clubDossier.savePlayer(detailRecord);
        detailPlayers.set(Number(c.playerId), detailRecord);
        savedTodayIds.add(Number(c.playerId));
        emittedByPlayer.set(Number(c.playerId), new Set(((detailRes && detailRes.events) || []).map((ev) => ev.type)));
        statsIndex[c.playerId] = runAt.toISOString();
        indexDirty = true;
        // 取得できたので、それまでの連続失敗の記録は消す(本当に「連続」でのみ諦める)
        if (playerFailCounts[String(c.playerId)] !== undefined) {
          delete playerFailCounts[String(c.playerId)];
          playerFailDirty = true;
        }
        stats.playersUpdated++;
        stats.playersFromDetailStats++;
        done++;
      } catch (e) {
        if (e && e.code === "BUDGET_EXHAUSTED") { skip("playerStats", "APIの1日予算に達したため、選手の詳細成績の更新を打ち切りました。"); break; }
        // ---- 2026年8月18日・本番で10日間まったく同じエラーが出続けた原因 ----
        //   実測: universe_player_failed:Guillem Badia:API_ERROR が
        //   8/9〜8/18 の10日間、毎日1件ずつ記録されていた。
        //
        //   この輪番は statsIndex(選手ID→最終更新時刻)の **古い順** に処理する。
        //   成功したときと「統計が空だった」ときは時刻を進めるのに、
        //   **失敗したときだけ進めていなかった**。
        //   その結果、取得できない選手は永遠に updatedAt が空のまま
        //   毎日必ず列の先頭に来て、毎日同じ失敗を繰り返し、
        //   しかも他の選手の枠を1つ食い続けていた。
        //   (すぐ上の「統計が無い選手も輪番を前進させる」と同じ対処が、
        //    例外の側に入っていなかった)
        //
        //   対処: 失敗しても輪番は前進させる(列の後ろへ回す)。
        //   そのうえで連続失敗を数え、3回続いたら当面スキップする。
        //   「毎日エラーを出し続ける」でも「黙って消す」でもなく、
        //   「取得できない選手として、理由つきで一覧に残す」。
        statsIndex[c.playerId] = runAt.toISOString();
        indexDirty = true;
        const failKey = String(c.playerId);
        const prevFails = Number(playerFailCounts[failKey] || 0) + 1;
        playerFailCounts[failKey] = prevFails;
        playerFailDirty = true;
        if (prevFails >= PLAYER_FAIL_GIVEUP) {
          // これ以上は毎日試さない(APIも枠も無駄になるため)。理由は残す。
          playerFailCounts[failKey] = { fails: prevFails, skipUntil: new Date(runAt.getTime() + PLAYER_FAIL_SKIP_DAYS * 86400000).toISOString(), name: c.name, reason: e.code || e.message };
          stats.unavailablePlayers = stats.unavailablePlayers || [];
          stats.unavailablePlayers.push({ name: c.name, playerId: c.playerId, fails: prevFails, reasonJa: `提供元から${prevFails}回続けて取得できなかったため、${PLAYER_FAIL_SKIP_DAYS}日間はこの選手の更新を見送ります(${e.code || e.message})。` });
        } else {
          stats.errors.push(`universe_player_failed:${c.name}:${e.code || e.message}`);
        }
        done++;
      }
    }
    if (indexDirty) await clubDossier.saveStatsIndex(statsIndex);
    if (playerFailDirty && deps.upstashSetJSON) await deps.upstashSetJSON(PLAYER_FAIL_KEY, playerFailCounts).catch(() => {});
  } catch (e) { stats.errors.push(`universe_players_failed:${e.message}`); }

  // ============================================================
  // ④-b 選手スカウティング用の検索索引を作る(2026年8月・全面刷新)
  // ============================================================
  // ご要望②〜⑤⑦⑩への土台。画面の検索は「この1本の索引をメモリで絞り込む」
  // だけになるため、検索1回あたりの Redis / API アクセスは **0回** になる。
  //
  // 情報源(すべて今日この関数の中で既に取得済み。追加のAPIコールは0件):
  //   ・③-b クラブ単位の一括取得 … 全所属選手の成績(最も新しい)
  //   ・④   1人ずつの詳細成績   … 輪番で深掘りしたぶん
  //   ・③   名簿(squad)        … 成績がまだ無い選手も必ず載せる
  //   ・①   /injuries           … 怪我の有無(選手ID)
  //   ・①   /fixtures/lineups   … スタメン配置(細かいポジションの推定)
  stats.playerIndex = { built: false };
  try {
    const psDeps = {
      upstashEnabled: !!(deps.upstashGetJSON && deps.upstashSetJSON),
      upstashGetJSON: deps.upstashGetJSON,
      upstashSetJSON: deps.upstashSetJSON,
      upstashCmd: deps.upstashCmd,
    };
    if (!psDeps.upstashEnabled) {
      stats.playerIndex = { built: false, reasonJa: "保存先(Upstash)が未設定のため、選手検索の索引を作成できません。" };
    } else {
      const todayKey = playerSearch.dateKeyNum(runAt.toISOString());
      const prevLoaded = await playerSearch.loadIndex(psDeps);
      const prevMap = new Map();
      for (const r of prevLoaded.rows) prevMap.set(Number(r[playerSearch.COL.id]), r);
      const isFirstBuild = prevMap.size === 0;

      // スタメン配置の累積(GET1回・SET1回)。今日ぶんを足す。
      const grid = (await playerSearch.loadGrid(psDeps)) || {};
      for (const [pid, g] of gridUpdates) {
        grid[pid] = playerSearch.accumulateGrid(grid[pid], g.grid, g.maxRow, g.isEdge, g.fixtureId);
      }

      // ---- 情報源をマージする。null では上書きしない(古い実測を消さない) ----
      const mergeInto = (base, next) => {
        const out = { ...(base || {}) };
        for (const [k, v] of Object.entries(next || {})) {
          if (k === "stats") continue;
          if (v !== null && v !== undefined && v !== "") out[k] = v;
        }
        if (next && next.stats) {
          out.stats = { ...(out.stats || {}) };
          for (const [k, v] of Object.entries(next.stats)) {
            if (v !== null && v !== undefined) out.stats[k] = v;
          }
        }
        return out;
      };
      const merged = new Map();
      const put = (id, rec) => { merged.set(id, mergeInto(merged.get(id), rec)); };
      for (const [, entry] of squadByClub) {
        for (const p of entry.players) {
          if (!p || !p.id) continue;
          put(Number(p.id), {
            id: Number(p.id), name: p.name, teamEn: entry.club.nameEn, teamJa: entry.club.nameJa,
            leagueId: entry.club.leagueId || null, position: p.position, age: p.age, number: p.number,
          });
        }
      }
      for (const [id, rec] of detailPlayers) put(id, rec);
      for (const [id, rec] of bulkPlayers) put(id, rec);   // 最も新しいので最後

      // ---- 索引の行を作る ----
      const rows = [];
      const changed = [];  // { row, prev } — 変化があった選手(速報と保存の対象)
      for (const [id, rec] of merged) {
        const prev = prevMap.get(id) || null;
        const gridStats = playerSearch.gridStatsFrom(grid[id]);
        // 怪我の有無は「今日そのクラブの負傷者リストを実際に確認できた」場合だけ
        // 0/1 を更新する。確認できていないクラブの選手は前回値を維持する
        // (確認していないのに「怪我していない」と書くのはでっち上げになる)。
        const injured = injuryCheckedClubs.has(rec.teamEn) ? injuredIds.has(id) : undefined;
        // 直近5試合の実測(取れた選手だけ。取れていなければ前回値を維持する)
        const r5 = recent5ByPlayer.get(id) || null;
        let recent5Rating = null, recent5Count = null, recent5Minutes = null;
        if (r5 && r5.length) {
          const rated = r5.filter((x) => Number.isFinite(x.rating));
          const played = r5.filter((x) => Number.isFinite(x.minutes));
          recent5Count = rated.length;
          recent5Rating = rated.length ? Math.round((rated.reduce((a, x) => a + x.rating, 0) / rated.length) * 100) / 100 : null;
          recent5Minutes = played.length ? Math.round(played.reduce((a, x) => a + x.minutes, 0) / played.length) : null;
        }
        const row = playerSearch.toIndexRow(rec, {
          leagueId: rec.leagueId, injured, gridStats, todayKey,
          recent5Rating, recent5Count, recent5Minutes,
        }, runAt.getTime(), prev);
        rows.push(row);
        if (prev && !rowsEquivalent(prev, row)) changed.push({ row, prev });
        else if (!prev) changed.push({ row, prev: null });
      }
      // 今日どの情報源にも現れなかった選手は、前回の行をそのまま残す
      // (クラブの名簿更新が輪番待ちのときに、索引から人が消えないようにする)。
      // ただし60日以上更新が無い行は退団などとみなして落とす。
      let carried = 0, dropped = 0;
      for (const [id, prev] of prevMap) {
        if (merged.has(id)) continue;
        const age = playerSearch.daysBetweenKeys(prev[playerSearch.COL.updatedAt], todayKey);
        if (age !== null && age > 60) { dropped++; continue; }
        rows.push(prev); carried++;
      }

      const C = playerSearch.COL;

      // ---- 選手個別の記録(kb:player:<id>)の更新 ----
      // 全員ぶん書くと Upstash のコマンド数が跳ね上がる。
      // savePlayer 1回のコストは **GET + SET + 速報のLPUSH + LTRIM = 最大4コマンド**
      // (監査で「2コマンド」と見積もっていたのが誤りだった)。
      // そのため上限は控えめにし、優先順位も見直す:
      //   ・移籍(所属クラブが変わった)          … 最優先。事実として重要
      //   ・更新が古い選手                        … 同じ選手ばかり保存して他が
      //                                            永久に取り残されるのを防ぐ
      //   ・平均評価の変化が大きい選手            … 変化の説明として価値が高い
      // 保存しきれなかったぶんも **索引には反映済み**(画面の検索・分析は最新)。
      // 遅れるのは個別ページの「記録ファイル」だけ。
      const SAVE_CAP = Number(process.env.UNIVERSE_INDEX_SAVE_CAP) || 150;
      const savable = changed
        .filter((x) => x.prev && !savedTodayIds.has(Number(x.row[C.id])) && bulkPlayers.has(Number(x.row[C.id])))
        .map((x) => {
          const teamChanged = x.prev[C.teamEn] !== x.row[C.teamEn] ? 100000 : 0;
          // 何日ぶん更新が止まっているか(古いほど優先)
          const staleDays = Math.min(60, playerSearch.daysBetweenKeys(x.prev[C.updatedAt], todayKey) || 0);
          const dr = Math.abs((x.row[C.rating] || 0) - (x.prev[C.rating] || 0));
          return { ...x, priority: teamChanged + staleDays * 100 + dr * 10 };
        })
        .sort((a, b) => b.priority - a.priority);
      let savedFromBulk = 0;
      for (const s2 of savable) {
        if (savedFromBulk >= SAVE_CAP) break;
        const rec = bulkPlayers.get(Number(s2.row[C.id]));
        if (!rec) continue;
        const r = await clubDossier.savePlayer({ ...rec, statsUpdatedAt: runAt.toISOString() }).catch(() => ({ saved: false }));
        if (r && r.saved) {
          savedFromBulk++;
          // ---- 検証で判明した取りこぼしへの対処 ----
          // 以前は「savePlayer を通した選手」を丸ごと速報の対象から外していた。
          // ところが savePlayer 側の検知は **保存済みの記録** との比較なので、
          // 記録に成績が入っていない選手(名簿だけで作られた記録)ではフォーム
          // 変化を検知できず、索引側の検知も抑制されて、結果として誰も気づけなかった。
          // 実際に出たイベントの種類だけを覚えて、それ以外は索引の差分から出す。
          const kinds = new Set((r.events || []).map((ev) => ev.type));
          emittedByPlayer.set(Number(s2.row[C.id]), kinds);
        }
      }
      const savableDeferred = Math.max(0, savable.length - savedFromBulk);
      if (savableDeferred > 0) {
        skip("playerRecords", `保存先のコマンド数を抑えるため、個別の選手記録の更新は${savedFromBulk}人までとし、${savableDeferred}人は翌日以降に回しました(検索・分析に使う索引には全員ぶん反映済みです)。`);
      }

      // ---- スカウト速報(移籍・フォーム急変・若手有望株)----
      // **必ず savePlayer より後に行う。** savePlayer も同じリストへ LPUSH し、
      // 最後に300件へ LTRIM するため、先に積むと全部押し出されて消えていた
      // (監査で「索引由来の速報が1件も残らない」ことが実測された)。
      let feedPushed = 0;
      const FEED_CAP = 60;
      for (const { row, prev } of changed) {
        if (feedPushed >= FEED_CAP) break;
        const id = Number(row[C.id]);
        const already = emittedByPlayer.get(id) || new Set();
        if (!prev) continue;                   // 初回は「新規登録」を大量に出さない
        const events = [];
        if (prev[C.teamEn] && row[C.teamEn] && prev[C.teamEn] !== row[C.teamEn]) {
          events.push({ type: "transfer", labelJa: "移籍", detailJa: `${prev[C.teamJa] || prev[C.teamEn]} → ${row[C.teamJa] || row[C.teamEn]}` });
        }
        const pr = prev[C.rating], nr = row[C.rating];
        if (Number.isFinite(pr) && Number.isFinite(nr) && pr > 0) {
          const d = Math.round((nr - pr) * 100) / 100;
          if (d >= 0.15) events.push({ type: "formUp", labelJa: "フォーム急上昇", detailJa: `平均評価が ${pr} → ${nr}(+${d})`, delta: d });
          else if (d <= -0.15) events.push({ type: "formDown", labelJa: "フォーム急下降", detailJa: `平均評価が ${pr} → ${nr}(${d})`, delta: d });
        }
        const age = row[C.age], mins = row[C.minutes], prevMins = prev[C.minutes];
        if (Number.isFinite(age) && age <= 21 && Number.isFinite(mins) && mins >= 450
          && Number.isFinite(nr) && nr >= 6.8 && (!Number.isFinite(prevMins) || mins > prevMins)) {
          events.push({ type: "prospect", labelJa: "若手有望株", detailJa: `${age}歳・出場${mins}分・平均評価${nr}`, age, minutes: mins, rating: nr });
        }
        for (const ev of events) {
          if (feedPushed >= FEED_CAP) break;
          if (already.has(ev.type)) continue;   // savePlayer 側で同じ種類を既に出した
          await deps.upstashCmd(["LPUSH", "kb:player:scoutfeed", JSON.stringify({
            ...ev, playerId: id, name: row[C.name] || null,
            teamEn: row[C.teamEn] || null, teamJa: row[C.teamJa] || null,
            position: row[C.position] || null, at: runAt.toISOString(),
          })]).catch(() => {});
          feedPushed++;
        }
      }
      if (feedPushed > 0) await deps.upstashCmd(["LTRIM", "kb:player:scoutfeed", "0", "299"]).catch(() => {});

      // ---- 保存 ----
      // grid は索引に載っている選手ぶんだけに刈り込む(退団者で膨らませない)
      const liveIds = new Set(rows.map((r) => Number(r[C.id])));
      const prunedGrid = {};
      for (const [pid, entry] of Object.entries(grid)) {
        if (liveIds.has(Number(pid))) prunedGrid[pid] = entry;
      }
      await playerSearch.saveGrid(psDeps, prunedGrid);
      // ---- 詳細画面用の補助データ(直近5試合・移籍履歴・怪我履歴)----
      // 索引とは別に、ブロック分割で保存する。画面は選手を開いたときだけ読む。
      // 索引に載っている選手ぶんだけに絞る(退団者で膨らませない)。
      const detailStores = await playerSearch.saveDetailStores(psDeps, {
        liveIds,
        recent5: recent5ByPlayer,
        transfers: transferRowsToday,
        injuries: injuryRowsToday,
      });
      stats.detailStores = detailStores;
      const saveRes = await playerSearch.saveIndex(psDeps, rows, {
        builtAt: runAt.toISOString(), dateKey,
        sources: {
          bulkPlayers: bulkPlayers.size, detailPlayers: detailPlayers.size,
          squadClubs: squadByClub.size, injuryCheckedClubs: injuryCheckedClubs.size,
          gridSamplesToday: gridUpdates.size,
        },
      });
      stats.playerIndex = {
        built: saveRes.saved === true,
        count: rows.length,
        shardCount: saveRes.shardCount,
        newRows: rows.filter((r) => !prevMap.has(Number(r[C.id]))).length,
        carriedOver: carried,
        droppedStale: dropped,
        changedToday: changed.filter((x) => x.prev).length,
        savedPlayerRecords: savedFromBulk,
        deferredPlayerRecords: savableDeferred,
        scoutFeedPushed: feedPushed,
        detailedPositionCount: rows.filter((r) => r[C.detailedPos]).length,
        injuredCount: rows.filter((r) => r[C.injured] === 1).length,
        withRating: rows.filter((r) => r[C.rating] !== null && r[C.rating] !== undefined).length,
        withRecent5: rows.filter((r) => (r[C.recent5Count] || 0) >= 3).length,
        withStartRate: rows.filter((r) => Number.isFinite(r[C.lineups])).length,
        firstBuild: isFirstBuild,
        // saveIndex がシャードごとに計測した実サイズ(ここで再度JSON化しない)
        approxBytes: (saveRes.meta && Array.isArray(saveRes.meta.bytesPerShard))
          ? saveRes.meta.bytesPerShard.reduce((a, b) => a + b, 0) : null,
        truncated: saveRes.truncated || 0,
        saveReasonJa: saveRes.reasonJa || null,
      };
      if (saveRes.refused) {
        skip("playerIndex", saveRes.reasonJa);
      }
      if (saveRes.truncated) {
        skip("playerIndex", (saveRes.meta && saveRes.meta.truncatedReasonJa) || `索引の上限を超えたため${saveRes.truncated}人を保存できませんでした。`);
      }
      stats.playersIndexed = rows.length;
      if (!saveRes.saved) stats.errors.push("universe_player_rich_index_save_failed");
    }
  } catch (e) {
    stats.errors.push(`universe_player_index_failed:${e.message}`);
    stats.playerIndex = { built: false, reasonJa: `索引の作成中にエラーが発生しました: ${e.message}` };
  }

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

/* ============================================================================
   2026年8月7日・「索引はできたのに主要クラブが入っていない」への対処
   ----------------------------------------------------------------------------
   本番の実測(/api/knowledge/player-facets):
     索引 1,401人 / 42クラブ。ところが
       Arsenal / Barcelona / Bayern / Man City / Liverpool / PSG が **丸ごと不在**
       国籍「Spain」はわずか2人、平均評価があるのは1,401人中354人
   利用者が実際に試す名前(Arsenal・Spain・Messi)が、ことごとく穴に落ちていた。

   原因:
     全100クラブの選手を成績つきで取ってくるのは
       /players?team=<id>&season=&page=   (③-b の一括取得)
     だが、これは長い毎日の学習の後半にあり、そこへ到達する前に学習が終わっていた。
     前半で終わる「名簿同期(1日14クラブ)」の分だけが溜まり、42クラブで頭打ち。

   対処:
     索引づくりを切り離したのと同じ考え方で、**選手データの収集も切り離す**。
       ・1回あたりのクラブ数を区切る(既定25クラブ ≒ API 50〜100回)
       ・どこまで進んだかを保存し、次回は続きから(輪番ではなく確実な巡回)
       ・保存済みの索引に上書きマージする(実測を消さない)
     これを数回まわせば、100クラブすべてが検索対象になる。
   ============================================================================ */
// 提供元から繰り返し取得できない選手を覚えておく場所。
// これが無いと、取得できない選手が毎日「更新が最も古い」ままになり、
// 永遠に列の先頭に居座って、毎日同じエラーを出し続ける(本番で10日続いた)。
const PLAYER_FAIL_KEY = "kb:player:statsfail";
const PLAYER_FAIL_GIVEUP = Number(process.env.PLAYER_FAIL_GIVEUP) || 3;   // 何回続けて失敗したら見送るか
const PLAYER_FAIL_SKIP_DAYS = Number(process.env.PLAYER_FAIL_SKIP_DAYS) || 30; // 見送る日数(その後もう一度試す)

const COLLECT_CURSOR_KEY = "kb:universe:playercursor";

async function collectClubPlayersBatch(deps, opts) {
  const o = opts || {};
  const {
    callApiFootball, clubDossier, apiBudget,
    upstashGetJSON, upstashSetJSON, upstashCmd,
  } = deps;
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const runAt = new Date(nowMs);
  const season = seasonOf(runAt);
  const clubLimit = Math.max(1, Math.min(100, o.clubLimit || 25));
  const pageLimit = Math.max(1, Math.min(6, o.pageLimit || BULK_PAGE_LIMIT));
  const recordSaveCap = Math.max(0, o.recordSaveCap === undefined ? 400 : o.recordSaveCap);

  const stats = {
    ok: false, at: runAt.toISOString(),
    clubsPlanned: 0, clubsFetched: 0, playersFetched: 0, apiRequests: 0,
    recordsSaved: 0, indexCount: null, indexClubs: null, withRating: null,
    unresolvedClubs: [], errors: [], notesJa: [],
    cursorBefore: null, cursorAfter: null, reasonJa: null,
  };
  if (typeof callApiFootball !== "function" || !clubDossier) {
    stats.reasonJa = "収集に必要な部品が渡されていません。";
    return stats;
  }
  const canSpend = (n) => (apiBudget ? apiBudget.remainingForJob() >= BUDGET_FLOOR + n : true);

  // ---- どこまで進んだか(次回は続きから) ----
  const cursorRec = (upstashGetJSON ? await upstashGetJSON(COLLECT_CURSOR_KEY).catch(() => null) : null) || {};
  const start = Number.isFinite(Number(cursorRec.next)) ? Number(cursorRec.next) % CLUB_UNIVERSE.length : 0;
  stats.cursorBefore = start;

  const targets = [];
  for (let i = 0; i < clubLimit; i++) targets.push(CLUB_UNIVERSE[(start + i) % CLUB_UNIVERSE.length]);
  stats.clubsPlanned = targets.length;

  const collected = new Map(); // playerId -> レコード
  let cursorAfter = start;
  // teamIdが未保存のクラブを、その場で照合する回数の上限(1クラブ=API1回)
  const resolveCap = Math.max(0, o.resolveCap === undefined ? 12 : o.resolveCap);
  let resolvedThisRun = 0;
  stats.resolvedNow = 0;

  for (const club of targets) {
    if (!canSpend(2)) {
      stats.notesJa.push(`APIの残り予算が安全ラインを下回ったため、${club.nameJa}以降は次回に回しました。`);
      break;
    }
    // teamId は調査ファイルに保存済みのものを使う(APIを使わない)。
    // ---- 2026年8月7日・本番実測での修正 ----
    //   保存済みのteamIdが無いクラブが多く、そこを黙って飛ばしていたため
    //   収集が実質なにも進んでいなかった(索引 1,401→1,433 = +32人だけ)。
    //   teamIdが無いクラブは、その場で1回だけ名前を照合して保存する。
    //   照合はAPI1回なので、1実行あたりの上限を決めて使いすぎないようにする。
    let teamId = null;
    let dossier = null;
    try {
      dossier = await clubDossier.getDossier(club.nameEn);
      teamId = dossier && dossier.teamId ? dossier.teamId : null;
    } catch (e) { teamId = null; }
    cursorAfter = (cursorAfter + 1) % CLUB_UNIVERSE.length;
    if (!teamId) {
      if (resolvedThisRun >= resolveCap || !canSpend(2)) {
        stats.unresolvedClubs.push(club.nameEn);
        continue;
      }
      try {
        const found = await callApiFootball("/teams", { search: club.nameEn });
        stats.apiRequests++;
        resolvedThisRun++;
        const list = (found && found.response) || [];
        const exact = list.find((x) => x && x.team && String(x.team.name).toLowerCase() === club.nameEn.toLowerCase())
          || list.find((x) => x && x.team && String(x.team.name).toLowerCase().replace(/[^a-z0-9]/g, "")
            === club.nameEn.toLowerCase().replace(/[^a-z0-9]/g, ""))
          || (list.length === 1 ? list[0] : null);
        if (exact && exact.team && exact.team.id) {
          teamId = exact.team.id;
          stats.resolvedNow++;
          // 次回からはAPIを使わずに済むよう保存する
          await clubDossier.updateSection(club.nameEn, "basic",
            (dossier && dossier.sections && dossier.sections.basic) || { note: "teamId resolved" },
            { nameJa: club.nameJa, teamId, uefaRankSnapshot: club.rank }).catch(() => {});
        }
      } catch (e) {
        if (e && e.code === "BUDGET_EXHAUSTED") {
          stats.notesJa.push("APIの1日予算に達したため、クラブ名の照合を打ち切りました。");
          break;
        }
        stats.errors.push(`resolve_failed:${club.nameEn}:${e.code || e.message}`);
      }
      if (!teamId) { stats.unresolvedClubs.push(club.nameEn); continue; }
    }
    try {
      let page = 1, totalPages = 1, got = 0;
      while (page <= Math.min(totalPages, pageLimit)) {
        if (!canSpend(1)) { stats.notesJa.push(`予算不足のため ${club.nameJa} を${page - 1}ページで打ち切りました。`); break; }
        const data = await callApiFootball("/players", { team: teamId, season, page });
        stats.apiRequests++;
        const t = data && data.paging && Number(data.paging.total);
        if (Number.isFinite(t) && t > 0) totalPages = t;
        const rows = (data && data.response) || [];
        if (!rows.length) break;
        for (const entry of rows) {
          const pl = entry && entry.player;
          if (!pl || !pl.id) continue;
          const list = Array.isArray(entry.statistics) ? entry.statistics : [];
          const best = list.length
            ? list.reduce((acc, cur) =>
              (((cur.games && cur.games.appearences) || 0) > ((acc.games && acc.games.appearences) || 0) ? cur : acc), list[0])
            : null;
          const real = best ? (computePlayerRealStats(best) || {}) : {};
          collected.set(Number(pl.id), {
            id: Number(pl.id), name: pl.name || null,
            teamEn: club.nameEn, teamJa: club.nameJa, leagueId: club.leagueId || null,
            nationality: pl.nationality || null,
            height: pl.height || null,
            birthDate: (pl.birth && pl.birth.date) || null,
            age: Number.isFinite(Number(pl.age)) ? Number(pl.age) : null,
            position: real.position || (best && best.games && best.games.position) || null,
            // 取得できていない値は0で埋めず null のままにする(でっち上げ防止)
            stats: best ? {
              appearances: (best.games && best.games.appearences) ?? null,
              lineups: (best.games && best.games.lineups) ?? null,
              minutes: (best.games && best.games.minutes) ?? null,
              rating: best.games && best.games.rating ? Math.round(parseFloat(best.games.rating) * 100) / 100 : null,
              goals: (best.goals && best.goals.total) ?? null,
              assists: (best.goals && best.goals.assists) ?? null,
              keyPasses: real.keyPasses ?? null,
              passAccuracyPct: real.passAccuracyPct ?? null,
              dribbleSuccessRatePct: real.dribbleSuccessRatePct ?? null,
              defensiveActions: real.defensiveActions ?? null,
              duelWinRatePct: real.duelWinRatePct ?? null,
              yellowCards: (best.cards && best.cards.yellow) ?? null,
              redCards: (best.cards && best.cards.red) ?? null,
              season,
            } : null,
          });
          got++;
        }
        page++;
      }
      if (got > 0) { stats.clubsFetched++; stats.playersFetched += got; }
    } catch (e) {
      if (e && e.code === "BUDGET_EXHAUSTED") {
        stats.notesJa.push("APIの1日予算に達したため、収集を打ち切りました(続きは次回)。");
        break;
      }
      stats.errors.push(`collect_players_failed:${club.nameEn}:${e.code || e.message}`);
    }
  }

  if (upstashSetJSON) {
    await upstashSetJSON(COLLECT_CURSOR_KEY, {
      next: cursorAfter, at: runAt.toISOString(),
      lapCount: (Number(cursorRec.lapCount) || 0) + (cursorAfter <= start ? 1 : 0),
    }).catch(() => {});
  }
  stats.cursorAfter = cursorAfter;

  if (!collected.size) {
    stats.reasonJa = stats.unresolvedClubs.length
      ? `対象クラブのチームIDが保存されていないため取得できませんでした(${stats.unresolvedClubs.length}クラブ)。毎日の学習が一度も完了していない可能性があります。`
      : "取得できた選手が0人でした。";
    return stats;
  }

  // ---- 索引に上書きマージする(前回の実測を消さない) ----
  const psDeps = {
    upstashEnabled: !!(upstashGetJSON && upstashSetJSON),
    upstashGetJSON, upstashSetJSON, upstashCmd,
  };
  const prevLoaded = await playerSearch.loadIndex(psDeps);
  const prevMap = new Map();
  for (const r of (prevLoaded.rows || [])) prevMap.set(Number(r[playerSearch.COL.id]), r);
  const grid = (await playerSearch.loadGrid(psDeps).catch(() => null)) || {};
  const todayKey = playerSearch.dateKeyNum(runAt.toISOString());

  const rows = [];
  const seen = new Set();
  for (const [id, rec] of collected) {
    seen.add(id);
    rows.push(playerSearch.toIndexRow(rec, { todayKey, gridStats: playerSearch.gridStatsFrom(grid[id]) }, nowMs, prevMap.get(id) || null));
  }
  for (const [id, prevRow] of prevMap) {
    if (seen.has(id)) continue;
    rows.push(prevRow);   // 今回取得しなかった選手を消さない
  }
  const saveRes = await playerSearch.saveIndex(psDeps, rows, {
    builtAt: runAt.toISOString(),
    collectedBatch: true,
    sources: { clubsFetched: stats.clubsFetched, playersFetched: stats.playersFetched },
  });
  stats.ok = saveRes.saved === true;
  stats.indexCount = rows.length;
  stats.indexClubs = new Set(rows.map((r) => r[playerSearch.COL.teamEn]).filter(Boolean)).size;
  stats.withRating = rows.filter((r) => r[playerSearch.COL.rating] !== null && r[playerSearch.COL.rating] !== undefined).length;
  if (!saveRes.saved) stats.reasonJa = saveRes.reasonJa || "索引の保存に失敗しました。";

  // ---- 選手記録も保存する(上限つき。次回の作り直しの材料になる) ----
  if (recordSaveCap > 0) {
    let saved = 0;
    const statsIndex = await clubDossier.getStatsIndex().catch(() => ({}));
    for (const [id, rec] of collected) {
      if (saved >= recordSaveCap) break;
      if (!rec.stats) continue;              // 成績が無い選手は記録を増やさない
      if (statsIndex[id]) continue;          // 既にあるものは書き直さない(コマンド節約)
      try {
        await clubDossier.savePlayer(rec);
        statsIndex[id] = runAt.toISOString();
        saved++;
      } catch (e) { /* 1件失敗しても続ける */ }
    }
    if (saved) await clubDossier.saveStatsIndex(statsIndex).catch(() => {});
    stats.recordsSaved = saved;
  }
  return stats;
}

module.exports.collectClubPlayersBatch = collectClubPlayersBatch;
module.exports.COLLECT_CURSOR_KEY = COLLECT_CURSOR_KEY;
