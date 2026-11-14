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
    // v104.1 K: 自信ランク(S/A/B/見送り)と、そのランクの実績(実測)。対象外の試合は rank:null と理由
    rank: p.tier ? (p.tier.rank || null) : null,
    rankLabelJa: p.tier && p.tier.rank ? (p.tier.labelJa || null) : null,
    rankRecordJa: (p.tier && p.tier.rank && p.tier.record && Number.isFinite(p.tier.record.hitPct))
      ? `このランクの実績: ${p.tier.record.n}件中${p.tier.record.hits}件的中(${p.tier.record.hitPct}%)。${p.tier.record.basisJa || ""}` : null,
    rankNoteJa: (p.tier && !p.tier.rank) ? (p.tier.reasonJa || null) : null,
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
  if (opts && opts.list) {
    // v104.1(総点検): 一覧用は小さくする(1件あたり約960文字 → 約450文字)。
    //   8件で回答AIに渡せる上限(6,000文字)を超え、末尾のランク別の件数・実績(rankCounts / tiers)と
    //   後ろの予想が切り落とされていた。ランクの実績は一覧の先頭(tiers.recordJa)に1回だけ載せ
    //   (「S 61件中46件的中(75.4%)」の形。1件ごとに同じ文を繰り返さない)、値の無い項目は省く。
    delete out.rankRecordJa;
    if (out.content) { delete out.content.calibrationNoteJa; }
    if (out.marketImpliedPct && typeof out.marketImpliedPct === "object") { const m = { ...out.marketImpliedPct }; delete m.overroundPct; out.marketImpliedPct = m; }
    if (out.score && out.score.home === null && out.score.away === null) delete out.score;
    if (!out.resolved) { delete out.resolved; delete out.correct; delete out.actualWinner; }
    for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  }
  return out;
}

// ---- クラブで絞るときの照合(v104.1 総点検) ----
//   v104 は「名前の部分一致」(n.includes(q) || q.includes(n))で絞っていたため、
//   「Roma」で「Romania」、「Inter」で「Inter Miami」、「Como」で「Comoros」の試合まで
//   そのクラブの予想・外れとして回答AIに渡していた。照合は次の順で厳密に行う:
//     ① このアプリの表記で作った側(originTeamEn)との名前の完全一致
//     ② 質問のクラブのチームIDと、試合の両チームのIDが分かるとき … IDだけで判定
//        (同じ名前の別クラブを混ぜない)
//     ③ IDが分からないとき … 名前の完全一致(アクセント記号・大文字小文字・FC/AC などの接頭辞の差は無視)
const { foldDiacritics } = require("../learning/clubUniverse");
const CLUB_NAME_AFFIX_RE = /^(fc|cf|afc|sc|ac|as|ss|cd|ud|rc|rcd|sv|bk|fk|sk|if|ik|ca|club)$/;
function clubNameKey(name) {
  return foldDiacritics(String(name || "")).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !CLUB_NAME_AFFIX_RE.test(w)).join("");
}
function sameClubName(a, b) {
  const sa = String(a || "").trim(), sb = String(b || "").trim();
  if (!sa || !sb) return false;
  if (sa.toLowerCase() === sb.toLowerCase()) return true; // 日本語名どうしもここで一致する
  const ka = clubNameKey(sa), kb = clubNameKey(sb);
  return !!ka && ka === kb;
}
function finiteIdOrNull(v) { return (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) ? Number(v) : null; }
/**
 * @param {{homeName?:string, awayName?:string, homeNameJa?:string, awayNameJa?:string, originName?:string, homeId?:number, awayId?:number}} sides
 * @param {{labelEn?:string, labelJa?:string, teamId?:number}|null} teamQ - 質問のクラブ(特定できたとき)
 * @param {string} raw - 利用者(回答AI)が渡したクラブ名そのまま(特定できなかったときの名前照合に使う)
 */
