"use strict";
/**
 * server/learning/confidenceTiers.js
 * ------------------------------------------------
 * v104.1(2026年11月14日)K「確信ピック」: 予想ごとの自信ランク(S / A / B / 見送り)と、その実績。
 *
 * ■ なぜ必要か(本番実測 11/14・直近30日 666件)
 *   全体の的中率は 57.4% だが、自信の帯で中身がまったく違う:
 *     自信 70%以上 … 98件で 73.5% / 55〜70% … 187件で 61.5% /
 *     45〜55% … 167件で 56.3% / 45%未満 … 214件で 47.2%
 *   「57%当たるAI」ではなく「自信がある試合は7割強当たり、自信がない試合は半々」というのが実像。
 *   これを予想カードの上で一目で分かるようにし、ランクごとの実績を毎日数える。
 *
 * ■ 何をするか
 *   ・自信 = 予想カードに出している数字そのもの(AI が予想した勝敗に与えた確率を、実測で補正した値)。
 *     新しい数字は作らない。カードの数字とランクが食い違わないよう、同じ計算(displayConfOf)を使う。
 *   ・ランク: S = 自信が tS 以上 / A = 60%以上 / B = 50%以上 / 見送り = 50%未満。
 *     A と見送りの境は固定。S の境(tS・既定70%)だけを毎晩の学習で決める。
 *   ・tS の学習: 答え合わせ済みの記録を時系列で前70%(学習)・後30%(検証)に分け、
 *     「その境以上の予想の的中率が目標(75%)に届く、いちばん低い境」(65〜80%の範囲)を学習側で選び、
 *     検証側でも崩れていない(目標−7ポイント以上)ときだけ採用する。迷ったら現状維持。
 *   ・予想を立てた時点でランクを記録に刻み(後出しで変えない)、答え合わせでランク別に採点する。
 *
 * ■ 守ること(劣化禁止・でっち上げ防止)
 *   ・勝敗の予想・確率は一切変えない(ランクは見せ方と計測だけ=的中率は数学的に不変)。
 *   ・対象は「公式戦」かつ「学習している大会」だけ。親善試合・未学習の大会にはランクを付けない
 *     (当てにならない場面で S を出さない)。付けなかった理由は言葉で残す。
 *   ・実績は実測だけ。件数が少ないランクは「まだ◯件」と件数を添え、割合だけを独り歩きさせない。
 *   ・「見送り」は「予想しない」ではない。予想は出し続け、自信が低いことを正直に伝える印。
 */

const { applyCalibration: applyBinCalibration } = require("./calibrationCorrection");

const MODEL_KEY = "learn:tiers:model";
const RANKS = ["S", "A", "B", "skip"];
const RANK_LABELS_JA = { S: "確信", A: "有力", B: "やや優勢", skip: "見送り" };
const RANK_MEANING_JA = {
  S: "AIの自信がいちばん高い試合",
  A: "AIの自信が高めの試合",
  B: "どちらかがやや優勢と見ている試合",
  skip: "AIの見立てでも当たる見込みが5割に届かない試合(予想は出しますが、自信はありません)",
};
const DEFAULT_THRESHOLDS = { tS: 0.7, tA: 0.6, tSkip: 0.5 };

const DEFAULT_OPTS = {
  target: 0.75,        // S の的中率の目標
  minTotal: 150,       // これ未満の件数では学習しない(既定のまま)
  minTrain: 40,        // 学習側で、その境以上の予想がこの件数以上あること
  minValid: 15,        // 検証側で同じく
  validTolerance: 0.07, // 検証側の的中率は 目標−7ポイント 以上
  lowerBoundSlack: 0.07, // 学習側の下限(ウィルソン・約84%片側)は 目標−7ポイント 以上
  // S の境を探す範囲。下限 65% は「S と呼ぶからには、AI自身の確率が65%以上」という最低条件
  // (まとめた的中率が目標に届くからといって、境を下げて S を薄めない)。
  gridMin: 0.65,
  gridMax: 0.8,
  gridStep: 0.025,
  hysteresis: 0.05,    // 前回の境との差がこれ未満なら動かさない(毎晩ふらつかせない)
  trainShare: 0.7,
  minForwardForDisplay: 20, // 刻印つきの実績をカードに出す最小件数(未満は過去の当てはめを使う)
};

