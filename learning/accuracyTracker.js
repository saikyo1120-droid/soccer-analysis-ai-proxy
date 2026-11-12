/**
 * server/learning/accuracyTracker.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑨)。
 * 予測精度を毎日測定する: 勝敗(1X2)だけでなく、スコア・BTTS(両チーム得点)・
 * Over/Under 2.5 の各市場について、的中率・Brier Score・Log Loss・
 * Calibration(自信と実際の的中のズレ)を記録し、昨日・先週・先月と比較する。
 *
 * ■ でっち上げ防止
 *   ・BTTS/Over-Under の確率は、勝敗予測と同じポアソン分布(homeLambda/awayLambda)
 *     から機械的に導出する。別の「予想」を勝手に作らない。
 *   ・検証データが無い日は、無理に数字を出さず「測定できない」と正直に返す。
 *   ・ROI(オッズを使った収益率)は、現在オッズを取得していないため計算しない
 *     (存在しない数字を出さない)。API-Football Proにはオッズのエンドポイントが
 *     あるため、必要になれば追加できる。
 *
 * ■ 指標の意味(利用者向けの説明にも使う)
 *   ・的中率: 当たった割合。分かりやすいが「自信の質」は測れない。
 *   ・Brier Score: 確率予測の二乗誤差(0が最良、1X2の無情報予測≒0.667)。
 *   ・Log Loss: 実際の結果に割り当てていた確率の対数損失(低いほど良い。
 *     自信満々で外すと大きく罰される)。
 *   ・Calibration: 「70%と言った予測は本当に70%当たっているか」。
 *
 * ■ 2026年8月・AI知能計測ラウンド(ご指示⑥)での拡張
 *   ・Precision / Recall / F1: 1X2はホーム勝ち・引き分け・アウェイ勝ちの
 *     3クラスなので、クラスごとの混同行列(予測回数・実際の回数・正解回数)を
 *     毎日積み上げ、マクロ平均のPrecision/Recall/F1を出す。
 *   ・ECE(Expected Calibration Error): 較正の帯ごとに「申告した自信の平均」も
 *     保存し(confSum)、|平均自信 − 実際の的中率| の加重平均を厳密に計算する。
 *   ・Top1/Top3: 1X2は3クラスしかないため「Top3的中率」は定義上必ず100%になる
 *     (=無意味な数字)。でっち上げた高得点を出さないため、Top3は最も難しい
 *     「スコア(何対何)」で測る: ポアソン格子の上位3スコアのどれかが実スコアと
 *     一致したか。Top1は従来どおり予測スコアそのものの一致。
 *   いずれも過去に保存済みの集計(古い形式)とマージしても壊れないよう、
 *   新フィールドは欠けていれば0(または「測定不能」)として扱う。
 */

const { poissonPmf } = require("./predictionModel");

const ACCURACY_KEY_PREFIX = "learn:accuracy:";
const P_FLOOR = 0.005; // log(0)回避

// ---- v100(2026年11月8日・「本当に賢くなっているか」の総点検) ----
//   ① リーグ別・学習済み/未学習別の的中率を日次集計に積む(内訳が無く、母数20件以上で
//      52%未満の日に原因を調べる手段が無かった。本番 11/8: 57件 47.4% で内訳が取れなかった)。
//   ② 「賢さ」を的中率以外で測る技能スコア(スキルスコア)を同じ集計から出す:
//        LogLoss スキル = 1 − 平均LogLoss ÷ ln3(当てずっぽう=3択均等の損失)
//        Brier  スキル = 1 − 平均Brier ÷ (2/3)(同じく3択均等の Brier)
//      0% = 当てずっぽうと同じ、100% = 完璧。マイナスは当てずっぽう以下。
//   いずれも保存済みの実測だけから機械的に計算する(推測で埋めない)。
const BY_LEAGUE_MAX_PER_DAY = 60;        // 1日の集計に持つリーグ数の上限(超えたぶんは「その他」へ)
const BY_LEAGUE_OTHER_KEY = "__other__"; // 上限を超えたリーグの受け皿
const LN3 = Math.log(3);
// v104 J: 試合内容の予測(2.5点以上・両チーム得点・スコア上位)の採点と集計
const matchContent = require("./matchContent");
const UNIFORM_BRIER_3WAY = 2 / 3;

/**
 * リーグ名を集計キーに正規化する(表記ゆれで別行にならないように)。
 * v101: 大会名だけだと別の国の同名大会が1行に合算される(本番実測: イタリアとブラジルの
 *   「Serie A」が 154 件の1行に、「Super League」はスイスか中国か区別不能)。記録に国名
 *   (leagueCountry。v101 から保存)があれば「Serie A(Italy)」の形にして区別する。
 *   UEFA 大会などの国名 "World" は付けない(意味が無いため)。
 */
function leagueKeyOf(name, country) {
  const s = String(name || "").trim().replace(/\s+/g, " ");
  if (!s) return "(大会名なし)";
  const c = String(country || "").trim().replace(/\s+/g, " ");
  const base = s.slice(0, 60);
  if (!c || /^world$/i.test(c)) return base;
  return `${base}(${c.slice(0, 30)})`;
}

// ---- v101(2026年11月9日): 計測の物差し ----
//   ① オッズあり/なし別(市場合成ができた予想と、自前モデル単独の予想の成績を分ける。
//      無オッズは直近30日で 14.9% あり、その群の的中率が未計測だった)
//   ② リーグ別の引き分け較正(予想した引き分け確率の平均 vs 実際の引き分け率。
//      ★5「引き分けの扱い」の判断材料。本番実測: 引き分け実際 21.3% vs 引き分け予想 1.0%)
//   ③ 朝版 vs 直前版(確定スタメン+直前オッズ)の的中率・Brier・LogLoss(★6 の判断材料。
//      従来は累計 Brier だけで、的中率も 30 日窓も無かった)
function emptyOddsBucket() { return { n: 0, hits: 0, brierSum: 0, logLossSum: 0 }; }
function emptyLineupCompare() {
  return { n: 0, morningHits: 0, preKickHits: 0, morningBrierSum: 0, preKickBrierSum: 0, morningLogLossSum: 0, preKickLogLossSum: 0, changed: 0, changedPreKickHits: 0, changedMorningHits: 0 };
}

function skillOf(avgLogLoss, avgBrier) {
  const ll = Number.isFinite(avgLogLoss) ? Math.round((1 - avgLogLoss / LN3) * 1000) / 10 : null;
  const br = Number.isFinite(avgBrier) ? Math.round((1 - avgBrier / UNIFORM_BRIER_3WAY) * 1000) / 10 : null;
  return {
    logLossSkillPct: ll, brierSkillPct: br,
    noteJa: "技能スコア=当てずっぽう(3択均等)に対してどれだけ損失が小さいか。0%で同等、100%で完璧、マイナスは当てずっぽう以下。的中率とは別の、確率の質(較正と鋭さ)の指標です。",
  };
}

