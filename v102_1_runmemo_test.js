"use strict";
/**
 * v102.1(2026年11月18日)・本番の最初の学習の実測を受けた小さな修正の検証
 * ----------------------------------------------------------------------------
 *   本番(11/18・v102 での最初の学習)の記録で、過去試合を取り直した日の「重みの検証の直前」の使用量が、
 *   この環境での実測より約55MB多かった(Node が使っている量 152MB / 上限 268MB。検証は走り切った)。
 *   原因: 毎日の学習の「実行中の記憶(runMemo)」が、④-b の取り直し(31大会×5シーズン = 155回)の応答を、
 *   1回しか使わないのに学習の終わりまで全部抱えていた(/fixtures を記憶の対象にしているため)。
 *   → ④-b には、記憶を通さない呼び出しを渡す。
 *
 *   ここで確かめること:
 *     1. ④-b の取り直しとリーグの照合は、実行中の記憶を通らない(記憶に数えられない・抱えられない)
 *     2. 取得するもの・回数・学習データは変わらない(同じ問い合わせを2回出さない)
 *     3. ほかの段階の重複の節約(実行中の記憶)は、これまでどおり働く
 *     4. 記録に「記憶が抱えていた応答の数(entries)」が残り、同じ日の再実行では多いほうを残す
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const S = __dirname;
const hb = require(path.join(S, "learning", "historicalBackfill.js"));
const dj = require(path.join(S, "learning", "dailyJob.js"));

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

// 毎日の学習が「実行中の記憶」の対象にしている問い合わせ先(learning/dailyJob.js の RUN_MEMO_ENDPOINTS と同じ並び。食い違えば下の検査1が落ちる)
const MEMO_ENDPOINTS = ["/standings", "/players/topscorers", "/players/topassists", "/injuries", "/fixtures/statistics", "/fixtures/headtohead",
  "/teams", "/players/squads", "/leagues", "/coachs", "/fixtures/lineups", "/fixtures"];
const keysOf = (p) => Object.keys(p || {}).sort().join(",");
const isSeasonFetch = (c) => c[0] === "/fixtures" && keysOf(c[1]) === "league,season";
const isLeagueCheck = (c) => c[0] === "/leagues" && keysOf(c[1]) === "id";

/** 提供元の模擬。呼ばれた問い合わせをすべて控える。従来の15大会だけ試合を返す(足した16リーグは「見つからない」) */
function createFakeApi() {
  const calls = [];
  const teamsOf = (leagueId) => [1, 2, 3, 4, 5, 6].map((k) => leagueId * 100 + k);
  async function callApiFootball(endpoint, params) {
    calls.push([endpoint, { ...(params || {}) }]);
    if (endpoint === "/fixtures" && params && params.league && params.season && keysOf(params) === "league,season") {
      const ids = teamsOf(params.league); const out = []; let n = 0;
      for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        n++;
        const date = new Date(Date.UTC(params.season, hb.CALENDAR_YEAR_LEAGUE_IDS.has(params.league) ? 2 : 7, 1) + n * 3 * 86400000).toISOString();
        out.push({ fixture: { id: params.league * 1000000 + (params.season % 100) * 10000 + n, date, status: { short: "FT" } },
          teams: { home: { id: ids[i], name: `T${ids[i]}` }, away: { id: ids[j], name: `T${ids[j]}` } },
          goals: { home: (i * 3 + j + n) % 4, away: (j * 2 + i + n) % 3 } });
      }
      return { response: out };
    }
    return { response: [] };
  }
  return { calls, callApiFootball };
}
/** 毎日の学習が使う命令をひととおり持つ、保存先の模擬 */
function createFullMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "MGET") return args.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { const [k, v, ...rest] = args; if (rest.includes("NX") && store.has(k)) return null; store.set(k, v); return "OK"; }
    if (op === "EXPIRE") return store.has(args[0]) ? 1 : 0;
    if (op === "DEL") return store.delete(args[0]) ? 1 : 0;
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "INCRBY") { const c = parseInt(store.get(args[0]), 10) || 0; const n = c + parseInt(args[1], 10); store.set(args[0], String(n)); return n; }
    if (op === "RPUSH" || op === "LPUSH") { const [k, ...vs] = args; const l = store.get(k) || []; for (const v of vs) { if (op === "RPUSH") l.push(v); else l.unshift(v); } store.set(k, l); return l.length; }
    if (op === "LLEN") return (store.get(args[0]) || []).length;
    if (op === "LRANGE") {
      const [k, s0, e0] = args; const l = store.get(k) || [];
      let st = parseInt(s0, 10), en = parseInt(e0, 10);
      if (st < 0) st = Math.max(0, l.length + st);
      if (en < 0) en = l.length + en;
      if (en >= l.length) en = l.length - 1;
      if (en < 0 || st > en) return [];
      return l.slice(st, en + 1);
    }
    if (op === "LREM") { const [k, , v] = args; store.set(k, (store.get(k) || []).filter((x) => x !== v)); return 1; }
    if (op === "LTRIM") {
      const [k, s0, e0] = args; const l = store.get(k) || [];
      let st = parseInt(s0, 10), en = parseInt(e0, 10);
      if (st < 0) st = Math.max(0, l.length + st);
      if (en < 0) en = l.length + en;
      store.set(k, l.slice(st, en + 1)); return "OK";
    }
    return null;
  }
  const upstashGetJSON = async (k) => { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  return { store, upstashCmd, upstashGetJSON, upstashSetJSON };
}

