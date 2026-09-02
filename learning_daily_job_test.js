/**
 * server/learning/dailyJob.js の runDailyLearning() / getGrowthLog() 統合テスト。
 * 実際のUpstash Redisの代わりに、同じコマンド体系(GET/SET/INCR/RPUSH/LRANGE/
 * LREM/LTRIM)を実装したインメモリのモックを使う。API-Footballも固定の
 * モックレスポンスを返す(このサンドボックスは実サービスに到達できないため)。
 */
const assert = require("assert");
const { runDailyLearning, getGrowthLog, REGISTERED_TEAMS, OWN_PREDICT_LOG_CAP } = require("../server/learning/dailyJob");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

// ---- インメモリRedis風モック ----
function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") {
      const [key, value, flag] = args;
      if (flag === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }
    if (op === "INCR") {
      const cur = parseInt(store.get(args[0]), 10) || 0;
      store.set(args[0], String(cur + 1));
      return cur + 1;
    }
    if (op === "RPUSH") {
      const [key, val] = args;
      const list = store.get(key) || [];
      list.push(val);
      store.set(key, list);
      return list.length;
    }
    if (op === "LRANGE") {
      const [key, startS, endS] = args;
      const list = store.get(key) || [];
      let start = parseInt(startS, 10), end = parseInt(endS, 10);
      if (start < 0) start = Math.max(0, list.length + start);
      if (end < 0) end = list.length + end;
      return list.slice(start, end + 1);
    }
    if (op === "LREM") {
      const [key, , val] = args;
      const list = store.get(key) || [];
      store.set(key, list.filter((v) => v !== val));
      return 1;
    }
    if (op === "LTRIM") {
      const [key, startS, endS] = args;
      const list = store.get(key) || [];
      let start = parseInt(startS, 10), end = parseInt(endS, 10);
      if (start < 0) start = Math.max(0, list.length + start);
      if (end < 0) end = list.length + end;
      store.set(key, list.slice(start, end + 1));
      return "OK";
    }
    throw new Error("mock does not implement: " + op);
  }
  async function upstashGetJSON(key) {
    const raw = await upstashCmd(["GET", key]);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  }
  async function upstashSetJSON(key, value) {
    await upstashCmd(["SET", key, JSON.stringify(value)]);
    return true;
  }
  return { upstashCmd, upstashGetJSON, upstashSetJSON, store };
}

// ---- API-Footballモック ----
// チームごとに固定の「フォーム」を割り当てる: teamId 1000番台=好調(直近5試合で勝ち越し)、
// それ以外は五分。/fixtures?next=1 では常に「未登録の対戦相手」との対戦を返す。
let fakeTeamIdCounter = 1000;
const teamIdByName = new Map();
function makeTeamId(nameEn) {
  if (!teamIdByName.has(nameEn)) { teamIdByName.set(nameEn, fakeTeamIdCounter++); }
  return teamIdByName.get(nameEn);
}
async function resolveTeamId(nameEn) { return makeTeamId(nameEn); }

function makeFixtureList(teamId, n, dateBase) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      fixture: { id: 5000 + teamId * 100 + i, date: new Date(dateBase - i * 86400e3).toISOString(), status: { short: "FT" } },
      teams: { home: { id: teamId, name: "T" + teamId }, away: { id: 9999, name: "Opponent" } },
      goals: { home: 2, away: 1 }, // 常に得失点差+1(全チーム共通なのでdeltaは0=事実は生成されない設計)
    });
  }
  return list;
}

async function callApiFootball(endpoint, params) {
  if (endpoint === "/fixtures" && params.team && params.last) {
    return { response: makeFixtureList(params.team, params.last, Date.now()) };
  }
  if (endpoint === "/fixtures" && params.team && params.next) {
    const fixtureId = 8000 + params.team;
    return { response: [{ fixture: { id: fixtureId, date: new Date(Date.now() + 86400e3).toISOString(), status: { short: "NS" } }, teams: { home: { id: params.team, name: "T" + params.team }, away: { id: 42, name: "RivalFC" } }, goals: { home: null, away: null } }] };
  }
  if (endpoint === "/fixtures" && params.id) {
    // このテストでは「まだ終わっていない」ことにして解決フェーズをスキップさせる
    return { response: [{ fixture: { id: Number(params.id), status: { short: "NS" } }, goals: { home: null, away: null } }] };
  }
  return { response: [] };
}

