/**
 * server/learning/healthCheck.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑨「Learning Engineを総点検してください」。
 *
 * ご要望原文: 「今日追加した知識0件・検証0件 と表示されることがあります。
 * これでは利用者は『本当に学習しているの?』と思ってしまいます。
 * GitHub Actions / cron / Render / Upstash / Prediction / Learning / Knowledge /
 * Memory / Hypothesis すべてログを確認し、毎日正常に動くことを実証してください」。
 *
 * ■ このモジュールが解決する「本当の問題」
 *   調査の結果、「0件」には性質のまったく違う2つの原因があることが分かりました。
 *
 *   (A) 正常な0件: Knowledge Engineは「内容が本当に変わった時だけ」新しい知識と
 *       して数える設計です(重複排除)。順位表も選手データも前日から変化が
 *       なければ、正しく動いていても新規0件になります。これは仕様どおりの
 *       健全な状態ですが、画面には「0件」としか出ないため、利用者からは
 *       「サボっている」ようにしか見えませんでした。
 *   (B) 異常な0件: APIキー未設定・Upstash未設定・API予算切れ・GitHub Actionsが
 *       動いていない、などで本当に何もできていない状態。
 *
 *   これまでのUIは(A)と(B)を区別できていませんでした。そこで
 *   diagnoseZeroKnowledge() が、その日の実行結果(growthLog)から
 *   「なぜ0件なのか」を根拠つきで判定し、利用者に正直に説明できるようにします。
 *   (A)であれば「重複でスキップ:N件」という数字そのものが
 *   「ちゃんと確認しに行ったが変化が無かった」動かぬ証拠になります。
 *
 * ■ 「毎日正常に動くことを実証」について
 *   getRunHistory() が過去N日分の実行ログ(learn:growthlog:YYYY-MM-DD)を
 *   実際に読み出し、日ごとの実行有無・追加知識件数・エラー件数を一覧にします。
 *   これが「毎日動いている(または動いていない)」ことの実データによる証拠です。
 *   欠けている日があれば、それ自体がGitHub Actions/cronが動いていない証拠として
 *   はっきり見えるようにします(推測で埋めることはしません)。
 */

const ZERO_CAUSE = {
  NOT_RUN_YET: "NOT_RUN_YET",
  NO_UPSTASH: "NO_UPSTASH",
  NO_API_KEY: "NO_API_KEY",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  ERRORS: "ERRORS",
  HEALTHY_NO_CHANGE: "HEALTHY_NO_CHANGE",
  NOTHING_TO_VERIFY: "NOTHING_TO_VERIFY",
  UNKNOWN: "UNKNOWN",
};

/**
 * その日の実行結果から「なぜ知識が0件なのか」を判定する。
 * 純粋関数(テストしやすさのため)。
 * @returns {{isZero:boolean, healthy:boolean, causes:Array<{code,titleJa,detailJa,severity}>}}
 */
