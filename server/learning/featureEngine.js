/**
 * server/learning/featureEngine.js
 * ------------------------------------------------
 * 2026年8月・ご指示③「同じ特徴量を二重管理しないでください」への対応。
 *
 * ご指示原文:
 *   「現在 Learning Engine と オンデマンド分析 で別々の特徴量生成になっている
 *     ように見えます。今後ズレが起きないよう特徴量生成を共通化してください。
 *     Feature Engine(共通特徴量生成)のような形にまとめられるなら
 *     その設計へ変更してください。」
 *
 * ■ なぜ必要だったか(監査で判明した実害)
 *   日次学習(dailyJob.js)は venueDiff / suspensionDiff / xgDiff / topScorerDiff へ
 *   実データを供給していましたが、利用者向けのオンデマンド分析(server.js)は
 *   同じ computeMatchFeatures を呼びながら**この4項目を渡していませんでした**。
 *   その結果、Learning Engineが学習した重みが、利用者の「今日どっちが勝つ?」
 *   という質問では**一切効いていませんでした**(常に0が入るため)。
 *
 *   原因は「同じ特徴量なのに、組み立てるコードが2箇所にあった」ことです。
 *   同じズレを二度と起こさないため、**チーム文脈(ctx)の組み立てを1箇所に集約**し、
 *   両方が必ずこの関数を通るようにします。
 *
 * ■ 設計方針
 *   ・値が取れなければ null のままにする(0にしない)。0は「その値が0だった」
 *     という別の意味を持ち、予測を歪めるため。
 *   ・この関数は純粋関数(API呼び出しをしない)。取得は呼び出し側の責務とし、
 *     取得済みの素材を渡してもらう。こうするとテストが容易になり、
 *     日次ジョブ/オンデマンドのどちらからでも同じ結果になることを保証できる。
 */
const { computeHomeAwaySplit } = require("./features");
const { computeMatchFeatures, computeFeatureAvailability } = require("./predictionModel");

/**
 * 片側チームの「予測モデルへ渡す文脈」を組み立てる共通関数。
 * これが Learning Engine とオンデマンド分析の唯一の入口になる。
 *
 * @param {object} src - 取得済みの素材
 *   - side: "home" | "away"(ホーム/アウェイどちら側として評価するか)
 *   - teamId: number
 *   - form: computeGoalRateFeatures/computeFatigueFeature の結果 + fixtures
 *   - injuries: computeInjuryCountFeature の結果
 *   - standings: computeStandingsFeature の結果
 *   - xg: fetchTeamXgAverage の結果(任意)
 *   - topScorer: fetchTeamTopScorer の結果(任意)
 */
function buildTeamContext(src) {
  const s = src || {};
  const form = s.form || {};
  const injuries = s.injuries || {};
  const standings = s.standings || {};
  const xg = s.xg || {};
  const topScorer = s.topScorer || {};

  const split = computeHomeAwaySplit(form.fixtures || [], s.teamId);
  // ホーム側は「ホームでの勝率」、アウェイ側は「アウェイでの勝率」で評価する。
  // 会場を区別しない formScore とは別の情報になる。
  const venueWinRate = s.side === "home" ? split.home.winRate : split.away.winRate;

  // 出場停止は「確実に出られない」ため、出場が不確実な負傷者とは分けて扱う。
  //
  // 第5次監査で発見した重大な欠陥の修正:
  //   これまでは `(injuries.suspendedPlayers || []).length` としていたため、
  //   /injuries の取得そのものに失敗した場合(予算切れ・5xx・タイムアウト)でも
  //   **「出場停止0人」と断定**していた。片側だけ失敗すると suspensionDiff に
  //   嘘の差が生まれ、実際に勝敗予想が反転しうる状態だった。
  //   取得できたかどうかは injuryCount が数値かどうかで判定できるので、
  //   取得できていなければ null(＝不明)のままにする。
  const injuriesFetched = Number.isFinite(injuries.injuryCount);
  const suspendedPlayers = injuries.suspendedPlayers || [];
  const suspensionCount = injuriesFetched ? suspendedPlayers.length : null;
  // 監査で判明した二重計上の修正: injuryCount は出場停止も含む合計人数なので、
  // suspensionDiff と両方に効いてしまっていた。純粋な負傷者数へ補正する。
  const rawInjuryCount = injuriesFetched ? injuries.injuryCount : null;
  const injuryOnlyCount = rawInjuryCount === null ? null : Math.max(0, rawInjuryCount - (suspensionCount || 0));

  return {
    // 第6次監査で発見した欠陥の修正:
    //   `?? 0` としていたため、直近試合が1件も取れなかったチーム
    //   (昇格直後・カップ戦のみ・APIの空応答など)が「フォームスコア0」と
    //   断定され、相手に一方的な差を与えていた。取れなければ不明(null)にする。
    formScore: form.currentFormScore ?? form.formScore ?? null,
    avgGoalsFor: form.avgGoalsFor ?? null,
    avgGoalsAgainst: form.avgGoalsAgainst ?? null,
    injuryCount: injuryOnlyCount,
    // 第6次監査で発見した欠陥の修正:
    //   `standings.points / standings.played` は、points が null のとき
    //   **null / 38 === 0** となり、「1試合あたり0勝点」という嘘の値になっていた。
    //   両方が数値であることを明示的に確認する。
    pointsPerGame: (Number.isFinite(standings.points) && Number.isFinite(standings.played) && standings.played > 0)
      ? (standings.points / standings.played)
      : null,
    matchesLast7Days: form.matchesLast7Days ?? null,
    // ---- 2026年8月・優先順位②で追加した4項目(ここが唯一の供給元) ----
    homeVenueWinRate: s.side === "home" ? venueWinRate : null,
    awayVenueWinRate: s.side === "away" ? venueWinRate : null,
    suspensionCount,
    xgNet: xg.xgNet ?? null,
    topScorerGoals: (topScorer && topScorer.player) ? topScorer.player.goals : null,
  };
}

/**
 * 1試合ぶんの特徴量を、両チームの素材から一気に組み立てる。
 * Learning Engine もオンデマンド分析も、必ずこの関数を通す。
 * @returns {{features, homeCtx, awayCtx, supplied}} supplied は
 *   「4つの新特徴量に実際に値が入ったか」の検査結果(ご指示⑥の証明用)。
 */
function buildMatchFeatures(homeSrc, awaySrc, h2h) {
  const homeCtx = buildTeamContext({ ...homeSrc, side: "home" });
  const awayCtx = buildTeamContext({ ...awaySrc, side: "away" });
  const features = computeMatchFeatures(homeCtx, awayCtx, h2h);

  // ご指示⑥「途中で0/null/undefinedになっていないことをログ付きで確認」のための
  // 自己申告。値が入らなかった項目は、なぜ入らなかったかを追跡できるようにする。
  //
  // 第5次監査での改善: これまでは新しい4項目しか検査していなかったため、
  // 「順位データが取れず0を入れてしまっていた」といった**古い特徴量の
  // でっち上げを誰も検知できなかった**。10項目すべてを検査する。
  const supplied = computeFeatureAvailability(homeCtx, awayCtx, h2h);
  return { features, homeCtx, awayCtx, supplied };
}

module.exports = { buildTeamContext, buildMatchFeatures };