/**
 * ポアソン格子から全市場の確率を導出する(勝敗と同一のモデル・同一のλ)。
 */
function computeMarketProbs(homeLambda, awayLambda, maxGoals) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const cap = maxGoals || 8;
  let pHome = 0, pDraw = 0, pAway = 0, pBtts = 0, pOver25 = 0;
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      const p = poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda);
      if (h > a) pHome += p; else if (h < a) pAway += p; else pDraw += p;
      if (h >= 1 && a >= 1) pBtts += p;
      if (h + a >= 3) pOver25 += p;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return {
    homeWin: pHome / total, draw: pDraw / total, awayWin: pAway / total,
    btts: pBtts / total, over25: pOver25 / total,
  };
}

/**
 * v97(全体監査): 1X2(勝敗)の「最終確率」を記録から取り出す。
 *
 * 予測の判定(predictedWinner)は v50 以降、市場オッズや「2つ目の意見」を混合した
 * **最終確率**で行われることがある。ところが採点(Brier/LogLoss/較正の自信)と画面の
 * 勝率表示は、混合前の λ だけから確率を計算し直していたため、
 *   ・画面の「勝率」と判定の根拠になった確率が食い違う
 *   ・較正マップ(「55%と言った予想は本当に55%当たるか」)が、判定に使っていない数字で作られる
 * という不整合があった。予測時に record.finalProbs(判定に実際に使った確率)を保存し、
 * 以後の採点・表示はこれを優先する。無い記録(v97より前)は従来どおり λ から導く。
 * @returns {{ homeWin:number, draw:number, awayWin:number, source:string }|null}
 */
function oneX2ProbsOf(record) {
  if (!record) return null;
  const fp = record.finalProbs;
  if (fp && [fp.homeWin, fp.draw, fp.awayWin].every((v) => Number.isFinite(v) && v >= 0)) {
    const total = fp.homeWin + fp.draw + fp.awayWin || 1;
    return { homeWin: fp.homeWin / total, draw: fp.draw / total, awayWin: fp.awayWin / total, source: fp.source || "final" };
  }
  const p = computeMarketProbs(record.homeLambda, record.awayLambda);
  return p ? { homeWin: p.homeWin, draw: p.draw, awayWin: p.awayWin, source: "lambda" } : null;
}

/** 記録の予測(predictedWinner)に与えていた確率(=自信)。判定できなければ null。 */
function confidenceOnPickOf(record) {
  const p = oneX2ProbsOf(record);
  if (!p || !record || !record.predictedWinner) return null;
  const v = record.predictedWinner === "home" ? p.homeWin : record.predictedWinner === "away" ? p.awayWin : record.predictedWinner === "draw" ? p.draw : null;
  return Number.isFinite(v) ? v : null;
}

/**
 * AI知能計測ラウンド(ご指示⑥・Top3): ポアソン格子から確率の高い順に
 * 上位Nスコアを返す。予測時と同じλ・同じ格子から機械的に導出するため、
 * 「後から都合の良いスコアを選ぶ」ことはできない。
 */
function topScorelines(homeLambda, awayLambda, topN, maxGoals) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda)) return null;
  const cap = maxGoals || 8;
  const cells = [];
  for (let h = 0; h <= cap; h++) {
    for (let a = 0; a <= cap; a++) {
      cells.push({ scoreline: `${h}-${a}`, p: poissonPmf(h, homeLambda) * poissonPmf(a, awayLambda) });
    }
  }
  cells.sort((x, y) => y.p - x.p);
  return cells.slice(0, Math.max(1, topN || 3)).map((c) => ({ scoreline: c.scoreline, prob: round4(c.p) }));
}

/** 実スコアから各市場の実際の結果を出す */
function outcomesFromScore(homeGoals, awayGoals) {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  return {
    winner: homeGoals > awayGoals ? "home" : homeGoals < awayGoals ? "away" : "draw",
    btts: homeGoals >= 1 && awayGoals >= 1,
    over25: homeGoals + awayGoals >= 3,
  };
}

/**
 * 解決済みの予測1件を全市場で採点する。
 * actualScore(実スコア)が無い古い記録は、1X2(actualWinner)だけ採点する。
 * @returns {object|null} 採点結果。採点材料が無ければnull。
 */
function scorePrediction(record) {
  if (!record || !Number.isFinite(record.homeLambda) || !Number.isFinite(record.awayLambda)) return null;
  const probs = computeMarketProbs(record.homeLambda, record.awayLambda);
  if (!probs) return null;

  const out = { markets: {} };

  // ---- 1X2(勝敗) ----
  // v97: 判定に実際に使った最終確率(finalProbs)があればそれで採点する(無ければ λ から)
  const p1x2 = oneX2ProbsOf(record) || probs;
  const actualWinner = record.actualWinner
    || (record.actualScore ? outcomesFromScore(record.actualScore.home, record.actualScore.away)?.winner : null);
  if (actualWinner) {
    const oneHot = { home: actualWinner === "home" ? 1 : 0, draw: actualWinner === "draw" ? 1 : 0, away: actualWinner === "away" ? 1 : 0 };
    const brier = Math.pow(p1x2.homeWin - oneHot.home, 2) + Math.pow(p1x2.draw - oneHot.draw, 2) + Math.pow(p1x2.awayWin - oneHot.away, 2);
    const pActual = actualWinner === "home" ? p1x2.homeWin : actualWinner === "away" ? p1x2.awayWin : p1x2.draw;
    const maxProb = Math.max(p1x2.homeWin, p1x2.draw, p1x2.awayWin);
    const predictedWinner = p1x2.homeWin === maxProb ? "home" : p1x2.awayWin === maxProb ? "away" : "draw";
    // v97: 自信=「実際に予測した勝敗に与えていた確率」。以前は最大確率(argmax)を使っていたため、
    //   引き分け帯のルールや市場混合で argmax と違う勝敗を予測した試合では、較正マップが
    //   「言っていない数字」で作られていた。記録に予測が無い旧記録だけ argmax を使う。
    const confidenceOnPick = confidenceOnPickOf({ ...record, finalProbs: record.finalProbs }) ?? maxProb;
    out.markets.oneX2 = {
      hit: record.predictedWinner ? record.predictedWinner === actualWinner : predictedWinner === actualWinner,
      brier: round4(brier),
      logLoss: round4(-Math.log(Math.max(P_FLOOR, pActual))),
      confidence: round4(confidenceOnPick), // 予測時の自信(較正の材料)= 予測した勝敗に与えていた確率
      confidenceBasis: record.predictedWinner ? "pick" : "argmax",
      probsSource: p1x2.source || "lambda", // "final"(混合後の最終確率) / "lambda"(λのみ・旧記録)
      probs: { homeWin: round4(p1x2.homeWin), draw: round4(p1x2.draw), awayWin: round4(p1x2.awayWin) },
      // ご指示⑥(Precision/Recall/F1): クラス別混同行列の材料として、
      // 「どのクラスを予測したか」も採点結果に残す(記録に予測が保存されて
      // いればそれを使い、無ければ確率の最大クラス=当時の予測を使う)。
      predicted: record.predictedWinner || predictedWinner,
      actual: actualWinner,
    };
  }

  // ---- BTTS / Over-Under 2.5(実スコアがある記録のみ) ----
  const score = record.actualScore;
  const actuals = score ? outcomesFromScore(score.home, score.away) : null;
  if (actuals) {
    out.markets.btts = binaryScore(probs.btts, actuals.btts);
    out.markets.over25 = binaryScore(probs.over25, actuals.over25);
    // 最終スコアの一致(最も難しい市場。参考値として記録)
    if (record.predictedScoreline) {
      const actualSl = `${score.home}-${score.away}`;
      // ご指示⑥(Top3): 予測時と同じポアソン格子から上位3スコアを再導出し、
      // 実スコアがその中に入っていたかを採点する(1X2のTop3は3クラスで
      // 必ず100%になるため、意味のあるスコア市場で測る。冒頭コメント参照)。
      const top3 = topScorelines(record.homeLambda, record.awayLambda, 3);
      out.markets.scoreline = {
        hit: record.predictedScoreline === actualSl,
        predicted: record.predictedScoreline,
        actual: actualSl,
        top3: top3 ? top3.map((t) => t.scoreline) : null,
        top3Hit: top3 ? top3.some((t) => t.scoreline === actualSl) : null,
      };
    }
    // ---- v104 J: 試合内容(λ版・整合版・表示した版)の採点。content の無い旧記録は null ----
    try {
      out.content = matchContent.scoreContent(record, score);
    } catch (e) { out.contentScoreErrorJa = `試合内容の採点に失敗(${(e && e.message) || "unknown"})`; }
  }
  return out;
}