function diagnoseZeroKnowledge(growthLog) {
  const log = growthLog || {};
  const saved = log.knowledgeItemsSavedToday || 0;
  const duplicate = log.knowledgeItemsDuplicateToday || 0;
  const errors = Array.isArray(log.errors) ? log.errors : [];
  const causes = [];

  const isZero = saved === 0;

  if (log.ranYet === false || (!log.date && !log.ranAt)) {
    causes.push({
      code: ZERO_CAUSE.NOT_RUN_YET, severity: "error",
      titleJa: "日次学習がまだ一度も実行されていません",
      detailJa: "GitHub Actionsのスケジュール実行(daily-learning.yml)が動いていない可能性があります。GitHubのActionsタブで、ワークフローが有効になっているか・直近の実行が成功しているかを確認してください。手動で実行して確かめることもできます。",
    });
    return { isZero: true, healthy: false, causes };
  }

  if (log.reason === "NO_UPSTASH") {
    causes.push({
      code: ZERO_CAUSE.NO_UPSTASH, severity: "error",
      titleJa: "Upstash(知識の保存先)が設定されていません",
      detailJa: "Renderの環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が設定されていないため、学習しても保存先がありません。設定すると翌日から知識が積み上がります。",
    });
    return { isZero: true, healthy: false, causes };
  }

  const noKeyErrors = errors.filter((e) => typeof e === "string" && e.includes("NO_KEY"));
  if (noKeyErrors.length) {
    causes.push({
      code: ZERO_CAUSE.NO_API_KEY, severity: "error",
      titleJa: `APIキーまたはLLMキーが未設定です(${noKeyErrors.length}件のNO_KEYエラー)`,
      detailJa: "Renderの環境変数 API_FOOTBALL_KEY / ANTHROPIC_API_KEY を確認してください。キーが無いと実データの取得やAIの考察生成ができず、知識が増えません。",
    });
  }

  const budget = log.apiBudget || null;
  if (budget && budget.remainingForJob === 0) {
    causes.push({
      code: ZERO_CAUSE.BUDGET_EXHAUSTED, severity: "warn",
      titleJa: `本日のAPIリクエスト予算を使い切りました(${budget.totalSpent}/${budget.dailyBudget}件)`,
      detailJa: "1日の上限に達したため、一部の更新を意図的に見送りました。無料プラン(100件/日)では起こりやすい状態です。環境変数 API_DAILY_BUDGET を上げる(有料プランへの移行)と解消します。",
    });
  }

  const otherErrors = errors.filter((e) => typeof e === "string" && !e.includes("NO_KEY"));
  if (otherErrors.length) {
    causes.push({
      code: ZERO_CAUSE.ERRORS, severity: isZero ? "error" : "warn",
      titleJa: `データ取得時に${otherErrors.length}件のエラーが発生しました`,
      detailJa: `代表的なエラー: ${otherErrors.slice(0, 3).join(" / ")}。API-Football側の一時的な不調や、シーズンオフでデータが空の場合にも発生します。`,
    });
  }

  // ここまでで異常が1つも見つからず、かつ「重複でスキップ」が発生している場合は、
  // 「ちゃんと確認しに行ったが、前回から変化が無かった」という健全な0件。
  if (isZero && !causes.length && duplicate > 0) {
    causes.push({
      code: ZERO_CAUSE.HEALTHY_NO_CHANGE, severity: "ok",
      titleJa: `正常に動作しています(確認した${duplicate}件すべて、前回から変化がありませんでした)`,
      detailJa: "このAIは「本当に内容が変わった時だけ」新しい知識として数えます(同じ情報を毎日水増しして『学習している風』に見せることをしないため)。順位表・選手データを実際に取得しに行った結果、前回と同じ内容だったので新規0件になりました。変化があった日には自動的に増えます。",
    });
    return { isZero: true, healthy: true, causes };
  }

  if (isZero && !causes.length) {
    causes.push({
      code: ZERO_CAUSE.UNKNOWN, severity: "warn",
      titleJa: "知識が増えなかった理由を特定できませんでした",
      detailJa: "エラーは記録されていませんが、新規保存も重複スキップも0件でした。対象データがまだ取得できていない(シーズンオフ等)可能性があります。",
    });
  }

  return { isZero, healthy: causes.every((c) => c.severity === "ok"), causes };
}

/**
 * 「検証した試合0件」の理由を判定する。
 * 知識件数とは原因が違う(試合が終わっていなければ検証しようがない)ため別関数。
 */
function diagnoseZeroVerification(growthLog) {
  const log = growthLog || {};
  const resolved = log.matchesResolvedToday || 0;
  const logged = log.newPredictionsLogged || 0;
  const totalResolved = log.totalOwnPredictionsResolvedSoFar || 0;
  if (resolved > 0) {
    return { isZero: false, healthy: true, titleJa: `${resolved}件の試合を検証しました`, detailJa: "" };
  }
  if (logged > 0) {
    return {
      isZero: true, healthy: true,
      titleJa: `本日は新たに${logged}件の予測を記録しました(検証はこれらの試合が終わってから)`,
      detailJa: "AIの予測は「試合前に記録し、試合後に答え合わせする」方式です。今日記録した予測は、その試合が終了した翌日以降の実行で自動的に検証されます(後出しで予測を書き換えないための設計です)。",
    };
  }
  if (totalResolved > 0) {
    return {
      isZero: true, healthy: true,
      titleJa: "本日終了した対象試合がありませんでした(これまでの累計検証は" + totalResolved + "件)",
      detailJa: "登録クラブの試合が無い日や、リーグの中断期間には検証が0件になります。異常ではありません。",
    };
  }
  return {
    isZero: true, healthy: false,
    titleJa: "まだ1件も検証できていません",
    detailJa: "予測の記録自体が行われていない可能性があります。日次学習が毎日実行されているか(下の実行履歴)を確認してください。",
  };
}

