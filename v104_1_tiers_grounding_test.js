"use strict";
/**
 * v104.1(2026年11月14日): K「確信ピック」(自信ランク)と M「数字の裏取り」の部品テスト
 * ----------------------------------------------------------------------------
 * K: learning/confidenceTiers.js / accuracyTracker.js(ランク別の採点)
 *   ・ランクは予想カードに出す自信の数字と同じ計算で決まる(温度較正済み/帯補正/補正なし)
 *   ・対象は公式戦かつ学習済みの大会だけ。対象外は rank:null と理由
 *   ・S の境は 65〜80% の範囲で、時系列の検証を通ったときだけ動く(迷ったら現状維持・毎晩ふらつかない)
 *   ・予想時に刻んだランクは後から変えない(境が動いても、前向きの実績は刻印どおりに数える)
 *   ・勝敗の予想・確率・的中率の集計は1つも変えない
 * M: discuss/grounding.js / intelligenceMetrics.js(集計)
 *   ・割合・小数・10以上の整数だけを照合し、西暦・日付・時刻・フォーメーション・定数・1桁の整数は数えない
 *   ・四捨五入の幅・0〜1の確率と割合の対応・100%からの引き算は「資料にある」とみなす
 *   ・実データを使っていない回答は「一致/不一致」と呼ばず、一般知識の数字として伝える
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const T = require("./learning/confidenceTiers");
const acc = require("./learning/accuracyTracker");
const G = require("./discuss/grounding");
const IM = require("./learning/intelligenceMetrics");

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rec = (p, extra) => ({ predictedWinner: "home", finalProbs: { homeWin: p, draw: (1 - p) / 2, awayWin: (1 - p) / 2, source: "market_blend" }, official: true, learnedCompetition: true, homeLambda: 1.5, awayLambda: 1.0, ...(extra || {}) });
/** 答え合わせ済みの記録を作る。miscal>0 は自信不足(言った確率より当たる)、<0 は自信過剰 */
function makeResolved(n, seed, miscal, opts) {
  const r = rng(seed); const o = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const conf = 0.36 + r() * 0.5;
    const pTrue = Math.max(0.05, Math.min(0.97, conf + (miscal || 0)));
    const hit = r() < pTrue;
    out.push({ ...rec(conf), resolved: true, actualWinner: hit ? "home" : "away", correct: hit, kickoff: new Date(Date.parse(o.from || "2026-08-01T00:00:00Z") + i * 3600e3 * (o.stepHours || 3)).toISOString(), ...(o.extra || {}) });
  }
  return out;
}
const MAP = { available: true, minN: 20, bins: { "33-45%": { n: 214, avgConfPct: 40.5, actualHitPct: 47.2 }, "45-55%": { n: 167, avgConfPct: 50, actualHitPct: 56.3 }, "55-70%": { n: 187, avgConfPct: 62, actualHitPct: 61.5 }, "70+%": { n: 98, avgConfPct: 78.5, actualHitPct: 73.5 } } };

