/**
 * server/learning/similarityIndex.js
 * ------------------------------------------------
 * 2026年8月・精度証明ラウンド①: RAG強化 —「似たクラブ」「似た試合」。
 * 理想の流れ(ご指示): 質問 → Knowledge → Memory → 似た試合 → 似たクラブ →
 * (似た監督=似たクラブの監督・戦術情報) → 特徴量 → LLM。
 *
 * ■ 設計(最終方針⑥適合)
 *   ・「似ている」の計算は毎晩の学習ジョブが行い、結果を1キーに保存する。
 *     質問時はその読み出しだけ(重い計算・追加API呼び出しはゼロ)。
 *   ・似ているかどうかは実測データ(リーグ順位・xG収支・ホーム勝率)の距離で
 *     機械的に決める。LLMの主観や推測は使わない。
 *   ・比較できる実測が2次元未満のクラブは「似ている」と言わない
 *     (材料不足で無理に似せない)。
 */

const SIMILAR_CLUBS_KEY = "kb:similar:clubs";

// 各次元の「1.0の距離」に相当するスケール(実データの typical range に基づく固定値)
// 成長可視化ラウンド③: 怪我状況(injuryCount)と過密日程(fatigueDiff)も比較次元に追加
// 2026年8月・第三者監査が発見した単位の取り違えの修正:
//   homeWinRate は features.js の computeHomeAwaySplit が返す **0〜1の比率**
//   (例 0.6 = 60%)なのに、目盛りだけ「30ポイント」= 0〜100の百分率のつもりで
//   置かれていた。そのためこの次元の寄与は最大でも 1/30 = 0.033 しかなく、
//   実質的に無視されたまま平均の分母だけを増やし、
//   「比較できる軸が少ないクラブほど似ている」と誤判定させていた。
//   目盛り(30ポイント差で距離1.0)は名前どおり「百分率」の想定で正しいので、
//   直すのは**入れる値の単位**の方(下の clubVectorFromDossier で百分率に変換する)。
const CLUB_SCALES = { position: 10, xgNet: 1.0, homeWinRatePct: 30, injuryCount: 4 };
const MATCH_FEATURE_SCALES = { formDiff: 40, goalRateDiff: 1.5, standingsDiff: 1.0, xgDiff: 1.2, injuryDiff: 4, fatigueDiff: 3 };

/** クラブ調査ファイル(dossier)から比較用の実測ベクトルを作る(無い値はnullのまま) */
function clubVectorFromDossier(dossier) {
  const secs = (dossier && dossier.sections) || {};
  return {
    position: secs.standings && Number.isFinite(secs.standings.position) ? secs.standings.position : null,
    xgNet: secs.xg && Number.isFinite(secs.xg.xgNet) ? secs.xg.xgNet : null,
    // features.js の computeHomeAwaySplit が返す homeWinRate は **0〜1の比率**
    // (0.6 = 勝率60%)。フィールド名(…Pct)と目盛り(30)は百分率の想定なので、
    // ここで百分率へ揃える。揃えないとこの軸の寄与が実質ゼロになる(第三者監査の指摘)。
    homeWinRatePct: secs.form && Number.isFinite(secs.form.homeWinRate) ? Math.round(secs.form.homeWinRate * 1000) / 10 : null,
    injuryCount: secs.injuries && Number.isFinite(secs.injuries.injuryCount) ? secs.injuries.injuryCount : null,
  };
}

/**
 * 成長可視化ラウンド③: 数値の距離では測れない「質的な類似」(同じ布陣・監督名)を
 * 調査ファイルから取り出す。索引の各entryに実測の共通点として添える。
 */
function clubTraitsFromDossier(dossier) {
  const secs = (dossier && dossier.sections) || {};
  return {
    formation: secs.coach && secs.coach.formation ? String(secs.coach.formation) : null,
    coachName: secs.coach && secs.coach.coachName ? String(secs.coach.coachName) : null,
  };
}

/** 2つのベクトルの距離(共有する非null次元のみ・各次元をスケールで正規化した平均) */
function vectorDistance(a, b, scales) {
  let sum = 0, dims = 0;
  const basis = [];
  for (const [key, scale] of Object.entries(scales)) {
    const va = a ? a[key] : null, vb = b ? b[key] : null;
    if (va === null || va === undefined || vb === null || vb === undefined) continue;
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    sum += Math.abs(va - vb) / scale;
    dims++;
    basis.push(key);
  }
  if (dims < 2) return null; // 比較できる実測が少なすぎる → 「似ている」と言わない
  return { distance: Math.round((sum / dims) * 1000) / 1000, dims, basis };
}

const CLUB_BASIS_JA = { position: "リーグ順位", xgNet: "xG収支", homeWinRatePct: "ホーム勝率", injuryCount: "怪我人数" };

/**
 * 全クラブの「似たクラブ上位3」索引を作る(毎晩1回・純関数)。
 * clubs: [{ teamEn, teamJa, vector, traits? }]
 * 成長可視化ラウンド③: 数値の距離に加えて、同じ布陣・怪我人数の近さ・監督名も
 * 「実測の共通点」(sharedTraitsJa)として各entryに添える。
 */