function round4(v) { return Math.round(v * 10000) / 10000; }
function round1(v) { return Math.round(v * 10) / 10; }
function pct(hits, n) { return n > 0 ? round1((hits / n) * 100) : null; }

/** ウィルソンの下限(片側)。z=1.0 は約84%。件数が少ないほど低く出る=少数の当たりを過信しない */
function wilsonLower(hits, n, z) {
  if (!(n > 0)) return null;
  const zz = Number.isFinite(z) ? z : 1.0;
  const p = hits / n;
  const denom = 1 + (zz * zz) / n;
  const centre = p + (zz * zz) / (2 * n);
  const margin = zz * Math.sqrt((p * (1 - p)) / n + (zz * zz) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function thresholdsOf(model) {
  const t = (model && model.thresholds) || {};
  const tA = DEFAULT_THRESHOLDS.tA;
  const tSkip = DEFAULT_THRESHOLDS.tSkip;
  let tS = Number(t.tS);
  if (!Number.isFinite(tS) || tS < DEFAULT_OPTS.gridMin - 1e-9 || tS > DEFAULT_OPTS.gridMax + 1e-9) tS = DEFAULT_THRESHOLDS.tS;
  return { tS: round4(tS), tA, tSkip };
}

/** 自信(0〜1)からランクを決める */
function rankOf(conf, thresholds) {
  if (!Number.isFinite(conf)) return null;
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (conf >= t.tS - 1e-9) return "S";
  if (conf >= t.tA - 1e-9) return "A";
  if (conf >= t.tSkip - 1e-9) return "B";
  return "skip";
}

/** 予想した勝敗に与えていた確率(最終確率・補正前)。取れなければ null(λからの再計算はしない=後から数字を作らない) */
function rawConfidenceOf(record) {
  if (!record || !record.predictedWinner) return null;
  const fp = record.finalProbs;
  if (!fp) return null;
  const h = fp.homeWin, d = fp.draw, a = fp.awayWin;
  if (![h, d, a].every((v) => Number.isFinite(v) && v >= 0)) return null;
  const total = h + d + a;
  if (!(total > 0)) return null;
  const v = record.predictedWinner === "home" ? h : record.predictedWinner === "away" ? a : record.predictedWinner === "draw" ? d : null;
  return Number.isFinite(v) ? v / total : null;
}

/**
 * 予想カードに出す自信(主表示の数字)と同じ値を返す。
 *   ・予想時に温度較正を適用済みの記録 … 最終確率そのまま(既に較正後)
 *   ・それ以外で、近い自信帯の実測が十分ある … 帯ごとの実測をなめらかにつないだ曲線で補正(learn:calibration:map。
 *     v104.1: 帯の境目で数字が逆転しない=モデルの値が高い予想ほどランクも同じか上になる)
 *   ・補正できる実測が無い … 最終確率そのまま
 * server.js の buildTodayPredictionEntry(confidence.displayPct)と同じ規則。食い違わないようテストで固定している。
 * @returns {{conf:number, rawConf:number, basis:"temperature"|"bin"|"raw"}|null}
 */
function displayConfOf(record, calibrationMap) {
  const raw = rawConfidenceOf(record);
  if (raw === null) return null;
  const rawPct = raw * 100;
  const tempApplied = !!(record.probCalibration && record.probCalibration.applied === true && record.rawFinalProbs);
  if (tempApplied) return { conf: Math.round(rawPct) / 100, rawConf: round4(raw), basis: "temperature" };
  const cal = applyBinCalibration(rawPct, calibrationMap);
  if (cal) return { conf: cal.calibratedPct / 100, rawConf: round4(raw), basis: "bin" };
  return { conf: Math.round(rawPct) / 100, rawConf: round4(raw), basis: "raw" };
}

/** ランクを付ける対象か(公式戦・学習している大会・最終確率がある) */
function eligibilityOf(record) {
  if (!record) return { eligible: false, reasonJa: "予想の記録がありません。" };
  if (record.official === false) return { eligible: false, reasonJa: "親善試合・2軍の試合のため、ランクの対象外です。" };
  if (record.learnedCompetition === false) return { eligible: false, reasonJa: "AIがまだ学習していない大会のため、ランクの対象外です。" };
  if (rawConfidenceOf(record) === null) return { eligible: false, reasonJa: "この予想には最終確率が記録されていないため、ランクを付けられません。" };
  return { eligible: true, reasonJa: null };
}

/**
 * 予想の記録に刻むランク。予想を立てた時点の境(model)と自信(カードに出す数字)で決め、以後は変えない。
 * @returns {{rank:string|null, conf:number|null, rawConf?:number, basis?:string, tS:number, tA:number, tSkip:number, v:number, reasonJa?:string}}
 */
function stampFor(record, model, calibrationMap) {
  const t = thresholdsOf(model);
  const el = eligibilityOf(record);
  const base = { tS: t.tS, tA: t.tA, tSkip: t.tSkip, v: 1 };
  if (!el.eligible) return { rank: null, conf: null, ...base, reasonJa: el.reasonJa };
  const dc = displayConfOf(record, calibrationMap);
  return { rank: rankOf(dc.conf, t), conf: dc.conf, rawConf: dc.rawConf, basis: dc.basis, ...base };
}

/** 記録の自信(ランクの材料): 刻印があればその値(予想時点の数字)、無ければ今の補正で計算した値 */
function confOfRecord(record, calibrationMap) {
  if (record && record.tier && Number.isFinite(record.tier.conf) && RANKS.includes(record.tier.rank)) return record.tier.conf;
  const dc = displayConfOf(record, calibrationMap);
  return dc ? dc.conf : null;
}

function emptyTable() {
  const o = {};
  for (const r of RANKS) o[r] = { n: 0, hits: 0, confSum: 0 };
  return o;
}

function finishTable(tbl) {
  const out = {};
  let n = 0;
  for (const r of RANKS) {
    const c = tbl[r] || { n: 0, hits: 0, confSum: 0 };
    n += c.n;
    const low = wilsonLower(c.hits, c.n, 1.0);
    out[r] = {
      n: c.n, hits: c.hits, hitPct: pct(c.hits, c.n),
      avgConfPct: c.n > 0 ? round1((c.confSum / c.n) * 100) : null,
      lowPct: low === null ? null : round1(low * 100),
    };
  }
  for (const r of RANKS) out[r].sharePct = n > 0 ? round1((out[r].n / n) * 100) : null;
  out.total = n;
  return out;
}

/** 学習・集計の材料: 答え合わせ済み・対象内の記録を {conf, hit, t} にする(古い順) */
function samplesFrom(records, calibrationMap) {
  const out = [];
  for (const r of records || []) {
    if (!r || r.resolved !== true || !r.actualWinner || !r.predictedWinner) continue;
    if (!eligibilityOf(r).eligible) continue;
    const conf = confOfRecord(r, calibrationMap);
    if (conf === null) continue;
    const t = Date.parse(r.kickoff || r.resolvedAt || r.loggedAt || "");
    if (!Number.isFinite(t)) continue;
    // stampedRank: 予想時に刻んだランク(刻印のある記録だけ。前向きの実績の材料)
    const stampedRank = (r.tier && RANKS.includes(r.tier.rank)) ? r.tier.rank : null;
    out.push({ conf, hit: r.predictedWinner === r.actualWinner, t, stampedRank });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 前向きの実績: 予想時に刻んだランクのまま数える(境が後で動いても数え直さない) */
function forwardTableOf(samples) {
  const tbl = emptyTable();
  for (const s of samples) {
    if (!s.stampedRank) continue;
    tbl[s.stampedRank].n++;
    if (s.hit) tbl[s.stampedRank].hits++;
    tbl[s.stampedRank].confSum += s.conf;
  }
  return finishTable(tbl);
}

function tableOf(samples, thresholds) {
  const tbl = emptyTable();
  for (const s of samples) {
    const rank = rankOf(s.conf, thresholds);
    if (!rank) continue;
    tbl[rank].n++;
    if (s.hit) tbl[rank].hits++;
    tbl[rank].confSum += s.conf;
  }
  return finishTable(tbl);
}

function atOrAbove(samples, t) {
  let n = 0, hits = 0;
  for (const s of samples) { if (s.conf >= t - 1e-9) { n++; if (s.hit) hits++; } }
  return { n, hits, rate: n > 0 ? hits / n : null };
}

/**
 * S の境(tS)を学習する。
 * @param {Array<object>} records - 答え合わせ済みの予想記録(learn:ownpred:recent)
 * @param {{prevModel?:object, nowIso?:string, opts?:object, calibrationMap?:object}} [ctx]
 *   calibrationMap: 刻印の無い旧記録の自信を「今の補正」で計算するための較正マップ(learn:calibration:map)
 */
function fitTierModel(records, ctx) {
  const c = ctx || {};
  const o = { ...DEFAULT_OPTS, ...(c.opts || {}) };
  const nowIso = c.nowIso || new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const prev = thresholdsOf(c.prevModel);
  const hadPrev = !!(c.prevModel && c.prevModel.thresholds && Number.isFinite(Number(c.prevModel.thresholds.tS)));
  const samples = samplesFrom(records, c.calibrationMap || null);
  const model = {
    v: 1, fittedAt: nowIso, target: o.target,
    thresholds: { ...prev }, adopted: false, decision: "kept", reasonJa: null,
    samples: { total: samples.length, train: 0, valid: 0, from: samples.length ? new Date(samples[0].t).toISOString().slice(0, 10) : null, to: samples.length ? new Date(samples[samples.length - 1].t).toISOString().slice(0, 10) : null },
    candidates: [],
  };
  const finish = () => {
    const cut30 = nowMs - 30 * 86400000;
    const last30 = samples.filter((s) => s.t >= cut30);
    // table   = 今の境を、答え合わせ済みの過去の予想に当てはめた実測(導入直後から見られる)
    // forward = 予想時に刻んだランクのまま数えた実績(刻印は v104.1 以降の予想だけ。後出しなしの証拠)
    model.table = { all: tableOf(samples, model.thresholds), last30: tableOf(last30, model.thresholds) };
    model.forward = { all: forwardTableOf(samples), last30: forwardTableOf(last30) };
    return model;
  };
  if (samples.length < o.minTotal) {
    model.decision = hadPrev ? "kept_previous" : "kept_default";
    model.reasonJa = `答え合わせ済みで対象内(公式戦・学習済みの大会)の予想が ${samples.length}件 で、学習に必要な ${o.minTotal}件 に届いていないため、Sの境は${hadPrev ? "前回" : "既定"}の ${Math.round(prev.tS * 1000) / 10}% のままにしました。`;
    return finish();
  }
  const cut = Math.max(1, Math.min(samples.length - 1, Math.floor(samples.length * o.trainShare)));
  const train = samples.slice(0, cut);
  const valid = samples.slice(cut);
  model.samples.train = train.length;
  model.samples.valid = valid.length;

  let chosen = null;
  const steps = Math.round((o.gridMax - o.gridMin) / o.gridStep);
  for (let i = 0; i <= steps; i++) {
    const t = round4(o.gridMin + i * o.gridStep);
    const tr = atOrAbove(train, t);
    const va = atOrAbove(valid, t);
    const low = wilsonLower(tr.hits, tr.n, 1.0);
    const passTrain = tr.n >= o.minTrain && tr.rate !== null && tr.rate >= o.target - 1e-9 && low !== null && low >= o.target - o.lowerBoundSlack - 1e-9;
    const passValid = va.n >= o.minValid && va.rate !== null && va.rate >= o.target - o.validTolerance - 1e-9;
    model.candidates.push({
      tS: t, trainN: tr.n, trainHitPct: tr.rate === null ? null : round1(tr.rate * 100), trainLowPct: low === null ? null : round1(low * 100),
      validN: va.n, validHitPct: va.rate === null ? null : round1(va.rate * 100), passTrain, passValid,
    });
    if (!chosen && passTrain && passValid) chosen = t; // いちばん低い境(=S の対象が最も多い)を選ぶ
  }

  // 今の境が今のデータでも成り立っているか(全データで 目標−検証の許容 以上)
  const cur = atOrAbove(samples, prev.tS);
  const currentHolds = cur.n >= o.minTrain && cur.rate !== null && cur.rate >= o.target - o.validTolerance - 1e-9;
  const fmt = (t) => `${Math.round(t * 1000) / 10}%`;
  if (chosen === null) {
    model.decision = hadPrev ? "kept_previous" : "kept_default";
    model.reasonJa = `学習側(${train.length}件)で的中率が目標の${Math.round(o.target * 100)}%に届き、検証側(${valid.length}件)でも崩れない境が見つからなかったため、Sの境は${hadPrev ? "前回" : "既定"}の ${fmt(prev.tS)} のままにしました(今の境以上の予想は ${cur.n}件で的中率 ${cur.rate === null ? "—" : round1(cur.rate * 100) + "%"})。`;
    return finish();
  }
  if (Math.abs(chosen - prev.tS) < o.hysteresis - 1e-9 && currentHolds) {
    model.decision = hadPrev ? "kept_previous" : "kept_default";
    model.reasonJa = `学習で選ばれた境は ${fmt(chosen)} でしたが、今の境 ${fmt(prev.tS)} との差が小さく、今の境でも的中率 ${round1(cur.rate * 100)}%(${cur.n}件)を保っているため、動かしませんでした(毎晩ふらつかせないため)。`;
    return finish();
  }
  model.thresholds = { ...prev, tS: chosen };
  model.adopted = true;
  model.decision = "adopted";
  const picked = model.candidates.find((x) => x.tS === chosen);
  model.reasonJa = `Sの境を ${fmt(prev.tS)} から ${fmt(chosen)} に変えました。学習側ではこの境以上の予想が ${picked.trainN}件で的中率 ${picked.trainHitPct}%、検証側でも ${picked.validN}件で ${picked.validHitPct}% でした(目標 ${Math.round(o.target * 100)}%)。`;
  return finish();
}

/** 成長ログ・日次レポート用の要約 */
function summarizeModel(model) {
  if (!model) return { available: false, reasonJa: "ランクの学習結果がまだ保存されていません(既定の境で動いています)。", thresholds: { ...DEFAULT_THRESHOLDS } };
  const t = thresholdsOf(model);
  return {
    available: true,
    fittedAt: model.fittedAt || null,
    thresholds: t,
    thresholdsJa: `S: 自信${Math.round(t.tS * 1000) / 10}%以上 / A: ${Math.round(t.tA * 100)}%以上 / B: ${Math.round(t.tSkip * 100)}%以上 / 見送り: ${Math.round(t.tSkip * 100)}%未満`,
    targetPct: Number.isFinite(model.target) ? Math.round(model.target * 100) : null,
    adopted: model.adopted === true,
    decision: model.decision || null,
    reasonJa: model.reasonJa || null,
    samples: model.samples || null,
    table: model.table || null,
    forward: model.forward || null,
    candidates: Array.isArray(model.candidates) ? model.candidates : [],
  };
}

/* ---------- 刻印つきの実績(予想時に付けたランクでの的中率)の集計 ---------- */
function emptyByTier() { return emptyTable(); }
function addTierScore(agg, rank, hit, conf) {
  if (!agg || !RANKS.includes(rank)) return agg;
  agg[rank].n++;
  if (hit) agg[rank].hits++;
  if (Number.isFinite(conf)) agg[rank].confSum = round4((agg[rank].confSum || 0) + conf);
  return agg;
}
function mergeByTier(a, b) {
  if (!a && !b) return null;
  const out = emptyTable();
  for (const src of [a, b]) {
    if (!src || typeof src !== "object") continue;
    for (const r of RANKS) {
      const v = src[r];
      if (!v) continue;
      out[r].n += v.n || 0;
      out[r].hits += v.hits || 0;
      out[r].confSum = round4(out[r].confSum + (v.confSum || 0));
    }
  }
  return out;
}
function summarizeByTier(byTier) {
  if (!byTier) return { measurable: false, total: 0, reasonJa: "ランクを刻印した予想の答え合わせがまだありません(刻印は v104.1 の導入後に立てた予想から始まります)。" };
  const t = finishTable(byTier);
  return { measurable: t.total > 0, ...t, reasonJa: t.total > 0 ? null : "ランクを刻印した予想の答え合わせがまだありません。" };
}

/**
 * 予想カードに出す「このランクの実績」。
 *   予想時に刻んだランクのまま数えた実績(forward)が minForwardForDisplay 件以上あればそれを、無ければ
 *   「今の境を過去の答え合わせ済みの予想に当てはめた実測」(backtest)を返す。どちらかは basis で明示する。
 *   どちらも直近30日に十分な件数があればそちらを、無ければ保存している全期間を使う。
 */
function trackRecordFor(rank, model, opts) {
  if (!RANKS.includes(rank) || !model) return null;
  const min = (opts && Number.isFinite(opts.minForward)) ? opts.minForward : DEFAULT_OPTS.minForwardForDisplay;
  const pick = (group) => {
    if (!group) return null;
    if (group.last30 && group.last30[rank] && group.last30[rank].n >= min) return { row: group.last30[rank], window: "last30" };
    if (group.all && group.all[rank] && group.all[rank].n > 0) return { row: group.all[rank], window: "all" };
    return null;
  };
  const fw = pick(model.forward);
  if (fw && fw.row.n >= min) {
    return { basis: "forward", window: fw.window, n: fw.row.n, hits: fw.row.hits, hitPct: fw.row.hitPct, basisJa: `予想を出した時点のランクのまま数えた実績(${fw.window === "last30" ? "直近30日" : "導入からの全期間"})` };
  }
  const bt = pick(model.table);
  if (bt) {
    return { basis: "backtest", window: bt.window, n: bt.row.n, hits: bt.row.hits, hitPct: bt.row.hitPct, basisJa: `今の境を、答え合わせ済みの過去の予想(${bt.window === "last30" ? "直近30日" : "保存している全期間"})に当てはめた実測` };
  }
  return null;
}

/**
 * 画面・会話に渡すランクの表示用データ。刻印があればそれを、無い旧記録は今の境と今の補正で導く(derived)。
 * @returns {{rank:string|null, labelJa?:string, meaningJa?:string, confPct?:number, stamped:boolean, record?:object|null, reasonJa?:string}}
 */
function viewFor(record, model, calibrationMap) {
  if (!record) return null;
  let st = (record.tier && typeof record.tier === "object") ? record.tier : null;
  const stamped = !!st;
  if (!st) st = stampFor(record, model, calibrationMap);
  if (!st.rank || !RANKS.includes(st.rank)) return { rank: null, stamped, reasonJa: st.reasonJa || "この予想にはランクを付けていません。" };
  return {
    rank: st.rank,
    labelJa: RANK_LABELS_JA[st.rank],
    meaningJa: RANK_MEANING_JA[st.rank],
    confPct: Number.isFinite(st.conf) ? Math.round(st.conf * 100) : null,
    stamped,
    record: trackRecordFor(st.rank, model),
  };
}

module.exports = {
  MODEL_KEY, RANKS, RANK_LABELS_JA, RANK_MEANING_JA, DEFAULT_THRESHOLDS, DEFAULT_OPTS,
  wilsonLower, thresholdsOf, rankOf, rawConfidenceOf, displayConfOf, confOfRecord, eligibilityOf, stampFor,
  samplesFrom, tableOf, fitTierModel, summarizeModel,
  emptyByTier, addTierScore, mergeByTier, summarizeByTier, trackRecordFor, viewFor, forwardTableOf,
};
