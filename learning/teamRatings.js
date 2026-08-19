/**
 * server/learning/teamRatings.js
 * ------------------------------------------------
 * 2026年8月18日・v50「チームの地力レーティング」(利用者の選択①)。
 *
 * ■ なぜ必要か(第9次監査後の診断)
 *   従来のモデルは「直近の調子・得失点・順位の差」だけで予測しており、
 *   チームそのものの強さ(地力)のパラメータを持っていなかった。ホームの
 *   下駄(homeBase)も全クラブ共通の定数。そのため外れ理由の第1位が
 *   「直近フォームを重視しすぎた」(本番実測×66件)になっていた——
 *   フォーム以外に頼れる軸が無いからフォームに頼りすぎる。
 *
 * ■ 手法(Dixon-Coles 1997 の本来の形。サッカー予測の古典・標準)
 *   各チーム t に攻撃力 att_t と守備力 def_t を持たせ、
 *     λ(ホーム得点) = exp(mu + homeAdv + att_home − def_away)
 *     λ(アウェイ得点) = exp(mu + att_away − def_home)
 *   のポアソン尤度を、過去試合(9リーグ×3シーズン・時間減衰つき)で最大化する。
 *   ・勾配は解析形(∂NLL/∂θ = Σ(λ−k)×∂logλ/∂θ)なので高速・正確。
 *   ・識別性: att と def は毎反復で平均0に再センタリングする。
 *   ・過学習防止: L2正則化 + 出場試合数が閾値未満のチームは評価しない
 *     (レーティング無し=影響0。少ない試合からでっち上げない)。
 *
 * ■ 既存モデルへの組み込み(劣化禁止)
 *   レーティングから求めた「地力ベースの期待得点」λ̂H・λ̂A を、既存の
 *   特徴量アーキテクチャに2つの特徴量として渡す:
 *     ratingLambdaDiff = λ̂H − λ̂A(どちらが強いか)
 *     ratingLambdaSum  = (λ̂H + λ̂A) − 中心値(点の入りやすさ)
 *   重みは初期値0(=導入した瞬間は挙動が1ミリも変わらない)。過去試合での
 *   勾配学習と自前記録の学習が、実測でどれだけ信頼するかを決める。
 */

const RATINGS_KEY = "learn:ratings:v1";
const MIN_MATCHES_FOR_RATING = 8;   // これ未満のチームは評価しない(でっち上げ防止)
const RATING_SUM_CENTER = 2.6;      // ratingLambdaSum の中心値(平均的な総得点)

/**
 * 過去試合からチーム別レーティングを学習する。
 * @param {Array} rows - {homeId, awayId, actualHomeGoals, actualAwayGoals, date} を含む行
 * @param {object} opts - { iterations, learningRate, l2, decayXiPerDay, nowMs }
 * @returns {{ available, byTeam, mu, homeAdv, matchesUsed, teamsRated, reasonJa }}
 */