function involvesTeam(sides, teamQ, raw) {
  const s = sides || {};
  const resolved = !!(teamQ && teamQ.labelEn);
  const names = resolved ? [teamQ.labelEn, teamQ.labelJa].filter(Boolean) : [String(raw || "")].filter(Boolean);
  if (!names.length) return false;
  if (s.originName && names.some((n) => sameClubName(n, s.originName))) return true;
  const qId = resolved ? finiteIdOrNull(teamQ.teamId) : null;
  const hid = finiteIdOrNull(s.homeId), aid = finiteIdOrNull(s.awayId);
  if (qId !== null && hid !== null && aid !== null) return hid === qId || aid === qId;
  return names.some((n) => sameClubName(n, s.homeName) || sameClubName(n, s.awayName) || sameClubName(n, s.homeNameJa) || sameClubName(n, s.awayNameJa));
}
function entrySides(p) {
  const nm = (x) => (x && typeof x === "object") ? (x.name || null) : (x || null);
  return {
    homeName: nm(p && p.home), awayName: nm(p && p.away),
    homeNameJa: (p && p.home && p.home.nameJa) || null, awayNameJa: (p && p.away && p.away.nameJa) || null,
    homeId: p && p.home && typeof p.home === "object" ? p.home.id : null, awayId: p && p.away && typeof p.away === "object" ? p.away.id : null,
  };
}

/**
 * 回答AIへ渡す JSON を上限(MAX_RESULT_CHARS)に収める。
 * v104.1(総点検): 旧コードは文字数で途中から切り落としていたため、JSON が壊れた形で渡り、
 *   後ろにある項目(一覧の件数・ランク別の実績・注記)が黙って消えていた。
 *   長いときは「いちばん長い配列の末尾」を1件ずつ落として、形を保ったまま収める(落とした件数は必ず書く)。
 *   それでも収まらない(配列の無い巨大な結果)ときだけ、従来どおり文字数で切る。
 */
function truncateJson(obj) {
  let s;
  try { s = JSON.stringify(obj); } catch (e) { return JSON.stringify({ ok: false, reasonJa: "結果をJSONにできませんでした" }); }
  if (s.length <= MAX_RESULT_CHARS) return s;
  try {
    const clone = JSON.parse(s);
    let dropped = 0;
    for (let guard = 0; guard < 400; guard++) {
      let best = null;
      const walk = (node) => {
        if (Array.isArray(node)) {
          if (node.length > 1) { const len = JSON.stringify(node).length; if (!best || len > best.len) best = { node, len }; }
          for (const c of node) walk(c);
        } else if (node && typeof node === "object") { for (const k of Object.keys(node)) walk(node[k]); }
      };
      walk(clone);
      if (!best) break;
      best.node.pop(); dropped++;
      clone.omittedForLengthJa = `結果が長いため、一覧の末尾を合計${dropped}件省略しました(条件や件数を絞ると見られます)`;
      const t = JSON.stringify(clone);
      if (t.length <= MAX_RESULT_CHARS) return t;
    }
  } catch (e) { /* 下の文字数切りへ */ }
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
    description: "今日(日本時間)の試合に対するこのサイトのAI予想一覧(保存済みのもの)。勝敗ピック・確率・確信度・自信ランク(S=確信/A=有力/B=やや優勢/skip=見送り)とそのランクの実績・引き分け注意・試合内容の見立て(合計得点・両チーム得点・スコア上位)。今日の対象試合が無い日はAIが予想している「次の試合」を返す。team を渡すとそのクラブの試合だけに絞る。rank を渡すとそのランクの試合だけに絞る(「自信のある試合は?」「おすすめは?」には rank:\"S\" を使い、無ければ \"A\")。結果は自信の高い順。",
    input_schema: { type: "object", properties: { team: { type: "string", description: "クラブ名(日本語・英語どちらでも)。省略で全件" }, rank: { type: "string", enum: ["S", "A", "B", "skip"], description: "自信ランクで絞る(任意)" }, limit: { type: "integer", description: "最大件数(既定8)" } }, required: [] },
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
    description: "2クラブの対戦分析(実データから計算したもの: AIモデルの勝敗確率(winProbability)・予想スコア・結論・効いた要素(keyFactors)・特徴量の数値(featuresUsed: フォーム差・順位差・直接対戦・怪我人の差など)・怪我人と出場停止・直近の布陣・得点ランキング上位の選手・実データから組み立てた展開の説明)。今日の試合予定に無い対戦でも使える。API消費が大きいので、本当に対戦の分析が必要なときだけ使う。",
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
    description: "AI予想の的中率・技能スコア(LogLoss)・較正(自信のズレ)の実測(直近7日/30日、公式戦、リーグ別、学習済み/未学習、オッズあり/なし、自信ランク別(S/A/B/見送り)の的中率、試合内容の予測の精度)。「どのくらい当たる?」「どのリーグが得意?」「Sランクはどれくらい当たる?」に使う。",
    input_schema: { type: "object", properties: { league: { type: "string", description: "リーグ名で絞る(任意。部分一致)" } }, required: [] },
  });
  return defs;
}

