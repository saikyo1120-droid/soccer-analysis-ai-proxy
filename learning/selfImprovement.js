/**
 * server/learning/selfImprovement.js
 * ------------------------------------------------
 * 2026年8月・自己改善ループラウンド。
 * 「毎日データを集めるAI」ではなく「毎日自分で成長方法を考え、改善していくAI」の中核:
 *   ① 自己診断(リーグ別精度・効いていない特徴量・データ欠損・API失敗箇所)
 *   ② 改善提案(取得頻度の上げ/下げ・新たに学習すべき対象)
 *   ③ 安全な範囲での自動実行(調整可能な「ノブ」+上下限+1日2変更まで)
 *   ④ 効果測定(改善前→改善後の数値比較。悪化したら自動で差し戻し)
 *   ⑤ 自己改善履歴(全イベントを保存し、利用者が「この1か月の改善」を見られる)
 *
 * ■ 安全設計(暴走防止)
 *   ・AIが変更できるのは下のTUNABLE_KNOBSに列挙された値だけ。それぞれに
 *     ハードコードされた上下限と1回の変更幅があり、コードの外に出られない。
 *   ・1日に実行する変更は最大2件。同じノブに評価待ちの変更がある間は再変更しない。
 *   ・すべての変更は「何を根拠に・何を期待して」と一緒に履歴へ記録され、
 *     数日後に宣言済みの指標で効果測定される。悪化していれば自動で元に戻す。
 *   ・診断・提案・判定はすべて機械的なルール(LLMには決めさせない)。
 * ■ でっち上げ防止
 *   ・診断は保存済みの実測だけから行い、材料が無い項目は「判定不能」と正直に返す。
 *   ・効果測定に必要な実測が無い日は「評価保留」として持ち越す(勝手に成功と
 *     みなさない)。3回持ち越したら「効果を確認できないまま維持」と記録する。
 */

const TUNE_CONFIG_KEY = "learn:selftune:config";
const HISTORY_KEY = "learn:selfimprove:log";
const HISTORY_MAX = 200;
const MAX_CHANGES_PER_DAY = 2;
const EVAL_AFTER_DAYS = 3;
const MAX_EVAL_ATTEMPTS = 3;

// AIが自分で調整してよい値の全一覧(これ以外は変更できない)
const TUNABLE_KNOBS = {
  xgRotationDays: { labelJa: "xG収集の周期(日)", def: 7, min: 3, max: 14, step: 2 },
  playerDetailCap: { labelJa: "選手詳細の1日あたり取得上限(人)", def: 300, min: 150, max: 400, step: 50 },
  priorityClubsMax: { labelJa: "学習計画の優先クラブ数(上限)", def: 5, min: 3, max: 10, step: 1 },
};

function clampKnob(name, value) {
  const k = TUNABLE_KNOBS[name];
  if (!k) return null;
  const v = Number.isFinite(value) ? value : k.def;
  return Math.max(k.min, Math.min(k.max, v));
}

function defaultTuneConfig() {
  const cfg = { pendingEvaluations: [] };
  for (const [name, k] of Object.entries(TUNABLE_KNOBS)) cfg[name] = k.def;
  return cfg;
}

async function loadTuneConfig(deps) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  const cfg = defaultTuneConfig();
  if (!upstashEnabled) return cfg;
  try {
    const stored = await upstashGetJSON(TUNE_CONFIG_KEY);
    if (stored && typeof stored === "object") {
      for (const name of Object.keys(TUNABLE_KNOBS)) {
        if (Number.isFinite(stored[name])) cfg[name] = clampKnob(name, stored[name]);
      }
      if (Array.isArray(stored.pendingEvaluations)) cfg.pendingEvaluations = stored.pendingEvaluations;
    }
  } catch (e) { /* 読めなければ既定値(安全側) */ }
  return cfg;
}

async function saveTuneConfig(deps, cfg) {
  const { upstashEnabled, upstashSetJSON } = deps || {};
  if (!upstashEnabled || !cfg) return false;
  try { await upstashSetJSON(TUNE_CONFIG_KEY, cfg); return true; } catch (e) { return false; }
}

