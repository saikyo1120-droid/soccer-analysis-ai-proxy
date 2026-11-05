/**
 * server/learning/dynamicUniverse.js
 * ------------------------------------------------
 * v98(2026年11月5日・利用者の指摘「登録選手データがない試合が多い」への対応③)
 * 「見た試合のクラブは翌日までに自動で取り込む」ための動的クラブ宇宙。
 *
 * ■ 背景(実測)
 *   知識の収集対象(clubUniverse.js)は172クラブの固定名簿だった。「本日の実際の試合」は
 *   毎日80試合を世界中から表示するため、その多くが名簿の外にあり、選手データ・怪我・監督・
 *   フォームを一切持っていなかった。しかも外のクラブを取りに行く経路が無く、使い続けても
 *   守備範囲が広がらなかった。
 *
 * ■ 設計
 *   ・「候補」: 今日の試合一覧に現れたチーム(/api/fixtures/today)、利用者がカードを開いた
 *     チーム(/api/fixture-analysis)、予想時にデータが欠けていたチーム(data_missing)を
 *     teamId 単位で記録する(kb:universe:dyn:seen)。候補の記録はまとめ書き(HSET 1回)。
 *   ・「採用」: 毎晩の学習で、候補の中から優先度の高い順に1日 UNIVERSE_DYNAMIC_PER_DAY
 *     (既定20)クラブを採用する(kb:universe:dyn:adopted)。採用済みクラブは翌日の収集で
 *     固定名簿のクラブと同じ流れ(フォーム・怪我・布陣・名簿・選手の一括成績)で取得される。
 *   ・優先度: 予想時にデータが欠けていたチーム > 学習対象大会のチーム > 利用者が開いた回数
 *     > 出現回数 > 最後に見た日の新しさ。2軍・女子・ユースは候補にしない。
 *   ・上限: 採用総数 UNIVERSE_DYNAMIC_MAX(既定300)。60日以上出現しないクラブは採用から外す
 *     (調査ファイルは残る。再び現れれば候補に戻る)。
 *   ・方針⑥: 利用者の操作の瞬間には何も取得しない。候補の記録だけ(1コマンド)で、取得は夜間。
 *   ・でっち上げ防止: 候補はAPIが実際に返したチーム(teamIdあり)だけ。名前の推測で作らない。
 *
 * ■ 保存形式
 *   kb:universe:dyn:seen     … HASH teamId -> JSON {nameEn, leagueId, league, country,
 *                               firstSeen, lastSeen, seen, views, learned, missing}
 *   kb:universe:dyn:adopted  … HASH teamId -> JSON {nameEn, nameJa, leagueId, country,
 *                               adoptedAt, lastSeen, lastCollectedAt, reasonJa}
 */
const { noteWarning } = require("./warnings"); // v92方針: 黙って続行しない(痕跡を残す)
const SEEN_KEY = "kb:universe:dyn:seen";
const ADOPTED_KEY = "kb:universe:dyn:adopted";
const DEFAULT_PER_DAY = Number(process.env.UNIVERSE_DYNAMIC_PER_DAY) || 20;
const DEFAULT_MAX_ADOPTED = Number(process.env.UNIVERSE_DYNAMIC_MAX) || 300;
const SEEN_KEEP_DAYS = 30;       // 候補として覚えておく期間
const ADOPTED_IDLE_DAYS = 60;    // この日数以上出現しない採用クラブは採用から外す
const REFRESH_WINDOW_DAYS = 3;   // 直近この日数に出現した採用クラブだけを毎日更新する
// B/女子/ユース(clubUniverse.js の SECONDARY_SQUAD_RE と同じ考え方)
const SECONDARY_RE = /(^|[\s.-])(b|ii|iii|u1[5-9]|u2[0-3]|w|women|fem|femenino|feminin|reserves?|academy|youth|jr|junior|sub\d+)([\s.-]|$)/i;

function dayKeyOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function daysBetween(aKey, bKey) {
  const a = Date.parse(String(aKey) + "T00:00:00Z"), b = Date.parse(String(bKey) + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}
function parseHash(raw) {
  // Upstash の HGETALL は [field, value, ...] または {field: value} で返る
  const out = new Map();
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out.set(String(raw[i]), raw[i + 1]);
  } else if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) out.set(String(k), raw[k]);
  }
  const parsed = new Map();
  let corrupt = 0;
  for (const [k, v] of out) {
    try { parsed.set(k, typeof v === "string" ? JSON.parse(v) : v); } catch (e) { corrupt++; } // 壊れた行は数えて開示する(黙って捨てない)
  }
  parsed.corrupt = corrupt;
  return parsed;
}
function isSecondaryName(name) { return SECONDARY_RE.test(String(name || "")); }

