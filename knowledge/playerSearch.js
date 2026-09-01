/**
 * server/knowledge/playerSearch.js
 * ------------------------------------------------
 * 2026年8月・「取得した全選手を選手スカウティングで検索・比較・分析できるようにする」
 * というご要望(①〜⑩)への対応。
 *
 * ■ 設計の中心にある制約(最終方針⑥)
 *   「利用者が質問した瞬間に重い処理を行う設計は禁止。重い処理は夜間バッチ」
 *   したがって:
 *     ・夜間バッチが **圧縮済みの索引** を作る(分割保存=シャード)
 *     ・サーバーは起動後に一度だけ読み、**メモリ上で絞り込む**
 *     ・検索1回あたりのRedisアクセスは **0回**、API呼び出しも **0回**
 *     ・並び替え・ページ切り出し・ファセット集計もすべてメモリ上
 *
 * ■ 索引の形式(サイズを抑えるため配列にする)
 *   オブジェクトだとキー名が3,000回繰り返されて数百KB無駄になる。
 *   位置で意味が決まる配列にすることで、1人あたり約150バイトに収まる。
 *   列の意味は COL を参照(コードから読めるように名前を付けてある)。
 *
 * ■ サイズ対策(シャード分割)
 *   Upstash REST は1リクエストのサイズに上限がある。3,000人を1キーに入れると
 *   将来1万人規模で必ず破綻するため、SHARD_SIZE人ごとに分割して保存する。
 *   読み出しはシャード数ぶんの GET(既定なら3〜4回)だけで、サーバー起動時と
 *   キャッシュ失効時にしか起きない。
 *
 * ■ 取得できない項目について(でっち上げ防止・重要)
 *   ご要望のうち次の3つは **API-Footballに存在しない**。
 *   推測値で埋めることはせず、検索条件からも外し、画面にも理由を明記する。
 *     ・利き足     ・市場価値     ・契約状況
 *   詳細ポジション(CB/RB/LB/DMF/CMF/AMF/RW/LW/CF)も、APIが返すのは
 *   Goalkeeper / Defender / Midfielder / Attacker の **4分類だけ**。
 *   スタメンの配置データ(grid)から推定できる範囲でのみ細分化し、
 *   推定に使った試合数を必ず添える。左右の別は、データ提供元の座標系の
 *   向きが確定できないため **断定しない**(RB/LBではなく「サイドバック」)。
 */

const INDEX_KEY = "kb:player:index";           // 互換のため残す(単一キー時代の読み出し)
const INDEX_META_KEY = "kb:player:index:meta";
const INDEX_SHARD_PREFIX = "kb:player:index:s"; // 旧形式(世代なし)。移行期の読み出し用に残す
// ---- 2026年8月の検証で判明した致命的な穴への対処: 索引の「世代」 ----
// 以前は 0..N-1 のシャードを **その場で上書き** していた。途中の1本が失敗すると
//   シャード0 = 今日の内容 / シャード1 = 昨日の内容
// という混ざった索引ができ、しかも available:true で返っていた
// (移籍した選手が古いクラブのまま出るなど、静かに間違った情報を出す)。
// 世代番号つきのキーへ全部書き切ってから、最後に目次(meta)を差し替える。
// 目次の差し替えは1コマンドなので、読み手が中途半端な状態を見ることが無い。
const INDEX_GEN_PREFIX = "kb:player:index:g";   // kb:player:index:g<gen>:s<n>
const shardKey = (gen, i) => (gen === null || gen === undefined
  ? `${INDEX_SHARD_PREFIX}${i}` : `${INDEX_GEN_PREFIX}${gen}:s${i}`);
const GRID_KEY = "kb:player:grid";              // スタメン配置の累積(細分ポジション推定用)
const SHARD_SIZE = 900;                          // 1シャードあたりの人数
const MAX_SHARDS = 40;                           // 上限36,000人。暴走時の安全弁
const GRID_MAX_SAMPLES = 20;                     // 1選手あたりの配置標本の上限

// 索引の列位置
const COL = {
  id: 0, name: 1, teamEn: 2, teamJa: 3, leagueId: 4, nationality: 5,
  position: 6, age: 7, heightCm: 8, minutes: 9, goals: 10, assists: 11,
  rating: 12, injured: 13, formDelta: 14, detailedPos: 15,
  appearances: 16, number: 17,
  prevRating: 18, prevGoals: 19, prevAssists: 20, prevMinutes: 21,
  baseRating: 22, baseAt: 23, updatedAt: 24,
  keyPasses: 25, passAccuracyPct: 26, dribbleSuccessRatePct: 27,
  defensiveActions: 28, duelWinRatePct: 29,
  yellowCards: 30, redCards: 31,
  injuredAt: 32,   // 怪我の有無を最後に確認できた日(YYYYMMDD)
  // ---- 2026年8月・「選手検索」統合で追加 ----
  lineups: 33,       // スタメン出場数(API-Footballの games.lineups。追加取得コスト0)
  recent5Rating: 34, // 直近5試合の平均評価(/fixtures/players の実測)
  recent5Count: 35,  // その平均に使えた試合数(3未満なら画面に出さない)
  recent5Minutes: 36,// 直近5試合の平均出場時間
};
const ROW_LENGTH = 37;

// API-Footballが返す4分類
const BROAD_POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Attacker"];
const BROAD_POSITION_JA = {
  Goalkeeper: "GK(ゴールキーパー)",
  Defender: "DF(ディフェンダー)",
  Midfielder: "MF(ミッドフィールダー)",
  Attacker: "FW(フォワード)",
};

// スタメン配置(grid)から推定する細分類。左右は断定しない。
const DETAILED_POSITION_JA = {
  GK: "GK(ゴールキーパー)",
  CB: "CB(センターバック)",
  SB: "SB(サイドバック)",
  DMF: "DMF(守備的MF)",
  CMF: "CMF(中央MF)",
  AMF: "AMF(攻撃的MF)",
  WG: "WG(ウイング)",
  CF: "CF(センターフォワード)",
};
const DETAILED_POSITION_ORDER = ["GK", "CB", "SB", "DMF", "CMF", "AMF", "WG", "CF"];

// ご要望に含まれるが、データ提供元に存在しない項目(検索条件から除外する)
const UNAVAILABLE_SEARCH_FIELDS_JA = {
  preferredFoot: "利き足は API-Football が提供していないため、検索条件にできません(推測で埋めることはしません)。",
  marketValue: "市場価値は API-Football が提供していないため、検索条件にできません(Transfermarkt等の別ソースが必要です)。",
  contractStatus: "契約状況(契約満了年など)は API-Football が提供していないため、検索条件にできません。",
};

/** 検索用の正規化(アクセント除去・小文字化)。clubDossierと同じ規則。 */
function normalizeForSearch(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[øØ]/g, "o").replace(/[đĐ]/g, "d").replace(/[łŁ]/g, "l").replace(/[ßẞ]/g, "ss")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** 身長 "180 cm" → 180。取れなければ null(0で埋めない)。 */
function parseHeightCm(h) {
  if (h === null || h === undefined || h === "") return null;
  if (typeof h === "number") return Number.isFinite(h) ? h : null;
  const m = String(h).match(/(\d{2,3})/);
  return m ? Number(m[1]) : null;
}

