/**
 * server/learning/trustEngine.js
 * ------------------------------------------------
 * 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示⑤)。
 * すべてのデータに「信頼度スコア・取得時刻・出所・更新頻度」を持たせ、
 * 古い情報ほど自動的に評価を下げる。
 *
 * ■ 設計方針(でっち上げ防止)
 *   ・信頼度は「出所の基礎点 × 鮮度による減衰」だけで機械的に決める。
 *     AIの主観的な「信頼できそう」という判定は一切入れない。
 *   ・鮮度の減衰は半減期方式(データの種類ごとに、実際の変化の速さに合わせる)。
 *     例: 怪我人情報は72時間で信頼度が半分になる(怪我は日々変わるため)。
 *         スタジアム情報は84日(ほぼ変わらないため)。
 *   ・Prediction Engineの重み学習は、信頼度の高い記録ほど強く学習する
 *     (computeNegativeLogLikelihoodのsampleWeight経由)。
 *
 * ■ 出所の基礎点の根拠
 *   API-Football(契約中の実データソース)を最高の0.95とする。1.0にしないのは、
 *   API側にも入力ミス・反映遅れが実際に存在するため(0.95は「ほぼ信頼できるが
 *   無謬ではない」という正直な評価)。AI推定は既存方針(aiEstimate 0.2)と同じ0.2。
 *   UEFAランキングの静的スナップショットは、取得時点では公式値だが更新されない
 *   ため0.6に留める。
 */

const SOURCE_TRUST = {
  // 契約中のAPIから今取得した実データ
  "api-football": { base: 0.95, labelJa: "API-Football(契約中の実データソース)" },
  // API-Footballの実データを毎日の学習で保存したもの(中身は同じ実データ。
  // 古さはこの基礎点ではなく鮮度減衰の方で評価する)
  "dossier": { base: 0.95, labelJa: "API-Footballの実データ(毎日の学習で事前蓄積)" },
  // 実データから機械計算した派生値(フォームスコア等)。計算は決定的だが
  // 「直近N試合」という切り取りが入るため、わずかに下げる
  "derived": { base: 0.9, labelJa: "実データからの機械計算値" },
  // 公式サイト等(将来の拡張用。現在は未接続なので使われない)
  "official": { base: 0.9, labelJa: "公式サイト" },
  // 静的スナップショット(UEFAランキング等。取得時点では正しいが更新されない)
  "static-snapshot": { base: 0.6, labelJa: "静的スナップショット(定期更新されない)" },
  // AIによる推定・生成(既存方針 aiEstimate 0.2 と揃える)
  "ai-estimate": { base: 0.2, labelJa: "AIによる推定(実測ではありません)" },
};

// データの種類ごとの半減期(時間)。「そのデータが実際にどのくらいの速さで
// 変わるか」に合わせる。怪我・フォームは速く、スタジアムはほぼ変わらない。
const HALF_LIFE_HOURS = {
  injuries: 72,     // 怪我・出場停止は日々変わる
  form: 96,         // 直近フォームは週2試合ペースで変わる
  standings: 168,   // 順位は週1回前後
  xg: 240,          // xG平均は動きが遅い
  coach: 336,       // 監督・布陣は数週間単位
  squad: 336,       // 名簿は移籍期間以外ほぼ固定
  transfers: 336,
  topScorer: 168,
  basic: 2016,      // スタジアム・創設年(84日)
  default: 168,
};

const MIN_FRESHNESS = 0.05; // どれだけ古くても「存在した実測」として最低限の重みは残す

/**
 * 1つのデータの信頼度を機械的に計算する。
 * @param {object} p - { source, kind, computedAt, nowMs }
 * @returns {{ score, base, freshness, ageHours, halfLifeHours, sourceLabelJa, noteJa }}
 */
