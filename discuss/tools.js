"use strict";
/**
 * v104(2026年11月12日)・会話②「道具を使えるAI」+③「予想と会話の接続」
 * ----------------------------------------------------------------------------
 * これまでの会話は「ルールが先に集めた事実を1回のLLM呼び出しで読む」だけだったので、
 * 想定外の質問(「今日のレアルの試合どう?」「昨日なぜ外した?」「順位表は?」)には
 * 実データ無しの一般論しか返せなかった。
 *
 * ここでは、回答AIが必要と判断したときだけ呼べる「道具」を定義する。各道具は
 * サーバーが既に持っている関数(保存済みの予想・学習の反省・クラブ知識・選手成績・
 * 対戦分析・順位)を呼ぶだけで、新しい推定や外部データは作らない。
 *   ・返り値は必ず {ok:true, data, sourceJa} か {ok:false, reasonJa}(「取得できなかった」を
 *     「無かった」に潰さない。回答AIはその旨を正直に書く)
 *   ・1質問あたりの道具の呼び出しは toolLoop 側で上限(既定: 3往復・5回)
 *   ・API-Football を使う道具(クラブ知識・対戦分析・選手成績)は既存の予算保護
 *     (apiBudget / キャッシュ)をそのまま通る。保存先(Upstash)の読み出しは数回以内
 *   ・JSON を回答AIへ渡すときは MAX_RESULT_CHARS で切り詰める(長すぎる根拠は無駄)
 *
 * deps(server.js が注入する実関数)が無い道具は定義に含めない(テストでは一部だけ注入できる)。
 */

const MAX_RESULT_CHARS = 6000;
const MAX_LIST = 10;

function compactNumber(v, digits) {
  if (!Number.isFinite(v)) return null;
  const m = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(v * m) / m;
}

/** 回答AIへ渡す予想1件(buildTodayPredictionEntry の出力)を小さくする */
function compactPredictionEntry(p, opts) {
  if (!p) return null;
  const full = !!(opts && opts.full);
  const c = p.confidence || null;
  const out = {
    fixtureId: p.fixtureId,
    kickoff: p.kickoff || null,
    status: p.status || null,
    league: p.league || null,
    country: p.country || null,
    home: p.home && (p.home.name || p.home) || null,
    away: p.away && (p.away.name || p.away) || null,
    pick: p.predictedWinner || null,
    probsPct: p.probs || null,
    confidencePct: c && Number.isFinite(c.displayPct) ? c.displayPct : null,
    confidenceNoteJa: c ? (c.calibrated ? (c.method === "temperature" ? "実測で学習した較正(温度)を適用済み" : "実測の較正マップで補正済み") : "較正なし(モデル生値)") : null,
    predictedScoreline: p.predictedScoreline || null,
    drawNoticeJa: (p.probs && Number.isFinite(p.probs.drawPct) && p.probs.drawPct >= 30 && p.predictedWinner !== "draw") ? `引き分けの確率が${p.probs.drawPct}%と高め` : null,
    learnedCompetition: p.learnedCompetition === true,
    topFactorJa: p.topFactorJa || null,
    marketImpliedPct: p.market && p.market.impliedPct ? p.market.impliedPct : null,
    blend: p.blend ? { marketPct: p.blend.marketPct, aiPct: p.blend.aiPct } : null,
    content: p.content ? {
      expTotalGoals: p.content.expTotalGoals ?? null, over25Pct: p.content.over25Pct ?? null, bttsPct: p.content.bttsPct ?? null,
      topScorelines: p.content.topScorelines || null, styleJa: p.content.styleJa || null, calibrationNoteJa: p.content.calibrationNoteJa || null,
    } : null,
    resolved: p.resolved === true,
    correct: p.resolved ? p.correct : null,
    actualWinner: p.actualWinner || null,
    score: p.score || null,
  };
  if (full) {
    out.basis = p.basis ? {
      factors: (p.basis.factors || []).map((f) => `${f.labelJa}(★${f.stars})`),
      usedJa: (p.basis.used || []).map((u) => u.labelJa),
      missingJa: (p.basis.missing || []).map((u) => u.labelJa),
      squadRatings: p.basis.squadRatings || null,
      weightsVersion: p.basis.weightsVersion ?? null,
    } : null;
    out.preKick = p.preKick ? { confirmed: p.preKick.confirmed === true, formations: p.preKick.formations || null, noteJa: p.preKick.noteJa || null, blended: p.preKick.blended || null } : null;
    out.similarPastJa = p.similarPastJa || null;
    out.scenarios = Array.isArray(p.scenarios) ? p.scenarios.slice(0, 5) : null;
    out.derived = p.derived || null;
    out.apifbBlend = p.apifbBlend || null;
    out.oddsSource = p.oddsSource || null;
  }
  return out;
}

