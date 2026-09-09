/**
 * server/learning/playerFeatures.js
 * ------------------------------------------------
 * 選手個人の「実データ」統計を抽出するモジュール(2026年8月・知識拡張フェーズ)。
 *
 * ご要望「選手についてキーパス・ドリブル成功率・守備指標・空中戦・パス成功率・
 * プレス成功率まで」への回答。API-Footballの/playersエンドポイントの
 * statistics[] には、実はこれまで使っていなかった多くの実データが含まれている
 * ことが分かったため(passes.key / passes.accuracy / dribbles.attempts,success /
 * tackles.total,interceptions / duels.total,won など)、それらを正式に抽出する。
 *
 * 正直な範囲(重要): 以下は実装していない(理由と代替案)。
 *   - プレス成功率: PPDA同様、API-Footballにこの種の高度な戦術指標は存在しない
 *     (契約中のデータソースでは提供されていないことを確認済み)。代替として、
 *     tackles.total + tackles.interceptions(奪回に関わった実際の回数)を
 *     「守備指標」として使う(プレスの「成功率」という意味では代用にならない
 *     点に注意)。
 *   - 空中戦(交空中戦だけの勝率): API-Footballのduels{total,won}は、地上戦・
 *     空中戦を区別しない「デュエル(競り合い)全体」の勝敗数であり、空中戦だけを
 *     切り出したデータではない。そのため「空中戦」ではなく正直に「デュエル
 *     (競り合い全体)勝率」として提供する。
 *   - 市場価値・契約情報・利き足: API-Footballのplayerオブジェクトに該当する
 *     フィールドが無いことを確認済み(id, name, age, birth, nationality,
 *     height, weight, injured, photo のみ)。Transfermarkt等の別データソースが
 *     必要になるため、今回は実装しない(スクレイピングは既存方針により不可)。
 *
 * 正確なフィールド名(誤字を含め実際のAPIレスポンス通りに扱う):
 *   games.appearences("appearances"ではなく"appearences"と綴る。API側の実際の
 *   綴りをそのまま踏襲。ここで直してしまうと実データと食い違って未定義になる)。
 */

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v.replace("%", "")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * v89(2026年9月9日・利用者の指摘「まだ女性の選手が混ざっています」への根治)
 * ------------------------------------------------------------------------------
 * ■ 本番で実測した混入経路
 *   API-Football側で、クラブの**男子チームIDに女子部門の成績が紐づいている**選手が
 *   存在する(実例: /players?team=<バイエルンの男子ID> の応答に、女子ブンデスリーガの
 *   成績を持つ選手が含まれていた)。従来の対策(v74)はチーム名・リーグ名の
 *   「W・Women・女子」等をチーム解決時と索引読み出し時に弾くものだったが、
 *   この経路では行に刻印されるのが**クラブ設定のラベル(男子クラブ名・男子リーグID)**
 *   のため、どちらのフィルタにも一切引っかからず、男子選手として表示されていた。
 *
 * ■ 対処(選手単位の判定)
 *   選手の statistics[](成績エントリー)の**中身のリーグ名・チーム名**で判定する。
 *   ここには実際の出場大会(例: "Frauen Bundesliga")が入っており、刻印ラベルと違って
 *   ごまかしが効かない。女子大会の成績しか持たない選手は、収集(索引・記録・速報)にも
 *   質問時のライブ検索にも載せない(このサイトは男子サッカー専用)。
 *   男子大会の成績を1件でも持つ選手は男子選手として扱い、成績の代表値も
 *   男子大会のエントリーからだけ選ぶ。
 *
 * ■ 誤爆防止(でっち上げ禁止と同じ精神で「消しすぎない」)
 *   ・単語境界で判定する(West Ham / Wolfsburg / World Cup 等のWは弾かない)
 *   ・チーム名の末尾「〜 W」「〜 (W)」は女子チームの標準表記なので弾く
 *   ・判定できない(リーグ名が無い等)エントリーは男子扱い=従来どおり(消しすぎない)
 */
