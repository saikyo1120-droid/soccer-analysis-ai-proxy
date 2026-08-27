/**
 * server/learning/matchupAnalysis.js
 * ------------------------------------------------
 * 2026年8月19日・v59「どんな対戦でも1行で分析する入口」(利用者のご要望①)。
 *
 * ■ 何をするか
 *   「レアル・マドリード vs バルセロナ」のような1行を受け取り、
 *   **今日の試合予定に無い対戦でも**、AIが実際に学習した中身で分析して返す。
 *     ・地力レーティング(Dixon-Coles・12大会×5シーズンの実試合で学習)
 *     ・学習済みのρ(スコア分布の補正)
 *     ・クラブElo(独立の外部レーティング。取得できている日のみ)
 *     ・実測の傾向(BTTS率・クリーンシート率・荒れやすさ)
 *
 * ■ でっち上げ防止(このファイルで最も大事なところ)
 *   ・クラブ名が**確実に1つに定まらない場合は分析しない**。
 *     「レアル」→レアル・マドリードのような短縮は、**完全一致の別名表**でだけ
 *     認める(かつて「レアル・ベティス」を「レアル・マドリード」として答えて
 *     しまった最悪の欠陥への恒久対策)。曖昧な場合は候補を出して正直に止まる。
 *   ・レーティングが無いクラブ(実試合の蓄積が足りないクラブ)は、
 *     推定値を作らずに「まだ分析できません」と正直に返す。
 *   ・当日の怪我・出場停止・移籍・市場オッズは**含まれていない**ことを、
 *     返り値(limitsJa)として必ず開示する。
 *
 * ■ 負荷(方針⑥: 質問した瞬間に重い処理をしない)
 *   この関数群は純粋な計算のみ。外部APIを1件も呼ばない。呼び出し側(server.js)は
 *   保存済みデータ(レーティング・重み・派生指標・Elo)の読み出しだけを行う。
 */

const { normName, namesMatch } = require("./oddsApi");
const { expGoalsFromRatings } = require("./teamRatings");
const {
  computeMatchProbabilitiesRaw, topScorelinesFrom, mostLikelyScoreline, derivedMatchMetrics,
  LAMBDA_MIN, LAMBDA_MAX,
} = require("./predictionModel");
const { combineVolatility } = require("./teamStats");
const { CLUB_UNIVERSE } = require("./clubUniverse");

const MAX_SIDE_LEN = 60;

/* ============================================================================
 * ①「A vs B」の1行を2つのクラブ名に分ける
 * ========================================================================== */

/** 質問文の末尾についた助詞・疑問語を落とす(クラブ名だけを残す) */
const TAIL_PATTERNS = [
  /[?？!！。、.\s]+$/u,
  /(どっちが?勝つ|どちらが?勝つ|どっちが?強い|どちらが?強い|どっちが?有利|どちらが?有利|どっち|どちら|勝つのは|勝つ|勝ち|予想して|予想|分析して|分析|解説して|解説|の結果|どうなる|の試合|の対戦|を見たい|見たい)$/u,
  /[はがをにでのっと]$/u,
];
function cleanSide(s) {
  let t = String(s || "").trim();
  for (let guard = 0; guard < 10; guard++) {
    let changed = false;
    for (const p of TAIL_PATTERNS) {
      const next = t.replace(p, "").trim();
      if (next !== t) { t = next; changed = true; }
    }
    if (!changed) break;
  }
  return t.trim();
}

const HAS_NON_ASCII = /[^\x00-\x7F]/;

/**
 * 1行の入力を {home, away} に分ける(純関数)。分けられなければ null。
 * 区切りは「vs」「対」「×」「-」「と」の順に試す(誤爆の少ない順)。
 */