function teamMatches(entry, teamQuery) {
  if (!teamQuery) return true;
  const q = String(teamQuery).toLowerCase();
  const names = [entry.home && (entry.home.name || entry.home), entry.away && (entry.away.name || entry.away)].filter(Boolean).map((s) => String(s).toLowerCase());
  return names.some((n) => n.includes(q) || q.includes(n));
}

function truncateJson(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch (e) { return JSON.stringify({ ok: false, reasonJa: "結果をJSONにできませんでした" }); }
  if (s.length <= MAX_RESULT_CHARS) return s;
  return s.slice(0, MAX_RESULT_CHARS - 60) + `…(長いため${s.length - MAX_RESULT_CHARS + 60}文字を省略)"}`;
}

/**
 * 道具の定義(Anthropic Messages API の tools 形式)。deps にある道具だけを返す。
 */
function toolDefinitions(deps) {
  const d = deps || {};
  const defs = [];
  if (d.getTodayPredictions) defs.push({
    name: "get_today_predictions",
    description: "今日(日本時間)の試合に対するこのサイトのAI予想一覧(保存済みのもの)。勝敗ピック・確率・確信度・引き分け注意・試合内容の見立て(合計得点・両チーム得点・スコア上位)。今日の対象試合が無い日はAIが予想している「次の試合」を返す。team を渡すとそのクラブの試合だけに絞る。",
    input_schema: { type: "object", properties: { team: { type: "string", description: "クラブ名(日本語・英語どちらでも)。省略で全件" }, limit: { type: "integer", description: "最大件数(既定8)" } }, required: [] },
  });
  if (d.getPredictionRecord) defs.push({
    name: "get_prediction_detail",
    description: "試合ID(fixtureId)を指定して、AI予想の詳細(根拠=効いた要素と使えた/欠けたデータ、主力評価点、市場オッズとの比較、直前版、似た過去の試合、スコア分布と試合内容の見立て)を返す。fixtureId は get_today_predictions の結果にある。",
    input_schema: { type: "object", properties: { fixtureId: { type: "integer", description: "試合ID" } }, required: ["fixtureId"] },
  });
  if (d.gatherClubFacts) defs.push({
    name: "get_team_snapshot",
    description: "クラブの現在の状況(直近の試合結果・フォーム・得失点・監督・布陣・怪我人・出場停止・順位・移籍・蓄積された知識)を実データで返す。順位表の質問にも使える(そのクラブの順位・勝点)。",
    input_schema: { type: "object", properties: { team: { type: "string", description: "クラブ名(日本語・英語どちらでも)" }, needs: { type: "array", items: { type: "string", enum: ["recentForm", "injuries", "coach", "formation", "standings", "transfers"] }, description: "必要な項目。省略で基本セット(recentForm, coach, injuries, standings)" } }, required: ["team"] },
  });
  if (d.getMatchAnalysis) defs.push({
    name: "get_match_analysis",
    description: "2クラブの対戦分析(実データ: 直近10試合のフォーム・怪我人・順位・過去の直接対戦・布陣・得点ランキング・AIモデルの勝敗確率)。今日の試合予定に無い対戦でも使える。API消費が大きいので、本当に対戦の分析が必要なときだけ使う。",
    input_schema: { type: "object", properties: { home: { type: "string", description: "ホーム側クラブ名" }, away: { type: "string", description: "アウェイ側クラブ名" } }, required: ["home", "away"] },
  });
  if (d.getPlayerStats) defs.push({
    name: "get_player_stats",
    description: "選手の今季の実成績(出場・得点・アシスト・平均レーティング・キーパス・パス成功率・ドリブル・守備指標・デュエル)を返す。",
    input_schema: { type: "object", properties: { name: { type: "string", description: "選手名(日本語・英語どちらでも)" }, team: { type: "string", description: "所属クラブ(分かれば)" } }, required: ["name"] },
  });
  if (d.getRecentResolved) defs.push({
    name: "get_recent_misses",
    description: "AIが最近外した予想とその理由(実測で機械的に分類した外れ理由: 主力評価点の重視しすぎ・怪我人の軽視・データ不足・監督交代など)。「なぜ外した?」「最近の反省は?」に使う。team を渡すとそのクラブが絡む試合だけ。",
    input_schema: { type: "object", properties: { team: { type: "string", description: "クラブ名(任意)" }, limit: { type: "integer", description: "最大件数(既定5・上限10)" } }, required: [] },
  });
  if (d.getAccuracySummary) defs.push({
    name: "get_accuracy_summary",
    description: "AI予想の的中率・技能スコア(LogLoss)・較正(自信のズレ)の実測(直近7日/30日、公式戦、リーグ別、学習済み/未学習、オッズあり/なし、試合内容の予測の精度)。「どのくらい当たる?」「どのリーグが得意?」に使う。",
    input_schema: { type: "object", properties: { league: { type: "string", description: "リーグ名で絞る(任意。部分一致)" } }, required: [] },
  });
  return defs;
}

