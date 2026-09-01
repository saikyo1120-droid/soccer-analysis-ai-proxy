/**
 * seoPages.js — v77(2026年9月1日・集客①)
 * ----------------------------------------------------------------------------
 * 検索エンジンからの流入の受け皿: 試合ごとの個別ページ+サイトマップ+robots。
 *
 * ■ なぜ作るか(利用者の承認済み方針)
 *   サイト全体が1枚のアプリ(index.html)のため、検索エンジンから見ると
 *   「ページが1枚しかないサイト」だった。「◯◯対◯◯ 予想」のような
 *   試合前検索の受け皿を、保存済みの予想レコードから自動生成する。
 *
 * ■ 設計原則(最終方針⑥の遵守)
 *   ・ここで行うのは「保存済みレコード(learn:ownpred:<id>)の読み出し+文字列組み立て」だけ。
 *   ・新しい計算・外部API呼び出し・LLMは一切使わない。
 *   ・呼び出し側(server.js)が10分キャッシュするため、同じ試合ページへの
 *     アクセスが集中してもUpstash読み出しは10分に1回。
 *   ・でっち上げ禁止: レコードに無い項目は書かない。答え合わせ前のページは
 *     「試合後にこのページで答え合わせします」と正直に書く。
 */
"use strict";

const { CLUB_UNIVERSE } = require("../learning/clubUniverse");
const { computeMarketProbs } = require("../learning/accuracyTracker");
const { scorelineOutcome } = require("../learning/predictionModel");

const MATCH_PATH_RE = /^\/match\/(\d{1,12})$/;
// サイトマップ用の軽量索引(JSON文字列のリスト)。予想の保存時に1件RPUSHするだけ。
const INDEX_KEY = "seo:matches";
const INDEX_CAP = 600;      // 索引の保持上限(直近600試合)
const SITEMAP_URL_CAP = 500; // サイトマップに載せる上限

// ---- クラブ名の日本語化(CLUB_UNIVERSEの静的対応表のみ。推測しない) ----
let JA_BY_EN = null;
function jaNameOf(nameEn) {
  if (!nameEn) return null;
  if (!JA_BY_EN) {
    JA_BY_EN = new Map();
    for (const c of CLUB_UNIVERSE) {
      if (c && c.nameEn && c.nameJa) JA_BY_EN.set(String(c.nameEn).toLowerCase(), c.nameJa);
    }
  }
  return JA_BY_EN.get(String(nameEn).toLowerCase()) || null;
}
function displayName(nameEn) {
  const ja = jaNameOf(nameEn);
  return ja ? `${ja}` : String(nameEn || "不明");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtKickoffJa(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    }) + "(日本時間)";
  } catch (e) { return null; }
}

function outcomeLabelJa(winner, homeName, awayName) {
  if (winner === "home") return `${homeName}(ホーム)の勝利`;
  if (winner === "away") return `${awayName}(アウェイ)の勝利`;
  if (winner === "draw") return "引き分け";
  return null;
}

// ---- サイトマップ索引への追記(毎朝の学習で予想を保存した直後に1回) ----
async function recordMatchIndexEntry(deps, record) {
  if (!deps || typeof deps.upstashCmd !== "function" || !record || !record.fixtureId) return false;
  const entry = JSON.stringify({
    id: String(record.fixtureId),
    kickoff: record.kickoff || null,
    home: record.homeTeamEn || null,
    away: record.awayTeamEn || null,
  });
  await deps.upstashCmd(["RPUSH", INDEX_KEY, entry]);
  await deps.upstashCmd(["LTRIM", INDEX_KEY, String(-INDEX_CAP), "-1"]);
  return true;
}

