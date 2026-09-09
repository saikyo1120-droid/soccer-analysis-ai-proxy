"use strict";
/** v88: 「アクセント付きの選手名で実成績が恒久的に取得失敗」の根治テスト
 *  (利用者の実機報告「今回もKylian Mbappéの実成績データを取得できず(TRANSIENT_ERROR)」)。
 *
 *  本番実測で確定した事実(2026年9月9日):
 *   ・API-Footballの検索はアクセント付き文字でパラメータ検証エラー(HTTP 200+errors)を返す
 *   ・search=Mbappé → 毎回失敗 / search=Mbappe → 即ヒット(4試合4得点まで取得できた)
 *
 *  検証すること(モックAPI-Footballサーバー+実サーバー起動):
 *   ① アクセント付きの名前(Kylian Mbappé)で実成績が取得できる(検索語がASCIIに畳まれる)
 *   ② NFDで分解できない文字(Ødegaardのø)も畳まれて取得できる
 *   ③ サーバーが外部APIへ送ったsearchパラメータに非ASCIIが1つも無い(根治の直接確認)
 *   ④ ASCIIの名前(Saka)は従来どおりそのまま送られる(挙動不変)
 *   ⑤ 非ラテン文字(日本語名)は畳めないので従来どおり送られ、クラッシュせず正直に失敗する */
const assert = require("assert");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// モックAPI-Football: 本物と同じ「アクセント付きsearchはHTTP 200+errorsで拒否」を再現する
function startMockApiFootball() {
  const seenSearches = []; // サーバーが実際に送ってきたsearchパラメータを全部記録する
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const search = u.searchParams.get("search");
    if (search !== null) seenSearches.push(search);
    const reply = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ errors: [], results: 1, paging: {}, ...obj })); };
    const validationError = () => reply({ errors: { search: "The Search field must only contain alpha characters." }, response: [] });
    const isAscii = (s) => /^[\x20-\x7E]*$/.test(s || "");
    const mbappeEntry = {
      player: { id: 278, name: "K. Mbappé", photo: null, nationality: "France", birth: { date: "1998-12-20" } },
      statistics: [{ team: { id: 541, name: "Real Madrid" }, league: { id: 140, name: "La Liga" }, games: { appearences: 4, minutes: 360, rating: "7.93", position: "Attacker" }, goals: { total: 4, assists: 0 }, shots: {}, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: { yellow: 0, red: 0 } }],
    };
    const odegaardEntry = {
      player: { id: 986, name: "M. Ødegaard", photo: null, nationality: "Norway", birth: { date: "1998-12-17" } },
      statistics: [{ team: { id: 42, name: "Arsenal" }, league: { id: 39, name: "Premier League" }, games: { appearences: 3, minutes: 270, rating: "7.40", position: "Midfielder" }, goals: { total: 1, assists: 2 }, shots: {}, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: { yellow: 0, red: 0 } }],
    };
    const sakaEntry = {
      player: { id: 1161, name: "B. Saka", photo: null, nationality: "England", birth: { date: "2001-09-05" } },
      statistics: [{ team: { id: 42, name: "Arsenal" }, league: { id: 39, name: "Premier League" }, games: { appearences: 5, minutes: 450, rating: "7.60", position: "Attacker" }, goals: { total: 2, assists: 1 }, shots: {}, passes: {}, dribbles: {}, tackles: {}, duels: {}, cards: { yellow: 0, red: 0 } }],
    };
    if (u.pathname === "/teams") {
      if (!isAscii(search)) return validationError(); // 本物と同じ挙動(チーム検索も同じ検証)
      if (/real madrid/i.test(search || "")) return reply({ response: [{ team: { id: 541, name: "Real Madrid" } }] });
      if (/arsenal/i.test(search || "")) return reply({ response: [{ team: { id: 42, name: "Arsenal" } }] });
      return reply({ response: [] });
    }
    if (u.pathname === "/players") {
      if (u.searchParams.get("id")) {
        const id = u.searchParams.get("id");
        if (id === "278") return reply({ response: [mbappeEntry] });
        if (id === "986") return reply({ response: [odegaardEntry] });
        if (id === "1161") return reply({ response: [sakaEntry] });
        return reply({ response: [] });
      }
      if (!isAscii(search)) return validationError(); // ← 本番実測どおりの拒否
      if (/^mbappe$/i.test(search || "") || /^kylian mbappe$/i.test(search || "")) return reply({ response: [mbappeEntry] });
      if (/^odegaard$/i.test(search || "") || /^martin odegaard$/i.test(search || "")) return reply({ response: [odegaardEntry] });
      if (/^saka$/i.test(search || "")) return reply({ response: [sakaEntry] });
      return reply({ response: [] });
    }
    reply({ response: [] });
  });
  return new Promise((resolve) => srv.listen(8897, "127.0.0.1", () => resolve({ srv, seenSearches })));
}

