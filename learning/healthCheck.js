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

  // ---- 2026年8月7日の修正 ----
  //   以前はここで「エラーN件」と一括りにし、英語の文字列を3つ並べていた。
  //   その中には、延期試合を待ち行列から外した **正常な処理の記録** や、
  //   API-Footballがそもそも持っていない項目まで含まれていた。
  //   利用者から見れば全部が赤い「エラー」に見え、
  //   「バグが直っていない」と受け取られてしまう。
  //   実際に取得できなかったものだけを問題として挙げ、それ以外は分けて書く。
  const otherErrors = errors.filter((e) => typeof e === "string" && !e.includes("NO_KEY"));
  if (otherErrors.length) {
    const cls = classifyLearnErrors(otherErrors);
    if (cls.impactCount > 0) {
      const top = cls.groups.filter((g) => g.level === "impact");
      causes.push({
        code: ZERO_CAUSE.ERRORS, severity: isZero ? "error" : "warn",
        titleJa: `本日、実際に取得できなかったものが${cls.impactCount}件あります`,
        detailJa: top.map((g) => `${g.titleJa}(${g.items.length}件): ${g.effectJa} 例: ${g.items.slice(0, 3).join(" / ")}`).join(" ")
          + (cls.harmlessCount || cls.minorCount
            ? ` なお、残り${cls.harmlessCount + cls.minorCount}件は、正常な処理の記録・提供元がそもそも持っていない項目・予測に影響しない小さな取りこぼしです。`
            : ""),
      });
    } else if (cls.minorCount > 0) {
      causes.push({
        code: ZERO_CAUSE.ERRORS, severity: "warn",
        titleJa: `本日、小さな取りこぼしが${cls.minorCount}件あります`,
        detailJa: cls.groups.filter((g) => g.level === "minor")
          .map((g) => `${g.titleJa}(${g.items.length}件): ${g.effectJa} 例: ${g.items.slice(0, 3).join(" / ")}`).join(" "),
      });
    }
    // impact も minor も無い場合(正常な処理の記録・仕様上の限界だけ)は、
    // 「エラー」としては1件も挙げない。
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
  // 2026年8月・本番での誤検出の修正:
  //   「直近14日間のうち3日しか実行されていません」と警告が出たが、実際には
  //   API-Footballのアカウント作成が7/31で、それ以前はそもそも実行しようが
  //   なかっただけだった(＝故障ではない)。記録が1件も無い時期まで「動いて
  //   いない日」として数えるのは、利用者を不必要に不安にさせる誤検出になる。
  //   そこで「最初に実行記録がある日」より前は集計から除外し、運用が始まって
  //   からの期間だけで判定する(推測で埋めるのではなく、対象外として明示する)。
  const out2 = out.slice();
  let firstRanIndex = -1;
  for (let i = out2.length - 1; i >= 0; i--) {
    if (out2[i].ran) { firstRanIndex = i; break; }
  }
  for (let i = 0; i < out2.length; i++) {
    if (firstRanIndex === -1 || i > firstRanIndex) out2[i].beforeStart = true;
  }
  const trackedDays = out2.filter((d) => !d.beforeStart);
  const ranDays = out2.filter((d) => d.ran).length;
  const missingTracked = trackedDays.filter((d) => !d.ran);
  const excludedCount = out2.length - trackedDays.length;
  const excludedNote = excludedCount > 0
    ? `(このうち${excludedCount}日は運用開始前のため対象外としています)`
    : "";

  let everyDayJa;
  if (firstRanIndex === -1) {
    everyDayJa = `直近${n}日間に実行記録が1件もありません。GitHub Actionsのスケジュールが動いていない可能性があります。`;
  } else if (missingTracked.length === 0) {
    everyDayJa = `運用開始以降の${trackedDays.length}日間、毎日欠かさず実行されています${excludedNote}。`;
  } else {
    everyDayJa = `運用開始以降の${trackedDays.length}日間のうち${trackedDays.length - missingTracked.length}日で実行されています(${missingTracked.map((d) => d.date).join("・")}は実行記録がありません)${excludedNote}。実行記録が無い日は、GitHub Actionsのスケジュールが動いていなかった可能性があります。`;
  }

  return {
    available: true,
    days: out2,
    ranDays,
    totalDays: n,
    // 運用が始まってからの日数と、そのうち実行できていない日(誤検出を避けた指標)
    trackedDays: trackedDays.length,
    missingDays: missingTracked.map((d) => d.date),
    everyDayJa,
  };
}

