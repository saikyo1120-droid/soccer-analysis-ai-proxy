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
    // v104.1(総点検): チームIDがある記録(v98以降)は、名前ではなくチームIDで数える。
    //   名前だけで数えると、同じ名前の別クラブ(例: FC Porto と、ブラジルの州リーグの「Porto」)が1つに合算され、
    //   しかも日本語名は固定名簿から引くため「FCポルトが絡む試合の的中率が…」と別クラブの成績を表示し得た。
    //   日本語名を付けるのは、このアプリの表記で記録された側(originTeamEn=追跡中クラブ自身)が含まれる場合と、
    //   チームIDの無い旧記録(従来どおり名前で照合)だけにする。
    const byClub = new Map();
    for (const r of records) {
      for (const side of ["home", "away"]) {
        const teamEn = side === "home" ? r.homeTeamEn : r.awayTeamEn;
        if (!teamEn) continue;
        const tidRaw = side === "home" ? r.homeTeamId : r.awayTeamId;
        const hasId = tidRaw !== null && tidRaw !== undefined && tidRaw !== "" && Number.isFinite(Number(tidRaw));
        const key = hasId ? `id:${Number(tidRaw)}` : `name:${teamEn}`;
        const cur = byClub.get(key) || { n: 0, hits: 0, hasId, originName: null, names: new Map() };
        cur.n++; if (r.correct) cur.hits++;
        cur.names.set(teamEn, (cur.names.get(teamEn) || 0) + 1);
        if (r.originTeamEn && r.originTeamEn === teamEn) cur.originName = teamEn;
        byClub.set(key, cur);
      }
    }
    const weak = [...byClub.values()]
      .map((v) => {
        const commonName = [...v.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return { teamEn: v.originName || commonName, n: v.n, accPct: (v.hits / v.n) * 100, labelFromUniverse: !v.hasId || !!v.originName };
      })
      .filter((c) => c.n >= MIN_SAMPLE_FOR_WEAKNESS && c.accPct <= overall - WEAKNESS_GAP_PCT)
      .sort((a, b) => a.accPct - b.accPct)
      .slice(0, 3);
    for (const c of weak) {
      const uni = c.labelFromUniverse ? findClub(c.teamEn) : null;
      items.push({
        kind: "club",
        targetEn: c.teamEn,
        targetJa: (uni && uni.nameJa) || c.teamEn,
        // v104.1(総点検): 追跡名簿(固定の172クラブ)のクラブかどうか。優先更新(翌日の収集で輪番を待たずに取得)が
        //   できるのは名簿のクラブだけ。名簿の外のクラブ(対戦相手として現れただけのクラブ・同じ名前の別クラブ)に
        //   「優先更新します」と書いたり、同じ名前の名簿クラブを代わりに優先したりしない。
        tracked: !!uni,
        reasonJa: `${(uni && uni.nameJa) || c.teamEn}が絡む直近${c.n}試合の的中率が${round1(c.accPct)}%で、全体(${round1(overall)}%)より${round1(overall - c.accPct)}ポイント低いため。`,
        actionJa: uni
          ? "明日の収集でこのクラブを優先更新します(フォーム・怪我・布陣・xGを輪番を待たずに取得)。"
          : "追跡名簿の外のクラブのため、優先更新の対象にはなりません(試合で見かけたクラブは、候補として記録し、順番に取り込んで情報を増やします)。",
      });
    }
  }

  // ---- ② 弱い特徴量(外れた理由の頻度集計から) ----
  const reasonToAction = {
    xgDiff_underweighted: { targetJa: "xG(チャンスの質)の学習", actionJa: "xG更新の対象クラブを増やし、xG特徴量の学習データを厚くします。" },
    injuryDiff_underweighted: { targetJa: "怪我情報の反映", actionJa: "怪我人情報の更新頻度を維持し、負傷者数の差の学習データを厚くします。" },
    coach_change_ignored: { targetJa: "監督交代の追跡", actionJa: "監督交代が検出されたクラブを翌日の優先更新に含めます。" },
    home_bonus_overweighted: { targetJa: "ホーム補正の見直し", actionJa: "次回の重み学習でホーム基礎値の近傍探索を継続します(自動)。" },
    // v98: 予想時にデータが欠けていた(外れ理由として正式に扱う)
    data_missing: { targetJa: "データ不足の解消", actionJa: "欠けていたチームを動的クラブの候補として記録し、翌日の収集で優先的に取得します(固定名簿の外のクラブも取り込みます)。" },
  };
  // ---- v100: 「次回の重み学習で再評価」が実際には何日も採用に至っていないとき、その事実を添える ----
  //   本番実測(11/8): 「直近フォームを重視しすぎた ×286」が毎日並び、毎日「次回の重み学習で再評価」と
  //   書かれていたが、重みは 10/15 から24日間一度も変わっていなかった(関門を通る改善が無かった)。
  //   予定だけを書き続けるのは不正直なので、据え置きの日数と理由を一緒に書く。
  const ws = (opts && opts.weightsState) || null;
  const reevalNote = (() => {
    if (!ws) return "";
    if (ws.weightsUpdatedToday) return "(本日の重み学習で重みが更新されました)";
    if (Number.isFinite(ws.daysSinceUpdate) && ws.daysSinceUpdate >= 3) {
      const gateJa = ws.gate && Number.isFinite(ws.gate.candidates)
        ? `直近の学習では候補${ws.gate.candidates}件のうち${ws.gate.passed || 0}件が採否の関門(検証LogLossの改善と的中率の維持)を通りました。`
        : "";
      return `(ただし重みは${ws.daysSinceUpdate}日間据え置きです。毎晩の学習で候補は作っていますが、検証データで改善が確認できたものだけを採用しています。${gateJa})`;
    }
    return "";
  })();
  for (const fr of (topFailureReasons || []).slice(0, 3)) {
    if (!fr || !fr.id || fr.count < 2) continue; // 1回だけの外れで方針は変えない
    const map = reasonToAction[fr.id];
    const baseAction = (map && map.actionJa) || "次回の重み学習(毎日実行)で該当特徴量の重みが再評価されます。";
    items.push({
      kind: "theme",
      targetEn: fr.id,
      targetJa: (map && map.targetJa) || fr.labelJa,
      reasonJa: `直近の外れた予測のうち${fr.count}件で「${fr.labelJa}」が原因と分析されたため。`,
      actionJa: /重み/.test(baseAction) ? baseAction + reevalNote : baseAction,
      weightsDaysSinceUpdate: ws && Number.isFinite(ws.daysSinceUpdate) ? ws.daysSinceUpdate : undefined,
    });
  }

  // ---- ②-b v98: どのデータが欠けて外れたかの内訳(missingFeatures の実測集計) ----
  const missCounts = new Map();
  let missedWithMissing = 0;
  for (const r of records) {
    if (r.correct) continue;
    const mf = Array.isArray(r.missingFeatures) ? r.missingFeatures
      : (Array.isArray(r.failureReasons) ? ((r.failureReasons.find((x) => x && x.id === "data_missing") || {}).missingFeatures || []) : []);
    if (!mf.length) continue;
    missedWithMissing++;
    for (const k of mf) missCounts.set(k, (missCounts.get(k) || 0) + 1);
  }
  if (missedWithMissing >= 2 && !items.some((it) => it.kind === "theme" && it.targetEn === "data_missing")) {
    const top = [...missCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => `${(opts && opts.featureLabelsJa && opts.featureLabelsJa[k]) || k}(${n}件)`);
    items.push({
      kind: "data",
      targetEn: "data_missing",
      targetJa: "データ不足の解消",
      reasonJa: `直近の外れた予測のうち${missedWithMissing}件は、予想時にデータが欠けていました(内訳: ${top.join("・")})。`,
      actionJa: "欠けていたチームを動的クラブの候補として記録し、翌日の収集で優先的に取得します。",
      missingFeatureCounts: Object.fromEntries(missCounts),
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
  // v104.1(総点検): 追跡名簿のクラブだけを返す(tracked:false=名簿の外。旗の無い旧い計画は、名簿に名前があるものだけ)
  return agenda.items
    .filter((it) => it.kind === "club" && it.targetEn && it.tracked !== false && !!findClub(it.targetEn))
    .map((it) => it.targetEn);
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
