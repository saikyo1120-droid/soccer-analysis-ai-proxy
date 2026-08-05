/**
 * server/learning/learningAgenda.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑩)。
 * AIが自分で「次に何を学ぶか」を決める。
 *
 * ■ 判断材料(すべて実データ)
 *   ・直近の検証済み予測(learn:ownpred:recent): どのクラブ・どのリーグで
 *     外しているか、通算とどれだけ差があるか
 *   ・外れた理由の頻度集計(failureReasons): どの特徴量の読みが弱いか
 *   ・監督交代を見逃した回数(contextualFailureReasons)
 *
 * ■ でっち上げ防止
 *   ・「苦手」と断定するのはサンプルが3件以上あり、かつ全体の的中率より
 *     15ポイント以上低い場合だけ。1回外しただけで「苦手」とは言わない。
 *   ・学習テーマには必ず「なぜそれを学ぶのか(実測の根拠)」と
 *     「具体的に何をするか」を添える。
 *
 * ■ 決めたテーマは翌日の収集で実際に使われる
 *   dailyJob が learn:agenda:latest を読み、優先クラブを universeCollector の
 *   priorityClubs へ渡す → そのクラブはtier Bでもその日のコア更新・xG更新の
 *   対象になる(「決めるだけで実行しない」を防ぐ)。
 */

const { findClub } = require("./clubUniverse");

const AGENDA_KEY_LATEST = "learn:agenda:latest";
const AGENDA_KEY_PREFIX = "learn:agenda:";
const MIN_SAMPLE_FOR_WEAKNESS = 3;
const WEAKNESS_GAP_PCT = 15;

function round1(v) { return Math.round(v * 10) / 10; }

/**
 * 直近の検証済み予測から「弱点」を実測で特定し、優先順位つきの学習計画を作る。
 * @param {Array} resolvedRecords - learn:ownpred:recent の中身(古い→新しい)
 * @param {Array} topFailureReasons - summarizeFailureReasonsの結果
 * @returns {{ generatedAt, overallAccuracyPct, items: [{priority, kind, targetEn, targetJa, reasonJa, actionJa}] }}
 */
function buildLearningAgenda(resolvedRecords, topFailureReasons, opts) {
  const records = (resolvedRecords || []).filter((r) => r && r.resolved && typeof r.correct === "boolean");
  const items = [];
  const overall = records.length ? (records.filter((r) => r.correct).length / records.length) * 100 : null;

  // ---- ① 苦手クラブ(実測: そのクラブが絡む試合の的中率が全体より15pt以上低い) ----
  if (overall !== null && records.length >= MIN_SAMPLE_FOR_WEAKNESS) {
    const byClub = new Map();
    for (const r of records) {
      for (const teamEn of [r.homeTeamEn, r.awayTeamEn]) {
        if (!teamEn) continue;
        const cur = byClub.get(teamEn) || { n: 0, hits: 0 };
        cur.n++; if (r.correct) cur.hits++;
        byClub.set(teamEn, cur);
      }
    }
    const weak = [...byClub.entries()]
      .map(([teamEn, v]) => ({ teamEn, n: v.n, accPct: (v.hits / v.n) * 100 }))
      .filter((c) => c.n >= MIN_SAMPLE_FOR_WEAKNESS && c.accPct <= overall - WEAKNESS_GAP_PCT)
      .sort((a, b) => a.accPct - b.accPct)
      .slice(0, 3);
    for (const c of weak) {
      const uni = findClub(c.teamEn);
      items.push({
        kind: "club",
        targetEn: c.teamEn,
        targetJa: (uni && uni.nameJa) || c.teamEn,
        reasonJa: `${(uni && uni.nameJa) || c.teamEn}が絡む直近${c.n}試合の的中率が${round1(c.accPct)}%で、全体(${round1(overall)}%)より${round1(overall - c.accPct)}ポイント低いため。`,
        actionJa: "明日の収集でこのクラブを優先更新します(フォーム・怪我・布陣・xGを輪番を待たずに取得)。",
      });
    }
  }

  // ---- ② 弱い特徴量(外れた理由の頻度集計から) ----
  const reasonToAction = {
    xgDiff_underweighted: { targetJa: "xG(チャンスの質)の学習", actionJa: "xG更新の対象クラブを増やし、xG特徴量の学習データを厚くします。" },
    injuryDiff_underweighted: { targetJa: "怪我情報の反映", actionJa: "怪我人情報の更新頻度を維持し、負傷者数の差の学習データを厚くします。" },
    coach_change_ignored: { targetJa: "監督交代の追跡", actionJa: "監督交代が検出されたクラブを翌日の優先更新に含めます。" },
    home_bonus_overweighted: { targetJa: "ホーム補正の見直し", actionJa: "次回の重み学習でホーム基礎値の近傍探索を継続します(自動)。" },
  };
  for (const fr of (topFailureReasons || []).slice(0, 3)) {
    if (!fr || !fr.id || fr.count < 2) continue; // 1回だけの外れで方針は変えない
    const map = reasonToAction[fr.id];
    items.push({
      kind: "theme",
      targetEn: fr.id,
      targetJa: (map && map.targetJa) || fr.labelJa,
      reasonJa: `直近の外れた予測のうち${fr.count}件で「${fr.labelJa}」が原因と分析されたため。`,
      actionJa: (map && map.actionJa) || "次回の重み学習(毎日実行)で該当特徴量の重みが再評価されます。",
    });
  }

  // ---- ③ 判断材料が無い場合も正直に返す ----
  const agenda = {
    generatedAt: (opts && opts.nowIso) || new Date().toISOString(),
    overallAccuracyPct: overall === null ? null : round1(overall),
    sampleSize: records.length,
    items: items.slice(0, 5).map((it, i) => ({ priority: i + 1, ...it })),
  };
  if (!agenda.items.length) {
    agenda.noteJa = records.length < MIN_SAMPLE_FOR_WEAKNESS
      ? `検証済みの予測がまだ${records.length}件のため、「苦手」を断定できる材料がありません(${MIN_SAMPLE_FOR_WEAKNESS}件以上で分析を始めます)。`
      : "直近の検証結果からは、特定のクラブ・特徴量に偏った弱点は検出されませんでした。";
  }
  return agenda;
}

/** 学習計画から「明日優先的に収集するクラブ」の英語名一覧を取り出す */
function priorityClubsOf(agenda) {
  if (!agenda || !Array.isArray(agenda.items)) return [];
  return agenda.items.filter((it) => it.kind === "club" && it.targetEn).map((it) => it.targetEn);
}

async function saveAgenda(deps, dateKey, agenda) {
  const { upstashEnabled, upstashSetJSON } = deps || {};
  if (!upstashEnabled || !agenda) return false;
  try {
    await upstashSetJSON(`${AGENDA_KEY_PREFIX}${dateKey}`, agenda);
    await upstashSetJSON(AGENDA_KEY_LATEST, agenda);
    return true;
  } catch (e) { return false; }
}

async function loadLatestAgenda(deps) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  if (!upstashEnabled) return null;
  return (await upstashGetJSON(AGENDA_KEY_LATEST).catch(() => null)) || null;
}

module.exports = {
  buildLearningAgenda, priorityClubsOf, saveAgenda, loadLatestAgenda,
  AGENDA_KEY_LATEST, AGENDA_KEY_PREFIX, MIN_SAMPLE_FOR_WEAKNESS, WEAKNESS_GAP_PCT,
};
