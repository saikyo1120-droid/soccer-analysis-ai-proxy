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
  const tacklesTotal = toNum(tackles.total) || 0;
  const interceptions = toNum(tackles.interceptions) || 0;

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
    dribbleSuccessRatePct: dribbleAttempts ? Math.round((dribbleSuccess / dribbleAttempts) * 1000) / 10 : null,
    // 「守備指標」= タックル+インターセプトの合計(プレス成功率の代替。正直な注記はファイル冒頭参照)
    defensiveActions: tacklesTotal + interceptions,
    tacklesTotal,
    interceptions,
    duelsTotal,
    duelsWon,
    // 「空中戦」ではなく正直に「デュエル(競り合い全体)勝率」
    duelWinRatePct: duelsTotal ? Math.round((duelsWon / duelsTotal) * 1000) / 10 : null,
    yellowCards: toNum((statsBlock.cards || {}).yellow),
    redCards: toNum((statsBlock.cards || {}).red),
  };
}

module.exports = { computePlayerRealStats, toNum };
