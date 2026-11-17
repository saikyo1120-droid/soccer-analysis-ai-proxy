"use strict";
/**
 * v102(2026年11月17日)・過去試合によるモデル調整(段階④-b)の安全弁とメモリの記録の検証
 * ----------------------------------------------------------------------------
 *   学習リーグを増やすと、④-b が同時に持つ試合の数は約2倍になる。本番の機械のメモリの上限は外から測れないので、
 *   「足りなかった場合」でも、利用者が何もしなくても学習が続くようにした。ここで確かめること:
 *     1. 通常の実行: 重い処理のあいだだけ「実行中の印」を置き、段階が進むたびに書き直し、終わったら消す
 *     2. 印が残っていた(前回は途中で処理ごと止まった)→ 3日間は「軽い設定」(新しいほうの試合だけ・重みの検証なし・取り直しなし)
 *     3. 期間が終わったら通常の設定で確かめる。走り切れたら記録を消す。そこでも止まったら 14日
 *     4. 「止まった」と数えないもの: 配備(プログラムの版が替わった)・同じ処理の印の消し損ね・終了の合図での終了・例外
 *     5. 保存先を読めない日は、通常の設定で進めて記録に残す
 *     6. メモリの実測(開始・読み込みのあと・検証の前後・終わり)と上限が、記録に残る
 *     7. 段階の切れ目のメモリの片づけは、計算の結果を変えない(止めても同じ結果)
 *     8. データセットの読み書き: 新しいほうのブロックだけを読める・上限を超えたら新しいほうを残す
 *     9. 健康診断に「軽い設定で動作中」が出る
 *    10. 交差検証に入る前に、メモリの余裕を実測で確かめる。足りない回は、落ちる前に検証を見送る(重みは変えない・理由と数字を残す)
 *    11. 検証の中で使う大きなデータを、検証のあとまで持ち続けない
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const S = __dirname;
const hb = require(path.join(S, "learning", "historicalBackfill.js"));
const mt = require(path.join(S, "learning", "modelTuning.js"));
const pm = require(path.join(S, "learning", "predictionModel.js"));
const { buildEngineStatuses } = require(path.join(S, "learning", "healthCheck.js"));

function rng(seed0) { let seed = seed0 >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const poisson = (rnd, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
/** 合成の試合: 2リーグ × 12チーム × 8シーズンの総当たり(約2,100試合 = 保存すると2ブロック) */
function synthMatches() {
  const rnd = rng(20261117);
  const matches = []; let id = 1;
  const nT = 12;
  for (let l = 0; l < 2; l++) {
    const leagueId = [39, 140][l];
    const teams = Array.from({ length: nT }, (_, i) => ({ id: (l + 1) * 100 + i + 1, att: (rnd() - 0.5) * 0.8, def: (rnd() - 0.5) * 0.6 }));
    for (let s = 0; s < 8; s++) {
      const year = 2019 + s; let day = 0;
      for (let round = 0; round < (nT - 1) * 2; round++) {
        const order = teams.slice();
        for (let k = 0; k < round % (nT - 1); k++) order.splice(1, 0, order.pop());
        for (let i = 0; i < nT / 2; i++) {
          let h = order[i], a = order[nT - 1 - i];
          if (round >= nT - 1) { const tmp = h; h = a; a = tmp; }
          const lh = Math.exp(0.3 + h.att - a.def), la = Math.exp(0.05 + a.att - h.def);
          const d = new Date(Date.UTC(year, 7, 10, 12 + (i % 6)) + (day + (i % 3)) * 86400000);
          matches.push({ id: id++, date: d.toISOString(), leagueId, season: year, homeId: h.id, awayId: a.id, homeName: "H" + h.id, awayName: "A" + a.id, hg: poisson(rnd, lh), ag: poisson(rnd, la) });
        }
        day += 7;
      }
    }
  }
  matches.sort((x, y) => new Date(x.date) - new Date(y.date) || x.id - y.id);
  return matches;
}
const MATCHES = synthMatches();
const ROWS = hb.buildTrainingRows(MATCHES, 10);
const RUN = new Date(Date.parse(MATCHES[MATCHES.length - 1].date) + 86400000);
const CORE_IDS = hb.DEFAULT_BACKFILL_LEAGUES.filter((l) => !l.verify).map((l) => l.id);
const W0 = { ...pm.EXTENDED_DEFAULT_WEIGHTS, version: 33 };
const DAY = 86400000;

function createMockRedis() {
  const store = new Map();
  const log = [];
  const failOn = { fn: null };
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd; log.push(cmd);
    if (failOn.fn && failOn.fn(cmd)) throw new Error("store down");
    if (op === "GET") return store.has(args[0]) ? store.get(args[0]) : null;
    if (op === "SET") { store.set(args[0], args[1]); return "OK"; }
    if (op === "DEL") return store.delete(args[0]) ? 1 : 0;
    if (op === "EXPIRE") return 1;
    if (op === "LPUSH") { const l = store.get(args[0]) || []; l.unshift(args[1]); store.set(args[0], l); return l.length; }
    if (op === "LTRIM") return "OK";
    if (op === "LRANGE") { const l = store.get(args[0]) || []; return l.slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1); }
    return null;
  }
  const upstashGetJSON = async (k) => { const raw = await upstashCmd(["GET", k]); return raw === null ? null : JSON.parse(raw); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  return { store, log, failOn, upstashCmd, upstashGetJSON, upstashSetJSON };
}
/** 保存済みのデータセットを置く(取り直しが起きないように、作成時刻を runAt の1時間前にする) */
async function seedDataset(mock, runAt) {
  const deps = { upstashEnabled: true, ...mock };
  await hb.saveDataset(deps, ROWS, { builtAt: new Date(runAt.getTime() - 3600000).toISOString(), leagues: CORE_IDS });
  // 足した16リーグは「照合に通っていない」と保存しておく(通信しない)
  await mock.upstashSetJSON(hb.LEAGUE_CHECK_KEY, { byId: Object.fromEntries([...hb.VERIFY_LEAGUE_IDS].map((x) => [x, { ok: false, reasonJa: "x", checkedAt: runAt.toISOString(), specVersion: 1 }])) });
  mock.log.length = 0;
}
async function touchDataset(mock, runAt) {
  const meta = await mock.upstashGetJSON(hb.BACKFILL_META_KEY);
  await mock.upstashSetJSON(hb.BACKFILL_META_KEY, { ...meta, builtAt: new Date(runAt.getTime() - 3600000).toISOString() });
  const chk = await mock.upstashGetJSON(hb.LEAGUE_CHECK_KEY);
  for (const k of Object.keys(chk.byId)) chk.byId[k].checkedAt = runAt.toISOString();
  await mock.upstashSetJSON(hb.LEAGUE_CHECK_KEY, chk);
  mock.log.length = 0;
}
const depsOf = (mock, extra) => ({ upstashEnabled: true, ...mock, callApiFootball: async () => ({ response: [] }), ...(extra || {}) });
const markerSets = (mock) => mock.log.filter((c) => c[0] === "SET" && c[1] === mt.TUNE_INFLIGHT_KEY).map((c) => JSON.parse(c[2]));
const leftover = (over) => JSON.stringify({ startedAt: new Date(RUN.getTime() - 3600000).toISOString(), date: "2026-11-18", commit: null, boot: "another-process", phase: "重みの検証の前", at: new Date(RUN.getTime() - 3000000).toISOString(), memory: { rssMb: 431, heapUsedMb: 240, heapTotalMb: 250, externalMb: 3, maxRssMb: 440 }, limits: { node: "v22.0.0", heapLimitMb: 256, constrainedMb: 512, totalMemMb: 512 }, ...(over || {}) });
const pickStable = (out) => JSON.stringify({ ran: out.ran, adopted: out.adopted, reasonJa: out.reasonJa, gateMode: out.gateMode, cv: out.cv ? { ...out.cv, ms: undefined } : null, oldEval: out.oldEval, newEval: out.newEval, drawBand: out.drawBand, xi: out.xi, datasetSize: out.datasetSize, comparisonJa: out.comparisonJa });

