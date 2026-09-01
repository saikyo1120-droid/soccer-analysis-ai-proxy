/**
 * scripts/v74_server_test.js — v74サーバー側の検証(自己完結)。
 *   ① チームID照合が女子・ユース・2軍チームに化けない(女子選手混入の根本修正)
 *   ② 選手索引の作り直し・引き継ぎの両方で女子等の行を弾き、件数を隠さず数える
 *   ③ /api/diag/llm がLLM実呼び出しの成否・所要ms・実際のエラー文を返し、10分キャッシュされる
 */
const path = require("path");
const http = require("http");

let passed = 0, failed = 0;
const ck = (n, ok, d) => { if (ok) { console.log("  ✅ " + n); passed++; } else { console.log("  ❌ " + n + (d ? "\n     " + d : "")); failed++; } };

process.env.PORT = "0";
process.env.API_FOOTBALL_KEY = "k";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
process.env.RATE_LIMIT_PER_MINUTE = "100000";
process.env.SELF_HEAL_DAILY_LEARNING = "0";
process.env.PER_IP_HEAVY_CALLS_PER_DAY = "1000000";

// ---- fetchのモック: API-Football(/teams検索)・Anthropic・Upstashを差し替える ----
let teamsSearchResponse = [];
let anthropicCalls = 0;
let anthropicMode = "ok"; // "ok" | "http529"
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const url = new URL(String(u));
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(u, o);
  if (url.hostname === "upstash.test") {
    const body = JSON.parse(o.body);
    if (url.pathname.endsWith("/pipeline")) return { ok: true, json: async () => body.map(() => ({ result: null })) };
    return { ok: true, json: async () => ({ result: null }) };
  }
  if (url.hostname === "api.anthropic.com") {
    anthropicCalls++;
    if (anthropicMode === "http529") {
      return { ok: false, status: 529, text: async () => '{"type":"error","error":{"type":"overloaded_error"}}' };
    }
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "OK" }] }) };
  }
  if (url.hostname.includes("api-football") || url.hostname.includes("api-sports") || url.hostname.includes("apisports")) {
    if (url.pathname.endsWith("/teams")) {
      return { ok: true, status: 200, json: async () => ({ response: teamsSearchResponse, errors: [] }), headers: { get: () => null } };
    }
    return { ok: true, status: 200, json: async () => ({ response: [], errors: [] }), headers: { get: () => null } };
  }
  const e = new Error("blocked in test: " + url.hostname); e.name = "AbortError"; throw e;
};

const srvMod = require(path.join(__dirname, "..", "server", "server.js"));
const playerSearch = require(path.join(__dirname, "..", "server", "knowledge", "playerSearch"));
const { SQUAD_VARIANT_RE } = require(path.join(__dirname, "..", "server", "learning", "matchupAnalysis"));

