/**
 * server/knowledge/teamKnowledge.js
 * ------------------------------------------------
 * v98(2026年11月5日・利用者の指摘「登録選手データがない試合が多い」への対応①②)
 * 試合カード(「本日の実際の試合」)の選手データを、画面内の手書き名簿(11クラブ・107人)
 * ではなく、サーバーの知識(クラブ宇宙172+動的クラブの調査ファイル・毎晩更新の選手索引)
 * から組み立てる。
 *
 * ■ 設計方針
 *   ・質問した瞬間に外部APIは呼ばない(方針⑥)。使うのは
 *       - 選手索引(プロセス内メモリ。毎晩の学習で作り直され、30分ごとに読み直される)
 *       - 調査ファイル kb:club:<slug>(両チームぶんを MGET 1回)
 *   ・でっち上げ禁止: 評価点・得点・出場時間はすべて API-Football の今季実測。
 *     「総合力」のような架空の能力値は作らない。母数(評価点のある選手数)を必ず添える。
 *   ・チームの照合は teamId(API-Footballの数値ID)で行う。名前の部分一致は使わない
 *     (「Inter」と「Inter Miami」のような誤照合を防ぐ)。
 *
 * ■ teamId → クラブ の対応表
 *   固定名簿(clubUniverse)のクラブは調査ファイルに teamId が保存されている。
 *   毎晩の収集が kb:universe:teammap(nameEn→teamId の小さな表)を書き、サーバーはそれを
 *   1 GET で読む。無い日(v98反映直後)は調査ファイルのまとめ読みから組み立てる。
 */
const TEAM_MAP_KEY = "kb:universe:teammap";
const TEAM_MAP_TTL_MS = Number(process.env.TEAM_MAP_TTL_MS) || 6 * 60 * 60 * 1000;
const SQUAD_TOP_N = 14;            // 「主力」= 出場時間上位14人(先発11+交代3)
const SQUAD_MIN_RATED = 7;         // 評価点のある主力がこれ未満なら「比較しない」
const SQUAD_MIN_MINUTES = 90;      // 90分未満しか出ていない選手は主力に数えない
const KEY_PLAYER_MIN_MINUTES = 180; // 注目選手は180分以上出ている選手から選ぶ

function normalizeName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * 選手索引の行(fromIndexRow 済みのオブジェクト)から「主力の実測」を組み立てる。
 * @param {Array<object>} players - { name, position, positionJa, minutes, goals, assists, rating, appearances, injured, age }
 */
function squadStrengthFromPlayers(players, opts) {
  const o = opts || {};
  const list = (players || []).filter((p) => p && p.name);
  const withMinutes = list.filter((p) => num(p.minutes) !== null && p.minutes >= (o.minMinutes ?? SQUAD_MIN_MINUTES));
  const core = withMinutes.slice().sort((a, b) => (b.minutes || 0) - (a.minutes || 0)).slice(0, o.topN ?? SQUAD_TOP_N);
  const rated = core.filter((p) => num(p.rating) !== null);
  const avgRating = rated.length ? Math.round((rated.reduce((s, p) => s + p.rating, 0) / rated.length) * 100) / 100 : null;
  const keyPlayers = list
    .filter((p) => num(p.rating) !== null && num(p.minutes) !== null && p.minutes >= (o.keyMinMinutes ?? KEY_PLAYER_MIN_MINUTES))
    .sort((a, b) => (b.rating - a.rating) || ((b.minutes || 0) - (a.minutes || 0)))
    .slice(0, o.keyN ?? 3)
    .map((p) => ({
      name: p.name, position: p.position || null, positionJa: p.positionJa || null, rating: Math.round(p.rating * 100) / 100,
      goals: num(p.goals) ?? 0, assists: num(p.assists) ?? 0, minutes: num(p.minutes) ?? 0,
      appearances: num(p.appearances), injured: p.injured === true,
    }));
  const injured = list.filter((p) => p.injured === true).map((p) => p.name);
  return {
    playersIndexed: list.length,
    coreCount: core.length,
    ratedCount: rated.length,
    avgRating,
    reliable: rated.length >= (o.minRated ?? SQUAD_MIN_RATED),
    keyPlayers,
    injuredIndexed: injured.slice(0, 8),
    injuredIndexedCount: injured.length,
  };
}

