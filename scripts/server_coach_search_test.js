/**
 * 2026年8月・優先順位⑤(今日の試合検索: 監督名でも検索できるようにする)の
 * バックエンド部分、GET /api/coach-search のテスト。
 * API-Footballの/coachsはコーチごとにフラットな{name, photo, career:[...]}を
 * 返す(server/learning/features.jsのcomputeCoachCareerと同じ実スキーマ前提)。
 */
const path = require("path");
const http = require("http");
const assert = require("assert");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

const calls = [];
global.fetch = async (url) => {
  const u = new URL(url.toString());
  calls.push(u.pathname + "?" + u.searchParams.toString());

  if (u.pathname === "/coachs" && u.searchParams.get("search") === "ancelotti") {
    return { ok: true, json: async () => ({ errors: [], response: [
      {
        name: "C. Ancelotti",
        photo: "https://example.com/ancelotti.png",
        career: [
          { team: { id: 541, name: "Real Madrid" }, start: "2021-06-01", end: null },
          { team: { id: 489, name: "AC Milan" }, start: "2001-11-01", end: "2009-05-31" },
        ],
      },
    ] }) };
  }
  if (u.pathname === "/coachs" && u.searchParams.get("search") === "nobody") {
    return { ok: true, json: async () => ({ errors: [], response: [] }) };
  }
  if (u.pathname === "/coachs" && u.searchParams.get("search") === "retired") {
    // career has no current (all entries have an end date) -> should be filtered out
    return { ok: true, json: async () => ({ errors: [], response: [
      { name: "Old Coach", photo: null, career: [{ team: { id: 1, name: "Some FC" }, start: "2000-01-01", end: "2005-01-01" }] },
    ] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  function check(name, cond) {
    if (cond) { console.log(`  [OK] ${name}`); }
    else { console.error(`  [FAIL] ${name}`); failures++; }
  }

  // 短すぎるクエリ(1文字)は検索を行わない(ノイズが多いため)
  const tooShort = await get(port, "/api/coach-search?name=a");
  check("1文字のクエリではAPI呼び出しをせず、foundはfalse", tooShort.found === false && tooShort.coaches.length === 0);
  check("1文字クエリでは実際に/coachsを呼んでいない(API予算を消費しない)", calls.length === 0);

  // 見つかる場合: 現所属チームを正しく解決する
  const found = await get(port, "/api/coach-search?name=ancelotti");
  console.log(JSON.stringify(found, null, 2));
  check("監督が見つかりfound=true", found.found === true);
  check("現所属チームがReal Madridと正しく解決される(career末尾のendがnullのエントリ)", found.coaches.length === 1 && found.coaches[0].team === "Real Madrid");
  check("名前も返る", found.coaches[0].name === "C. Ancelotti");

  // 見つからない場合
  const notFound = await get(port, "/api/coach-search?name=nobody");
  check("該当なしの場合はfound=falseで空配列", notFound.found === false && Array.isArray(notFound.coaches) && notFound.coaches.length === 0);

  // 現所属が不明(全career末尾にendがある = 退任済み)な監督は除外される
  const retired = await get(port, "/api/coach-search?name=retired");
  check("現所属が不明な監督は除外され、found=false", retired.found === false && retired.coaches.length === 0);

  server.close();
  console.log(failures === 0 ? "\nCoach search endpoint PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