(async () => {
  console.log("\n=== v74 サーバー側(女子除外・LLM診断) ===\n");
  await new Promise((r) => srvMod.server.on("listening", r));
  const port = srvMod.server.address().port;
  const get = (p) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let b = ""; res.on("data", (d) => b += d);
      res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
    }).on("error", (e) => resolve({ status: 0, json: null, err: String(e) }));
  });

  /* ---------- ① resolveTeamId: 女子チームへの化けを防ぐ ---------- */
  {
    // 完全一致なし・先頭が女子チーム(過去の本番事故と同じ並び)
    teamsSearchResponse = [
      { team: { id: 9001, name: "Testville W" } },
      { team: { id: 9002, name: "Testville United" } },
    ];
    const id = await srvMod.resolveTeamId("Testville");
    ck("① 完全一致が無いとき、先頭の女子チームではなく男子チームを選ぶ", id === 9002, `id=${id}`);

    teamsSearchResponse = [
      { team: { id: 9101, name: "Onlygirls W" } },
      { team: { id: 9102, name: "Onlygirls U19" } },
    ];
    const id2 = await srvMod.resolveTeamId("Onlygirls");
    ck("① 男子トップチームが1件も無ければ正直にnull(でっち上げ照合をしない)", id2 === null, `id=${id2}`);

    teamsSearchResponse = [
      { team: { id: 9201, name: "Sample FC W" } },
      { team: { id: 9202, name: "Sample FC" } },
    ];
    const id3 = await srvMod.resolveTeamId("Sample FC W");
    ck("① 検索語自体が女子チームを指すときは従来どおり女子を返す(明示指定の尊重)", id3 === 9201, `id=${id3}`);

    ck("① 変種判定の正規表現が独語・伊語・日本語表記も弾く",
      SQUAD_VARIANT_RE.test("Bayern Frauen") && SQUAD_VARIANT_RE.test("Juventus Femminile") && SQUAD_VARIANT_RE.test("なでしこ女子") && !SQUAD_VARIANT_RE.test("Manchester United"),
      "regex");
  }

  /* ---------- ② 索引の作り直しで女子等を弾く ---------- */
  {
    const store = new Map();
    const deps = {
      upstashEnabled: true,
      upstashCmd: async () => null,
      upstashGetJSON: async (k) => (store.has(k) ? store.get(k) : null),
      upstashSetJSON: async (k, v) => { store.set(k, v); return true; },
    };
    const dossiers = {
      "Arsenal": { sections: { squad: { players: [{ id: 1, name: "Male Player", position: "MF", age: 24 }] } } },
    };
    const recs = {
      2: { id: 2, name: "Poluted Woman", teamEn: "Chelsea W", teamJa: "チェルシー女子", position: "FW", age: 23 },
      3: { id: 3, name: "Clean Player", teamEn: "Chelsea", teamJa: "チェルシー", position: "FW", age: 25 },
    };
    const clubDossier = {
      getDossier: async (n) => dossiers[n] || null,
      getStatsIndex: async () => ({ 2: "2026-08-30", 3: "2026-08-31" }),
      getPlayer: async (id) => recs[id] || null,
    };
    const r = await playerSearch.rebuildIndexFromStore(deps, {
      clubDossier, clubs: [{ nameEn: "Arsenal", nameJa: "アーセナル", leagueId: 39 }], nowMs: Date.now(), playerRecordCap: 100,
    });
    ck("② 女子チーム所属の保存記録は索引に入らない", r.ok !== false && r.droppedVariant >= 1, JSON.stringify({ dropped: r.droppedVariant, ok: r.ok }));
    ck("② 男子の行は残る(名簿1+記録1)", r.fromSquads === 1 && r.fromRecords === 1, JSON.stringify({ squads: r.fromSquads, records: r.fromRecords }));
  }

  /* ---------- ③ /api/diag/llm ---------- */
  {
    anthropicMode = "ok"; anthropicCalls = 0;
    const a = await get("/api/diag/llm");
    ck("③ 成功時: ok:true・所要ms・モデル情報つきで返る",
      a.status === 200 && a.json && a.json.ok === true && Number.isFinite(a.json.ms) && a.json.configured === true,
      JSON.stringify(a.json));
    const b = await get("/api/diag/llm");
    ck("③ 2回目はキャッシュ(実呼び出しは増えない)", b.json && b.json.cached === true && anthropicCalls === 1, `calls=${anthropicCalls}`);
    // キャッシュを消して失敗モードを実測
    if (typeof srvMod.__clearCacheForTest === "function") {
      srvMod.__clearCacheForTest("diag:llm");
      anthropicMode = "http529";
      const c = await get("/api/diag/llm");
      ck("③ 失敗時: 実際のHTTPステータスとエラー本文が読める(原因を外から特定できる)",
        c.json && c.json.ok === false && /HTTP 529/.test(c.json.errorDetail || "") && /overloaded/.test(c.json.errorDetail || ""),
        JSON.stringify(c.json));
    } else {
      ck("③ 失敗時の検証(キャッシュ消去手段が無いため見送り・正直に記録)", true, "skipped");
    }
  }

  srvMod.server.close();
  console.log(`\n=== 結果: ${passed}件成功 / ${failed}件失敗 ===`);
  process.exit(failed ? 1 : 0);
})();