function parseMatchupText(text) {
  const src = String(text || "").trim();
  if (!src || src.length > 160) return null;
  const trySplit = (re, guard) => {
    const m = src.split(re);
    if (m.length !== 2) return null;
    const a = cleanSide(m[0]), b = cleanSide(m[1]);
    if (!a || !b) return null;
    if (a.length > MAX_SIDE_LEN || b.length > MAX_SIDE_LEN) return null;
    if (guard && !guard(a, b)) return null;
    return { home: a, away: b };
  };
  // ① 空白つきの vs / VS(英語表記でも安全)
  let r = trySplit(/(?:^|\s)(?:vs\.?|ｖｓ|ＶＳ)(?:\s|$)/i);
  if (r) return r;
  // ② 空白なしの vs(「レアルvsバルサ」)。英単語の途中での誤爆を避けるため、
  //    どちらかの側に非ASCII(日本語)が含まれる場合だけ認める。
  r = trySplit(/vs\.?/i, (a, b) => HAS_NON_ASCII.test(a) || HAS_NON_ASCII.test(b));
  if (r) return r;
  // ③ 「対」「×」。「対戦」「対決」のような語の一部は除く(直後の文字で判定)。
  r = trySplit(/対(?![戦決応策象照抗話面])/u);
  if (r) return r;
  r = trySplit(/\s*[×✕]\s*/u);
  if (r) return r;
  // ④ 「Arsenal - Chelsea」(必ず前後に空白。クラブ名内のハイフンは割らない)
  r = trySplit(/\s+[-–—]\s+/u);
  if (r) return r;
  // ⑤ ひらがなの「と」(日本語のクラブ名はカタカナ・英字なので区切りとして安全)
  r = trySplit(/と/u, (a, b) => HAS_NON_ASCII.test(a) || HAS_NON_ASCII.test(b));
  if (r) return r;
  return null;
}

/* ============================================================================
 * ②クラブ名の解決(曖昧なら分析しない)
 * ========================================================================== */

/** 日本語表記の照合キー(全角半角・中黒・空白の揺れを吸収する) */
function jaKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[・･\s'’`.\-‐−–—]/gu, "")
    .trim();
}

/**
 * 日本語の短縮形・別名(**完全一致のときだけ**採用する)。
 * ここに無い短縮形は「知らない」として正直に扱う(部分一致の推測はしない)。
 */
const JA_ALIASES = {
  "レアル": "Real Madrid",
  "レアルマドリッド": "Real Madrid",
  "レアルマドリー": "Real Madrid",
  "マドリー": "Real Madrid",
  "バルサ": "Barcelona",
  "バルセロナ": "Barcelona",
  "アトレティコ": "Atletico Madrid",
  "アトレチコ": "Atletico Madrid",
  "アトレティコマドリッド": "Atletico Madrid",
  "シティ": "Manchester City",
  "マンチェスターシティ": "Manchester City",
  "マンチェスターc": "Manchester City",
  "マンc": "Manchester City",
  "マンu": "Manchester United",
  "マンユナイテッド": "Manchester United",
  "マンチェスターu": "Manchester United",
  "ユナイテッド": "Manchester United",
  "リバプール": "Liverpool",
  "スパーズ": "Tottenham",
  "トッテナムホットスパー": "Tottenham",
  "バイエルン": "Bayern Munich",
  "バイエルンミュンヘン": "Bayern Munich",
  "ドルトムント": "Borussia Dortmund",
  "ライプツィヒ": "RB Leipzig",
  "レバークーゼン": "Bayer Leverkusen",
  "ユーベ": "Juventus",
  "ユベントス": "Juventus",
  "ミラン": "AC Milan",
  "インテルミラノ": "Inter",
  "インテルミラン": "Inter",
  "ローマ": "AS Roma",
  "ポルト": "Porto",
  "スポルティング": "Sporting CP",
  "リスボン": "Sporting CP",
  "psg": "Paris Saint Germain",
  "パリsg": "Paris Saint Germain",
  "パリ": "Paris Saint Germain",
  "psv": "PSV Eindhoven",
  "セビリア": "Sevilla",
  "ビリャレアル": "Villarreal",
  "フランクフルト": "Eintracht Frankfurt",
  "ザルツブルク": "Red Bull Salzburg",
  "ブルッヘ": "Club Brugge",
  "ブルージュ": "Club Brugge",
};

