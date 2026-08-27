/**
 * server/learning/oddsApi.js
 * ------------------------------------------------
 * 2026年8月19日・v57「複数ブックメーカーのコンセンサスオッズ」(The Odds API)。
 *
 * ■ 何のためか(利用者のご要望②)
 *   これまで市場シグナルはAPI-Footballの1ソースだった。The Odds APIから
 *   複数ブックメーカーのh2h(勝ち分け負け)オッズを取り、マージン(控除率)を
 *   取り除いた含意確率の平均=コンセンサスを作る。市場ブレンド(v50)と
 *   marketEdge特徴量(v47)の入力が「1社の声」から「市場の合意」に変わる。
 *
 * ■ 正直さと安全(このプロジェクトの流儀)
 *   ・ODDS_API_KEY が未設定なら、このモジュールは一切動かない(従来と完全同一)。
 *   ・無料枠(500クレジット/月)内で運用できるよう、月間クレジット予算を
 *     Redisで数えて上限で止める(既定480。ODDS_API_MONTHLY_BUDGETで変更可)。
 *     1回の取得 = 1リーグ全試合ぶん = 1クレジット(regions=eu × markets=h2h)。
 *   ・チーム名の照合が曖昧(候補2件以上)な試合は使わない(誤マッチで
 *     別の試合のオッズを混ぜるくらいなら、正直に「無し」にする)。
 *   ・どの試合で何社の平均を使ったかは record.oddsSource として保存し、画面で開示する。
 *
 * ■ クレジット試算(無料枠500/月の内訳)
 *   朝の学習: その日に対象試合があるリーグだけ取得(最大9/日) ≒ 月200前後。
 *   直前ウォッチ(lineupWatch): キックオフ帯のリーグだけ(最大9/日) ≒ 月200前後。
 *   合計は予算480で必ず頭打ち(超えたら残りは従来のAPI-Footballオッズのみ)。
 */

const ODDS_API_HOST = "api.the-odds-api.com";

// API-FootballのリーグID → The Odds APIのsport key(9リーグ・実表で確認済み)
const SPORT_KEYS = {
  39: "soccer_epl",
  140: "soccer_spain_la_liga",
  78: "soccer_germany_bundesliga",
  135: "soccer_italy_serie_a",
  61: "soccer_france_ligue_one",
  88: "soccer_netherlands_eredivisie",
  94: "soccer_portugal_primeira_liga",
  203: "soccer_turkey_super_league",
  144: "soccer_belgium_first_div",
  // v58: 欧州カップ戦(The Odds APIの公式sport key・実表で確認済み)
  2: "soccer_uefa_champs_league",
  3: "soccer_uefa_europa_league",
  848: "soccer_uefa_europa_conference_league",
};

const DEFAULT_MONTHLY_BUDGET = 480; // 無料枠500に対する安全マージン
const CREDITS_KEY_PREFIX = "oddsapi:credits:"; // oddsapi:credits:<YYYY-MM(UTC)>

function isEnabled(env) {
  return !!(env && env.ODDS_API_KEY);
}
function monthlyBudget(env) {
  const n = Number(env && env.ODDS_API_MONTHLY_BUDGET);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MONTHLY_BUDGET;
}
function monthKeyUtc(nowMs) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 月間クレジットをn消費する。予算超過なら消費を戻してfalse。
 * (The Odds APIの課金月とは厳密には一致しない可能性があるが、安全側=少なめに使う)
 */