/**
 * 9つの構成要素それぞれの状態を、実データから判定する。
 * 推測は書かず、確認できないものは正直に "unknown" とその理由を返す。
 */
function buildEngineStatuses(ctx) {
  const { growthLog, runHistory, upstashEnabled, apiKeyConfigured, llmConfigured, engineTotals, apiPlan, configuredCaps } = ctx || {};
  const log = growthLog || {};
  const totals = engineTotals || log.engineTotals || {};
  const s = [];
  const push = (id, labelJa, status, messageJa, actionJa) => s.push({ id, labelJa, status, messageJa, actionJa: actionJa || null });

  // 1. GitHub Actions / 2. cron(同じスケジュール実行の話なのでまとめて判定する)
  if (runHistory && runHistory.available) {
    // 「運用開始前」の期間は判定から除外する(2026年8月・誤検出の修正)。
    const missing = runHistory.missingDays || [];
    if (runHistory.ranDays === 0) {
      push("githubActions", "GitHub Actions / cron(毎日の起動)", "error", runHistory.everyDayJa,
        "GitHubリポジトリのActionsタブで daily-learning.yml が有効か、直近の実行が失敗していないかを確認してください。");
    } else if (missing.length === 0) {
      push("githubActions", "GitHub Actions / cron(毎日の起動)", "ok", runHistory.everyDayJa);
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
    // 第6次監査で発見した誤りの修正:
    //   UPSTASH_ENABLED は環境変数が2つ入っているかどうかだけの判定で、
    //   実際に読み書きできるかは一切確認していない。にもかかわらず
    //   「実際に読み書きできています」と断言していたため、トークンが失効している
    //   状態でも正常と表示され、しかも同じ画面が(読めないせいで生じた)
    //   「実行記録が無い」を GitHub Actions のせいだと誤って表示していた。
    //   実際に読めたかどうかで表現を変える。
    if (log && log.ranYet) {
      push("upstash", "Upstash Redis(知識の保存先)", "ok",
        "接続設定が有効で、実際に学習記録を読み出せています(この画面に表示している日次の記録がその証拠です)。");
    } else {
      push("upstash", "Upstash Redis(知識の保存先)", "unknown",
        "接続設定は入っていますが、学習記録をまだ1件も読み出せていません。設定が正しいのに読めない場合は、URL/トークンの誤りや失効の可能性があります。",
        "Renderの環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が現在有効な値か確認してください(/api/debug-status で実際の疎通を確認できます)。");
    }
  } else {
    push("upstash", "Upstash Redis(知識の保存先)", "error",
      "未設定です。保存先が無いため、学習しても何も残りません。",
      "Renderの環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定してください。");
  }

  // ---- 2026年8月・「AI予測の正答率が何日も変わらない」調査を受けて追加 ----
  //   この監視は自社予測(learn:ownpred)だけを見ており、ホーム画面に大きく出る
  //   「AI予測の正答率」(API-Football予測 = pred:* 系)は**どこからも監視されて
  //   いなかった**。そのため答え合わせが止まっていても、誰かが気づいて指摘するまで
  //   何日でも見過ごされる状態だった。同じ見落としを繰り返さないための項目。
  const pa = (ctx && ctx.predictionAccuracy) || null;
  if (!pa || pa.configured === false) {
    push("predictionAccuracy", "AI予測の正答率(答え合わせが進んでいるか)", "unknown",
      "正答率の記録を読み出せませんでした。");
  } else if (!pa.resolved) {
    push("predictionAccuracy", "AI予測の正答率(答え合わせが進んでいるか)", "unknown",
      `まだ1件も答え合わせが終わっていません(記録済み${pa.total || 0}件・答え合わせ待ち${pa.pending == null ? "不明" : pa.pending}件)。`);
  } else {
    const ageDays = pa.lastResolvedAt
      ? Math.floor((Date.now() - new Date(pa.lastResolvedAt).getTime()) / 86400000)
      : null;
    const pending = Number.isFinite(pa.pending) ? pa.pending : null;
    // 「答え合わせ待ちが溜まっているのに、何日も1件も確定していない」= 詰まっている
    const stalled = ageDays !== null && ageDays >= 3 && pending !== null && pending > 0;
    const queueBig = pending !== null && pending >= 30;
    if (stalled) {
      push("predictionAccuracy", "AI予測の正答率(答え合わせが進んでいるか)", "error",
        `答え合わせ待ちが${pending}件あるのに、最後に確定したのは${ageDays}日前です。正答率が実質的に止まっています。`,
        "予測の自動収集(predictions-auto-collect)が動いているか、保留リストの先頭に「結果が出ない試合」が溜まっていないかを /api/auto-collect-predictions の pendingLenBefore / evicted で確認してください。");
    } else if (queueBig) {
      push("predictionAccuracy", "AI予測の正答率(答え合わせが進んでいるか)", "warn",
        `答え合わせ待ちが${pending}件たまっています(最後の確定: ${ageDays === null ? "不明" : ageDays + "日前"})。`,
        "1回あたりの答え合わせ件数を上回るペースで予測が増えていないか確認してください。");
    } else {
      push("predictionAccuracy", "AI予測の正答率(答え合わせが進んでいるか)", "ok",
        `${pa.resolved}件の答え合わせが完了し、的中率${pa.accuracyPct}%として集計されています(答え合わせ待ち${pending === null ? "不明" : pending + "件"}、最後の確定: ${ageDays === null ? "不明" : ageDays + "日前"})。`);
    }
  }

  // APIキー
  push("apiFootball", "API-Football(実データの取得元)",
    apiKeyConfigured ? "ok" : "error",
    apiKeyConfigured ? "APIキーが設定されています。" : "APIキーが未設定のため、実データを一切取得できません。",
    apiKeyConfigured ? null : "Renderの環境変数 API_FOOTBALL_KEY を設定してください。");

  // 契約プラン(2026年8月・優先順位⑪)。
  // API-Footballは「自動更新されない」仕様のため、期限が切れると通知なく無料プラン
  // (1日100リクエスト)へ戻る。有料プラン向けの設定(EXTENDED_LEAGUE_CAP /
  // PLAYER_UPDATE_CAP)を入れたまま無料へ戻ると、予算不足で更新が大量に見送られる。
  // それを「原因不明の不調」ではなく「契約が切れた」とはっきり示すための判定。
  if (apiPlan && apiPlan.detectedDailyLimit) {
    const caps = configuredCaps || {};
    const configuredForPaid = (Number(caps.playerUpdateCap) || 0) > 10 || (Number(caps.extendedLeagueCap) || 0) > 2;
    if (apiPlan.detectedDailyLimit <= 100 && configuredForPaid) {
      push("apiPlan", "API-Footballの契約プラン", "error",
        `現在は${apiPlan.planNameJa}(1日${apiPlan.detectedDailyLimit}件)ですが、有料プラン向けの設定(1日${caps.playerUpdateCap || "?"}選手・拡張リーグ${caps.extendedLeagueCap || "?"}件)が入ったままです。有料プランの期限が切れて無料プランへ戻った可能性が高いです。`,
        "API-Footballは自動更新されません。ダッシュボードのProfile→My Accessで契約状況を確認し、必要なら再契約してください。再契約すれば設定はそのままで自動的に元に戻ります。");
    } else {
      push("apiPlan", "API-Footballの契約プラン", "ok",
        `${apiPlan.planNameJa}(1日${apiPlan.detectedDailyLimit}件)として自動判定しています。${apiPlan.detectedRemaining != null ? `本日の残り: ${apiPlan.detectedRemaining}件。` : ""}`,
        "API-Footballは自動更新されない仕様です。期限が切れると通知なく無料プラン(1日100件)へ戻るため、更新日をカレンダー等に控えておくことをおすすめします。");
    }
  } else {
    push("apiPlan", "API-Footballの契約プラン", "unknown",
      (apiPlan && apiPlan.noteJa) || "まだ契約プランを自動判定できていません。");
  }

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
    // 第6次監査で発見した誤りの修正:
    //   「更新すると精度が悪化すると判定した」と断言していたが、実際に
    //   重みが更新されない理由は4通りある(改善する候補が無かった/予測の記録に
    //   拡張特徴量がまだ無い/検証用に取り置けるデータが足りない/書き込みに失敗)。
    //   後ろの3つは**比較そのものを行っていない**のに、行ったうえで見送ったと
    //   報告していた。dailyJobは本当の理由を learn:weights:history に書いているので、
    //   それを読んで表示する。
    const histNote = (log && log.weightsHistoryNoteJa) || null;
    push("prediction", "Prediction Engine(予測モデル)", "ok",
      histNote
        ? `検証済み${resolvedSoFar}件。本日は重みを更新していません。理由: ${histNote}`
        : `検証済み${resolvedSoFar}件。本日は重みを更新していません(その理由は学習履歴に記録されています)。`);
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

/* ============================================================================
 * 2026年8月7日・ご指摘への対応(2度目)
 * ----------------------------------------------------------------------------
 * 画面には、こういう赤い行が出ていた:
 *   ❌ データ取得時に12件のエラーが発生しました
 *      代表的なエラー: prediction_unresolvable:1548504:PST / odds_failed:… /
 *      predict_failed:Inter Miami:API-Football HTTP 429
 *
 * ところが12件の中身は3種類がまざっていた。
 *   (1) 本当に困るもの … 429で「その日の予測が作れなかった」
 *   (2) 正常な処理     … 延期になった試合を待ち行列から外した記録
 *                        (以前の監査で、詰まりを防ぐために **わざと入れた** 処理)
 *   (3) 仕様上の限界   … API-Footballが利き足・市場価値を提供していない
 *
 * ここが「エラーの正解表」。画面(index.html)もこの結果を使うので、
 * 判定基準が2か所に分かれてズレることがない。
 * ========================================================================== */
const LEARN_ERROR_RULES = [
  {
    id: "rateLimited",
    test: /HTTP 429|RATE_LIMITED|1分あたりの上限/,
    level: "impact",
    titleJa: "データ提供元の1分あたりの上限に当たり、取得できなかったものがあります",
    meaningJa: "API-Footballには1分あたりの回数制限があります。ここに当たったぶんは、その日のうちに取得できていません。",
    effectJa: "その試合・そのクラブの分析が、当日は最新になりません(翌日の学習で自動的に取り直します)。",
  },
  {
    id: "predictFailed",
    test: /^predict_failed/,
    level: "impact",
    titleJa: "新しい予測を作れなかったクラブがあります",
    meaningJa: "予測に必要なデータを取得できなかったクラブです。",
    effectJa: "そのクラブについて、その日の新しい予測は作られていません。",
  },
  {
    id: "budget",
    test: /BUDGET_EXHAUSTED|予算/,
    level: "impact",
    titleJa: "1日のAPI予算を使い切ったため、見送った処理があります",
    meaningJa: "契約プランの1日あたりの上限に達しました。",
    effectJa: "見送ったぶんは、翌日の学習で取り直します。",
  },
  {
    id: "unresolvable",
    test: /^prediction_unresolvable:.*:(PST|CANC|ABD|AWD|WO)$/,
    level: "normal",
    titleJa: "延期・中止になった試合を、答え合わせの待ち行列から外しました",
    meaningJa: "結果が出ない試合なので、いつまでも待たないように取り除いた記録です。",
    effectJa: "正常な処理です。利用者への影響はありません。",
  },
  {
    id: "fixtureGone",
    test: /^prediction_fixture_(missing|not_found)/,
    level: "normal",
    titleJa: "提供元から消えた試合を、答え合わせの対象から外しました",
    meaningJa: "試合IDが振り直された・シーズン移行で消えた等で、確認しても見つからない試合です。",
    effectJa: "正常な処理です。利用者への影響はありません。",
  },
  {
    id: "notProvided",
    test: /存在しないため|提供していないため|提供されていません/,
    level: "spec",
    titleJa: "データ提供元がそもそも持っていない項目です",
    meaningJa: "API-Footballが提供していない項目(利き足・市場価値・年俸など)です。",
    effectJa: "取得できないものとして、画面でも「取得できません」と明記しています。",
  },
  {
    id: "odds",
    test: /^odds_failed/,
    level: "minor",
    titleJa: "オッズを取得できなかった試合があります",
    meaningJa: "その試合にオッズが提供されていないか、取得が一時的に失敗しました。",
    effectJa: "市場との比較(ROI)の集計から、その試合だけが外れます。予測そのものには影響しません。",
  },
  {
    id: "playerNotFound",
    test: /に一致する選手が見つかりませんでした/,
    level: "minor",
    titleJa: "提供元で見つからなかった選手がいます",
    meaningJa: "表記ゆれ等で、API-Football側の選手と結びつけられなかったものです。",
    effectJa: "その選手の成績だけが更新されません。他の選手には影響しません。",
  },
  // ---- v50で追加: 市場ブレンド学習の失敗(外部取得と無関係・翌日再挑戦) ----
  {
    id: "marketBlendFit",
    test: /^market_blend_fit_failed/,
    level: "minor",
    titleJa: "市場ブレンド比率の学習を今回は実施できませんでした",
    meaningJa: "最終確率にオッズを混ぜる比率(w)の見直し計算に失敗しました。外部データの取得とは無関係です。",
    effectJa: "前回学習済みの比率(または0=純自前)のまま予測を続けます。次の学習で自動的に再挑戦します。",
  },
  // ---- v49(第9次監査)で追加: 週間ダイジェストの生成失敗 ----
  //   これを入れないと下の受け皿(fetchFailed)に飲み込まれ、「提供元からの
  //   取得が失敗」という事実と異なる説明で「影響あり」扱いになっていた。
  //   ダイジェストは外部から何も取得しない(保存済み記録の読み書きのみ)。
  {
    id: "weeklyDigest",
    test: /^weekly_digest_(failed|save_failed)/,
    level: "minor",
    titleJa: "週間ダイジェストを今回は作れませんでした",
    meaningJa: "AIの1週間まとめ記事(保存済み記録から週1回生成)の生成または保存に失敗しました。外部データの取得とは無関係です。",
    effectJa: "記事の公開が次の学習まで延びるだけです。予測・学習・的中率には一切影響しません(次の学習で自動的に再挑戦します)。",
  },
  // ---- ここから下は「具体的な規則に当てはまらなかった取得失敗」の受け皿 ----
  //   個別の規則より後ろに置くこと(先に置くと odds_failed 等を飲み込んでしまう)。
  {
    id: "fetchFailed",
    test: /_failed:|HTTP_ERROR|取得に失敗/,
    level: "impact",
    titleJa: "取得に失敗したものがあります",
    meaningJa: "提供元からの取得が失敗しました(一時的な不調・シーズンオフでデータが空、などでも起こります)。",
    effectJa: "その項目だけが、その日は最新になりません(翌日の学習で取り直します)。",
  },
];

/**
 * 学習の記録(errors配列)を、利用者にとっての意味で分類する。
 * level: impact(実際に取得できなかった) / minor(小さな取りこぼし)
 *      / normal(正常な処理の記録)      / spec(そもそも取得できない項目)
 */
function classifyLearnErrors(list) {
  const groups = new Map();
  (list || []).forEach((raw) => {
    const text = String(raw);
    const rule = LEARN_ERROR_RULES.find((r) => r.test.test(text));
    const key = rule ? rule.id : "unknown";
    if (!groups.has(key)) {
      groups.set(key, rule
        ? { id: rule.id, level: rule.level, titleJa: rule.titleJa, meaningJa: rule.meaningJa, effectJa: rule.effectJa, items: [] }
        : {
          id: "unknown", level: "minor", titleJa: "分類できなかった記録",
          meaningJa: "想定していない種類の記録です。", effectJa: "内容を確認する必要があります。", items: [],
        });
    }
    groups.get(key).items.push(text);
  });
  const order = { impact: 0, minor: 1, normal: 2, spec: 3 };
  const arr = [...groups.values()].sort((a, b) => order[a.level] - order[b.level]);
  const countBy = (lv) => arr.filter((g) => g.level === lv).reduce((n, g) => n + g.items.length, 0);
  const impactCount = countBy("impact");
  const minorCount = countBy("minor");
  const harmlessCount = countBy("normal") + countBy("spec");
  return {
    groups: arr,
    total: (list || []).length,
    impactCount, minorCount, harmlessCount,
    // 画面の見出しに使う一文(ここで作っておけば表現が2か所でズレない)
    headlineJa: (list || []).length === 0
      ? null
      : impactCount > 0
        ? `本日、実際に取得できなかったものが${impactCount}件あります。`
          + (minorCount ? `小さな取りこぼしが${minorCount}件、` : "")
          + (harmlessCount ? `正常な処理の記録などが${harmlessCount}件です。` : (minorCount ? "" : ""))
        : minorCount > 0
          ? `本日、小さな取りこぼしが${minorCount}件あります(予測そのものには影響しません)。`
            + (harmlessCount ? `残りの${harmlessCount}件は正常な処理の記録です。` : "")
          : `記録が${(list || []).length}件ありますが、いずれも正常な処理の記録か、提供元がそもそも持っていない項目です(利用者への影響はありません)。`,
  };
}

module.exports = {
  diagnoseZeroKnowledge, diagnoseZeroVerification, getRunHistory, buildEngineStatuses, ZERO_CAUSE,
  classifyLearnErrors, LEARN_ERROR_RULES,
};