// ---- sitemap.xml ----
async function buildSitemapXml(deps, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  const urls = [`  <url><loc>${esc(base)}/</loc><changefreq>daily</changefreq></url>`];
  let rows = [];
  try {
    rows = (await deps.upstashCmd(["LRANGE", INDEX_KEY, "0", "-1"])) || [];
  } catch (e) { rows = []; }
  const seen = new Set();
  const items = [];
  for (const raw of rows) {
    try {
      const it = JSON.parse(raw);
      if (!it || !it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    } catch (e) { /* 壊れた行は載せない(サイトマップ全体は生かす) */ }
  }
  items.sort((a, b) => String(b.kickoff || "").localeCompare(String(a.kickoff || "")));
  for (const it of items.slice(0, SITEMAP_URL_CAP)) {
    const lastmod = (typeof it.kickoff === "string" && /^\d{4}-\d{2}-\d{2}/.test(it.kickoff))
      ? `<lastmod>${it.kickoff.slice(0, 10)}</lastmod>` : "";
    urls.push(`  <url><loc>${esc(base)}/match/${esc(it.id)}</loc>${lastmod}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

// ---- robots.txt ----
function robotsTxt(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
}

// ---- 試合ページ本体 ----
function renderMatchPageHtml(record, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  const home = displayName(record.homeTeamEn);
  const away = displayName(record.awayTeamEn);
  const canonical = `${base}/match/${esc(String(record.fixtureId))}`;
  const kickoffJa = fmtKickoffJa(record.kickoff);
  const resolved = record.resolved === true;

  // 勝率(保存済みλから導く既存モデルの分布。新しい推定はしない)
  const probs = (Number.isFinite(record.homeLambda) && Number.isFinite(record.awayLambda))
    ? computeMarketProbs(record.homeLambda, record.awayLambda) : null;
  const pct = (x) => Math.round(Number(x) * 100);

  const predLabel = outcomeLabelJa(record.predictedWinner, home, away);
  // 勝敗と矛盾するスコアは出さない(SPAと同じ整合ルール)
  const scoreline = (record.predictedScoreline
    && scorelineOutcome(record.predictedScoreline) === record.predictedWinner)
    ? record.predictedScoreline : null;

  const topFactor = Array.isArray(record.factorImportance)
    ? (record.factorImportance.find((f) => f && f.stars > 0) || null) : null;

  const title = `${home} vs ${away} のAI予想${resolved ? "と結果" : ""}`;
  const descParts = [`サッカー分析AIによる${home} vs ${away}の勝敗予想`];
  if (predLabel) descParts.push(`予想: ${predLabel}`);
  if (resolved && record.actualScore) descParts.push(`結果: ${record.actualScore.home}-${record.actualScore.away}`);
  descParts.push("外れも隠さず答え合わせを公開しています。");
  const desc = descParts.join("。");

  const rows = [];
  if (record.league) rows.push(`<tr><th>大会</th><td>${esc(record.league)}${record.official === false ? "(親善など・参考扱い)" : ""}</td></tr>`);
  if (kickoffJa) rows.push(`<tr><th>キックオフ</th><td>${esc(kickoffJa)}</td></tr>`);
  if (predLabel) rows.push(`<tr><th>AIの予想</th><td><strong>${esc(predLabel)}</strong>${scoreline ? `(最有力スコア ${esc(scoreline)})` : ""}</td></tr>`);
  if (probs) {
    rows.push(`<tr><th>勝率の見立て</th><td>${esc(home)} ${pct(probs.homeWin)}% / 引き分け ${pct(probs.draw)}% / ${esc(away)} ${pct(probs.awayWin)}%</td></tr>`);
  }
  if (topFactor && topFactor.labelJa) rows.push(`<tr><th>根拠(最重要要素)</th><td>${esc(topFactor.labelJa)}</td></tr>`);
  if (record.blendUsed && Number.isFinite(record.blendUsed.marketPct)) {
    rows.push(`<tr><th>判定方式</th><td>市場オッズ${Number(record.blendUsed.marketPct)}%+AI${Number(record.blendUsed.aiPct)}%の合成判定</td></tr>`);
  }
  if (Number.isFinite(record.marketEdgePt)) {
    rows.push(`<tr><th>市場(オッズ)比較</th><td>AIは市場より${record.marketEdgePt > 0 ? "強気" : "弱気"}(${record.marketEdgePt > 0 ? "+" : ""}${Number(record.marketEdgePt)}pt)</td></tr>`);
  }
  if (Number.isFinite(record.weightsVersion)) rows.push(`<tr><th>使用モデル</th><td>自前予測モデル(学習v${Number(record.weightsVersion)}の重み)</td></tr>`);
  if (record.learnedCompetition === false) {
    rows.push(`<tr><th>ご注意</th><td>この大会はAIがまだ過去試合を学習していないため、参考予想です。</td></tr>`);
  }

  let resultHtml = "";
  if (resolved) {
    const actualLabel = outcomeLabelJa(record.actualWinner, home, away) || "結果不明";
    const score = (record.actualScore && record.actualScore.home !== null && record.actualScore.home !== undefined)
      ? `${Number(record.actualScore.home)} - ${Number(record.actualScore.away)}` : null;
    const hit = record.correct === true;
    // スコア一致は表記ゆれを避けるため数値で比較する(判定できる材料が無ければ書かない)
    let scorelineHit = null;
    if (scoreline && record.actualScore) {
      const m = /^(\d+)-(\d+)$/.exec(scoreline);
      if (m) scorelineHit = Number(m[1]) === Number(record.actualScore.home) && Number(m[2]) === Number(record.actualScore.away);
    }
    resultHtml = `
    <h2>答え合わせ(実際の結果)</h2>
    <table>
      <tr><th>実際の結果</th><td><strong>${esc(actualLabel)}</strong>${score ? `(${esc(score)})` : ""}</td></tr>
      <tr><th>勝敗の予想</th><td>${hit ? "✅ 的中" : "❌ 外れ"}</td></tr>
      ${scorelineHit !== null ? `<tr><th>スコアまでの予想</th><td>${scorelineHit ? "✅ 完全的中" : `❌ 外れ(予想 ${esc(scoreline)})`}</td></tr>` : ""}
    </table>
    <p class="note">外れも隠さず載せるのが、このAIの方針です。外した理由の分析は<a href="${esc(base)}/">アプリ本体の「🙈 AIの反省」タブ</a>で公開しています。</p>`;
  } else {
    resultHtml = `
    <h2>答え合わせについて</h2>
    <p>この試合が終わると、AIが結果を照合し、このページに<strong>的中か外れかを必ず追記</strong>します(外れても隠しません)。予想は毎朝の学習時に保存されたもので、後から書き換えることはありません。</p>`;
  }

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | サッカー分析AI</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:site_name" content="サッカー分析AI">
<meta property="og:image" content="${esc(base)}/icon-512.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${esc(base)}/icon-192.png">
<style>
  body { font-family: -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif; background: #f9f9f7; color: #0b0b0b; margin: 0; padding: 16px; line-height: 1.7; }
  main { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e2e0db; border-radius: 12px; padding: 20px 22px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 22px 0 8px; border-left: 4px solid #2a78d6; padding-left: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eceae5; vertical-align: top; font-size: 14px; }
  th { width: 9.5em; color: #555; font-weight: 600; white-space: nowrap; }
  .note { font-size: 13px; color: #555; }
  .cta { display: inline-block; margin-top: 14px; background: #2a78d6; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; }
  footer { max-width: 720px; margin: 14px auto 0; font-size: 12px; color: #777; }
</style>
</head>
<body>
<main>
  <h1>${esc(home)} vs ${esc(away)}</h1>
  <p class="note">サッカー分析AIの試合予想ページ${kickoffJa ? ` ・ ${esc(kickoffJa)}` : ""}</p>
  <h2>AIの予想</h2>
  <table>
${rows.join("\n")}
  </table>
  ${record.similarPastJa ? `<p class="note">📚 ${esc(record.similarPastJa)}</p>` : ""}
  ${resultHtml}
  <h2>このAIについて</h2>
  <p>毎朝、実データで学習した自前モデルが予想を生成・保存し、試合後に必ず答え合わせして精度を全公開しています(外れも隠しません)。今日の全試合の予想・的中率の実測・AIとの予想対決はアプリ本体でどうぞ。</p>
  <a class="cta" href="${esc(base)}/">⚽ 今日のAI予想を見る</a>
</main>
<footer>このページは保存済みの予想レコードから自動生成されています。予想の後出し・書き換えはありません。</footer>
</body>
</html>
`;
  return html;
}

// 見つからない場合の正直な404ページ
function renderNotFoundHtml(fixtureId, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>この試合の予想は見つかりませんでした | サッカー分析AI</title>
<meta name="robots" content="noindex">
<style>body{font-family:-apple-system,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif;background:#f9f9f7;margin:0;padding:16px;line-height:1.7;}main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e0db;border-radius:12px;padding:20px 22px;}a.cta{display:inline-block;margin-top:10px;background:#2a78d6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;}</style>
</head>
<body>
<main>
  <h1>この試合の予想レコードは見つかりませんでした</h1>
  <p>この試合ID(${esc(String(fixtureId))})の予想は、まだ作られていないか、保存期限(答え合わせ後180日)を過ぎて削除されています。作りものの予想を代わりに表示することはしません。</p>
  <a class="cta" href="${esc(base)}/">⚽ 今日のAI予想を見る</a>
</main>
</body>
</html>
`;
}

// ルート用の入口: レコードを読み、ページか404を返す
async function renderMatchPage(deps, fixtureId, origin) {
  let record = null;
  try {
    record = await deps.upstashGetJSON(`learn:ownpred:${fixtureId}`);
  } catch (e) { record = null; }
  if (!record || !record.fixtureId) {
    return { status: 404, html: renderNotFoundHtml(fixtureId, origin) };
  }
  return { status: 200, html: renderMatchPageHtml(record, origin) };
}

module.exports = {
  MATCH_PATH_RE, INDEX_KEY, INDEX_CAP, SITEMAP_URL_CAP,
  recordMatchIndexEntry, buildSitemapXml, robotsTxt,
  renderMatchPage, renderMatchPageHtml, renderNotFoundHtml,
  jaNameOf,
};