function trustOf(p) {
  const src = SOURCE_TRUST[p && p.source] || SOURCE_TRUST["api-football"];
  const halfLife = HALF_LIFE_HOURS[p && p.kind] || HALF_LIFE_HOURS.default;
  const now = (p && p.nowMs) || Date.now();
  const at = p && p.computedAt ? new Date(p.computedAt).getTime() : null;
  const ageHours = Number.isFinite(at) ? Math.max(0, (now - at) / 3600000) : null;
  // 取得時刻が不明なデータは、鮮度を確かめようがないので厳しめに半減1回分とみなす
  const freshness = ageHours === null ? 0.5 : Math.max(MIN_FRESHNESS, Math.pow(0.5, ageHours / halfLife));
  const score = Math.round(src.base * freshness * 100) / 100;
  return {
    score,
    base: src.base,
    freshness: Math.round(freshness * 100) / 100,
    ageHours: ageHours === null ? null : Math.round(ageHours),
    halfLifeHours: halfLife,
    sourceLabelJa: src.labelJa,
    noteJa: describeTrustJa(score, src.labelJa, ageHours),
  };
}

function describeTrustJa(score, sourceLabelJa, ageHours) {
  const pct = Math.round(score * 100);
  const age = ageHours === null ? "取得時刻不明" : ageHours < 1 ? "取得直後" : `${Math.round(ageHours)}時間前に取得`;
  return `信頼度${pct}%(${sourceLabelJa}・${age})`;
}

/**
 * 予測記録1件の「学習時の重み(サンプル重み)」。
 * 予測時点で特徴量に付けた信頼度の平均を使う。信頼度が記録されていない
 * 古い記録は1.0(従来どおりの扱い)にする — 記録が無いことを理由に
 * 学習から追い出さない(過去の検証データも貴重なため)。
 */
function sampleWeightOf(record) {
  const t = record && record.featureTrust;
  if (!t) return 1;
  // 第8次監査の修正: avgScore(出所の基礎点込み)をそのまま使うと、取得直後の
  // 実データでも約0.94となり、信頼度記録の無い古いレコード(1.0)より弱く学習される
  // 「逆転」が起きていた。学習の強弱に使うのは**鮮度(avgFreshness)**とする:
  // 全データが取得直後なら1.0(古いレコードと同格)、古いデータで行った予測ほど
  // 学習への影響が下がる — これが本来の意図。avgFreshnessを持たない移行期の
  // レコードは、avgScoreを最高基礎点(0.95)で正規化して近似する。
  if (Number.isFinite(t.avgFreshness)) return Math.max(0.1, Math.min(1, t.avgFreshness));
  if (Number.isFinite(t.avgScore)) return Math.max(0.1, Math.min(1, t.avgScore / 0.95));
  return 1;
}

/**
 * 予測時に使った各データの信頼度をまとめる。
 * @param {Array<{key, source, kind, computedAt}>} parts
 * @returns {{ avgScore, parts: [{key, score, ageHours, sourceLabelJa}], noteJa }}
 */
function buildFeatureTrust(parts, nowMs) {
  const scored = (parts || [])
    .filter((p) => p && p.key)
    .map((p) => {
      const t = trustOf({ ...p, nowMs });
      return { key: p.key, score: t.score, freshness: t.freshness, ageHours: t.ageHours, sourceLabelJa: t.sourceLabelJa };
    });
  if (!scored.length) return null;
  const avg = scored.reduce((s, x) => s + x.score, 0) / scored.length;
  // 学習の強弱に使う鮮度の平均(sampleWeightOf参照。出所の基礎点を含めない)
  const avgFreshness = scored.reduce((s, x) => s + (Number.isFinite(x.freshness) ? x.freshness : 0.5), 0) / scored.length;
  const low = scored.filter((x) => x.score < 0.5).map((x) => x.key);
  return {
    avgScore: Math.round(avg * 100) / 100,
    avgFreshness: Math.round(avgFreshness * 100) / 100,
    parts: scored,
    noteJa: low.length
      ? `使用データの平均信頼度${Math.round(avg * 100)}%(信頼度が下がっているデータ: ${low.join("・")})`
      : `使用データの平均信頼度${Math.round(avg * 100)}%`,
  };
}

module.exports = {
  SOURCE_TRUST, HALF_LIFE_HOURS, MIN_FRESHNESS,
  trustOf, describeTrustJa, sampleWeightOf, buildFeatureTrust,
};