/**
 * 道具を実行する。例外は呼び出し側に投げず {ok:false, reasonJa} に変換する(回答AIが正直に扱えるように)。
 * @returns {Promise<{ok:boolean, data?:any, reasonJa?:string, sourceJa?:string, elapsedMs:number, resultJson:string, summaryJa:string}>}
 */
async function executeTool(name, input, deps) {
  const d = deps || {};
  const inp = (input && typeof input === "object") ? input : {};
  const t0 = Date.now();
  let out;
  try {
    out = await runTool(name, inp, d);
  } catch (e) {
    out = { ok: false, reasonJa: `道具「${name}」の実行中にエラーが発生しました(${(e && e.message) || "unknown"})` };
  }
  const elapsedMs = Date.now() - t0;
  const resultJson = truncateJson(out);
  const summaryJa = out && out.ok ? (out.summaryJa || `${TOOL_LABELS_JA[name] || name}: 取得`) : `${TOOL_LABELS_JA[name] || name}: ${(out && out.reasonJa) || "失敗"}`;
  return { ...out, elapsedMs, resultJson, summaryJa };
}

const TOOL_LABELS_JA = {
  get_today_predictions: "今日のAI予想",
  get_prediction_detail: "予想の詳細",
  get_team_snapshot: "クラブの現状",
  get_match_analysis: "対戦分析",
  get_player_stats: "選手の今季成績",
  get_recent_misses: "外した予想の反省",
  get_accuracy_summary: "的中率の実測",
};