/** 生年月日から年齢。取れなければ null。 */
function ageFrom(birthDate, nowMs) {
  if (!birthDate) return null;
  const t = Date.parse(birthDate);
  if (!Number.isFinite(t)) return null;
  const ref = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.floor((ref - t) / (365.25 * 86400000));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-08-06T..." → 20260806(数値。索引を小さくするため) */
function dateKeyNum(iso) {
  if (!iso) return null;
  const s = String(iso).slice(0, 10).replace(/-/g, "");
  const n = Number(s);
  return Number.isFinite(n) && s.length === 8 ? n : null;
}
function dateKeyToIso(n) {
  const s = String(n || "");
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function daysBetweenKeys(a, b) {
  const ia = dateKeyToIso(a), ib = dateKeyToIso(b);
  if (!ia || !ib) return null;
  const d = (Date.parse(ib) - Date.parse(ia)) / 86400000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

/* =========================================================
   スタメン配置(grid)の累積
   ---------------------------------------------------------
   /fixtures/lineups は既に監督・布陣のために毎日取得している。
   その startXI には各選手の grid("行:列")が入っているが、これまで
   捨てていた。**追加のAPIコールは1件も発生しない**ので、ここで拾う。

   累積形式(1選手あたり5つの値。索引と同じくサイズ優先):
     [samples, sideSamples, maxRowSeen, rowHistogramPacked, lastFixtureId]
   rowHistogramPacked は行1〜7の出現回数を 1 桁ずつ詰めた文字列
   (例 "0301000" = 行2に3回、行3に1回)。9回で頭打ち。

   lastFixtureId は **同じ試合を毎日数え直さない** ために持つ。
   夜間バッチは毎日「直近の終了済み試合」のラインナップを取りに行くので、
   代表ウィークなど次の試合が無い期間は同じ試合を14日連続で数えてしまい、
   「直近14試合の配置から推定」という**事実に反する説明**になっていた。
   ========================================================= */
function emptyGridEntry() { return [0, 0, 0, "0000000", null]; }
function normalizeGridEntry(entry) {
  if (!Array.isArray(entry) || entry.length < 4) return emptyGridEntry();
  const e = entry.slice(0, 5);
  while (e.length < 5) e.push(null);
  return e;
}

/**
 * @param {Array}  entry  既存の累積
 * @param {string} gridStr "行:列"
 * @param {number} formationMaxRow その試合のスタメンの最も前の行
 * @param {boolean|undefined} isEdge その試合で「同じ行の端に居たか」。
 *   呼び出し側が同じ行の最小列・最大列を見て判定して渡す。
 *   渡されない場合だけ col===1 で代用する(4バックの右サイドが列4になる
 *   座標系では、col===1 だけを見ると片方のSBを取りこぼす)。
 * @param {number|string|undefined} fixtureId その配置が観測された試合のID。
 *   前回と同じ試合なら数えない(同じ試合の二重計上を防ぐ)。
 */
function accumulateGrid(entry, gridStr, formationMaxRow, isEdge, fixtureId) {
  const e = normalizeGridEntry(entry);
  const m = String(gridStr || "").match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return e;
  const row = Number(m[1]);
  const col = Number(m[2]);
  if (!Number.isFinite(row) || !Number.isFinite(col) || row < 1 || row > 7) return e;
  // 同じ試合を二度数えない(「直近N試合」という説明を正しく保つため)
  if (fixtureId !== undefined && fixtureId !== null && String(e[4]) === String(fixtureId)) return e;
  const edge = isEdge === undefined ? (col === 1) : !!isEdge;
  if (e[0] >= GRID_MAX_SAMPLES) {
    // 上限に達したら **全体を比率のまま半分に減らす**。
    // 以前は sideSamples を無条件に1減らしていたため、たとえば
    // 「7割の試合でサイドに居るサイドバック」でも、標本が増えるほど
    // サイド率が0に近づき、必ずCB判定に化けていた。
    e[0] = Math.floor(e[0] / 2);
    e[1] = Math.floor(e[1] / 2);
    e[3] = e[3].split("").map((c) => String(Math.floor(Number(c || 0) / 2))).join("");
  }
  e[0] += 1;
  if (edge) e[1] += 1;
  e[2] = Math.max(e[2], Number.isFinite(formationMaxRow) ? formationMaxRow : row);
  const hist = e[3].split("");
  const idx = row - 1;
  hist[idx] = String(Math.min(9, Number(hist[idx] || 0) + 1));
  e[3] = hist.join("");
  if (fixtureId !== undefined && fixtureId !== null) e[4] = fixtureId;
  return e;
}

/** 累積エントリ → inferDetailedPosition が読める形 */
function gridStatsFrom(entry) {
  if (!Array.isArray(entry) || entry.length < 4) return null;
  const rows = {};
  const hist = String(entry[3] || "");
  for (let i = 0; i < hist.length; i++) {
    const c = Number(hist[i] || 0);
    if (c > 0) rows[i + 1] = c;
  }
  return { samples: entry[0], sideSamples: entry[1], maxRow: entry[2], rows };
}

/**
 * スタメン配置の集計から、細分類を推定する。
 * @param {object} gridStats { rows, sideSamples, samples, maxRow }
 * @param {string} broad API-Footballの4分類
 */
function inferDetailedPosition(gridStats, broad) {
  if (broad === "Goalkeeper") {
    return { code: "GK", samples: (gridStats && gridStats.samples) || 0, confidentJa: "確定(GKは4分類の時点で一意に決まります)" };
  }
  if (!gridStats || !gridStats.samples || gridStats.samples < 3) {
    return { code: null, samples: (gridStats && gridStats.samples) || 0, confidentJa: "スタメンの配置データが3試合分に達していないため、細かいポジションは推定していません。" };
  }
  const rows = gridStats.rows || {};
  const topRow = Object.keys(rows).sort((a, b) => rows[b] - rows[a])[0];
  const row = Number(topRow);
  const sideRate = gridStats.samples ? (gridStats.sideSamples || 0) / gridStats.samples : 0;
  const isSide = sideRate >= 0.6; // 6割以上、ラインの端に配置されていれば「サイド」
  const note = `直近${gridStats.samples}試合のスタメン配置から推定`;

  if (broad === "Defender") return { code: isSide ? "SB" : "CB", samples: gridStats.samples, confidentJa: note };
  if (broad === "Attacker") return { code: isSide ? "WG" : "CF", samples: gridStats.samples, confidentJa: note };
  if (broad === "Midfielder") {
    // 中盤の細分は「布陣に中盤の列がいくつあるか」で意味が変わる。
    //   4-3-3 / 4-4-2 … 中盤は1列だけ → その列は CMF(守備的/攻撃的の別は無い)
    //   4-2-3-1        … 中盤は2列   → 手前が DMF、前が AMF
    //   4-1-4-1 等      … 3列        → 手前 DMF / 中 CMF / 前 AMF
    // 行1はGKなので、フィールドプレーヤーの列数は maxRow - 1。
    const maxRow = gridStats.maxRow || row;
    const bands = Math.max(1, maxRow - 1);
    let code;
    if (row <= 2) code = "DMF";           // 最終ラインに並ぶほど下がっている
    else if (bands <= 3) code = "CMF";    // 中盤が1列しかない布陣
    else if (row === 3) code = "DMF";
    else if (row >= maxRow - 1) code = "AMF";
    else code = "CMF";
    return { code, samples: gridStats.samples, confidentJa: note };
  }
  return { code: null, samples: gridStats.samples, confidentJa: "4分類が取得できていないため、細かいポジションを推定できません。" };
}

/* =========================================================
   索引の行を作る / 読む
   ========================================================= */

/**
 * 選手記録 → 索引1行。既存行があれば「前回値」を引き継ぐ(成長傾向の算出に使う)。
 * @param {object} p  選手記録(kb:player:<id> 相当)
 * @param {object} extra { leagueId, injured, formDelta, gridStats, todayKey }
 * @param {Array}  prev 既存の索引行(無ければ null)
 */
function toIndexRow(p, extra, nowMs, prev) {
  const e = extra || {};
  const st = p.stats || {};
  const detailed = inferDetailedPosition(e.gridStats, p.position);
  const todayKey = e.todayKey || dateKeyNum(new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString());

  const rating = numOrNull(st.rating);
  const goals = numOrNull(st.goals);
  const assists = numOrNull(st.assists);
  const minutes = numOrNull(st.minutes);

  // ---- 前回値・基準値の引き継ぎ(成長傾向のため) ----
  // 「前回」= 直近で数値が実際に動いた時点。動いていない日に上書きすると
  // 差分が常に0になり、成長が見えなくなる。
  let prevRating = prev ? prev[COL.prevRating] : null;
  let prevGoals = prev ? prev[COL.prevGoals] : null;
  let prevAssists = prev ? prev[COL.prevAssists] : null;
  let prevMinutes = prev ? prev[COL.prevMinutes] : null;
  if (prev) {
    const changed = (rating !== null && prev[COL.rating] !== null && rating !== prev[COL.rating])
      || (minutes !== null && prev[COL.minutes] !== null && minutes !== prev[COL.minutes]);
    if (changed) {
      prevRating = prev[COL.rating];
      prevGoals = prev[COL.goals];
      prevAssists = prev[COL.assists];
      prevMinutes = prev[COL.minutes];
    }
  }
  // ---- 基準値(成長傾向を測るための出発点)----
  // 「30日経ったら基準を今日の値に更新する」という作りにしていたが、これは
  // **更新した当日に基準日=今日となり、差分が必ず0日・0になる**。つまり
  // 30日ごとに成長傾向が消える。基準は原則として動かさず、
  //   ・まだ基準が無い
  //   ・シーズンが変わって成績が0に戻った(出場試合数が減った)
  //   ・1年近く経った(300日)
  // のときにだけ張り直す。こうすると「いつと比べてどう変わったか」が常に言える。
  const appearances = numOrNull(st.appearances);
  const prevAppearances = prev ? prev[COL.appearances] : null;
  const seasonReset = Number.isFinite(appearances) && Number.isFinite(prevAppearances)
    && appearances < prevAppearances;
  let baseRating = prev ? prev[COL.baseRating] : null;
  let baseAt = prev ? prev[COL.baseAt] : null;
  const baseAge = baseAt ? daysBetweenKeys(baseAt, todayKey) : null;
  const needNewBase = baseRating === null || baseRating === undefined
    || baseAt === null || baseAt === undefined
    || seasonReset || (baseAge !== null && baseAge >= 300);
  if (needNewBase && rating !== null) { baseRating = rating; baseAt = todayKey; }
  else if (needNewBase) { baseRating = null; baseAt = null; }

  // フォームの差分は「基準ではなく前回比」。savePlayer側の検知と意味を揃える。
  let formDelta = numOrNull(e.formDelta);
  if (formDelta === null && rating !== null && prevRating !== null && prevRating !== undefined) {
    formDelta = Math.round((rating - prevRating) * 100) / 100;
  }

  const row = new Array(ROW_LENGTH).fill(null);
  row[COL.id] = p.id;
  row[COL.name] = p.name || "";
  row[COL.teamEn] = p.teamEn || "";
  row[COL.teamJa] = p.teamJa || "";
  row[COL.leagueId] = e.leagueId ?? (prev ? prev[COL.leagueId] : null) ?? null;
  row[COL.nationality] = p.nationality || (prev ? prev[COL.nationality] : "") || "";
  row[COL.position] = p.position || (prev ? prev[COL.position] : "") || "";
  row[COL.age] = p.age ?? ageFrom(p.birthDate, nowMs) ?? (prev ? prev[COL.age] : null);
  row[COL.heightCm] = parseHeightCm(p.height) ?? (prev ? prev[COL.heightCm] : null);
  row[COL.minutes] = minutes ?? (prev ? prev[COL.minutes] : null);
  row[COL.goals] = goals ?? (prev ? prev[COL.goals] : null);
  row[COL.assists] = assists ?? (prev ? prev[COL.assists] : null);
  row[COL.rating] = rating ?? (prev ? prev[COL.rating] : null);
  // 0=今日確認して負傷リストに無し / 1=負傷中 / null=まだ確認できていない。
  // 以前は末尾に `|| 0` が付いていたため、**一度も負傷者リストを見ていないクラブの
  // 選手まで「出場できる状態」として公開されていた**(でっち上げ)。
  const injuredKnownToday = e.injured === true || e.injured === false;
  row[COL.injured] = e.injured === true ? 1
    : e.injured === false ? 0
      : (prev && (prev[COL.injured] === 0 || prev[COL.injured] === 1) ? prev[COL.injured] : null);
  row[COL.injuredAt] = injuredKnownToday ? todayKey : (prev ? (prev[COL.injuredAt] ?? null) : null);
  row[COL.lineups] = numOrNull(st.lineups) ?? (prev ? prev[COL.lineups] : null);
  // 直近5試合は別ステージで集計するため、渡されたときだけ更新する
  row[COL.recent5Rating] = numOrNull(e.recent5Rating) ?? (prev ? prev[COL.recent5Rating] : null);
  row[COL.recent5Count] = numOrNull(e.recent5Count) ?? (prev ? prev[COL.recent5Count] : null);
  row[COL.recent5Minutes] = numOrNull(e.recent5Minutes) ?? (prev ? prev[COL.recent5Minutes] : null);
  // 今回の実測から差分を出せない日は、前回の値をそのまま残す。
  // (同日再実行や、そのクラブの一括取得が予算で見送られた日に消えていた)
  row[COL.formDelta] = formDelta !== null && formDelta !== undefined
    ? formDelta
    : (prev ? (prev[COL.formDelta] ?? null) : null);
  row[COL.detailedPos] = detailed.code || (prev ? prev[COL.detailedPos] : null);
  row[COL.appearances] = numOrNull(st.appearances) ?? (prev ? prev[COL.appearances] : null);
  row[COL.number] = numOrNull(p.number) ?? (prev ? prev[COL.number] : null);
  row[COL.prevRating] = prevRating ?? null;
  row[COL.prevGoals] = prevGoals ?? null;
  row[COL.prevAssists] = prevAssists ?? null;
  row[COL.prevMinutes] = prevMinutes ?? null;
  row[COL.baseRating] = baseRating ?? null;
  row[COL.baseAt] = baseAt ?? null;
  row[COL.updatedAt] = todayKey;
  row[COL.keyPasses] = numOrNull(st.keyPasses) ?? (prev ? prev[COL.keyPasses] : null);
  row[COL.passAccuracyPct] = numOrNull(st.passAccuracyPct) ?? (prev ? prev[COL.passAccuracyPct] : null);
  row[COL.dribbleSuccessRatePct] = numOrNull(st.dribbleSuccessRatePct) ?? (prev ? prev[COL.dribbleSuccessRatePct] : null);
  row[COL.defensiveActions] = numOrNull(st.defensiveActions) ?? (prev ? prev[COL.defensiveActions] : null);
  row[COL.duelWinRatePct] = numOrNull(st.duelWinRatePct) ?? (prev ? prev[COL.duelWinRatePct] : null);
  row[COL.yellowCards] = numOrNull(st.yellowCards) ?? (prev ? prev[COL.yellowCards] : null);
  row[COL.redCards] = numOrNull(st.redCards) ?? (prev ? prev[COL.redCards] : null);
  return row;
}

/** 配列 → 読みやすいオブジェクト(APIの応答用) */
function fromIndexRow(row) {
  if (!Array.isArray(row)) return null;
  const growth = growthOf(row);
  return {
    id: row[COL.id],
    name: row[COL.name],
    teamEn: row[COL.teamEn] || null,
    teamJa: row[COL.teamJa] || null,
    leagueId: row[COL.leagueId],
    nationality: row[COL.nationality] || null,
    position: row[COL.position] || null,
    positionJa: BROAD_POSITION_JA[row[COL.position]] || null,
    detailedPosition: row[COL.detailedPos] || null,
    detailedPositionJa: DETAILED_POSITION_JA[row[COL.detailedPos]] || null,
    age: row[COL.age],
    heightCm: row[COL.heightCm],
    number: row[COL.number],
    appearances: row[COL.appearances],
    minutes: row[COL.minutes],
    goals: row[COL.goals],
    assists: row[COL.assists],
    rating: row[COL.rating],
    injured: row[COL.injured] === 1,
    injuryChecked: row[COL.injured] === 0 || row[COL.injured] === 1,
    injuryCheckedAt: dateKeyToIso(row[COL.injuredAt]),
    injuryNoteJa: (() => {
      if (!(row[COL.injured] === 0 || row[COL.injured] === 1)) {
        return "このクラブの負傷者リストをまだ確認できていないため、怪我の有無は分かりません。";
      }
      const age = daysBetweenKeys(row[COL.injuredAt], row[COL.updatedAt]);
      // いつ確認した情報なのかを必ず言う(確認できない日が続くと古い情報が残るため)
      if (age === null) return null;
      if (age >= 3) return `この情報は${age}日前に確認したものです(その後このクラブの負傷者リストを取得できていません)。`;
      return null;
    })(),
    formDelta: row[COL.formDelta],
    keyPasses: row[COL.keyPasses],
    passAccuracyPct: row[COL.passAccuracyPct],
    dribbleSuccessRatePct: row[COL.dribbleSuccessRatePct],
    defensiveActions: row[COL.defensiveActions],
    duelWinRatePct: row[COL.duelWinRatePct],
    yellowCards: row[COL.yellowCards],
    redCards: row[COL.redCards],
    // ---- 派生値(0で埋めず、元が取れていなければ null) ----
    lineups: row[COL.lineups],
    startRatePct: (Number.isFinite(row[COL.lineups]) && Number.isFinite(row[COL.appearances]) && row[COL.appearances] > 0)
      ? Math.round((row[COL.lineups] / row[COL.appearances]) * 1000) / 10 : null,
    minutesPerAppearance: (Number.isFinite(row[COL.minutes]) && Number.isFinite(row[COL.appearances]) && row[COL.appearances] > 0)
      ? Math.round(row[COL.minutes] / row[COL.appearances]) : null,
    recent5Rating: row[COL.recent5Count] >= 3 ? row[COL.recent5Rating] : null,
    recent5Count: row[COL.recent5Count],
    recent5Minutes: row[COL.recent5Count] >= 3 ? row[COL.recent5Minutes] : null,
    recent5NoteJa: (row[COL.recent5Count] >= 3)
      ? `直近${row[COL.recent5Count]}試合の実測`
      : `直近の試合ごとの評価が${row[COL.recent5Count] || 0}試合ぶんしか取得できていないため、平均を出していません(3試合以上で表示します)。`,
    growth,
    updatedAt: dateKeyToIso(row[COL.updatedAt]),
    photo: row[COL.id] ? `https://media.api-sports.io/football/players/${row[COL.id]}.png` : null,
  };
}

/** 成長傾向(基準日からの平均評価の変化)。基準が無ければ「まだ測れない」と返す。 */
function growthOf(row) {
  const cur = row[COL.rating];
  const base = row[COL.baseRating];
  const baseAt = row[COL.baseAt];
  const today = row[COL.updatedAt];
  if (cur === null || base === null || baseAt === null) {
    return { measurable: false, reasonJa: "比較できる過去の平均評価がまだ蓄積していないため、成長傾向は測定できません(明日以降のデータで判定できるようになります)。" };
  }
  const days = daysBetweenKeys(baseAt, today);
  const delta = Math.round((cur - base) * 100) / 100;
  if (days === null) {
    return { measurable: false, reasonJa: "基準日を読み取れなかったため、変化を測定できません。", baseAt: dateKeyToIso(baseAt) };
  }
  if (days === 0) {
    return { measurable: false, reasonJa: "基準日と今日が同じため、まだ変化を測定できません(明日以降に測定できるようになります)。", baseAt: dateKeyToIso(baseAt) };
  }
  return {
    measurable: true, delta, days,
    baseRating: base, currentRating: cur, baseAt: dateKeyToIso(baseAt),
    trendJa: delta >= 0.1 ? "上昇傾向" : delta <= -0.1 ? "下降傾向" : "横ばい",
    noteJa: `${days}日前の平均評価 ${base} と比べて ${delta === 0 ? "±0(変化なし)" : (delta > 0 ? "+" : "") + delta}`,
  };
}

/* =========================================================
   絞り込み・並び替え・ページ切り出し
   ========================================================= */
function inRange(v, min, max) {
  if (min === undefined && max === undefined) return true;
  if (v === null || v === undefined) return false; // 未取得は範囲指定時に除外(0扱いしない)
  if (min !== undefined && v < min) return false;
  if (max !== undefined && v > max) return false;
  return true;
}

const SORTABLE = {
  rating: COL.rating, goals: COL.goals, assists: COL.assists,
  minutes: COL.minutes, appearances: COL.appearances,
  age: COL.age, height: COL.heightCm, form: COL.formDelta, name: COL.name,
  lineups: COL.lineups, recent5: COL.recent5Rating,
};

function matchesRow(row, query, pre) {
  const q = query || {};
  const p = pre || {};
  if (p.nameQ) {
    const n = normalizeForSearch(row[COL.name]);
    if (!n.includes(p.nameQ) && !n.split(" ").some((w) => w.startsWith(p.nameQ))) return false;
  }
  if (p.clubQ) {
    const en = normalizeForSearch(row[COL.teamEn]);
    const ja = String(row[COL.teamJa] || "");
    if (!en.includes(p.clubQ) && !(q.club && ja.includes(q.club))) return false;
  }
  if (p.clubsExact && p.clubsExact.length && !p.clubsExact.includes(row[COL.teamEn])) return false;
  if (p.natQ) {
    const nat = normalizeForSearch(row[COL.nationality]);
    if (!nat.includes(p.natQ)) return false;
  }
  if (p.nationalities && p.nationalities.length && !p.nationalities.includes(row[COL.nationality])) return false;
  if (p.leagueIds && p.leagueIds.length && !p.leagueIds.includes(Number(row[COL.leagueId]))) return false;
  if (p.positions && p.positions.length && !p.positions.includes(row[COL.position])) return false;
  if (p.detailed && p.detailed.length && !p.detailed.includes(row[COL.detailedPos])) return false;
  // 未確認(null)は、怪我あり・怪我なしのどちらにも含めない。
  // 「確認していないのに出場できる」と答えるのはでっち上げになる。
  if (q.injured === true && row[COL.injured] !== 1) return false;
  if (q.injured === false && row[COL.injured] !== 0) return false;
  if (!inRange(row[COL.age], q.ageMin, q.ageMax)) return false;
  if (!inRange(row[COL.heightCm], q.heightMin, q.heightMax)) return false;
  if (!inRange(row[COL.minutes], q.minutesMin, q.minutesMax)) return false;
  if (!inRange(row[COL.goals], q.goalsMin, q.goalsMax)) return false;
  if (!inRange(row[COL.assists], q.assistsMin, q.assistsMax)) return false;
  if (!inRange(row[COL.rating], q.ratingMin, q.ratingMax)) return false;
  if (!inRange(row[COL.formDelta], q.formMin, q.formMax)) return false;
  // ---- 2026年8月・「選手検索」統合で追加した条件 ----
  if (q.startRateMin !== undefined || q.startRateMax !== undefined) {
    const lu = row[COL.lineups], ap = row[COL.appearances];
    const rate = (Number.isFinite(lu) && Number.isFinite(ap) && ap > 0) ? (lu / ap) * 100 : null;
    if (!inRange(rate, q.startRateMin, q.startRateMax)) return false;
  }
  if (q.minutesPerAppMin !== undefined || q.minutesPerAppMax !== undefined) {
    const mi = row[COL.minutes], ap = row[COL.appearances];
    const mpa = (Number.isFinite(mi) && Number.isFinite(ap) && ap > 0) ? mi / ap : null;
    if (!inRange(mpa, q.minutesPerAppMin, q.minutesPerAppMax)) return false;
  }
  if (q.recent5Min !== undefined || q.recent5Max !== undefined) {
    const r5 = (row[COL.recent5Count] >= 3) ? row[COL.recent5Rating] : null;
    if (!inRange(r5, q.recent5Min, q.recent5Max)) return false;
  }
  return true;
}

/** 条件を前処理して、行ごとの判定を軽くする(3,000行×条件の正規化を毎回やらない) */
function precompute(query) {
  const q = query || {};
  return {
    nameQ: normalizeForSearch(q.name),
    clubQ: normalizeForSearch(q.club),
    natQ: normalizeForSearch(q.nationality),
    clubsExact: Array.isArray(q.clubs) ? q.clubs.filter(Boolean) : [],
    nationalities: Array.isArray(q.nationalities) ? q.nationalities.filter(Boolean) : [],
    leagueIds: Array.isArray(q.leagueIds) ? q.leagueIds.map(Number).filter(Number.isFinite) : [],
    positions: Array.isArray(q.positions) ? q.positions.filter(Boolean) : [],
    detailed: Array.isArray(q.detailedPositions) ? q.detailedPositions.filter(Boolean) : [],
  };
}

/** 複数条件の絞り込み。**すべてメモリ上**で行い、Redisへは触らない。 */
function searchIndex(index, q) {
  const query = q || {};
  const pre = precompute(query);
  const matched = [];
  for (const row of index) {
    if (matchesRow(row, query, pre)) matched.push(row);
  }
  return sortRows(matched, query);
}

function sortRows(rows, query) {
  const q = query || {};
  const sortKey = Object.prototype.hasOwnProperty.call(SORTABLE, q.sort) ? SORTABLE[q.sort] : COL.rating;
  const desc = q.order !== "asc";
  const out = rows.slice();
  out.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    const aNull = av === null || av === undefined || av === "";
    const bNull = bv === null || bv === undefined || bv === "";
    if (aNull && bNull) return String(a[COL.name]).localeCompare(String(b[COL.name]));
    if (aNull) return 1;   // 未取得は常に最後(0として上位に来ると誤解を生む)
    if (bNull) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      const r = String(av).localeCompare(String(bv));
      return desc ? -r : r;
    }
    if (av === bv) return String(a[COL.name]).localeCompare(String(b[COL.name]));
    return desc ? bv - av : av - bv;
  });
  return out;
}