async function appendHistory(deps, events) {
  const { upstashEnabled, upstashCmd } = deps || {};
  if (!upstashEnabled || !events || !events.length) return 0;
  let appended = 0;
  for (const ev of events) {
    try {
      await upstashCmd(["RPUSH", HISTORY_KEY, JSON.stringify(ev)]);
      appended++;
    } catch (e) { /* 1件の失敗で止めない */ }
  }
  await upstashCmd(["LTRIM", HISTORY_KEY, String(-HISTORY_MAX), "-1"]).catch(() => {});
  return appended;
}

// ---------------------------------------------------------------
// ① 自己診断(すべて保存済みの実測から。材料が無ければ「判定不能」)
// ---------------------------------------------------------------

const TRUST_PART_KEYS = ["form", "injuries", "standings", "xg"];
const TRUST_PART_JA = { form: "フォーム", injuries: "怪我情報", standings: "順位・勝点", xg: "xG(期待得点)" };

function buildSelfDiagnosis(input) {
  const { recentRecords, featureEffectiveness, apiCallStats, errors, accuracyTrend } = input || {};
  const resolved = (recentRecords || []).filter((r) => r && r.resolved && r.actualWinner);

  // (a) リーグ別の精度(リーグ情報を持つ新形式の記録のみ。n≥3で表示・n<3は集計外)
  const byLeague = new Map();
  for (const r of resolved) {
    if (!r.league) continue;
    const cur = byLeague.get(r.league) || { n: 0, hits: 0, drawActual: 0, drawPredicted: 0, drawHit: 0 };
    cur.n++;
    if (r.correct) cur.hits++;
    // v78(案4): 引き分けの実際の頻度・予想頻度・的中数もリーグ別に実測する
    // (引き分け帯の学習=案1の効果と弱点をリーグ単位で追えるようにするため)
    if (r.actualWinner === "draw") cur.drawActual++;
    if (r.predictedWinner === "draw") {
      cur.drawPredicted++;
      if (r.actualWinner === "draw") cur.drawHit++;
    }
    byLeague.set(r.league, cur);
  }
  const overallN = resolved.length;
  const overallHitPct = overallN ? round1((resolved.filter((r) => r.correct).length / overallN) * 100) : null;
  const leagueAccuracy = Array.from(byLeague.entries())
    .filter(([, v]) => v.n >= 3)
    .map(([league, v]) => ({ league, n: v.n, hitRatePct: round1((v.hits / v.n) * 100) }))
    .sort((a, b) => a.hitRatePct - b.hitRatePct);
  // v78(案4): リーグ別の常設実測表(件数の多い順・n≥3のみ。少数サンプルの%は
  // 実力を表さないため載せない=的中率カードと同じ方針)
  const leagueTable = Array.from(byLeague.entries())
    .filter(([, v]) => v.n >= 3)
    .map(([league, v]) => ({
      league, n: v.n,
      hitRatePct: round1((v.hits / v.n) * 100),
      drawActualPct: round1((v.drawActual / v.n) * 100),
      drawPredictedPct: round1((v.drawPredicted / v.n) * 100),
      drawHitN: v.drawHit,
    }))
    .sort((a, b) => b.n - a.n);

  // (b) データ欠損率(予測時に両側の実値が揃っていた特徴の記録割合から)
  const withTrust = resolved.filter((r) => r.featureTrust && Array.isArray(r.featureTrust.parts));
  const dataGaps = [];
  if (withTrust.length >= 3) {
    for (const key of TRUST_PART_KEYS) {
      const present = withTrust.filter((r) => r.featureTrust.parts.some((p) => p && p.key === key)).length;
      dataGaps.push({ key, labelJa: TRUST_PART_JA[key], missingRatePct: round1(((withTrust.length - present) / withTrust.length) * 100) });
    }
    dataGaps.sort((a, b) => b.missingRatePct - a.missingRatePct);
  }

  // (c) 効いていない特徴量(毎日のablation実測から。既存機構が自動で0化候補にする)
  const ineffectiveFeatures = (featureEffectiveness && featureEffectiveness.measurable)
    ? (featureEffectiveness.features || [])
      .filter((f) => f.contribution !== null && f.contribution < -0.002)
      .map((f) => ({ labelJa: f.labelJa, contribution: f.contribution }))
    : [];

  // (d) API失敗の発生箇所(常時計測カウンタ+当日のエラー分類)
  const errorPrefixCounts = {};
  for (const e of errors || []) {
    const prefix = String(e).split(":")[0];
    errorPrefixCounts[prefix] = (errorPrefixCounts[prefix] || 0) + 1;
  }
  const apiFailures = {
    successRatePct: apiCallStats && Number.isFinite(apiCallStats.successRatePct) ? apiCallStats.successRatePct : null,
    failuresByCode: (apiCallStats && apiCallStats.failuresByCode) || {},
    topErrorPrefixes: Object.entries(errorPrefixCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([prefix, count]) => ({ prefix, count })),
  };

  const acc7 = accuracyTrend && accuracyTrend.last7Days && accuracyTrend.last7Days.markets && accuracyTrend.last7Days.markets.oneX2;
  return {
    generatedFromN: overallN,
    overallHitPct,
    hit7dPct: (acc7 && acc7.measurable) ? acc7.hitRatePct : null,
    leagueAccuracy,
    leagueAccuracyNoteJa: leagueAccuracy.length ? null
      : (overallN ? "リーグ情報つきの答え合わせ済み予測がまだ3件未満のため、リーグ別の精度は判定不能です(新しい予測記録から自動で貯まります)。" : "答え合わせ済みの予測がまだ無いため、リーグ別の精度は判定不能です。"),
    // v78(案4): リーグ別の常設実測表(的中率+引き分けの実際/予想/的中)
    leagueTable,
    leagueTableNoteJa: `直近の答え合わせ済み${overallN}件からの実測(3件以上のリーグのみ・件数の多い順)。「引分実際」はそのリーグで実際に引き分けだった割合、「引分予想」はAIが引き分けと予想した割合です。`,
    dataGaps,
    dataGapsNoteJa: dataGaps.length ? null : "信頼度つきの予測記録がまだ3件未満のため、データ欠損率は判定不能です。",
    ineffectiveFeatures,
    apiFailures,
  };
}