(async () => {
  const { srv: mock, seenSearches } = await startMockApiFootball();
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env, PORT: "8898",
      API_FOOTBALL_API_BASE: "http://127.0.0.1:8897", API_FOOTBALL_KEY: "test-key",
      UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server boot timeout")), 15000);
      const poll = async () => {
        try { const r = await httpGet("http://127.0.0.1:8898/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
        setTimeout(poll, 300);
      };
      poll();
    });
    const base = "http://127.0.0.1:8898/api/player-season-stats";

    await t("① アクセント付き(Kylian Mbappé)で実成績が取得できる(本番で恒久失敗していたケース)", async () => {
      const r = await httpGet(`${base}?name=${encodeURIComponent("Kylian Mbappé")}&teamEn=${encodeURIComponent("Real Madrid")}`);
      assert.strictEqual(r.status, 200);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.found, true, "found=false: " + r.body.slice(0, 200));
      assert.strictEqual(b.player.id, 278);
      assert.strictEqual(b.stats.appearances, 4, "出場数が取れていない: " + JSON.stringify(b.stats).slice(0, 120));
      assert.strictEqual(b.stats.goals, 4);
    });

    await t("② NFDで分解できないø(Martin Ødegaard)も畳まれて取得できる", async () => {
      const r = await httpGet(`${base}?name=${encodeURIComponent("Martin Ødegaard")}&teamEn=Arsenal`);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.found, true, "found=false: " + r.body.slice(0, 200));
      assert.strictEqual(b.player.id, 986);
      assert.strictEqual(b.stats.goals, 1);
    });

    await t("④ ASCIIの名前(Bukayo Saka)は従来どおり姓で検索されヒットする(挙動不変)", async () => {
      const r = await httpGet(`${base}?name=${encodeURIComponent("Bukayo Saka")}&teamEn=Arsenal`);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.found, true, "found=false: " + r.body.slice(0, 200));
      assert.strictEqual(b.player.id, 1161);
      assert.ok(seenSearches.includes("Saka"), "姓のままの検索語が送られていない: " + JSON.stringify(seenSearches));
    });

    await t("⑤ 非ラテン文字(日本語名)は畳めない→従来どおり送られ、クラッシュせず正直に失敗する", async () => {
      const r = await httpGet(`${base}?name=${encodeURIComponent("架空選手")}`);
      assert.strictEqual(r.status, 200);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.found, false);
      assert.ok(b.reason, "理由が無い");
    });

    await t("③ 外部APIへ送られたsearchに非ASCIIが無い(日本語名の意図的な例外を除く)=根治の直接確認", async () => {
      const nonAscii = seenSearches.filter((s) => !/^[\x20-\x7E]*$/.test(s) && !/^架空選手$/.test(s));
      assert.deepStrictEqual(nonAscii, [], "非ASCIIの検索語が送信されている: " + JSON.stringify(nonAscii));
      assert.ok(seenSearches.some((s) => /^mbappe$/i.test(s)), "畳まれたMbappeが送られていない: " + JSON.stringify(seenSearches));
      assert.ok(seenSearches.some((s) => /^odegaard$/i.test(s)), "畳まれたOdegaardが送られていない");
    });
  } finally {
    server.kill("SIGKILL");
    await new Promise((r) => mock.close(r));
  }

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