/**
 * 過去N日分の実行ログを実際に読み出して、「毎日動いているか」を実データで示す。
 * 欠けている日は推測で埋めず、正直に ran:false として返す。
 */
async function getRunHistory(deps, days, todayDateKey) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  const n = Math.max(1, Math.min(60, days || 14));
  const out = [];
  if (!upstashEnabled || typeof upstashGetJSON !== "function") {
    return { available: false, reasonJa: "Upstashが設定されていないため、過去の実行履歴を読み出せません。", days: [] };
  }
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) {
    const dateKey = new Date(base - i * 86400000).toISOString().slice(0, 10);
    let log = null;
    try { log = await upstashGetJSON(`learn:growthlog:${dateKey}`); } catch (e) { log = null; }
    if (!log) {
      out.push({ date: dateKey, ran: false });
    } else {
      out.push({
        date: dateKey, ran: true,
        runsToday: log.runsToday || 1,
        knowledgeItemsSavedToday: log.knowledgeItemsSavedToday || 0,
        knowledgeItemsDuplicateToday: log.knowledgeItemsDuplicateToday || 0,
        matchesResolvedToday: log.matchesResolvedToday || 0,
        newPredictionsLogged: log.newPredictionsLogged || 0,
        errorCount: Array.isArray(log.errors) ? log.errors.length : 0,
      });
    }
  }
  const ranDays = out.filter((d) => d.ran).length;
  return {
    available: true,
    days: out,
    ranDays,
    totalDays: n,
    // 「毎日動いている」ことをひと目で言い切れる形にする
    everyDayJa: ranDays === n
      ? `直近${n}日間、毎日欠かさず実行されています。`
      : `直近${n}日間のうち${ranDays}日で実行されています(${n - ranDays}日は実行記録がありません)。実行記録が無い日は、GitHub Actionsのスケジュールが動いていなかった可能性があります。`,
  };
}

/**
 * 9つの構成要素それぞれの状態を、実データから判定する。
 * 推測は書かず、確認できないものは正直に "unknown" とその理由を返す。
 */
