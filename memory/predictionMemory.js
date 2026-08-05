/**
 * server/memory/predictionMemory.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑤「Memory Engineを試合予測にも使ってください」。
 *
 * ご指示(設計方針):
 *   「Memory Engineは『すべて保存』ではなく、予測や評価が変わった時だけ記録して
 *     ください。前回との違い・変わった理由・何を学んだかを保存し、同じ内容は
 *     重複保存しないようにしてください。回答では必要な時だけ過去との比較を表示し、
 *     レスポンス速度を落とさない設計にしてください。」
 *
 * ■ 「変わった時だけ」の実装
 *   既存の memoryStore.saveConclusion は、前回と同じ内容なら
 *   {changed:false, reason:"UNCHANGED"} を返して保存しない仕組みを既に持っている。
 *   このモジュールはその上に「予測評価という主題」を載せ、
 *   さらに**意味のある変化だけ**を通すフィルタを追加する。
 *   具体的には、勝者予想が変わった場合か、勝率が CHANGE_THRESHOLD_PCT(既定5%)
 *   以上動いた場合のみ「変化あり」とみなす。0.1%の揺れで毎日保存すると
 *   「変わった時だけ」の意図が失われるため。
 *
 * ■ 「変わった理由」の作り方(LLMを使わない=速い・でっち上げない)
 *   予測時に既に計算されている特徴量(features)の前回との差分を取り、
 *   最も大きく動いた要因を機械的に特定する。LLMを呼ばないので
 *   レスポンス速度に影響せず、かつ存在しない理由を作らない。
 *
 * ■ レスポンス速度への配慮
 *   ・書き込みは「変化があった時だけ」なので、通常はUpstashへの書き込みが発生しない。
 *   ・読み出しは1キーのGETのみ(getLastConclusion)。
 *   ・比較文の生成は純粋な計算(外部呼び出しなし)。
 *   ・呼び出し側は await せず fire-and-forget にもできるよう、
 *     recordPredictionEvaluation は失敗しても例外を投げない設計にしている。
 */

const CHANGE_THRESHOLD_PCT = 5; // 勝率がこれ以上動いたら「評価が変わった」とみなす

// 特徴量の日本語名(predictionModel.jsのFEATURE_LABELS_JAと同じ語彙を使う)
const FEATURE_LABELS_JA = {
  formDiff: "直近フォーム",
  goalRateDiff: "得点力・失点率",
  injuryDiff: "怪我人",
  standingsDiff: "順位・勝点",
  headToHeadDiff: "過去対戦成績",
  fatigueDiff: "過密日程(疲労)",
  venueDiff: "ホーム/アウェイ別の成績",
  suspensionDiff: "出場停止",
  xgDiff: "xG(期待得点)",
  topScorerDiff: "エースの得点力",
};

const WINNER_LABELS_JA = { home: "ホーム有利", away: "アウェイ有利", draw: "引き分け濃厚" };

// 対戦カードごとの主題キー。同じ対戦は同じキーに集約する(順序も固定する)。
function matchupKey(homeTeamEn, awayTeamEn) {
  if (!homeTeamEn || !awayTeamEn) return null;
  return `matchup:${homeTeamEn}-vs-${awayTeamEn}:prediction`;
}

// 保存する「評価」の要約文。ここが前回と同じなら保存しない(重複排除の判定材料)。
function buildEvaluationStatement(evaluation) {
  const e = evaluation || {};
  const winner = WINNER_LABELS_JA[e.predictedWinner] || "判定不能";
  const pct = Number.isFinite(e.homeWinPct) ? `(ホーム勝率${e.homeWinPct}%)` : "";
  return `${winner}${pct}`;
}

/**
 * 前回と今回の評価の差から、「何が変わったのか・なぜ変わったのか」を説明する。
 * LLMは使わない(速度とでっち上げ防止のため)。
 * @returns {{isMeaningful:boolean, headlineJa:string, reasonsJa:string[], learnedJa:string|null}}
 */