async function tryConsumeCredits(deps, n, nowMs) {
  const { upstashCmd, env } = deps;
  if (!upstashCmd) return false; // 数えられない環境では使わない(青天井を避ける)
  const key = `${CREDITS_KEY_PREFIX}${monthKeyUtc(nowMs)}`;
  try {
    const used = Number(await upstashCmd(["INCRBY", key, String(n)]));
    await upstashCmd(["EXPIRE", key, String(40 * 86400)]).catch(() => {});
    if (!Number.isFinite(used) || used > monthlyBudget(env)) {
      await upstashCmd(["DECRBY", key, String(n)]).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ---- チーム名の照合 ----------------------------------------------------
// API-FootballとThe Odds APIは表記が微妙に違う(例: Wolves / Wolverhampton Wanderers)。
// 規則: 正規化 → 完全一致 → 別名表 → トークン包含。曖昧なら不採用(正直)。
const NAME_ALIASES = {
  "wolves": "wolverhampton wanderers",
  "spurs": "tottenham hotspur",
  "man united": "manchester united",
  "man city": "manchester city",
  "psg": "paris saint germain",
  "paris sg": "paris saint germain", // ClubElo表記(v57)
  "inter": "inter milan",
  "athletic club": "athletic bilbao",
  // v67: 綴り違いの英語名(ダイアクリティカル除去では埋まらない別綴り)。
  //   本番実測: 「Bayern Munich」がAPI-Football正式名「Bayern München」と照合できず、
  //   ・The Odds APIのコンセンサスがバイエルンの試合を一度も照合できていなかった
  //   ・対戦分析で「バイエルン」が女子チーム(Bayern Munich W)に化けた
  //   の2つの実バグの根になっていた。正規化後の完全一致だけを許す(推測はしない)。
  "bayern munich": "bayern munchen",
  "cologne": "koln", // The Odds API表記「FC Cologne」→ 正式名「1. FC Köln」
};
function normName(s) {
  let t = String(s || "").toLowerCase();
  t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); // ダイアクリティカル除去
  t = t.replace(/[&.\-']/g, " ");
  t = t.replace(/\b(fc|afc|cf|ac|sc|cd|sd|bk|if|sk|1)\b/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return NAME_ALIASES[t] || t;
}
function tokensOf(s) { return new Set(normName(s).split(" ").filter(Boolean)); }
function namesMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokensOf(a), tb = tokensOf(b);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let common = 0;
  for (const t of small) if (large.has(t)) common++;
  // 小さい方のトークンが全て含まれる(Brighton ⊆ Brighton and Hove Albion)か、共通2語以上
  return (common === small.size && small.size >= 1) || common >= 2;
}

// ---- コンセンサスの計算 ------------------------------------------------
/**
 * 1ブックメーカーのh2hから、マージン(控除率)を除いた含意確率を出す。
 * p_i = (1/odds_i) / Σ(1/odds_j) …「オッズの逆数を正規化」= 標準的なde-vig。
 */
function devigOneBook(prices) {
  const inv = prices.map((p) => (Number.isFinite(p) && p > 1 ? 1 / p : null));
  if (inv.some((v) => v === null)) return null;
  const sum = inv.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return inv.map((v) => v / sum);
}

/**
 * The Odds APIのイベント配列 → 試合ごとのコンセンサス。
 * @returns [{ home, away, kickoffMs, consensus: {homePct, drawPct, awayPct}, nBooks }]
 */
function buildConsensusEvents(apiEvents) {
  const out = [];
  for (const ev of Array.isArray(apiEvents) ? apiEvents : []) {
    const home = ev && ev.home_team, away = ev && ev.away_team;
    const kickoffMs = ev && ev.commence_time ? Date.parse(ev.commence_time) : NaN;
    if (!home || !away || !Number.isFinite(kickoffMs)) continue;
    const perBook = [];
    for (const bk of (ev.bookmakers || [])) {
      const mkt = (bk.markets || []).find((m) => m && m.key === "h2h");
      if (!mkt) continue;
      const byName = new Map((mkt.outcomes || []).map((o) => [o.name, Number(o.price)]));
      const pH = byName.get(home), pA = byName.get(away), pD = byName.get("Draw");
      const devig = devigOneBook([pH, pD, pA]);
      if (devig) perBook.push(devig);
    }
    if (!perBook.length) continue;
    const avg = [0, 1, 2].map((i) => perBook.reduce((a, b) => a + b[i], 0) / perBook.length);
    out.push({
      home, away, kickoffMs,
      nBooks: perBook.length,
      consensus: {
        homePct: Math.round(avg[0] * 1000) / 10,
        drawPct: Math.round(avg[1] * 1000) / 10,
        awayPct: Math.round(avg[2] * 1000) / 10,
      },
    });
  }
  return out;
}

/**
 * 1リーグぶんのコンセンサスを取得する(=1クレジット)。
 * 失敗・予算切れ・未対応リーグは null(正直に「無し」)。
 * @param deps { fetchFn, upstashCmd, env, log? }
 */
async function fetchLeagueConsensus(deps, leagueId, nowMs) {
  const { fetchFn, env } = deps;
  const sportKey = SPORT_KEYS[leagueId];
  if (!sportKey || !isEnabled(env) || typeof fetchFn !== "function") return null;
  if (!(await tryConsumeCredits(deps, 1, nowMs))) {
    return { ok: false, reason: "budget_exhausted", events: [] };
  }
  const url = `https://${ODDS_API_HOST}/v4/sports/${sportKey}/odds` +
    `?apiKey=${encodeURIComponent(env.ODDS_API_KEY)}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) return { ok: false, reason: `http_${res ? res.status : "no_response"}`, events: [] };
    const json = await res.json();
    return { ok: true, reason: null, events: buildConsensusEvents(json) };
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "network" : String((e && e.message) || e).slice(0, 60), events: [] };
  }
}

/**
 * 取得済みイベント一覧から、この試合のコンセンサスを探す。
 * 両チーム名が一致し、キックオフが±3時間以内。候補が2件以上なら不採用(誤マッチ防止)。
 */
function matchFixture(events, homeName, awayName, kickoffIso) {
  if (!Array.isArray(events) || !events.length) return null;
  const ko = kickoffIso ? Date.parse(kickoffIso) : NaN;
  const hits = events.filter((ev) =>
    namesMatch(ev.home, homeName) && namesMatch(ev.away, awayName)
    && (!Number.isFinite(ko) || Math.abs(ev.kickoffMs - ko) <= 3 * 3600 * 1000));
  if (hits.length !== 1) return null;
  return hits[0];
}

module.exports = {
  SPORT_KEYS, DEFAULT_MONTHLY_BUDGET, CREDITS_KEY_PREFIX,
  isEnabled, monthlyBudget, monthKeyUtc, tryConsumeCredits,
  normName, namesMatch, devigOneBook, buildConsensusEvents,
  fetchLeagueConsensus, matchFixture,
};