/** ページ切り出し */
function paginate(rows, page, perPage) {
  const p = Math.max(1, Number(page) || 1);
  const per = Math.max(1, Math.min(100, Number(perPage) || 24));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / per));
  const start = (p - 1) * per;
  return {
    items: rows.slice(start, start + per).map(fromIndexRow),
    page: p, perPage: per, total, totalPages,
    hasNext: p < totalPages, hasPrev: p > 1,
  };
}

/** 絞り込み用の候補一覧(クラブ・国籍・リーグ・ポジション)を索引から実測で作る */
function facetsOf(index) {
  const clubs = new Map();
  const nats = new Map();
  const leagues = new Map();
  const positions = new Map();
  const detailed = new Map();
  for (const row of index) {
    const cEn = row[COL.teamEn];
    if (cEn) {
      const cur = clubs.get(cEn) || { teamEn: cEn, teamJa: row[COL.teamJa] || cEn, leagueId: row[COL.leagueId], count: 0 };
      if (!cur.teamJa && row[COL.teamJa]) cur.teamJa = row[COL.teamJa];
      cur.count++; clubs.set(cEn, cur);
    }
    const nat = row[COL.nationality];
    if (nat) nats.set(nat, (nats.get(nat) || 0) + 1);
    const lg = row[COL.leagueId];
    if (lg) leagues.set(lg, (leagues.get(lg) || 0) + 1);
    const pos = row[COL.position];
    if (pos) positions.set(pos, (positions.get(pos) || 0) + 1);
    const dp = row[COL.detailedPos];
    if (dp) detailed.set(dp, (detailed.get(dp) || 0) + 1);
  }
  return {
    clubs: [...clubs.values()].sort((a, b) => String(a.teamEn).localeCompare(String(b.teamEn))),
    nationalities: [...nats.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    leagues: [...leagues.entries()].map(([leagueId, count]) => ({ leagueId: Number(leagueId), count })).sort((a, b) => b.count - a.count),
    positions: BROAD_POSITIONS.filter((c) => positions.has(c)).map((code) => ({ code, labelJa: BROAD_POSITION_JA[code], count: positions.get(code) })),
    detailedPositions: DETAILED_POSITION_ORDER.filter((c) => detailed.has(c)).map((code) => ({ code, labelJa: DETAILED_POSITION_JA[code], count: detailed.get(code) })),
  };
}

/* =========================================================
   保存・読み出し(シャード分割)
   ========================================================= */
async function saveIndex(deps, rows, meta) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON, upstashCmd } = deps;
  if (!upstashEnabled) return { saved: false, reasonJa: "保存先(Upstash)が未設定のため索引を保存できません。" };
  const list = Array.isArray(rows) ? rows : [];
  const wanted = Math.max(1, Math.ceil(list.length / SHARD_SIZE));
  const shardCount = Math.min(MAX_SHARDS, wanted);
  // 上限で切り捨てた場合は黙って減らさず、必ず理由を残す
  const capacity = shardCount * SHARD_SIZE;
  const truncated = Math.max(0, list.length - capacity);
  const stored = truncated ? list.slice(0, capacity) : list;

  const prevMeta = upstashGetJSON ? await upstashGetJSON(INDEX_META_KEY).catch(() => null) : null;
  const prevGen = prevMeta && Number.isFinite(prevMeta.generation) ? prevMeta.generation : null;
  const prevCount = prevMeta && Number.isFinite(prevMeta.count) ? prevMeta.count : 0;
  const gen = (prevGen === null ? 0 : (prevGen + 1) % 1000);

  // ---- 壊滅的な縮小を拒む ----
  // 保存先が一時的に読めない日は、この関数へ空に近い配列が渡りうる。
  // そのまま書き換えると、これまで積み上げた索引が1回の障害で消える。
  if (prevCount >= 200 && stored.length < prevCount * 0.5) {
    return {
      saved: false, shardCount: prevMeta ? prevMeta.shardCount : 0, count: prevCount,
      refused: true,
      reasonJa: `今回作られた索引が${stored.length}人まで減っていました(前回は${prevCount}人)。データ取得の失敗で index が壊れる恐れがあるため、書き換えを見送り、前回の索引をそのまま使います。`,
    };
  }

  let ok = true;
  const failedShards = [];
  const bytesPerShard = [];
  for (let i = 0; i < shardCount; i++) {
    const chunk = stored.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    bytesPerShard.push(JSON.stringify(chunk).length);
    const r = await upstashSetJSON(shardKey(gen, i), chunk);
    if (r === false) { ok = false; failedShards.push(i); }
  }

  const fullMeta = {
    ...(meta || {}),
    generation: gen,
    shardCount, shardSize: SHARD_SIZE, count: stored.length,
    truncatedCount: truncated,
    truncatedReasonJa: truncated
      ? `索引の上限(${MAX_SHARDS}シャード=${MAX_SHARDS * SHARD_SIZE}人)を超えたため、${truncated}人を保存できませんでした。`
      : null,
    bytesPerShard,
    savedAt: (meta && meta.savedAt) || new Date().toISOString(),
    columns: COL,
  };

  if (!ok) {
    // 新しい世代のキーへ書いているだけなので、読み手はまだ前回の世代を見ている。
    // 目次を更新しなければ、今日の失敗は利用者に影響しない。
    for (let i = 0; i < shardCount; i++) {
      if (upstashCmd) await upstashCmd(["DEL", shardKey(gen, i)]).catch(() => {});
    }
    return {
      saved: false, shardCount, count: stored.length, meta: fullMeta, failedShards, truncated,
      reasonJa: `索引の一部(ブロック ${failedShards.join(",")})の保存に失敗したため、今回の書き換えを取り消しました。前回の索引がそのまま使われます。`,
    };
  }

  // ここで初めて切り替わる(1コマンド)。読み手が中途半端な状態を見ることは無い。
  const okMeta = (await upstashSetJSON(INDEX_META_KEY, fullMeta)) !== false;
  let removedShards = 0;
  if (okMeta && upstashCmd) {
    // 前の世代を片付ける(失敗しても実害は無い。次の世代で上書きされる)
    if (prevGen !== null) {
      const prevShards = prevMeta && Number.isFinite(prevMeta.shardCount) ? prevMeta.shardCount : MAX_SHARDS;
      for (let i = 0; i < Math.min(MAX_SHARDS, prevShards); i++) {
        await upstashCmd(["DEL", shardKey(prevGen, i)]).catch(() => {});
        removedShards++;
      }
    } else {
      // 旧形式(世代なし)からの移行。読み出しの候補から外すために消す。
      const oldShards = prevMeta && Number.isFinite(prevMeta.shardCount) ? prevMeta.shardCount : 0;
      for (let i = 0; i < Math.min(MAX_SHARDS, oldShards); i++) {
        await upstashCmd(["DEL", `${INDEX_SHARD_PREFIX}${i}`]).catch(() => {});
        removedShards++;
      }
      await upstashCmd(["DEL", INDEX_KEY]).catch(() => {});
    }
  }
  return {
    saved: okMeta, shardCount, count: stored.length, meta: fullMeta,
    generation: gen, failedShards, removedShards, truncated,
    reasonJa: okMeta ? null : "索引の目次(meta)の保存に失敗したため、前回の索引がそのまま使われます。",
  };
}