function fitTeamRatings(rows, opts) {
  const o = opts || {};
  const usable = (rows || []).filter((r) => r
    && Number.isFinite(r.homeId) && Number.isFinite(r.awayId)
    && Number.isFinite(r.actualHomeGoals) && Number.isFinite(r.actualAwayGoals));
  if (usable.length < 300) {
    return { available: false, byTeam: {}, matchesUsed: usable.length, teamsRated: 0, reasonJa: `チームID付きの過去試合が${usable.length}件で、レーティング学習に必要な300件に達していません。` };
  }

  // ---- v57: xGブレンド(有効ゴール) ----
  //   g_eff = α×xG + (1−α)×実ゴール。xGが無い行は実ゴールのまま。
  //   α=0(既定)では従来と1ビットも変わらない(劣化禁止)。
  const xgAlpha = Number.isFinite(o.xgAlpha) ? Math.max(0, Math.min(1, o.xgAlpha)) : 0;
  const effGoals = (r) => {
    if (xgAlpha > 0 && Number.isFinite(r.xgH) && Number.isFinite(r.xgA)) {
      return [xgAlpha * r.xgH + (1 - xgAlpha) * r.actualHomeGoals,
              xgAlpha * r.xgA + (1 - xgAlpha) * r.actualAwayGoals];
    }
    return [r.actualHomeGoals, r.actualAwayGoals];
  };

  // 時間減衰の重み(古い試合ほど軽く)
  const xi = o.decayXiPerDay ?? 0.0065;
  const nowMs = o.nowMs ?? 0;
  const wOf = (r) => {
    if (!xi || !nowMs) return 1;
    const t = Date.parse(r.date);
    if (!Number.isFinite(t)) return 1;
    return Math.exp(-xi * Math.max(0, (nowMs - t) / 86400000));
  };

  // 出場試合数を数え、閾値未満のチームは学習対象から除外する
  const counts = new Map();
  for (const r of usable) {
    counts.set(r.homeId, (counts.get(r.homeId) || 0) + 1);
    counts.set(r.awayId, (counts.get(r.awayId) || 0) + 1);
  }
  const rated = new Set([...counts.entries()].filter(([, n]) => n >= MIN_MATCHES_FOR_RATING).map(([id]) => id));
  // 両チームとも評価対象の試合だけで学習する(片側不明の試合はレーティングを歪める)
  const train = usable.filter((r) => rated.has(r.homeId) && rated.has(r.awayId));
  if (train.length < 300) {
    return { available: false, byTeam: {}, matchesUsed: train.length, teamsRated: rated.size, reasonJa: `評価可能チーム同士の試合が${train.length}件で不足しています。` };
  }

  const att = new Map(), def = new Map();
  for (const id of rated) { att.set(id, 0); def.set(id, 0); }
  let mu = Math.log(1.35); // 平均的な1チームの得点の対数から開始
  let homeAdv = 0.2;
  const lr = o.learningRate ?? 0.1;
  const l2 = o.l2 ?? 0.02;
  const iterations = o.iterations ?? 150;

  for (let iter = 0; iter < iterations; iter++) {
    const gAtt = new Map(), gDef = new Map(), wTeam = new Map();
    let gMu = 0, gHome = 0, totalW = 0;
    for (const r of train) {
      const w = wOf(r);
      totalW += w;
      const lh = Math.exp(mu + homeAdv + att.get(r.homeId) - def.get(r.awayId));
      const la = Math.exp(mu + att.get(r.awayId) - def.get(r.homeId));
      const [gH, gA] = effGoals(r); // v57: xGブレンド(α=0なら実ゴールそのもの)
      const dh = (lh - gH) * w; // ∂NLL/∂(logλH)
      const da = (la - gA) * w;
      gMu += dh + da;
      gHome += dh;
      gAtt.set(r.homeId, (gAtt.get(r.homeId) || 0) + dh);
      gAtt.set(r.awayId, (gAtt.get(r.awayId) || 0) + da);
      gDef.set(r.awayId, (gDef.get(r.awayId) || 0) - dh);
      gDef.set(r.homeId, (gDef.get(r.homeId) || 0) - da);
      wTeam.set(r.homeId, (wTeam.get(r.homeId) || 0) + w);
      wTeam.set(r.awayId, (wTeam.get(r.awayId) || 0) + w);
    }
    if (totalW <= 0) break;
    mu -= lr * (gMu / (2 * totalW));      // 全試合×2得点分の平均勾配
    homeAdv -= lr * (gHome / totalW);     // ホーム側のみの平均勾配
    for (const id of rated) {
      // チームごとの勾配は「そのチームが関わった試合の重み合計」で平均する
      // (試合数の多いチームと少ないチームで学習の歩幅を揃える。標準的な正規化)
      const wt = Math.max(1e-9, wTeam.get(id) || 0);
      att.set(id, att.get(id) - lr * ((gAtt.get(id) || 0) / wt + l2 * att.get(id)));
      def.set(id, def.get(id) - lr * ((gDef.get(id) || 0) / wt + l2 * def.get(id)));
    }
    // 識別性: att/def を平均0へ再センタリング(ずれは mu が吸収する)
    const attMean = [...att.values()].reduce((s, v) => s + v, 0) / rated.size;
    const defMean = [...def.values()].reduce((s, v) => s + v, 0) / rated.size;
    for (const id of rated) { att.set(id, att.get(id) - attMean); def.set(id, def.get(id) - defMean); }
    mu += attMean - defMean;
    // 発散ガード: 数値が壊れたら打ち切って「学習失敗」を正直に返す
    if (!Number.isFinite(mu) || !Number.isFinite(homeAdv)) {
      return { available: false, byTeam: {}, matchesUsed: train.length, teamsRated: rated.size, reasonJa: "レーティング学習が数値的に発散したため、結果を採用しません。" };
    }
  }

  const byTeam = {};
  for (const id of rated) {
    const a = att.get(id), d = def.get(id);
    if (!Number.isFinite(a) || !Number.isFinite(d) || Math.abs(a) > 3 || Math.abs(d) > 3) continue; // 壊れた値は保存しない
    byTeam[id] = { att: Math.round(a * 1000) / 1000, def: Math.round(d * 1000) / 1000, n: counts.get(id) || 0 };
  }
  return {
    available: Object.keys(byTeam).length >= 20,
    xgAlpha, // v57: 学習に使ったxGブレンド率(0=実ゴールのみ)
    byTeam, mu: Math.round(mu * 1000) / 1000, homeAdv: Math.round(homeAdv * 1000) / 1000,
    matchesUsed: train.length, teamsRated: Object.keys(byTeam).length,
    reasonJa: null,
  };
}

/**
 * レーティングから「地力ベースの期待得点」を求める。
 * どちらかのチームのレーティングが無ければ null(=特徴量0・影響なし)。
 */
function expGoalsFromRatings(ratings, homeId, awayId) {
  if (!ratings || !ratings.available || !ratings.byTeam) return null;
  const h = ratings.byTeam[homeId], a = ratings.byTeam[awayId];
  if (!h || !a) return null;
  const lh = Math.exp(ratings.mu + ratings.homeAdv + h.att - a.def);
  const la = Math.exp(ratings.mu + a.att - h.def);
  if (!Number.isFinite(lh) || !Number.isFinite(la)) return null;
  return { home: Math.round(lh * 100) / 100, away: Math.round(la * 100) / 100 };
}

module.exports = { RATINGS_KEY, MIN_MATCHES_FOR_RATING, RATING_SUM_CENTER, fitTeamRatings, expGoalsFromRatings };