function buildClubSimilarityIndex(clubs, builtAtIso) {
  const list = (clubs || []).filter((c) => c && c.teamEn && c.vector);
  const index = {};
  let comparableClubs = 0;
  for (const c of list) {
    const sims = [];
    for (const o of list) {
      if (o.teamEn === c.teamEn) continue;
      const d = vectorDistance(c.vector, o.vector, CLUB_SCALES);
      if (!d) continue;
      const sharedTraitsJa = [];
      const ct = c.traits || {}, ot = o.traits || {};
      if (ct.formation && ot.formation && ct.formation === ot.formation) sharedTraitsJa.push(`同じ基本布陣(${ot.formation})`);
      if (Number.isFinite(c.vector.injuryCount) && Number.isFinite(o.vector.injuryCount) && Math.abs(c.vector.injuryCount - o.vector.injuryCount) <= 1) {
        sharedTraitsJa.push(`怪我人数も同水準(${o.vector.injuryCount}人)`);
      }
      sims.push({
        teamEn: o.teamEn, teamJa: o.teamJa || null, distance: d.distance,
        basisJa: d.basis.map((k) => CLUB_BASIS_JA[k]).join("・"),
        sharedTraitsJa,
        coachName: ot.coachName || null,
      });
    }
    if (!sims.length) continue;
    sims.sort((x, y) => x.distance - y.distance);
    index[c.teamEn.toLowerCase()] = { teamEn: c.teamEn, teamJa: c.teamJa || null, similar: sims.slice(0, 3) };
    comparableClubs++;
  }
  return {
    available: comparableClubs > 0,
    builtAt: builtAtIso || null,
    clubCount: list.length,
    comparableClubs,
    index,
    noteJa: comparableClubs
      ? `${comparableClubs}クラブについて、実測(順位・xG収支・ホーム勝率)の距離で「似たクラブ」を索引化しました(毎晩更新)。`
      : "比較できる実測データ(2次元以上)を持つクラブがまだ無いため、似たクラブの索引はまだ作れません(収集が進むと自動で作られます)。",
  };
}

/**
 * 「似た試合」: これから行う予測の特徴量に近い、答え合わせ済みの過去試合を探す。
 * 毎晩の予測記録時に呼ばれる(手元のメモリ内データのみ・追加読み出しなし)。
 */
function findSimilarResolvedMatches(features, resolvedRecords, topN) {
  if (!features) return [];
  const out = [];
  for (const r of resolvedRecords || []) {
    if (!r || !r.resolved || !r.actualWinner || !r.features) continue;
    const d = vectorDistance(features, r.features, MATCH_FEATURE_SCALES);
    if (!d) continue;
    out.push({
      homeTeamEn: r.homeTeamEn || null, awayTeamEn: r.awayTeamEn || null,
      actualWinner: r.actualWinner, predictedWinner: r.predictedWinner || null,
      correct: r.correct === true, distance: d.distance,
    });
  }
  out.sort((x, y) => x.distance - y.distance);
  return out.slice(0, Math.max(1, topN || 3));
}

/** 似た試合の結果を1行の日本語にまとめる(でっち上げ無しの機械的集計) */
function summarizeSimilarMatchesJa(similarList) {
  if (!similarList || !similarList.length) return null;
  const counts = { home: 0, draw: 0, away: 0 };
  similarList.forEach((m) => { if (counts[m.actualWinner] !== undefined) counts[m.actualWinner]++; });
  const parts = [];
  if (counts.home) parts.push(`ホーム勝ち${counts.home}`);
  if (counts.draw) parts.push(`引き分け${counts.draw}`);
  if (counts.away) parts.push(`アウェイ勝ち${counts.away}`);
  return `特徴量(フォーム・得点力・順位・xG・怪我・日程)が似た状況の過去${similarList.length}試合の実結果: ${parts.join("・")}`;
}

/** クラブと同名エクスポート(似た監督・布陣情報の取り出しに使う) */

async function saveClubSimilarityIndex(deps, indexObj) {
  const { upstashEnabled, upstashSetJSON } = deps || {};
  if (!upstashEnabled || !indexObj) return false;
  try { await upstashSetJSON(SIMILAR_CLUBS_KEY, indexObj); return true; } catch (e) { return false; }
}

async function loadClubSimilarityIndex(deps) {
  const { upstashEnabled, upstashGetJSON } = deps || {};
  if (!upstashEnabled) return null;
  try { return await upstashGetJSON(SIMILAR_CLUBS_KEY); } catch (e) { return null; }
}

module.exports = {
  SIMILAR_CLUBS_KEY, CLUB_SCALES, MATCH_FEATURE_SCALES,
  clubVectorFromDossier, clubTraitsFromDossier, vectorDistance,
  buildClubSimilarityIndex, findSimilarResolvedMatches, summarizeSimilarMatchesJa,
  saveClubSimilarityIndex, loadClubSimilarityIndex,
};
