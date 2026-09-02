/**
 * scripts/audit8_regression_test.js
 * ------------------------------------------------
 * 第8次監査(第三者監査・4視点並列)で発見した欠陥の回帰テスト。
 * 各テストは「欠陥が直っていること」と「修正が既存動作を壊していないこと」を
 * 実際にコードを動かして確認する。
 */

const assert = require("assert");
const { runDailyLearning, mergeGrowthLogs } = require("../server/learning/dailyJob");
const { createKnowledgeStore } = require("../server/knowledge/knowledgeStore");
const { createClubDossier } = require("../server/knowledge/clubDossier");
const { collectUniverse } = require("../server/learning/universeCollector");
const { clubsForCoreUpdate, clubsForSquadSync } = require("../server/learning/clubUniverse");

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

function createMockRedis() {
  const store = new Map();
  const expires = new Map(); // key -> seconds (TTLが設定されたことの記録)
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") {
      const [k, v, ...rest] = args;
      if (rest.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      const exIdx = rest.indexOf("EX");
      if (exIdx !== -1) expires.set(k, Number(rest[exIdx + 1]));
      return "OK";
    }
    if (op === "EXPIRE") { if (store.has(args[0])) { expires.set(args[0], Number(args[1])); return 1; } return 0; }
    if (op === "DEL") { const had = store.delete(args[0]); return had ? 1 : 0; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "INCRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c + parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") {
      // 実Redisと同じ端の解釈: 変換後もstopが負なら空(範囲外の負指定は空を返す)
      const [k, s, e] = args; const l = store.get(k) || [];
      let st = parseInt(s, 10), en = parseInt(e, 10);
      if (st < 0) st = Math.max(0, l.length + st);
      if (en < 0) en = l.length + en;
      if (en >= l.length) en = l.length - 1;
      if (en < 0 || st > en) return [];
      return l.slice(st, en + 1);
    }
    if (op === "LREM") { const [k, , v] = args; store.set(k, (store.get(k) || []).filter((x) => x !== v)); return 1; }
    if (op === "LTRIM") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; store.set(k, l.slice(st, en + 1)); return "OK"; }
    return null;
  }
  async function upstashGetJSON(k) { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); }
  async function upstashSetJSON(k, v) { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; }
  return { store, expires, upstashCmd, upstashGetJSON, upstashSetJSON };
}