(async () => {
  console.log("■ 1. ④-b には、実行中の記憶を通さない呼び出しを渡している");
  const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
  await t("過去試合によるモデル調整(tuneModelOnHistory)に渡すのは、記憶を通さない呼び出し(rawCallApiFootball)", () => {
    const m = src.match(/const tuneDeps = \{([^}]*)\};\s*\n\s*modelTuning = await tuneModelOnHistory\(tuneDeps, baseForTune, runAt, \{ dateKey, guardRecords \}\);/);
    assert.ok(m, "呼び出しの形が変わっている");
    assert.strictEqual((src.match(/tuneModelOnHistory\(/g) || []).length, 1, "毎日の学習が、過去試合によるモデル調整を呼ぶ場所は1つだけ");
    assert.ok(/callApiFootball: rawCallApiFootball,/.test(m[1]), "記憶を通す呼び出しのまま: " + m[1].slice(0, 200));
    assert.ok(/apiBudget,/.test(m[1]) && /heartbeat,/.test(m[1]), "予算と進捗の通知は、これまでどおり渡す");
    // 記憶の対象は変えていない(ほかの段階の節約はそのまま)
    const set = src.match(/const RUN_MEMO_ENDPOINTS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(set, "RUN_MEMO_ENDPOINTS が見つからない");
    const listed = [...set[1].matchAll(/"(\/[^"]+)"/g)].map((x) => x[1]);
    assert.deepStrictEqual(listed, MEMO_ENDPOINTS, "記憶の対象の並びが、このテストの控えと違う");
  });
  await t("④-b の中で提供元を呼ぶのは「リーグの照合」と「1シーズンぶんの取得」だけ(どちらも1回の実行で同じ問い合わせを繰り返さない)", () => {
    const hbSrc = fs.readFileSync(path.join(S, "learning", "historicalBackfill.js"), "utf8");
    const mtSrc = fs.readFileSync(path.join(S, "learning", "modelTuning.js"), "utf8");
    const hbCalls = [...hbSrc.matchAll(/await callApiFootball\(("[^"]+"),\s*(\{[^}]*\})/g)].map((x) => `${x[1]} ${x[2]}`);
    assert.deepStrictEqual(hbCalls, ['"/leagues" { id: l.id }', '"/fixtures" { league: leagueId, season }']);
    assert.ok(!/callApiFootball\(/.test(mtSrc), "modelTuning.js が提供元を直接呼ぶようになっている(記憶を通さなくてよいか確かめること)");
    // 同じ形(リーグ+シーズンだけ)の問い合わせを、ほかの段階は出していない(= 記憶を通さなくても、節約を失わない)
    for (const f of fs.readdirSync(path.join(S, "learning")).filter((x) => x.endsWith(".js") && x !== "historicalBackfill.js")) {
      const body = fs.readFileSync(path.join(S, "learning", f), "utf8");
      assert.ok(!/callApiFootball\(\s*"\/fixtures",\s*\{\s*league:[^,}]+,\s*season:?[^,}]*\}/.test(body), `${f} が、1シーズンぶんの取得と同じ形の問い合わせを出している`);
      assert.ok(!/callApiFootball\(\s*"\/leagues",\s*\{\s*id:/.test(body), `${f} が、リーグの照合と同じ形の問い合わせを出している`);
    }
  });

  console.log("■ 2. 毎日の学習(runDailyLearning)を実際にまわす");
  const RUN = new Date("2026-11-18T01:36:00.000Z");
  const mock = createFullMockRedis();
  const api = createFakeApi();
  let first = null;
  await t("過去試合を取り直す日: 取り直しの応答とリーグの照合は、実行中の記憶に数えられない(= 抱えられない)。学習データはこれまでどおり作られる", async () => {
    first = await dj.runDailyLearning({ callApiFootball: api.callApiFootball, resolveTeamId: async () => null, upstashEnabled: true, ...mock, now: () => RUN });
    hb.setActivatedLeagues([]);
    const seasonFetches = api.calls.filter(isSeasonFetch), leagueChecks = api.calls.filter(isLeagueCheck);
    // 従来の15大会×5シーズン。同じ問い合わせを2回出していない
    assert.strictEqual(seasonFetches.length, 75, `1シーズンぶんの取得が ${seasonFetches.length} 回`);
    assert.strictEqual(new Set(seasonFetches.map((c) => JSON.stringify(c[1]))).size, 75, "同じシーズンを2回取りに行っている");
    assert.strictEqual(leagueChecks.length, 16); assert.strictEqual(new Set(leagueChecks.map((c) => c[1].id)).size, 16);
    const memoEligible = api.calls.filter((c) => MEMO_ENDPOINTS.includes(c[0])).length;
    const memo = first.apiRunMemo;
    assert.ok(memo && Number.isFinite(memo.misses) && Number.isFinite(memo.hits) && Number.isFinite(memo.entries), JSON.stringify(memo));
    // 提供元に届いた「記憶の対象の問い合わせ」=(記憶を通って初めて出たもの)+(記憶を通らなかったもの)
    assert.strictEqual(memoEligible - memo.misses, 75 + 16, `記憶を通らなかった問い合わせは ${memoEligible - memo.misses} 件(取り直し75+照合16 = 91 のはず)`);
    assert.strictEqual(memo.entries, memo.misses, "失敗の無い実行では、記憶が抱える数 = 初めて出た問い合わせの数");
    // 学習データ
    const tune = first.modelTuning;
    assert.ok(tune && tune.datasetSize > 1500, JSON.stringify(tune && { n: tune.datasetSize, r: tune.reasonJa }));
    assert.strictEqual(tune.leaguesInDataset, 15);
    assert.ok(/過去5シーズン×15リーグから2250試合を取得し、\d+件の学習データを作りました\(APIリクエスト75件\)。/.test(tune.datasetNoteJa), tune.datasetNoteJa);
    assert.ok(tune.leagueChecks && tune.leagueChecks.total === 16);
  });
  await t("取り直さない日(同じ日の再実行): ④-b は提供元を呼ばない。記憶を通らない問い合わせは0件で、ほかの段階の節約はこれまでどおり", async () => {
    const api2 = createFakeApi();
    const second = await dj.runDailyLearning({ callApiFootball: api2.callApiFootball, resolveTeamId: async () => null, upstashEnabled: true, ...mock, now: () => new Date(RUN.getTime() + 3600000) });
    hb.setActivatedLeagues([]);
    assert.strictEqual(api2.calls.filter(isSeasonFetch).length, 0, "取り直さない日に、シーズンを取りに行った");
    assert.strictEqual(api2.calls.filter(isLeagueCheck).length, 0, "照合の結果は保存済みなのに、照合し直した");
    const memoEligible = api2.calls.filter((c) => MEMO_ENDPOINTS.includes(c[0])).length;
    // 成長ログは同じ日の2回ぶんを合算して返す → 2回めだけの数は、合算から1回めを引いて出す
    const missesSecond = second.apiRunMemo.misses - first.apiRunMemo.misses;
    assert.strictEqual(memoEligible - missesSecond, 0, "記憶を通らない問い合わせがある");
    assert.strictEqual(second.apiRunMemo.entries, Math.max(first.apiRunMemo.entries, missesSecond), "同じ日の再実行では、多いほうを残す");
  });
  await t("同じ問い合わせを繰り返す段階の節約は、これまでどおり(同じ引数の2回めは提供元に届かない)", async () => {
    // 登録クラブを1つだけ解決できるようにして、①と③が同じクラブの直近の試合を取りに行く状況を作る
    const mock2 = createFullMockRedis();
    const calls = [];
    const apiFn = async (endpoint, params) => { calls.push(endpoint + "?" + JSON.stringify(params || {})); return { response: [] }; };
    const r = await dj.runDailyLearning({ callApiFootball: apiFn, resolveTeamId: async (name) => (name ? 33 : null), upstashEnabled: true, ...mock2, now: () => RUN });
    hb.setActivatedLeagues([]);
    const memoCalls = calls.filter((c) => MEMO_ENDPOINTS.includes(c.split("?")[0]));
    const bypass = calls.filter((c) => /^\/fixtures\?\{"league":\d+,"season":\d+\}$/.test(c) || /^\/leagues\?\{"id":\d+\}$/.test(c));
    const viaMemo = memoCalls.length - bypass.length;
    assert.strictEqual(viaMemo, r.apiRunMemo.misses, "記憶を通った問い合わせの数が、記録と合わない");
    // 記憶を通った問い合わせは、提供元に同じものが2回届いていない
    const seen = new Map();
    for (const c of memoCalls) { if (bypass.includes(c)) continue; seen.set(c, (seen.get(c) || 0) + 1); }
    const dup = [...seen.entries()].filter(([, n]) => n > 1);
    assert.deepStrictEqual(dup, [], "同じ問い合わせが提供元に2回届いた: " + JSON.stringify(dup.slice(0, 3)));
    assert.ok(r.apiRunMemo.hits >= 0 && r.apiRunMemo.savedRequests === r.apiRunMemo.hits);
  });

  console.log("■ 3. 記録");
  await t("同じ日の再実行の合算: hits・misses は足し、entries は多いほう。古い記録(entries なし)とも合算できる", () => {
    const m = dj.mergeGrowthLogs({ date: "2026-11-18", apiRunMemo: { hits: 3, misses: 40, savedRequests: 3, entries: 40 } }, { date: "2026-11-18", apiRunMemo: { hits: 5, misses: 25, savedRequests: 5, entries: 25 } });
    assert.strictEqual(m.apiRunMemo.hits, 8); assert.strictEqual(m.apiRunMemo.misses, 65); assert.strictEqual(m.apiRunMemo.savedRequests, 8); assert.strictEqual(m.apiRunMemo.entries, 40);
    const old = dj.mergeGrowthLogs({ date: "2026-11-18", apiRunMemo: { hits: 1, misses: 10, savedRequests: 1 } }, { date: "2026-11-18", apiRunMemo: { hits: 0, misses: 7, savedRequests: 0, entries: 7 } });
    assert.strictEqual(old.apiRunMemo.entries, 7); assert.strictEqual(old.apiRunMemo.misses, 17);
    const none = dj.mergeGrowthLogs({ date: "2026-11-18" }, { date: "2026-11-18", apiRunMemo: { hits: 0, misses: 7, savedRequests: 0, entries: 7 } });
    assert.strictEqual(none.apiRunMemo.entries, 7);
  });

  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
