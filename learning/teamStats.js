/**
 * server/learning/teamStats.js
 * ------------------------------------------------
 * 2026年8月19日・v59「派生指標(BTTS・クリーンシート・荒れやすさ)」。
 *
 * ■ 何をするか
 *   毎朝の学習が持っている「実試合のデータセット」(12大会×5シーズン)から、
 *   クラブごとの以下の実測値を機械的に数える。**推測・補完は一切しない。**
 *     ・BTTS率        … 両チームが得点した試合の割合
 *     ・クリーンシート率… 無失点で終えた試合の割合
 *     ・無得点率       … 自分が得点できなかった試合の割合
 *     ・オーバー2.5率  … 合計3点以上になった試合の割合
 *     ・荒れやすさ     … 「1試合の合計得点」のばらつき(標準偏差)
 *
 * ■ 「荒れやすさ」を勝手な閾値でラベル付けしない設計(でっち上げ防止)
 *   「標準偏差1.6以上は荒れやすい」のような閾値は、根拠のない人間の決め打ちに
 *   なる。そこで**同じデータセット内の全クラブの中での相対順位(パーセンタイル)**
 *   だけを計算して保存する。画面のラベルは「全クラブ中の上位◯%」という
 *   実測の順位そのものから決まるため、恣意的な基準が入らない。
 *
 * ■ いつ計算するか(方針⑥: 質問した瞬間に重い処理をしない)
 *   毎朝の学習(modelTuning)がデータセットを読み込んだそのついでに1回だけ集計し、
 *   Redis(learn:teamstats:v1)へ保存する。利用者の質問時は保存済みの読み出しのみ。
 */

const TEAM_STATS_KEY = "learn:teamstats:v1";
const MIN_MATCHES_FOR_STATS = 10; // これ未満のクラブは公開しない(少数からの断定を避ける)

/** 小数3桁に丸める(保存サイズを抑える) */
function r3(v) { return Math.round(v * 1000) / 1000; }

/**
 * 学習用データセットの行からクラブ別の実測傾向を集計する(純関数)。
 * @param {Array} rows - {homeId, awayId, actualHomeGoals, actualAwayGoals, date}
 * @param {object} opts - { minMatches, builtAt }
 * @returns {{available, byTeam, overall, teamsCounted, matchesUsed, minMatches, builtAt, reasonJa}}
 */