// ---------------------------------------------------------------
// ② 改善提案 → ③ 安全な実行(機械的ルール)
// ---------------------------------------------------------------

function buildImprovementProposals(diagnosis, config, context) {
  const proposals = [];
  const budgetUsagePct = context && Number.isFinite(context.budgetUsagePct) ? context.budgetUsagePct : null;
  const gapOf = (key) => {
    const g = (diagnosis.dataGaps || []).find((x) => x.key === key);
    return g ? g.missingRatePct : null;
  };

  // ルール1: xG欠損が多い → xG収集の周期を短く(頻度を上げる)
  const xgGap = gapOf("xg");
  if (xgGap !== null && xgGap >= 40 && config.xgRotationDays > TUNABLE_KNOBS.xgRotationDays.min) {
    proposals.push({
      kind: "frequency_up", targetJa: "xG収集の頻度",
      proposalJa: `予測時にxGが揃っていない割合が${xgGap}%と高いため、xG収集の周期を${config.xgRotationDays}日→${clampKnob("xgRotationDays", config.xgRotationDays - TUNABLE_KNOBS.xgRotationDays.step)}日に短縮します(取得頻度を上げる)。`,
      action: { knob: "xgRotationDays", to: clampKnob("xgRotationDays", config.xgRotationDays - TUNABLE_KNOBS.xgRotationDays.step) },
      expect: { metricName: "xgMissingRatePct", direction: "lower", tolerancePt: 2 },
    });
  }
  // ルール2: xGが十分揃っていて予算が逼迫 → 周期を長く(無駄を削る)
  if (xgGap !== null && xgGap <= 10 && budgetUsagePct !== null && budgetUsagePct >= 85 && config.xgRotationDays < TUNABLE_KNOBS.xgRotationDays.max) {
    proposals.push({
      kind: "frequency_down", targetJa: "xG収集の頻度",
      proposalJa: `xGの欠損は${xgGap}%と少なく、API予算の使用率が${budgetUsagePct}%と高いため、xG収集の周期を${config.xgRotationDays}日→${clampKnob("xgRotationDays", config.xgRotationDays + TUNABLE_KNOBS.xgRotationDays.step)}日に延ばします(精度を保ったまま無駄だけを削る)。`,
      action: { knob: "xgRotationDays", to: clampKnob("xgRotationDays", config.xgRotationDays + TUNABLE_KNOBS.xgRotationDays.step) },
      expect: { metricName: "budgetUsagePct", direction: "lower", tolerancePt: 2 },
    });
  }
  // ルール3: 予算に余裕 → 選手詳細の学習量を増やす(新たに学習する情報を増やす)
  if (budgetUsagePct !== null && budgetUsagePct <= 50 && config.playerDetailCap < TUNABLE_KNOBS.playerDetailCap.max) {
    proposals.push({
      kind: "learn_more", targetJa: "選手詳細の学習量",
      proposalJa: `API予算の使用率が${budgetUsagePct}%と余裕があるため、選手詳細の1日あたり取得上限を${config.playerDetailCap}人→${clampKnob("playerDetailCap", config.playerDetailCap + TUNABLE_KNOBS.playerDetailCap.step)}人に増やします(同じ予算でより多く学ぶ)。`,
      action: { knob: "playerDetailCap", to: clampKnob("playerDetailCap", config.playerDetailCap + TUNABLE_KNOBS.playerDetailCap.step) },
      expect: { metricName: "playersUpdatedToday", direction: "higher", tolerancePt: 0 },
    });
  }
  // ルール4: 予算が逼迫 → 選手詳細を絞って中核(コア更新・予測)を守る
  if (budgetUsagePct !== null && budgetUsagePct >= 92 && config.playerDetailCap > TUNABLE_KNOBS.playerDetailCap.min) {
    proposals.push({
      kind: "frequency_down", targetJa: "選手詳細の学習量",
      proposalJa: `API予算の使用率が${budgetUsagePct}%と逼迫しているため、選手詳細の上限を${config.playerDetailCap}人→${clampKnob("playerDetailCap", config.playerDetailCap - TUNABLE_KNOBS.playerDetailCap.step)}人に絞り、コア更新と予測を守ります。`,
      action: { knob: "playerDetailCap", to: clampKnob("playerDetailCap", config.playerDetailCap - TUNABLE_KNOBS.playerDetailCap.step) },
      expect: { metricName: "budgetUsagePct", direction: "lower", tolerancePt: 2 },
    });
  }
  // ルール5: 特に弱いリーグがある → 優先クラブ枠を広げて重点学習
  const worst = (diagnosis.leagueAccuracy || [])[0];
  if (worst && worst.n >= 5 && diagnosis.overallHitPct !== null && (diagnosis.overallHitPct - worst.hitRatePct) >= 15) {
    const p = {
      kind: "learn_more", targetJa: `弱いリーグ(${worst.league})の重点学習`,
      proposalJa: `${worst.league}の的中率が${worst.hitRatePct}%(全体${diagnosis.overallHitPct}%より${round1(diagnosis.overallHitPct - worst.hitRatePct)}pt低い・${worst.n}件)のため、学習計画の優先クラブ枠を広げて${worst.league}のクラブを重点収集します。`,
      action: config.priorityClubsMax < TUNABLE_KNOBS.priorityClubsMax.max
        ? { knob: "priorityClubsMax", to: clampKnob("priorityClubsMax", config.priorityClubsMax + TUNABLE_KNOBS.priorityClubsMax.step) }
        : null,
      expect: { metricName: "hit7dPct", direction: "higher", tolerancePt: 0 },
    };
    proposals.push(p);
  }
  // ルール6: 429(レート制限)が多発 → 提案のみ(自動変更は安全のため行わない)
  const code429 = (diagnosis.apiFailures && diagnosis.apiFailures.failuresByCode && diagnosis.apiFailures.failuresByCode.http_429) || 0;
  if (code429 >= 10) {
    proposals.push({
      kind: "proposal_only", targetJa: "APIレート制限(429)対策",
      proposalJa: `API-Footballのレート制限エラー(429)が${code429}件発生しています。呼び出し間隔の見直しが必要ですが、リクエスト間隔の変更は安全のため自動では行いません(提案として記録します)。`,
      action: null, expect: null,
    });
  }
  // ルール7: 有害と実測された特徴量 → 既存の自動0化機構に委任(情報として記録)
  if ((diagnosis.ineffectiveFeatures || []).length) {
    proposals.push({
      kind: "delegated", targetJa: "有害と実測された特徴量",
      proposalJa: `${diagnosis.ineffectiveFeatures.map((f) => f.labelJa).join("・")}が予測を悪化させていると実測されています。次回の重み学習で自動的に0化候補になります(ホールドアウト検証を通過した場合のみ採用される既存の安全機構に委ねます)。`,
      action: null, expect: null,
    });
  }
  return proposals;
}

