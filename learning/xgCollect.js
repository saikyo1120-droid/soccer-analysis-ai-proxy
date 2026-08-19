/**
 * server/learning/xgCollect.js
 * ------------------------------------------------
 * 2026年8月19日・v57「xGの前向き収集」(利用者のご要望①)。
 *
 * ■ 何か
 *   実ゴールは運のノイズが大きい。xG(決定機の質)で地力を学習すると
 *   同じ試合数でも安定する、というのがサッカー分析の定説。
 *   API-Footballの試合統計(/fixtures/statistics)には多くのリーグで
 *   expected_goals が含まれるので、**昨日終わった9リーグの試合ぶんを毎日
 *   少しずつ収集**して learn:xg:map に貯める。
 *
 * ■ 正直な設計
 *   ・過去3シーズンぶんを一括取得することはしない(約1.2万試合×1リクエスト
 *     ずつ必要で、日次予算を数日つぶすため)。前向きに毎日貯める。
 *     したがって「xGが地力学習に効き始めるのはデータが300試合貯まってから」
 *     (それまでα=0のまま=従来と完全同一)。この設計自体を画面とREADMEで開示する。
 *   ・xGが提供されない試合・リーグは欠損のまま(推測で埋めない)。
 *   ・1日の統計取得は上限つき(既定30試合・jobCall=利用者枠に触れない)。
 *
 * ■ 保存形式
 *   learn:xg:map = { builtAt, entries: { "YYYY-MM-DD:homeId:awayId": [xh, xa] } }
 *   キーは日付+チームIDで、データセット(週次で作り直される)と独立に生き残る。
 *   上限6000件(古い日付から捨てる)。
 */

const XG_MAP_KEY = "learn:xg:map";
const MAX_ENTRIES = 6000;
const DEFAULT_STATS_CAP = 30;

function xgKey(dateStr, homeId, awayId) {
  return `${String(dateStr).slice(0, 10)}:${homeId}:${awayId}`;
}

/** /fixtures/statistics の応答から両チームのxGを取り出す(無ければnull) */
function extractXg(statsResponse, homeId, awayId) {
  const list = (statsResponse && statsResponse.response) || [];
  let xh = null, xa = null;
  for (const side of list) {
    const teamId = side && side.team && side.team.id;
    const stats = (side && side.statistics) || [];
    const row = stats.find((s) => s && String(s.type || "").toLowerCase() === "expected_goals");
    const v = row ? Number(row.value) : NaN;
    if (!Number.isFinite(v)) continue;
    if (teamId === homeId) xh = v;
    else if (teamId === awayId) xa = v;
  }
  return (Number.isFinite(xh) && Number.isFinite(xa)) ? [xh, xa] : null;
}

/** 古い日付のエントリから捨てて上限内に収める */
function pruneEntries(entries, max) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return 0;
  keys.sort(); // キー先頭がYYYY-MM-DDなので辞書順=日付順
  let removed = 0;
  for (const k of keys) {
    if (Object.keys(entries).length <= max) break;
    delete entries[k];
    removed++;
  }
  return removed;
}

/**
 * 昨日終わった対象リーグの試合のxGを収集して learn:xg:map へ追記する。
 * @param deps { callApiFootball, upstashGetJSON, upstashSetJSON, apiBudget }
 * @param opts { leagueIds, season, dateStr(昨日のYYYY-MM-DD), statsCap }
 */
async function collectRecentXg(deps, opts) {
  const { callApiFootball, upstashGetJSON, upstashSetJSON, apiBudget } = deps;
  const leagueIds = (opts && opts.leagueIds) || [];
  const dateStr = opts && opts.dateStr;
  const season = opts && opts.season;
  const statsCap = (opts && opts.statsCap) || DEFAULT_STATS_CAP;
  const out = { ran: false, leaguesChecked: 0, fixturesSeen: 0, statsFetched: 0, xgSaved: 0, alreadyHad: 0, noXgProvided: 0, errors: [], entriesTotal: null, reasonJa: null };
  if (!upstashSetJSON || !dateStr || !leagueIds.length) { out.reasonJa = "保存先または対象日がありません。"; return out; }
  const needed = leagueIds.length + statsCap;
  if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(needed + 50)) {
    out.reasonJa = `API予算の残りが少ないため今回は見送りました(必要見込み約${needed}件)。`;
    return out;
  }
  const saved = (await upstashGetJSON(XG_MAP_KEY).catch(() => null)) || { entries: {} };
  const entries = saved.entries || {};
  out.ran = true;
  let statsBudget = statsCap;
  for (const lg of leagueIds) {
    try {
      const fx = await callApiFootball("/fixtures", { league: lg, season, date: dateStr }, { jobCall: true });
      out.leaguesChecked++;
      for (const f of (fx && fx.response) || []) {
        const st = f && f.fixture && f.fixture.status && f.fixture.status.short;
        if (!/^(FT|AET|PEN)$/.test(String(st || ""))) continue;
        const homeId = f.teams && f.teams.home && f.teams.home.id;
        const awayId = f.teams && f.teams.away && f.teams.away.id;
        if (!Number.isFinite(homeId) || !Number.isFinite(awayId)) continue;
        out.fixturesSeen++;
        const key = xgKey(f.fixture.date, homeId, awayId);
        if (entries[key]) { out.alreadyHad++; continue; }
        if (statsBudget <= 0) continue; // 上限到達(残りは明日以降。黙って捨てない=カウントに出る)
        statsBudget--;
        try {
          const stats = await callApiFootball("/fixtures/statistics", { fixture: f.fixture.id }, { jobCall: true });
          out.statsFetched++;
          const xg = extractXg(stats, homeId, awayId);
          if (xg) { entries[key] = xg; out.xgSaved++; }
          else out.noXgProvided++;
        } catch (e) {
          out.errors.push(`stats_failed:${f.fixture.id}:${(e && e.code) || "err"}`);
        }
      }
    } catch (e) {
      out.errors.push(`fixtures_failed:${lg}:${(e && e.code) || "err"}`);
    }
  }
  pruneEntries(entries, MAX_ENTRIES);
  out.entriesTotal = Object.keys(entries).length;
  const ok = await upstashSetJSON(XG_MAP_KEY, { builtAt: (opts && opts.nowIso) || new Date().toISOString(), entries }).catch(() => false);
  if (ok === false) out.errors.push("xg_map_save_failed");
  out.errors = out.errors.slice(0, 5);
  return out;
}

/** 保存済みマップから lookup(date, homeId, awayId) を作る */
function makeXgLookup(savedMap) {
  const entries = (savedMap && savedMap.entries) || {};
  return (dateStr, homeId, awayId) => entries[xgKey(dateStr, homeId, awayId)] || null;
}

module.exports = { XG_MAP_KEY, MAX_ENTRIES, xgKey, extractXg, pruneEntries, collectRecentXg, makeXgLookup };
