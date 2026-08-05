/**
 * server/learning/importanceEngine.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑫「自律学習判断」の実装。
 *
 * ■ ご指示の原文
 *   「Learning Engineは『何でも保存する』のではなく、AI自身が『これは学ぶ価値がある』と
 *     判断できるようにしてください。(新監督就任・大型移籍・怪我・戦術変更・急激な
 *     フォーム変化・連勝連敗・予測を大きく外した試合 など)重要度を付けて学習し、
 *     『なぜ学ぶべきと判断したのか』まで保存してください。」
 *
 * ■ なぜ必要か(実際に起きていた問題)
 *   これまでの Knowledge Engine は、届いた事実をすべて同じ重さで保存していました。
 *   その結果:
 *     ・「監督が交代した」と「順位が1つ上がった」が同じ1件として数えられ、
 *       「今日は知識が34件増えました」と言われても**中身の重みが分からない**。
 *     ・クラブごとの保存上限(80件)に達したとき、押し出されるのは古い順であって
 *       重要度順ではないため、**監督交代のような決定的な事実が、順位の微小な変動に
 *       押し出されて消える**ことが起こりえた。
 *     ・推論エンジンが根拠を並べるとき、重要な事実と些細な事実の区別がなかった。
 *
 * ■ 設計方針(このプロジェクトの一貫した方針に従う)
 *   1. **LLMを使わない**。重要度は、実データから機械的に導ける条件だけで判定する。
 *      LLMに「重要かどうか」を聞くと、その判断自体がでっち上げになりうるため。
 *   2. **必ず理由を残す**。重要度だけを数字で付けても、後から検証できない。
 *      「なぜそう判断したか」を日本語で保存し、利用者にもそのまま見せられるようにする。
 *   3. **判断できないものは無理に格付けしない**。該当する条件が1つも無ければ
 *      「日常的な記録(routine)」として正直にそう記す。
 *
 * ■ 重要度の段階
 *   critical(4) … そのクラブの見方を根本から変える出来事。監督交代・主力の長期離脱など。
 *   high(3)     … 予測や評価に直接効く変化。大型移籍・急激なフォーム変化・大きな予測ミス。
 *   medium(2)   … 傾向として意味がある変化。連勝連敗・フォーメーション変更など。
 *   low(1)      … 日々の細かい更新。順位の小さな変動・選手の数値の微増減など。
 *   routine(0)  … 変化とは言えない定期記録。
 */

const IMPORTANCE_LEVELS = {
  critical: { score: 4, labelJa: "最重要", noteJa: "このクラブの見方そのものが変わる出来事です。" },
  high: { score: 3, labelJa: "重要", noteJa: "予測や評価に直接効く変化です。" },
  medium: { score: 2, labelJa: "注目", noteJa: "傾向として意味のある変化です。" },
  low: { score: 1, labelJa: "参考", noteJa: "日々の細かな更新です。" },
  routine: { score: 0, labelJa: "定期記録", noteJa: "変化とは言えない、定期的な記録です。" },
};

// 保存されている知識カテゴリごとの「基準となる重要度」。
// ここに無いカテゴリは low 扱いになる(知らないものを勝手に重要と決めつけない)。
const CATEGORY_BASE_IMPORTANCE = {
  coachChange: "critical",          // 監督交代
  transferImpact: "high",           // 移籍
  injuries: "high",                 // 怪我・出場停止
  predictionContextualFailure: "high", // モデルの外側の要因で外した(学びが大きい)
  predictionFailureReason: "medium",
  predictionSuccessReason: "medium",
  matchReflection: "medium",
  recentFormTrend: "medium",
  homeAway: "medium",
  playstyleAnalysis: "low",
  dailyAiView: "low",
  leagueStandings: "low",
  leagueTopScorers: "low",
  leagueTopAssists: "low",
  playerDaily: "low",
  managerHistory: "medium",
  clubProfile: "low",
  predictionHypothesis: "medium",
  aiLeadingFactor: "low",
};

function levelOf(name) {
  return IMPORTANCE_LEVELS[name] ? name : "low";
}
function scoreOf(name) {
  return (IMPORTANCE_LEVELS[levelOf(name)] || IMPORTANCE_LEVELS.low).score;
}
function maxLevel(a, b) {
  return scoreOf(a) >= scoreOf(b) ? levelOf(a) : levelOf(b);
}

/**
 * ご指示にあった出来事を、実データから機械的に検出する。
 *
 * @param {object} signals - 実データから分かっている手がかり(すべて任意)
 *   - category: 知識カテゴリ
 *   - formDelta: 直近5試合と、その前5試合の得失点差の変化量
 *   - streak: { result: "勝ち"|"負け"|"分け", count: number }
 *   - injuryCount / previousInjuryCount: 負傷者数と前回の負傷者数
 *   - coachChanged: 監督が変わったか(真偽)
 *   - formationChanged: 布陣が変わったか(真偽)
 *   - transferCount: 直近の移籍件数
 *   - predictionMissMargin: 予測が外れた度合い(0〜1。勝つと思っていた側の確率)
 *   - isFirstTimeKnown: そのクラブについて初めて得た種類の知識か
 * @returns {{level, score, labelJa, reasonsJa: string[], reasonJa: string, signals: object}}
 */