/**
 * ③ 提案のうち実行可能なもの(action付き)を、安全ガードの範囲で適用する。
 *   ・1日最大2件 ・評価待ちのノブは再変更しない ・上下限は必ずクランプ
 */
function applyProposals(config, proposals, nowIso) {
  const applied = [];
  const pendingKnobs = new Set((config.pendingEvaluations || []).map((p) => p.knob));
  for (const p of proposals) {
    if (applied.length >= MAX_CHANGES_PER_DAY) break;
    if (!p.action || !p.action.knob || !TUNABLE_KNOBS[p.action.knob]) continue;
    if (pendingKnobs.has(p.action.knob)) continue; // 前回の変更の効果測定が済むまで触らない
    const from = config[p.action.knob];
    const to = clampKnob(p.action.knob, p.action.to);
    if (to === from) continue;
    config[p.action.knob] = to;
    const evaluation = p.expect ? {
      knob: p.action.knob, from, to,
      changedAt: nowIso,
      metricName: p.expect.metricName, direction: p.expect.direction, tolerancePt: p.expect.tolerancePt,
      baseline: null, // 適用当日の実測を基準として記録する(呼び出し側がmetricsから埋める)
      evalAfterDays: EVAL_AFTER_DAYS, attempts: 0,
    } : null;
    if (evaluation) {
      config.pendingEvaluations = config.pendingEvaluations || [];
      config.pendingEvaluations.push(evaluation);
      pendingKnobs.add(p.action.knob);
    }
    applied.push({ knob: p.action.knob, labelJa: TUNABLE_KNOBS[p.action.knob].labelJa, from, to, reasonJa: p.proposalJa });
  }
  return applied;
}