(async () => {
  await test("runDailyLearning: Upstash未設定なら正直にNO_UPSTASHを返す", async () => {
    const result = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: false, upstashCmd: async () => null, upstashGetJSON: async () => null, upstashSetJSON: async () => false });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "NO_UPSTASH");
  });

  await test("runDailyLearning: 登録チーム全てを分析し、新しい自社予測を記録する", async () => {
    const mock = createMockRedis();
    const result = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.teamsAnalyzed, REGISTERED_TEAMS.length);
    assert.ok(result.newPredictionsLogged > 0, "新しい予測が記録されているはず、実際: " + result.newPredictionsLogged);
    // 2026-09-02監査での更新: 上限は5→20(8/6)→公開前90(v80)と正当に進化した。
    // 固定値でなく現行のexport値を参照する(仕様が変わればテストも自動で追随)。
    assert.ok(result.newPredictionsLogged <= OWN_PREDICT_LOG_CAP, `1回の実行での新規予測は上限${OWN_PREDICT_LOG_CAP}件のはず`);
    const total = await mock.upstashGetJSON.call ? null : null;
  });

  await test("runDailyLearning: 全登録チーム分を記録し終えたら、それ以上は重複記録しない(冪等性)", async () => {
    // 1回の実行では上限5件までしか新規記録しない設計なので、登録チーム数(11)を
    // 使い切るまで複数回実行してから、その後の実行で新規0件になることを確認する。
    //
    // 2026年8月・本番バグ修正(growthLogの同日合算)に伴う注記: このテストは
    // 全て同じ日付("2026-08-01")内で複数回実行するため、修正後はgrowthLogの
    // newPredictionsLoggedが「その日の累計」になる(=1回1回の新規0件がその日の
    // 合計に上書きされて消えるという、まさに今回の本番バグを防ぐための仕様変更)。
    // そのため「戻り値が0件になる」ではなく、「直前の実行から増えていない
    // (=このラウンドでは新規に何も追加されていない)」ことと、実際に永続化された
    // 件数(learn:ownpred:total、Redisの生データ)が変化していないことの両方で
    // 冪等性を検証する。
    const mock = createMockRedis();
    const rounds = Math.ceil(REGISTERED_TEAMS.length / 5) + 1; // 余裕を持って+1周
    let lastRoundResult = null;
    for (let i = 0; i < rounds; i++) {
      lastRoundResult = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    }
    const totalBefore = parseInt(await mock.upstashCmd(["GET", "learn:ownpred:total"]), 10) || 0;
    const extra = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T09:00:00Z") });
    const totalAfter = parseInt(await mock.upstashCmd(["GET", "learn:ownpred:total"]), 10) || 0;
    assert.strictEqual(
      extra.newPredictionsLogged, lastRoundResult.newPredictionsLogged,
      `全登録チーム分を記録し終えた後は、その日の累計が直前の実行から増えないはず. got lastRound=${lastRoundResult.newPredictionsLogged} extra=${extra.newPredictionsLogged}`
    );
    assert.strictEqual(totalBefore, totalAfter, "同じ未来の試合に対して二重に予測を記録してはいけない(永続化された実件数で検証)");
  });

  await test("runDailyLearning: 得失点差に有意な変化がある場合だけ事実として記録する(閾値未満は記録しない)", async () => {
    const mock = createMockRedis();
    // このモックのcallApiFootballは全試合で得失点差+1固定 → 直近5 = 前5 → delta=0 → 事実は生成されないはず
    const result = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.factsAddedToday, 0, "得失点差の変化が無いのに事実を作ってはいけない(架空の変化をでっち上げない)");
  });

  await test("runDailyLearning: フォームが実際に変化しているチームには正しく事実を生成する", async () => {
    const mock = createMockRedis();
    let call = 0;
    const customApiFootball = async (endpoint, params) => {
      if (endpoint === "/fixtures" && params.team && params.last) {
        call++;
        // 最初に呼ばれるチーム(バイエルン想定)だけ、直近5試合を高得点勝利、前5試合を大敗にする
        if (call === 1) {
          const list = [];
          const now = Date.now();
          for (let i = 0; i < 5; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 4, away: 0 } });
          for (let i = 5; i < 10; i++) list.push({ fixture: { id: 1 + i, date: new Date(now - i * 86400e3).toISOString() }, teams: { home: { id: params.team }, away: { id: 2 } }, goals: { home: 0, away: 3 } });
          return { response: list };
        }
        return { response: makeFixtureList(params.team, params.last, Date.now()) };
      }
      return callApiFootball(endpoint, params);
    };
    const result = await runDailyLearning({ callApiFootball: customApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.ok(result.factsAddedToday >= 1, "少なくとも1件、実際のフォーム変化に基づく事実が記録されるはず");
    assert.ok(result.facts[0].statement.includes(REGISTERED_TEAMS[0].nameJa), "事実の文言に対象クラブ名が含まれるはず");
  });

  await test("getGrowthLog: 実行前はranYet:falseを正直に返す", async () => {
    const mock = createMockRedis();
    const log = await getGrowthLog({ upstashEnabled: true, ...mock });
    assert.strictEqual(log.ranYet, false);
  });

  await test("getGrowthLog: 実行後は最新の成長ログを返す", async () => {
    const mock = createMockRedis();
    await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    const log = await getGrowthLog({ upstashEnabled: true, ...mock });
    assert.strictEqual(log.ranYet, true);
    assert.strictEqual(log.date, "2026-08-01");
  });

  await test("runDailyLearning: 検証データが閾値(10件)未満の間は、重みの再調整を行わない", async () => {
    const mock = createMockRedis();
    const result = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-01T03:00:00Z") });
    assert.strictEqual(result.weightsUpdated, false, "検証データが十分に無いのにモデルを更新してはいけない(過学習防止)");
  });

  await test("runDailyLearning: 実データで的中率が本当に改善する場合だけモデルを更新する(悪化する変更は採用しない)", async () => {
    const mock = createMockRedis();
    // 「ホームフォームが高いほどホームが勝つ」という一貫した実データを20件仕込む。
    // 現在の重み(sensitivity低め)より、sensitivityを上げた方が的中率が上がるはずのデータ。
    const records = [];
    for (let i = 0; i < 20; i++) {
      const homeFormScore = 3, awayFormScore = -3; // 大差でホームが好調
      records.push({ fixtureId: 9000 + i, homeFormScore, awayFormScore, predictedWinner: "home", actualWinner: "home", resolved: true });
    }
    await mock.upstashCmd(["SET", "learn:ownpred:resolved", "20"]);
    await mock.upstashCmd(["SET", "learn:ownpred:correct", "20"]);
    for (const r of records) await mock.upstashCmd(["RPUSH", "learn:ownpred:recent", JSON.stringify(r)]);
    // わざと「今の重みではあまり自信を持てない(sensitivityが低すぎて僅差にしかならない)」
    // 状態を作る: 現在の重みでは一部が引き分け判定になってしまうよう調整
    await mock.upstashSetJSON("learn:weights", { homeBase: 1.0, awayBase: 1.0, sensitivity: 0.02, version: 0, updatedAt: null });

    const result = await runDailyLearning({ callApiFootball, resolveTeamId, upstashEnabled: true, ...mock, now: () => new Date("2026-08-02T03:00:00Z") });
    const history = (await mock.upstashCmd(["LRANGE", "learn:weights:history", "0", "-1"])).map((s) => JSON.parse(s));
    assert.ok(history.length >= 1, "再調整の判断結果(採用/不採用いずれか)が履歴に残っているはず");
    const last = history[history.length - 1];
    assert.ok("adopted" in last, "履歴には採用有無が記録されているはず");
    if (last.adopted) {
      assert.ok(last.newAccuracy > last.oldAccuracy, "採用する場合は新しい重みの的中率が既存より本当に高いはず");
    }
  });

  console.log(failures === 0 ? "\nAll daily-job integration tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