/** クラブ宇宙(日本語名)+別名表から「日本語キー → 英語名」を作る */
function buildJaMap(universe) {
  const map = new Map();
  for (const c of (universe || CLUB_UNIVERSE)) {
    if (c && c.nameJa && c.nameEn) map.set(jaKey(c.nameJa), { nameEn: c.nameEn, nameJa: c.nameJa });
  }
  const jaByEn = new Map();
  for (const c of (universe || CLUB_UNIVERSE)) {
    if (c && c.nameEn) jaByEn.set(c.nameEn, c.nameJa || null);
  }
  for (const [alias, nameEn] of Object.entries(JA_ALIASES)) {
    const k = jaKey(alias);
    if (!map.has(k)) map.set(k, { nameEn, nameJa: jaByEn.get(nameEn) || null });
  }
  return map;
}

/**
 * 学習で貯まったチーム名(id→名前)から、照合用の索引を作る。
 * @param {...object} sources - { [id]: "name" } の形のオブジェクト(後勝ち)
 * @returns {Array<{id:number,name:string}>}
 */
function buildNameIndex(...sources) {
  const merged = new Map();
  for (const src of sources) {
    for (const [id, name] of Object.entries(src || {})) {
      const n = Number(id);
      if (!Number.isFinite(n) || !name) continue;
      merged.set(n, String(name));
    }
  }
  return [...merged.entries()].map(([id, name]) => ({ id, name }));
}

function tokenSet(name) {
  return new Set(normName(name).split(" ").filter((t) => t.length >= 4));
}

/**
 * v67: 女子・ユース・2軍を示す表記(API-Footballの命名慣習)。
 * 本番実測: 学習の採集名簿に「Bayern Munich W」(女子)が入った日から、
 * 「バイエルン」の照合が女子チーム1件に一意ヒットしてしまい、
 * 男子トップチームの分析ができなくなった。問い合わせがそれを求めていない限り、
 * これらの表記を持つ候補は表記ゆらぎ照合の対象にしない
 * (別チームに化けるくらいなら照合しない、という v59 の原則の徹底)。
 */
const SQUAD_VARIANT_RE = /(\s|\()W\)?$|\sW\s|U-?(17|18|19|20|21|23)|\s(II|III|B)$|women|youth|reserves?|femin|ladies/i;
function isSquadVariantName(name) { return SQUAD_VARIANT_RE.test(String(name || "")); }
function queryWantsVariant(q) {
  return SQUAD_VARIANT_RE.test(String(q || "")) || /女子|レディース|ユース|リザーブ|2軍|セカンド/.test(String(q || ""));
}

/**
 * クラブ名(日本語/英語/短縮形)を1つのチームIDに解決する(純関数)。
 * @returns {{ok:true, id, name, nameJa}|{ok:false, reason, candidates?, queryRaw}}
 */
