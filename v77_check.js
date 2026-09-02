/**
 * scripts/v77_check.js — v77(集客3点)の自己完結テスト。
 *   ① 試合個別ページ(/match/<id>)+sitemap.xml+robots.txt(検索エンジンの受け皿)
 *   ④ PWA(manifest配信MIME・/sw.jsの限定配信・登録ガード)
 *   ② 目覚ましワークフローの終日化(スケジュール行の静的確認)
 * 実行: node scripts/v77_check.js(リポジトリのどこからでも可・ネットワーク不要)
 */
"use strict";
const path = require("path");
const fs = require("fs");
const http = require("http");

// 配置の自動判別(2026-09-02監査): 開発配置(scripts/../server/)でも、リポジトリの
// フラット配置(テストと同じ階層または親にserver.jsとlearning/)でも実行できるようにする。
// リポジトリに保管したテストが、保管先(フラット配置)ではそのまま実行できなかった問題の修正。
const ROOT = (() => {
  if (fs.existsSync(path.join(__dirname, "..", "server", "server.js"))) return path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(__dirname, "server.js")) && fs.existsSync(path.join(__dirname, "learning"))) return __dirname;
  if (fs.existsSync(path.join(__dirname, "..", "server.js")) && fs.existsSync(path.join(__dirname, "..", "learning"))) return path.resolve(__dirname, "..");
  return path.resolve(__dirname, "..", "..");
})();
const SERVER_DIR = fs.existsSync(path.join(ROOT, "server", "server.js")) ? path.join(ROOT, "server") : ROOT;
const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 300) : ""}`); };

// ============ Part 1: seoPages 単体 ============
const seoPages = require(path.join(SERVER_DIR, "knowledge", "seoPages.js"));
const { CLUB_UNIVERSE } = require(path.join(SERVER_DIR, "learning", "clubUniverse.js"));
const uni = CLUB_UNIVERSE.find((c) => c && c.nameEn && c.nameJa);

const baseRecord = {
  fixtureId: 12345,
  homeTeamEn: uni.nameEn, awayTeamEn: "Testville FC <script>alert(1)</script>",
  league: "テストリーグ", kickoff: "2026-09-13T18:00:00+00:00",
  predictedWinner: "home", predictedScoreline: "2-1",
  homeLambda: 1.8, awayLambda: 0.9,
  factorImportance: [{ labelJa: "得点力・失点率", stars: 2 }],
  weightsVersion: 12, official: true, learnedCompetition: true,
  resolved: false,
};

// 1. 未解決ページ: 日本語クラブ名・予想・正直な「答え合わせについて」
{
  const html = seoPages.renderMatchPageHtml(baseRecord, "https://example.test");
  ck("①ページ: 対応表にあるクラブは日本語名で表示", html.includes(uni.nameJa), uni.nameJa);
  ck("①ページ: 予想(ホーム勝利)と最有力スコアが出る", html.includes("勝利") && html.includes("2-1"), "");
  ck("①ページ: 未解決は「試合後に必ず追記」と正直に書く", html.includes("答え合わせについて") && !html.includes("✅") && !html.includes("❌"), "");
  ck("①ページ: canonical/OGPが絶対URLで入る", html.includes('rel="canonical" href="https://example.test/match/12345"') && html.includes('property="og:title"'), "");
  ck("①ページ: HTMLエスケープ(名前に仕込んだscriptが無害化)", !html.includes("<script>alert") && html.includes("&lt;script&gt;"), "");
  ck("①ページ: 勝率3値(保存済みλ由来)が出る", /\d+% \/ 引き分け \d+% \//.test(html), "");
}
// 2. 解決済み(的中+スコア完全一致)
{
  const rec = { ...baseRecord, resolved: true, actualWinner: "home", correct: true, actualScore: { home: 2, away: 1 }, resolvedAt: "2026-09-13T20:00:00Z" };
  const html = seoPages.renderMatchPageHtml(rec, "https://example.test");
  ck("①ページ: 解決済みは実結果+✅的中を表示", html.includes("✅ 的中") && html.includes("2 - 1"), "");
  ck("①ページ: スコア完全一致も判定して表示", html.includes("✅ 完全的中"), "");
}
// 3. 解決済み(外れ)+スコア不一致
{
  const rec = { ...baseRecord, resolved: true, actualWinner: "away", correct: false, actualScore: { home: 0, away: 2 } };
  const html = seoPages.renderMatchPageHtml(rec, "https://example.test");
  ck("①ページ: 外れも隠さず❌で表示", html.includes("❌ 外れ"), "");
}
// 4. 勝敗と矛盾するスコアは出さない(SPAと同じ整合ルール)
{
  const rec = { ...baseRecord, predictedScoreline: "1-1" };
  const html = seoPages.renderMatchPageHtml(rec, "https://example.test");
  ck("①ページ: 予想勝敗と矛盾するスコア(home予想で1-1)は非表示", !html.includes("最有力スコア"), "");
}
// 5. sitemap / robots / 索引
{
  const rows = [
    JSON.stringify({ id: "111", kickoff: "2026-09-10T12:00:00Z", home: "A", away: "B" }),
    "{broken json",
    JSON.stringify({ id: "222", kickoff: "2026-09-12T12:00:00Z", home: "C", away: "D" }),
  ];
  seoPages.buildSitemapXml({ upstashCmd: async () => rows }, "https://example.test").then((xml) => {
    ck("①sitemap: ルート+/match/URLが入り、壊れた行はスキップ",
      xml.includes("<loc>https://example.test/</loc>") && xml.includes("/match/111") && xml.includes("/match/222") && xml.includes("<lastmod>2026-09-10</lastmod>"), xml.slice(0, 300));
  });
  const robots = seoPages.robotsTxt("https://example.test");
  ck("①robots: Sitemapの絶対URLを含む", robots.includes("Sitemap: https://example.test/sitemap.xml") && robots.includes("Allow: /"), robots);
  const calls = [];
  seoPages.recordMatchIndexEntry({ upstashCmd: async (c) => { calls.push(c); } }, baseRecord).then(() => {
    const rp = calls.find((c) => c[0] === "RPUSH");
    const lt = calls.find((c) => c[0] === "LTRIM");
    ck("①索引: RPUSH(JSON)+LTRIM(-600)で追記される",
      !!rp && rp[1] === "seo:matches" && JSON.parse(rp[2]).id === "12345" && !!lt && lt[2] === "-600", JSON.stringify(calls));
  });
}

// ============ Part 2: サーバー起動統合(スタブ環境・ネットワーク遮断) ============
process.env.PORT = "0";
process.env.API_FOOTBALL_KEY = "k";
process.env.ANTHROPIC_API_KEY = "";
process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
process.env.RATE_LIMIT_PER_MINUTE = "100000";
process.env.SELF_HEAL_DAILY_LEARNING = "0";
process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000";

const RECORD_FOR_ROUTE = { ...baseRecord, awayTeamEn: "Testville FC" };
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = new URL(String(u));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(u, o);
  if (url.hostname === "upstash.test") {
    const body = JSON.parse(o.body);
    if (url.pathname.endsWith("/pipeline")) return { ok: true, json: async () => body.map(() => ({ result: null })) };
    if (Array.isArray(body) && body[0] === "GET" && body[1] === "learn:ownpred:12345") {
      return { ok: true, json: async () => ({ result: JSON.stringify(RECORD_FOR_ROUTE) }) };
    }
    if (Array.isArray(body) && body[0] === "LRANGE" && body[1] === "seo:matches") {
      return { ok: true, json: async () => ({ result: [JSON.stringify({ id: "12345", kickoff: "2026-09-13T18:00:00Z" })] }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  }
  const e = new Error("blocked"); e.name = "AbortError"; throw e;
};

const srv = require(path.join(SERVER_DIR, "server.js"));
(async () => {
  await new Promise((r) => srv.server.on("listening", r));
  const port = srv.server.address().port;
  const get = (p) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let buf = "";
      res.on("data", (d) => { buf += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    }).on("error", (e) => resolve({ status: 0, body: String(e), headers: {} }));
  });

  const page = await get("/match/12345");
  ck("②統合: /match/12345 が200で、両クラブ名を含むHTML",
    page.status === 200 && page.body.includes(uni.nameJa) && page.body.includes("Testville FC") && page.headers["content-type"].includes("text/html"), `status=${page.status}`);
  const cachedAgain = await get("/match/12345");
  ck("②統合: 同ページ2回目も200(10分キャッシュ経路)", cachedAgain.status === 200, "");
  const missing = await get("/match/99999");
  ck("②統合: 無いIDは正直な404(noindex付き)", missing.status === 404 && missing.body.includes("noindex") && missing.body.includes("見つかりませんでした"), `status=${missing.status}`);
  const nonNumeric = await get("/match/abc");
  ck("②統合: 数字でないIDはページ経路に入らず404", nonNumeric.status === 404, `status=${nonNumeric.status}`);
  const sm = await get("/sitemap.xml");
  ck("②統合: /sitemap.xml が200のXMLで/match/12345を含む",
    sm.status === 200 && sm.body.includes("<urlset") && sm.body.includes("/match/12345") && sm.headers["content-type"].includes("xml"), `status=${sm.status}`);
  const rb = await get("/robots.txt");
  ck("②統合: /robots.txt が200でSitemap行を含む", rb.status === 200 && rb.body.includes("Sitemap:"), `status=${rb.status}`);
  const sw = await get("/sw.js");
  ck("④統合: /sw.js が200・text/javascript・no-cacheで配信",
    sw.status === 200 && sw.body.includes("CACHE_NAME") && sw.headers["content-type"].includes("javascript") && String(sw.headers["cache-control"]).includes("no-cache"), `status=${sw.status}`);
  const srcLeak = await get("/server.js");
  ck("④統合: /server.js は引き続き配信されない(ソース流出ガード維持)", srcLeak.status === 404, `status=${srcLeak.status}`);
  const mf = await get("/manifest.webmanifest");
  ck("④統合: manifestが200・application/manifest+jsonで配信",
    mf.status === 200 && mf.body.includes("サッカー分析AI") && mf.headers["content-type"].includes("manifest"), `status=${mf.status} ct=${mf.headers["content-type"]}`);
  const health = await get("/api/health");
  ck("既存: /api/health は従来どおり200", health.status === 200, `status=${health.status}`);

  srv.server.close();

  // ============ Part 3: 静的な結線確認 ============
  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ck("④index: manifestリンクとtheme-colorがheadにある", indexHtml.includes('rel="manifest"') && indexHtml.includes('name="theme-color"'), "");
  ck("④index: SW登録は自動テスト(webdriver)中は行わないガード付き", indexHtml.includes("serviceWorker.register") && indexHtml.includes("navigator.webdriver"), "");
  ck("①index: 予想カードに試合ページへのリンク雛形がある", indexHtml.includes("/match/${Number(p.fixtureId)}"), "");
  const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "matchday-ping.yml"), "utf8");
  ck("②YAML: ほぼ終日のcron(0-19,22-23)+土日補完(20-21)がある", yml.includes("0-19,22-23 * * *") && yml.includes("20-21 * * 0,6"), "");
  const dj = fs.readFileSync(path.join(SERVER_DIR, "learning", "dailyJob.js"), "utf8");
  ck("①dailyJob: 予測保存時にサイトマップ索引へ追記する結線がある", dj.includes("recordMatchIndexEntry"), "");
  const icons = ["icon-192.png", "icon-512.png", "apple-touch-icon.png"].every((f) => fs.existsSync(path.join(ROOT, f)));
  ck("④アイコン3種がリポジトリ直下にある", icons, "");

  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