async function loadIndex(deps) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) {
    return { rows: [], meta: null, available: false, partial: false, reasonJa: "保存先(Upstash)が未設定のため、収集済み選手の索引を読み出せません。" };
  }
  const meta = (await upstashGetJSON(INDEX_META_KEY).catch(() => null)) || null;
  const rows = [];
  const missingShards = [];
  if (meta && Number.isFinite(meta.shardCount) && meta.shardCount > 0) {
    const gen = Number.isFinite(meta.generation) ? meta.generation : null;
    for (let i = 0; i < Math.min(MAX_SHARDS, meta.shardCount); i++) {
      const chunk = await upstashGetJSON(shardKey(gen, i)).catch(() => null);
      // 読み出し失敗を黙って捨てない(以前は「900人少ない完全な結果」を返していた)
      if (Array.isArray(chunk)) rows.push(...chunk.filter((r) => Array.isArray(r) && r[COL.id]));
      else missingShards.push(i);
    }
    const expected = Number.isFinite(meta.count) ? meta.count : null;
    // 目次が「N人」と言っているのに読めた数が大きく足りない場合も不完全とみなす
    const shortfall = expected !== null && rows.length < expected * 0.9;
    const partial = missingShards.length > 0 || shortfall;
    return {
      rows, meta,
      available: !partial,
      partial,
      missingShards,
      expectedCount: expected,
      reasonJa: partial
        ? `選手索引を完全に読み出せませんでした(目次では${expected !== null ? expected + "人" : "不明"}、実際に読めたのは${rows.length}人${missingShards.length ? `・${missingShards.length}ブロックが欠落` : ""})。この結果は不完全です。`
        : (rows.length ? null : "索引がまだ作られていません(毎日の学習が次に走ったときに作られます)。"),
    };
  }
  // 旧世代(単一キー)からの読み出し。移行期のみ通る。
  const legacy = await upstashGetJSON(INDEX_KEY).catch(() => null);
  if (Array.isArray(legacy)) rows.push(...legacy.filter((r) => Array.isArray(r) && r[COL.id]));
  if (rows.length) return { rows, meta, available: true, partial: false, missingShards: [], reasonJa: null };
  // ---- 2026年8月7日・本番調査で分かった「診断できなさ」の修正 ----
  //   ここへ来る原因は3つあり、必要な対処がまったく違う:
  //     ① 目次そのものが無い  → 毎日の学習がまだ一度も索引を作っていない
  //     ② 目次はあるが0人     → 学習は走ったが材料が1人も無かった
  //     ③ 目次の読み出し失敗  → 保存先への接続が一時的に落ちた
  //   以前は3つとも同じ文言(「目次を読み出せませんでした」)にまとめていたため、
  //   本番で「まだ作られていない」のか「壊れている」のかを外から判別できず、
  //   原因の切り分けに丸1往復かかった。metaFound を必ず返し、文言も分ける。
  const metaFound = !!meta;
  return {
    rows: [], meta, metaFound, available: false, partial: true, missingShards: [],
    expectedCount: metaFound && Number.isFinite(meta.count) ? meta.count : null,
    reasonJa: metaFound
      ? `選手索引の目次はありますが、登録されている選手が0人です(最終作成: ${meta.builtAt || "不明"})。次の毎日の学習で作り直されます。`
      : "選手索引はまだ作られていません。毎日の学習が次に走ったときに作られます(24時間以上動いていない場合は、この画面を開くとサーバーが自動で学習を開始します)。",
  };
}

/* =========================================================
   詳細画面用の補助データ(直近5試合・移籍履歴・怪我履歴)
   ---------------------------------------------------------
   索引とは別に持つ理由:
     ・検索には使わないので、検索用の索引を重くしたくない
     ・選手を1人開いたときにだけ読めば十分(Lazy Load)
   索引と同じくブロック分割で保存し、読み出しはブロック数ぶんのGETだけ。
   ========================================================= */
const DETAIL_KEYS = {
  recent5: "kb:player:recent5",
  transfers: "kb:player:transfers",
  injuries: "kb:player:injuries",
};
const DETAIL_SHARD_SIZE = 700;   // 1ブロックあたりの選手数
const DETAIL_MAX_SHARDS = 20;