async function runTool(name, inp, d) {
  if (name === "get_today_predictions") {
    if (!d.getTodayPredictions) return { ok: false, reasonJa: "この道具は使えません" };
    const body = await d.getTodayPredictions();
    if (!body || !body.found) return { ok: false, reasonJa: (body && body.noteJa) || "本日の試合一覧を取得できませんでした" };
    if (body.readFailed) return { ok: false, reasonJa: body.noteJa || "保存先から予想を読み出せませんでした(予想が無いのではなく読めなかった状態)" };
    const limit = Math.max(1, Math.min(MAX_LIST, Number(inp.limit) || 8));
    const teamQ = inp.team ? await resolveTeamQuery(inp.team, d) : null;
    const pool = (body.predictions && body.predictions.length) ? body.predictions : (body.upcomingPredictions || []);
    const kind = (body.predictions && body.predictions.length) ? "today" : "upcoming";
    let selected = pool;
    if (inp.team) {
      const names = (teamQ && teamQ.labelEn) ? [teamQ.labelEn, teamQ.labelJa].filter(Boolean) : [String(inp.team)];
      selected = pool.filter((p) => names.some((n) => teamMatches(p, n)));
    }
    const list = selected.slice(0, limit).map((p) => compactPredictionEntry(p));
    return {
      ok: true,
      data: { date: body.date || null, kind, totalFixturesToday: body.totalFixturesToday ?? null, count: list.length, predictions: list, noteJa: list.length ? null : (teamQ ? `${teamQ.labelJa || teamQ.labelEn || inp.team}の試合に対するAI予想は、今日の分にも「次の試合」にもありません` : body.noteJa || null) },
      sourceJa: "このサイトのAIが毎朝の学習で保存した予想(/api/predictions/today と同じデータ)",
      summaryJa: `今日のAI予想: ${list.length}件${kind === "upcoming" ? "(次の試合)" : ""}`,
    };
  }
  if (name === "get_prediction_detail") {
    if (!d.getPredictionRecord) return { ok: false, reasonJa: "この道具は使えません" };
    const id = Number(inp.fixtureId);
    if (!Number.isFinite(id)) return { ok: false, reasonJa: "fixtureId が数値ではありません" };
    const entry = await d.getPredictionRecord(id);
    if (!entry) return { ok: false, reasonJa: `試合ID ${id} のAI予想は保存されていません` };
    return { ok: true, data: compactPredictionEntry(entry, { full: true }), sourceJa: "保存済みの予想記録(learn:ownpred)", summaryJa: `予想の詳細: 試合ID ${id}` };
  }
  if (name === "get_team_snapshot") {
    if (!d.gatherClubFacts) return { ok: false, reasonJa: "この道具は使えません" };
    const team = await resolveTeamQuery(inp.team, d);
    if (!team || !team.labelEn) return { ok: false, reasonJa: `クラブ「${inp.team || ""}」を特定できませんでした${team && team.candidates ? `(候補: ${team.candidates.join(" / ")})` : ""}` };
    const needs = Array.isArray(inp.needs) && inp.needs.length ? inp.needs : ["recentForm", "coach", "injuries", "standings"];
    const facts = await d.gatherClubFacts(team.labelEn, needs, team.labelJa || null);
    return { ok: true, data: { team: team.labelEn, teamJa: team.labelJa || null, facts: (facts || []).slice(0, 25) }, sourceJa: "API-Football の実データと、毎晩の学習で蓄積したクラブ知識", summaryJa: `クラブの現状: ${team.labelJa || team.labelEn}(事実${(facts || []).length}件)` };
  }
  if (name === "get_match_analysis") {
    if (!d.getMatchAnalysis) return { ok: false, reasonJa: "この道具は使えません" };
    if (!inp.home || !inp.away) return { ok: false, reasonJa: "home と away の両方が必要です" };
    const body = await d.getMatchAnalysis(String(inp.home), String(inp.away));
    if (!body || body.ok === false) return { ok: false, reasonJa: (body && (body.message || body.reason)) || "対戦分析を取得できませんでした" };
    return { ok: true, data: body, sourceJa: "対戦分析(API-Football の実データ+AIモデル)", summaryJa: `対戦分析: ${inp.home} vs ${inp.away}` };
  }
  if (name === "get_player_stats") {
    if (!d.getPlayerStats) return { ok: false, reasonJa: "この道具は使えません" };
    if (!inp.name) return { ok: false, reasonJa: "選手名が必要です" };
    const body = await d.getPlayerStats(String(inp.name), inp.team ? String(inp.team) : "");
    if (!body || !body.found) return { ok: false, reasonJa: `${inp.name}の実成績データは見つかりませんでした(${(body && body.reason) || "不明"})` };
    return { ok: true, data: { player: body.player || null, season: body.season || null, stats: body.stats || null, facts: body.facts || null }, sourceJa: "API-Football の選手統計(今季)", summaryJa: `選手の今季成績: ${(body.player && body.player.name) || inp.name}` };
  }
  if (name === "get_recent_misses") {
    if (!d.getRecentResolved) return { ok: false, reasonJa: "この道具は使えません" };
    const recs = await d.getRecentResolved();
    if (!Array.isArray(recs)) return { ok: false, reasonJa: "答え合わせ済みの記録を読み出せませんでした" };
    const limit = Math.max(1, Math.min(MAX_LIST, Number(inp.limit) || 5));
    const teamQ = inp.team ? await resolveTeamQuery(inp.team, d) : null;
    const nameOf = (r, side) => side === "home" ? (r.homeTeamEn || "ホーム") : side === "away" ? (r.awayTeamEn || "アウェイ") : "引き分け";
    const pool = recs.filter((r) => r && r.resolved && r.correct === false)
      .filter((r) => !teamQ || !teamQ.labelEn || [r.homeTeamEn, r.awayTeamEn].some((n) => n && (String(n).toLowerCase().includes(teamQ.labelEn.toLowerCase()) || teamQ.labelEn.toLowerCase().includes(String(n).toLowerCase()))));
    const items = pool.slice(0, limit).map((r) => ({
      fixtureId: r.fixtureId, kickoff: r.kickoff || null, league: r.league || null,
      home: r.homeTeamEn || null, away: r.awayTeamEn || null,
      predictedJa: r.predictedWinner === "draw" ? "引き分け" : `${nameOf(r, r.predictedWinner)}勝利`,
      actualJa: r.actualWinner === "draw" ? "引き分け" : `${nameOf(r, r.actualWinner)}勝利`,
      actualScore: (r.actualScore && Number.isFinite(Number(r.actualScore.home))) ? `${r.actualScore.home}-${r.actualScore.away}` : null,
      confidencePct: r.finalProbs ? Math.round(((r.predictedWinner === "home" ? r.finalProbs.homeWin : r.predictedWinner === "away" ? r.finalProbs.awayWin : r.finalProbs.draw) || 0) * 100) : null,
      official: r.official !== false,
      learnedCompetition: r.learnedCompetition !== false,
      reasonsJa: [...(Array.isArray(r.contextualFailureReasons) ? r.contextualFailureReasons : []), ...(Array.isArray(r.failureReasons) ? r.failureReasons : [])]
        .filter((x) => x && x.labelJa).slice(0, 3).map((x) => `${x.labelJa}${x.detail || x.detailJa ? `(${x.detail || x.detailJa})` : ""}`),
    }));
    const total = pool.length;
    return { ok: true, data: { count: items.length, totalMissesInWindow: total, windowNoteJa: "答え合わせ済み予測の直近300件のローリング窓(累計ではない)", items, noReasonNoteJa: "理由が空の試合は、原因を特定できる実測データが見つからなかった外れ(分類できない外れも正直に残している)" }, sourceJa: "AIの反省(答え合わせ時に機械的に分類した外れ理由)", summaryJa: `外した予想: ${items.length}件(窓内 ${total}件)` };
  }
  if (name === "get_accuracy_summary") {
    if (!d.getAccuracySummary) return { ok: false, reasonJa: "この道具は使えません" };
    const s = await d.getAccuracySummary();
    if (!s) return { ok: false, reasonJa: "精度の実測を読み出せませんでした" };
    const out = { ...s };
    if (inp.league && Array.isArray(s.byLeague)) {
      const q = String(inp.league).toLowerCase();
      out.byLeague = s.byLeague.filter((r) => r && String(r.league || r.key || "").toLowerCase().includes(q)).slice(0, MAX_LIST);
    } else if (Array.isArray(s.byLeague)) out.byLeague = s.byLeague.slice(0, MAX_LIST);
    return { ok: true, data: out, sourceJa: "日次レポート(learn:accuracy:<日付> の合算)と反省タブ(直近300件窓)の実測", summaryJa: "的中率の実測" };
  }
  return { ok: false, reasonJa: `未知の道具です: ${name}` };
}

/** クラブ名の解決(deps.resolveClub があればそれを使う。無ければ名前をそのまま使う) */
async function resolveTeamQuery(name, d) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  if (typeof d.resolveClub !== "function") return { labelEn: raw, labelJa: null };
  const r = await d.resolveClub(raw);
  if (r && r.ok) return { labelEn: r.labelEn, labelJa: r.labelJa || null, teamId: r.teamId || null };
  return { labelEn: null, labelJa: null, candidates: (r && r.candidates) || null, raw };
}

module.exports = { toolDefinitions, executeTool, compactPredictionEntry, truncateJson, TOOL_LABELS_JA, MAX_RESULT_CHARS };