// ---------------------------------------------------------------
// ④ 効果測定(宣言済みの指標で改善前→改善後を比較。悪化なら自動で差し戻し)
// ---------------------------------------------------------------

function evaluateDueChanges(config, metricsNow, nowIso) {
  const results = [];
  const remaining = [];
  for (const pe of config.pendingEvaluations || []) {
    const dueMs = new Date(pe.changedAt).getTime() + pe.evalAfterDays * 86400000;
    if (new Date(nowIso).getTime() < dueMs) { remaining.push(pe); continue; }
    const now = metricsNow ? metricsNow[pe.metricName] : null;
    if (!Number.isFinite(now) || !Number.isFinite(pe.baseline)) {
      pe.attempts = (pe.attempts || 0) + 1;
      if (pe.attempts >= MAX_EVAL_ATTEMPTS) {
        results.push({ type: "evaluation", knob: pe.knob, verdict: "判定不能", from: pe.from, to: pe.to, metricName: pe.metricName, baseline: pe.baseline, now: Number.isFinite(now) ? now : null, detailJa: `効果測定に必要な実測(${pe.metricName})が${MAX_EVAL_ATTEMPTS}回の評価日とも揃わなかったため、効果を確認できないまま設定を維持します(正直に「判定不能」と記録)。`, at: nowIso });
      } else {
        pe.nextNoteJa = "評価に必要な実測が無いため持ち越し";
        remaining.push(pe);
      }
      continue;
    }
    const delta = round1(now - pe.baseline);
    const improved = pe.direction === "lower" ? now < pe.baseline : now > pe.baseline;
    const within = pe.direction === "lower" ? now <= pe.baseline + (pe.tolerancePt || 0) : now >= pe.baseline - (pe.tolerancePt || 0);
    if (improved) {
      results.push({ type: "evaluation", knob: pe.knob, verdict: "成功", from: pe.from, to: pe.to, metricName: pe.metricName, baseline: pe.baseline, now, deltaPt: delta, detailJa: `改善前${pe.baseline} → 改善後${now}(${pe.direction === "lower" ? "低下" : "上昇"}が目標)。改善を確認したため設定を維持します。`, at: nowIso });
    } else if (within) {
      results.push({ type: "evaluation", knob: pe.knob, verdict: "変化なし", from: pe.from, to: pe.to, metricName: pe.metricName, baseline: pe.baseline, now, deltaPt: delta, detailJa: `改善前${pe.baseline} → 改善後${now}。許容範囲内の変化のため、設定は維持して様子を見ます。`, at: nowIso });
    } else {
      // 悪化 → 自動で差し戻す
      config[pe.knob] = clampKnob(pe.knob, pe.from);
      results.push({ type: "revert", knob: pe.knob, verdict: "失敗→差し戻し", from: pe.from, to: pe.to, metricName: pe.metricName, baseline: pe.baseline, now, deltaPt: delta, detailJa: `改善前${pe.baseline} → 改善後${now}と悪化したため、${TUNABLE_KNOBS[pe.knob].labelJa}を${pe.to}→${pe.from}へ自動で差し戻しました(失敗も正直に記録します)。`, at: nowIso });
    }
  }
  config.pendingEvaluations = remaining;
  return results;
}