function assessImportance(signals) {
  const s = signals || {};
  const reasons = [];
  let level = levelOf(CATEGORY_BASE_IMPORTANCE[s.category] || "low");

  // ---- ご指示に挙げられた出来事を、それぞれ機械的に判定する ----

  // 1. 新監督就任
  if (s.coachChanged === true) {
    level = maxLevel(level, "critical");
    reasons.push("監督が交代しました。チームの戦い方が根本から変わる可能性があるため、最優先で学ぶべき変化だと判断しました。");
  }

  // 2. 大型移籍(件数が多いほど影響が大きいとみなす。金額はAPIから取得できない)
  if (Number.isFinite(s.transferCount) && s.transferCount > 0) {
    if (s.transferCount >= 3) {
      level = maxLevel(level, "critical");
      reasons.push(`直近で${s.transferCount}件の移籍がありました。複数の入れ替わりは戦力の構成そのものを変えるため、最優先で学ぶべきと判断しました。`);
    } else {
      level = maxLevel(level, "high");
      reasons.push(`直近で${s.transferCount}件の移籍がありました。戦力の変化は予測に直接効くため、重要な変化だと判断しました。`);
    }
  }

  // 3. 怪我(人数そのものより「増えたこと」を重く見る)
  if (Number.isFinite(s.injuryCount)) {
    const prev = Number.isFinite(s.previousInjuryCount) ? s.previousInjuryCount : null;
    if (prev !== null && s.injuryCount - prev >= 3) {
      level = maxLevel(level, "critical");
      reasons.push(`負傷・出場停止者が${prev}人から${s.injuryCount}人へ、${s.injuryCount - prev}人増えました。主力を一度に欠く可能性が高く、最優先で学ぶべきと判断しました。`);
    } else if (prev !== null && s.injuryCount - prev >= 1) {
      level = maxLevel(level, "high");
      reasons.push(`負傷・出場停止者が${prev}人から${s.injuryCount}人へ増えました。出場可能な選手が変わるため、重要な変化だと判断しました。`);
    } else if (s.injuryCount >= 5) {
      level = maxLevel(level, "high");
      reasons.push(`負傷・出場停止者が${s.injuryCount}人と多い状態です。総力戦になるため、重要な情報だと判断しました。`);
    }
  }

  // 4. 戦術変更(フォーメーションの変更)
  if (s.formationChanged === true) {
    level = maxLevel(level, "medium");
    reasons.push("直近の試合で基本フォーメーションが変わりました。戦い方の意図が変わった可能性があるため、注目すべき変化だと判断しました。");
  }

  // 5. 急激なフォーム変化(得失点差の平均が大きく動いた)
  if (Number.isFinite(s.formDelta)) {
    const d = Math.abs(s.formDelta);
    const dir = s.formDelta > 0 ? "上昇" : "低下";
    if (d >= 1.5) {
      level = maxLevel(level, "critical");
      reasons.push(`直近5試合の1試合平均得失点差が、その前の5試合と比べて${s.formDelta > 0 ? "+" : ""}${s.formDelta}と大きく${dir}しました。短期間での急激な変化は、必ず原因があるため最優先で学ぶべきと判断しました。`);
    } else if (d >= 0.8) {
      level = maxLevel(level, "high");
      reasons.push(`直近5試合の1試合平均得失点差が${s.formDelta > 0 ? "+" : ""}${s.formDelta}と明確に${dir}しました。調子の変化は予測に直接効くため、重要だと判断しました。`);
    } else if (d >= 0.3) {
      level = maxLevel(level, "medium");
      reasons.push(`直近5試合の1試合平均得失点差が${s.formDelta > 0 ? "+" : ""}${s.formDelta}${dir}しました。傾向として意味のある変化だと判断しました。`);
    }
  }

  // 6. 連勝・連敗
  if (s.streak && Number.isFinite(s.streak.count) && s.streak.count >= 3 && (s.streak.result === "勝ち" || s.streak.result === "負け")) {
    const word = s.streak.result === "勝ち" ? "連勝" : "連敗";
    if (s.streak.count >= 5) {
      level = maxLevel(level, "high");
      reasons.push(`${s.streak.count}${word}中です。これだけ続くのは偶然では説明しにくく、チーム状態に構造的な理由がある可能性が高いため、重要だと判断しました。`);
    } else {
      level = maxLevel(level, "medium");
      reasons.push(`${s.streak.count}${word}中です。勢いは次の試合にも影響しうるため、注目すべきだと判断しました。`);
    }
  }

  // 7. 予測を大きく外した試合(自信を持っていたほど、学びが大きい)
  if (Number.isFinite(s.predictionMissMargin) && s.predictionMissMargin > 0) {
    if (s.predictionMissMargin >= 0.6) {
      level = maxLevel(level, "critical");
      reasons.push(`勝つと予想していた側に${Math.round(s.predictionMissMargin * 100)}%の確率を与えていたのに、その通りになりませんでした。自信を持っていた予測ほど、外れた理由の中に大きな学びがあるため、最優先で学ぶべきと判断しました。`);
    } else if (s.predictionMissMargin >= 0.45) {
      level = maxLevel(level, "high");
      reasons.push(`${Math.round(s.predictionMissMargin * 100)}%の確率を与えていた側が勝てませんでした。予測の外れ方として大きいため、重要だと判断しました。`);
    }
  }

  // 8. そのクラブについて初めて得る種類の知識(空白を埋める価値がある)
  if (s.isFirstTimeKnown === true) {
    level = maxLevel(level, "medium");
    reasons.push("このクラブについて、この種類の情報を持つのは初めてです。知識の空白を埋める価値があるため、注目すべきだと判断しました。");
  }

  if (!reasons.length) {
    const base = CATEGORY_BASE_IMPORTANCE[s.category];
    reasons.push(base
      ? `${s.category}の定期的な更新です。特筆すべき変化の条件には当てはまりませんでした。`
      : "特筆すべき変化の条件には当てはまりませんでした。日常的な記録として保存します。");
    if (!base) level = "routine";
  }

  const meta = IMPORTANCE_LEVELS[level];
  return {
    level,
    score: meta.score,
    labelJa: meta.labelJa,
    // 「なぜ学ぶべきと判断したのか」(ご指示の中核)。複数該当した場合はすべて残す。
    reasonsJa: reasons,
    reasonJa: reasons.join(" "),
    // 判定に使った手がかりも残す(後から「その判断は妥当だったか」を検証できるように)
    signals: {
      category: s.category ?? null,
      formDelta: Number.isFinite(s.formDelta) ? s.formDelta : null,
      streak: s.streak || null,
      injuryCount: Number.isFinite(s.injuryCount) ? s.injuryCount : null,
      previousInjuryCount: Number.isFinite(s.previousInjuryCount) ? s.previousInjuryCount : null,
      coachChanged: s.coachChanged ?? null,
      formationChanged: s.formationChanged ?? null,
      transferCount: Number.isFinite(s.transferCount) ? s.transferCount : null,
      predictionMissMargin: Number.isFinite(s.predictionMissMargin) ? s.predictionMissMargin : null,
      isFirstTimeKnown: s.isFirstTimeKnown ?? null,
    },
  };
}