async function saveShardedMap(deps, baseKey, map) {
  const { upstashEnabled, upstashSetJSON, upstashCmd, upstashGetJSON } = deps;
  if (!upstashEnabled) return { saved: false, count: 0 };
  const ids = Object.keys(map);
  const shardCount = Math.min(DETAIL_MAX_SHARDS, Math.max(1, Math.ceil(ids.length / DETAIL_SHARD_SIZE)));
  const prevMeta = upstashGetJSON ? await upstashGetJSON(`${baseKey}:meta`).catch(() => null) : null;
  const gen = prevMeta && Number.isFinite(prevMeta.generation) ? (prevMeta.generation + 1) % 1000 : 0;
  let ok = true;
  for (let i = 0; i < shardCount; i++) {
    const chunk = {};
    for (const id of ids.slice(i * DETAIL_SHARD_SIZE, (i + 1) * DETAIL_SHARD_SIZE)) chunk[id] = map[id];
    if ((await upstashSetJSON(`${baseKey}:g${gen}:s${i}`, chunk)) === false) ok = false;
  }
  if (!ok) {
    // 目次を更新しない = 前回の内容がそのまま使われる(混ざらない)
    if (upstashCmd) for (let i = 0; i < shardCount; i++) await upstashCmd(["DEL", `${baseKey}:g${gen}:s${i}`]).catch(() => {});
    return { saved: false, count: 0, reasonJa: "補助データの保存に失敗したため、前回の内容を使い続けます。" };
  }
  const okMeta = (await upstashSetJSON(`${baseKey}:meta`, {
    generation: gen, shardCount, count: ids.length, savedAt: new Date().toISOString(),
  })) !== false;
  if (okMeta && upstashCmd && prevMeta && Number.isFinite(prevMeta.generation)) {
    for (let i = 0; i < Math.min(DETAIL_MAX_SHARDS, prevMeta.shardCount || 0); i++) {
      await upstashCmd(["DEL", `${baseKey}:g${prevMeta.generation}:s${i}`]).catch(() => {});
    }
  }
  return { saved: okMeta, count: ids.length, shardCount };
}

async function loadShardedMap(deps, baseKey) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) return { map: {}, available: false };
  const meta = await upstashGetJSON(`${baseKey}:meta`).catch(() => null);
  if (!meta || !Number.isFinite(meta.shardCount)) return { map: {}, available: false };
  const map = {};
  let missing = 0;
  for (let i = 0; i < Math.min(DETAIL_MAX_SHARDS, meta.shardCount); i++) {
    const chunk = await upstashGetJSON(`${baseKey}:g${meta.generation}:s${i}`).catch(() => null);
    if (chunk && typeof chunk === "object") Object.assign(map, chunk);
    else missing++;
  }
  return { map, available: missing === 0, missing, meta };
}

/**
 * 3種類の補助データをまとめて保存する。
 * @param {object} sets { liveIds:Set, recent5:Map, transfers:Array, injuries:Array }
 */
async function saveDetailStores(deps, sets) {
  const live = sets.liveIds || new Set();
  const keep = (id) => live.size === 0 || live.has(Number(id));

  // 直近5試合(今日取れた選手ぶんだけ更新し、それ以外は前回の内容を残す)
  const prevR5 = (await loadShardedMap(deps, DETAIL_KEYS.recent5)).map || {};
  const r5 = {};
  for (const [id, rows] of Object.entries(prevR5)) if (keep(id)) r5[id] = rows;
  for (const [id, rows] of (sets.recent5 || new Map())) if (keep(id)) r5[id] = rows;

  // 移籍履歴(日付で重複を除いて積む。最大10件)
  const prevTr = (await loadShardedMap(deps, DETAIL_KEYS.transfers)).map || {};
  const tr = {};
  for (const [id, rows] of Object.entries(prevTr)) if (keep(id)) tr[id] = rows;
  for (const row of (sets.transfers || [])) {
    if (!keep(row.playerId)) continue;
    const arr = tr[row.playerId] || [];
    const key = `${row.date}|${row.fromEn}|${row.toEn}`;
    if (arr.some((x) => `${x.date}|${x.fromEn}|${x.toEn}` === key)) continue;
    arr.push(row);
    arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    tr[row.playerId] = arr.slice(0, 10);
  }

  // 怪我履歴(同じ日・同じ理由は1件にまとめる。最大10件)
  const prevInj = (await loadShardedMap(deps, DETAIL_KEYS.injuries)).map || {};
  const inj = {};
  for (const [id, rows] of Object.entries(prevInj)) if (keep(id)) inj[id] = rows;
  for (const row of (sets.injuries || [])) {
    if (!keep(row.playerId)) continue;
    const arr = inj[row.playerId] || [];
    const key = `${row.at}|${row.reasonJa}`;
    if (arr.some((x) => `${x.at}|${x.reasonJa}` === key)) continue;
    arr.push(row);
    arr.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    inj[row.playerId] = arr.slice(0, 10);
  }

  const a = await saveShardedMap(deps, DETAIL_KEYS.recent5, r5);
  const b = await saveShardedMap(deps, DETAIL_KEYS.transfers, tr);
  const c = await saveShardedMap(deps, DETAIL_KEYS.injuries, inj);
  return {
    recent5: a, transfers: b, injuries: c,
    saved: a.saved && b.saved && c.saved,
  };
}

async function loadGrid(deps) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) return {};
  return (await upstashGetJSON(GRID_KEY).catch(() => null)) || {};
}
async function saveGrid(deps, grid) {
  const { upstashEnabled, upstashSetJSON } = deps;
  if (!upstashEnabled || !grid) return false;
  return (await upstashSetJSON(GRID_KEY, grid)) !== false;
}

/* =========================================================
   ⑧ AI分析(実測値のみを根拠にする)
   ---------------------------------------------------------
   「長所」「短所」は、**同じポジションの選手の中での順位**という
   実測から必ず計算できるものだけを使う。能力値・総合点は作らない。
   戦術・クラブの当てはめは "解釈" であることを明示する。
   ========================================================= */
const METRIC_DEFS = [
  { key: "goals", col: COL.goals, labelJa: "ゴール数", higherIsBetter: true, unitJa: "点" },
  { key: "assists", col: COL.assists, labelJa: "アシスト数", higherIsBetter: true, unitJa: "本" },
  { key: "rating", col: COL.rating, labelJa: "平均評価", higherIsBetter: true, digits: 2 },
  { key: "minutes", col: COL.minutes, labelJa: "出場時間", higherIsBetter: true, unitJa: "分" },
  { key: "keyPasses", col: COL.keyPasses, labelJa: "キーパス", higherIsBetter: true, unitJa: "本" },
  { key: "passAccuracyPct", col: COL.passAccuracyPct, labelJa: "パス成功率", higherIsBetter: true, unitJa: "%", digits: 1 },
  { key: "dribbleSuccessRatePct", col: COL.dribbleSuccessRatePct, labelJa: "ドリブル成功率", higherIsBetter: true, unitJa: "%", digits: 1 },
  { key: "defensiveActions", col: COL.defensiveActions, labelJa: "守備アクション(タックル+インターセプト)", higherIsBetter: true, unitJa: "回" },
  { key: "duelWinRatePct", col: COL.duelWinRatePct, labelJa: "デュエル勝率", higherIsBetter: true, unitJa: "%", digits: 1 },
  { key: "lineups", col: COL.lineups, labelJa: "スタメン出場数", higherIsBetter: true, unitJa: "試合" },
];

/** 同ポジションの母集団の中での順位(%)。母集団が20人未満なら計算しない。 */
function percentileTable(index, row) {
  const pos = row[COL.position];
  const peers = index.filter((r) => r[COL.position] === pos && r[COL.id] !== row[COL.id]);
  const out = {};
  for (const m of METRIC_DEFS) {
    const mine = row[m.col];
    if (mine === null || mine === undefined) {
      out[m.key] = { measurable: false, reasonJa: `${m.labelJa}がまだ取得できていません。` };
      continue;
    }
    const vals = peers.map((r) => r[m.col]).filter((v) => v !== null && v !== undefined);
    if (vals.length < 20) {
      out[m.key] = { measurable: false, reasonJa: `比較できる同ポジションの選手が${vals.length}人しかいないため、順位を出していません(20人以上必要)。`, value: mine };
      continue;
    }
    // ---- 同値の扱い(2026年8月の監査で発見した順位のでっち上げ) ----
    // 以前は「自分より小さい人数 ÷ 全体」で順位を出していた。これだと
    // **全員が同じ値のとき順位0%(=下位1%)になる**。
    // 例: GKのゴール数は全員0なので、全GKが「ゴール数が同ポジション最下位」という
    // 事実に反する短所を持たされていた。中間順位(同値は半分と数える)に直す。
    const below = vals.filter((v) => v < mine).length;
    const equal = vals.filter((v) => v === mine).length;
    const pct = Math.round(((below + equal / 2) / vals.length) * 100);
    const tieRate = equal / vals.length;
    // 半数以上が同じ値の項目は、順位に意味が無い(0点/0本など)。
    // 「測れない」のではなく「差が付いていない」ので、そう明記して長所・短所から外す。
    const tieDominant = tieRate >= 0.5;
    const topPct = Math.max(1, 100 - pct);
    const rankJa = topPct <= 50 ? `上位${topPct}%` : `下位${Math.max(1, 100 - topPct)}%`;
    out[m.key] = {
      measurable: true, value: mine, percentile: pct, sampleSize: vals.length,
      sameValueCount: equal, tieDominant,
      labelJa: m.labelJa, unitJa: m.unitJa || "", digits: m.digits ?? null,
      displayValue: m.digits !== undefined && m.digits !== null ? Number(mine).toFixed(m.digits) : String(mine),
      noteJa: tieDominant
        ? `同じ${BROAD_POSITION_JA[pos] || pos}${vals.length}人のうち${equal}人が同じ値のため、順位に意味がありません`
        : `同じ${BROAD_POSITION_JA[pos] || pos}${vals.length}人の中で${rankJa}`,
    };
  }
  return out;
}

const TACTIC_RULES = [
  {
    id: "possession", labelJa: "ボール保持で崩す戦術(ポゼッション)",
    needs: ["passAccuracyPct", "keyPasses"],
    test: (p) => (p.passAccuracyPct.percentile >= 60 && p.keyPasses.percentile >= 55),
    whyJa: "パス成功率とキーパスがいずれも同ポジションの上位にあるため。",
  },
  {
    id: "counter", labelJa: "速い攻め(カウンター)",
    needs: ["dribbleSuccessRatePct", "goals"],
    test: (p) => (p.dribbleSuccessRatePct.percentile >= 60 && p.goals.percentile >= 55),
    whyJa: "ドリブル成功率とゴール数がいずれも同ポジションの上位にあるため。",
  },
  {
    id: "press", labelJa: "前から奪う戦術(ハイプレス)",
    needs: ["defensiveActions", "duelWinRatePct"],
    test: (p) => (p.defensiveActions.percentile >= 60 && p.duelWinRatePct.percentile >= 55),
    whyJa: "守備アクションとデュエル勝率がいずれも同ポジションの上位にあるため。",
  },
  {
    id: "lowblock", labelJa: "引いて守る戦術(ローブロック)",
    needs: ["duelWinRatePct", "defensiveActions"],
    test: (p) => (p.duelWinRatePct.percentile >= 70 && p.defensiveActions.percentile >= 50),
    whyJa: "デュエル勝率が特に高く、守備アクションも平均以上のため。",
  },
  {
    id: "creator", labelJa: "個で違いを作る戦術(創造性重視)",
    needs: ["assists", "keyPasses"],
    test: (p) => (p.assists.percentile >= 70 || p.keyPasses.percentile >= 75),
    whyJa: "アシストまたはキーパスが同ポジションの上位にあるため。",
  },
];