/**
 * 道具を実行する。例外は呼び出し側に投げず {ok:false, reasonJa} に変換する(回答AIが正直に扱えるように)。
 * @returns {Promise<{ok:boolean, data?:any, reasonJa?:string, sourceJa?:string, elapsedMs:number, resultJson:string, summaryJa:string, summary:object}>}
 *   summaryJa … 画面の「AIが確認したデータ」に出す1行(日本語)
 *   summary   … 同じ内容を、言語に依らない形にしたもの(v104.1)。{ kind, ... }
 *               画面はこれを使って、英語・中国語・スペイン語でも日本語を残さずに1行を組み立てる
 *               (summaryJa にはクラブの日本語名や、失敗の理由の日本語文が入るため、そのままでは訳せない)。
 *               失敗は { kind:"failed", tool } だけ(理由の文は summaryJa と、回答AIに渡す結果の中にある)。
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
  // 画面用の構造化した要約(summary)は、回答AIに渡す結果(resultJson)には入れない(AIが読む内容は v104 と同じ)
  const forModel = (out && typeof out === "object") ? { ...out } : out;
  if (forModel && typeof forModel === "object") delete forModel.summary;
  const resultJson = truncateJson(forModel);
  const summaryJa = out && out.ok ? (out.summaryJa || `${TOOL_LABELS_JA[name] || name}: 取得`) : `${TOOL_LABELS_JA[name] || name}: ${(out && out.reasonJa) || "失敗"}`;
  const summary = out && out.ok ? { ...(out.summary || { kind: "ok" }), tool: name } : { kind: "failed", tool: name };
  return { ...out, elapsedMs, resultJson, summaryJa, summary };
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
    // v104.1(総点検): 今日の分が0件で、「次の試合」の読み出しにも失敗しているとき(upcomingReadFailed)は、
    //   「予想がありません」ではなく「読めませんでした」と返す(読めなかったことを「無い」に潰さない)。
    if (body.upcomingReadFailed && !(body.predictions && body.predictions.length) && !(body.upcomingPredictions && body.upcomingPredictions.length)) {
      return { ok: false, reasonJa: "保存先から「次の試合」の予想を読み出せませんでした(予想が無いのではなく読めなかった状態。1分ほど待つと読めることがあります)" };
    }
    const limit = Math.max(1, Math.min(MAX_LIST, Number(inp.limit) || 8));
    const teamQ = inp.team ? await resolveTeamQuery(inp.team, d) : null;
    const pool = (body.predictions && body.predictions.length) ? body.predictions : (body.upcomingPredictions || []);
    const kind = (body.predictions && body.predictions.length) ? "today" : "upcoming";
    let selected = pool;
    if (inp.team) selected = pool.filter((p) => involvesTeam(entrySides(p), teamQ, inp.team));
    // v104.1 K: ランクで絞る(指定があるときだけ)。ランク別の件数は、絞る前の一覧から数えて必ず添える
    const RANKS = ["S", "A", "B", "skip"];
    const rankCounts = { S: 0, A: 0, B: 0, skip: 0, none: 0 };
    for (const p of selected) rankCounts[(p && p.tier && RANKS.includes(p.tier.rank)) ? p.tier.rank : "none"]++;
    const rankQ = RANKS.includes(String(inp.rank || "")) ? String(inp.rank) : null;
    const beforeRank = selected.length;
    if (rankQ) selected = selected.filter((p) => p && p.tier && p.tier.rank === rankQ);
    // 自信の高い順(同じなら開始時刻順)。まだ始まっていない試合を先に
    const confOf = (p) => (p && p.confidence && Number.isFinite(p.confidence.displayPct)) ? p.confidence.displayPct : -1;
    selected = selected.slice().sort((a, b) => (Number(!!a.resolved) - Number(!!b.resolved)) || (confOf(b) - confOf(a)) || (new Date(a.kickoff || 0) - new Date(b.kickoff || 0)));
    const matched = selected.length;
    let list = selected.slice(0, limit).map((p) => compactPredictionEntry(p, { list: true }));
    const t = body.tiers || null;
    const tiersBrief = t ? {
      thresholdsJa: `S: 自信${t.thresholds.sPct}%以上 / A: ${t.thresholds.aPct}%以上 / B: ${t.thresholds.skipPct}%以上 / 見送り: ${t.thresholds.skipPct}%未満(公式戦かつ学習済みの大会だけが対象)`,
      // 実績は、予想時のランクのまま数えたもの(forward)が各ランク20件以上あればそれを、無ければ今の境を過去に当てはめた実測(backtest)
      recordJa: (() => {
        const rowsOf = (g) => (g && (g.last30 && g.totalLast30 >= 80 ? g.last30 : g.all)) || null;
        const fw = rowsOf(t.forward), bt = rowsOf(t.backtest);
        const useFw = fw && fw.every((r) => r.n >= (t.minForDisplay || 20));
        const rows = useFw ? fw : bt;
        if (!rows || !rows.some((r) => r.n > 0)) return "ランク別の実績はまだ集計されていません";
        return `${useFw ? "予想時のランクのまま数えた実績" : "今の境を答え合わせ済みの過去の予想に当てはめた実測"}: ` + rows.filter((r) => r.n > 0).map((r) => `${r.rank === "skip" ? "見送り" : r.rank} ${Number.isFinite(r.hits) ? `${r.n}件中${r.hits}件的中(${r.hitPct}%)` : `${r.hitPct}%(${r.n}件)`}`).join(" / ");
      })(),
    } : null;
    // 要約(件数・ランク別の件数・ランクの実績)を先に置き、一覧は上限に収まる件数だけ載せる(載せなかった件数は必ず書く)
    const head = { date: body.date || null, kind, totalFixturesToday: body.totalFixturesToday ?? null, matched, rankCounts, rankFilter: rankQ, tiers: tiersBrief };
    const sourceJa = "このサイトのAIが毎朝の学習で保存した予想(/api/predictions/today と同じデータ)";
    const sizeWith = (l) => JSON.stringify({ ok: true, data: { ...head, count: l.length, predictions: l, noteJa: "x".repeat(90) }, sourceJa, summaryJa: "x".repeat(40) }).length;
    while (list.length > 1 && sizeWith(list) > MAX_RESULT_CHARS) list = list.slice(0, -1);
    const notShown = matched - list.length;
    return {
      ok: true,
      data: {
        ...head, count: list.length,
        noteJa: list.length
          ? (notShown > 0 ? `該当${matched}件のうち、自信の高い順に${list.length}件を載せています(残り${notShown}件は、クラブ名(team)やランク(rank)で絞ると見られます)` : null)
          : (rankQ && beforeRank > 0 ? `ランク${rankQ === "skip" ? "「見送り」" : rankQ}の予想は${kind === "upcoming" ? "「次の試合」" : "今日の分"}にありません(ランク別の件数は rankCounts を参照)`
            : (teamQ ? `${teamQ.labelJa || teamQ.labelEn || inp.team}の試合に対するAI予想は、今日の分にも「次の試合」にもありません` : body.noteJa || null)),
        predictions: list,
      },
      sourceJa,
      summaryJa: `今日のAI予想: ${list.length}件${rankQ ? `(ランク${rankQ === "skip" ? "見送り" : rankQ})` : ""}${kind === "upcoming" ? "(次の試合)" : ""}`,
      summary: { kind: "today_predictions", count: list.length, rank: rankQ, upcoming: kind === "upcoming" },
    };
  }
  if (name === "get_prediction_detail") {
    if (!d.getPredictionRecord) return { ok: false, reasonJa: "この道具は使えません" };
    const id = Number(inp.fixtureId);
    if (!Number.isFinite(id)) return { ok: false, reasonJa: "fixtureId が数値ではありません" };
    const entry = await d.getPredictionRecord(id);
    if (!entry) return { ok: false, reasonJa: `試合ID ${id} のAI予想は保存されていません` };
    return { ok: true, data: compactPredictionEntry(entry, { full: true }), sourceJa: "保存済みの予想記録(learn:ownpred)", summaryJa: `予想の詳細: 試合ID ${id}`, summary: { kind: "prediction_detail", fixtureId: id } };
  }
  if (name === "get_team_snapshot") {
    if (!d.gatherClubFacts) return { ok: false, reasonJa: "この道具は使えません" };
    const team = await resolveTeamQuery(inp.team, d);
    if (!team || !team.labelEn) return { ok: false, reasonJa: `クラブ「${inp.team || ""}」を特定できませんでした${team && team.candidates ? `(候補: ${team.candidates.join(" / ")})` : ""}` };
    const needs = Array.isArray(inp.needs) && inp.needs.length ? inp.needs : ["recentForm", "coach", "injuries", "standings"];
    const facts = await d.gatherClubFacts(team.labelEn, needs, team.labelJa || null);
    return { ok: true, data: { team: team.labelEn, teamJa: team.labelJa || null, facts: (facts || []).slice(0, 25) }, sourceJa: "API-Football の実データと、毎晩の学習で蓄積したクラブ知識", summaryJa: `クラブの現状: ${team.labelJa || team.labelEn}(事実${(facts || []).length}件)`, summary: { kind: "team_snapshot", teamJa: team.labelJa || null, teamEn: team.labelEn, facts: (facts || []).length } };
  }
  if (name === "get_match_analysis") {
    if (!d.getMatchAnalysis) return { ok: false, reasonJa: "この道具は使えません" };
    if (!inp.home || !inp.away) return { ok: false, reasonJa: "home と away の両方が必要です" };
    const body = await d.getMatchAnalysis(String(inp.home), String(inp.away));
    if (!body || body.ok === false) return { ok: false, reasonJa: (body && (body.message || body.reason)) || "対戦分析を取得できませんでした" };
    return { ok: true, data: body, sourceJa: "対戦分析(API-Football の実データ+AIモデル)", summaryJa: `対戦分析: ${inp.home} vs ${inp.away}`, summary: { kind: "match_analysis", home: String(inp.home), away: String(inp.away), homeEn: (body.home && body.home.nameEn) || null, awayEn: (body.away && body.away.nameEn) || null } };
  }
  if (name === "get_player_stats") {
    if (!d.getPlayerStats) return { ok: false, reasonJa: "この道具は使えません" };
    if (!inp.name) return { ok: false, reasonJa: "選手名が必要です" };
    const body = await d.getPlayerStats(String(inp.name), inp.team ? String(inp.team) : "");
    if (!body || !body.found) return { ok: false, reasonJa: `${inp.name}の実成績データは見つかりませんでした(${(body && body.reason) || "不明"})` };
    return { ok: true, data: { player: body.player || null, season: body.season || null, stats: body.stats || null, facts: body.facts || null }, sourceJa: "API-Football の選手統計(今季)", summaryJa: `選手の今季成績: ${(body.player && body.player.name) || inp.name}`, summary: { kind: "player_stats", player: String((body.player && body.player.name) || inp.name) } };
  }
  if (name === "get_recent_misses") {
    if (!d.getRecentResolved) return { ok: false, reasonJa: "この道具は使えません" };
    const recs = await d.getRecentResolved();
    if (!Array.isArray(recs)) return { ok: false, reasonJa: "答え合わせ済みの記録を読み出せませんでした" };
    const limit = Math.max(1, Math.min(MAX_LIST, Number(inp.limit) || 5));
    const teamQ = inp.team ? await resolveTeamQuery(inp.team, d) : null;
    const nameOf = (r, side) => side === "home" ? (r.homeTeamEn || "ホーム") : side === "away" ? (r.awayTeamEn || "アウェイ") : "引き分け";
    // v104.1(総点検): クラブを指定されたのに特定できなかったとき、v104 は絞り込みを黙って外し、
    //   全クラブの外れをそのクラブの外れとして返していた。特定できないときは、渡された名前との
    //   完全一致だけで絞る(一致が無ければ0件と正直に返す)。照合は involvesTeam(ID優先・部分一致なし)。
    const pool = recs.filter((r) => r && r.resolved && r.correct === false)
      .filter((r) => !inp.team || involvesTeam({ homeName: r.homeTeamEn, awayName: r.awayTeamEn, originName: r.originTeamEn, homeId: r.homeTeamId, awayId: r.awayTeamId }, teamQ, inp.team));
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
    // v104.1(総点検): 理由の文が長い外れが並ぶと上限(6,000文字)を超え、末尾の注記ごと切り落とされるため、収まる件数だけ載せる
    let shownItems = items;
    while (shownItems.length > 1 && JSON.stringify(shownItems).length > MAX_RESULT_CHARS - 900) shownItems = shownItems.slice(0, -1);
    const itemsCut = items.length - shownItems.length;
    const teamNoteJa = !inp.team ? null
      : (teamQ && teamQ.labelEn)
        ? (total ? null : `${teamQ.labelJa || teamQ.labelEn}が絡む外れは、直近の答え合わせ済み予測の中にありません`)
        : `クラブ「${String(inp.team).slice(0, 40)}」を特定できなかったため、名前が完全に一致する試合だけで絞りました(${total}件)${teamQ && teamQ.candidates ? `。候補: ${teamQ.candidates.join(" / ")}` : ""}`;
    return { ok: true, data: { count: shownItems.length, totalMissesInWindow: total, teamNoteJa, ...(itemsCut > 0 ? { omittedForLengthJa: `長さの都合で${itemsCut}件を省略しました(limit を小さくするか、team で絞ると見られます)` } : {}), windowNoteJa: "答え合わせ済み予測の直近300件のローリング窓(累計ではない)", items: shownItems, noReasonNoteJa: "理由が空の試合は、原因を特定できる実測データが見つからなかった外れ(分類できない外れも正直に残している)" }, sourceJa: "AIの反省(答え合わせ時に機械的に分類した外れ理由)", summaryJa: `外した予想: ${shownItems.length}件(窓内 ${total}件)`, summary: { kind: "recent_misses", count: shownItems.length, total } };
  }
  if (name === "get_accuracy_summary") {
    if (!d.getAccuracySummary) return { ok: false, reasonJa: "この道具は使えません" };
    const s = await d.getAccuracySummary();
    if (!s) return { ok: false, reasonJa: "精度の実測を読み出せませんでした" };
    const out = { ...s };
    // リーグ別の一覧は、直近30日(byLeague)と直近7日(byLeague7Days)の2つ。league の指定があれば両方を絞る
    for (const key of ["byLeague", "byLeague7Days"]) {
      if (!Array.isArray(s[key])) continue;
      if (inp.league) {
        const q = String(inp.league).toLowerCase();
        out[key] = s[key].filter((r) => r && String(r.league || r.key || "").toLowerCase().includes(q)).slice(0, MAX_LIST);
      } else out[key] = s[key].slice(0, key === "byLeague" ? 20 : 12);
    }
    if (inp.league && Array.isArray(out.byLeague) && !out.byLeague.length && !(Array.isArray(out.byLeague7Days) && out.byLeague7Days.length)) out.leagueNoteJa = `「${String(inp.league).slice(0, 40)}」に当たる大会の集計は、直近30日の記録にありません`;
    return { ok: true, data: out, sourceJa: "日次レポート(learn:accuracy:<日付> の合算)と反省タブ(直近300件窓)の実測", summaryJa: "的中率の実測", summary: { kind: "accuracy_summary" } };
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

module.exports = { toolDefinitions, executeTool, compactPredictionEntry, truncateJson, TOOL_LABELS_JA, MAX_RESULT_CHARS, involvesTeam, sameClubName, clubNameKey };
