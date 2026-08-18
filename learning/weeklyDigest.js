/**
 * server/learning/weeklyDigest.js
 * ------------------------------------------------
 * 2026年8月18日・v48「週間AIダイジェスト」(利用者の選択)。
 *
 * 毎週月曜(日本時間)に、直前の1週間(月曜0:00〜日曜24:00 JST)の
 * 「AIの1週間」を実データだけから機械的に組み立てる読み物。
 *   ・今週の成績(公式戦と参考試合を分けて)
 *   ・ベスト的中(市場=ブックメーカーが最も疑っていたのに当てた試合)
 *   ・一番の外れ(AIが最も自信を持っていたのに外した試合と、その理由)
 *   ・AIが学んだこと(実際に採用された重みの変化)
 *   ・来週の注目試合(保存済みの予測から)
 *
 * ■ でっち上げ防止
 *   すべて保存済みの実測記録(learn:ownpred:*, learn:weights:history)から
 *   機械的に選ぶ。LLMは使わない。該当が無い項目は正直に「ありませんでした」。
 * ■ コスト
 *   生成は日次学習ジョブ内で週1回だけ(Redis読み書きのみ・API呼び出しゼロ)。
 *   利用者への配信は保存済みJSONの読み出し(+10分キャッシュ)のみ。
 */
const { computeMarketProbs } = require("./accuracyTracker");
const { describeWeightsHistoryEntry, classifyFixtureOfficial } = require("./predictionModel");
const { CLUB_UNIVERSE } = require("./clubUniverse");

const DIGEST_LATEST_KEY = "learn:digest:latest";
const DIGEST_HISTORY_KEY = "learn:digest:history";
const DIGEST_HISTORY_KEEP = 12;
const JST_OFFSET_MS = 9 * 3600 * 1000;

const RANK_BY_EN = new Map(CLUB_UNIVERSE.map((c) => [c.nameEn.toLowerCase(), c.rank]));
const JA_BY_EN = new Map(CLUB_UNIVERSE.map((c) => [c.nameEn.toLowerCase(), c.nameJa]));

/** 直前に「完了した」週(月曜0:00 JST 〜 次の月曜0:00 JST)の範囲を返す。 */
function lastCompletedWeekRange(nowMs) {
  const jst = new Date(nowMs + JST_OFFSET_MS);
  // JSTの「今日」の0:00(UTCミリ秒で表現)
  const todayStartJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - JST_OFFSET_MS;
  const dow = jst.getUTCDay(); // 0=日,1=月,...
  const daysSinceMonday = (dow + 6) % 7; // 月曜=0
  const thisMondayMs = todayStartJstMs - daysSinceMonday * 86400000;
  return { startMs: thisMondayMs - 7 * 86400000, endMs: thisMondayMs };
}