function buildTeamStats(rows, opts) {
  const o = opts || {};
  const minN = Number.isFinite(o.minMatches) ? o.minMatches : MIN_MATCHES_FOR_STATS;
  const usable = (rows || []).filter((r) => r
    && Number.isFinite(r.homeId) && Number.isFinite(r.awayId)
    && Number.isFinite(r.actualHomeGoals) && Number.isFinite(r.actualAwayGoals));
  if (!usable.length) {
    return {
      available: false, byTeam: {}, overall: null, teamsCounted: 0, matchesUsed: 0,
      minMatches: minN, builtAt: o.builtAt || null,
      reasonJa: "集計に使える実試合が0件のため、派生指標は作成していません。",
    };
  }

  const acc = new Map(); // id -> 集計器
  const bump = (id, gf, ga) => {
    let a = acc.get(id);
    if (!a) { a = { n: 0, btts: 0, cs: 0, fts: 0, over25: 0, gf: 0, ga: 0, tot: 0, totSq: 0 }; acc.set(id, a); }
    const total = gf + ga;
    a.n++;
    if (gf > 0 && ga > 0) a.btts++;
    if (ga === 0) a.cs++;
    if (gf === 0) a.fts++;
    if (total >= 3) a.over25++;
    a.gf += gf; a.ga += ga; a.tot += total; a.totSq += total * total;
  };
  let allBtts = 0, allOver25 = 0, allTot = 0, allTotSq = 0;
  for (const r of usable) {
    const hg = r.actualHomeGoals, ag = r.actualAwayGoals;
    bump(r.homeId, hg, ag);
    bump(r.awayId, ag, hg);
    const total = hg + ag;
    if (hg > 0 && ag > 0) allBtts++;
    if (total >= 3) allOver25++;
    allTot += total; allTotSq += total * total;
  }

  // ---- クラブ別の実測値(試合数が閾値以上のクラブのみ) ----
  const entries = [];
  for (const [id, a] of acc.entries()) {
    if (a.n < minN) continue;
    const mean = a.tot / a.n;
    const varTot = Math.max(0, a.totSq / a.n - mean * mean);
    entries.push({
      id,
      n: a.n,
      bttsRate: r3(a.btts / a.n),
      csRate: r3(a.cs / a.n),
      ftsRate: r3(a.fts / a.n),
      over25Rate: r3(a.over25 / a.n),
      gfAvg: r3(a.gf / a.n),
      gaAvg: r3(a.ga / a.n),
      totalAvg: r3(mean),
      totalSd: r3(Math.sqrt(varTot)),
    });
  }
  if (!entries.length) {
    return {
      available: false, byTeam: {}, overall: null, teamsCounted: 0, matchesUsed: usable.length,
      minMatches: minN, builtAt: o.builtAt || null,
      reasonJa: `実試合は${usable.length}件ありましたが、${minN}試合以上あるクラブが1つも無いため、派生指標は公開しません。`,
    };
  }

  // ---- 「荒れやすさ」= 合計得点のばらつきの相対順位(0〜100。高いほど荒れやすい) ----
  //   閾値の決め打ちを避けるため、同じデータセット内の全クラブの中での
  //   順位だけを持たせる(1クラブしか居ない場合は順位が定義できないのでnull)。
  //   同点は同じ順位にする(並び順で優劣がつくと、実測ではない差が生まれるため)。
  const sdValues = entries.map((e) => e.totalSd).sort((a, b) => a - b);
  const pctByValue = new Map();
  for (let i = 0; i < sdValues.length;) {
    const v = sdValues[i];
    let j = i;
    while (j < sdValues.length && sdValues[j] === v) j++;
    const less = i, equal = j - i;
    // 中間順位パーセンタイル: (自分より小さい数 + 同点の半分) / 全体
    pctByValue.set(v, Math.round(((less + equal / 2) / sdValues.length) * 100));
    i = j;
  }
  for (const e of entries) e.volPct = entries.length > 1 ? pctByValue.get(e.totalSd) : null;

  const byTeam = {};
  for (const e of entries) {
    byTeam[e.id] = {
      n: e.n, bttsRate: e.bttsRate, csRate: e.csRate, ftsRate: e.ftsRate,
      over25Rate: e.over25Rate, gfAvg: e.gfAvg, gaAvg: e.gaAvg,
      totalAvg: e.totalAvg, totalSd: e.totalSd, volPct: e.volPct,
    };
  }
  const oMean = allTot / usable.length;
  const overall = {
    matches: usable.length,
    bttsRate: r3(allBtts / usable.length),
    over25Rate: r3(allOver25 / usable.length),
    totalAvg: r3(oMean),
    totalSd: r3(Math.sqrt(Math.max(0, allTotSq / usable.length - oMean * oMean))),
  };
  return {
    available: true,
    byTeam, overall,
    teamsCounted: entries.length,
    matchesUsed: usable.length,
    minMatches: minN,
    builtAt: o.builtAt || null,
    reasonJa: null,
  };
}

/**
 * 2クラブの「荒れやすさ」を1つにまとめる(純関数)。
 * 片方しか実測が無ければそのまま使い、両方無ければnull(でっち上げない)。
 * @returns {{ pct:number, labelJa:string, basis:"both"|"home"|"away" }|null}
 */
function combineVolatility(homeStat, awayStat) {
  const vs = [];
  if (homeStat && Number.isFinite(homeStat.volPct)) vs.push(["home", homeStat.volPct]);
  if (awayStat && Number.isFinite(awayStat.volPct)) vs.push(["away", awayStat.volPct]);
  if (!vs.length) return null;
  const pct = Math.round(vs.reduce((s, [, v]) => s + v, 0) / vs.length);
  // ラベルは「全クラブ中の相対順位」そのものの言い換え(独自の閾値ではなく三分位)
  const labelJa = pct >= 67 ? "荒れやすい" : pct <= 33 ? "落ち着いた" : "平均的";
  return { pct, labelJa, basis: vs.length === 2 ? "both" : vs[0][0] };
}

module.exports = { TEAM_STATS_KEY, MIN_MATCHES_FOR_STATS, buildTeamStats, combineVolatility };