function createTeamKnowledge(deps) {
  const {
    CLUB_UNIVERSE, clubDossier, dynamicUniverse,
    getPlayerRows,          // () => { rows: Array<fromIndexRow済み|null>, builtAt }  (プロセス内の選手索引)
    upstashEnabled, upstashCmd, upstashGetJSON,
    nowMs = () => Date.now(),
  } = deps || {};
  const universe = Array.isArray(CLUB_UNIVERSE) ? CLUB_UNIVERSE : [];
  const byNormName = new Map();
  for (const c of universe) {
    byNormName.set(normalizeName(c.nameEn), c);
    if (c.searchAs) byNormName.set(normalizeName(c.searchAs), c);
  }

  const state = { byTeamId: new Map(), builtAt: 0, building: null, source: null, dynamicCount: 0, staticCount: 0 };

  async function readTeamMapFromStore() {
    if (!upstashEnabled || typeof upstashGetJSON !== "function") return null;
    return (await upstashGetJSON(TEAM_MAP_KEY).catch(() => null)) || null;
  }

  async function buildFromDossiers() {
    const entries = [];
    if (clubDossier && typeof clubDossier.getDossiers === "function" && universe.length) {
      const r = await clubDossier.getDossiers(universe.map((c) => c.nameEn));
      for (const c of universe) {
        const d = r.byName.get(c.nameEn);
        if (d && Number.isFinite(Number(d.teamId))) entries.push({ teamId: Number(d.teamId), nameEn: c.nameEn, nameJa: c.nameJa, tier: d.tier || null, dynamic: false, leagueId: c.leagueId || null });
      }
    }
    return entries;
  }

  async function rebuild() {
    const map = new Map();
    let source = "store";
    let staticEntries = [];
    const stored = await readTeamMapFromStore();
    if (stored && Array.isArray(stored.clubs) && stored.clubs.length) {
      for (const e of stored.clubs) {
        if (!e || !Number.isFinite(Number(e.teamId)) || !e.nameEn) continue;
        const uni = byNormName.get(normalizeName(e.nameEn)) || null;
        staticEntries.push({ teamId: Number(e.teamId), nameEn: e.nameEn, nameJa: e.nameJa || (uni && uni.nameJa) || e.nameEn, tier: e.tier || null, dynamic: !!e.dynamic, leagueId: e.leagueId ?? (uni && uni.leagueId) ?? null });
      }
    } else {
      source = "dossiers";
      staticEntries = await buildFromDossiers();
    }
    for (const e of staticEntries) if (!e.dynamic) map.set(e.teamId, e);
    let dynamicCount = 0;
    if (dynamicUniverse && typeof dynamicUniverse.loadAdopted === "function") {
      const ad = await dynamicUniverse.loadAdopted();
      if (ad && ad.ok) {
        for (const [id, v] of ad.map) {
          const teamId = Number(id);
          if (!Number.isFinite(teamId) || !v || !v.nameEn) continue;
          if (!map.has(teamId)) { map.set(teamId, { teamId, nameEn: v.nameEn, nameJa: v.nameJa || v.nameEn, tier: "C", dynamic: true, leagueId: v.leagueId || null, adoptedAt: v.adoptedAt || null }); dynamicCount++; }
        }
      }
    }
    state.byTeamId = map;
    state.builtAt = nowMs();
    state.source = source;
    state.dynamicCount = dynamicCount;
    state.staticCount = map.size - dynamicCount;
    return map;
  }

  async function ensureMap(force) {
    const fresh = state.builtAt && (nowMs() - state.builtAt) < TEAM_MAP_TTL_MS;
    if (!force && fresh) return state.byTeamId;
    if (state.building) return state.building;
    state.building = rebuild().catch(() => state.byTeamId).finally(() => { state.building = null; });
    return state.building;
  }
  function invalidate() { state.builtAt = 0; }

  /** 試合のチーム({id, name})を知識上のクラブへ解決する(teamId 優先・名前は完全一致のみ) */
  async function resolveTeam(team) {
    const map = await ensureMap(false);
    const id = team && Number(team.id);
    if (Number.isFinite(id) && map.has(id)) return map.get(id);
    const uni = byNormName.get(normalizeName(team && team.name));
    if (uni) {
      // 固定名簿にあるが teamId が未保存(収集が一度も成功していない)クラブ
      return { teamId: Number.isFinite(id) ? id : null, nameEn: uni.nameEn, nameJa: uni.nameJa, tier: null, dynamic: false, leagueId: uni.leagueId || null, teamIdUnconfirmed: true };
    }
    return null;
  }

  function playersOf(nameEn) {
    const idx = typeof getPlayerRows === "function" ? getPlayerRows() : null;
    if (!idx || !Array.isArray(idx.players)) return { players: [], builtAt: null, available: false };
    const target = String(nameEn || "").toLowerCase();
    return { players: idx.players.filter((p) => p && String(p.teamEn || "").toLowerCase() === target), builtAt: idx.builtAt || null, available: true };
  }

  /** 1チームぶんの「選手の実測」(索引から。保存先は読まない) */
  function squadStrengthOf(club) {
    if (!club || !club.nameEn) return null;
    const { players, builtAt, available } = playersOf(club.nameEn);
    if (!available) return null;
    return { ...squadStrengthFromPlayers(players), indexBuiltAt: builtAt };
  }

  /**
   * 予測モデルの特徴量用: 主力の平均評価点(信頼できる母数があるときだけ数値。無ければ null)。
   * 日次学習から teamId で呼ばれる。推測で埋めない。
   */
  async function squadRatingForFeature(teamId, nameHint) {
    const club = await resolveTeam({ id: teamId, name: nameHint });
    if (!club) return null;
    const s = squadStrengthOf(club);
    return s && s.reliable ? s.avgRating : null;
  }

  function dossierSummary(d) {
    if (!d || !d.sections) return null;
    const s = d.sections;
    const form = s.form || null;
    const inj = s.injuries || null;
    const coach = s.coach || null;
    const standings = s.standings || null;
    return {
      nameJa: d.nameJa || null,
      tier: d.tier || null,
      updatedAt: d.updatedAt || null,
      form: form ? {
        currentFormScore: num(form.currentFormScore), avgGoalsFor: num(form.avgGoalsFor), avgGoalsAgainst: num(form.avgGoalsAgainst),
        recentResults: Array.isArray(form.recentResults) ? form.recentResults.slice(0, 5).map((r) => ({
          date: r.date || null, opponent: r.opponent || null, homeAway: r.homeAway || null, goalsFor: num(r.goalsFor), goalsAgainst: num(r.goalsAgainst),
        })) : [],
        computedAt: form.computedAt || null,
      } : null,
      injuries: inj ? {
        count: num(inj.injuryCount),
        players: (Array.isArray(inj.injuredPlayers) ? inj.injuredPlayers : []).slice(0, 6).map((p) => (typeof p === "string" ? p : (p && (p.name || p.player)) || null)).filter(Boolean),
        suspended: (Array.isArray(inj.suspendedPlayers) ? inj.suspendedPlayers : []).slice(0, 4).map((p) => (typeof p === "string" ? p : (p && (p.name || p.player)) || null)).filter(Boolean),
        computedAt: inj.computedAt || null,
      } : null,
      coach: coach ? { name: coach.coachName || null, formation: coach.formation || null, computedAt: coach.computedAt || null } : null,
      standings: standings ? { rank: num(standings.rank), points: num(standings.points), played: num(standings.played), computedAt: standings.computedAt || null } : null,
      recentChanges: Array.isArray(d.lastChangesJa) ? d.lastChangesJa.slice(0, 3) : [],
    };
  }

  /**
   * 試合カード用: 両チームの知識をまとめて返す(調査ファイルは MGET 1回)。
   * @param {{id:number, name:string}} home
   * @param {{id:number, name:string}} away
   */
  async function knowledgeForFixture(home, away) {
    const [hc, ac] = await Promise.all([resolveTeam(home), resolveTeam(away)]);
    const names = [hc && hc.nameEn, ac && ac.nameEn].filter(Boolean);
    let byName = new Map(); let readFailed = false;
    if (names.length && clubDossier && typeof clubDossier.getDossiers === "function") {
      try {
        const r = await clubDossier.getDossiers(names);
        byName = r.byName; readFailed = !!r.readFailed;
      } catch (e) { readFailed = true; }
    }
    const pack = (team, club) => {
      if (!club) return { tracked: false, teamId: (team && Number(team.id)) || null, nameEn: (team && team.name) || null, reason: "untracked" };
      const d = byName.get(club.nameEn) || null;
      return {
        tracked: true, teamId: club.teamId ?? null, nameEn: club.nameEn, nameJa: club.nameJa || null,
        tier: club.tier || (d && d.tier) || null, dynamic: !!club.dynamic, adoptedAt: club.adoptedAt || null,
        squad: squadStrengthOf(club),
        dossier: dossierSummary(d),
        dossierMissing: !d,
      };
    };
    return { home: pack(home, hc), away: pack(away, ac), readFailed, mapSource: state.source, mapBuiltAt: state.builtAt ? new Date(state.builtAt).toISOString() : null };
  }

  /** 同期版: 固定名簿(静的)のチームか(候補記録の除外判定用。表が未構築なら名前だけで判定) */
  function isStaticTeamSync(teamId, name) {
    const id = Number(teamId);
    if (Number.isFinite(id) && state.byTeamId.has(id) && !state.byTeamId.get(id).dynamic) return true;
    return byNormName.has(normalizeName(name));
  }

  function snapshot() {
    return { clubsMapped: state.byTeamId.size, staticCount: state.staticCount, dynamicCount: state.dynamicCount, source: state.source, builtAt: state.builtAt ? new Date(state.builtAt).toISOString() : null };
  }

  return { ensureMap, invalidate, resolveTeam, squadStrengthOf, squadRatingForFeature, knowledgeForFixture, snapshot, isStaticTeamSync, TEAM_MAP_KEY };
}

module.exports = { createTeamKnowledge, squadStrengthFromPlayers, normalizeName, TEAM_MAP_KEY, SQUAD_TOP_N, SQUAD_MIN_RATED };