const SEEN_CACHE_MS = Number(process.env.UNIVERSE_DYNAMIC_SEEN_CACHE_MS) || 60 * 60 * 1000;

function createDynamicUniverse(deps) {
  const { upstashEnabled, upstashCmd } = deps || {};
  const enabled = !!upstashEnabled && typeof upstashCmd === "function";
  const nowFn = (deps && typeof deps.nowMs === "function") ? deps.nowMs : () => Date.now();
  // 候補ハッシュのプロセス内キャッシュ(1時間)。候補の記録のたびに HGETALL しない
  // (試合一覧は15分キャッシュなので、記録は多くても1日96回。読みは1時間に1回で十分)。
  const seenCache = { map: null, loadedAt: 0 };

  async function readHash(key) {
    if (!enabled) return { ok: true, map: new Map() };
    try {
      const raw = await upstashCmd(["HGETALL", key]);
      return { ok: true, map: parseHash(raw) };
    } catch (e) {
      return { ok: false, map: new Map(), error: String((e && e.message) || e).slice(0, 120) };
    }
  }

  /**
   * 候補チームを記録する(まとめ書き)。
   * @param {Array<{teamId:number, nameEn:string, leagueId?:number, league?:string, country?:string}>} teams
   * @param {{source:string, nowMs?:number, learnedLeagueIds?:Set<number>, views?:boolean, missing?:boolean}} opts
   *   source: "fixtures" | "view" | "data_missing"
   */
  async function recordSeen(teams, opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const today = dayKeyOf(nowMs);
    const clean = [];
    const seenIds = new Set();
    for (const t of teams || []) {
      const id = Number(t && t.teamId);
      if (!Number.isFinite(id) || id <= 0 || seenIds.has(id)) continue;
      if (!t.nameEn || isSecondaryName(t.nameEn)) continue;
      if (typeof o.isStaticTeam === "function" && o.isStaticTeam(id, t.nameEn)) continue;
      seenIds.add(id);
      clean.push({ ...t, teamId: id });
    }
    if (!clean.length) return { ok: true, recorded: 0 };
    if (!enabled) return { ok: false, recorded: 0, reasonJa: "保存先(Upstash)が未設定のため候補を記録できません。" };
    let cur;
    if (seenCache.map && (nowFn() - seenCache.loadedAt) < SEEN_CACHE_MS) cur = { ok: true, map: seenCache.map };
    else {
      cur = await readHash(SEEN_KEY);
      if (!cur.ok) return { ok: false, recorded: 0, reasonJa: `候補の読み出しに失敗しました(${cur.error})` };
      seenCache.map = cur.map; seenCache.loadedAt = nowFn();
    }
    const args = ["HSET", SEEN_KEY];
    const nextEntries = [];
    for (const t of clean) {
      const prev = cur.map.get(String(t.teamId)) || null;
      const learned = !!(o.learnedLeagueIds instanceof Set && Number.isFinite(Number(t.leagueId)) && o.learnedLeagueIds.has(Number(t.leagueId)));
      const next = {
        nameEn: t.nameEn,
        leagueId: Number.isFinite(Number(t.leagueId)) ? Number(t.leagueId) : (prev && prev.leagueId) || null,
        league: t.league || (prev && prev.league) || null,
        country: t.country || (prev && prev.country) || null,
        firstSeen: (prev && prev.firstSeen) || today,
        lastSeen: today,
        seen: ((prev && prev.seen) || 0) + (o.source === "fixtures" || o.source === "data_missing" ? 1 : 0),
        views: ((prev && prev.views) || 0) + (o.source === "view" ? 1 : 0),
        learned: !!((prev && prev.learned) || learned),
        missing: ((prev && prev.missing) || 0) + (o.source === "data_missing" ? 1 : 0),
      };
      args.push(String(t.teamId), JSON.stringify(next));
      nextEntries.push([String(t.teamId), next]);
    }
    try {
      await upstashCmd(args);
      for (const [id, v] of nextEntries) cur.map.set(id, v); // キャッシュも更新(次回の seen/views の加算が正しくなる)
      return { ok: true, recorded: clean.length };
    } catch (e) {
      return { ok: false, recorded: 0, reasonJa: `候補の保存に失敗しました(${String((e && e.message) || e).slice(0, 120)})` };
    }
  }

  async function loadAdopted() { return readHash(ADOPTED_KEY); }
  async function loadSeen() { return readHash(SEEN_KEY); }

  /**
   * 今日の採用を決める(毎晩の学習から1回だけ呼ぶ)。
   * @returns {{ok, adoptedNow:[], adoptedAll:[], candidates:number, prunedSeen:number, retired:number, reasonJa}}
   */
  async function adoptForToday(opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const today = o.dateKey || dayKeyOf(nowMs);
    const perDay = Number.isFinite(o.perDay) ? Math.max(0, o.perDay) : DEFAULT_PER_DAY;
    const maxAdopted = Number.isFinite(o.maxAdopted) ? o.maxAdopted : DEFAULT_MAX_ADOPTED;
    const isStaticTeam = typeof o.isStaticTeam === "function" ? o.isStaticTeam : () => false;
    const empty = { ok: true, adoptedNow: [], adoptedAll: [], candidates: 0, prunedSeen: 0, retired: 0 };
    if (!enabled) return { ...empty, ok: false, reasonJa: "保存先(Upstash)が未設定のため動的クラブは使えません。" };
    const seen = await readHash(SEEN_KEY);
    const adopted = await readHash(ADOPTED_KEY);
    if (!seen.ok || !adopted.ok) {
      return { ...empty, ok: false, reasonJa: `候補または採用済みの一覧を読めなかったため、今日の採用を見送りました(${seen.error || adopted.error})。` };
    }
    // ① 古い候補の掃除(30日以上現れていない)と、固定名簿に居るチームの除外
    const toDelete = [];
    for (const [id, v] of seen.map) {
      const age = daysBetween(v && v.lastSeen, today);
      if (!v || !Number.isFinite(age) || age > SEEN_KEEP_DAYS || isStaticTeam(Number(id), v.nameEn) || isSecondaryName(v.nameEn)) toDelete.push(id);
    }
    const out = { ...empty, warnings: [] };
    if (seen.map.corrupt) noteWarning(out, "dyn_seen_corrupt_rows", String(seen.map.corrupt));
    if (toDelete.length) { try { await upstashCmd(["HDEL", SEEN_KEY, ...toDelete]); } catch (e) { noteWarning(out, "dyn_prune_failed", e); } for (const id of toDelete) seen.map.delete(id); }
    seenCache.map = seen.map; seenCache.loadedAt = nowFn(); // 掃除後の最新をキャッシュへ
    // ② 採用済みのうち、60日以上現れていないクラブは採用から外す(調査ファイルは残る)
    const retire = [];
    for (const [id, v] of adopted.map) {
      const s = seen.map.get(id);
      const last = (s && s.lastSeen) || (v && v.lastSeen) || (v && v.adoptedAt);
      if (daysBetween(last, today) > ADOPTED_IDLE_DAYS) retire.push(id);
    }
    if (retire.length) { try { await upstashCmd(["HDEL", ADOPTED_KEY, ...retire]); } catch (e) { noteWarning(out, "dyn_retire_failed", e); } for (const id of retire) adopted.map.delete(id); }
    // ③ 候補の優先順位
    const candidates = [...seen.map.entries()]
      .filter(([id]) => !adopted.map.has(id))
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) =>
        (b.missing || 0) - (a.missing || 0)
        || Number(!!b.learned) - Number(!!a.learned)
        || (b.views || 0) - (a.views || 0)
        || (b.seen || 0) - (a.seen || 0)
        || String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    const room = Math.max(0, maxAdopted - adopted.map.size);
    const pick = candidates.slice(0, Math.min(perDay, room));
    const adoptedNow = [];
    if (pick.length) {
      const args = ["HSET", ADOPTED_KEY];
      for (const c of pick) {
        const reasonJa = c.missing ? "予想時にこのチームのデータが欠けていたため"
          : c.learned ? "AIが予想している大会のチームのため"
          : c.views ? `利用者がこのチームの試合カードを${c.views}回開いたため`
          : `本日の試合一覧に${c.seen}回現れたため`;
        const entry = {
          nameEn: c.nameEn, nameJa: c.nameEn, leagueId: c.leagueId || null, league: c.league || null, country: c.country || null,
          adoptedAt: today, lastSeen: c.lastSeen || today, lastCollectedAt: null, reasonJa,
        };
        args.push(String(c.id), JSON.stringify(entry));
        adoptedNow.push({ teamId: Number(c.id), ...entry });
        adopted.map.set(String(c.id), entry);
      }
      try { await upstashCmd(args); }
      catch (e) { return { ...out, ok: false, candidates: candidates.length, reasonJa: `採用の保存に失敗しました(${String((e && e.message) || e).slice(0, 120)})` }; }
    }
    // ④ 採用済みの lastSeen を候補側の最新で更新(まとめ書き1回。変化があるときだけ)
    const refreshArgs = ["HSET", ADOPTED_KEY];
    for (const [id, v] of adopted.map) {
      const s = seen.map.get(id);
      if (s && s.lastSeen && s.lastSeen !== v.lastSeen) { v.lastSeen = s.lastSeen; refreshArgs.push(id, JSON.stringify(v)); }
    }
    if (refreshArgs.length > 2) { try { await upstashCmd(refreshArgs); } catch (e) { noteWarning(out, "dyn_lastseen_refresh_failed", e); } }
    const adoptedAll = [...adopted.map.entries()].map(([id, v]) => ({ teamId: Number(id), ...v }));
    return { ...out, ok: true, adoptedNow, adoptedAll, candidates: candidates.length, prunedSeen: toDelete.length, retired: retire.length };
  }

  /**
   * 収集(universeCollector)へ渡す「クラブ」の形に変換する。
   * newlyAdoptedIds に含まれるクラブは名簿・一括成績も今日取得する。
   * それ以外は「直近 REFRESH_WINDOW_DAYS 日に出現したクラブ」だけを更新対象にする。
   */
  function clubObjectsFor(adoptedAll, opts) {
    const o = opts || {};
    const today = o.dateKey || dayKeyOf(Number.isFinite(o.nowMs) ? o.nowMs : Date.now());
    const perDay = Number.isFinite(o.perDay) ? o.perDay : DEFAULT_PER_DAY;
    const newly = o.newlyAdoptedIds instanceof Set ? o.newlyAdoptedIds : new Set();
    const list = (adoptedAll || []).map((e, i) => ({
      nameEn: e.nameEn, nameJa: e.nameJa || e.nameEn, country: e.country || null,
      leagueId: Number.isFinite(Number(e.leagueId)) ? Number(e.leagueId) : null,
      rank: 1000 + i, apiTeamId: Number(e.teamId), dynamic: true,
      adoptedAt: e.adoptedAt || null, lastSeen: e.lastSeen || null, lastCollectedAt: e.lastCollectedAt || null,
      isNew: newly.has(Number(e.teamId)),
    }));
    const due = list.filter((c) => c.isNew
      || (daysBetween(c.lastSeen, today) <= REFRESH_WINDOW_DAYS && (!c.lastCollectedAt || c.lastCollectedAt !== today)));
    // 新規採用を先頭に、次に最後の収集が古い順
    due.sort((a, b) => Number(!!b.isNew) - Number(!!a.isNew) || String(a.lastCollectedAt || "").localeCompare(String(b.lastCollectedAt || "")));
    return { all: list, due: due.slice(0, perDay), skippedByCap: Math.max(0, due.length - perDay) };
  }

  /** 収集後に「いつ収集したか」を書き戻す(まとめ書き1回) */
  async function markCollected(teamIds, dateKey) {
    if (!enabled || !teamIds || !teamIds.length) return false;
    const adopted = await readHash(ADOPTED_KEY);
    if (!adopted.ok) return false;
    const args = ["HSET", ADOPTED_KEY];
    for (const id of teamIds) {
      const v = adopted.map.get(String(id));
      if (!v) continue;
      v.lastCollectedAt = dateKey;
      args.push(String(id), JSON.stringify(v));
    }
    if (args.length <= 2) return false;
    try { await upstashCmd(args); return true; } catch (e) { return false; }
  }

  return { recordSeen, loadSeen, loadAdopted, adoptForToday, clubObjectsFor, markCollected,
    SEEN_KEY, ADOPTED_KEY, DEFAULT_PER_DAY, DEFAULT_MAX_ADOPTED, REFRESH_WINDOW_DAYS, isSecondaryName };
}

module.exports = { createDynamicUniverse, isSecondaryName, SEEN_KEY, ADOPTED_KEY, DEFAULT_PER_DAY, DEFAULT_MAX_ADOPTED };