function describeEvaluationChange(previous, current) {
  const prev = previous || null;
  const cur = current || {};
  if (!prev) {
    return {
      isMeaningful: false,
      headlineJa: "この対戦についてAIが評価するのは今回が初めてです。",
      reasonsJa: [],
      learnedJa: null,
    };
  }

  const winnerChanged = prev.predictedWinner !== cur.predictedWinner;
  const pctDelta = (Number.isFinite(cur.homeWinPct) && Number.isFinite(prev.homeWinPct))
    ? Math.round((cur.homeWinPct - prev.homeWinPct) * 10) / 10
    : null;
  const pctMoved = pctDelta !== null && Math.abs(pctDelta) >= CHANGE_THRESHOLD_PCT;

  if (!winnerChanged && !pctMoved) {
    return {
      isMeaningful: false,
      headlineJa: "前回の評価から実質的な変化はありません。",
      reasonsJa: [],
      learnedJa: null,
    };
  }

  // 何が変わったのか(見出し)
  let headlineJa;
  if (winnerChanged) {
    headlineJa = `前回は「${WINNER_LABELS_JA[prev.predictedWinner] || "判定不能"}」と考えていましたが、今回は「${WINNER_LABELS_JA[cur.predictedWinner] || "判定不能"}」に評価を変更しました。`;
  } else {
    headlineJa = `評価の方向は「${WINNER_LABELS_JA[cur.predictedWinner] || "判定不能"}」のままですが、ホーム勝率の見立てが${prev.homeWinPct}%から${cur.homeWinPct}%へ${pctDelta > 0 ? "上がり" : "下がり"}ました。`;
  }

  // なぜ変わったのか(特徴量の差分から、大きく動いた順に最大3件)
  const reasonsJa = [];
  const prevF = prev.features || {};
  const curF = cur.features || {};
  // 第6次監査で発見した欠陥の修正:
  //   特徴量は「両チーム分そろわなかった」場合も0として保存されるため、
  //   昨日は取得できていたxGが今日は取得できなかっただけで
  //   「xGがアウェイ側に有利な方向へ0.80動きました」という、
  //   **データ障害をサッカー的な理由として説明する**文が出ていた。
  //   どちらの時点で実データが揃っていたか(supplied)を見て、
  //   片方でも揃っていない項目は理由に使わず、正直に別枠で伝える。
  const prevSupplied = prev.supplied || null;
  const curSupplied = cur.supplied || null;
  const bothSupplied = (k) => {
    if (!prevSupplied || !curSupplied) return true; // 記録が古く判定材料が無い場合は従来通り
    return prevSupplied[k] !== false && curSupplied[k] !== false;
  };
  const lostDataKeys = Object.keys(FEATURE_LABELS_JA).filter((k) =>
    prevSupplied && curSupplied && prevSupplied[k] === true && curSupplied[k] === false);
  const moves = Object.keys(FEATURE_LABELS_JA)
    .filter(bothSupplied)
    .map((k) => ({ key: k, delta: (curF[k] || 0) - (prevF[k] || 0) }))
    .filter((m) => Math.abs(m.delta) > 0.01)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);
  for (const m of moves) {
    const label = FEATURE_LABELS_JA[m.key];
    const dir = m.delta > 0 ? "ホーム側に有利な方向へ" : "アウェイ側に有利な方向へ";
    reasonsJa.push(`${label}が${dir}${Math.abs(m.delta).toFixed(2)}動きました。`);
  }
  if (lostDataKeys.length) {
    // データが取れなくなったことは、サッカー的な理由ではない。別枠で正直に言う。
    reasonsJa.push(`なお、前回は取得できていた${lostDataKeys.map((k) => FEATURE_LABELS_JA[k]).join("・")}のデータが今回は取得できませんでした(この項目は今回の判断には使っていません)。`);
  }
  if (!reasonsJa.length) {
    // 第6次監査で発見した誤りの修正:
    //   「AIが他の試合から学習して重みを更新したため」と断言していたが、
    //   重みが実際に更新されたかどうかは、この関数では一切確認していない。
    //   前回の記録が古くて特徴量を持っていない場合もここへ来る。
    //   確認していないことを原因として述べない。
    const weightsChanged = Number.isFinite(prev.weightsVersion) && Number.isFinite(cur.weightsVersion)
      && prev.weightsVersion !== cur.weightsVersion;
    reasonsJa.push(weightsChanged
      ? `試合のデータ自体は前回とほぼ同じですが、その間にAIが他の試合から学習して重み(何を重視するか)を更新したため(バージョン${prev.weightsVersion}→${cur.weightsVersion})、評価が変わりました。`
      : "試合のデータ自体は前回とほぼ同じでしたが、評価の数値がわずかに変わりました(理由をこれ以上特定できていません)。");
  }

  // 何を学んだか
  const learnedJa = winnerChanged
    ? "同じ対戦でも、直前の状況の変化によって結論が入れ替わりうることを記録しました。次回この対戦を評価する際の比較材料になります。"
    : "結論は同じでも、確からしさが変化したことを記録しました。";

  return { isMeaningful: true, headlineJa, reasonsJa, learnedJa };
}

