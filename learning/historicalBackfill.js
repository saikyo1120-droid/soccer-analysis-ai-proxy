/**
 * server/learning/historicalBackfill.js
 * ------------------------------------------------
 * 2026年8月・共同開発者レビューを受けて新設。
 *
 * ■ なぜ必要か(この設計変更が最も効果が大きい)
 *   これまで予測モデルの学習データは `learn:ownpred:recent`
 *   =「自分が予測した試合」だけだった。そのため本番でも36件しか貯まらず、
 *   11個の特徴量のうち10個の重みが初期値0のまま=実質1変数モデルだった。
 *   「20件/日なので300件まで2週間」と見積もっていたが、これは
 *   **問題の立て方そのものが間違っていた**。
 *
 *   モデルの学習に必要なのは「自分が予測したか」ではなく
 *   **「特徴量と結果のペア」**である。API-Football は
 *     GET /fixtures?league=39&season=2025
 *   で1リーグ1シーズン(約380試合)を **1リクエスト** で返す。
 *   5リーグ × 3シーズン = 15リクエストで約5,700試合。
 *   本番のAPI予算は7,500件/日で、日次学習の実測消費は約1,000件。
 *   つまり**余っている予算だけで、その日のうちに現状の158倍の学習データを作れる。**
 *
 *   機械学習では Backfill / Historical Training と呼ばれる標準的な手法で、
 *   本来なら最初にやるべきことだった。
 *
 * ■ でっち上げ防止の方針
 *   ・取得できた実試合の結果のみを使う。欠損は0で埋めず、その特徴量を
 *     「取得できなかった」として除外する(既存のdiffOrZeroと同じ考え方)。
 *   ・過去試合の特徴量は「その試合より前の情報だけ」から作る(リーク防止)。
 *     未来の情報を使うと、バックテストの数字が実際より良く出てしまう。
 *   ・時間減衰(Dixon-Coles)により、古い試合ほど学習への影響を小さくする。
 */

// 動作確認済みのリーグID(clubUniverse.jsと同じ基準。未確認IDは決め打ちしない)
const DEFAULT_BACKFILL_LEAGUES = [
  { id: 39, nameJa: "プレミアリーグ" },
  { id: 140, nameJa: "ラ・リーガ" },
  { id: 78, nameJa: "ブンデスリーガ" },
  { id: 135, nameJa: "セリエA" },
  { id: 61, nameJa: "リーグ・アン" },
];

const BACKFILL_KEY = "learn:backfill:dataset";
const BACKFILL_META_KEY = "learn:backfill:meta";
// 1シーズン380試合 × 5リーグ × 3シーズン ≒ 5,700件。
// 1件あたり約200バイトに圧縮して保存するため、約1.1MB。Upstashの1キー上限に
// 収まるよう、保存時は必要最小限のフィールドだけにする。
const MAX_STORED_MATCHES = 8000;

const FINISHED = new Set(["FT", "AET", "PEN"]);

/**
 * 指定リーグ・シーズンの全試合を取得して、学習に使える形へ整形する。
 * @returns {{ matches: Array, requests: number, errors: string[] }}
 */
async function fetchSeason(callApiFootball, leagueId, season) {
  const errors = [];
  let requests = 0;
  try {
    const data = await callApiFootball("/fixtures", { league: leagueId, season });
    requests++;
    const rows = (data && data.response) || [];
    const matches = [];
    for (const r of rows) {
      if (!r || !r.fixture || !r.teams || !r.goals) continue;
      const st = r.fixture.status ? r.fixture.status.short : null;
      if (!FINISHED.has(st)) continue;                    // 未実施・中止は学習に使わない
      if (r.goals.home === null || r.goals.away === null) continue;
      matches.push({
        id: r.fixture.id,
        date: r.fixture.date,
        leagueId,
        season,
        homeId: r.teams.home.id,
        awayId: r.teams.away.id,
        homeName: r.teams.home.name,
        awayName: r.teams.away.name,
        hg: r.goals.home,
        ag: r.goals.away,
      });
    }
    return { matches, requests, errors };
  } catch (e) {
    errors.push(`backfill_failed:league=${leagueId}:season=${season}:${e.code || e.message}`);
    return { matches: [], requests, errors };
  }
}

/**
 * 複数リーグ・複数シーズンをまとめて取得する。
 * apiBudget を渡すと、予算が足りない場合は取得を打ち切り、理由を残す。
 */