// femin(仏feminine)・fémin(アクセント付き)・femmin(伊femminile)・femen(西femenino)をすべて拾う
const WOMENS_COMP_RE = /\bwomen'?s?\b|\bfrauen\b|f[ée]min|femmin|femen|\bwsl\b|\bnwsl\b|\bladies\b|\bdames\b|damallsvenskan|toppserien|kvinne|女子|レディース/i;
const WOMENS_TEAM_SUFFIX_RE = /(\s|\()W\)?$/;
function isWomensStatEntry(st) {
  const lg = String((st && st.league && st.league.name) || "");
  const tm = String((st && st.team && st.team.name) || "");
  if (WOMENS_COMP_RE.test(lg) || WOMENS_COMP_RE.test(tm)) return true;
  if (/^liga f$/i.test(lg.trim())) return true; // スペイン女子1部の正式名(単語が短く上の正規表現に含めると誤爆するため完全一致)
  if (WOMENS_TEAM_SUFFIX_RE.test(tm.trim())) return true;
  return false;
}
/** statistics[]から男子大会のエントリーだけを残す。womensOnly=女子成績しか無い選手 */
function filterMensStatEntries(list) {
  const all = Array.isArray(list) ? list : [];
  const mens = all.filter((st) => !isWomensStatEntry(st));
  return { mens, womensOnly: all.length > 0 && mens.length === 0 };
}

/**
 * @param {object} statsBlock - API-Footballの /players レスポンスの
 *   response[].statistics[] の1要素(既存のserver.js resolvePlayerId/
 *   handlePlayerSeasonStatsが選び出したものをそのまま渡す想定)。
 */
function computePlayerRealStats(statsBlock) {
  if (!statsBlock) return null;
  const games = statsBlock.games || {};
  const passes = statsBlock.passes || {};
  const dribbles = statsBlock.dribbles || {};
  const tackles = statsBlock.tackles || {};
  const duels = statsBlock.duels || {};
  const goals = statsBlock.goals || {};

  const dribbleAttempts = toNum(dribbles.attempts);
  const dribbleSuccess = toNum(dribbles.success);
  const duelsTotal = toNum(duels.total);
  const duelsWon = toNum(duels.won);
  // ---- 2026年8月の監査で発見した「0のでっち上げ」の修正 ----
  // 以前は `|| 0` としていたため、**タックル・インターセプトが1つも
  // 取得できていない選手も「守備アクション0回」という実測値**として
  // 保存されていた。0は「やっていない」であって「取得できていない」ではない。
  // 両方とも取得できない場合は null(=測れていない)を返す。
  const tacklesTotalRaw = toNum(tackles.total);
  const interceptionsRaw = toNum(tackles.interceptions);
  const tacklesTotal = tacklesTotalRaw === null ? 0 : tacklesTotalRaw;
  const interceptions = interceptionsRaw === null ? 0 : interceptionsRaw;
  const defensiveMeasured = tacklesTotalRaw !== null || interceptionsRaw !== null;

  return {
    position: games.position || null,
    appearances: toNum(games.appearences),
    minutes: toNum(games.minutes),
    avgRating: toNum(games.rating),
    goals: toNum(goals.total),
    assists: toNum(goals.assists),
    keyPasses: toNum(passes.key),
    passAccuracyPct: toNum(passes.accuracy), // API-Football上は数値(%相当)またはnull
    dribbleAttempts,
    dribbleSuccessCount: dribbleSuccess,
    // 試行はあるのに成功数が取得できていない場合、0%は「1度も成功しなかった」
    // という実測の主張になってしまう。取得できていないなら null を返す。
    dribbleSuccessRatePct: (dribbleAttempts && dribbleSuccess !== null)
      ? Math.round((dribbleSuccess / dribbleAttempts) * 1000) / 10 : null,
    // 「守備指標」= タックル+インターセプトの合計(プレス成功率の代替。正直な注記はファイル冒頭参照)
    defensiveActions: defensiveMeasured ? tacklesTotal + interceptions : null,
    tacklesTotal: tacklesTotalRaw,
    interceptions: interceptionsRaw,
    duelsTotal,
    duelsWon,
    // 「空中戦」ではなく正直に「デュエル(競り合い全体)勝率」
    duelWinRatePct: (duelsTotal && duelsWon !== null)
      ? Math.round((duelsWon / duelsTotal) * 1000) / 10 : null,
    yellowCards: toNum((statsBlock.cards || {}).yellow),
    redCards: toNum((statsBlock.cards || {}).red),
  };
}

module.exports = { computePlayerRealStats, toNum, isWomensStatEntry, filterMensStatEntries };