/**
 * 選手1人のAI分析。すべて実測値からの計算で、能力値のでっち上げはしない。
 * @param {Array} index 索引全体(順位計算の母集団)
 * @param {Array} row   対象の行
 */
function analyzePlayer(index, row, opts) {
  const o = opts || {};
  const pct = percentileTable(index, row);
  const measurable = Object.values(pct).filter((v) => v.measurable);

  const strengths = METRIC_DEFS
    .map((m) => ({ m, p: pct[m.key] }))
    .filter((x) => x.p.measurable && !x.p.tieDominant && x.p.percentile >= 70)
    .sort((a, b) => b.p.percentile - a.p.percentile)
    .slice(0, 4)
    .map((x) => ({ metric: x.m.key, labelJa: x.m.labelJa, value: x.p.value, displayValue: x.p.displayValue, unitJa: x.p.unitJa, percentile: x.p.percentile, noteJa: x.p.noteJa }));

  const weaknesses = METRIC_DEFS
    .map((m) => ({ m, p: pct[m.key] }))
    .filter((x) => x.p.measurable && !x.p.tieDominant && x.p.percentile <= 30)
    .sort((a, b) => a.p.percentile - b.p.percentile)
    .slice(0, 3)
    .map((x) => ({ metric: x.m.key, labelJa: x.m.labelJa, value: x.p.value, displayValue: x.p.displayValue, unitJa: x.p.unitJa, percentile: x.p.percentile, noteJa: x.p.noteJa }));

  const tactics = [];
  for (const rule of TACTIC_RULES) {
    const ok = rule.needs.every((k) => pct[k] && pct[k].measurable && !pct[k].tieDominant);
    if (!ok) continue;
    if (rule.test(pct)) tactics.push({ id: rule.id, labelJa: rule.labelJa, whyJa: rule.whyJa });
  }

  // プレースタイル: 上位の指標の組み合わせを日本語で説明する(断定しない)
  const styleTags = [];
  const at = (k, n) => pct[k] && pct[k].measurable && !pct[k].tieDominant && pct[k].percentile >= n;
  if (at("dribbleSuccessRatePct", 70)) styleTags.push("ドリブルで運べる");
  if (at("keyPasses", 70)) styleTags.push("決定機を作る");
  if (at("passAccuracyPct", 75)) styleTags.push("パスを繋いで組み立てる");
  if (at("defensiveActions", 70)) styleTags.push("守備での貢献が多い");
  if (at("duelWinRatePct", 70)) styleTags.push("1対1に強い");
  if (at("goals", 75)) styleTags.push("得点を取り切る");
  if (at("minutes", 80)) styleTags.push("主力として使われ続けている");

  const growth = growthOf(row);
  const form = row[COL.formDelta];
  const condition = row[COL.injured] === 1
    ? { state: "injured", labelJa: "負傷者リストに掲載中", sourceJa: "API-Footballの負傷者リスト(毎日更新)" }
    : form === null || form === undefined
      ? { state: "unknown", labelJa: "調子の変化はまだ測定できません", reasonJa: "前回の平均評価が保存されていないため、変化を出せません(明日以降に測定できるようになります)。" }
      : form >= 0.15 ? { state: "up", labelJa: `上向き(平均評価が前回比 +${form})` }
        : form <= -0.15 ? { state: "down", labelJa: `下向き(平均評価が前回比 ${form})` }
          : { state: "flat", labelJa: `横ばい(平均評価の前回比 ${form === 0 ? "±0" : (form > 0 ? "+" : "") + form})` };

  return {
    playerId: row[COL.id],
    name: row[COL.name],
    measuredCount: measurable.length,
    percentiles: pct,
    strengths, weaknesses,
    tactics,
    styleTags,
    growth,
    condition,
    similar: o.skipSimilar ? null : similarPlayers(index, row, 5),
    fitClubs: o.skipFitClubs ? null : fitClubs(index, row, 5),
    methodJa: "長所・短所は「同じポジションの選手の中での順位」という実測の計算結果です。能力値や総合点のような独自スコアは作っていません。",
    unavailableJa: UNAVAILABLE_SEARCH_FIELDS_JA,
  };
}

/** 類似選手: 実測値を同ポジション内で標準化し、距離が近い順。母集団が小さい場合は出さない。 */
function similarPlayers(index, row, limit) {
  const pos = row[COL.position];
  const peers = index.filter((r) => r[COL.position] === pos && r[COL.id] !== row[COL.id]);
  if (peers.length < 20) {
    return { available: false, reasonJa: `同じポジションの比較対象が${peers.length}人しかいないため、類似選手を出していません(20人以上必要)。`, items: [] };
  }
  const cols = [COL.rating, COL.goals, COL.assists, COL.keyPasses, COL.passAccuracyPct, COL.dribbleSuccessRatePct, COL.defensiveActions, COL.duelWinRatePct];
  const stats = cols.map((c) => {
    const vals = peers.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    return { mean, sd };
  });
  const usable = cols.map((c, i) => (stats[i] && row[c] !== null && row[c] !== undefined ? i : -1)).filter((i) => i >= 0);
  if (usable.length < 3) {
    return { available: false, reasonJa: `この選手の実測項目が${usable.length}個しか揃っていないため、類似選手を出していません(3個以上必要)。`, items: [] };
  }
  const z = (r, i) => (r[cols[i]] - stats[i].mean) / stats[i].sd;
  const scored = [];
  for (const p of peers) {
    let sum = 0, n = 0;
    for (const i of usable) {
      if (p[cols[i]] === null || p[cols[i]] === undefined) continue;
      sum += (z(row, i) - z(p, i)) ** 2; n++;
    }
    if (n < Math.max(3, Math.ceil(usable.length * 0.6))) continue;
    scored.push({ row: p, dist: Math.sqrt(sum / n), used: n });
  }
  scored.sort((a, b) => a.dist - b.dist);
  return {
    available: true,
    basisJa: `平均評価・ゴール・アシスト・キーパス・パス成功率・ドリブル成功率・守備アクション・デュエル勝率のうち、両者ともに実測できている項目だけを同ポジション内で標準化して比較しています。`,
    items: scored.slice(0, limit || 5).map((s) => ({
      ...fromIndexRow(s.row),
      distance: Math.round(s.dist * 1000) / 1000,
      comparedMetrics: s.used,
    })),
  };
}

/**
 * 向いているクラブ: 「そのクラブの同ポジションで、この選手より平均評価が高い選手が
 * 何人いるか」という実測から、出場機会を得やすい順に並べる。
 * 移籍市場の評価や戦術的相性を推測しているわけではないことを明記する。
 */
function fitClubs(index, row, limit) {
  const pos = row[COL.position];
  const mine = row[COL.rating];
  if (mine === null || mine === undefined) {
    return { available: false, reasonJa: "この選手の平均評価がまだ取得できていないため、出場機会の比較ができません。", items: [] };
  }
  const byClub = new Map();
  for (const r of index) {
    if (r[COL.position] !== pos) continue;
    if (r[COL.id] === row[COL.id]) continue;
    const c = r[COL.teamEn];
    if (!c) continue;
    const cur = byClub.get(c) || { teamEn: c, teamJa: r[COL.teamJa] || c, leagueId: r[COL.leagueId], samePos: 0, better: 0, rated: 0 };
    cur.samePos++;
    if (r[COL.rating] !== null && r[COL.rating] !== undefined) {
      cur.rated++;
      if (r[COL.rating] > mine) cur.better++;
    }
    byClub.set(c, cur);
  }
  const items = [...byClub.values()]
    .filter((c) => c.rated >= 2 && c.teamEn !== row[COL.teamEn])
    .sort((a, b) => (a.better - b.better) || (b.rated - a.rated))
    .slice(0, limit || 5)
    .map((c) => ({
      teamEn: c.teamEn, teamJa: c.teamJa, leagueId: c.leagueId,
      samePositionPlayers: c.samePos, ratedPlayers: c.rated, betterRatedPlayers: c.better,
      noteJa: `同じ${BROAD_POSITION_JA[pos] || pos}で平均評価がこの選手を上回るのは${c.better}人(平均評価が取れている${c.rated}人中)`,
    }));
  return {
    available: items.length > 0,
    reasonJa: items.length ? null : "比較できるクラブがまだ揃っていません。",
    basisJa: "「そのクラブの同じポジションで、この選手より平均評価が高い選手が少ない」という実測の並び替えです。移籍の可能性・戦術的な相性・給与などを推測したものではありません。",
    items,
  };
}

/* =========================================================
   ⑨ 比較(2〜4人)
   ========================================================= */
const COMPARE_METRICS = [
  { key: "rating", col: COL.rating, labelJa: "平均評価", higherIsBetter: true, digits: 2 },
  { key: "appearances", col: COL.appearances, labelJa: "出場試合", higherIsBetter: true, digits: 0 },
  { key: "minutes", col: COL.minutes, labelJa: "出場時間(分)", higherIsBetter: true, digits: 0 },
  { key: "goals", col: COL.goals, labelJa: "ゴール", higherIsBetter: true, digits: 0 },
  { key: "assists", col: COL.assists, labelJa: "アシスト", higherIsBetter: true, digits: 0 },
  { key: "keyPasses", col: COL.keyPasses, labelJa: "キーパス", higherIsBetter: true, digits: 0 },
  { key: "passAccuracyPct", col: COL.passAccuracyPct, labelJa: "パス成功率(%)", higherIsBetter: true, digits: 1 },
  { key: "dribbleSuccessRatePct", col: COL.dribbleSuccessRatePct, labelJa: "ドリブル成功率(%)", higherIsBetter: true, digits: 1 },
  { key: "defensiveActions", col: COL.defensiveActions, labelJa: "守備アクション", higherIsBetter: true, digits: 0 },
  { key: "duelWinRatePct", col: COL.duelWinRatePct, labelJa: "デュエル勝率(%)", higherIsBetter: true, digits: 1 },
  { key: "age", col: COL.age, labelJa: "年齢", higherIsBetter: null, digits: 0 },
  { key: "heightCm", col: COL.heightCm, labelJa: "身長(cm)", higherIsBetter: null, digits: 0 },
];

