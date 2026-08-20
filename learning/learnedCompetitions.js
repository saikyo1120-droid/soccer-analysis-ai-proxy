/**
 * server/learning/learnedCompetitions.js
 * ------------------------------------------------
 * 2026年8月20日・v62「学習した大会と、していない大会を分ける」
 * (的中率低下の根治②)。
 *
 * ■ 見つかった問題(本番実測)
 *   AIの学習データは**欧州12大会**(9リーグ+CL/EL/ECL)だけ。ところが予想は、
 *   追跡クラブの試合であれば**どの大会でも**出していた。実際に外れた試合には
 *   ハンガリーNB I・MLS・スイスなど、**学習データが1件も無い大会**が並んでいた。
 *   それらを同じ的中率に混ぜて数えていたため、
 *     ・数字が実力より低く出る(親善試合を分けたときと同じ構造の問題)
 *     ・利用者から見て「この予想はどれくらい根拠があるのか」が分からない
 *   という2つの不利益があった。
 *
 * ■ 方針(親善試合のときと同じ考え方を踏襲する)
 *   **予想は今までどおり出す(隠さない)。ただし集計と表示を分ける。**
 *   ・学習済みの大会 … 主表示。AIの実力はこの数字で測る。
 *   ・学習していない大会 … 参考表示。「学習データがない大会です」と明記する。
 *   これは数字を良く見せるための操作ではない。**同じ条件で測った数字だけを
 *   並べる**ための分離であり、参考側の数字も必ず一緒に開示する。
 *
 * ■ 判定の根拠(でっち上げ防止)
 *   「学習した大会」の定義は、実際に過去試合を取得している
 *   historicalBackfill.DEFAULT_BACKFILL_LEAGUES と**同一のリスト**を使う。
 *   人が別に決めた表ではないので、学習対象を増やせば判定も自動で追従する。
 */

const { DEFAULT_BACKFILL_LEAGUES } = require("./historicalBackfill");

/** 学習対象の大会ID(過去試合を実際に取得している大会) */
const LEARNED_LEAGUE_IDS = new Set(DEFAULT_BACKFILL_LEAGUES.map((l) => l.id));

/**
 * 大会IDが記録されていない古い予測のための、名前による補助判定。
 * API-Football が返す英語名(記録に保存されている表記)で持つ。
 * ここに無い名前は「学習していない」と正直に扱う(推測で学習済みにしない)。
 */
const LEARNED_LEAGUE_NAMES = [
  "premier league", "la liga", "bundesliga", "serie a", "ligue 1",
  "eredivisie", "primeira liga", "super lig", "süper lig", "jupiler pro league",
  "first division a", "uefa champions league", "uefa europa league",
  "uefa europa conference league",
];

function normLeagueName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * この試合の大会を、AIが学習しているか判定する(純関数)。
 * @param {number|null} leagueId - API-Football の大会ID(記録の leagueId)
 * @param {string|null} leagueName - 大会名(IDが無い古い記録の補助)
 * @param {Set<number>|null} learnedIds - 差し替え用(テスト・将来の拡張)
 * @returns {{ learned: boolean, reasonJa: string|null }}
 */
function classifyLearnedCompetition(leagueId, leagueName, learnedIds) {
  const ids = learnedIds || LEARNED_LEAGUE_IDS;
  const unlearned = () => ({
    learned: false,
    reasonJa: `${leagueName ? `「${leagueName}」は` : "この大会は"}AIの学習データに含まれていない大会です(学習しているのは欧州12大会)。参考予想として扱い、実力を測る的中率とは分けて集計しています。`,
  });
  // Number(null) も Number("") も 0 になってしまうため、空の値は先に弾く
  // (これを怠ると、IDが無い古い記録が「ID=0の未知の大会」として扱われ、
  //  大会名による補助判定に到達しない)。
  const hasId = leagueId !== null && leagueId !== undefined && leagueId !== ""
    && Number.isFinite(Number(leagueId));
  if (hasId) {
    // IDがあるならそれが最も確実。学習対象に無いIDは、名前を見ずに未学習とする。
    return ids.has(Number(leagueId)) ? { learned: true, reasonJa: null } : unlearned();
  }
  // IDが無い古い記録だけ、大会名で補助的に判定する。
  //   **完全一致のみ**。部分一致にすると「Ukrainian Premier League」のような
  //   別大会を「Premier League」として学習済み扱いしてしまう(でっち上げ)。
  const n = normLeagueName(leagueName);
  if (n && LEARNED_LEAGUE_NAMES.includes(n)) return { learned: true, reasonJa: null };
  return unlearned();
}

/** 保存済みの予測記録が「学習した大会」かを返す(保存フラグ優先・無ければ判定) */
function isLearnedRecord(record) {
  if (!record) return false;
  if (record.learnedCompetition !== undefined) return record.learnedCompetition !== false;
  return classifyLearnedCompetition(record.leagueId, record.league).learned;
}

/**
 * 答え合わせ済みの記録を「学習済み大会 / 学習していない大会 / 参考(親善・2軍)」に分けて数える。
 * @param {Array} records - resolved な予測記録
 * @param {(r:any)=>boolean} isOfficial - 公式戦かどうかの判定(既存の分類をそのまま渡す)
 * @returns {{ learnedOfficial, unlearnedOfficial, unofficial, all }}
 */
function accuracySplit(records, isOfficial) {
  const officialOf = typeof isOfficial === "function" ? isOfficial : () => true;
  const bucket = () => ({ n: 0, hits: 0 });
  const out = { learnedOfficial: bucket(), unlearnedOfficial: bucket(), unofficial: bucket(), all: bucket() };
  for (const r of records || []) {
    if (!r || !r.resolved) continue;
    const hit = r.correct === true;
    out.all.n++; if (hit) out.all.hits++;
    if (!officialOf(r)) { out.unofficial.n++; if (hit) out.unofficial.hits++; continue; }
    const key = isLearnedRecord(r) ? "learnedOfficial" : "unlearnedOfficial";
    out[key].n++; if (hit) out[key].hits++;
  }
  for (const k of Object.keys(out)) {
    out[k].hitRatePct = out[k].n ? Math.round((out[k].hits / out[k].n) * 1000) / 10 : null;
  }
  return out;
}

module.exports = {
  LEARNED_LEAGUE_IDS, LEARNED_LEAGUE_NAMES,
  classifyLearnedCompetition, isLearnedRecord, accuracySplit,
};