function binaryScore(prob, actual) {
  const y = actual ? 1 : 0;
  return {
    hit: (prob >= 0.5) === actual,
    brier: round4(Math.pow(prob - y, 2)),
    logLoss: round4(-Math.log(Math.max(P_FLOOR, actual ? prob : 1 - prob))),
    prob: round4(prob),
    actual,
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * 1日分の採点を集計する(合計値で持ち、同じ日の複数回実行はマージで加算できる形)。
 */
function buildDailyAccuracy(scoredList) {
  const agg = emptyDailyAccuracy();
  for (const s of scoredList || []) {
    if (!s || !s.markets) continue;
    for (const m of ["oneX2", "btts", "over25"]) {
      const mk = s.markets[m];
      if (!mk || !Number.isFinite(mk.brier)) continue;
      const a = agg[m];
      a.n++;
      if (mk.hit) a.hits++;
      // 2026年8月18日: 公式戦(親善・2軍を除く)だけの成績も並行して数える。
      // 親善試合は当てられなくて当然なので、主表示は公式戦の的中率にする。
      if (m === "oneX2" && s.official === true) {
        a.official = a.official || { n: 0, hits: 0 };
        a.official.n++;
        if (mk.hit) a.official.hits++;
      }
      a.brierSum = round4(a.brierSum + mk.brier);
      a.logLossSum = round4(a.logLossSum + mk.logLoss);
      if (m === "oneX2" && Number.isFinite(mk.confidence)) {
        // Calibration: 自信(最大確率)の帯ごとに「実際に当たった割合」を貯める。
        // ご指示⑥(ECE): 帯ごとの「申告した自信の合計」も貯める。これで
        // ECE = Σ(帯の件数/全件数)×|帯の平均自信 − 帯の的中率| が厳密に出せる。
        const bin = mk.confidence < 0.45 ? "33-45" : mk.confidence < 0.55 ? "45-55" : mk.confidence < 0.7 ? "55-70" : "70+";
        a.calibration[bin].n++;
        if (mk.hit) a.calibration[bin].hits++;
        a.calibration[bin].confSum = round4((a.calibration[bin].confSum || 0) + mk.confidence);
      }
      // ご指示⑥(Precision/Recall/F1): クラス別の混同行列を積み上げる
      if (m === "oneX2" && mk.predicted && mk.actual && a.perClass[mk.predicted] && a.perClass[mk.actual]) {
        a.perClass[mk.predicted].pred++;
        a.perClass[mk.actual].actual++;
        if (mk.predicted === mk.actual) a.perClass[mk.predicted].correct++;
      }
      // v100: リーグ別・学習済み/未学習別(1X2のみ。採点結果に league / learned が添えられている場合)
      if (m === "oneX2") {
        a.byLeague = a.byLeague || {};
        let lk = leagueKeyOf(s.league, s.leagueCountry); // v101: 国名で同名大会を区別
        if (!a.byLeague[lk] && Object.keys(a.byLeague).length >= BY_LEAGUE_MAX_PER_DAY) lk = BY_LEAGUE_OTHER_KEY;
        a.byLeague[lk] = a.byLeague[lk] || { n: 0, hits: 0 };
        a.byLeague[lk].n++;
        if (mk.hit) a.byLeague[lk].hits++;
        // v101: リーグ別の引き分け較正の材料(実際の引き分け数と、予想した引き分け確率の合計)
        if (mk.actual === "draw") a.byLeague[lk].drawActual = (a.byLeague[lk].drawActual || 0) + 1;
        if (mk.probs && Number.isFinite(mk.probs.draw)) {
          a.byLeague[lk].drawPredSum = round4((a.byLeague[lk].drawPredSum || 0) + mk.probs.draw);
          a.byLeague[lk].drawPredN = (a.byLeague[lk].drawPredN || 0) + 1;
        }
        a.byLearned = a.byLearned || { learned: { n: 0, hits: 0 }, unlearned: { n: 0, hits: 0 }, unknown: { n: 0, hits: 0 } };
        const lb = s.learned === true ? "learned" : s.learned === false ? "unlearned" : "unknown";
        a.byLearned[lb].n++;
        if (mk.hit) a.byLearned[lb].hits++;
        // v101①: オッズあり/なし別(採点結果に oddsPresent が添えられている記録だけ)
        if (typeof s.oddsPresent === "boolean") {
          a.byOdds = a.byOdds || { withOdds: emptyOddsBucket(), noOdds: emptyOddsBucket() };
          const ob = s.oddsPresent ? a.byOdds.withOdds : a.byOdds.noOdds;
          ob.n++;
          if (mk.hit) ob.hits++;
          ob.brierSum = round4(ob.brierSum + mk.brier);
          ob.logLossSum = round4(ob.logLossSum + mk.logLoss);
        }
        // v101③: 朝版 vs 直前版(直前版の判定がある記録だけ。両方とも同じ試合で採点)
        const lc = s.lineupCompare;
        if (lc && Number.isFinite(lc.morningBrier) && Number.isFinite(lc.preKickBrier)) {
          a.lineup = a.lineup || emptyLineupCompare();
          a.lineup.n++;
          if (lc.morningHit) a.lineup.morningHits++;
          if (lc.preKickHit) a.lineup.preKickHits++;
          a.lineup.morningBrierSum = round4(a.lineup.morningBrierSum + lc.morningBrier);
          a.lineup.preKickBrierSum = round4(a.lineup.preKickBrierSum + lc.preKickBrier);
          if (Number.isFinite(lc.morningLogLoss)) a.lineup.morningLogLossSum = round4(a.lineup.morningLogLossSum + lc.morningLogLoss);
          if (Number.isFinite(lc.preKickLogLoss)) a.lineup.preKickLogLossSum = round4(a.lineup.preKickLogLossSum + lc.preKickLogLoss);
          if (lc.changed) {
            a.lineup.changed++;
            if (lc.preKickHit) a.lineup.changedPreKickHits++;
            if (lc.morningHit) a.lineup.changedMorningHits++;
          }
        }
      }
    }
    if (s.content) {
      agg.content = matchContent.addContentScore(agg.content || matchContent.emptyContentAgg(), s.content); // v104 J
    }
    if (s.markets.scoreline) {
      agg.scoreline.n++;
      if (s.markets.scoreline.hit) agg.scoreline.hits++;
      // ご指示⑥(Top3): top3Hitが採点されている記録だけを分母に数える
      // (古い採点結果にはtop3が無いため、無いものを外れ扱いにしない)。
      if (typeof s.markets.scoreline.top3Hit === "boolean") {
        agg.scoreline.top3N++;
        if (s.markets.scoreline.top3Hit) agg.scoreline.top3Hits++;
      }
    }
  }
  return agg;
}

function emptyDailyAccuracy() {
  const bins = () => ({ "33-45": { n: 0, hits: 0, confSum: 0 }, "45-55": { n: 0, hits: 0, confSum: 0 }, "55-70": { n: 0, hits: 0, confSum: 0 }, "70+": { n: 0, hits: 0, confSum: 0 } });
  const perClass = () => ({ home: { pred: 0, actual: 0, correct: 0 }, draw: { pred: 0, actual: 0, correct: 0 }, away: { pred: 0, actual: 0, correct: 0 } });
  return {
    oneX2: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins(), perClass: perClass() },
    btts: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    over25: { n: 0, hits: 0, brierSum: 0, logLossSum: 0, calibration: bins() },
    scoreline: { n: 0, hits: 0, top3N: 0, top3Hits: 0 },
  };
}

/** 同じ日の2回目以降の実行分を加算マージする(上書きで消さない) */
function mergeDailyAccuracy(a, b) {
  if (!a) return b; if (!b) return a;
  const out = emptyDailyAccuracy();
  for (const m of ["oneX2", "btts", "over25"]) {
    out[m].n = (a[m]?.n || 0) + (b[m]?.n || 0);
    out[m].hits = (a[m]?.hits || 0) + (b[m]?.hits || 0);
    out[m].brierSum = round4((a[m]?.brierSum || 0) + (b[m]?.brierSum || 0));
    out[m].logLossSum = round4((a[m]?.logLossSum || 0) + (b[m]?.logLossSum || 0));
    // 2026年8月18日: 公式戦だけのタリーも合算する(片方に無ければあるほうだけ)
    if (m === "oneX2" && ((a[m] && a[m].official) || (b[m] && b[m].official))) {
      out[m].official = {
        n: ((a[m] && a[m].official && a[m].official.n) || 0) + ((b[m] && b[m].official && b[m].official.n) || 0),
        hits: ((a[m] && a[m].official && a[m].official.hits) || 0) + ((b[m] && b[m].official && b[m].official.hits) || 0),
      };
    }
    for (const bin of Object.keys(out[m].calibration)) {
      out[m].calibration[bin].n = (a[m]?.calibration?.[bin]?.n || 0) + (b[m]?.calibration?.[bin]?.n || 0);
      out[m].calibration[bin].hits = (a[m]?.calibration?.[bin]?.hits || 0) + (b[m]?.calibration?.[bin]?.hits || 0);
      // 古い保存形式にはconfSumが無い → 0として加算(ECE側は「confSumの無い
      // 件が混ざった帯」を測定対象から外すため、嘘の自信0%にはならない)
      out[m].calibration[bin].confSum = round4((a[m]?.calibration?.[bin]?.confSum || 0) + (b[m]?.calibration?.[bin]?.confSum || 0));
    }
  }
  for (const cls of ["home", "draw", "away"]) {
    out.oneX2.perClass[cls].pred = (a.oneX2?.perClass?.[cls]?.pred || 0) + (b.oneX2?.perClass?.[cls]?.pred || 0);
    out.oneX2.perClass[cls].actual = (a.oneX2?.perClass?.[cls]?.actual || 0) + (b.oneX2?.perClass?.[cls]?.actual || 0);
    out.oneX2.perClass[cls].correct = (a.oneX2?.perClass?.[cls]?.correct || 0) + (b.oneX2?.perClass?.[cls]?.correct || 0);
  }
  // v100: リーグ別・学習済み/未学習別の合算(古い保存形式には無い → 片方だけでも合算できる)
  const leagueMaps = [a.oneX2?.byLeague, b.oneX2?.byLeague].filter((x) => x && typeof x === "object");
  if (leagueMaps.length) {
    out.oneX2.byLeague = {};
    for (const mp of leagueMaps) {
      for (const [k, v] of Object.entries(mp)) {
        if (!v) continue;
        let key = k;
        if (!out.oneX2.byLeague[key] && Object.keys(out.oneX2.byLeague).length >= BY_LEAGUE_MAX_PER_DAY * 3) key = BY_LEAGUE_OTHER_KEY;
        out.oneX2.byLeague[key] = out.oneX2.byLeague[key] || { n: 0, hits: 0 };
        const dst = out.oneX2.byLeague[key];
        dst.n += v.n || 0;
        dst.hits += v.hits || 0;
        // v101: 引き分け較正の材料も合算(古い保存形式には無い → 0 として足す)
        if (v.drawActual) dst.drawActual = (dst.drawActual || 0) + v.drawActual;
        if (v.drawPredN) {
          dst.drawPredN = (dst.drawPredN || 0) + v.drawPredN;
          dst.drawPredSum = round4((dst.drawPredSum || 0) + (v.drawPredSum || 0));
        }
      }
    }
  }
  // v101①: オッズあり/なし別の合算
  const oddsMaps = [a.oneX2?.byOdds, b.oneX2?.byOdds].filter((x) => x && typeof x === "object");
  if (oddsMaps.length) {
    out.oneX2.byOdds = { withOdds: emptyOddsBucket(), noOdds: emptyOddsBucket() };
    for (const mp of oddsMaps) {
      for (const k of ["withOdds", "noOdds"]) {
        const v = mp[k]; if (!v) continue;
        out.oneX2.byOdds[k].n += v.n || 0;
        out.oneX2.byOdds[k].hits += v.hits || 0;
        out.oneX2.byOdds[k].brierSum = round4(out.oneX2.byOdds[k].brierSum + (v.brierSum || 0));
        out.oneX2.byOdds[k].logLossSum = round4(out.oneX2.byOdds[k].logLossSum + (v.logLossSum || 0));
      }
    }
  }
  // v101③: 朝版 vs 直前版の合算
  const lineupMaps = [a.oneX2?.lineup, b.oneX2?.lineup].filter((x) => x && typeof x === "object");
  if (lineupMaps.length) {
    out.oneX2.lineup = emptyLineupCompare();
    for (const mp of lineupMaps) {
      for (const k of Object.keys(out.oneX2.lineup)) {
        const v = mp[k];
        if (!Number.isFinite(v)) continue;
        out.oneX2.lineup[k] = /Sum$/.test(k) ? round4(out.oneX2.lineup[k] + v) : out.oneX2.lineup[k] + v;
      }
    }
  }
  const learnedMaps = [a.oneX2?.byLearned, b.oneX2?.byLearned].filter((x) => x && typeof x === "object");
  if (learnedMaps.length) {
    out.oneX2.byLearned = { learned: { n: 0, hits: 0 }, unlearned: { n: 0, hits: 0 }, unknown: { n: 0, hits: 0 } };
    for (const mp of learnedMaps) {
      for (const lb of ["learned", "unlearned", "unknown"]) {
        out.oneX2.byLearned[lb].n += (mp[lb] && mp[lb].n) || 0;
        out.oneX2.byLearned[lb].hits += (mp[lb] && mp[lb].hits) || 0;
      }
    }
  }
  out.scoreline.n = (a.scoreline?.n || 0) + (b.scoreline?.n || 0);
  out.scoreline.hits = (a.scoreline?.hits || 0) + (b.scoreline?.hits || 0);
  out.scoreline.top3N = (a.scoreline?.top3N || 0) + (b.scoreline?.top3N || 0);
  out.scoreline.top3Hits = (a.scoreline?.top3Hits || 0) + (b.scoreline?.top3Hits || 0);
  // v104 J: 試合内容の集計(古い保存形式には無い → 片方だけでも合算)
  const contentMerged = matchContent.mergeContentAgg(a.content, b.content);
  if (contentMerged) out.content = contentMerged;
  return out;
}

/**
 * ご指示⑥(Precision/Recall/F1): クラス別混同行列からマクロ平均を計算する。
 * ・Precision(そのクラスを予測したときに当たっていた割合)は、そのクラスを
 *   一度も予測していなければ定義できない → 実際に出現しているクラスなら0点、
 *   そもそも出現していないクラスはマクロ平均から除外(嘘の0点で平均を
 *   下げない・嘘の満点で上げない)。
 */
function computePrecisionRecallF1(perClass) {
  if (!perClass) return { measurable: false, reasonJa: "クラス別の集計がまだ保存されていません(この機能の追加前に保存された記録です)。" };
  const CLASS_JA = { home: "ホーム勝ち", draw: "引き分け", away: "アウェイ勝ち" };
  const classes = [];
  for (const cls of ["home", "draw", "away"]) {
    const c = perClass[cls] || { pred: 0, actual: 0, correct: 0 };
    if (!c.pred && !c.actual) continue; // データに一度も出ていないクラスは評価しない
    const precision = c.pred > 0 ? c.correct / c.pred : (c.actual > 0 ? 0 : null);
    const recall = c.actual > 0 ? c.correct / c.actual : (c.pred > 0 ? 0 : null);
    const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
      ? (2 * precision * recall) / (precision + recall) : (precision === null || recall === null ? null : 0);
    classes.push({
      cls, labelJa: CLASS_JA[cls], predicted: c.pred, actual: c.actual, correct: c.correct,
      precision: precision === null ? null : round4(precision),
      recall: recall === null ? null : round4(recall),
      f1: f1 === null ? null : round4(f1),
    });
  }
  const usable = classes.filter((c) => c.precision !== null && c.recall !== null);
  if (!usable.length) return { measurable: false, reasonJa: "混同行列に件数がまだありません。", classes };
  const mean = (key) => round4(usable.reduce((s, c) => s + c[key], 0) / usable.length);
  return {
    measurable: true,
    macroPrecision: mean("precision"), macroRecall: mean("recall"), macroF1: mean("f1"),
    evaluatedClasses: usable.length,
    classes,
    noteJa: "3クラス(ホーム勝ち/引き分け/アウェイ勝ち)のマクロ平均です。データに出現したクラスだけで平均しています。",
  };
}

/**
 * ご指示⑥(ECE): 較正の帯ごとの |平均自信 − 実際の的中率| を件数で加重平均する。
 * confSumはこの機能の追加後に保存された記録にしか無いため、confSumの無い帯は
 * 測定対象から正直に外す(0%の自信と偽って計算しない)。
 */
function computeEce(calibration) {
  if (!calibration) return { measurable: false, reasonJa: "較正の帯がまだ保存されていません。" };
  let totalN = 0, coveredN = 0, weighted = 0;
  const binDetails = [];
  for (const [bin, v] of Object.entries(calibration)) {
    if (!v || !v.n) continue;
    totalN += v.n;
    if (!(v.confSum > 0)) continue; // 旧形式(自信の合計が無い)は測定不能として除外
    const avgConf = v.confSum / v.n;
    const hitRate = v.hits / v.n;
    coveredN += v.n;
    weighted += v.n * Math.abs(avgConf - hitRate);
    binDetails.push({ bin: `${bin}%`, n: v.n, avgConfPct: round1(avgConf * 100), actualHitPct: round1(hitRate * 100), gapPt: round1(Math.abs(avgConf - hitRate) * 100) });
  }
  if (!coveredN) return { measurable: false, reasonJa: totalN ? "自信の合計(confSum)が保存される前の記録のため、ECEは計算できません(新しい採点分から自動的に測定されます)。" : "採点済みの予測がまだありません。", bins: [] };
  return {
    measurable: true,
    ece: round4(weighted / coveredN),
    ecePct: round1((weighted / coveredN) * 100),
    measuredOnN: coveredN, totalN,
    bins: binDetails,
    noteJa: `ECE = 自信の帯ごとの|平均自信−実際の的中率|の加重平均(0が最良)。${coveredN < totalN ? `全${totalN}件のうち自信が記録されている${coveredN}件で測定。` : ""}`,
  };
}

/** v100: リーグ別の内訳(件数の多い順・上位25)。記録の無い古い集計は measurable:false */
function summarizeByLeague(byLeague) {
  if (!byLeague || typeof byLeague !== "object") {
    return { measurable: false, reasonJa: "リーグ別の集計はこの機能(v100)の追加後に答え合わせした分から記録されます。", rows: [] };
  }
  const rows = Object.entries(byLeague)
    .filter(([, v]) => v && v.n > 0)
    .map(([k, v]) => {
      const row = { league: k === BY_LEAGUE_OTHER_KEY ? "その他" : k, n: v.n, hits: v.hits, hitRatePct: round1((v.hits / v.n) * 100) };
      // v101: 引き分け較正(予想した引き分け確率の平均 vs 実際の引き分け率。材料のある行だけ)
      if (v.drawPredN > 0) {
        row.drawActualPct = round1(((v.drawActual || 0) / v.n) * 100);
        row.drawPredAvgPct = round1(((v.drawPredSum || 0) / v.drawPredN) * 100);
        row.drawGapPt = round1(row.drawPredAvgPct - row.drawActualPct); // マイナス=引き分けを過小評価
      }
      return row;
    })
    .sort((a, b) => b.n - a.n || a.league.localeCompare(b.league));
  const totalN = rows.reduce((s, r) => s + r.n, 0);
  const drawRows = rows.filter((r) => Number.isFinite(r.drawGapPt) && r.n >= 10);
  return {
    measurable: rows.length > 0,
    leagues: rows.length, totalN,
    rows: rows.slice(0, 25),
    // 母数5件以上で、全体より15pt以上低いリーグ(弱点の候補。断定はしない)
    weakRows: (() => {
      const overall = totalN ? rows.reduce((s, r) => s + r.hits, 0) / totalN * 100 : null;
      if (overall === null) return [];
      return rows.filter((r) => r.n >= 5 && r.hitRatePct <= overall - 15).slice(0, 8);
    })(),
    // v101: 引き分けを最も過小評価しているリーグ(母数10件以上・差の大きい順)。★5 の材料
    drawCalibration: drawRows.length ? {
      measurable: true,
      rows: [...drawRows].sort((a, b) => a.drawGapPt - b.drawGapPt).slice(0, 10).map((r) => ({ league: r.league, n: r.n, drawActualPct: r.drawActualPct, drawPredAvgPct: r.drawPredAvgPct, drawGapPt: r.drawGapPt })),
      overall: (() => {
        let n = 0, act = 0, predSum = 0, predN = 0;
        for (const v of Object.values(byLeague)) { if (!v || !(v.drawPredN > 0)) continue; n += v.n; act += v.drawActual || 0; predSum += v.drawPredSum || 0; predN += v.drawPredN; }
        return n ? { n, drawActualPct: round1((act / n) * 100), drawPredAvgPct: round1((predSum / predN) * 100), drawGapPt: round1(((predSum / predN) - (act / n)) * 100) } : null;
      })(),
      noteJa: "予想した引き分け確率の平均と、実際に引き分けだった割合の差(マイナス=引き分けを少なく見積もっている)。予想の選び方(最大確率)は変えずに、確率の正しさを直す材料です。",
    } : { measurable: false, reasonJa: "引き分け較正はこの機能(v101)の追加後に答え合わせした分から記録されます(母数10件以上のリーグから表示)。" },
    noteJa: "1X2の的中率をリーグ(大会)別に数えたものです。母数の小さいリーグは偶然で大きく動くため、5件未満は弱点の判定に使いません。同名の大会は国名で区別します(v101)。",
  };
}

/** v101①: オッズあり(市場合成)/ オッズなし(自前モデル単独)別の成績 */
function summarizeByOdds(byOdds) {
  if (!byOdds || typeof byOdds !== "object") {
    return { measurable: false, reasonJa: "オッズあり/なし別の集計はこの機能(v101)の追加後に答え合わせした分から記録されます。" };
  }
  const row = (v) => (v && v.n > 0)
    ? { n: v.n, hits: v.hits, hitRatePct: round1((v.hits / v.n) * 100), avgBrier: round4(v.brierSum / v.n), avgLogLoss: round4(v.logLossSum / v.n), skill: skillOf(v.logLossSum / v.n, v.brierSum / v.n) }
    : { n: 0, hits: 0, hitRatePct: null, avgBrier: null, avgLogLoss: null, skill: null };
  const withOdds = row(byOdds.withOdds), noOdds = row(byOdds.noOdds);
  const total = withOdds.n + noOdds.n;
  return {
    measurable: total > 0,
    withOdds, noOdds,
    noOddsSharePct: total ? round1((noOdds.n / total) * 100) : null,
    gapPt: (withOdds.hitRatePct !== null && noOdds.hitRatePct !== null) ? round1(withOdds.hitRatePct - noOdds.hitRatePct) : null,
    noteJa: "「オッズあり」=市場オッズと合成して判定した予想。「オッズなし」=オッズが取れず自前モデル単独で判定した予想(最も弱い状態)。差が大きいほど、オッズ取得率を上げる(★3)効果が大きいことを示します。",
  };
}

/** v101③: 朝版(公式の予想)と直前版(確定スタメン+直前オッズ)の同一試合比較 */
function summarizeLineupCompare(lineup) {
  if (!lineup || !(lineup.n > 0)) {
    return { measurable: false, reasonJa: "朝版 vs 直前版の比較はこの機能(v101)の追加後に答え合わせした分から記録されます(直前情報が取れた試合のみ)。" };
  }
  const n = lineup.n;
  const side = (hits, brierSum, llSum) => ({
    hitRatePct: round1((hits / n) * 100),
    avgBrier: round4(brierSum / n),
    avgLogLoss: Number.isFinite(llSum) && llSum > 0 ? round4(llSum / n) : null,
  });
  const morning = side(lineup.morningHits, lineup.morningBrierSum, lineup.morningLogLossSum);
  const preKick = side(lineup.preKickHits, lineup.preKickBrierSum, lineup.preKickLogLossSum);
  return {
    measurable: true, n,
    morning, preKick,
    deltaHitPt: round1(preKick.hitRatePct - morning.hitRatePct),
    deltaBrier: round4(preKick.avgBrier - morning.avgBrier), // マイナス=直前版が良い
    changed: lineup.changed || 0,
    changedPreKickHits: lineup.changedPreKickHits || 0,
    changedMorningHits: lineup.changedMorningHits || 0,
    noteJa: "同じ試合について、朝の公式予想と、確定スタメン・直前オッズで計算し直した直前版を両方採点したもの。Brier の差がマイナスなら直前版の方が確率が良い。「判定が変わった試合」は直前版が別の勝敗を選んだ試合の数と、その的中数です(★6 の判断材料。公式の予想は朝版のまま)。",
  };
}

/** v100: 学習済み大会 / 未学習大会 / 不明(旧記録)の内訳 */
function summarizeByLearned(byLearned) {
  if (!byLearned || typeof byLearned !== "object") {
    return { measurable: false, reasonJa: "学習済み/未学習別の集計はこの機能(v100)の追加後に答え合わせした分から記録されます。" };
  }
  const row = (v) => (v && v.n > 0) ? { n: v.n, hits: v.hits, hitRatePct: round1((v.hits / v.n) * 100) } : { n: 0, hits: 0, hitRatePct: null };
  const learned = row(byLearned.learned), unlearned = row(byLearned.unlearned), unknown = row(byLearned.unknown);
  return {
    measurable: (learned.n + unlearned.n + unknown.n) > 0,
    learned, unlearned, unknown,
    gapPt: (learned.hitRatePct !== null && unlearned.hitRatePct !== null) ? round1(learned.hitRatePct - unlearned.hitRatePct) : null,
    noteJa: "「学習済み」=AIが過去試合を取り込んでいる大会(地力レーティングが効く)。「未学習」=学習データの無い大会(市場オッズとフォーム等だけで予想)。差が大きいほど、学習対象の拡張で上がる余地が大きいことを示します。",
  };
}

/** 集計を人間が読む形(的中率%・平均Brier・平均LogLoss・較正表)へ変換 */
function summarizeAccuracy(agg) {
  if (!agg) return null;
  const marketJa = { oneX2: "勝敗(1X2)", btts: "両チーム得点(BTTS)", over25: "オーバー/アンダー2.5" };
  const out = { markets: {}, scoreline: null };
  let any = false;
  for (const m of ["oneX2", "btts", "over25"]) {
    const a = agg[m];
    if (!a || !a.n) { out.markets[m] = { labelJa: marketJa[m], n: 0, measurable: false }; continue; }
    any = true;
    out.markets[m] = {
      labelJa: marketJa[m], measurable: true, n: a.n,
      hitRatePct: round1((a.hits / a.n) * 100),
      // 2026年8月18日: 公式戦(親善・2軍を除く)だけの的中率。
      // この区分の記録が始まる前のデータには無いので、無ければ正直にnull。
      official: (m === "oneX2" && a.official && a.official.n > 0)
        ? { n: a.official.n, hitRatePct: round1((a.official.hits / a.official.n) * 100) }
        : null,
      avgBrier: round4(a.brierSum / a.n),
      avgLogLoss: round4(a.logLossSum / a.n),
      calibration: Object.entries(a.calibration)
        .filter(([, v]) => v.n > 0)
        .map(([bin, v]) => ({ bin: `${bin}%`, n: v.n, actualHitPct: round1((v.hits / v.n) * 100) })),
    };
    // ご指示⑥: 1X2にはPrecision/Recall/F1(マクロ平均)とECEを追加する
    if (m === "oneX2") {
      out.markets.oneX2.precisionRecallF1 = computePrecisionRecallF1(a.perClass);
      out.markets.oneX2.ece = computeEce(a.calibration);
      // v100: 技能スコア(当てずっぽう基準)・リーグ別・学習済み/未学習別
      out.markets.oneX2.skill = skillOf(a.logLossSum / a.n, a.brierSum / a.n);
      out.markets.oneX2.byLeague = summarizeByLeague(a.byLeague);
      out.markets.oneX2.byLearned = summarizeByLearned(a.byLearned);
      // v101: オッズあり/なし別・朝版 vs 直前版
      out.markets.oneX2.byOdds = summarizeByOdds(a.byOdds);
      out.markets.oneX2.lineupCompare = summarizeLineupCompare(a.lineup);
    }
  }
  if (agg.scoreline && agg.scoreline.n) {
    out.scoreline = {
      n: agg.scoreline.n,
      hitRatePct: round1((agg.scoreline.hits / agg.scoreline.n) * 100),
      // ご指示⑥(Top1/Top3): Top1=予測スコアそのものの一致率。Top3=同じ
      // ポアソン格子の上位3スコアのどれかが実スコアだった割合(採点済み分のみ)。
      top1HitRatePct: round1((agg.scoreline.hits / agg.scoreline.n) * 100),
      top3: (agg.scoreline.top3N > 0)
        ? { n: agg.scoreline.top3N, hitRatePct: round1((agg.scoreline.top3Hits / agg.scoreline.top3N) * 100) }
        : { n: 0, measurable: false, reasonJa: "Top3の採点はこの機能の追加後の答え合わせから記録されます。" },
      noteJa: "1X2のTop3的中率は3クラスしか無いため定義上100%になり無意味です。そのためTop3は最も難しい「スコア一致」で測っています。",
    };
  }
  // v104 J: 試合内容の予測(λ版 vs 整合版・表示した確率の較正)
  out.matchContent = matchContent.summarizeContentAgg(agg.content);
  out.measurable = any;
  if (!any) out.reasonJa = "この期間に答え合わせできた予測がありません(試合が無い・まだ結果が出ていない場合は正常です)。";
  return out;
}

async function saveDailyAccuracy(deps, dateKey, aggToday) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON, upstashCmd } = deps || {};
  if (!upstashEnabled || !dateKey || !aggToday) return false;
  try {
    // v97(全体監査): 「読めなかった」のに「無かった」と見なして上書きすると、同じ日の
    //   先に保存した採点(1日2回の実行・自動収集の答え合わせ)が消える。upstashCmd があれば
    //   失敗を区別し、失敗した日は保存を見送る(false を返す=呼び出し側が痕跡を残す)。
    let existing = null;
    if (typeof upstashCmd === "function") {
      try {
        const raw = await upstashCmd(["GET", `${ACCURACY_KEY_PREFIX}${dateKey}`]);
        existing = raw === null || raw === undefined ? null : (typeof raw === "object" ? raw : JSON.parse(raw));
      } catch (e) { return false; }
    } else {
      existing = await upstashGetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`).catch(() => null);
    }
    const merged = mergeDailyAccuracy(existing, aggToday);
    const ok = await upstashSetJSON(`${ACCURACY_KEY_PREFIX}${dateKey}`, merged);
    return ok !== false;
  } catch (e) { return false; }
}

/**
 * 昨日・直近7日・直近30日との比較(ご指示⑨「昨日/先週/先月との比較」)。
 * 記録の無い日は欠落として扱い、推測で埋めない。
 */
// ---- v92(2026年9月18日): 30日ぶんの日次集計を「1件ずつ30往復」から「1回のMGET」へ ----
//   実測: /api/learning/daily-report のキャッシュ切れ直後の1回目が6日連続でタイムアウト。
//   原因はこの関数の for ループ(await を30回直列=30往復)。読む内容・返す数字は
//   まったく同じで、往復回数だけを減らす(2026年8月8日のpipeline化と同じ考え方)。
//   MGETが使えない環境(depsにupstashCmdが無い/モック/応答が配列でない)は従来の
//   1件ずつの読み出しにそのまま戻る=結果は常に同一。
async function readDailyAggregates(deps, keys) {
  const { upstashCmd, upstashGetJSON } = deps || {};
  if (typeof upstashCmd === "function" && keys.length) {
    try {
      const raw = await upstashCmd(["MGET", ...keys]);
      if (Array.isArray(raw) && raw.length === keys.length) {
        return {
          readMode: "mget", // v92: 本番で「速い経路が実際に使われたか」を確認できるように残す
          values: raw.map((v) => {
            if (v === null || v === undefined) return null;
            if (typeof v === "object") return v; // 既に展開済みの応答にも耐える
            try { return JSON.parse(v); } catch (e) { return null; }
          }),
        };
      }
    } catch (e) { /* 従来経路(1件ずつ)へ。readMode="per-key" として結果に残る=黙らない */ }
  }
  // ---- v94: 1件ずつの経路では「読めなかった」を数える ----
  //   9/25朝の本番で、保存先の一時失敗により30日中11日ぶんしか読めず、
  //   「27日→11日で52%」と劣化した数字を(失敗と分からない形で)返していた。
  //   upstashGetJSON は失敗を null に潰すため、upstashCmd があればそちらで読んで失敗を数える。
  const out = [];
  let readFailures = 0;
  for (const k of keys) {
    if (typeof upstashCmd === "function") {
      try {
        const raw = await upstashCmd(["GET", k]);
        if (raw === null || raw === undefined) { out.push(null); continue; }
        if (typeof raw === "object") { out.push(raw); continue; }
        try { out.push(JSON.parse(raw)); } catch (e) { out.push(null); }
      } catch (e) { readFailures++; out.push(null); }
    } else {
      out.push(await upstashGetJSON(k).catch(() => { readFailures++; return null; }));
    }
  }
  return { readMode: "per-key", values: out, readFailures };
}

async function getAccuracyTrend(deps, todayDateKey) {
  const { upstashEnabled } = deps || {};
  if (!upstashEnabled) return { available: false, reasonJa: "Upstashが未設定のため測定記録を読み出せません。" };
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const dateKeys = [];
  for (let i = 0; i < 30; i++) dateKeys.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  const read = await readDailyAggregates(deps, dateKeys.map((dk) => `${ACCURACY_KEY_PREFIX}${dk}`));
  // v94: 全日が読めなかった=保存先の障害。数字を出さず、正直に available:false で返す
  if (read.readFailures && read.readFailures >= dateKeys.length) {
    return {
      available: false, readFailed: true, readMode: read.readMode, readFailures: read.readFailures,
      reasonJa: "保存先(Upstash)から精度の記録を読み出せませんでした(記録が無いという意味ではありません)。",
    };
  }
  const aggs = read.values;
  const daily = [];
  dateKeys.forEach((dk, i) => { if (aggs[i]) daily.push({ date: dk, agg: aggs[i] }); });
  const sumRange = (rows) => rows.reduce((acc, r) => mergeDailyAccuracy(acc, r.agg), null);
  const today = daily.find((d) => d.date === todayDateKey) || null;
  const yesterdayKey = new Date(base - 86400000).toISOString().slice(0, 10);
  const yesterday = daily.find((d) => d.date === yesterdayKey) || null;
  const last7 = sumRange(daily.filter((d) => d.date !== todayDateKey).slice(0, 7));
  const last30 = sumRange(daily.filter((d) => d.date !== todayDateKey));
  const s = (agg) => summarizeAccuracy(agg);
  const t = today ? s(today.agg) : null;
  const y = yesterday ? s(yesterday.agg) : null;
  return {
    available: true,
    recordedDays: daily.length,
    readMode: read.readMode, // v92: "mget"(1往復) / "per-key"(従来の30往復)。数字は両経路で同一
    // v94: 一部の日が読めなかった場合、その日数(0=全部読めた)。>0 なら 7日/30日の数字は不完全
    readFailures: read.readFailures || 0,
    partial: (read.readFailures || 0) > 0,
    partialNoteJa: (read.readFailures || 0) > 0
      ? `${read.readFailures}日ぶんの記録を保存先から読み出せなかったため、7日/30日の数字は不完全です(読めた日だけの集計)。`
      : null,
    today: t, yesterday: y, last7Days: s(last7), last30Days: s(last30),
    // 「前日より精度が何%改善したか」: 両日とも測定できた市場だけ差を出す
    vsYesterday: (t && y && t.markets.oneX2.measurable && y.markets.oneX2.measurable)
      ? {
        hitRateDeltaPct: round1(t.markets.oneX2.hitRatePct - y.markets.oneX2.hitRatePct),
        brierDelta: round4(t.markets.oneX2.avgBrier - y.markets.oneX2.avgBrier),
        logLossDelta: round4(t.markets.oneX2.avgLogLoss - y.markets.oneX2.avgLogLoss),
        noteJa: "Brier/LogLossはマイナス(減少)が改善です。",
      }
      : { noteJa: "昨日か今日のどちらかに答え合わせできた予測が無いため、前日比は測定できません。" },
  };
}

module.exports = {
  ACCURACY_KEY_PREFIX,
  computeMarketProbs, outcomesFromScore, scorePrediction, topScorelines,
  oneX2ProbsOf, confidenceOnPickOf, // v97
  buildDailyAccuracy, mergeDailyAccuracy, emptyDailyAccuracy,
  computePrecisionRecallF1, computeEce,
  summarizeAccuracy, saveDailyAccuracy, getAccuracyTrend, readDailyAggregates,
  skillOf, summarizeByLeague, summarizeByLearned, leagueKeyOf, LN3, UNIFORM_BRIER_3WAY, // v100
  summarizeByOdds, summarizeLineupCompare, emptyOddsBucket, emptyLineupCompare, // v101
};