/**
 * その日に学んだ内容を「重要度別に何件ずつだったか」へ集計する。
 * 「今日は知識が34件増えました」だけでは中身の重みが分からない、という
 * 問題への回答。利用者には「最重要2件・重要5件・…」と見せられるようにする。
 */
function summarizeImportance(items) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, routine: 0 };
  const highlights = [];
  for (const it of items || []) {
    const lv = levelOf(it && it.importance && it.importance.level);
    counts[lv]++;
    if (lv === "critical" || lv === "high") {
      highlights.push({
        level: lv,
        labelJa: IMPORTANCE_LEVELS[lv].labelJa,
        statement: (it && it.statement) || "",
        reasonJa: (it && it.importance && it.importance.reasonJa) || "",
        teamJa: (it && (it.teamJa || it.teamEn)) || null,
      });
    }
  }
  const notable = counts.critical + counts.high;
  const total = (items || []).length;
  // 監査の指摘への対応:
  //   1件も学べなかった日(=取得が全部失敗した日)にも
  //   「本日学んだ0件は、いずれも日常的な更新の範囲でした」と表示していた。
  //   失敗を「特筆すべきことが無かった」と言い換えるのは、
  //   このプロジェクトが最も避けたい種類の嘘なので、0件は0件として扱う。
  //   また、ここで数えているのは「重要度を判定した知識」だけであり、
  //   リーグ・選手の知識は含まれないことも明示する(件数の食い違いを防ぐ)。
  const summaryJa = total === 0
    ? "本日は、重要度を判定できる新しい知識がありませんでした(データ取得に失敗している可能性もあります。下のエラー欄をご確認ください)。"
    : notable > 0
      ? `本日、重要度を判定した${total}件のうち、${counts.critical}件が最重要、${counts.high}件が重要でした。`
      : `本日、重要度を判定した${total}件は、いずれも日常的な更新の範囲でした(特筆すべき変化はありませんでした)。`;
  return {
    counts,
    notableCount: notable,
    // 「今日いちばん学ぶ価値があったこと」を上位から数件だけ
    highlights: highlights.sort((a, b) => scoreOf(b.level) - scoreOf(a.level)).slice(0, 5),
    summaryJa,
  };
}

module.exports = {
  assessImportance,
  summarizeImportance,
  IMPORTANCE_LEVELS,
  CATEGORY_BASE_IMPORTANCE,
  scoreOf,
  levelOf,
};