async function main() {
  console.log("=== 欠陥1(High): 延長・PK決着の試合が永久に未解決だった ===");

  await ok("PEN(PK決着)の試合が90分スコアで解決され、キューから外れる", async () => {
    const mock = createMockRedis();
    // 保留中の予測を仕込む(PKまで行った試合)
    await mock.upstashSetJSON("learn:ownpred:8001", {
      fixtureId: 8001, predictedWinner: "draw", homeLambda: 1.2, awayLambda: 1.2,
      features: { formDiff: 0 }, weightsSnapshot: { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.1 },
      resolved: false, homeTeamEn: "A", awayTeamEn: "B", originTeamEn: "A",
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", "8001"]);
    const api = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id) {
        return { response: [{
          fixture: { id: 8001, date: "2026-08-19T18:00:00Z", status: { short: "PEN" } },
          teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
          goals: { home: 2, away: 2 },              // 延長込みのスコア
          score: { fulltime: { home: 1, away: 1 } }, // 90分時点のスコア
          league: { id: 39 },
        }] };
      }
      return { response: [] };
    };
    const r = await runDailyLearning({ callApiFootball: api, resolveTeamId: async () => null, upstashEnabled: true, ...mock, now: () => new Date("2026-08-20T03:00:00Z") });
    assert.strictEqual(r.matchesResolvedToday, 1, "PK決着の試合が解決されるはず");
    const rec = await mock.upstashGetJSON("learn:ownpred:8001");
    assert.strictEqual(rec.resolved, true);
    assert.strictEqual(rec.actualWinner, "draw", "採点は90分時点のスコア(1-1=引き分け)で行う");
    assert.deepStrictEqual(rec.actualScore, { home: 1, away: 1 });
    assert.strictEqual(rec.finishedStatus, "PEN", "PK決着だったことを正直に記録");
    const pending = await mock.upstashCmd(["LRANGE", "learn:ownpred:pending", "0", "-1"]);
    assert.ok(!pending.includes("8001"), "キューから外れて詰まりを起こさない");
    assert.ok(mock.expires.has("learn:ownpred:8001"), "解決済みレコードにTTLが付く(無限成長の防止)");
  });

  console.log("=== 欠陥2(High): 解決処理の多重実行ロック ===");

  await ok("別プロセスがロック保持中の試合は解決をスキップする(二重計上の防止)", async () => {
    const mock = createMockRedis();
    await mock.upstashSetJSON("learn:ownpred:8002", {
      fixtureId: 8002, predictedWinner: "home", homeLambda: 2, awayLambda: 1,
      features: { formDiff: 1 }, resolved: false, homeTeamEn: "A", awayTeamEn: "B",
    });
    await mock.upstashCmd(["RPUSH", "learn:ownpred:pending", "8002"]);
    // 別プロセスがロックを保持している状態を再現
    await mock.upstashCmd(["SET", "learn:ownpred:resolvelock:8002", "other-process", "NX", "EX", "3600"]);
    let fixtureApiCalls = 0;
    const api = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.id) { fixtureApiCalls++; return { response: [] }; }
      return { response: [] };
    };
    const r = await runDailyLearning({ callApiFootball: api, resolveTeamId: async () => null, upstashEnabled: true, ...mock, now: () => new Date("2026-08-20T03:00:00Z") });
    assert.strictEqual(r.matchesResolvedToday, 0, "ロック中は解決しない");
    assert.strictEqual(fixtureApiCalls, 0, "ロック中はAPIも呼ばない(予算節約)");
    const resolvedCount = await mock.upstashCmd(["GET", "learn:ownpred:resolved"]);
    assert.ok(!resolvedCount || resolvedCount === "0", "カウンタが二重INCRされない");
  });

  console.log("=== 欠陥3(Medium): 同日複数回実行での成長ログの壊れ ===");

  await ok("weightsUpdated=trueが同日の後続実行(false)で消えない", () => {
    const run1 = { date: "2026-08-20", ranAt: "2026-08-20T03:00:00Z", weightsUpdated: true, weightsUpdatedV2: true, v2AccuracyBefore: 50, v2AccuracyAfter: 60, aiViewsChanged: 2, aiViewsUnchanged: 9, errors: [] };
    const run2 = { date: "2026-08-20", ranAt: "2026-08-20T09:00:00Z", weightsUpdated: false, weightsUpdatedV2: false, v2AccuracyBefore: null, v2AccuracyAfter: null, aiViewsChanged: 2, aiViewsUnchanged: 9, errors: [] };
    const merged = mergeGrowthLogs(run1, run2);
    assert.strictEqual(merged.weightsUpdated, true, "その日一度でも更新されていればtrueを保持");
    assert.strictEqual(merged.weightsUpdatedV2, true);
    assert.strictEqual(merged.v2AccuracyAfter, 60, "採用時の的中率も保持");
    assert.strictEqual(merged.aiViewsUnchanged, 9, "同じクラブの数え直しはsumせずmax(14回実行で154に水増ししない)");
  });

  console.log("=== 欠陥4(Medium): 「今日の新規知識」の日付基準ズレ(JST) ===");

  await ok("日本時間の朝4時(UTC前日19時)に保存した知識が「今日の新規」に数えられる", async () => {
    const mock = createMockRedis();
    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    // UTCでは2026-08-19T19:05(=日本時間2026-08-20 04:05)に保存された知識
    await ks.saveKnowledgeItem({
      teamEn: "Arsenal", teamJa: "アーセナル", category: "recentFormTrend", type: "fact",
      statement: "テスト用の事実です。", computedAt: "2026-08-19T19:05:00.000Z",
    });
    const diff = await ks.getKnowledgeDiffForTeam("Arsenal", "2026-08-20", Date.parse("2026-08-19T19:10:00Z"));
    assert.strictEqual(diff.newItems.length, 1, "JST基準のdateKey(2026-08-20)で新規1件と数えられるはず");
  });

  console.log("=== 欠陥5(Low→重要): 重み読み取り失敗時の正直な見送り ===");

  await ok("learn:weightsを読めない日は初期重みで予測せず、理由を記録して見送る", async () => {
    const mock = createMockRedis();
    const failingCmd = async (cmd) => {
      if (cmd[0] === "GET" && cmd[1] === "learn:weights") throw new Error("upstash timeout");
      return mock.upstashCmd(cmd);
    };
    const api = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.next) {
        return { response: [{
          fixture: { id: 9100, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } },
          teams: { home: { id: 100, name: "Home FC" }, away: { id: 2, name: "Away FC" } },
          goals: { home: null, away: null }, league: { id: 39, season: 2026 },
        }] };
      }
      if (endpoint === "/fixtures" && params.last) {
        const now = Date.now();
        return { response: Array.from({ length: 10 }, (_, i) => ({
          fixture: { id: 1000 + i, date: new Date(now - i * 86400e3).toISOString(), status: { short: "FT" } },
          teams: { home: { id: 100 }, away: { id: 2 } }, goals: { home: 2, away: 0 },
        })) };
      }
      return { response: [] };
    };
    const r = await runDailyLearning({
      callApiFootball: api, resolveTeamId: async () => 100,
      upstashEnabled: true, ...mock, upstashCmd: failingCmd,
      now: () => new Date("2026-08-20T03:00:00Z"),
    });
    assert.strictEqual(r.newPredictionsLogged, 0, "読み取り失敗時は予測を記録しない");
    assert.ok((r.errors || []).some((e) => String(e).includes("weights_read_failed_prediction_skipped")), "見送った理由が記録される: " + JSON.stringify((r.errors || []).slice(0, 3)));
  });

  console.log("=== 欠陥6(Medium): 宇宙収集の同日再実行ガード ===");

  function makeUniverseApi() {
    const calls = [];
    const teamIdOf = (name) => 1000 + [...String(name)].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    const callApiFootball = async (apiPath, params) => {
      calls.push(apiPath);
      if (apiPath === "/teams") return { response: [{ team: { id: teamIdOf(params.search), name: params.search, founded: 1900, country: "X" }, venue: {} }] };
      if (apiPath === "/fixtures") return { response: [] };
      if (apiPath === "/injuries") return { response: [] };
      if (apiPath === "/transfers") return { response: [] };
      if (apiPath === "/players/squads") return { response: [{ players: [{ id: params.team * 10 + 1, name: `P${params.team}`, age: 25, number: 7, position: "Attacker" }] }] };
      if (apiPath === "/players") return { response: [] };
      return { response: [] };
    };
    return { callApiFootball, calls };
  }

  await ok("同じ日の2回目の実行は、コア更新・名簿の再取得を見送る(選手詳細だけ続行)", async () => {
    const up = createMockRedis();
    const dossier = createClubDossier({ upstashEnabled: true, ...up });
    const deps = (api) => ({
      callApiFootball: api.callApiFootball, apiBudget: { remainingForJob: () => 999999 },
      clubDossier: dossier, knowledgeStore: null, knowledgeGraph: null, thoughtTimeline: null,
      computeFormScore: () => ({ currentFormScore: null, delta: null, sampleSize: 0 }),
      recordLearned: async () => {},
      upstashCmd: up.upstashCmd, upstashGetJSON: up.upstashGetJSON, upstashSetJSON: up.upstashSetJSON,
    });
    const api1 = makeUniverseApi();
    const run1 = await collectUniverse(deps(api1), new Date("2026-08-20T00:10:00Z"), "2026-08-20");
    assert.ok(run1.coreClubsPlanned > 0, "1回目はコア更新が計画される");
    assert.ok(up.store.has("kb:universe:ran:2026-08-20"), "実施記録が保存される");
    assert.ok(up.expires.has("kb:universe:ran:2026-08-20"), "実施記録にTTLが付く");
    const api2 = makeUniverseApi();
    const run2 = await collectUniverse(deps(api2), new Date("2026-08-20T06:10:00Z"), "2026-08-20");
    assert.strictEqual(run2.coreClubsPlanned, 0, "2回目はコア更新を計画しない");
    assert.strictEqual(run2.sameDayRerun, true);
    assert.ok(run2.skipped.some((s) => s.reasonJa.includes("収集済み")), "見送り理由を正直に記録");
    const coreCalls2 = api2.calls.filter((p) => p === "/fixtures" || p === "/injuries" || p === "/transfers").length;
    assert.strictEqual(coreCalls2, 0, "2回目はコア系APIを一切呼ばない(予算浪費の防止)");
  });

  console.log("=== 欠陥7(Critical): 選手詳細の全件読みをやめ索引1キーにする ===");

  await ok("選手の輪番が候補全員のgetPlayerではなく索引(kb:player:statsIndex)で決まる", async () => {
    const up = createMockRedis();
    const dossier = createClubDossier({ upstashEnabled: true, ...up });
    // 名簿を事前投入(2クラブ×2人)。squadセクションを直接作る。
    await dossier.updateSection("Real Madrid", "squad", { players: [{ id: 11, name: "P11" }, { id: 12, name: "P12" }], count: 2 }, { nameJa: "レアル・マドリード", teamId: 541 });
    await dossier.updateSection("Arsenal", "squad", { players: [{ id: 21, name: "P21" }, { id: 22, name: "P22" }], count: 2 }, { nameJa: "アーセナル", teamId: 42 });
    let getPlayerCalls = 0;
    const wrappedDossier = { ...dossier, getPlayer: async (id) => { getPlayerCalls++; return dossier.getPlayer(id); } };
    const api = makeUniverseApi();
    // 選手詳細APIだけ実応答を返す
    api.callApiFootball = ((orig) => async (p, q) => {
      if (p === "/players" && q.id) {
        return { response: [{ player: { id: q.id, name: `P${q.id}`, nationality: "X", height: null, birth: {} }, statistics: [{ games: { appearences: 10, minutes: 900, rating: "7.0", position: "Attacker" }, goals: { total: 5, assists: 2 }, passes: {}, dribbles: {}, tackles: {}, duels: {} }] }] };
      }
      // 名簿輪番(stage③)がテスト用に仕込んだsquadを上書きしないようにする
      if (p === "/players/squads") return { response: [] };
      return orig(p, q);
    })(api.callApiFootball);
    process.env.UNIVERSE_PLAYER_CAP_TEST = "";
    const deps = {
      callApiFootball: api.callApiFootball, apiBudget: { remainingForJob: () => 999999 },
      clubDossier: wrappedDossier, knowledgeStore: null, knowledgeGraph: null, thoughtTimeline: null,
      computeFormScore: () => ({ currentFormScore: null, delta: null, sampleSize: 0 }),
      recordLearned: async () => {},
      upstashCmd: up.upstashCmd, upstashGetJSON: up.upstashGetJSON, upstashSetJSON: up.upstashSetJSON,
    };
    const run = await collectUniverse(deps, new Date("2026-08-21T00:10:00Z"), "2026-08-21");
    assert.strictEqual(getPlayerCalls, 0, `輪番決定のためのgetPlayer全件読みが廃止されている(実際: ${getPlayerCalls}回)`);
    assert.ok(run.playersUpdated >= 4, "選手詳細は保存されている");
    const idx = await up.upstashGetJSON("kb:player:statsIndex");
    assert.ok(idx && idx["11"] && idx["21"], "索引に更新時刻が記録される");
  });

  console.log("=== 欠陥8(High): 知識の孤児キー掃除 ===");

  await ok("一覧の上限(80件)から溢れた知識は、本体キーごと削除される", async () => {
    const mock = createMockRedis();
    const ks = createKnowledgeStore({ upstashEnabled: true, ...mock });
    for (let i = 0; i < 82; i++) {
      await ks.saveKnowledgeItem({
        teamEn: "Chelsea", teamJa: "チェルシー", category: "recentFormTrend", type: "fact",
        statement: `テスト事実その${i}です。`, computedAt: "2026-08-20T00:00:00.000Z",
      });
    }
    const list = await mock.upstashCmd(["LRANGE", "knowledge:byTeam:Chelsea", "0", "-1"]);
    assert.ok(list.length <= 80, `一覧は80件上限のはず(実際: ${list.length})`);
    // 本体キーの数 = 一覧に残っている数(孤児が無い)
    const itemKeys = [...mock.store.keys()].filter((k) => k.startsWith("knowledge:item:"));
    assert.strictEqual(itemKeys.length, list.length, `溢れた本体キーが削除される(本体${itemKeys.length}件 vs 一覧${list.length}件)`);
  });

  console.log("=== 設定の確認(コード検査) ===");

  await ok("「本日の試合」はtimezone=Asia/Tokyoで取得し、cron経由はjobCall計上", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "..", "server", "server.js"), "utf8");
    assert.ok(src.includes('timezone: "Asia/Tokyo"'), "fixturesの取得が日本時間の1日と一致する");
    assert.ok(/handleFixturesToday\(new URLSearchParams\(\), \{ jobCall: true \}\)/.test(src), "auto-collectのフェーズ2がjobCall計上");
    assert.ok(src.includes("llm:budget:"), "LLM全体上限がUpstashへ永続化(スリープでリセットされない)");
    assert.ok(src.includes("learn:forceruns:"), "force実行回数がUpstashへ永続化");
    // 2026-09-02監査での更新: 8/7に実行ロックは90分へ正当延長された(README第21節:
  // 30分では学習の所要時間約40分より短かった)。audit8本来の意図「30分未満へ
  // 縮めない」を保ちつつ、現行の定数を読んで検証する。
  {
    const lockM = src.match(/DAILY_RUN_LOCK_SECONDS\)\s*\|\|\s*(\d+)/);
    assert.ok(lockM && Number(lockM[1]) >= 1800,
      `実行ロックの既定は30分以上のはず(現行: ${lockM && lockM[1]}秒)`);
  }
    assert.ok(src.includes('e.code === "API_ERROR" || e.code === "NO_KEY"'), "クォータ超過・キー未設定を「選手が存在しない」と誤キャッシュしない");
  });

  console.log(`\n結果: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
