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
 *   のポアソン尤度を、過去試合(12大会×5シーズン・時間減衰つき)で最大化する。
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
/**
 * v60「地力ランキングの信頼性」(本番実測での欠陥への根治)
 * ------------------------------------------------------------------
 * v58で欧州カップ戦を学習対象に加えた結果、**カップ予選にしか出ないクラブ**が
 * データセットに大量に入った(評価対象 191→364チーム)。本番実測では
 * FCノアシェラン(デンマーク)が地力1位・強さ3.428となり、アーセナル(1.898)や
 * バイエルンを大きく上回るという、明らかに事実に反する順位が出ていた。
 *
 * 原因(合成データで再現・確認済み):
 *   ①出場8試合という下限が低すぎ、②その少数の試合の相手も同じく
 *   「予選しか出ていないクラブ」で固まっているため、**主要リーグと繋がっていない
 *   閉じた集団の中だけで数字が決まる**。弱い相手に大勝した記録だけが残り、
 *   その相手の弱さを測る材料がどこにも無いため、地力が青天井に膨らむ。
 *   (再現実験: 20試合を弱小相手に大勝したクラブが強さ3.397で1位になった。
 *    本番のノアシェラン3.428とほぼ同じ値。)
 *
 * 対処(2つとも統計的に正しい方向の修正であり、恣意的な調整ではない):
 *   ①**反復コア抽出**: 「評価対象チーム同士の試合」だけを数え直して下限を満たさない
 *     チームを外す、を変化が無くなるまで繰り返す。閉じた弱小集団は連鎖的に外れ、
 *     残るのは「十分な試合数で互いに繋がったクラブ」だけになる。
 *   ②**試合数に応じた収縮**: 勾配をチームごとの重み合計で割っている現在の形では、
 *     L2の係数も同じく割らなければ数式として整合しない(現状は実質「試合数が多い
 *     ほど強く正則化される」という逆向きになっていた)。基準値÷そのチームの重みを
 *     掛けることで、データが薄いチームほど平均へ強く引き戻される。
 *
 * 下限40試合の根拠: 1リーグ1シーズンは約38試合。つまり「この5シーズンのデータの中に
 * 1シーズンぶん以上の実績があるクラブだけを評価する」という意味であり、
 * 少数の試合から地力を断定しないための線引き(推測で埋めるよりも、評価しない)。
 */
const MIN_MATCHES_FOR_RATING = 40;  // これ未満のチームは評価しない(でっち上げ防止)
const CORE_MAX_ITERATIONS = 50;     // 反復コア抽出の安全上限(通常2〜4回で収束)
const RATING_SUM_CENTER = 2.6;      // ratingLambdaSum の中心値(平均的な総得点)

/**
 * 反復コア抽出(純関数)。「評価対象同士の試合」だけを数え直して下限未満を外す、を
 * 変化が無くなるまで繰り返す。返すのは評価対象チームIDの集合。
 */
function extractRatedCore(rows, minMatches) {
  let rated = new Set();
  for (const r of rows) { rated.add(r.homeId); rated.add(r.awayId); }
  const totalTeams = rated.size;
  const done = (set, counts, iterations) => ({
    rated: set, counts, iterations, droppedTotal: totalTeams - set.size,
  });
  for (let it = 0; it < CORE_MAX_ITERATIONS; it++) {
    const counts = new Map();
    for (const r of rows) {
      if (!rated.has(r.homeId) || !rated.has(r.awayId)) continue;
      counts.set(r.homeId, (counts.get(r.homeId) || 0) + 1);
      counts.set(r.awayId, (counts.get(r.awayId) || 0) + 1);
    }
    const next = new Set([...counts.entries()].filter(([, n]) => n >= minMatches).map(([id]) => id));
    if (next.size === rated.size) return done(next, counts, it + 1);
    rated = next;
    if (!rated.size) return done(rated, new Map(), it + 1);
  }
  return done(rated, new Map(), CORE_MAX_ITERATIONS);
}