// ---------------------------------------------------------------
// ⑤ 履歴の読み出し(「この1か月で何を改善してきたか」)
// ---------------------------------------------------------------

async function getSelfImprovementHistory(deps, days) {
  const { upstashEnabled, upstashCmd } = deps || {};
  if (!upstashEnabled) return { available: false };
  try {
    const raw = (await upstashCmd(["LRANGE", HISTORY_KEY, String(-HISTORY_MAX), "-1"]).catch(() => [])) || [];
    const all = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    const cutoff = Date.now() - (days || 30) * 86400000;
    const recent = all.filter((e) => e.at && new Date(e.at).getTime() >= cutoff);
    const counts = {};
    recent.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
    return {
      available: true,
      periodDays: days || 30,
      totalEvents: recent.length,
      counts, // {change, evaluation, revert, proposal, ...}
      latest: recent.slice(-8).reverse(),
      noteJa: "AIが自分で行った診断・提案・変更・効果測定・差し戻しの全記録です(機械的ルールによる自動実行。上限・安全ガードの範囲内でのみ変更します)。",
    };
  } catch (e) { return { available: false }; }
}

function round1(v) { return Math.round(v * 10) / 10; }

module.exports = {
  TUNABLE_KNOBS, TUNE_CONFIG_KEY, HISTORY_KEY, MAX_CHANGES_PER_DAY, EVAL_AFTER_DAYS,
  clampKnob, defaultTuneConfig, loadTuneConfig, saveTuneConfig, appendHistory,
  buildSelfDiagnosis, buildImprovementProposals, applyProposals, evaluateDueChanges,
  getSelfImprovementHistory,
};