function weekKeyOf(startMs) {
  const d = new Date(startMs + JST_OFFSET_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`; // 週の開始日(JST・月曜)で一意にする
}

function dateJa(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  const youbi = ["日", "月", "火", "水", "木", "金", "土"][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${youbi})`;
}

function clubJa(nameEn) {
  return (nameEn && JA_BY_EN.get(String(nameEn).toLowerCase())) || nameEn || "不明";
}

function winnerJa(r, side) {
  if (side === "home") return `${clubJa(r.homeTeamEn)}の勝利`;
  if (side === "away") return `${clubJa(r.awayTeamEn)}の勝利`;
  return "引き分け";
}

function scoreStr(r) {
  return (r.actualScore && Number.isFinite(Number(r.actualScore.home)))
    ? `${r.actualScore.home}-${r.actualScore.away}` : null;
}

function isOfficialRec(r) {
  return r.official !== undefined
    ? r.official !== false
    : classifyFixtureOfficial(r.league || null, r.homeTeamEn, r.awayTeamEn).official;
}

/** その予測が自分の予想勝敗に割り当てていた確率(実測: λから機械的に計算)。 */
function ownConfidencePct(r) {
  if (r.marketScores && r.marketScores.markets && r.marketScores.markets.oneX2
    && Number.isFinite(r.marketScores.markets.oneX2.confidence)) {
    return Math.round(r.marketScores.markets.oneX2.confidence * 100);
  }
  if (Number.isFinite(r.homeLambda) && Number.isFinite(r.awayLambda)) {
    const p = computeMarketProbs(r.homeLambda, r.awayLambda);
    if (p) {
      const v = r.predictedWinner === "home" ? p.homeWin : r.predictedWinner === "away" ? p.awayWin : p.draw;
      return Math.round(v * 100);
    }
  }
  return null;
}

/** 市場(ブックメーカー)がその予想勝敗に与えていた含意確率(%)。無ければnull。 */
function marketPctForPick(r) {
  const m = r.marketImplied;
  if (!m) return null;
  const v = r.predictedWinner === "home" ? m.homePct : r.predictedWinner === "away" ? m.awayPct : m.drawPct;
  return Number.isFinite(v) ? v : null;
}

function topReasonJa(r) {
  const ctx = Array.isArray(r.contextualFailureReasons) ? r.contextualFailureReasons : [];
  if (ctx.length && ctx[0] && ctx[0].labelJa) return ctx[0].labelJa;
  const fr = Array.isArray(r.failureReasons) ? r.failureReasons : [];
  if (fr.length && fr[0] && fr[0].labelJa) return fr[0].labelJa;
  return null;
}

/**
 * ダイジェスト本体を組み立てる(純粋関数・依存注入でテスト可能)。
 * @param {object} p { resolvedRecords, pendingRecords, weightsHistoryEntries, nowMs }
 */
function buildWeeklyDigest(p) {
  const nowMs = p.nowMs;
  const { startMs, endMs } = lastCompletedWeekRange(nowMs);
  const inWeek = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= startMs && t < endMs; };

  const resolved = (p.resolvedRecords || []).filter((r) => r && r.resolved && inWeek(r.resolvedAt));
  const hits = resolved.filter((r) => r.correct === true);
  const misses = resolved.filter((r) => r.correct === false);
  const official = resolved.filter(isOfficialRec);
  const officialHits = official.filter((r) => r.correct === true);

  // ---- ベスト的中: 市場が最も疑っていた(含意確率が最も低い)のに当てた試合 ----
  let bestHit = null;
  const hitsWithMarket = hits.map((r) => ({ r, mkt: marketPctForPick(r) })).filter((x) => x.mkt !== null);
  if (hitsWithMarket.length) {
    hitsWithMarket.sort((a, b) => a.mkt - b.mkt);
    const { r, mkt } = hitsWithMarket[0];
    bestHit = {
      matchJa: `${clubJa(r.homeTeamEn)} ${scoreStr(r) || ""} ${clubJa(r.awayTeamEn)}`.trim(),
      predictedJa: winnerJa(r, r.predictedWinner),
      marketPctForPick: mkt,
      kickoff: r.kickoff || null,
      lineJa: `市場(ブックメーカー)は${winnerJa(r, r.predictedWinner)}を${mkt}%しか見ていませんでしたが、AIは当てました。`,
    };
  } else if (hits.length) {
    const r = hits.slice().sort((a, b) => String(b.resolvedAt || "").localeCompare(String(a.resolvedAt || "")))[0];
    bestHit = {
      matchJa: `${clubJa(r.homeTeamEn)} ${scoreStr(r) || ""} ${clubJa(r.awayTeamEn)}`.trim(),
      predictedJa: winnerJa(r, r.predictedWinner),
      marketPctForPick: null,
      kickoff: r.kickoff || null,
      lineJa: "今週の的中から1試合(この週はオッズ付きで比較できた的中がありませんでした)。",
    };
  }

  // ---- 一番の外れ: AIが最も自信を持っていたのに外した試合 ----
  let worstMiss = null;
  if (misses.length) {
    const scored = misses.map((r) => ({ r, conf: ownConfidencePct(r) }))
      .sort((a, b) => (b.conf ?? -1) - (a.conf ?? -1));
    const { r, conf } = scored[0];
    const reason = topReasonJa(r);
    worstMiss = {
      matchJa: `${clubJa(r.homeTeamEn)} ${scoreStr(r) || ""} ${clubJa(r.awayTeamEn)}`.trim(),
      predictedJa: winnerJa(r, r.predictedWinner),
      actualJa: winnerJa(r, r.actualWinner),
      confidencePct: conf,
      reasonJa: reason,
      official: isOfficialRec(r),
      kickoff: r.kickoff || null,
      lineJa: conf !== null
        ? `AIは${conf}%の自信で${winnerJa(r, r.predictedWinner)}と予想しましたが、実際は${winnerJa(r, r.actualWinner)}でした。${reason ? `理由の分析: ${reason}。` : "モデルが数値化できていない要因の影響とみられます。"}`
        : `${winnerJa(r, r.predictedWinner)}と予想しましたが、実際は${winnerJa(r, r.actualWinner)}でした。`,
    };
  }

  // ---- AIが学んだこと: 実際に採用された重みの変化(この週の分だけ) ----
  const learnedLines = [];
  for (const e of (p.weightsHistoryEntries || [])) {
    if (!e || !e.adopted) continue;
    const t = Date.parse(e.date);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    const desc = describeWeightsHistoryEntry(e);
    if (desc && desc.adopted) {
      (desc.bullets || []).slice(0, 2).forEach((b) => {
        const line = typeof b === "string" ? b : (b && (b.lineJa || b.textJa || b.label)) || null;
        if (line) learnedLines.push(line);
      });
    }
  }

  // ---- 来週の注目試合: 保存済みの未解決予測から(有名クラブ順・最大5件) ----
  const upcoming = (p.pendingRecords || [])
    .filter((r) => r && !r.resolved && r.kickoff)
    .filter((r) => { const t = Date.parse(r.kickoff); return Number.isFinite(t) && t >= nowMs && t < nowMs + 7 * 86400000; })
    .map((r) => ({
      r,
      rank: Math.min(
        RANK_BY_EN.get(String(r.homeTeamEn || "").toLowerCase()) ?? 999,
        RANK_BY_EN.get(String(r.awayTeamEn || "").toLowerCase()) ?? 999
      ),
    }))
    .sort((a, b) => a.rank - b.rank || String(a.r.kickoff).localeCompare(String(b.r.kickoff)))
    .slice(0, 5)
    .map(({ r }) => ({
      kickoff: r.kickoff,
      matchJa: `${clubJa(r.homeTeamEn)} vs ${clubJa(r.awayTeamEn)}`,
      predictedJa: winnerJa(r, r.predictedWinner),
      official: isOfficialRec(r),
    }));

  const hitRatePct = resolved.length ? Math.round((hits.length / resolved.length) * 1000) / 10 : null;
  const officialRatePct = official.length ? Math.round((officialHits.length / official.length) * 1000) / 10 : null;

  return {
    weekKey: weekKeyOf(startMs),
    periodJa: `${dateJa(startMs)}〜${dateJa(endMs - 1)}`,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      n: resolved.length, hits: hits.length, misses: misses.length, hitRatePct,
      official: { n: official.length, hits: officialHits.length, hitRatePct: officialRatePct },
      referenceN: resolved.length - official.length,
      lineJa: resolved.length
        ? `答え合わせできた${resolved.length}試合中${hits.length}試合的中(${hitRatePct}%)。うち公式戦は${official.length}試合中${officialHits.length}試合(${officialRatePct ?? "—"}%)。`
        : "この週は答え合わせまで進んだ試合がありませんでした。",
    },
    bestHit,   // null = 的中なし(正直に表示する)
    worstMiss, // null = 外れなし
    learned: {
      lines: learnedLines.slice(0, 4),
      lineJa: learnedLines.length
        ? null
        : "この週は重みの更新はありませんでした(検証で既存の重みを上回らなかった日は、正直に据え置いています)。",
    },
    upcoming,
    noteJa: "この記事はAIの実測記録だけから機械的に組み立てています。LLMによる作文・脚色はありません。",
  };
}