function comparePlayers(index, rows) {
  const players = rows.map((r) => fromIndexRow(r));
  const metrics = COMPARE_METRICS.map((m) => {
    const values = rows.map((r) => r[m.col]);
    const present = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null && x.v !== undefined);
    let bestIndex = null;
    if (m.higherIsBetter === true && present.length >= 2) {
      const max = Math.max(...present.map((x) => x.v));
      const winners = present.filter((x) => x.v === max);
      bestIndex = winners.length === 1 ? winners[0].i : null; // 同点なら勝者を作らない
    }
    return {
      key: m.key, labelJa: m.labelJa, digits: m.digits,
      values, bestIndex,
      comparableJa: present.length < 2
        ? `${rows.length}人のうち${present.length}人しか実測できていないため、この項目は比較していません。`
        : null,
      missingCount: rows.length - present.length,
    };
  });
  const perPlayerAnalysis = rows.map((r) => analyzePlayer(index, r, { skipSimilar: true, skipFitClubs: true }));
  const wins = rows.map((_, i) => metrics.filter((m) => m.bestIndex === i).length);
  return {
    players, metrics,
    winCounts: wins,
    samePosition: new Set(rows.map((r) => r[COL.position])).size === 1,
    analyses: perPlayerAnalysis.map((a) => ({
      playerId: a.playerId, strengths: a.strengths, weaknesses: a.weaknesses,
      tactics: a.tactics, styleTags: a.styleTags, growth: a.growth, condition: a.condition,
    })),
    cautionJa: "比較しているのは実測値だけです。総合点や勝敗の判定は作っていません。ポジションが違う選手同士では、同じ項目を比べても意味が薄い場合があります。",
    unavailableJa: UNAVAILABLE_SEARCH_FIELDS_JA,
  };
}

/* =========================================================
   入力途中の候補表示(オートコンプリート)
   ---------------------------------------------------------
   索引はサーバーのメモリにあるので、1文字打つたびに
   Redisにも外部APIにも触れずに候補を返せる。
   ・完全一致 → 前方一致 → 単語の先頭一致 → 部分一致 の順
   ・同点は「よく使われている順」(=所属選手が多いクラブ、選手数が多い国)
   ========================================================= */
function rankSuggestion(normalized, query) {
  if (!normalized) return null;
  if (normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  if (normalized.split(" ").some((w) => w.startsWith(query))) return 2;
  if (normalized.includes(query)) return 3;
  return null;
}

/**
 * @param {Array} index 索引
 * @param {string} field "name" | "club" | "nationality"
 * @param {string} q 入力途中の文字列
 * @param {number} limit 返す件数
 */
function suggest(index, field, q, limit) {
  const max = Math.max(1, Math.min(20, limit || 8));
  const raw = String(q || "").trim();
  const norm = normalizeForSearch(raw);
  if (!raw) return [];

  if (field === "club") {
    const clubs = new Map();
    for (const row of index) {
      const en = row[COL.teamEn];
      if (!en) continue;
      const cur = clubs.get(en) || { value: en, labelJa: row[COL.teamJa] || en, count: 0, leagueId: row[COL.leagueId] };
      cur.count++; clubs.set(en, cur);
    }
    const out = [];
    for (const c of clubs.values()) {
      // 英語表記と日本語表記のどちらでも引けるようにする
      const score = Math.min(
        rankSuggestion(normalizeForSearch(c.value), norm) ?? 99,
        (c.labelJa && c.labelJa.includes(raw)) ? 1 : 99
      );
      if (score === 99) continue;
      out.push({ ...c, score });
    }
    out.sort((a, b) => (a.score - b.score) || (b.count - a.count) || a.value.localeCompare(b.value));
    return out.slice(0, max).map((c) => ({ value: c.value, labelJa: c.labelJa, count: c.count, subJa: `${c.count}人` }));
  }

  if (field === "nationality") {
    const nats = new Map();
    for (const row of index) {
      const n = row[COL.nationality];
      if (!n) continue;
      nats.set(n, (nats.get(n) || 0) + 1);
    }
    const out = [];
    for (const [name, count] of nats) {
      const score = rankSuggestion(normalizeForSearch(name), norm);
      if (score === null) continue;
      out.push({ value: name, labelJa: name, count, score });
    }
    out.sort((a, b) => (a.score - b.score) || (b.count - a.count) || a.value.localeCompare(b.value));
    return out.slice(0, max).map((n) => ({ value: n.value, labelJa: n.labelJa, count: n.count, subJa: `${n.count}人` }));
  }

  // 選手名
  const out = [];
  for (const row of index) {
    const score = rankSuggestion(normalizeForSearch(row[COL.name]), norm);
    if (score === null) continue;
    // 同点のときは、出場時間が長い(=よく知られている)選手を先に出す
    out.push({ score, minutes: row[COL.minutes] ?? -1, row });
    if (out.length > 4000) break; // 暴走防止
  }
  out.sort((a, b) => (a.score - b.score) || (b.minutes - a.minutes) || String(a.row[COL.name]).localeCompare(String(b.row[COL.name])));
  return out.slice(0, max).map((x) => ({
    value: x.row[COL.name],
    id: x.row[COL.id],
    labelJa: x.row[COL.name],
    subJa: [x.row[COL.teamJa] || x.row[COL.teamEn], BROAD_POSITION_JA[x.row[COL.position]] || null, x.row[COL.nationality] || null]
      .filter(Boolean).join(" / "),
    photo: x.row[COL.id] ? `https://media.api-sports.io/football/players/${x.row[COL.id]}.png` : null,
  }));
}

/* =========================================================
   AIおすすめ選手
   ---------------------------------------------------------
   「22歳以下・ウイング・評価が高い・怪我が少ない・伸びしろがある」
   のような条件から候補を出す。順位づけに使うのは実測値だけで、
   独自の総合点は作らない。**なぜその選手なのかを必ず添える**。
   ========================================================= */
const RECOMMEND_PRESETS = {
  youngProspect: {
    labelJa: "伸びしろのある若手",
    query: { ageMax: 22, minutesMin: 450 },
    weights: { rating: 1.0, growth: 1.2, startRate: 0.6, youth: 0.8 },
    reasonJa: "22歳以下で、出場時間が450分以上あり、平均評価が伸びている選手",
  },
  inForm: {
    labelJa: "いま調子が良い選手",
    query: { formMin: 0.1 },
    weights: { rating: 0.8, form: 1.5, recent5: 1.2 },
    reasonJa: "直近で平均評価が上がっている選手",
  },
  reliable: {
    labelJa: "毎試合出ている主力",
    query: { minutesMin: 900 },
    weights: { rating: 1.2, startRate: 1.5, minutes: 0.8 },
    reasonJa: "スタメンで出続けていて、平均評価も高い選手",
  },
  fitOnly: {
    labelJa: "いま出場できる選手",
    query: { injured: false },
    weights: { rating: 1.2, startRate: 0.8 },
    reasonJa: "負傷者リストに載っておらず、平均評価が高い選手",
  },
};

/** 実測値だけを使った並び替え。各要素の寄与を「理由」として必ず返す。 */
function recommendPlayers(index, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(30, o.limit || 10));
  const preset = RECOMMEND_PRESETS[o.preset] || null;
  const query = { ...(preset ? preset.query : {}), ...(o.query || {}) };
  const weights = { ...(preset ? preset.weights : { rating: 1 }), ...(o.weights || {}) };

  const pool = searchIndex(index, query);
  if (!pool.length) {
    return {
      available: false, items: [],
      reasonJa: "条件に合う選手が見つかりませんでした。条件をゆるめてお試しください。",
      presetJa: preset ? preset.labelJa : null,
    };
  }
  // 各指標を「同ポジションではなく候補全体の中での順位(0〜1)」に直す。
  // 単位の違う指標を足すために順位に直しているだけで、能力値は作っていない。
  const cols = {
    rating: COL.rating, minutes: COL.minutes, form: COL.formDelta,
    recent5: COL.recent5Rating, goals: COL.goals, assists: COL.assists,
  };
  const pct = {};
  for (const [key, col] of Object.entries(cols)) {
    const vals = pool.map((r) => r[col]).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    pct[key] = (v) => {
      if (v === null || v === undefined || !vals.length) return null;
      let lo = 0, hi = vals.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < v) lo = mid + 1; else hi = mid; }
      return vals.length > 1 ? lo / (vals.length - 1) : 0.5;
    };
  }
  const startRateOf = (r) => {
    const lu = r[COL.lineups], ap = r[COL.appearances];
    return (Number.isFinite(lu) && Number.isFinite(ap) && ap > 0) ? lu / ap : null;
  };
  const youthOf = (r) => (Number.isFinite(r[COL.age]) ? Math.max(0, (30 - r[COL.age]) / 14) : null);
  const growthOfRow = (r) => {
    const g = growthOf(r);
    return g.measurable ? Math.max(0, Math.min(1, (g.delta + 0.5) / 1.0)) : null;
  };

  const scored = pool.map((r) => {
    const parts = [];
    let total = 0, usedWeight = 0;
    const add = (key, value, labelJa, detailJa) => {
      const w = weights[key];
      if (!w || value === null || value === undefined) return;
      total += w * value; usedWeight += w;
      if (value >= 0.7) parts.push({ labelJa, detailJa, strength: Math.round(value * 100) });
    };
    add("rating", pct.rating(r[COL.rating]), "平均評価が高い", r[COL.rating] !== null ? `平均評価 ${r[COL.rating]}` : null);
    add("form", pct.form(r[COL.formDelta]), "調子が上向き", Number.isFinite(r[COL.formDelta]) ? `前回比 ${r[COL.formDelta] > 0 ? "+" : ""}${r[COL.formDelta]}` : null);
    add("recent5", pct.recent5(r[COL.recent5Count] >= 3 ? r[COL.recent5Rating] : null), "直近5試合でも高評価", r[COL.recent5Count] >= 3 ? `直近${r[COL.recent5Count]}試合の平均 ${r[COL.recent5Rating]}` : null);
    add("minutes", pct.minutes(r[COL.minutes]), "出場時間が長い", Number.isFinite(r[COL.minutes]) ? `${r[COL.minutes]}分` : null);
    add("startRate", startRateOf(r), "スタメンで使われている", (() => {
      const sr = startRateOf(r);
      return sr === null ? null : `スタメン率 ${Math.round(sr * 100)}%`;
    })());
    add("youth", youthOf(r), "若い", Number.isFinite(r[COL.age]) ? `${r[COL.age]}歳` : null);
    add("growth", growthOfRow(r), "平均評価が伸びている", (() => {
      const g = growthOf(r);
      return g.measurable ? g.noteJa : null;
    })());
    return { row: r, score: usedWeight > 0 ? total / usedWeight : 0, parts, usedWeight };
  })
    // 判断材料が1つも無い選手は候補にしない(でっち上げ防止)
    .filter((x) => x.usedWeight > 0 && x.parts.length > 0);

  scored.sort((a, b) => b.score - a.score);
  return {
    available: scored.length > 0,
    presetJa: preset ? preset.labelJa : null,
    criteriaJa: preset ? preset.reasonJa : "指定された条件",
    poolSize: pool.length,
    methodJa: "候補全体の中での順位(実測値)だけを組み合わせて並べています。能力値や総合点のような独自スコアは作っていません。",
    reasonJa: scored.length ? null : "条件に合う選手はいましたが、根拠にできる実測値が揃っていませんでした。",
    items: scored.slice(0, limit).map((x) => ({
      ...fromIndexRow(x.row),
      matchScore: Math.round(x.score * 100),
      whyJa: x.parts.map((p) => p.detailJa ? `${p.labelJa}(${p.detailJa})` : p.labelJa),
    })),
  };
}

/* =========================================================
   今日AIが注目する選手(実測の変化からだけ選ぶ)
   ========================================================= */