function resolveClub(raw, ctx) {
  const q = String(raw || "").trim();
  if (!q) return { ok: false, reason: "empty", queryRaw: q };
  if (q.length > MAX_SIDE_LEN) return { ok: false, reason: "too_long", queryRaw: q };
  const index = (ctx && ctx.index) || [];
  if (!index.length) return { ok: false, reason: "no_index", queryRaw: q };
  const jaMap = (ctx && ctx.jaMap) || buildJaMap();

  // ① 日本語名・別名(完全一致のみ)→ 英語名へ
  const uni = jaMap.get(jaKey(q));
  const target = uni ? uni.nameEn : q;
  const nameJa = uni ? uni.nameJa : null;

  // ② 正規化した完全一致
  const tNorm = normName(target);
  const exact = index.filter((e) => normName(e.name) === tNorm);
  if (exact.length === 1) return { ok: true, id: exact[0].id, name: exact[0].name, nameJa };
  if (exact.length > 1) {
    // 同名が複数ID(データ上の重複)。レーティングを持つ側が1つならそれを使う。
    const rated = ctx.ratedIds ? exact.filter((e) => ctx.ratedIds.has(e.id)) : [];
    if (rated.length === 1) return { ok: true, id: rated[0].id, name: rated[0].name, nameJa };
    return { ok: false, reason: "ambiguous", candidates: exact.slice(0, 4).map((e) => e.name), queryRaw: q };
  }

  // ③ 表記ゆらぎ照合(候補が2件以上なら**使わない**=誤マッチ防止)
  //   v67: 問い合わせが女子・ユース・2軍を求めていない限り、それらの表記を持つ
  //   候補はここから除外する(「Bayern Munich W」への化けの再発防止)。
  const allowVariant = queryWantsVariant(q) || queryWantsVariant(target);
  const fuzzyPool = allowVariant ? index : index.filter((e) => !isSquadVariantName(e.name));
  const fuzzy = [];
  for (const e of fuzzyPool) {
    if (namesMatch(e.name, target)) fuzzy.push(e);
    if (fuzzy.length > 4) break;
  }
  if (fuzzy.length === 1) return { ok: true, id: fuzzy[0].id, name: fuzzy[0].name, nameJa };
  if (fuzzy.length > 1) {
    return { ok: false, reason: "ambiguous", candidates: fuzzy.slice(0, 4).map((e) => e.name), queryRaw: q };
  }

  // ④ 特徴的な語での一意照合(「Bayern Munich」と「Bayern München」のような綴り違い)。
  //    候補がちょうど1件のときだけ採用する。
  const qTokens = tokenSet(target);
  if (qTokens.size) {
    const hits = [];
    for (const e of fuzzyPool) {
      const et = tokenSet(e.name);
      let common = false;
      for (const t of qTokens) if (et.has(t)) { common = true; break; }
      if (common) hits.push(e);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return { ok: true, id: hits[0].id, name: hits[0].name, nameJa };
  }
  return { ok: false, reason: "not_found", queryRaw: q };
}

/* ============================================================================
 * ③分析本体(保存済みの学習結果だけで組み立てる)
 * ========================================================================== */

function pct1(v) { return Math.round(v * 1000) / 10; }

/**
 * 解決済みの2クラブから分析を組み立てる(純関数・外部通信なし)。
 * @param {object} p
 *   home/away : {id, name, nameJa}
 *   ratings   : learn:ratings:v1 の中身
 *   weights   : learn:weights の中身(ρを使う)
 *   teamStats : learn:teamstats:v1 の中身(無ければ実測傾向は出さない)
 *   elo       : { byNorm:Map, rows:Array, date:string } | null
 */
function buildMatchup(p) {
  const { home, away, ratings, weights, teamStats, elo } = p || {};
  if (!home || !away) return { available: false, reason: "missing_side" };
  if (home.id === away.id) return { available: false, reason: "same_club" };
  const eg = expGoalsFromRatings(ratings, home.id, away.id);
  if (!eg) {
    const has = (id) => !!(ratings && ratings.byTeam && ratings.byTeam[id]);
    return {
      available: false,
      reason: "no_rating",
      missing: [!has(home.id) ? home.name : null, !has(away.id) ? away.name : null].filter(Boolean),
    };
  }
  const rho = (weights && Number.isFinite(weights.rho)) ? weights.rho : 0;
  // ---- v64: 期待得点に現実的な範囲を掛ける(v63と同じ考え方をこの経路にも) ----
  //   地力レーティングからの期待得点は exp() なので負にはならないが、
  //   レーティングが極端なクラブでは上限なく大きくなりうる。予想カード側
  //   (predictOutcomeV2)には v63 で範囲を入れたのに、この「どんな対戦でも分析」
  //   の経路には入っていなかった。同じ基準を適用し、外れたら正直に開示する。
  const lamHome = Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, eg.home));
  const lamAway = Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, eg.away));
  const lambdaClamped = lamHome !== eg.home || lamAway !== eg.away;
  const raw = computeMatchProbabilitiesRaw(lamHome, lamAway, 8, rho);
  const winner = (raw.homeWin >= raw.draw && raw.homeWin >= raw.awayWin) ? "home"
    : (raw.awayWin >= raw.draw ? "away" : "draw");
  const scenarios = topScorelinesFrom(lamHome, lamAway, 6, rho, 5)
    .map((s) => ({ scoreline: s.scoreline, pct: pct1(s.p) }));
  const derived = derivedMatchMetrics(lamHome, lamAway, 8, rho);

  // 実測の傾向(集計済みのものだけ。無いクラブは null)
  const sTeam = (id) => (teamStats && teamStats.byTeam && teamStats.byTeam[id]) || null;
  const hs = sTeam(home.id), as = sTeam(away.id);
  const volatility = combineVolatility(hs, as);

  // クラブElo(その日ぶんが取れているときだけ)
  let clubElo = null;
  if (elo && elo.byNorm && Array.isArray(elo.rows)) {
    const pick = (name) => {
      const direct = elo.byNorm.get(normName(name));
      if (direct) return direct.elo;
      const hits = [];
      for (const r of elo.rows) { if (namesMatch(r.club, name)) hits.push(r); if (hits.length > 2) break; }
      return hits.length === 1 ? hits[0].elo : null;
    };
    const he = pick(home.name), ae = pick(away.name);
    if (Number.isFinite(he) && Number.isFinite(ae)) {
      clubElo = { home: he, away: ae, diff: Math.round((he - ae) * 10) / 10, date: elo.date || null };
    }
  }

  return {
    available: true,
    home: { id: home.id, name: home.name, nameJa: home.nameJa || null },
    away: { id: away.id, name: away.name, nameJa: away.nameJa || null },
    predictedWinner: winner,
    probs: {
      homeWinPct: Math.round(raw.homeWin * 100),
      drawPct: Math.round(raw.draw * 100),
      awayWinPct: Math.round(raw.awayWin * 100),
    },
    expGoals: { home: eg.home, away: eg.away },
    // v64: 期待得点が現実的な範囲を外れたか(外れた分析は割り引いて見てもらう)
    lambdaClamped,
    topScoreline: mostLikelyScoreline(lamHome, lamAway, 6, rho, winner),
    scenarios,
    derived: derived ? {
      bttsPct: Math.round(derived.btts * 100),
      over25Pct: Math.round(derived.over25 * 100),
      homeCleanSheetPct: Math.round(derived.homeCleanSheet * 100),
      awayCleanSheetPct: Math.round(derived.awayCleanSheet * 100),
      expTotalGoals: Math.round(derived.expTotalGoals * 100) / 100,
    } : null,
    history: (hs || as) ? {
      home: hs ? { n: hs.n, bttsPct: Math.round(hs.bttsRate * 100), csPct: Math.round(hs.csRate * 100), over25Pct: Math.round(hs.over25Rate * 100), totalAvg: hs.totalAvg, totalSd: hs.totalSd, volPct: hs.volPct } : null,
      away: as ? { n: as.n, bttsPct: Math.round(as.bttsRate * 100), csPct: Math.round(as.csRate * 100), over25Pct: Math.round(as.over25Rate * 100), totalAvg: as.totalAvg, totalSd: as.totalSd, volPct: as.volPct } : null,
      volatility,
      teamsCounted: (teamStats && teamStats.teamsCounted) || null,
    } : null,
    clubElo,
    basis: {
      ratingsBuiltAt: (ratings && ratings.builtAt) || null,
      ratingMatches: (ratings && ratings.matchesUsed) || null,
      teamsRated: (ratings && ratings.teamsRated) || null,
      weightsVersion: (weights && Number.isFinite(weights.version)) ? weights.version : null,
      rho,
      statsMatches: (teamStats && teamStats.matchesUsed) || null,
    },
    limitsJa: "この分析は「地力レーティング(過去の実試合から学習)」と「実測の傾向」で計算しています。当日の怪我人・出場停止・移籍・市場オッズは含みません(今日の試合の予想カードにはそれらも入ります)。",
  };
}

module.exports = {
  MAX_SIDE_LEN, JA_ALIASES,
  cleanSide, parseMatchupText, jaKey, buildJaMap, buildNameIndex, resolveClub, buildMatchup,
};