/**
 * 週1回の生成と保存。直前の完了週のダイジェストが未生成の場合だけ作る。
 * 失敗しても呼び出し元(日次学習)を壊さない(理由を返すだけ)。
 */
async function generateAndStoreWeeklyDigest(deps, runAt) {
  const { upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON } = deps;
  if (!upstashEnabled) return { generated: false, reasonJa: "保存先(Upstash)が未設定のため、ダイジェストは作れません。" };
  const nowMs = runAt instanceof Date ? runAt.getTime() : Date.parse(runAt);
  const { startMs } = lastCompletedWeekRange(nowMs);
  const wantKey = weekKeyOf(startMs);

  const existing = await upstashGetJSON(DIGEST_LATEST_KEY).catch(() => null);
  if (existing && existing.weekKey === wantKey) {
    return { generated: false, reasonJa: `今週分(${wantKey}週)は生成済みです。`, weekKey: wantKey };
  }

  const rawRecent = (await upstashCmd(["LRANGE", "learn:ownpred:recent", "-400", "-1"]).catch(() => [])) || [];
  const resolvedRecords = rawRecent
    .map((x) => { try { return typeof x === "object" ? x : JSON.parse(x); } catch (e) { return null; } })
    .filter(Boolean);

  const pendingIds = (await upstashCmd(["LRANGE", "learn:ownpred:pending", "-40", "-1"]).catch(() => [])) || [];
  const pendingRecords = [];
  for (const id of pendingIds) {
    const rec = await upstashGetJSON(`learn:ownpred:${id}`).catch(() => null);
    if (rec) pendingRecords.push(rec);
  }

  const rawHistory = (await upstashCmd(["LRANGE", "learn:weights:history", "-20", "-1"]).catch(() => [])) || [];
  const weightsHistoryEntries = rawHistory
    .map((x) => { try { return typeof x === "object" ? x : JSON.parse(x); } catch (e) { return null; } })
    .filter(Boolean);

  const digest = buildWeeklyDigest({ resolvedRecords, pendingRecords, weightsHistoryEntries, nowMs });

  const okLatest = await upstashSetJSON(DIGEST_LATEST_KEY, digest);
  if (okLatest === false) {
    return { generated: false, reasonJa: "ダイジェストの保存に失敗しました。次回の学習で再挑戦します。", weekKey: wantKey };
  }
  await upstashCmd(["LPUSH", DIGEST_HISTORY_KEY, JSON.stringify(digest)]).catch(() => {});
  await upstashCmd(["LTRIM", DIGEST_HISTORY_KEY, "0", String(DIGEST_HISTORY_KEEP - 1)]).catch(() => {});
  return { generated: true, weekKey: wantKey, digest };
}

module.exports = {
  DIGEST_LATEST_KEY, DIGEST_HISTORY_KEY,
  lastCompletedWeekRange, weekKeyOf, buildWeeklyDigest, generateAndStoreWeeklyDigest,
};