(async () => {
  console.log("v104.1 K 確信ピック(自信ランク)・M 数字の裏取り の部品");

  // ================= K-1 ランクの決め方 =================
  await t("K1 既定の境: S=70%以上 / A=60%以上 / B=50%以上 / 見送り=50%未満。境ちょうどは上のランク", () => {
    assert.deepStrictEqual(T.DEFAULT_THRESHOLDS, { tS: 0.7, tA: 0.6, tSkip: 0.5 });
    const th = T.thresholdsOf(null);
    assert.deepStrictEqual([0.95, 0.7, 0.6999, 0.6, 0.5999, 0.5, 0.4999, 0.34].map((c) => T.rankOf(c, th)), ["S", "S", "A", "A", "B", "B", "skip", "skip"]);
    assert.strictEqual(T.rankOf(NaN, th), null);
    // 保存された境が範囲(65〜80%)の外・壊れているときは既定へ戻す(A と見送りの境は固定)
    assert.strictEqual(T.thresholdsOf({ thresholds: { tS: 0.3 } }).tS, 0.7);
    assert.strictEqual(T.thresholdsOf({ thresholds: { tS: 0.95 } }).tS, 0.7);
    assert.strictEqual(T.thresholdsOf({ thresholds: { tS: "x" } }).tS, 0.7);
    assert.deepStrictEqual(T.thresholdsOf({ thresholds: { tS: 0.75, tA: 0.1, tSkip: 0.9 } }), { tS: 0.75, tA: 0.6, tSkip: 0.5 });
  });

  await t("K2 自信=予想カードの数字と同じ計算: 温度較正済みは最終確率そのまま/帯の実測があればその分だけ補正/無ければそのまま", () => {
    // 帯ごとの実測を点としてつないだ曲線で補正する(v104.1 総点検: 帯の境目で数字が逆転しないように)。
    //   点: (40.5→47.2) (50→56.3) (62→61.5) (78.5→73.5)。50% はちょうど点の上なので 56.3 → 56%。
    //   75% は (62→61.5) と (78.5→73.5) のあいだ: 61.5 + (13/16.5)×12 = 70.95 → 71%(旧方式は一律 -5pt で 70%)
    assert.deepStrictEqual(T.displayConfOf(rec(0.5), MAP), { conf: 0.56, rawConf: 0.5, basis: "bin" });
    assert.deepStrictEqual(T.displayConfOf(rec(0.75), MAP), { conf: 0.71, rawConf: 0.75, basis: "bin" });
    // 補正の材料が無い/件数不足(20件未満)の帯は補正しない
    assert.deepStrictEqual(T.displayConfOf(rec(0.62), null), { conf: 0.62, rawConf: 0.62, basis: "raw" });
    assert.strictEqual(T.displayConfOf(rec(0.62), { available: true, minN: 20, bins: { "55-70%": { n: 5, avgConfPct: 60, actualHitPct: 90 } } }).basis, "raw");
    // 温度較正を予想時に適用済みの記録には、帯補正を重ねない
    const temp = rec(0.62, { rawFinalProbs: { homeWin: 0.55, draw: 0.25, awayWin: 0.2 }, probCalibration: { applied: true, T: 0.8, regime: "odds" } });
    assert.deepStrictEqual(T.displayConfOf(temp, MAP), { conf: 0.62, rawConf: 0.62, basis: "temperature" });
    // 引き分け予想・アウェイ予想も、予想した勝敗の確率を使う
    assert.strictEqual(T.displayConfOf({ predictedWinner: "draw", finalProbs: { homeWin: 0.3, draw: 0.38, awayWin: 0.32 } }, null).conf, 0.38);
    assert.strictEqual(T.displayConfOf({ predictedWinner: "away", finalProbs: { homeWin: 0.2, draw: 0.2, awayWin: 0.6 } }, null).conf, 0.6);
    // 最終確率が無い旧記録は null(λ から作り直さない=後から数字を作らない)
    assert.strictEqual(T.displayConfOf({ predictedWinner: "home", homeLambda: 2, awayLambda: 0.8 }, MAP), null);
  });

  await t("K2b 帯の境目で数字もランクも逆転しない: モデルの値が高い予想ほど、表示の自信もランクも同じか上(v104.1 総点検)", () => {
    const C = require(path.join(__dirname, "learning/calibrationCorrection.js"));
    // 旧方式(帯ごとに一律の足し引き)で実際に起きていた逆転: 生値54%→60% / 56%→56%、生値69%→70% / 72%→67%
    const d = (p) => T.displayConfOf(rec(p), MAP).conf;
    assert.ok(d(0.54) <= d(0.56), `54% と 56% が逆転: ${d(0.54)} > ${d(0.56)}`);
    assert.ok(d(0.69) <= d(0.72), `69% と 72% が逆転: ${d(0.69)} > ${d(0.72)}`);
    assert.deepStrictEqual([d(0.54), d(0.56), d(0.69), d(0.72)], [0.58, 0.59, 0.67, 0.69]);
    // 総当たり: 本番の実測に近いマップ・件数不足の帯があるマップ・実測どうしが逆転しているマップ・1帯だけのマップ
    const maps = [
      MAP,
      { available: true, minN: 20, bins: { "33-45%": { n: 214, avgConfPct: 40.5, actualHitPct: 47.2 }, "45-55%": { n: 167, avgConfPct: 50, actualHitPct: 56.3 }, "55-70%": { n: 12, avgConfPct: 61, actualHitPct: 20 }, "70+%": { n: 98, avgConfPct: 78.5, actualHitPct: 73.5 } } },
      { available: true, minN: 20, bins: { "33-45%": { n: 60, avgConfPct: 41, actualHitPct: 55 }, "45-55%": { n: 80, avgConfPct: 50, actualHitPct: 48 }, "55-70%": { n: 90, avgConfPct: 62, actualHitPct: 70 }, "70+%": { n: 30, avgConfPct: 80, actualHitPct: 62 } } },
      { available: true, minN: 20, bins: { "70+%": { n: 30, avgConfPct: 80, actualHitPct: 60 } } },
      { available: true, minN: 20, bins: { "45-55%": { n: 500, avgConfPct: 54.96, actualHitPct: 70 }, "55-70%": { n: 500, avgConfPct: 55, actualHitPct: 40 } } },
    ];
    const order = { skip: 0, B: 1, A: 2, S: 3 };
    for (const [mi, map] of maps.entries()) {
      for (const tS of [0.65, 0.7, 0.75, 0.8]) {
        let prevPct = -1, prevRank = -1, prevRaw = null;
        for (let raw = 34; raw <= 99; raw += 0.25) {
          const cal = C.applyCalibration(raw, map);
          const pct = cal ? cal.calibratedPct : Math.round(raw);
          // 補正が無い範囲(材料なし)は生値。その境目でも逆転しないこと
          assert.ok(pct >= prevPct, `マップ${mi}: 生値 ${prevRaw}% → ${prevPct}% なのに、生値 ${raw}% → ${pct}%(逆転)`);
          const st = T.stampFor(rec(raw / 100), { thresholds: { tS } }, map);
          assert.ok(order[st.rank] >= prevRank, `マップ${mi}・S の境 ${tS}: 生値 ${raw}% のランク ${st.rank} が、それより低い生値のランクより下`);
          if (cal) { assert.ok(cal.basisN > 0 && Array.isArray(cal.basisBins) && cal.basisBins.length >= 1); assert.ok(/補正しています/.test(cal.noteJa) && cal.noteJa.includes(`モデル生値${Math.round(raw)}%`)); }
          prevPct = pct; prevRank = order[st.rank]; prevRaw = raw;
        }
      }
    }
    // 実測が足りない帯(20件未満)の数字は材料にしない: その帯の「的中率20%」は使われず、中心ではモデルの値に近いまま
    const sparse = C.applyCalibration(61, maps[1]);
    assert.ok(sparse && !sparse.basisBins.includes("55-70%") && Math.abs(sparse.calibratedPct - 61) <= 1, JSON.stringify(sparse));
    // 実測の点そのもの(帯の平均の自信)では、実測の的中率どおり(従来と同じ)
    assert.strictEqual(C.applyCalibration(40.5, MAP).calibratedPct, 47); assert.strictEqual(C.applyCalibration(62, MAP).calibratedPct, 62); assert.strictEqual(C.applyCalibration(78.5, MAP).calibratedPct, 74);
    // 端より外は、端の点と同じ幅だけ足し引き(従来と同じ): 36% → +6.7pt、95% → -5pt
    assert.strictEqual(C.applyCalibration(36, MAP).deltaPt, 6.7); assert.strictEqual(C.applyCalibration(95, MAP).deltaPt, -5); assert.strictEqual(C.applyCalibration(95, MAP).calibratedPct, 90);
    // 自信の高い帯ほど的中率が低い(件数の少なさによる偶然の逆転)は、件数で重みづけして均す
    const curve = C.calibrationCurveOf(maps[2]);
    for (let i = 1; i < curve.length; i++) assert.ok(curve[i].y >= curve[i - 1].y - 1e-9, "曲線の点が右下がり: " + JSON.stringify(curve.map((p) => p.y)));
    assert.ok(curve[0].pooled && curve[1].pooled && Math.abs(curve[0].y - (55 * 60 + 48 * 80) / 140) < 1e-9, "均した値は件数の重みつき平均");
    // 材料が1つも無い・マップが無い・数値でない → null(生の値をそのまま出す)
    assert.strictEqual(C.applyCalibration(60, null), null); assert.strictEqual(C.applyCalibration(60, { available: false }), null);
    assert.strictEqual(C.applyCalibration(NaN, MAP), null); assert.strictEqual(C.calibrationCurveOf({ available: true, bins: {} }), null);
    assert.strictEqual(C.applyCalibration(60, { available: true, minN: 20, bins: { "55-70%": { n: 19, avgConfPct: 60, actualHitPct: 90 } } }), null);
    // 壊れた値(平均の自信が帯の外・的中率が範囲外)は材料にしない
    assert.strictEqual(C.applyCalibration(60, { available: true, minN: 20, bins: { "55-70%": { n: 50, avgConfPct: 12, actualHitPct: 90 } } }), null);
    assert.strictEqual(C.applyCalibration(60, { available: true, minN: 20, bins: { "55-70%": { n: 50, avgConfPct: 60, actualHitPct: 190 } } }), null);
  });

  await t("K3 対象は公式戦かつ学習済みの大会だけ。対象外・確率なしは rank:null と理由(当てにならない場面で S を出さない)", () => {
    const s1 = T.stampFor(rec(0.9, { official: false }), null, null);
    assert.strictEqual(s1.rank, null); assert.ok(/親善試合/.test(s1.reasonJa));
    const s2 = T.stampFor(rec(0.9, { learnedCompetition: false }), null, null);
    assert.strictEqual(s2.rank, null); assert.ok(/学習していない大会/.test(s2.reasonJa));
    const s3 = T.stampFor({ predictedWinner: "home", official: true, learnedCompetition: true }, null, null);
    assert.strictEqual(s3.rank, null); assert.ok(/最終確率/.test(s3.reasonJa));
    // 旧記録(official / learnedCompetition の項目が無い)は対象に含める(従来の集計と同じ扱い)
    assert.strictEqual(T.stampFor({ predictedWinner: "home", finalProbs: { homeWin: 0.72, draw: 0.18, awayWin: 0.1 } }, null, null).rank, "S");
    const ok = T.stampFor(rec(0.75), { thresholds: { tS: 0.75 } }, MAP);
    assert.deepStrictEqual(ok, { rank: "A", conf: 0.71, rawConf: 0.75, basis: "bin", tS: 0.75, tA: 0.6, tSkip: 0.5, v: 1 }, "境(モデル)と補正(マップ)の両方を反映して刻む");
  });

  await t("K4 刻印は後から変えない: 刻印のある記録の自信は刻んだ値。境が動いても前向きの実績は刻印どおりに数える", () => {
    const stamped = { ...rec(0.75), tier: { rank: "S", conf: 0.72, tS: 0.7 } };
    assert.strictEqual(T.confOfRecord(stamped, MAP), 0.72, "今の補正(0.71)ではなく、予想時の値");
    assert.strictEqual(T.confOfRecord(rec(0.75), MAP), 0.71, "刻印の無い旧記録は今の補正で計算");
    // 対象外の刻印(rank:null)は刻印として扱わない
    assert.strictEqual(T.confOfRecord({ ...rec(0.75), tier: { rank: null, conf: null } }, MAP), 0.71);
    const samples = [
      { conf: 0.72, hit: true, t: 1, stampedRank: "S" }, { conf: 0.72, hit: false, t: 2, stampedRank: "S" },
      { conf: 0.9, hit: true, t: 3, stampedRank: null },
    ];
    const fw = T.forwardTableOf(samples);
    assert.deepStrictEqual([fw.S.n, fw.S.hits, fw.total], [2, 1, 2], "刻印の無い記録は前向きの実績に入れない");
    const bt = T.tableOf(samples, { tS: 0.75, tA: 0.6, tSkip: 0.5 });
    assert.deepStrictEqual([bt.S.n, bt.A.n], [1, 2], "当てはめの表は今の境で数える(0.72 は A)");
  });

  // ================= K-2 境の学習 =================
  await t("K5 件数が足りない(150件未満)ときは学習せず既定のまま。理由を言葉で残し、表は作る", () => {
    const m = T.fitTierModel(makeResolved(100, 1, 0), { nowIso: "2026-12-20T00:00:00Z" });
    assert.strictEqual(m.decision, "kept_default"); assert.strictEqual(m.adopted, false); assert.strictEqual(m.thresholds.tS, 0.7);
    assert.ok(/100件/.test(m.reasonJa) && /150件/.test(m.reasonJa));
    assert.strictEqual(m.table.all.total, 100);
    assert.strictEqual(T.fitTierModel([], { nowIso: "2026-12-20T00:00:00Z" }).table.all.total, 0);
  });

  await t("K6 自信過剰のモデル(言った確率より当たらない): 目標75%に届く境まで S を引き上げる(検証側でも確認)", () => {
    const m = T.fitTierModel(makeResolved(2000, 6, -0.05), { nowIso: "2026-12-20T00:00:00Z" });
    assert.strictEqual(m.decision, "adopted"); assert.ok(m.thresholds.tS > 0.7 && m.thresholds.tS <= 0.8, String(m.thresholds.tS));
    const c = m.candidates.find((x) => x.tS === m.thresholds.tS);
    assert.ok(c.passTrain && c.passValid && c.trainHitPct >= 75 && c.validHitPct >= 68 && c.trainN >= 40 && c.validN >= 15, JSON.stringify(c));
    // 選んだ境より低い境は、学習側か検証側のどちらかで条件を満たしていない(=いちばん低い境を選んでいる)
    for (const x of m.candidates.filter((y) => y.tS < m.thresholds.tS)) assert.ok(!(x.passTrain && x.passValid), JSON.stringify(x));
    assert.ok(m.table.all.S.hitPct >= 73, "S の実測: " + m.table.all.S.hitPct);
    assert.ok(/変えました/.test(m.reasonJa));
  });

  await t("K7 境は 65% より下げない(まとめた的中率が目標に届いても S を薄めない)・80% より上げない", () => {
    const m = T.fitTierModel(makeResolved(2000, 5, 0.06), { nowIso: "2026-12-20T00:00:00Z" }); // 自信不足=低い境でも75%に届く
    assert.ok(m.thresholds.tS >= 0.65 - 1e-9, String(m.thresholds.tS));
    assert.ok(Math.min(...m.candidates.map((x) => x.tS)) >= 0.65 - 1e-9 && Math.max(...m.candidates.map((x) => x.tS)) <= 0.8 + 1e-9);
    assert.strictEqual(m.candidates.length, 7, "0.65〜0.80 を 0.025 刻み");
  });

  await t("K8 目標に届く境が無いときは動かさない(迷ったら現状維持)。今の境の実測は正直に表へ出す", () => {
    const m = T.fitTierModel(makeResolved(800, 3, -0.2), { nowIso: "2026-12-20T00:00:00Z" });
    assert.strictEqual(m.adopted, false); assert.strictEqual(m.thresholds.tS, 0.7);
    assert.ok(/見つからなかった/.test(m.reasonJa));
    assert.ok(m.table.all.S.hitPct < 70, "S の実測がそのまま出る(飾らない): " + m.table.all.S.hitPct);
  });

  await t("K9 毎晩ふらつかせない: 翌日同じデータなら動かない/差が0.05未満で今の境が成り立っていれば動かさない/成り立たなくなったら動かす", () => {
    const data = makeResolved(2000, 6, -0.05);
    const d1 = T.fitTierModel(data, { nowIso: "2026-12-20T00:00:00Z" });
    const d2 = T.fitTierModel(data, { nowIso: "2026-12-21T00:00:00Z", prevModel: d1 });
    assert.strictEqual(d2.thresholds.tS, d1.thresholds.tS); assert.strictEqual(d2.decision, "kept_previous");
    // 今の境が 0.675 で、学習が選ぶ境(0.65)との差が 0.025 → 今の境が成り立っているので動かさない
    const good = makeResolved(2000, 5, 0.06);
    const k = T.fitTierModel(good, { nowIso: "2026-12-20T00:00:00Z", prevModel: { thresholds: { tS: 0.675 } } });
    assert.strictEqual(k.thresholds.tS, 0.675); assert.ok(/動かしませんでした/.test(k.reasonJa), k.reasonJa);
    // 今の境(0.70)が成り立たない(自信過剰)ときは、差が小さくても動かす
    const bad = makeResolved(2000, 6, -0.05);
    const mv = T.fitTierModel(bad, { nowIso: "2026-12-20T00:00:00Z", prevModel: { thresholds: { tS: 0.75 } } });
    assert.ok(mv.thresholds.tS >= 0.75, "引き下げない: " + mv.thresholds.tS);
  });

  await t("K10 対象外(親善・未学習)と未解決の記録は学習にも表にも入れない。同じ入力なら結果は同じ(決定的)", () => {
    const base = makeResolved(300, 9, 0);
    const noise = [...makeResolved(200, 10, 0, { extra: { official: false } }), ...makeResolved(200, 11, 0, { extra: { learnedCompetition: false } }), ...makeResolved(50, 12, 0).map((r) => ({ ...r, resolved: false, actualWinner: null }))];
    const a = T.fitTierModel(base, { nowIso: "2026-12-20T00:00:00Z" });
    const b = T.fitTierModel([...noise, ...base], { nowIso: "2026-12-20T00:00:00Z" });
    assert.strictEqual(b.samples.total, 300);
    assert.deepStrictEqual(b.table, a.table); assert.deepStrictEqual(b.thresholds, a.thresholds);
    assert.deepStrictEqual(T.fitTierModel(base, { nowIso: "2026-12-20T00:00:00Z" }), a);
  });

  await t("K11 表の中身: 件数・的中・的中率・平均の自信・下限(少数の当たりを過信しない)・構成比。直近30日は別に数える", () => {
    const m = T.fitTierModel(makeResolved(600, 21, 0, { from: "2026-10-01T00:00:00Z", stepHours: 3 }), { nowIso: "2026-12-15T00:00:00Z" });
    const all = m.table.all;
    assert.strictEqual(all.S.n + all.A.n + all.B.n + all.skip.n, 600);
    for (const r of T.RANKS) {
      const row = all[r];
      assert.ok(row.hits <= row.n && Math.abs(row.hitPct - Math.round((row.hits / row.n) * 1000) / 10) < 1e-9);
      assert.ok(row.lowPct <= row.hitPct, "下限は実測以下");
      assert.ok(row.sharePct > 0 && row.avgConfPct > 0);
    }
    assert.ok(all.S.hitPct > all.A.hitPct && all.A.hitPct > all.B.hitPct && all.B.hitPct > all.skip.hitPct, "正しく較正されたモデルなら、ランクが高いほどよく当たる");
    assert.ok(all.S.avgConfPct >= 70 && all.skip.avgConfPct < 50);
    assert.ok(m.table.last30.total < 600 && m.table.last30.total > 0, "直近30日: " + m.table.last30.total);
    assert.ok(Math.abs(T.wilsonLower(74, 98, 1.0) - 0.709) < 0.002); assert.strictEqual(T.wilsonLower(0, 0, 1), null);
  });

  await t("K12 カードに出す実績: 前向き(刻印どおり)が20件以上あればそれ、無ければ当てはめ。直近30日に20件あればそれ、無ければ全期間。どちらかを必ず明記", () => {
    const row = (n, hits) => ({ n, hits, hitPct: n ? Math.round((hits / n) * 1000) / 10 : null });
    const tbl = (s) => ({ S: row(...s), A: row(0, 0), B: row(0, 0), skip: row(0, 0), total: s[0] });
    const model = { table: { all: tbl([150, 112]), last30: tbl([61, 46]) }, forward: { all: tbl([12, 10]), last30: tbl([3, 3]) } };
    const r1 = T.trackRecordFor("S", model);
    assert.deepStrictEqual([r1.basis, r1.window, r1.n, r1.hits, r1.hitPct], ["backtest", "last30", 61, 46, 75.4], "前向きが12件(20件未満)なので当てはめ");
    assert.ok(/当てはめた実測/.test(r1.basisJa) && /直近30日/.test(r1.basisJa));
    const r2 = T.trackRecordFor("S", { ...model, forward: { all: tbl([40, 31]), last30: tbl([24, 19]) } });
    assert.deepStrictEqual([r2.basis, r2.window, r2.n, r2.hitPct], ["forward", "last30", 24, 79.2]);
    const r3 = T.trackRecordFor("S", { ...model, forward: { all: tbl([40, 31]), last30: tbl([5, 5]) } });
    assert.deepStrictEqual([r3.basis, r3.window, r3.n], ["forward", "all", 40], "直近30日が20件未満なら全期間");
    assert.strictEqual(T.trackRecordFor("A", model), null, "0件のランクは実績なし(作らない)");
    assert.strictEqual(T.trackRecordFor("S", null), null); assert.strictEqual(T.trackRecordFor("X", model), null);
  });

  await t("K13 表示用データ(viewFor): 刻印があればそのまま(今の境で付け直さない)・無ければ今の境で導いた参考値・対象外は理由", () => {
    const model = { thresholds: { tS: 0.75 }, table: { all: { S: { n: 30, hits: 24, hitPct: 80 } }, last30: {} }, forward: null };
    const stamped = T.viewFor({ ...rec(0.5), tier: { rank: "S", conf: 0.72, tS: 0.7, tA: 0.6, tSkip: 0.5, v: 1 } }, model, MAP);
    assert.deepStrictEqual([stamped.rank, stamped.labelJa, stamped.confPct, stamped.stamped], ["S", "確信", 72, true]);
    assert.strictEqual(stamped.record.hitPct, 80);
    const derived = T.viewFor(rec(0.75), model, MAP); // 今の補正で 71% → 境 75% なので A
    assert.deepStrictEqual([derived.rank, derived.labelJa, derived.confPct, derived.stamped], ["A", "有力", 71, false]);
    const none = T.viewFor({ ...rec(0.9), tier: { rank: null, conf: null, reasonJa: "親善試合・2軍の試合のため、ランクの対象外です。" } }, model, MAP);
    assert.deepStrictEqual([none.rank, none.stamped], [null, true]); assert.ok(/対象外/.test(none.reasonJa));
    assert.strictEqual(T.viewFor(null, model, MAP), null);
    for (const r of T.RANKS) assert.ok(T.RANK_LABELS_JA[r] && T.RANK_MEANING_JA[r]);
    assert.ok(!/鉄板|賭け|ベット|儲/.test(JSON.stringify([T.RANK_LABELS_JA, T.RANK_MEANING_JA])), "賭けを連想させる言い方を使わない");
  });

  // ================= K-3 採点(accuracyTracker) =================
  const scored = (tier, hit, conf, extra) => ({ official: true, league: "Serie A", learned: true, tier, ...(extra || {}), markets: { oneX2: { hit, brier: hit ? 0.2 : 0.9, logLoss: hit ? 0.4 : 1.3, confidence: conf, predicted: "home", actual: hit ? "home" : "away", probs: { homeWin: conf, draw: (1 - conf) / 2, awayWin: (1 - conf) / 2 } } } });
  await t("K14 ランク別の採点: 刻印のある記録だけを数える。合算(同日2回目・複数日)と要約ができる", () => {
    const day1 = acc.buildDailyAccuracy([scored("S", true, 0.74), scored("S", true, 0.8), scored("S", false, 0.71), scored("A", true, 0.62), scored("skip", false, 0.44), scored(null, true, 0.9), scored(undefined, false, 0.5), scored("X", true, 0.7)]);
    assert.deepStrictEqual([day1.oneX2.byTier.S.n, day1.oneX2.byTier.S.hits, day1.oneX2.byTier.A.n, day1.oneX2.byTier.B.n, day1.oneX2.byTier.skip.n], [3, 2, 1, 0, 1]);
    assert.strictEqual(day1.oneX2.n, 8, "全体の件数は従来どおり(刻印の無い記録も数える)");
    const day2 = acc.buildDailyAccuracy([scored("S", true, 0.75), scored("B", false, 0.55)]);
    const merged = acc.mergeDailyAccuracy(day1, day2);
    assert.deepStrictEqual([merged.oneX2.byTier.S.n, merged.oneX2.byTier.S.hits, merged.oneX2.byTier.B.n], [4, 3, 1]);
    const sum = acc.summarizeAccuracy(merged).markets.oneX2.byTier;
    assert.strictEqual(sum.measurable, true); assert.strictEqual(sum.total, 7);
    assert.deepStrictEqual([sum.S.n, sum.S.hits, sum.S.hitPct, sum.A.hitPct, sum.skip.hitPct], [4, 3, 75, 100, 0]);
    // 古い保存形式(byTier なし)とも合算できる・両方に無ければ項目を作らない
    const old = acc.buildDailyAccuracy([scored(null, true, 0.6)]);
    assert.strictEqual(old.oneX2.byTier, undefined);
    assert.strictEqual(acc.mergeDailyAccuracy(old, day2).oneX2.byTier.S.n, 1);
    assert.strictEqual(acc.mergeDailyAccuracy(old, old).oneX2.byTier, undefined);
    assert.strictEqual(acc.summarizeAccuracy(old).markets.oneX2.byTier.measurable, false);
  });

  await t("K15 的中率・Brier・LogLoss・較正の帯は、ランクを足す前と1つも変わらない(見せ方と計測だけの追加)", () => {
    const list = [scored("S", true, 0.74), scored("A", false, 0.62), scored("skip", true, 0.44)];
    const without = list.map((s) => { const c = JSON.parse(JSON.stringify(s)); delete c.tier; return c; });
    const a = acc.buildDailyAccuracy(list), b = acc.buildDailyAccuracy(without);
    const strip = (x) => { const c = JSON.parse(JSON.stringify(x)); delete c.oneX2.byTier; return c; };
    assert.deepStrictEqual(strip(a), strip(b));
    const sa = acc.summarizeAccuracy(a), sb = acc.summarizeAccuracy(b);
    delete sa.markets.oneX2.byTier; delete sb.markets.oneX2.byTier;
    assert.deepStrictEqual(sa, sb);
    // scorePrediction の採点結果も、記録に tier があっても同じ
    const r = { ...rec(0.62), actualWinner: "home", actualScore: { home: 2, away: 1 } };
    assert.deepStrictEqual(acc.scorePrediction({ ...r, tier: { rank: "A", conf: 0.62 } }), acc.scorePrediction(r));
  });

  // ================= M-1 数字の取り出し =================
  const claims = (s) => G.extractClaims(s).items.map((x) => x.text);
  await t("M1 照合する数字: 割合・小数・10以上の整数(桁区切り・全角も)。同じ数字は1回だけ", () => {
    assert.deepStrictEqual(claims("勝つ確率は62%、平均評価は7.13、今季18得点。出場は1,234分。もう一度62%。"), ["62%", "7.13", "18", "1234"]);
    assert.deepStrictEqual(claims("勝率62%、評価7.1、勝点42"), ["62%", "7.1", "42"]);
    assert.deepStrictEqual(claims("Win probability 62.5 percent, 18 goals, rating 7.3"), ["62.5%", "18", "7.3"]);
    assert.deepStrictEqual(claims("probabilidad del 55 por ciento y 21 goles"), ["55%", "21"]);
  });
  await t("M2 照合しないもの: 西暦・日付・時刻・シーズン・フォーメーション・試合時間の定数・基準線(2.5点)・1X2・「第N節」・1桁の整数・「100%」", () => {
    assert.deepStrictEqual(claims("2026年11月14日 19:30 キックオフ。2025-26シーズン、2026/27も。4-3-3 と 4-2-3-1。90分で決着、45分で交代。11人対11人。"), []);
    assert.deepStrictEqual(claims("2.5点以上は55%、1.5ゴール以上。1X2の予想。第12節、第3戦。100%勝てるとは言えません。"), ["55%"]);
    assert.strictEqual(G.extractClaims("直近5試合は3勝1分1敗、2点差。").items.length, 0);
    assert.strictEqual(G.extractClaims("直近5試合は3勝1分1敗、2点差。").skippedSmall, 5);
    assert.deepStrictEqual(claims("https://media.api-sports.io/football/players/1485.png を参照。試合は 2026-11-14T19:30:00+00:00。"), []);
    // 西暦に見えても、単位が付いていれば成績の数字として照合する(出場2034分 など)
    assert.deepStrictEqual(claims("今季は2034分に出場、通算2010試合。2026年のこと。"), ["2034", "2010"]);
    assert.deepStrictEqual(claims("U23代表、3バック、5レーン、7日間、3か月、2週間"), []);
  });

  // ================= M-2 照合 =================
  const check = (answer, corpus, dataUsed) => G.checkGrounding({ answerTexts: [answer], corpusTexts: corpus, dataUsed: dataUsed !== false });
  await t("M3 資料にある数字は一致: 四捨五入の幅(72.6→73%・7.128→7.13・87.4→87)・0〜1の確率と割合(0.731→73%)・桁区切り", () => {
    const corpus = ["homeWinPct: 72.6 / rating 7.128 / passAccuracy 87.4 / prob 0.731 / minutes 1,234 / points 42"];
    const r = check("勝つ確率は73%、評価は7.13、パス成功率は87、別の確率は73.1%、出場1234分、勝点42。", corpus);
    assert.deepStrictEqual([r.verdict, r.checked, r.supported, r.unsupportedCount], ["all_supported", 6, 6, 0], JSON.stringify(r));
    assert.strictEqual(r.noteJa, "照合した数字6個は、すべて取得したデータにある数字と一致しました。");
    // 幅を超えるズレは一致にしない
    const r2 = check("勝つ確率は75%、評価は7.2、勝点44。", corpus);
    assert.deepStrictEqual([r2.verdict, r2.supported, r2.unsupported.map((u) => u.text)], ["partial", 0, ["75%", "7.2", "44"]]);
  });
  await t("M4 100%からの引き算は資料から導けるものとして数える(割合だけ)。割合でない数字の引き算は認めない", () => {
    const corpus = ["awayWinPct: 17, homeWinPct: 62, drawPct: 21, goals 30"];
    const r = check("負けない確率は83%です。", corpus);
    assert.deepStrictEqual([r.verdict, r.supported, r.derived], ["all_supported", 1, 1]);
    assert.strictEqual(check("残りは70%です。", corpus).verdict, "partial", "割合ではない 30 からの引き算は認めない");
  });
  await t("M5 資料に無い数字を見つける(本番を想定した例): 一覧は最大6個・件数は全数。文言は「計算した値や、AIの推定・一般知識による値の場合があります」と添える", () => {
    const corpus = ["取得できた事実:\n- homeWinPct: 62, drawPct: 21, awayWinPct: 17\n- rating 7.128\n- goals: 18\n- goalsFor 30 goalsAgainst 9"];
    const r = check("勝つ確率は62%、評価は7.13、今季18得点。得失点差は+25、シュート成功率は31%。", corpus);
    assert.deepStrictEqual([r.verdict, r.checked, r.supported, r.ratePct], ["partial", 5, 3, 60]);
    assert.deepStrictEqual(r.unsupported, [{ text: "25", kind: "num" }, { text: "31%", kind: "pct" }]);
    assert.strictEqual(r.noteJa, "照合した数字5個のうち3個は取得したデータと一致しました。次の数字は、取得したデータに同じ値が見当たりません(AIが計算した値や、AIの推定・一般知識による値の場合があります): 25、31%。");
    assert.ok(!/でっち上げ|嘘|誤り/.test(r.noteJa), r.noteJa);
    const many = check("数字は 11%、12%、13%、14%、15%、16%、17.5、18.5 です。", ["資料に数字なし"]);
    assert.deepStrictEqual([many.unsupportedCount, many.unsupported.length], [8, 6]); assert.ok(many.noteJa.endsWith("ほか。"), many.noteJa);
  });
  await t("M6 実データを使っていない回答は「一致/不一致」と呼ばない: 一般知識の数字として伝える。質問文の繰り返しだけなら何も添えない", () => {
    const g = G.checkGrounding({ answerTexts: ["ワールドカップには48チームが出場し、決勝の会場は82500人を収容します。"], corpusTexts: [], questionTexts: ["W杯について教えて"], dataUsed: false });
    assert.deepStrictEqual([g.verdict, g.unsupportedCount, g.dataUsed], ["general_knowledge", 2, false]);
    assert.ok(/一般知識/.test(g.noteJa) && !/一致/.test(g.noteJa));
    const echo = G.checkGrounding({ answerTexts: ["勝率62%は高い部類です。"], corpusTexts: [], questionTexts: ["勝率62%って高い?"], dataUsed: false });
    assert.deepStrictEqual([echo.verdict, echo.noteJa, echo.checked, echo.fromQuestion], ["none", null, 0, 1]);
    // 数字の無い回答・空の回答は何も添えない
    assert.strictEqual(check("オフサイドは反則です。", ["x"]).verdict, "none");
    assert.strictEqual(G.checkGrounding({ answerTexts: [null, "", undefined], corpusTexts: [], dataUsed: true }).verdict, "none");
    assert.strictEqual(G.checkGrounding(null).verdict, "none");
  });
  await t("M6-2 出どころを混ぜない①: 利用者が質問に書いた数字の引用は、照合の対象から外す(一致にも不一致にも数えない)", () => {
    const base = { corpusTexts: ["homeWinPct: 58, drawPct: 24, awayWinPct: 18"], dataUsed: true };
    // 利用者「80%ある?」→ AI「80%には届かず、58%です」: 58% だけを照合する
    const r = G.checkGrounding({ ...base, answerTexts: ["80%には届きません。AIの予想は58%です。"], questionTexts: ["アーセナルの勝率は80%ある?"] });
    assert.deepStrictEqual([r.verdict, r.checked, r.supported, r.fromQuestion, r.repeated, r.unsupportedCount], ["all_supported", 1, 1, 1, 0, 0], JSON.stringify(r));
    assert.strictEqual(r.noteJa, "照合した数字1個は、すべて取得したデータにある数字と一致しました。");
    // データにも質問にもある数字は「一致」(データが優先)
    const both = G.checkGrounding({ ...base, answerTexts: ["はい、58%です。"], questionTexts: ["58%で合ってる?"] });
    assert.deepStrictEqual([both.verdict, both.supported, both.fromQuestion], ["all_supported", 1, 0]);
    // これまでの質問(会話の文脈)に書かれた数字も、利用者の数字
    const old = G.checkGrounding({ ...base, answerTexts: ["先ほどの35得点という前提なら、十分に狙えます。"], questionTexts: ["狙える?", "今季35得点いけると思う?"] });
    assert.deepStrictEqual([old.verdict, old.checked, old.fromQuestion, old.noteJa], ["none", 0, 1, null]);
    // 利用者の数字からAIが引き算した値は、AIが計算した値として挙げる(利用者の数字そのものではない)
    const calc = G.checkGrounding({ ...base, answerTexts: ["つまり負ける見込みは20%ということになります。"], questionTexts: ["80%勝てるなら?"] });
    assert.deepStrictEqual([calc.verdict, calc.unsupported.map((u) => u.text), calc.fromQuestion], ["partial", ["20%"], 0]);
  });
  await t("M6-3 出どころを混ぜない②: AIが前の回答に書いた数字を繰り返しても「取得したデータと一致」にしない(一度書いた数字が裏取り済みに化けない)", () => {
    const earlier = ["ワールドカップには48チームが出場し、決勝の会場は82500人を収容します。"];
    // 実ブラウザ検査で見つけた例: 一般知識で答えた数字を、次の(実データを使う)回答で繰り返した
    const r = G.checkGrounding({ answerTexts: ["会場は82500人収容、48チームが出場します。"], corpusTexts: ["順位: 2位 / 勝点 63"], questionTexts: ["マンチェスター・シティはどう?"], earlierAnswerTexts: earlier, dataUsed: true });
    assert.deepStrictEqual([r.verdict, r.checked, r.supported, r.repeated, r.unsupportedCount, r.ratePct], ["repeated_only", 0, 0, 2, 0, null], JSON.stringify(r));
    assert.strictEqual(r.noteJa, "この回答の数字2個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。");
    assert.ok(!/一致しました/.test(r.noteJa));
    // 一致した数字と繰り返しの数字が混ざる回答: 一致は一致、繰り返しは別に数える
    const mix = G.checkGrounding({ answerTexts: ["勝点は63です。会場は82500人収容です。"], corpusTexts: ["順位: 2位 / 勝点 63"], earlierAnswerTexts: earlier, dataUsed: true });
    assert.deepStrictEqual([mix.verdict, mix.checked, mix.supported, mix.repeated, mix.ratePct], ["all_supported", 1, 1, 1, 100]);
    assert.strictEqual(mix.noteJa, "照合した数字1個は、すべて取得したデータにある数字と一致しました。 ほかに1個は、これまでの回答に出てきた数字の繰り返しです(今回は照合していません)。");
    // 一致しない数字と繰り返しの数字が混ざる回答
    const bad = G.checkGrounding({ answerTexts: ["勝点は63、得失点差は+41。会場は82500人収容です。"], corpusTexts: ["順位: 2位 / 勝点 63"], earlierAnswerTexts: earlier, dataUsed: true });
    assert.deepStrictEqual([bad.verdict, bad.checked, bad.supported, bad.repeated, bad.unsupported.map((u) => u.text)], ["partial", 2, 1, 1, ["41"]]);
    assert.ok(bad.noteJa.includes(": 41。 ほかに1個は、これまでの回答に出てきた数字の繰り返しです"), bad.noteJa);
    // 実データを使っていない回答での繰り返しも、黙って通さない
    const gk = G.checkGrounding({ answerTexts: ["48チームです。"], corpusTexts: [], earlierAnswerTexts: earlier, dataUsed: false });
    assert.deepStrictEqual([gk.verdict, gk.repeated], ["repeated_only", 1]);
    // 取得したデータに同じ数字があれば、前の回答にあっても「一致」(今回のデータで確かめられたため)
    const ok = G.checkGrounding({ answerTexts: ["48チームです。"], corpusTexts: ["teams: 48"], earlierAnswerTexts: earlier, dataUsed: true });
    assert.deepStrictEqual([ok.verdict, ok.supported, ok.repeated], ["all_supported", 1, 0]);
    // 利用者の数字と前の回答の数字が同じなら、利用者の数字として扱う(何も添えない)
    const q = G.checkGrounding({ answerTexts: ["48チームです。"], corpusTexts: [], questionTexts: ["48チームで合ってる?"], earlierAnswerTexts: earlier, dataUsed: false });
    assert.deepStrictEqual([q.verdict, q.fromQuestion, q.repeated], ["none", 1, 0]);
  });
  await t("M6-4 出どころの仕分け(buildSources): AIの推定プロフィール・AIの結論・前回の結論・調査計画AIの論点は「取得したデータ」に入れない", () => {
    // 本番の推定プロフィールの書き出し(clubProfileEngine / playerProfileEngine が実際に作る形)
    const clubEstimate = "【AIによる推定・戦術傾向】戦術スタイル: ポゼッション志向 / フォーメーション傾向: 4-3-3 / 強み: 保持率は65%前後 / 弱み: 被カウンター";
    const playerEstimate = "【AIによる推定・プレースタイル】推進力のあるウインガー / 特徴: 1試合あたり12回の仕掛け";
    for (const f of [clubEstimate, playerEstimate, "【AIによる推定】ハイプレスが持ち味", "[似たクラブ リヴァプール の知識] 【AIによる推定・戦術傾向】戦術スタイル: ゲーゲンプレス", "[学習エンジン 2026-11-10] 【AIによる推定・戦術傾向】戦術スタイル: 堅守速攻", "【AIの結論】攻撃力が最大の強み", "", null]) {
      assert.strictEqual(G.isMeasuredFact(f), false, "実データとして扱ってはいけない: " + f);
    }
    for (const f of ["順位: 2位(勝点63)", "直近5試合: 3勝1分1敗", "[学習エンジン 2026-11-10] 順位が3位から2位に上がりました", "負傷者情報は取得できませんでした。"]) {
      assert.strictEqual(G.isMeasuredFact(f), true, "実データ(または断り書き)は残す: " + f);
    }
    // 知能計測の「実データの事実」も同じ見分け方(v104.1 で修正: 従来は「【AIによる推定】」で始まる項目しか除けなかった)
    assert.strictEqual(IM.isRealDataFact(clubEstimate), false); assert.strictEqual(IM.isRealDataFact(playerEstimate), false);
    assert.strictEqual(IM.isRealDataFact("[似たクラブ リヴァプール の知識] 【AIによる推定・戦術傾向】戦術スタイル: ゲーゲンプレス"), false);
    assert.strictEqual(IM.isRealDataFact("【AIによる推定】ハイプレスが持ち味"), false, "従来の書き出しも引き続き除く");
    assert.strictEqual(IM.isRealDataFact("順位: 2位(勝点63)"), true); assert.strictEqual(IM.isRealDataFact("負傷者情報は取得できませんでした。"), false);
    const q = IM.scoreReasoningQuality({ facts: ["順位: 2位(勝点63)", clubEstimate], answerFields: {}, confidenceStars: 3, confidenceReasonJa: "" });
    assert.strictEqual(q.realFactCount, 1, "考察の質スコアの「実データの件数」に推定を数えない");

    const src = G.buildSources({
      facts: ["順位: 2位(勝点63)", clubEstimate, "【AIの結論】得点力は1試合平均2.4点"],
      reasoningBlock: ["観点1「攻撃力」(根拠3件, スコア72): 直近5試合で14得点", "AIが前回下した結論: 「直近5試合で11得点と好調」。今回は根拠の状況が変わり、上記の観点の方が根拠が強くなっています。", "【調査計画AIが特定した、この質問で最も重視すべき論点】勝率55%の壁を越えられるか"].join("\n"),
      toolTexts: ['{"confidencePct":58}'], stats: { goals: 18 }, question: "勝率80%ある?",
      history: [{ q: "昨季は35得点?", a: "ワールドカップには48チームが出場します。" }, null], profileText: "好きなクラブ: シャルケ04", previousConclusion: "直近5試合で11得点と好調",
    });
    const D = src.corpusTexts.join("\n");
    assert.ok(D.includes("勝点63") && D.includes("スコア72") && D.includes("14得点") && D.includes('"confidencePct":58') && D.includes('"goals":18'), D);
    assert.ok(!D.includes("65%") && !D.includes("2.4") && !D.includes("11得点") && !D.includes("55%") && !D.includes("80%") && !D.includes("48チーム"), "推定・結論・前回の結論・計画AIの論点・質問・前の回答が D に混ざっている: " + D);
    assert.deepStrictEqual(src.questionTexts, ["勝率80%ある?", "昨季は35得点?", "好きなクラブ: シャルケ04"]);
    assert.deepStrictEqual(src.earlierAnswerTexts, ["ワールドカップには48チームが出場します。", "直近5試合で11得点と好調"]);
    // 仕分けた材料での照合: 推定プロフィールにしか無い 65% は「取得したデータに見当たらない」、前回の結論の 11 は「繰り返し」
    const r = G.checkGrounding({ answerTexts: ["勝点63で、保持率は65%。直近は11得点、確信度は58%です。80%には届きません。"], ...src, dataUsed: true });
    assert.deepStrictEqual([r.verdict, r.checked, r.supported, r.unsupported.map((u) => u.text), r.repeated, r.fromQuestion], ["partial", 3, 2, ["65%"], 1, 1], JSON.stringify(r));
    // 何も渡されなくても壊れない
    assert.deepStrictEqual(G.buildSources(null), { corpusTexts: [], questionTexts: [], earlierAnswerTexts: [] });
  });
  await t("M7 資料の読み方: JSON の項目名の数字(over25・last7Days・top3)や日時・URL・IDの数字を「資料の数字」に数えない。勝敗の並び(WWDLW)は数に直す", () => {
    const c = G.extractCorpusNumbers(['{"over25Pct":55,"last7Days":{"top3":2},"kickoff":"2026-11-14T19:30:00+00:00","photo":"https://x.io/players/1485.png","form":"WWDLW"}']);
    assert.ok(c.all.includes(55) && !c.all.includes(25) && !c.all.includes(7) && !c.all.includes(2026) && !c.all.includes(19) && !c.all.includes(30) && !c.all.includes(1485), JSON.stringify(c.all));
    assert.ok(c.all.includes(3) && c.all.includes(1) && c.all.includes(5), "W3・D1・L1・5試合");
    assert.ok(c.pctLike.includes(55));
    // 道具の結果の取り出し(runToolLoop の messages)
    const texts = G.toolResultTextsOf([
      { role: "user", content: "質問" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: '{"ok":true,"data":{"confidencePct":52}}' }, { type: "tool_result", tool_use_id: "b", content: { n: 7 } }] },
    ]);
    assert.deepStrictEqual(texts, ['{"ok":true,"data":{"confidencePct":52}}', '{"n":7}']);
    assert.deepStrictEqual(G.toolResultTextsOf(null), []);
    // 大きな資料でも落ちない(40万字で切る)
    const big = G.extractCorpusNumbers(["12.5 ".repeat(200000)]);
    assert.ok(big.chars <= 400000 && big.all.length > 1000);
  });

  // ================= M-3 集計 =================
  await t("M8 集計(メモリ → 日次保存): 裏取り率=一致した数字/照合した数字。一般知識の回答・数字の無い回答は率に入れない", async () => {
    const base = IM.pendingGrounding();
    IM.recordGroundingSample({ verdict: "all_supported", checked: 4, supported: 4, dataUsed: true });
    IM.recordGroundingSample({ verdict: "partial", checked: 5, supported: 3, dataUsed: true });
    IM.recordGroundingSample({ verdict: "general_knowledge", checked: 2, supported: 0, dataUsed: false });
    IM.recordGroundingSample({ verdict: "none", checked: 0, supported: 0, dataUsed: true });
    // 前の回答の数字の繰り返し: 件数だけ数え、裏取り率(一致/照合)の分母・分子には入れない
    IM.recordGroundingSample({ verdict: "repeated_only", checked: 0, supported: 0, repeated: 2, dataUsed: true });
    IM.recordGroundingSample({ verdict: "all_supported", checked: 1, supported: 1, repeated: 1, dataUsed: true });
    assert.strictEqual(IM.recordGroundingSample(null), false);
    const p = IM.pendingGrounding();
    const d = (k) => p[k] - base[k];
    assert.deepStrictEqual([d("answers"), d("withNumbers"), d("numbersChecked"), d("numbersSupported"), d("allSupported"), d("withUnsupported"), d("generalKnowledge"), d("numbersRepeated")], [6, 3, 10, 8, 2, 1, 1, 3]);
    const s = IM.summarizeGrounding({ answers: 4, withNumbers: 2, numbersChecked: 9, numbersSupported: 7, allSupported: 1, withUnsupported: 1, generalKnowledge: 1 });
    assert.deepStrictEqual([s.measurable, s.groundedRatePct, s.cleanAnswerRatePct, s.numbersRepeated], [true, 77.8, 50, 0], "旧い記録(numbersRepeated が無い)でも 0 として読める");
    assert.strictEqual(IM.summarizeGrounding({ answers: 2, withNumbers: 1, numbersChecked: 3, numbersSupported: 3, allSupported: 1, withUnsupported: 0, generalKnowledge: 0, numbersRepeated: 4 }).numbersRepeated, 4);
    assert.strictEqual(IM.mergeGrounding({ answers: 1, numbersRepeated: 2 }, { answers: 1 }).numbersRepeated, 2);
    assert.strictEqual(IM.summarizeGrounding(null).measurable, false);
    assert.strictEqual(IM.summarizeGrounding({ answers: 3, withNumbers: 0, numbersChecked: 0 }).groundedRatePct, null, "照合した数字が無い日に 0% や 100% を作らない");
    // 日次保存: 議論の質の集計(learn:intel:<日付>)に合流し、保存できたぶんだけメモリから引く
    const store = new Map();
    const deps = {
      upstashEnabled: true,
      upstashCmd: async (c) => { if (c[0] === "GET") return store.has(c[1]) ? store.get(c[1]) : null; if (c[0] === "MGET") return c.slice(1).map((k) => (store.has(k) ? store.get(k) : null)); if (c[0] === "SET") { store.set(c[1], c[2]); return "OK"; } return null; },
      upstashGetJSON: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      upstashSetJSON: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
    };
    const before = IM.pendingGrounding().answers;
    const fl = await IM.flushIntelDaily(deps, "2026-11-15");
    assert.strictEqual(fl.groundingFlushed, before);
    assert.strictEqual(IM.pendingGrounding().answers, 0, "保存後はメモリを空にする");
    const saved = JSON.parse(store.get("learn:intel:2026-11-15"));
    assert.ok(saved.grounding && saved.grounding.answers === before && saved.grounding.numbersChecked >= 9);
    // 同じ日の2回目は加算(上書きで消さない)
    IM.recordGroundingSample({ verdict: "all_supported", checked: 2, supported: 2, dataUsed: true });
    await IM.flushIntelDaily(deps, "2026-11-15");
    assert.strictEqual(JSON.parse(store.get("learn:intel:2026-11-15")).grounding.answers, before + 1);
    // 推移の読み出し(今日・その前の7日間・未保存分)。窓の数え方は精度トレンドと同じ(last7Days は今日を含まない)
    store.set("learn:intel:2026-11-12", JSON.stringify({ grounding: { answers: 3, withNumbers: 3, numbersChecked: 8, numbersSupported: 6, allSupported: 1, withUnsupported: 2, generalKnowledge: 0 } }));
    store.set("learn:intel:2026-11-08", JSON.stringify({ samples: 2, grounding: { answers: 5, withNumbers: 4, numbersChecked: 12, numbersSupported: 12, allSupported: 4, withUnsupported: 0, generalKnowledge: 1 } }));
    store.set("learn:intel:2026-11-07", JSON.stringify({ grounding: { answers: 99, withNumbers: 99, numbersChecked: 990, numbersSupported: 0, allSupported: 0, withUnsupported: 99, generalKnowledge: 0 } })); // 8日前=窓の外
    store.set("learn:intel:2026-11-10", JSON.stringify({ samples: 4, scoreSum: 300 })); // 裏取りの無い日(v104 までの記録)は数えない
    const tr = await IM.getGroundingTrend(deps, "2026-11-15");
    assert.strictEqual(tr.available, true); assert.strictEqual(tr.today.answers, before + 1); assert.strictEqual(tr.pending.answers, 0);
    assert.deepStrictEqual([tr.last7Days.answers, tr.last7Days.groundedRatePct, tr.recordedDays], [8, 90, 3], "last7Days=11/8〜11/14(今日 11/15 と 11/7 を含まない): " + JSON.stringify(tr.last7Days));
    assert.ok(tr.today.groundedRatePct > 0 && /機械的に照合/.test(tr.noteJa) && /今日を含みません/.test(tr.noteJa));
    assert.deepStrictEqual(IM.groundingTrendKeys("2026-11-15"), ["15", "14", "13", "12", "11", "10", "09", "08"].map((d) => `learn:intel:2026-11-${d}`));
    // 保存に失敗した日はメモリを消さない(次回もう一度保存する)
    IM.recordGroundingSample({ verdict: "all_supported", checked: 1, supported: 1, dataUsed: true });
    const failing = { ...deps, upstashSetJSON: async () => false };
    const ff = await IM.flushIntelDaily(failing, "2026-11-16");
    assert.strictEqual(ff.flushed, 0); assert.strictEqual(IM.pendingGrounding().answers, 1);
    await IM.flushIntelDaily(deps, "2026-11-16");
    // 議論の質の要約(従来の項目)は、裏取りを足しても変わらない
    const sum = IM.summarizeIntelDaily({ ...IM.emptyIntelDaily(), samples: 2, scoreSum: 150, parsedOkCount: 2 });
    assert.strictEqual(sum.avgReasoningScore, 75); assert.strictEqual(sum.grounding.measurable, false);
  });

  // ================= 方針 =================
  await t("Z1 v92方針: 新しく足した learning/ のファイルに黙った catch が無い。grounding は LLM を呼ばない(外部通信なし)", () => {
    for (const f of ["learning/confidenceTiers.js", "learning/clubUniverse.js"]) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      assert.strictEqual((src.match(/catch \(e\) \{ \/\*/g) || []).length, 0, f);
    }
    const g = fs.readFileSync(path.join(__dirname, "discuss", "grounding.js"), "utf8");
    assert.ok(!/require\(|fetch\(|generateLLM|https?:\/\/(?!\[)/.test(g.replace(/https\?:\\\/\\\/\[\^/g, "")), "grounding.js は依存も通信も持たない");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})();