/**
 * 予測評価をMemory Engineへ記録する(変化があった時だけ)。
 * 例外を投げない(呼び出し側のレスポンスを絶対に止めないため)。
 *
 * @param {object} deps - { memoryStore }
 * @param {string} homeTeamEn
 * @param {string} awayTeamEn
 * @param {object} evaluation - { predictedWinner, homeWinPct, features, computedAt }
 * @returns {{recorded:boolean, reason:string, change:object|null}}
 */
async function recordPredictionEvaluation(deps, homeTeamEn, awayTeamEn, evaluation) {
  const { memoryStore } = deps || {};
  const key = matchupKey(homeTeamEn, awayTeamEn);
  if (!memoryStore || !key) return { recorded: false, reason: "NO_STORE_OR_KEY", change: null };

  try {
    const last = await memoryStore.getLastConclusion(key);
    const previous = (last && last.detail) ? last.detail : null;
    const change = describeEvaluationChange(previous, evaluation);

    // 初回は「変化」ではないが、比較の起点として必ず記録する。
    // それ以降は、意味のある変化があった時だけ記録する(ご指示の「すべて保存しない」)。
    if (previous && !change.isMeaningful) {
      return { recorded: false, reason: "NO_MEANINGFUL_CHANGE", change };
    }

    const statement = buildEvaluationStatement(evaluation);
    const result = await memoryStore.saveConclusion(
      key,
      {
        statement,
        computedAt: evaluation.computedAt || new Date().toISOString(),
        reasoning: change.isMeaningful ? [change.headlineJa, ...change.reasonsJa].join(" ") : "この対戦の初回評価。",
        // 次回の比較に必要な生データ。統計値そのものは保存するが、
        // 表示用の文章は毎回その場で組み立てる(古い文言が残らないようにするため)。
        detail: {
          predictedWinner: evaluation.predictedWinner,
          homeWinPct: evaluation.homeWinPct,
          features: evaluation.features || {},
          // 第6次監査での追加: 「その特徴量に実データが入っていたか」も一緒に
          // 記録する。これが無いと、次回の比較で「データ障害」と
          // 「本当にサッカー的な変化」を区別できない。
          supplied: evaluation.supplied || null,
          weightsVersion: Number.isFinite(evaluation.weightsVersion) ? evaluation.weightsVersion : null,
        },
      },
      change.isMeaningful ? change.headlineJa : "この対戦の初回評価を記録しました。"
    );
    return { recorded: !!result.changed, reason: result.reason || "SAVED", change };
  } catch (e) {
    // Memory Engineは付加機能。失敗しても予測そのものは返さなければならない。
    return { recorded: false, reason: `ERROR:${e.message}`, change: null };
  }
}

/**
 * 回答へ添える「過去との比較」を作る。
 * ご指示どおり**必要な時だけ**返す(変化が無ければnull=画面に何も出さない)。
 * 読み出しは1キーのみ・計算だけなので、レスポンス速度に影響しない。
 */
async function buildComparisonForResponse(deps, homeTeamEn, awayTeamEn, evaluation) {
  const { memoryStore } = deps || {};
  const key = matchupKey(homeTeamEn, awayTeamEn);
  if (!memoryStore || !key) return null;
  try {
    const last = await memoryStore.getLastConclusion(key);
    const previous = (last && last.detail) ? last.detail : null;
    if (!previous) return null; // 初回は比較するものが無いので何も出さない
    const change = describeEvaluationChange(previous, evaluation);
    if (!change.isMeaningful) return null; // 変化が無ければ表示しない(ノイズを増やさない)
    return {
      headlineJa: change.headlineJa,
      reasonsJa: change.reasonsJa,
      learnedJa: change.learnedJa,
      previousComputedAt: last.computedAt || null,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  matchupKey, buildEvaluationStatement, describeEvaluationChange,
  recordPredictionEvaluation, buildComparisonForResponse,
  CHANGE_THRESHOLD_PCT, FEATURE_LABELS_JA, WINNER_LABELS_JA,
};