// ---- 子プロセスとして呼ばれたとき(--child-tune): 調整を1回走らせて、結果を1行で出す(片づけを止めた場合との比較用) ----
if (process.argv.includes("--child-tune")) {
  (async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    const out = await mt.tuneModelOnHistory(depsOf(mock), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    console.log(JSON.stringify({ stable: pickStable(out), gc: out.memory.gc }));
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : e)); } };

(async () => {
  assert.ok(ROWS.length > 1500 && ROWS.length <= 2400, `合成の行数 ${ROWS.length}`);
  let normalOut = null;

  console.log("■ 1. 通常の実行");
  await t("重い処理のあいだだけ「実行中の印」を置く。段階が進むたびに書き直し(段階・メモリ・版・処理の目印つき)、終わったら消す", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    const seen = [];
    const out = await mt.tuneModelOnHistory(depsOf(mock, { heartbeat: async (d) => { seen.push([d, mock.store.has(mt.TUNE_INFLIGHT_KEY)]); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    normalOut = out;
    assert.strictEqual(out.ran, true); assert.strictEqual(out.gateMode, "cv"); assert.ok(out.cv, "交差検証をしていない");
    assert.strictEqual(out.crashGuard.safeMode, false); assert.strictEqual(out.crashGuard.strikes, 0); assert.strictEqual(out.crashGuard.previousAttempt, null);
    const sets = markerSets(mock);
    assert.deepStrictEqual(sets.map((m) => m.phase), ["開始", "過去試合の読み込みのあと", "重みの検証の前", "重みの検証のあと"]);
    for (const m of sets) {
      assert.strictEqual(m.startedAt, RUN.toISOString()); assert.strictEqual(m.date, "2026-11-18");
      assert.strictEqual(m.boot, mt.PROCESS_BOOT_ID); assert.strictEqual(m.commit, null, "この環境には配備の番号が無い");
      assert.ok(Number.isFinite(m.memory.rssMb) && m.memory.rssMb > 0); assert.ok(Number.isFinite(Date.parse(m.at)));
      assert.strictEqual(m.limits.node, process.version); assert.ok(m.limits.heapLimitMb > 0);
    }
    // 印の有効期限は7日(その間に次の実行が来なければ、通常の設定で試す)
    const setCmds = mock.log.filter((c) => c[0] === "SET" && c[1] === mt.TUNE_INFLIGHT_KEY);
    for (const c of setCmds) assert.deepStrictEqual(c.slice(3), ["EX", String(7 * 86400)]);
    // 交差検証の最中は印がある。終わったら無い
    assert.ok(seen.some(([d, has]) => d === "過去試合の交差検証" && has === true), "交差検証の前に印が無い");
    assert.strictEqual(mock.store.has(mt.TUNE_INFLIGHT_KEY), false, "終わったのに印が残っている");
    assert.strictEqual(mock.store.has(mt.TUNE_SAFEMODE_KEY), false);
    // 保存先への追加のコマンドは、読み出し2・印の書き込み4・消去1
    const extra = mock.log.filter((c) => c[1] === mt.TUNE_INFLIGHT_KEY || c[1] === mt.TUNE_SAFEMODE_KEY);
    assert.deepStrictEqual(extra.map((c) => `${c[0]}:${c[1] === mt.TUNE_INFLIGHT_KEY ? "印" : "状態"}`), ["GET:状態", "GET:印", "SET:印", "SET:印", "SET:印", "SET:印", "DEL:印"]);
  });
  await t("保存先が無い環境では、印を置かずに従来どおり動く(例外を出さない)", async () => {
    const out = await mt.tuneModelOnHistory({ upstashEnabled: false }, W0, RUN, { dateKey: "2026-11-18" });
    assert.strictEqual(out.ran, false); assert.strictEqual(out.adopted, false);
  });

  console.log("■ 2. 印が残っていた(前回は途中で処理ごと止まった)→ 軽い設定");
  let safeState = null;
  const mockA = createMockRedis();
  await t("3日間の軽い設定に切り替える: 重みの検証をしない・モデルを変えない・地力レーティングと派生指標は更新する・理由を残す", async () => {
    await seedDataset(mockA, RUN);
    mockA.store.set(mt.TUNE_INFLIGHT_KEY, leftover());
    const beats = [];
    const out = await mt.tuneModelOnHistory(depsOf(mockA, { heartbeat: async (d) => { beats.push(d); } }), W0, RUN, { dateKey: "2026-11-19", guardRecords: [] });
    assert.strictEqual(out.ran, true); assert.strictEqual(out.adopted, false); assert.strictEqual(out.newParams, null);
    assert.strictEqual(out.gateMode, "cv"); assert.strictEqual(out.cv, null, "軽い設定なのに交差検証をしている");
    assert.ok(!beats.includes("過去試合の交差検証"));
    const g = out.crashGuard;
    assert.strictEqual(g.safeMode, true); assert.strictEqual(g.strikes, 1);
    assert.strictEqual(g.since, RUN.toISOString()); assert.strictEqual(Date.parse(g.until) - RUN.getTime(), mt.SAFE_MODE_DAYS * DAY); assert.strictEqual(mt.SAFE_MODE_DAYS, 3);
    assert.strictEqual(g.previousAttempt.endedBy, "process_ended"); assert.strictEqual(g.previousAttempt.phase, "重みの検証の前");
    assert.strictEqual(g.previousAttempt.memory.rssMb, 431); assert.strictEqual(g.previousAttempt.limits.constrainedMb, 512);
    // 理由の文: 1文ずつ独立(かっこの中に「。」が無い)。時刻は日本時間
    const startJst = new Date(RUN.getTime() - 3600000 + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
    const untilJst = new Date(Date.parse(g.until) + 9 * 3600000).toISOString().slice(0, 10);
    assert.strictEqual(g.reasonJa, `前回(日本時間 ${startJst} に開始)の過去試合によるモデル調整は、途中で処理ごと止まっていました。そのため、日本時間 ${untilJst} までは軽い設定で動かします(新しいほうの過去試合だけを使い、重みの検証は行いません)。`);
    assert.strictEqual(out.reasonJa, `${g.reasonJa}モデルは変更しません。`);
    assert.ok(!/。[)）]/.test(out.reasonJa), "かっこの中に文の終わりがある");
    assert.ok(/^軽い設定で動かしているため、保存済みの過去試合のうち新しい\d+件だけを使い、取り直しは見送りました。$/.test(out.datasetNoteJa), out.datasetNoteJa);
    // ほかの処理は続いている
    assert.strictEqual(out.teamRatings.fullFit.available, true); assert.strictEqual(out.teamRatings.fullFit.saved, true);
    assert.strictEqual(out.teamStats.saved, true);
    assert.ok(out.holdoutBaseEval && out.holdoutBaseEval.sampleSize > 200, "従来と同じ「新しい3割」の成績は残す");
    assert.ok(out.vsBaseline && out.vsBaseline.comparisonJa);
    // 状態の保存(45日。期間は until で見る)。前回の印は消す。軽い設定のあいだは新しい印を置かない
    const st = JSON.parse(mockA.store.get(mt.TUNE_SAFEMODE_KEY)); safeState = st;
    assert.strictEqual(st.strikes, 1); assert.strictEqual(st.until, g.until);
    const setCmd = mockA.log.find((c) => c[0] === "SET" && c[1] === mt.TUNE_SAFEMODE_KEY);
    assert.deepStrictEqual(setCmd.slice(3), ["EX", String(45 * 86400)]);
    assert.strictEqual(mockA.store.has(mt.TUNE_INFLIGHT_KEY), false);
    assert.strictEqual(markerSets(mockA).length, 0, "軽い設定なのに印を置いた");
    // 調整の履歴にも、軽い設定だったことが残る
    const rec = JSON.parse(mockA.store.get(mt.TUNING_LOG_KEY)[0]);
    assert.strictEqual(rec.crashGuard.safeMode, true); assert.strictEqual(rec.adopted, false); assert.ok(rec.memory && rec.memory.end);
  });
  await t("期間中の次の日も軽い設定のまま(保存先の読み出しは1回だけ・回数は増えない)", async () => {
    const run2 = new Date(RUN.getTime() + DAY);
    await touchDataset(mockA, run2);
    const out = await mt.tuneModelOnHistory(depsOf(mockA), W0, run2, { dateKey: "2026-11-20", guardRecords: [] });
    assert.strictEqual(out.crashGuard.safeMode, true); assert.strictEqual(out.crashGuard.strikes, 1); assert.strictEqual(out.crashGuard.until, safeState.until);
    assert.strictEqual(out.cv, null); assert.strictEqual(out.adopted, false);
    const extra = mockA.log.filter((c) => c[1] === mt.TUNE_INFLIGHT_KEY || c[1] === mt.TUNE_SAFEMODE_KEY);
    assert.deepStrictEqual(extra.map((c) => c[0]), ["GET"]);
  });

  console.log("■ 3. 期間が終わったら、通常の設定で確かめる");
  await t("走り切れたら「止まった回数」の記録を消す(次に止まったら、また1回めから)", async () => {
    const run3 = new Date(RUN.getTime() + 3 * DAY + 60000);
    await touchDataset(mockA, run3);
    const out = await mt.tuneModelOnHistory(depsOf(mockA), W0, run3, { dateKey: "2026-11-22", guardRecords: [] });
    assert.strictEqual(out.crashGuard.safeMode, false); assert.strictEqual(out.crashGuard.staleState, true); assert.strictEqual(out.crashGuard.strikes, 1);
    assert.ok(out.cv, "通常の設定なのに交差検証をしていない");
    assert.strictEqual(markerSets(mockA).length, 4);
    assert.strictEqual(mockA.store.has(mt.TUNE_SAFEMODE_KEY), false, "走り切れたのに記録が残っている");
    assert.strictEqual(mockA.store.has(mt.TUNE_INFLIGHT_KEY), false);
  });
  await t("確かめた回でも止まった(2回め)→ 14日間の軽い設定。文も変わる", async () => {
    const mock = createMockRedis();
    const run4 = new Date(RUN.getTime() + 3 * DAY + 3600000);
    await seedDataset(mock, run4);
    // 期間が終わった記録(1回め)が残っていて、通常の設定で確かめた回の印も残っている
    mock.store.set(mt.TUNE_SAFEMODE_KEY, JSON.stringify({ since: RUN.toISOString(), until: new Date(RUN.getTime() + 3 * DAY).toISOString(), strikes: 1, reasonJa: "x", previousAttempt: null }));
    mock.store.set(mt.TUNE_INFLIGHT_KEY, leftover({ startedAt: new Date(run4.getTime() - 3000000).toISOString() }));
    const out = await mt.tuneModelOnHistory(depsOf(mock), W0, run4, { dateKey: "2026-11-22", guardRecords: [] });
    const g = out.crashGuard;
    assert.strictEqual(g.safeMode, true); assert.strictEqual(g.strikes, 2);
    assert.strictEqual(Date.parse(g.until) - run4.getTime(), mt.SAFE_MODE_DAYS_REPEAT * DAY); assert.strictEqual(mt.SAFE_MODE_DAYS_REPEAT, 14);
    const untilJst = new Date(Date.parse(g.until) + 9 * 3600000).toISOString().slice(0, 10);
    assert.strictEqual(g.reasonJa, `過去試合によるモデル調整が、通常の設定に戻して確かめた回でも、途中で処理ごと止まりました(2回め)。そのため、日本時間 ${untilJst} までは軽い設定で動かします(新しいほうの過去試合だけを使い、重みの検証は行いません)。`);
    assert.strictEqual(out.cv, null);
    assert.strictEqual(JSON.parse(mock.store.get(mt.TUNE_SAFEMODE_KEY)).strikes, 2);
  });

  console.log("■ 4. 「止まった」と数えないもの");
  await t("配備(印を置いたときとプログラムの版が違う)による再起動は数えない。通常の設定で続け、記録に残す", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    mock.store.set(mt.TUNE_INFLIGHT_KEY, leftover({ commit: "aaaaaaaaaaaa" }));
    const prevEnv = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT = "bbbbbbbbbbbbccccccccccccdddddddddddd1234";
    try {
      assert.strictEqual(mt.codeCommit(), "bbbbbbbbbbbb");
      const out = await mt.tuneModelOnHistory(depsOf(mock), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
      assert.strictEqual(out.crashGuard.safeMode, false); assert.strictEqual(out.crashGuard.previousAttempt.endedBy, "deploy");
      assert.ok(/配備による再起動とみなして/.test(out.crashGuard.noteJa));
      assert.ok(out.cv, "通常の設定で続けていない");
      assert.strictEqual(mock.store.has(mt.TUNE_SAFEMODE_KEY), false);
      assert.strictEqual(markerSets(mock)[0].commit, "bbbbbbbbbbbb", "新しい印には、いまの版を入れる");
      // 同じ版のまま印が残っていたら、数える
      const mock2 = createMockRedis();
      await seedDataset(mock2, RUN);
      mock2.store.set(mt.TUNE_INFLIGHT_KEY, leftover({ commit: "bbbbbbbbbbbb" }));
      const out2 = await mt.tuneModelOnHistory(depsOf(mock2), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
      assert.strictEqual(out2.crashGuard.safeMode, true); assert.strictEqual(out2.crashGuard.previousAttempt.commit, "bbbbbbbbbbbb");
    } finally {
      if (prevEnv === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = prevEnv;
    }
    assert.strictEqual(mt.codeCommit(), prevEnv ? prevEnv.slice(0, 12) : null);
  });
  await t("この処理自身が置いた印(消す操作の失敗で残っただけ)は数えない", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    mock.store.set(mt.TUNE_INFLIGHT_KEY, leftover({ boot: mt.PROCESS_BOOT_ID }));
    const out = await mt.tuneModelOnHistory(depsOf(mock), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.strictEqual(out.crashGuard.safeMode, false); assert.strictEqual(out.crashGuard.previousAttempt.endedBy, "marker_not_cleared");
    assert.ok(out.cv); assert.strictEqual(mock.store.has(mt.TUNE_SAFEMODE_KEY), false);
  });
  await t("例外で終わったときは印を消す(処理は生きているので、次回は通常の設定)", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    await assert.rejects(
      mt.tuneModelOnHistory(depsOf(mock, { clubEloLookup: () => { throw new Error("boom"); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] }),
      /boom/
    );
    assert.strictEqual(mock.store.has(mt.TUNE_INFLIGHT_KEY), false, "例外のあとに印が残っている");
    assert.strictEqual(mock.store.has(mt.TUNE_SAFEMODE_KEY), false);
    assert.strictEqual(await mt.releaseInflightMarkerOnShutdown(), false, "実行中でないのに、終了時の片づけが動いた");
  });
  await t("終了の合図を受けたとき: 実行中なら印を消す(配備・再起動での終了を「落ちた」と数えない)。実行中でなければ何もしない", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    assert.strictEqual(await mt.releaseInflightMarkerOnShutdown(), false);
    let during = null;
    const out = await mt.tuneModelOnHistory(depsOf(mock, {
      heartbeat: async (d) => {
        if (d !== "過去試合の交差検証" || during) return;
        const before = mock.store.has(mt.TUNE_INFLIGHT_KEY);
        const released = await mt.releaseInflightMarkerOnShutdown();
        during = { before, released, after: mock.store.has(mt.TUNE_INFLIGHT_KEY), again: await mt.releaseInflightMarkerOnShutdown() };
      },
    }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.deepStrictEqual(during, { before: true, released: true, after: false, again: false });
    assert.strictEqual(out.ran, true);
    // server.js: 終了の合図の処理に組み込まれている(保存先が応答しないときは3秒で打ち切る)
    const src = fs.readFileSync(path.join(S, "server.js"), "utf8");
    assert.ok(/await Promise\.all\(\[flushBudgetOnExit\(\), flushUpstashUsageOnExit\(\), releaseTuningMarkerOnExit\(\)\]\);\s*\n\s*process\.exit\(0\);/.test(src), "終了の合図の処理に入っていない");
    assert.ok(/SHUTDOWN_MARKER_RELEASE_TIMEOUT_MS = 3000/.test(src));
  });

  console.log("■ 5. 保存先を読めない日");
  await t("安全弁の状態を読めなかったら、通常の設定で進めて記録に残す(黙って続けない)", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    mock.failOn.fn = (c) => c[0] === "GET" && c[1] === mt.TUNE_SAFEMODE_KEY;
    const notes = [];
    const out = await mt.tuneModelOnHistory(depsOf(mock, { noteWarning: (tag) => { notes.push(tag); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.strictEqual(out.crashGuard.safeMode, false); assert.ok(out.cv);
    assert.ok(notes.includes("tuning_crashguard_read_failed"), notes.join(","));
  });
  await t("印を書けない・消せないときも、調整そのものは最後まで行い、記録に残す", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    mock.failOn.fn = (c) => (c[0] === "SET" || c[0] === "DEL") && c[1] === mt.TUNE_INFLIGHT_KEY;
    const notes = [];
    const out = await mt.tuneModelOnHistory(depsOf(mock, { noteWarning: (tag) => { notes.push(tag); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.strictEqual(out.ran, true); assert.ok(out.cv);
    assert.ok(notes.includes("tuning_inflight_mark_failed") && notes.includes("tuning_inflight_clear_failed"), notes.join(","));
  });

  await t("通信が1回だけ失敗したとき(長い計算の直後に、切れていた接続に当たった場合)は、もう1回試して成功する。記録に失敗を残さない", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    // 印の書き込み(3回め = 「重みの検証の前」)と、最後の消去を、それぞれ最初の1回だけ失敗させる
    let setCount = 0, delFailed = false;
    mock.failOn.fn = (c) => {
      if (c[1] !== mt.TUNE_INFLIGHT_KEY) return false;
      if (c[0] === "SET") { setCount++; return setCount === 3; }
      if (c[0] === "DEL" && !delFailed) { delFailed = true; return true; }
      return false;
    };
    const notes = [];
    const out = await mt.tuneModelOnHistory(depsOf(mock, { noteWarning: (tag) => { notes.push(tag); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.strictEqual(out.ran, true); assert.ok(out.cv);
    assert.deepStrictEqual(notes.filter((n) => /^tuning_/.test(n)), [], "1回の失敗を、失敗として記録している");
    assert.strictEqual(setCount, 5, "印の書き込みは4段階+やり直し1回"); assert.strictEqual(delFailed, true);
    assert.strictEqual(mock.store.has(mt.TUNE_INFLIGHT_KEY), false, "やり直しで消せていない");
    // 部品そのもの: 1回めが失敗 → 2回めの結果を返す。2回とも失敗 → 失敗を投げる
    let n = 0;
    assert.strictEqual(await mt.storeCmdRetryOnce(async () => { n++; if (n === 1) throw new Error("fetch failed"); return "OK"; }, ["SET", "k", "v"]), "OK");
    assert.strictEqual(n, 2);
    await assert.rejects(mt.storeCmdRetryOnce(async () => { throw new Error("down"); }, ["GET", "k"]), /down/);
  });

  console.log("■ 6. メモリの実測");
  await t("記録に、上限(Node の版・Node の上限・入れ物の上限・見えているメモリ)と、段階ごとの実測が残る", async () => {
    const m = normalOut.memory;
    assert.strictEqual(m.node, process.version);
    assert.ok(Number.isFinite(m.heapLimitMb) && m.heapLimitMb > 0); assert.ok(Number.isFinite(m.totalMemMb) && m.totalMemMb > 0);
    assert.ok(m.constrainedMb === null || (Number.isFinite(m.constrainedMb) && m.constrainedMb > 0), "入れ物の上限は、読めなければ null");
    for (const k of ["start", "startAfterGc", "afterDataset", "beforeGate", "afterGate", "end"]) {
      assert.ok(m[k], `${k} が無い`);
      assert.ok(Number.isFinite(m[k].rssMb) && m[k].rssMb > 0, k); assert.ok(Number.isFinite(m[k].heapUsedMb) && m[k].heapUsedMb > 0, k);
      assert.ok(m[k].maxRssMb === null || m[k].maxRssMb >= m[k].rssMb - 1, `${k}: 最大値が現在値より小さい`);
    }
    assert.strictEqual(typeof m.gc.available, "boolean");
    if (m.gc.available) assert.ok(m.gc.calls >= 9, `片づけの回数 ${m.gc.calls}`); else assert.strictEqual(m.gc.calls, 0);
    if (m.gc.available) assert.ok(m.startAfterGc.heapUsedMb <= m.start.heapUsedMb, "片づけたあとのほうが多い");
    // 調整の履歴にも同じ記録が入る(日次レポートから読める)
    const snap = mt.memorySnapshot(), lim = mt.memoryLimits();
    assert.deepStrictEqual(Object.keys(snap), ["rssMb", "heapUsedMb", "heapTotalMb", "externalMb", "maxRssMb"]);
    assert.deepStrictEqual(Object.keys(lim), ["node", "heapLimitMb", "constrainedMb", "totalMemMb"]);
  });
  await t("毎日の学習は、調整の記録(安全弁・メモリ)と、学習全体の開始・終了のメモリを成長ログに残す", () => {
    const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    assert.ok(/crashGuard: modelTuning\.crashGuard \?\? null,\s*\n\s*memoryCheck: modelTuning\.memoryCheck \?\? null,\s*\n\s*memory: modelTuning\.memory \?\? null,/.test(src));
    assert.ok(/const processMemoryAtStart = memorySnapshot\(\);/.test(src));
    assert.ok(/processMemory: \{ \.\.\.memoryLimits\(\), start: processMemoryAtStart, end: memorySnapshot\(\) \},/.test(src));
  });

  console.log("■ 7. メモリの片づけは、計算の結果を変えない");
  await t("片づけを止めても(TUNE_EXPLICIT_GC=off)、採否・理由・検証の数字は1文字も変わらない", async () => {
    const run = (env) => JSON.parse(execFileSync(process.execPath, [__filename, "--child-tune"], { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").pop());
    const off = run({ TUNE_EXPLICIT_GC: "off" });
    const on = run({ TUNE_EXPLICIT_GC: "" });
    assert.deepStrictEqual(off.gc, { available: false, calls: 0, ms: 0 });
    assert.strictEqual(typeof on.gc.available, "boolean");
    assert.strictEqual(on.stable, off.stable, "片づけの有無で結果が変わった");
    assert.strictEqual(on.stable, pickStable(normalOut), "同じ入力なのに、この処理の中の結果と違う");
  });

  console.log("■ 8. データセットの読み書き");
  await t("新しいほうのブロックだけを読める(軽い設定用)。行は古い順のまま・読まなかったブロックの数を返す", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    const deps = { upstashEnabled: true, ...mock };
    const all = await hb.loadDataset(deps);
    assert.strictEqual(all.rows.length, ROWS.length); assert.strictEqual(all.meta.shardCount, 2); assert.strictEqual(all.skippedOldShards, undefined);
    const last = await hb.loadDataset(deps, { lastShards: 1 });
    assert.strictEqual(last.rows.length, ROWS.length - hb.BACKFILL_SHARD_SIZE); assert.strictEqual(last.skippedOldShards, 1);
    assert.strictEqual(last.rows[0].date, ROWS[hb.BACKFILL_SHARD_SIZE].date); assert.strictEqual(last.rows[last.rows.length - 1].date, ROWS[ROWS.length - 1].date);
    const more = await hb.loadDataset(deps, { lastShards: 20 });
    assert.strictEqual(more.rows.length, ROWS.length, "ブロック数より多く指定したら全部"); assert.strictEqual(more.skippedOldShards, undefined);
    assert.strictEqual(mt.SAFE_MODE_LAST_SHARDS, 20); assert.strictEqual(mt.SAFE_MODE_LAST_SHARDS * hb.BACKFILL_SHARD_SIZE, 24000);
    // 軽い設定の読み込み: 新しいほうだけ・取り直さない(古くなっていても)
    const old = new Date(RUN.getTime() + 10 * DAY);
    let apiCalls = 0;
    const ds = await mt.ensureDataset({ ...deps, callApiFootball: async () => { apiCalls++; return { response: [] }; } }, old, { safeMode: true });
    assert.strictEqual(ds.refreshed, false); assert.strictEqual(apiCalls, 0, "軽い設定なのに取り直した"); assert.strictEqual(ds.rows.length, ROWS.length);
  });
  await t("軽い設定のあいだに保存済みの過去試合を1件も読めなかった日: 取り直さずに、その回の調整を見送る(いちばん重い処理を、印なしで走らせない)", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    mock.store.set(mt.TUNE_INFLIGHT_KEY, leftover());
    // ブロックの読み出しだけ失敗させる(目次は読める)
    const failingGet = async (k) => { if (/^learn:backfill:dataset:s\d+$/.test(k)) throw new Error("store down"); return mock.upstashGetJSON(k); };
    let apiCalls = 0;
    const notes = [];
    const out = await mt.tuneModelOnHistory({ upstashEnabled: true, ...mock, upstashGetJSON: failingGet, callApiFootball: async () => { apiCalls++; return { response: [] }; }, noteWarning: (tag) => { notes.push(tag); } }, W0, RUN, { dateKey: "2026-11-19", guardRecords: [] });
    assert.strictEqual(out.ran, false); assert.strictEqual(out.adopted, false);
    assert.strictEqual(out.reasonJa, "軽い設定で動かしていますが、保存済みの過去試合を読み出せなかったため、今回の過去試合によるモデル調整は見送りました。");
    assert.strictEqual(apiCalls, 0, "軽い設定なのに、過去試合を取り直そうとした");
    assert.strictEqual(out.crashGuard.safeMode, true); assert.ok(out.memory && out.memory.afterDataset);
    assert.ok(notes.includes("backfill_shard_read_failed"), notes.join(","));
    assert.strictEqual(markerSets(mock).length, 0);
    // 通常の設定では、読めなかった日は従来どおり取り直しを試みる(v101 までと同じ動き)
    const mock2 = createMockRedis();
    await seedDataset(mock2, RUN);
    const failingGet2 = async (k) => { if (/^learn:backfill:dataset:s\d+$/.test(k)) throw new Error("store down"); return mock2.upstashGetJSON(k); };
    let apiCalls2 = 0;
    const ds2 = await mt.ensureDataset({ upstashEnabled: true, ...mock2, upstashGetJSON: failingGet2, callApiFootball: async () => { apiCalls2++; return { response: [] }; } }, RUN);
    assert.ok(apiCalls2 > 0, "通常の設定で、取り直しを試みていない"); assert.strictEqual(ds2.refreshed, false);
  });
  await t("読み込んだ行は、保存前と同じ値(保存用の形を全件ぶん二重に持たない作りに変えても、中身は同じ)", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    const got = (await hb.loadDataset({ upstashEnabled: true, ...mock })).rows;
    for (const i of [0, 1, 777, hb.BACKFILL_SHARD_SIZE - 1, hb.BACKFILL_SHARD_SIZE, ROWS.length - 1]) {
      const a = ROWS[i], b = got[i];
      assert.strictEqual(b.date, a.date); assert.strictEqual(b.leagueId, a.leagueId); assert.strictEqual(b.homeId, a.homeId); assert.strictEqual(b.awayId, a.awayId);
      assert.strictEqual(b.actualHomeGoals, a.actualHomeGoals); assert.strictEqual(b.actualAwayGoals, a.actualAwayGoals); assert.strictEqual(b.actualWinner, a.actualWinner);
      for (const k of ["formScore", "avgGoalsFor", "avgGoalsAgainst", "pointsPerGame", "matchesLast7Days", "sampleSize"]) {
        assert.strictEqual(b.homeCtx[k], a.homeCtx[k] ?? null, `行${i} homeCtx.${k}`); assert.strictEqual(b.awayCtx[k], a.awayCtx[k] ?? null, `行${i} awayCtx.${k}`);
      }
      assert.strictEqual(b.homeCtx.homeVenueWinRate, a.homeCtx.homeVenueWinRate ?? null); assert.strictEqual(b.awayCtx.awayVenueWinRate, a.awayCtx.awayVenueWinRate ?? null);
    }
  });
  await t("保存の上限(45ブロック)を超えた行は、古いほうを保存しない(新しいほうを残す。文言「直近◯件を保存」と合う)", async () => {
    const cap = hb.BACKFILL_MAX_SHARDS * hb.BACKFILL_SHARD_SIZE;
    const big = [];
    for (let i = 0; i < cap + 7; i++) big.push({ date: new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString(), leagueId: 39, season: 2020, homeId: 1, awayId: 2, homeCtx: { formScore: 0.1, sampleSize: 5 }, awayCtx: { formScore: -0.1, sampleSize: 5 }, actualHomeGoals: 1, actualAwayGoals: 0, actualWinner: "home" });
    const mock = createMockRedis();
    const deps = { upstashEnabled: true, ...mock };
    const res = await hb.saveDataset(deps, big, { builtAt: RUN.toISOString(), leagues: [39] });
    assert.strictEqual(res.saved, true); assert.strictEqual(res.shardCount, hb.BACKFILL_MAX_SHARDS); assert.strictEqual(res.storedRows, cap); assert.strictEqual(res.truncatedRows, 7);
    assert.strictEqual(res.reasonJa, `上限を超えた7件は保存していません(直近${cap}件を保存)。`);
    const back = await hb.loadDataset(deps);
    assert.strictEqual(back.rows.length, cap);
    assert.strictEqual(back.rows[0].date, big[7].date, "古いほうの7件を保存していないこと"); assert.strictEqual(back.rows[cap - 1].date, big[cap + 6].date, "いちばん新しい行が入っていること");
  });

  console.log("■ 9. 健康診断");
  await t("軽い設定で動かしている日は、注意(warn)として理由つきで出す。通常の日は出さない", () => {
    const base = { runHistory: null, upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true, engineTotals: {} };
    const reason = "前回(日本時間 2026-11-19 04:17 に開始)の過去試合によるモデル調整は、途中で処理ごと止まっていました。そのため、日本時間 2026-11-22 までは軽い設定で動かします(新しいほうの過去試合だけを使い、重みの検証は行いません)。";
    const on = buildEngineStatuses({ ...base, growthLog: { ranYet: true, modelTuning: { ran: true, adopted: false, crashGuard: { safeMode: true, strikes: 1, reasonJa: reason } } } });
    const item = on.find((e) => e.id === "tuningSafeMode");
    assert.ok(item, "項目が無い"); assert.strictEqual(item.status, "warn"); assert.strictEqual(item.messageJa, reason);
    assert.ok(/操作は不要です/.test(item.actionJa) && /14日/.test(item.actionJa));
    const off = buildEngineStatuses({ ...base, growthLog: { ranYet: true, modelTuning: { ran: true, adopted: false, crashGuard: { safeMode: false, strikes: 0 } } } });
    assert.ok(!off.some((e) => e.id === "tuningSafeMode"));
    const none = buildEngineStatuses({ ...base, growthLog: { ranYet: true } });
    assert.ok(!none.some((e) => e.id === "tuningSafeMode"));
  });

  console.log("■ 10. 交差検証に入る前の、メモリの余裕の確認");
  await t("目安の式: Node の空き = 上限 − 使用中(目安 64MB+行数×0.00048MB)/サーバーの空き = 入れ物の上限 −(使用中 − 確保済みの空き)(目安 40MB+行数×0.0008MB)", () => {
    assert.deepStrictEqual(mt.CV_MEMORY_RULE, { heapBaseMb: 64, heapPerRowMb: 0.00048, rssBaseMb: 40, rssPerRowMb: 0.0008 });
    const snap = { rssMb: 300, heapUsedMb: 150, heapTotalMb: 170, externalMb: 3, maxRssMb: 320 };
    // 512MB の入れ物・Node の上限 304MB(= 256+48): 空きは 154MB / 232MB。51,925行の目安は 89MB / 82MB → 足りる
    const ok = mt.cvMemoryCheck(51925, snap, { node: "v22", heapLimitMb: 304, constrainedMb: 512, totalMemMb: 512 });
    assert.deepStrictEqual(ok, { ok: true, checked: true, rows: 51925, heapFreeMb: 154, heapNeedMb: 89, rssFreeMb: 232, rssNeedMb: 82, reasonJa: null });
    assert.strictEqual(mt.cvMemoryCheck(24000, snap, { heapLimitMb: 304, constrainedMb: 512 }).heapNeedMb, 76);
    // Node の空きが足りない(上限 230MB → 空き 80MB < 89MB)
    const heapShort = mt.cvMemoryCheck(51925, snap, { heapLimitMb: 230, constrainedMb: 512 });
    assert.strictEqual(heapShort.ok, false); assert.strictEqual(heapShort.heapFreeMb, 80);
    assert.strictEqual(heapShort.reasonJa, "メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました(Node の空き 80MB・必要の目安 89MB)。");
    // Node の上限は大きいが、入れ物の空きが足りない(使用中 470MB・確保済みの空き 20MB → 空き 62MB < 82MB)
    const rssShort = mt.cvMemoryCheck(51925, { ...snap, rssMb: 470 }, { heapLimitMb: 2096, constrainedMb: 512 });
    assert.strictEqual(rssShort.ok, false); assert.strictEqual(rssShort.rssFreeMb, 62);
    assert.strictEqual(rssShort.reasonJa, "メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました(サーバーの空き 62MB・必要の目安 82MB)。");
    for (const r of [heapShort.reasonJa, rssShort.reasonJa]) assert.ok(!/。[)\uFF09]/.test(r), "かっこの中に文の終わりがある");
    // 上限を読めない環境: その項目は確かめられない(見送らない)。どちらも読めなければ checked:false
    const noCg = mt.cvMemoryCheck(51925, { ...snap, rssMb: 470 }, { heapLimitMb: 2096, constrainedMb: null });
    assert.strictEqual(noCg.ok, true); assert.strictEqual(noCg.rssFreeMb, null); assert.strictEqual(noCg.checked, true);
    const none = mt.cvMemoryCheck(51925, snap, { heapLimitMb: null, constrainedMb: null });
    assert.strictEqual(none.ok, true); assert.strictEqual(none.checked, false);
    assert.strictEqual(mt.cvMemoryCheck(51925, null, null).ok, true);
    // ちょうど目安と同じなら足りる
    assert.strictEqual(mt.cvMemoryCheck(51925, snap, { heapLimitMb: 150 + 89, constrainedMb: null }).ok, true);
    assert.strictEqual(mt.cvMemoryCheck(51925, snap, { heapLimitMb: 150 + 88, constrainedMb: null }).ok, false);
    // 片づけ(GC)を呼べなかった環境: 使用中の量に片づけ前のごみが含まれるので、確かめない(見送らない。その旨を残す)
    const noGc = mt.cvMemoryCheck(51925, { ...snap, rssMb: 470 }, { heapLimitMb: 160, constrainedMb: 512 }, null, false);
    assert.deepStrictEqual(noGc, { ok: true, checked: false, gcUnavailable: true, rows: 51925, heapFreeMb: null, heapNeedMb: 89, rssFreeMb: null, rssNeedMb: 82, reasonJa: null });
    assert.strictEqual(mt.cvMemoryCheck(51925, { ...snap, rssMb: 470 }, { heapLimitMb: 160, constrainedMb: 512 }, null, true).ok, false, "片づけたあとの値なら確かめる");
  });
  await t("通常の実行では確認の結果(足りた)と数字が記録に残る。環境変数 TUNE_MEMORY_CHECK=off で確認を止められる", () => {
    const c = normalOut.memoryCheck;
    assert.strictEqual(c.ok, true); assert.strictEqual(c.checked, true); assert.strictEqual(c.rows, ROWS.length);
    assert.strictEqual(c.heapNeedMb, Math.ceil(64 + ROWS.length * 0.00048)); assert.strictEqual(c.rssNeedMb, Math.ceil(40 + ROWS.length * 0.0008));
    assert.strictEqual(c.heapFreeMb, normalOut.memory.heapLimitMb - normalOut.memory.beforeGate.heapUsedMb);
    assert.strictEqual(c.reasonJa, null);
    const prev = process.env.TUNE_MEMORY_CHECK;
    process.env.TUNE_MEMORY_CHECK = "off";
    try {
      const off = mt.cvMemoryCheck(51925, { rssMb: 470, heapUsedMb: 150, heapTotalMb: 170 }, { heapLimitMb: 160, constrainedMb: 512 });
      assert.strictEqual(off.ok, true); assert.strictEqual(off.checked, false); assert.strictEqual(off.disabled, true); assert.strictEqual(off.reasonJa, null);
    } finally { if (prev === undefined) delete process.env.TUNE_MEMORY_CHECK; else process.env.TUNE_MEMORY_CHECK = prev; }
  });
  await t("余裕が足りない回: 検証を見送り、モデルを変えない。ほかの処理(地力レーティング・派生指標)は続ける。軽い設定にはしない(落ちていないので)", async () => {
    const mock = createMockRedis();
    await seedDataset(mock, RUN);
    const beats = [];
    const out = await mt.tuneModelOnHistory(depsOf(mock, { heartbeat: async (d) => { beats.push(d); } }), W0, RUN, { dateKey: "2026-11-18", guardRecords: [], cvMemoryRule: { heapBaseMb: 1e7 } });
    assert.strictEqual(out.ran, true); assert.strictEqual(out.adopted, false); assert.strictEqual(out.newParams, null);
    assert.strictEqual(out.gateMode, "cv"); assert.strictEqual(out.cv, null); assert.ok(!beats.includes("過去試合の交差検証"), "見送ったのに交差検証をしている");
    assert.strictEqual(out.memoryCheck.ok, false); assert.strictEqual(out.memoryCheck.heapNeedMb, Math.ceil(1e7 + ROWS.length * 0.00048));
    assert.ok(/^メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました\(Node の空き \d+MB・必要の目安 \d+MB\)。モデルは変更しません。$/.test(out.reasonJa), out.reasonJa);
    assert.strictEqual(out.crashGuard.safeMode, false); assert.strictEqual(mock.store.has(mt.TUNE_SAFEMODE_KEY), false); assert.strictEqual(mock.store.has(mt.TUNE_INFLIGHT_KEY), false);
    assert.strictEqual(out.datasetSize, ROWS.length, "行は全部使う(減らすのは軽い設定のときだけ)");
    assert.strictEqual(out.teamRatings.fullFit.saved, true); assert.strictEqual(out.teamStats.saved, true);
    assert.ok(out.holdoutBaseEval && out.vsBaseline);
    const rec = JSON.parse(mock.store.get(mt.TUNING_LOG_KEY)[0]);
    assert.strictEqual(rec.memoryCheck.ok, false); assert.strictEqual(rec.adopted, false);
    // 軽い設定の回は、この確認をしない(検証そのものをしないので)
    const mock2 = createMockRedis();
    await seedDataset(mock2, RUN);
    mock2.store.set(mt.TUNE_INFLIGHT_KEY, leftover());
    const safe = await mt.tuneModelOnHistory(depsOf(mock2), W0, RUN, { dateKey: "2026-11-18", guardRecords: [] });
    assert.strictEqual(safe.crashGuard.safeMode, true); assert.strictEqual(safe.memoryCheck, null);
  });
  await t("健康診断: 見送った日は注意(warn)として、理由と数字つきで出す。足りた日は出さない", () => {
    const base = { runHistory: null, upstashEnabled: true, apiKeyConfigured: true, llmConfigured: true, engineTotals: {} };
    const reason = "メモリの余裕が足りないため、今回は過去試合での重みの検証を見送りました(Node の空き 80MB・必要の目安 89MB)。";
    const on = buildEngineStatuses({ ...base, growthLog: { ranYet: true, modelTuning: { ran: true, adopted: false, memoryCheck: { ok: false, reasonJa: reason }, crashGuard: { safeMode: false } } } });
    const item = on.find((e) => e.id === "tuningMemory");
    assert.ok(item); assert.strictEqual(item.status, "warn"); assert.strictEqual(item.messageJa, reason); assert.ok(/操作は不要です/.test(item.actionJa));
    assert.ok(!on.some((e) => e.id === "tuningSafeMode"));
    const off = buildEngineStatuses({ ...base, growthLog: { ranYet: true, modelTuning: { ran: true, memoryCheck: { ok: true, reasonJa: null } } } });
    assert.ok(!off.some((e) => e.id === "tuningMemory"));
  });

  console.log("■ 11. 検証の中で使う大きなデータを、検証のあとまで持ち続けない");
  await t("交差検証の本体(同期の関数)が返すのは、小さな結果だけ(全試合ぶんの特徴量を返さない)", () => {
    const gate = mt.corpusGateOptions({});
    const DRAW = 0.15;
    const step = mt.corpusCvGateStep({
      rows: ROWS.map((r) => ({ ...r })), base: W0, runAt: RUN, corpusGate: gate, ratingOpts: { xgAlpha: 0, xi: undefined, perLeagueHomeAdv: false },
      guardRecords: [], chooseDrawBand: () => ({ chosen: DRAW, detail: { chosen: DRAW, default: DRAW } }), drawBandDefault: DRAW, onStep: () => {},
    });
    assert.deepStrictEqual(Object.keys(step).sort(), ["candidateFormDetail", "candidateWeights", "corpusCv", "cvLeagueTableJa", "decision", "drawBandChosen", "drawBandDetail", "gradFit", "newEval", "oldEval", "ownGuard"]);
    const size = JSON.stringify(step).length;
    assert.ok(size < 20000, `返す結果が大きい(${size}文字)。全試合ぶんのデータを返していないか`);
    assert.strictEqual(typeof step.decision.adopt, "boolean"); assert.ok(step.corpusCv && Number.isFinite(step.corpusCv.n));
  });
  await t("交差検証の関門では、学習用の行(古い7割)にレーティングの値を付けない(付けられる件数は数える)。従来の関門では、これまでどおり付ける", async () => {
    const src = fs.readFileSync(path.join(S, "learning", "modelTuning.js"), "utf8");
    assert.ok(/const ratingsAttachedTrain = corpusGate\.mode === "cv" \? countAttachable\(train, ratingsTrain\) : attachRatings\(train, ratingsTrain\);/.test(src));
    assert.ok(/const ratingsAttachedTest = attachRatings\(test, ratingsTrain\);/.test(src));
    // 記録の件数(付けられた行の数)は、関門の種類によらず同じ
    const mockCv = createMockRedis(); await seedDataset(mockCv, RUN);
    const cvOut = normalOut;
    const mockLg = createMockRedis(); await seedDataset(mockLg, RUN);
    const lgOut = await mt.tuneModelOnHistory(depsOf(mockLg), W0, RUN, { dateKey: "2026-11-18", guardRecords: [], gateMode: "legacy" });
    assert.strictEqual(lgOut.gateMode, "legacy"); assert.strictEqual(lgOut.memoryCheck, null, "従来の関門では、交差検証の前の確認はしない");
    assert.ok(cvOut.teamRatings.attachedTrain > 500);
    assert.strictEqual(cvOut.teamRatings.attachedTrain, lgOut.teamRatings.attachedTrain); assert.strictEqual(cvOut.teamRatings.attachedTest, lgOut.teamRatings.attachedTest);
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