function dailyHighlights(index, opts) {
  const o = opts || {};
  const limit = o.limit || 5;
  const picks = [];
  const seen = new Set();
  const push = (row, kindJa, whyJa) => {
    const id = Number(row[COL.id]);
    if (seen.has(id)) return;
    seen.add(id);
    picks.push({ ...fromIndexRow(row), kindJa, whyJa });
  };

  // ① 調子が最も上がった選手
  const formUp = index.filter((r) => Number.isFinite(r[COL.formDelta]) && r[COL.formDelta] >= 0.15)
    .sort((a, b) => b[COL.formDelta] - a[COL.formDelta]);
  for (const r of formUp.slice(0, 2)) {
    push(r, "調子が急上昇", `平均評価が前回比 +${r[COL.formDelta]}(現在 ${r[COL.rating]})`);
  }
  // ② 直近5試合で最も評価が高い若手
  const youngHot = index
    .filter((r) => Number.isFinite(r[COL.age]) && r[COL.age] <= 23 && r[COL.recent5Count] >= 3 && Number.isFinite(r[COL.recent5Rating]))
    .sort((a, b) => b[COL.recent5Rating] - a[COL.recent5Rating]);
  for (const r of youngHot.slice(0, 2)) {
    push(r, "好調な若手", `${r[COL.age]}歳・直近${r[COL.recent5Count]}試合の平均評価 ${r[COL.recent5Rating]}`);
  }
  // ③ 移籍したばかりの選手(索引の所属変更から検知したもの)
  const moved = (o.recentTransfers || []);
  for (const t of moved.slice(0, 2)) {
    const r = index.find((x) => Number(x[COL.id]) === Number(t.playerId));
    if (r) push(r, "移籍", t.detailJa || "所属クラブが変わりました");
  }
  // ④ 怪我から戻った選手
  const returned = (o.injuryReturns || []);
  for (const t of returned.slice(0, 2)) {
    const r = index.find((x) => Number(x[COL.id]) === Number(t.playerId));
    if (r) push(r, "怪我から復帰", t.detailJa || "負傷者リストから外れました");
  }
  // ⑤ 枠が余ったら、平均評価が高く出場も多い選手で埋める
  if (picks.length < limit) {
    const solid = index
      .filter((r) => Number.isFinite(r[COL.rating]) && Number.isFinite(r[COL.minutes]) && r[COL.minutes] >= 900)
      .sort((a, b) => b[COL.rating] - a[COL.rating]);
    for (const r of solid) {
      if (picks.length >= limit) break;
      push(r, "安定した主力", `出場${r[COL.minutes]}分・平均評価 ${r[COL.rating]}`);
    }
  }
  return {
    available: picks.length > 0,
    items: picks.slice(0, limit),
    methodJa: "前日からの実測の変化(調子・直近5試合・移籍・怪我)だけで選んでいます。AIの好みや評判は入っていません。",
    reasonJa: picks.length ? null : "前日と比べて目立った変化がまだ検知できていません(索引が2日ぶん貯まると表示されます)。",
  };
}

/* =========================================================
   2026年8月7日・「データはあるのに検索できない」への構造的な対処
   ---------------------------------------------------------
   本番で起きたこと(実測):
     ・選手の記録   1,378件(保存されている)
     ・クラブの名簿 42クラブぶん(保存されている)
     ・選手の索引   0人(作られていない)

   原因は「索引づくりが、長い毎日の学習ジョブの **最後** に置かれていた」こと。
   途中で止まると、材料はすべて保存済みなのに索引だけが永久にできない。
   しかも索引づくり自体は **外部APIを1回も使わない**(保存済みの材料だけで
   完結する)ので、長いジョブに相乗りさせる理由がそもそも無かった。

   そこで、保存済みのデータだけから索引を作り直せる関数を独立させる。
     ・外部API(API-Football)の呼び出し: 0回
     ・毎日の学習が止まっていても、これ単体で検索が復活する
     ・前回の索引があれば引き継ぐ(実測を消さない)
   ========================================================= */
async function rebuildIndexFromStore(deps, opts) {
  const o = opts || {};
  const clubDossier = o.clubDossier;
  const clubs = o.clubs || [];
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const todayKey = dateKeyNum(new Date(nowMs).toISOString());
  const cap = Math.max(100, Math.min(20000, o.playerRecordCap || 6000));
  const stats = {
    ok: false, source: "store", apiCalls: 0,
    fromSquads: 0, fromRecords: 0, carriedOver: 0,
    clubsWithSquad: 0, recordsRead: 0, redisReads: 0,
    droppedVariant: 0, // v74: 女子・ユース等として索引から外した件数(隠さず数える)
    reasonJa: null,
  };
  if (!deps || !deps.upstashEnabled) {
    stats.reasonJa = "保存先(Upstash)が未設定のため、索引を作り直せません。";
    return stats;
  }
  if (!clubDossier) {
    stats.reasonJa = "クラブの調査ファイルを読む手段が渡されていないため、索引を作り直せません。";
    return stats;
  }

  // ---- ① 前回の索引(あれば引き継ぐ) ----
  const prevLoaded = await loadIndex(deps);
  const prevMap = new Map();
  for (const r of (prevLoaded.rows || [])) prevMap.set(Number(r[COL.id]), r);

  // ---- ② クラブの名簿(保存済み)から、全所属選手の骨格を作る ----
  const merged = new Map();
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
  // ---- v74(2026年9月1日・利用者の指摘): 女子・ユース・2軍チームの選手を索引に入れない ----
  //   このサイトは男子サッカー専用(利用者の方針)。過去にチームID照合の化けで
  //   女子チームの名簿・記録が保存された可能性があるため、索引を作る段階でも弾く。
  //   (照合側の根本修正は server.js resolveTeamId 参照。ここは防波堤の二重化)
  const VARIANT_RE = /(\s|\()W\)?$|\sW\s|U-?(17|18|19|20|21|23)|\s(II|III|B)$|women|youth|reserves?|femin|frauen|femminile|dames|ladies|女子|レディース/i;
  const isVariantRec = (rec) => VARIANT_RE.test(String((rec && rec.teamEn) || "")) || VARIANT_RE.test(String((rec && rec.teamJa) || "")) || VARIANT_RE.test(String((rec && rec.leagueName) || ""));
  let droppedVariant = 0;
  const put = (id, rec) => {
    if (isVariantRec(rec)) { droppedVariant++; return false; }
    merged.set(Number(id), mergeInto(merged.get(Number(id)), rec));
    return true;
  };

  for (const club of clubs) {
    const d = await clubDossier.getDossier(club.nameEn).catch(() => null);
    stats.redisReads++;
    const squad = d && d.sections && d.sections.squad && d.sections.squad.players;
    if (!Array.isArray(squad) || !squad.length) continue;
    stats.clubsWithSquad++;
    for (const p of squad) {
      if (!p || !p.id) continue;
      if (put(p.id, {
        id: Number(p.id), name: p.name, teamEn: club.nameEn, teamJa: club.nameJa,
        leagueId: club.leagueId || null, position: p.position, age: p.age, number: p.number,
      })) stats.fromSquads++;
    }
  }

  // ---- ③ 保存済みの選手記録(実測の成績つき)を重ねる ----
  const statsIndex = await clubDossier.getStatsIndex().catch(() => ({}));
  stats.redisReads++;
  // 更新が新しい順に読む(上限で切れても、より新しい実測が残るように)
  const ids = Object.keys(statsIndex || {})
    .sort((a, b) => String(statsIndex[b] || "").localeCompare(String(statsIndex[a] || "")))
    .slice(0, cap);
  for (const id of ids) {
    const rec = await clubDossier.getPlayer(id).catch(() => null);
    stats.redisReads++;
    stats.recordsRead++;
    if (!rec || !rec.id) continue;
    if (put(rec.id, rec)) stats.fromRecords++;
  }

  // ---- ④ スタメン配置(細かいポジションの推定に使う。保存済み) ----
  const grid = (await loadGrid(deps).catch(() => null)) || {};
  stats.redisReads++;

  // ---- ⑤ 索引の行を作る ----
  const rows = [];
  for (const [id, rec] of merged) {
    const prev = prevMap.get(id) || null;
    rows.push(toIndexRow(rec, { todayKey, gridStats: gridStatsFrom(grid[id]) }, nowMs, prev));
  }
  // 前回の索引にしかいない選手も残す(名簿の輪番で今日たまたま読めなかった人を消さない)
  for (const [id, prevRow] of prevMap) {
    if (merged.has(id)) continue;
    // v74: 前回の索引から引き継ぐ行にも同じ防波堤を通す(過去に混入した女子選手を掃除する)
    if (VARIANT_RE.test(String(prevRow[COL.teamEn] || "")) || VARIANT_RE.test(String(prevRow[COL.teamJa] || ""))) { droppedVariant++; continue; }
    rows.push(prevRow);
    stats.carriedOver++;
  }

  stats.droppedVariant = droppedVariant;
  if (!rows.length) {
    stats.reasonJa = "保存済みのデータから作れる選手が1人もいませんでした(名簿も選手記録もまだ空です)。";
    return stats;
  }

  const saveRes = await saveIndex(deps, rows, {
    builtAt: new Date(nowMs).toISOString(),
    dateKey: o.dateKey || null,
    rebuiltFromStore: true,
    sources: {
      squadClubs: stats.clubsWithSquad,
      playerRecords: stats.recordsRead,
      carriedOver: stats.carriedOver,
    },
  });
  stats.ok = saveRes.saved === true;
  stats.count = rows.length;
  stats.shardCount = saveRes.shardCount;
  stats.withRating = rows.filter((r) => r[COL.rating] !== null && r[COL.rating] !== undefined).length;
  stats.withNationality = rows.filter((r) => r[COL.nationality]).length;
  stats.clubs = new Set(rows.map((r) => r[COL.teamEn]).filter(Boolean)).size;
  stats.reasonJa = saveRes.saved === true ? null : (saveRes.reasonJa || "索引の保存に失敗しました。");
  return stats;
}

module.exports = {
  rebuildIndexFromStore,
  suggest, rankSuggestion, recommendPlayers, RECOMMEND_PRESETS, dailyHighlights,
  INDEX_KEY, INDEX_META_KEY, INDEX_SHARD_PREFIX, INDEX_GEN_PREFIX, shardKey, GRID_KEY, SHARD_SIZE, MAX_SHARDS, ROW_LENGTH,
  COL, BROAD_POSITIONS, BROAD_POSITION_JA, DETAILED_POSITION_JA, DETAILED_POSITION_ORDER,
  UNAVAILABLE_SEARCH_FIELDS_JA, METRIC_DEFS, COMPARE_METRICS, SORTABLE,
  normalizeForSearch, parseHeightCm, ageFrom, numOrNull, dateKeyNum, dateKeyToIso, daysBetweenKeys,
  emptyGridEntry, normalizeGridEntry, accumulateGrid, gridStatsFrom, inferDetailedPosition,
  toIndexRow, fromIndexRow, growthOf, inRange, matchesRow, precompute, searchIndex, sortRows, paginate, facetsOf,
  saveIndex, loadIndex, loadGrid, saveGrid,
  DETAIL_KEYS, saveDetailStores, loadShardedMap, saveShardedMap,
  percentileTable, analyzePlayer, similarPlayers, fitClubs, comparePlayers,
};