async function backfillSeasons(deps, opts) {
  const { callApiFootball, apiBudget } = deps;
  const o = opts || {};
  const leagues = o.leagues || DEFAULT_BACKFILL_LEAGUES;
  const seasons = o.seasons || [];
  const all = [];
  const errors = [];
  const skipped = [];
  let requests = 0;

  for (const league of leagues) {
    for (const season of seasons) {
      // 1リクエストぶんの予算も無ければ、黙って止めずに理由を残す
      if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(1)) {
        skipped.push({
          leagueId: league.id, season,
          reasonJa: `APIの残り予算が不足したため、${league.nameJa}(${season})以降の過去試合の取得を見送りました。`,
        });
        continue;
      }
      const r = await fetchSeason(callApiFootball, league.id, season);
      requests += r.requests;
      errors.push(...r.errors);
      all.push(...r.matches);
    }
  }

  // 同じ試合を二重に持たない(リーグ再編などでIDが重複しうる)
  const seen = new Set();
  const unique = [];
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }
  unique.sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    matches: unique.slice(-MAX_STORED_MATCHES),
    requests,
    errors,
    skipped,
    noteJa: `${leagues.length}リーグ×${seasons.length}シーズンから${unique.length}試合を取得しました(APIリクエスト${requests}件)。`,
  };
}

/**
 * ---- 特徴量の構築(リーク防止つき) ----
 * 各試合について「その試合より前の試合だけ」からチームの状態を作る。
 * 直近N試合の得点・失点・勝率・ホーム/アウェイ別成績を、時系列を進めながら
 * 逐次更新する(1パス)。未来の情報は一切使わない。
 *
 * @param {Array} matches 日付昇順の試合配列
 * @param {number} window 直近何試合を使うか(既定10。既存のフォーム計算と揃える)
 */
function buildTrainingRows(matches, window) {
  const W = window || 10;
  const hist = new Map(); // teamId -> [{date, gf, ga, isHome, win}]
  const rows = [];

  const statsOf = (teamId, isHomeSide) => {
    const h = hist.get(teamId) || [];
    if (h.length < 3) return null; // 3試合未満は状態を推定しない(でっち上げ防止)
    const recent = h.slice(-W);
    const n = recent.length;
    const gf = recent.reduce((s, x) => s + x.gf, 0) / n;
    const ga = recent.reduce((s, x) => s + x.ga, 0) / n;
    const formScore = recent.reduce((s, x) => s + (x.gf - x.ga), 0) / n;
    const sideGames = recent.filter((x) => x.isHome === isHomeSide);
    const sideWinRate = sideGames.length >= 2
      ? sideGames.filter((x) => x.win).length / sideGames.length
      : null;
    const points = recent.reduce((s, x) => s + (x.gf > x.ga ? 3 : x.gf === x.ga ? 1 : 0), 0);
    return {
      formScore,
      avgGoalsFor: gf,
      avgGoalsAgainst: ga,
      pointsPerGame: points / n,
      homeVenueWinRate: isHomeSide ? sideWinRate : null,
      awayVenueWinRate: isHomeSide ? null : sideWinRate,
      sampleSize: n,
    };
  };

  for (const m of matches) {
    const hCtx = statsOf(m.homeId, true);
    const aCtx = statsOf(m.awayId, false);
    // 両チームとも十分な履歴がある試合だけを学習に使う
    if (hCtx && aCtx) {
      rows.push({
        fixtureId: m.id,
        date: m.date,
        leagueId: m.leagueId,
        homeName: m.homeName,
        awayName: m.awayName,
        homeCtx: hCtx,
        awayCtx: aCtx,
        actualHomeGoals: m.hg,
        actualAwayGoals: m.ag,
        actualWinner: m.hg > m.ag ? "home" : m.hg < m.ag ? "away" : "draw",
      });
    }
    // この試合の結果を履歴へ反映(次の試合以降にだけ影響する = リークしない)
    const push = (teamId, gf, ga, isHome) => {
      const arr = hist.get(teamId) || [];
      arr.push({ date: m.date, gf, ga, isHome, win: gf > ga });
      if (arr.length > 40) arr.shift();
      hist.set(teamId, arr);
    };
    push(m.homeId, m.hg, m.ag, true);
    push(m.awayId, m.ag, m.hg, false);
  }

  return rows;
}

/**
 * Dixon-Colesの時間減衰重み。古い試合ほど軽くする。
 * 文献の標準値 ξ=0.0065/日 は半減期およそ107日。
 * ξ=0 のときすべて1(=減衰なし)なので、既存の挙動と一致する。
 */
function timeDecayWeight(matchDateIso, referenceMs, xi) {
  if (!xi) return 1;
  const t = Date.parse(matchDateIso);
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (referenceMs - t) / 86400000);
  return Math.exp(-xi * days);
}

