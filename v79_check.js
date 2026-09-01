/**
 * scripts/v79_check.js — v79(案5会話の文脈記憶+案6第二意見ブレンド)の自己完結テスト。
 * 実行: node scripts/v79_check.js(ネットワーク不要)
 */
"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, fs.existsSync(path.join(__dirname, "..", "server", "server.js")) ? ".." : "../..");
const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 300) : ""}`); };

const pm = require(path.join(ROOT, "server", "learning", "predictionModel.js"));

// ============ 案6: 第二意見ブレンド(単体) ============
{
  // サンプル不足 → 正直に見送り(w=0)
  const few = pm.fitSecondOpinionBlend([]);
  ck("案6: 記録不足のときは学習を見送り、理由を書く", few.adopted === false && few.w === 0 && /件/.test(few.reasonJa), JSON.stringify(few));
}
function mkRec(actual, apifbGood, apifbBad) {
  // 自前モデルはほぼ互角(情報が薄い)・API-Football予想は actual に寄せる/外す
  const peaked = (t) => ({ homePct: t === "home" ? 70 : 15, drawPct: t === "draw" ? 70 : 15, awayPct: t === "away" ? 70 : 15 });
  return {
    resolved: true, actualWinner: actual,
    homeLambda: 1.31, awayLambda: 1.29, weightsSnapshot: { rho: 0 },
    apifbImplied: apifbGood ? peaked(actual) : peaked(apifbBad),
  };
}
{
  const outcomes = ["home", "away", "draw"];
  const good = Array.from({ length: 120 }, (_, i) => mkRec(outcomes[i % 3], true));
  const fitG = pm.fitSecondOpinionBlend(good);
  ck("案6: 第二意見が実際に情報を持つとき、検証NLL改善で採用される",
    fitG.adopted === true && fitG.w > 0 && fitG.validNllBest < fitG.validNllBase, JSON.stringify(fitG));
  const bad = Array.from({ length: 120 }, (_, i) => mkRec(outcomes[i % 3], false, outcomes[(i + 1) % 3]));
  const fitB = pm.fitSecondOpinionBlend(bad);
  ck("案6: 第二意見が有害なときは採用しない(w=0のまま)", fitB.adopted === false && fitB.w === 0, JSON.stringify(fitB));
}
{
  // 適用: w=0/データ無し → 不変。w>0 → 混合されて判定が動き、開示が付く
  const base = { homeLambda: 1.31, awayLambda: 1.29, rho: 0, marketImplied: null, marketW: 0 };
  const off = pm.applySecondOpinionBlend({ ...base, apifbImplied: { homePct: 70, drawPct: 15, awayPct: 15 }, w: 0 });
  ck("案6: w=0では1ビットも変えない(開示もnull)", off.apifbBlendUsed === null, JSON.stringify(off));
  const noData = pm.applySecondOpinionBlend({ ...base, apifbImplied: null, w: 0.5 });
  ck("案6: 第二意見が無い試合は従来どおり(開示null)", noData.apifbBlendUsed === null, "");
  const on = pm.applySecondOpinionBlend({ ...base, apifbImplied: { homePct: 80, drawPct: 10, awayPct: 10 }, w: 0.6 });
  ck("案6: w>0では混合され、開示(混合%と学習の旨)が必ず付く",
    on.apifbBlendUsed && on.apifbBlendUsed.pct === 60 && /実測で学習/.test(on.apifbBlendUsed.noteJa) && on.predictedWinner === "home",
    JSON.stringify(on));
}
{
  // 学習の土台=「その予測が実際に使った確率」: 市場ブレンド済み記録では土台が変わる
  const rec = mkRec("home", true);
  const s1 = pm.secondOpinionSampleOf(rec);
  const s2 = pm.secondOpinionSampleOf({ ...rec, marketImplied: { homePct: 80, drawPct: 10, awayPct: 10 }, blendUsed: { w: 0.5 } });
  ck("案6: 市場ブレンドを使った記録は、その適用後の確率を土台に学習する",
    !!s1 && !!s2 && Math.abs(s2.model.home - s1.model.home) > 0.05, JSON.stringify({ s1: s1.model, s2: s2.model }));
}
{
  ck("案6: isSaneWeightsがapifbBlendの範囲(0〜0.95)を守る",
    pm.isSaneWeights({ homeBase: 1.3, awayBase: 1.1, apifbBlend: 0.5 }) === true
    && pm.isSaneWeights({ homeBase: 1.3, awayBase: 1.1, apifbBlend: 1.5 }) === false, "");
}
{
  const dj = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  ck("案6: 予測時にAPI-Football予想を取得・記録する結線がある",
    dj.includes("apifbImplied = { homePct: h, drawPct: d, awayPct: a2 }") && dj.includes("apifbImplied, apifbBlendUsed,"), "");
  ck("案6: 毎晩の学習に門番つきの混合比フィットがある",
    dj.includes("fitSecondOpinionBlend(recentForApifb)") && dj.includes("apifbBlendFit:"), "");
  const sv = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ck("案6: 予想の開示(apifbBlend)がAPI応答に載る", sv.includes("apifbBlend: record.apifbBlendUsed"), "");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ck("案6: 画面の開示行(🤝 第二意見)と4言語辞書がある",
    html.includes("第二意見を") && html.includes("Second opinion blended"), "");
}

// ============ 案5: 会話の文脈記憶 ============
// サーバーをスタブ環境で起動して sanitizeDiscussHistory を単体検証
process.env.PORT = "0";
process.env.API_FOOTBALL_KEY = "k";
process.env.ANTHROPIC_API_KEY = "";
process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
process.env.RATE_LIMIT_PER_MINUTE = "100000";
process.env.SELF_HEAL_DAILY_LEARNING = "0";
process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000";
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = new URL(String(u));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(u, o);
  if (url.hostname === "upstash.test") {
    const body = JSON.parse(o.body);
    if (url.pathname.endsWith("/pipeline")) return { ok: true, json: async () => body.map(() => ({ result: null })) };
    return { ok: true, json: async () => ({ result: null }) };
  }
  const e = new Error("blocked"); e.name = "AbortError"; throw e;
};
const srv = require(path.join(ROOT, "server", "server.js"));
(async () => {
  await new Promise((r) => srv.server.on("listening", r));
  {
    const s = srv.sanitizeDiscussHistory;
    ck("案5: sanitizeDiscussHistoryが公開されている(テスト可能)", typeof s === "function", "");
    ck("案5: 配列以外・壊れた要素は黙って捨てる(エラーにしない)",
      s(null).length === 0 && s([{ q: "", a: "x" }, "junk", { q: "Q", a: "A" }]).length === 1, "");
    const long = s([{ q: "あ".repeat(900), a: "い".repeat(2000) }]);
    ck("案5: 1往復あたりの上限(質問500字・回答800字)で切り詰める",
      long[0].q.length === 500 && long[0].a.length === 800, "");
    const many = s([1, 2, 3, 4, 5].map((i) => ({ q: `Q${i}`, a: `A${i}` })));
    ck("案5: 直近3往復だけを使う", many.length === 3 && many[0].q === "Q3" && many[2].q === "Q5", JSON.stringify(many));
  }
  {
    const sv = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
    ck("案5: 直前の会話がLLMプロンプトへ渡る結線がある(文脈と事実の優先順も明記)",
      sv.includes("直前の会話(参考情報") && sv.includes("historyTurns"), "");
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    ck("案5: 画面が直近3往復をサーバーへ送る", html.includes("history: Array.isArray(history) ? history.slice(-3) : []"), "");
    ck("案5: 続きの質問で直前の対象を引き継ぐ(代名詞判定つき)",
      html.includes("DISCUSS_FOLLOWUP_RE") && html.includes("mem.lastSubject"), "");
    ck("案5: 記憶は画面単位(hero / card:◯◯)で分ける", html.includes('"hero"') && html.includes("card:${key}"), "");
  }
  srv.server.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