/**
 * 過去試合からチーム別レーティングを学習する。
 * @param {Array} rows - {homeId, awayId, actualHomeGoals, actualAwayGoals, date} を含む行
 * @param {object} opts - { iterations, learningRate, l2, decayXiPerDay, nowMs }
 * @returns {{ available, byTeam, mu, homeAdv, matchesUsed, teamsRated, reasonJa }}
 */
// v71③: 時間減衰ξの既定値(1日あたり)。半減期に直すと約107日。
//   これまで固定だったが、xGブレンド率αと同じ門番方式(検証データで勝った値だけ採用)で
//   毎日の学習時に候補と比較されるようになった(modelTuning参照)。既定値も必ず候補に入る。
const XI_DEFAULT = 0.0065;

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

  // 時間減衰の重み(古い試合ほど軽く)。既定値は XI_DEFAULT(v71で門番付き探索の候補になった)
  const xi = o.decayXiPerDay ?? XI_DEFAULT;
  const nowMs = o.nowMs ?? 0;
  const wOf = (r) => {
    if (!xi || !nowMs) return 1;
    const t = Date.parse(r.date);
    if (!Number.isFinite(t)) return 1;
    return Math.exp(-xi * Math.max(0, (nowMs - t) / 86400000));
  };

  // ---- v60: 反復コア抽出 ----
  //   「評価対象チーム同士の試合」だけを数え直して下限未満を外す、を収束まで繰り返す。
  //   主要リーグと繋がっていない閉じた集団(カップ予選だけの弱小クラブ群)は
  //   連鎖的に外れ、残るのは互いに十分繋がったクラブだけになる。
  const minMatches = Number.isFinite(o.minMatches) ? o.minMatches : MIN_MATCHES_FOR_RATING;
  const core = extractRatedCore(usable, minMatches);
  const rated = core.rated;
  const counts = core.counts;
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
  let wRef = null; // v60: 収縮の基準となる標準的なチームの重み(初回反復で決める)

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
    // ---- v60: 収縮の基準となる「標準的なチームの重み」(中央値)を一度だけ決める ----
    //   これを基準に、データの薄いチームほど強く平均へ引き戻す。
    if (wRef === null) {
      const vals = [...wTeam.values()].filter((v) => v > 0).sort((a, b) => a - b);
      wRef = vals.length ? vals[Math.floor(vals.length / 2)] : 1;
    }
    mu -= lr * (gMu / (2 * totalW));      // 全試合×2得点分の平均勾配
    homeAdv -= lr * (gHome / totalW);     // ホーム側のみの平均勾配
    for (const id of rated) {
      // チームごとの勾配は「そのチームが関わった試合の重み合計」で平均する
      // (試合数の多いチームと少ないチームで学習の歩幅を揃える。標準的な正規化)
      const wt = Math.max(1e-9, wTeam.get(id) || 0);
      // v60: 勾配をwtで割るなら、L2の係数も同じくwtで割らないと数式として整合しない。
      //   基準(中央値)を掛けて、標準的な試合数のチームでは従来と同じ強さになるよう保つ。
      //   → データが薄いチームだけが、より強く平均へ収縮する(統計的に正しい向き)。
      const l2Eff = l2 * (wRef / wt);
      att.set(id, att.get(id) - lr * ((gAtt.get(id) || 0) / wt + l2Eff * att.get(id)));
      def.set(id, def.get(id) - lr * ((gDef.get(id) || 0) / wt + l2Eff * def.get(id)));
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
    // v60: 何を根拠に「評価できる」と判断したかを開示する(説明責任)
    minMatches, coreIterations: core.iterations, teamsDropped: Math.max(0, core.droppedTotal || 0),
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

module.exports = {
  RATINGS_KEY, MIN_MATCHES_FOR_RATING, CORE_MAX_ITERATIONS, RATING_SUM_CENTER,
  extractRatedCore, fitTeamRatings, expGoalsFromRatings, XI_DEFAULT,
};