// ---- 2026年8月・検証で判明した「保存できていないのに成功と報告する」欠陥 ----
//   5リーグ×3シーズンの学習データは実測で約1.3MB(本物のシーズンなら約2MB)。
//   これを1キーに入れると Upstash の1値/1リクエストの上限を超えて保存に失敗する。
//   ところが保存関数の戻り値を捨てていたため、毎日
//     「3,809件の学習データを作りました」と成功を報告しながら1件も保存されず、
//     翌日また15リクエストを使って取り直す
//   という自己強化ループになりうる状態だった(週1回のはずが毎日15件)。
//   選手索引と同じくブロック分割で保存し、**保存できたかどうかを必ず返す**。
const BACKFILL_SHARD_SIZE = 1200;                       // 1ブロックあたりの試合数
const BACKFILL_MAX_SHARDS = 12;                          // 上限14,400件
const backfillShardKey = (i) => `${BACKFILL_KEY}:s${i}`;

async function saveDataset(deps, rows, meta) {
  const { upstashEnabled, upstashSetJSON, upstashCmd, upstashGetJSON } = deps;
  if (!upstashEnabled) return { saved: false, reasonJa: "保存先(Upstash)が未設定のため、学習データを保存できません。" };
  // 保存サイズを抑えるため、学習に必要な項目だけを残す
  const slim = rows.map((r) => ({
    d: r.date, l: r.leagueId,
    h: r.homeCtx, a: r.awayCtx,
    hg: r.actualHomeGoals, ag: r.actualAwayGoals, w: r.actualWinner,
  }));
  const shardCount = Math.min(BACKFILL_MAX_SHARDS, Math.max(1, Math.ceil(slim.length / BACKFILL_SHARD_SIZE)));
  const stored = slim.slice(0, shardCount * BACKFILL_SHARD_SIZE);
  const truncated = slim.length - stored.length;
  const failed = [];
  for (let i = 0; i < shardCount; i++) {
    const chunk = stored.slice(i * BACKFILL_SHARD_SIZE, (i + 1) * BACKFILL_SHARD_SIZE);
    if ((await upstashSetJSON(backfillShardKey(i), chunk)) === false) failed.push(i);
  }
  if (failed.length) {
    return {
      saved: false, failedShards: failed,
      reasonJa: `学習データの保存に失敗しました(${failed.length}/${shardCount}ブロック)。次回の実行で作り直します。`,
    };
  }
  // 前世代の余りブロックを片付ける
  const prevMeta = upstashGetJSON ? await upstashGetJSON(BACKFILL_META_KEY).catch(() => null) : null;
  const prevShards = prevMeta && Number.isFinite(prevMeta.shardCount) ? prevMeta.shardCount : 0;
  if (upstashCmd) {
    for (let i = shardCount; i < Math.min(BACKFILL_MAX_SHARDS, prevShards); i++) {
      await upstashCmd(["DEL", backfillShardKey(i)]).catch(() => {});
    }
    // 旧形式(単一キー)が残っていると読み出しで混ざるので消す
    await upstashCmd(["DEL", BACKFILL_KEY]).catch(() => {});
  }
  const fullMeta = { ...(meta || {}), shardCount, shardSize: BACKFILL_SHARD_SIZE, storedRows: stored.length, truncatedRows: truncated };
  const okMeta = (await upstashSetJSON(BACKFILL_META_KEY, fullMeta)) !== false;
  return {
    saved: okMeta, shardCount, storedRows: stored.length, truncatedRows: truncated, meta: fullMeta,
    reasonJa: okMeta
      ? (truncated ? `上限を超えた${truncated}件は保存していません(直近${stored.length}件を保存)。` : null)
      : "学習データの目次の保存に失敗しました。",
  };
}

async function loadDataset(deps) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) return { rows: [], meta: null };
  const meta = (await upstashGetJSON(BACKFILL_META_KEY).catch(() => null)) || null;
  let slim = [];
  if (meta && Number.isFinite(meta.shardCount) && meta.shardCount > 0) {
    for (let i = 0; i < Math.min(BACKFILL_MAX_SHARDS, meta.shardCount); i++) {
      const chunk = await upstashGetJSON(backfillShardKey(i)).catch(() => null);
      if (Array.isArray(chunk)) slim.push(...chunk);
    }
  } else {
    // 旧形式(単一キー)からの読み出し。移行期のみ通る。
    slim = (await upstashGetJSON(BACKFILL_KEY).catch(() => null)) || [];
  }
  const rows = slim.map((r) => ({
    date: r.d, leagueId: r.l,
    homeCtx: r.h, awayCtx: r.a,
    actualHomeGoals: r.hg, actualAwayGoals: r.ag, actualWinner: r.w,
  }));
  return { rows, meta };
}

module.exports = {
  DEFAULT_BACKFILL_LEAGUES, BACKFILL_KEY, BACKFILL_META_KEY, MAX_STORED_MATCHES,
  BACKFILL_SHARD_SIZE, BACKFILL_MAX_SHARDS, backfillShardKey,
  fetchSeason, backfillSeasons, buildTrainingRows, timeDecayWeight,
  saveDataset, loadDataset,
};