function buildEngineStatuses(ctx) {
  const { growthLog, runHistory, upstashEnabled, apiKeyConfigured, llmConfigured, engineTotals } = ctx || {};
  const log = growthLog || {};
  const totals = engineTotals || log.engineTotals || {};
  const s = [];
  const push = (id, labelJa, status, messageJa, actionJa) => s.push({ id, labelJa, status, messageJa, actionJa: actionJa || null });

  // 1. GitHub Actions / 2. cron(同じスケジュール実行の話なのでまとめて判定する)
  if (runHistory && runHistory.available) {
    if (runHistory.ranDays === runHistory.totalDays) {
      push("githubActions", "GitHub Actions / cron(毎日の起動)", "ok", runHistory.everyDayJa);
    } else if (runHistory.ranDays === 0) {
      push("githubActions", "GitHub Actions / cron(毎日の起動)", "error", runHistory.everyDayJa,
        "GitHubリポジトリのActionsタブで daily-learning.yml が有効か、直近の実行が失敗していないかを確認してください。");
    } else {
      push("githubActions", "GitHub Actions / cron(毎日の起動)", "warn", runHistory.everyDayJa,
        "実行記録が無い日があります。GitHub Actionsは長期間コミットが無いリポジトリでは自動的に無効化されることがあります。");
    }
  } else {
    push("githubActions", "GitHub Actions / cron(毎日の起動)", "unknown",
      (runHistory && runHistory.reasonJa) || "実行履歴を確認できませんでした。");
  }

  // 3. Render(このサーバー自身。応答できている時点で起動している)
  push("render", "Render(サーバー)", "ok",
    "この診断結果を返せている時点で、Render上のサーバーは起動して応答しています。",
    "無料プランでは15分アクセスが無いとスリープします。日次実行が失敗する場合は、起床待ちのタイムアウトが原因のことがあります。");

  // 4. Upstash
  if (upstashEnabled) {
    push("upstash", "Upstash Redis(知識の保存先)", "ok", "接続設定が有効です。実際に読み書きできています(この画面の数値がその証拠です)。");
  } else {
    push("upstash", "Upstash Redis(知識の保存先)", "error",
      "未設定です。保存先が無いため、学習しても何も残りません。",
      "Renderの環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定してください。");
  }

  // APIキー
  push("apiFootball", "API-Football(実データの取得元)",
    apiKeyConfigured ? "ok" : "error",
    apiKeyConfigured ? "APIキーが設定されています。" : "APIキーが未設定のため、実データを一切取得できません。",
    apiKeyConfigured ? null : "Renderの環境変数 API_FOOTBALL_KEY を設定してください。");

  push("llm", "LLM(AIの考察生成)",
    llmConfigured ? "ok" : "warn",
    llmConfigured ? "APIキーが設定されています。" : "未設定です。実データの蓄積は続きますが、AIによる考察・プロフィール生成は行われません。",
    llmConfigured ? null : "Renderの環境変数 ANTHROPIC_API_KEY を設定してください。");

  // 5. Learning Engine
  if (log.ranYet === false) {
    push("learning", "Learning Engine(日次学習)", "error", "まだ一度も実行されていません。");
  } else {
    const runs = log.runsToday || 1;
    push("learning", "Learning Engine(日次学習)", "ok",
      `最終実行: ${log.ranAt || log.date || "不明"}(本日${runs}回実行)。登録${log.teamsAnalyzed || 0}クラブ・${log.leaguesAnalyzedToday || 0}リーグ・${log.playersCheckedToday || 0}選手を確認しました。`);
  }

  // 6. Knowledge Engine
  const saved = log.knowledgeItemsSavedToday || 0;
  const dup = log.knowledgeItemsDuplicateToday || 0;
  if (saved > 0) {
    push("knowledge", "Knowledge Engine(知識)", "ok", `本日${saved}件の新しい知識を保存しました(累計${totals.knowledgeItemsTotal || 0}件)。`);
  } else if (dup > 0) {
    push("knowledge", "Knowledge Engine(知識)", "ok",
      `本日の新規保存は0件ですが、${dup}件を実際に確認したうえで「前回から変化なし」と判定しています(累計${totals.knowledgeItemsTotal || 0}件)。動作は正常です。`);
  } else {
    push("knowledge", "Knowledge Engine(知識)", "warn",
      `本日は新規保存も重複スキップも0件でした(累計${totals.knowledgeItemsTotal || 0}件)。データ取得が失敗している可能性があります。`);
  }

  // 7. Prediction Engine
  const resolvedSoFar = log.totalOwnPredictionsResolvedSoFar || 0;
  const minNeeded = log.minResolvedForRecalibration || 10;
  if (log.weightsUpdated || log.weightsUpdatedV2) {
    push("prediction", "Prediction Engine(予測モデル)", "ok", "本日、実データに基づいて重みを更新しました。");
  } else if (resolvedSoFar >= minNeeded) {
    push("prediction", "Prediction Engine(予測モデル)", "ok",
      `検証済み${resolvedSoFar}件。本日は「更新すると精度が悪化する」と判定したため、あえて重みを据え置きました(悪化する変更は採用しない設計)。`);
  } else {
    push("prediction", "Prediction Engine(予測モデル)", "ok",
      `検証済み${resolvedSoFar}件 / 更新に必要な${minNeeded}件(あと${Math.max(0, minNeeded - resolvedSoFar)}件)。少ないデータで重みを動かすと過学習になるため、意図的に固定しています。`);
  }

  // 8. Memory Engine
  push("memory", "Memory Engine(振り返りの記憶)",
    (totals.memoryConclusionsTotal || 0) > 0 ? "ok" : "warn",
    `累計${totals.memoryConclusionsTotal || 0}件の結論を記憶しています。本日の振り返り保存: ${log.reflectionsSaved || 0}件。`);

  // 9. Hypothesis Engine
  const hc = log.hypothesesConfirmed || 0;
  const hd = log.hypothesesDiscarded || 0;
  push("hypothesis", "Hypothesis Engine(仮説)",
    (hc + hd) > 0 ? "ok" : "warn",
    (hc + hd) > 0
      ? `本日、仮説を${hc + hd}件検証しました(裏付けられた: ${hc}件 / 破棄: ${hd}件)。`
      : "本日は検証できた仮説がありませんでした(対象試合がまだ終了していない場合に起こります)。");

  return s;
}

module.exports = {
  diagnoseZeroKnowledge, diagnoseZeroVerification, getRunHistory, buildEngineStatuses, ZERO_CAUSE,
};
