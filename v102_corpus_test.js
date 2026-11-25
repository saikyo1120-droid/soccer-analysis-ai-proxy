"use strict";
/**
 * v102(2026年11月17日)・B「過去試合を主な教材に」の検証
 * ----------------------------------------------------------------------------
 *   過去試合の行(コーパス)の特徴量を本番の予想と同じ定義にそろえ、採否を「時系列の前向き交差検証」で決める。
 *   ここで確かめること:
 *     1. 行の特徴量が、本番と同じ定義(フォーム5試合・得点/失点10試合・シーズンの勝点・会場別の勝率・連戦・対戦成績)
 *     2. どの行も「その試合より前」だけから作られる(未来の試合・その試合自身の結果を変えても変わらない)
 *     3. 前向きの交差検証: レーティングも重みも、検証する時期より前の試合だけで作る
 *     4. 合成データで「本物の改善は通る/偶然は通らない」
 *     5. 自社予想の記録での確認(悪化するなら採用しない)
 *     6. 毎日の調整(tuneModelOnHistory)に組み込まれ、採用・据え置き・旧関門の切り替えが正しく動く
 *     7. 画面に出す理由の文・リーグ別の表
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const S = __dirname;
const hb = require(path.join(S, "learning", "historicalBackfill.js"));
const mt = require(path.join(S, "learning", "modelTuning.js"));
const pm = require(path.join(S, "learning", "predictionModel.js"));
const cvg = require(path.join(S, "learning", "cvGate.js"));
const { computeFormScore } = require(path.join(S, "learning", "dailyJob.js"));

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

function rng(seed0) { let seed = seed0 >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const poisson = (rnd, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * 合成の試合: leagues リーグ × seasons シーズンの総当たり(1チーム teams、週1節)。
 * strength > 0 のとき、チームごとに攻撃力・守備力の差がある(レーティングと特徴量から学べる信号がある)。
 */
function synthMatches(o) {
  const rnd = rng(o.seed || 1);
  const matches = []; let id = 1;
  const nT = o.teams || 12;
  for (let l = 0; l < (o.leagues || 2); l++) {
    const leagueId = (o.leagueIds && o.leagueIds[l]) || 39 + l * 1000;
    const teams = Array.from({ length: nT }, (_, i) => ({ id: (l + 1) * 100 + i + 1, att: (rnd() - 0.5) * (o.strength ?? 0.8), def: (rnd() - 0.5) * (o.strength ?? 0.8) * 0.75 }));
    for (let s = 0; s < (o.seasons || 2); s++) {
      const year = (o.firstYear || 2022) + s; let day = 0;
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
        day += o.dayStep || 7;
      }
    }
  }
  matches.sort((x, y) => new Date(x.date) - new Date(y.date) || x.id - y.id);
  return matches;
}
const W0 = { ...pm.EXTENDED_DEFAULT_WEIGHTS };
const GATE = mt.corpusGateOptions({});

function createMockRedis() {
  const store = new Map();
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
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
  return { store, upstashCmd, upstashGetJSON, upstashSetJSON };
}

(async () => {
  console.log("■ 1. 行の特徴量は、本番と同じ定義");
  await t("手で数えた値と一致する: フォーム=直近5試合の得失点差の平均/得点・失点=直近10試合の平均/会場別の勝率/連戦/シーズンの勝点/対戦成績", () => {
    // チーム1 の試合を、手で数えられる形で並べる(相手は 2〜9。週1試合、最後の2試合だけ3日おき)
    const day = (n) => new Date(Date.UTC(2026, 7, 1, 12) + n * 86400000).toISOString();
    const M = [];
    let id = 1;
    const add = (n, home, away, hg, ag, league, season) => M.push({ id: id++, date: day(n), leagueId: league || 39, season: season || 2026, homeId: home, awayId: away, homeName: "T" + home, awayName: "T" + away, hg, ag });
    // 相手側にも履歴が要る(3試合以上で行になる)ので、相手どうしの試合を先に入れておく
    for (let k = 0; k < 4; k++) { add(k, 2, 3, 1, 1); add(k, 4, 5, 0, 0); add(k, 6, 7, 2, 2); add(k, 8, 9, 1, 0); }
    // チーム1: [会場, 得点, 失点]。ホーム=H
    const t1 = [["H", 2, 0, 2], ["A", 1, 1, 3], ["H", 0, 1, 4], ["A", 3, 1, 5], ["H", 2, 2, 6], ["A", 0, 2, 7], ["H", 1, 0, 8], ["A", 2, 1, 9], ["H", 4, 0, 2], ["A", 1, 3, 3], ["H", 1, 1, 4]];
    let n = 10;
    for (let i = 0; i < t1.length; i++) {
      const [v, gf, ga, opp] = t1[i];
      if (v === "H") add(n, 1, opp, gf, ga); else add(n, opp, 1, ga, gf);
      n += i >= 9 ? 3 : 7; // 10試合め→11試合めは3日おき
    }
    // 12試合め(検査する試合): チーム1 がホームで、チーム3 と対戦。11試合めから3日後
    add(n, 1, 3, 1, 0);
    const rows = hb.buildTrainingRows(M);
    const row = rows.find((r) => r.fixtureId === id - 1);
    assert.ok(row, "検査する試合の行が無い");
    const hist = t1; // その試合より前のチーム1の11試合
    const last10 = hist.slice(-10), last5 = hist.slice(-5);
    assert.strictEqual(row.homeCtx.sampleSize, 10);
    assert.strictEqual(row.homeCtx.avgGoalsFor, r2(last10.reduce((s, x) => s + x[1], 0) / 10));
    assert.strictEqual(row.homeCtx.avgGoalsAgainst, r2(last10.reduce((s, x) => s + x[2], 0) / 10));
    assert.strictEqual(row.homeCtx.formScore, r2(last5.reduce((s, x) => s + (x[1] - x[2]), 0) / 5));
    // 本番の関数(dailyJob.computeFormScore)に同じ5試合を渡した値とも一致する
    //   本番は「直近10試合を新しい順に並べ、先頭の5試合」を使う。11試合ぜんぶを日付つきで渡して、同じ5試合が選ばれることも確かめる
    const asApiFixtures = hist.map((x, i) => (x[0] === "H"
      ? { fixture: { date: day(100 + i) }, teams: { home: { id: 1 }, away: { id: 99 } }, goals: { home: x[1], away: x[2] } }
      : { fixture: { date: day(100 + i) }, teams: { home: { id: 99 }, away: { id: 1 } }, goals: { home: x[2], away: x[1] } }));
    const prod = computeFormScore(asApiFixtures.slice(-10), 1);
    assert.strictEqual(row.homeCtx.formScore, prod.currentFormScore, "本番のフォームの計算と一致しない");
    assert.strictEqual(prod.sampleSize, 10);
    // 会場別: 直近10試合のうちホームの試合の勝率
    const homeGames = last10.filter((x) => x[0] === "H");
    assert.strictEqual(row.homeCtx.homeVenueWinRate, r2(homeGames.filter((x) => x[1] > x[2]).length / homeGames.length));
    assert.strictEqual(row.homeCtx.awayVenueWinRate, null, "ホーム側にアウェイの勝率を入れない");
    // 連戦: キックオフ前7日間の試合数(11試合め=3日前・10試合め=6日前 → 2)
    assert.strictEqual(row.homeCtx.matchesLast7Days, 2);
    // シーズンの勝点: その試合より前の11試合の 勝点÷試合数(直近10試合ではない)
    const pts = hist.reduce((s, x) => s + (x[1] > x[2] ? 3 : x[1] === x[2] ? 1 : 0), 0);
    assert.strictEqual(row.homeCtx.pointsPerGame, r4(pts / hist.length));
    // 対戦成績: チーム1とチーム3の、それより前の直接対戦(t1 の2番め=アウェイで1-1、10番め=アウェイで1-3)
    assert.deepStrictEqual(row.h2h, { homeSideWins: 0, awaySideWins: 1, sampleSize: 2 });
    assert.strictEqual(row.season, 2026); assert.strictEqual(row.actualWinner, "home");
    // アウェイ側(チーム3)は、アウェイの勝率だけを持つ
    assert.strictEqual(row.awayCtx.homeVenueWinRate, null); assert.ok(row.awayCtx.awayVenueWinRate === null || Number.isFinite(row.awayCtx.awayVenueWinRate));
    // 特徴量にすると、差の向きが本番と同じ(computeMatchFeatures)
    const f = pm.computeMatchFeatures(row.homeCtx, row.awayCtx, row.h2h);
    assert.strictEqual(f.headToHeadDiff, -1); assert.strictEqual(f.fatigueDiff, row.awayCtx.matchesLast7Days - 2);
    assert.strictEqual(f.formDiff, row.homeCtx.formScore - row.awayCtx.formScore);
    assert.strictEqual(f.standingsDiff, row.homeCtx.pointsPerGame - row.awayCtx.pointsPerGame);
  });
  await t("シーズンの勝点はシーズンごと: 新しいシーズンの初戦は「まだ無い」(null)。前のシーズンの成績を持ち越さない", () => {
    const M = synthMatches({ leagues: 1, teams: 6, seasons: 2, seed: 4 });
    const rows = hb.buildTrainingRows(M);
    const firstOf2023 = rows.filter((r) => r.season === 2023).slice(0, 3);
    assert.ok(firstOf2023.length === 3);
    for (const r of firstOf2023) { assert.strictEqual(r.homeCtx.pointsPerGame, null); assert.strictEqual(r.awayCtx.pointsPerGame, null); assert.strictEqual(pm.computeMatchFeatures(r.homeCtx, r.awayCtx, r.h2h).standingsDiff, 0); }
    // 2節め以降は値がある。フォーム(直近5試合)はシーズンをまたいで続く(本番の「直近の試合」と同じ)
    const later = rows.filter((r) => r.season === 2023)[5];
    assert.ok(Number.isFinite(later.homeCtx.pointsPerGame)); assert.ok(Number.isFinite(firstOf2023[0].homeCtx.formScore));
  });
  await t("カップ戦の勝点は、そのチームの国内リーグの表から取る(45日以内に国内リーグの試合があるときだけ)。カップ戦の結果は表に入れない", () => {
    const day = (n) => new Date(Date.UTC(2026, 7, 1, 12) + n * 86400000).toISOString();
    const M = []; let id = 1;
    const add = (n, league, home, away, hg, ag) => M.push({ id: id++, date: day(n), leagueId: league, season: 2026, homeId: home, awayId: away, homeName: "T" + home, awayName: "T" + away, hg, ag });
    for (let k = 0; k < 4; k++) { add(k * 7, 39, 1, 2, 2, 0); add(k * 7, 140, 3, 4, 0, 1); } // 1 は4勝(勝点12/4)、3 は4敗(0/4)
    add(30, 2, 1, 3, 5, 0);   // カップ戦①(国内リーグの最後の試合から9日後)
    add(33, 2, 3, 1, 0, 0);   // カップ戦②: ①の結果が表に入っていないこと
    add(120, 2, 1, 3, 1, 1);  // カップ戦③: 国内リーグの最後の試合から 99日後 → 表は使わない
    const rows = hb.buildTrainingRows(M);
    const c1 = rows.find((r) => r.fixtureId === id - 3), c2 = rows.find((r) => r.fixtureId === id - 2), c3 = rows.find((r) => r.fixtureId === id - 1);
    assert.strictEqual(c1.homeCtx.pointsPerGame, 3); assert.strictEqual(c1.awayCtx.pointsPerGame, 0);
    assert.strictEqual(c2.homeCtx.pointsPerGame, 0, "カップ戦の結果が国内リーグの表に入った"); assert.strictEqual(c2.awayCtx.pointsPerGame, 3);
    assert.strictEqual(c3.homeCtx.pointsPerGame, null); assert.strictEqual(c3.awayCtx.pointsPerGame, null);
    assert.deepStrictEqual(c2.h2h, { homeSideWins: 0, awaySideWins: 1, sampleSize: 1 }, "対戦成績はカップ戦も数える(本番の直接対戦の記録と同じ)");
  });
  await t("履歴が3試合に満たないチームの試合は行にしない(推定しない)。取れない値は null → 特徴量は 0", () => {
    const M = synthMatches({ leagues: 1, teams: 6, seasons: 1, seed: 9 });
    const rows = hb.buildTrainingRows(M);
    const firstRowIdx = M.findIndex((m) => m.id === rows[0].fixtureId);
    assert.ok(firstRowIdx >= 9, `最初の行は ${firstRowIdx} 試合め(各チーム3試合=9試合より後)`);
    assert.ok(rows.length < M.length);
    const f = pm.computeMatchFeatures({ formScore: 1, avgGoalsFor: null, avgGoalsAgainst: 1, pointsPerGame: null, homeVenueWinRate: null, matchesLast7Days: null }, { formScore: 0, avgGoalsFor: 1, avgGoalsAgainst: 1, pointsPerGame: 1.5, awayVenueWinRate: 0.5, matchesLast7Days: 1 }, null);
    assert.deepStrictEqual([f.goalRateDiff, f.standingsDiff, f.venueDiff, f.fatigueDiff, f.headToHeadDiff], [0, 0, 0, 0, 0]);
  });

  console.log("■ 2. 未来を見ない");
  const MM = synthMatches({ leagues: 2, teams: 10, seasons: 2, seed: 21 });
  const ROWS = hb.buildTrainingRows(MM);
  const strip = (r) => JSON.stringify({ h: r.homeCtx, a: r.awayCtx, q: r.h2h, s: r.season, l: r.leagueId });
  await t("その試合自身の結果を変えても、その行の特徴量は変わらない(答えを見ていない)", () => {
    for (const idx of [30, 100, 200, MM.length - 1]) {
      const changed = MM.map((m, i) => (i === idx ? { ...m, hg: m.hg + 5, ag: 0 } : m));
      const rows2 = hb.buildTrainingRows(changed);
      const a = ROWS.find((r) => r.fixtureId === MM[idx].id), b = rows2.find((r) => r.fixtureId === MM[idx].id);
      if (!a) continue;
      assert.strictEqual(strip(b), strip(a), `試合 ${idx}`);
    }
  });
  await t("ある時点より後の試合の結果をすべて変えても、それより前の行は1つも変わらない", () => {
    for (const cut of [50, 180, 300]) {
      const changed = MM.map((m, i) => (i >= cut ? { ...m, hg: (m.ag + 3) % 6, ag: (m.hg + 1) % 4 } : m));
      const rows2 = hb.buildTrainingRows(changed);
      const cutMs = Date.parse(MM[cut].date);
      const before = ROWS.filter((r) => MM.findIndex((m) => m.id === r.fixtureId) < cut);
      assert.ok(before.length > 10);
      for (const a of before) {
        const b = rows2.find((r) => r.fixtureId === a.fixtureId);
        assert.strictEqual(strip(b), strip(a), `試合 ${a.fixtureId}(境 ${cut})`);
        assert.ok(Date.parse(a.date) <= cutMs);
      }
      // 境より後の行は(結果が変わったので)変わるものがある = この検査が空振りしていない
      const after = ROWS.filter((r) => MM.findIndex((m) => m.id === r.fixtureId) > cut + 20);
      assert.ok(after.some((a) => strip(rows2.find((r) => r.fixtureId === a.fixtureId)) !== strip(a)));
    }
  });
  await t("後ろに試合を足しても、前の行は変わらない(毎日データが増えても、過去の行は同じ)", () => {
    const shorter = hb.buildTrainingRows(MM.slice(0, 250));
    for (const a of shorter) assert.strictEqual(strip(ROWS.find((r) => r.fixtureId === a.fixtureId)), strip(a));
  });

  console.log("■ 3. 前向きの交差検証は、検証する時期より前だけで学習する");
  // レーティングは1チームにつき40試合以上が要る(teamRatings.MIN_MATCHES_FOR_RATING)。最初の時期(全体の2割)だけでも足りる長さにする
const BIG = synthMatches({ leagues: 2, teams: 12, seasons: 11, seed: 33, strength: 0.9 });
  const BIGROWS = hb.buildTrainingRows(BIG);
  const RUNAT = new Date(Date.parse(BIG[BIG.length - 1].date) + 86400000);
  let RES;
  await t("時期ごとのレーティングは「それより前の行」だけで学習する。最初の時期にはレーティングを付けない", () => {
    RES = mt.corpusForwardCv(BIGROWS, W0, RUNAT, { xgAlpha: 0, xi: 0.0065 }, GATE);
    const blocks = cvg.timeBlocks(BIGROWS.length, 5);
    assert.deepStrictEqual(RES.blocks, blocks);
    assert.deepStrictEqual(RES.ratingFits.map((f) => [f.block, f.rows]), blocks.slice(1).map((b, i) => [i + 1, b[0]]), "レーティングの学習に使った行数が、時期の始まりの位置と一致しない");
    assert.ok(RES.ratingFits.every((f) => f.available && f.teams > 0 && !f.error));
    for (let i = blocks[0][0]; i < blocks[0][1]; i++) { assert.strictEqual(RES.prepared[i].features.ratingLambdaDiff, 0); assert.strictEqual(RES.prepared[i].features.ratingLambdaSum, 0); }
    assert.ok(RES.prepared.slice(blocks[1][0], blocks[1][1]).some((r) => r.features.ratingLambdaDiff !== 0), "2つめの時期にレーティングが付いていない");
    assert.strictEqual(RES.prepared.length, BIGROWS.length);
  });
  await t("行に元から付いているレーティング由来の値(全体で学習した値=その試合の結果を見ている)は使わない", () => {
    const tainted = BIGROWS.map((r) => ({ ...r, homeCtx: { ...r.homeCtx, ratingExpGoals: 9 }, awayCtx: { ...r.awayCtx, ratingExpGoals: 0.1 } }));
    const res2 = mt.corpusForwardCv(tainted, W0, RUNAT, { xgAlpha: 0, xi: 0.0065 }, GATE);
    for (const i of [0, 5, 400, 900, BIGROWS.length - 1]) assert.deepStrictEqual(res2.prepared[i].features, RES.prepared[i].features, `行 ${i}`);
    assert.strictEqual(res2.cv.gain, RES.cv.gain);
  });
  await t("最後の時期の結果だけを変えても、それより前の時期の特徴量・候補の重み・成績は変わらない(未来を見ていない)", () => {
    const blocks = RES.blocks;
    const lastStart = blocks[4][0];
    const changed = BIGROWS.map((r, i) => (i >= lastStart ? { ...r, actualHomeGoals: r.actualAwayGoals, actualAwayGoals: r.actualHomeGoals, actualWinner: r.actualWinner === "home" ? "away" : r.actualWinner === "away" ? "home" : "draw" } : r));
    const res2 = mt.corpusForwardCv(changed, W0, RUNAT, { xgAlpha: 0, xi: 0.0065 }, GATE);
    for (let i = 0; i < blocks[4][1]; i += 37) assert.deepStrictEqual(res2.prepared[i].features, RES.prepared[i].features, `行 ${i} の特徴量`);
    for (const f of [1, 2, 3, 4]) assert.deepStrictEqual(res2.foldWeights[f], RES.foldWeights[f], `時期 ${f + 1} で試す重み(それより前だけで学習)`);
    const g1 = RES.cv.folds.map((f) => f.gain), g2 = res2.cv.folds.map((f) => f.gain);
    assert.deepStrictEqual(g2.slice(0, 3), g1.slice(0, 3), "前の時期の成績が、最後の時期の結果で変わった");
    assert.notStrictEqual(g2[3], g1[3], "最後の時期の成績は変わるはず(この検査が空振りしていない)");
  });
  await t("交差検証で比べるのは後ろ4つの時期(全体の約8割)。リーグ別の内訳は全体と同じ行を束ね直したもの", () => {
    const n4 = RES.blocks.slice(1).reduce((s, b) => s + (b[1] - b[0]), 0);
    assert.strictEqual(RES.cv.n, n4); assert.strictEqual(RES.cv.scheme, "forward"); assert.strictEqual(RES.cv.foldsWithCandidate, 4);
    assert.strictEqual(RES.cv.byGroup.reduce((s, g) => s + g.n, 0), RES.cv.n);
    const pooled = RES.cv.byGroup.reduce((s, g) => s + g.gain * g.n, 0) / RES.cv.n;
    assert.ok(Math.abs(pooled - RES.cv.gain) < 1e-9, `${pooled} vs ${RES.cv.gain}`);
    assert.strictEqual(RES.cv.byGroup.length, 2);
  });

  console.log("■ 4. 本物の改善は通る・偶然は通らない");
  await t("現行の重みが悪い(地力の差を使っていない)とき: 改善が確かめられて通り、全件で学習し直した重みが返る", () => {
    assert.strictEqual(RES.decision.pass, true, RES.decision.reasonJa);
    assert.ok(RES.cv.gain >= 0.001 && RES.cv.z >= 1.64 && RES.cv.positiveFolds >= 3, JSON.stringify({ g: RES.cv.gain, z: RES.cv.z, p: RES.cv.positiveFolds }));
    assert.ok(RES.finalWeights && pm.isSaneWeights(RES.finalWeights));
    assert.ok(/条件をすべて満たしました。$/.test(RES.decision.reasonJa));
    // 学習するのは、過去試合に実際に値がある特徴量の重みだけ(市場オッズ・怪我・xG・出場停止・主力評価点は動かさない)
    for (const k of ["marketEdgeSensitivity", "injurySensitivity", "suspensionSensitivity", "xgSensitivity", "squadRatingSensitivity", "clubEloSensitivity", "topScorerSensitivity", "marketBlend", "apifbBlend", "drawBand"]) {
      if (k in W0) assert.strictEqual(RES.finalWeights[k], W0[k], `${k} が動いた`);
      assert.ok(!RES.keys.includes(k), `${k} を学習の対象にしている`);
    }
    for (const k of ["rho", "homeBase", "awayBase"]) assert.ok(RES.keys.includes(k));
    assert.ok(RES.keys.some((k) => /rating/i.test(k)), "レーティングの重みを学習の対象にしていない: " + RES.keys.join(","));
  });
  await t("現行の重みが既に最良(その重みで学習し直したもの)のとき: 学習し直しても改善は確かめられず、通らない", () => {
    // 1回めで全件から学習した重みを「現行」にして、同じデータでもう一度かける → もう伸びしろは無い
    const res2 = mt.corpusForwardCv(BIGROWS, RES.finalWeights, RUNAT, { xgAlpha: 0, xi: 0.0065 }, GATE);
    assert.strictEqual(res2.decision.pass, false, JSON.stringify({ g: res2.cv.gain, z: res2.cv.z, p: res2.cv.positiveFolds }));
    assert.strictEqual(res2.finalWeights, null, "通っていないのに、全件で学習し直した");
    assert.ok(res2.cv.gain < 0.001);
  });
  await t("結果が特徴量と無関係な世界(どのチームも同じ強さ)では、何度やっても通らない(偶然の通過 0/6)", () => {
    let passed = 0; const seen = [];
    for (let seed = 1; seed <= 6; seed++) {
      const rows = hb.buildTrainingRows(synthMatches({ leagues: 3, teams: 12, seasons: 3, seed: 100 + seed, strength: 0 }));
      // 現行の重みは、この世界でいちばん良い「平均の得点だけ」の重み(特徴量の重みは 0)
      const base = { ...W0 };
      for (const wKey of [...Object.values(pm.FEATURE_WEIGHT_MAP), ...Object.values(pm.FEATURE_SUM_WEIGHT_MAP)]) base[wKey] = 0;
      base.homeBase = Math.exp(0.3); base.awayBase = Math.exp(0.05); base.rho = 0;
      const res = mt.corpusForwardCv(rows, base, new Date(Date.parse(rows[rows.length - 1].date) + 86400000), { xgAlpha: 0, xi: 0.0065 }, GATE);
      seen.push([r4(res.cv.gain), Math.round(res.cv.z * 100) / 100, res.cv.positiveFolds]);
      if (res.decision.pass) passed++;
    }
    assert.strictEqual(passed, 0, "偶然で通った: " + JSON.stringify(seen));
  });
  await t("件数が足りないときは判断しない(検証 1,000件未満)。関門の条件は環境変数で変えられる", () => {
    const small = hb.buildTrainingRows(synthMatches({ leagues: 1, teams: 10, seasons: 2, seed: 5 }));
    const res = mt.corpusForwardCv(small, W0, new Date(Date.parse(small[small.length - 1].date) + 86400000), { xgAlpha: 0, xi: 0.0065 }, GATE);
    assert.strictEqual(res.decision.pass, false); assert.ok(/統計的に判断できる件数|候補を作れなかった/.test(res.decision.reasonJa), res.decision.reasonJa);
    assert.deepStrictEqual(mt.CORPUS_CV_DEFAULTS, { folds: 5, minGain: 0.001, minZ: 1.64, accTolPt: 0.5, minN: 1000, iterations: 25, guardMinRecords: 100, guardMaxLoss: 0.002 });
    assert.strictEqual(GATE.mode, "cv");
    const saved = { ...process.env };
    try {
      process.env.CORPUS_GATE_MODE = "legacy"; process.env.CORPUS_GATE_CV_FOLDS = "4"; process.env.CORPUS_GATE_MIN_Z = "2.5"; process.env.CORPUS_GATE_MIN_LOGLOSS_GAIN = "0.003"; process.env.CORPUS_GATE_ACCURACY_TOLERANCE_PT = "1";
      const g = mt.corpusGateOptions({});
      assert.deepStrictEqual([g.mode, g.folds, g.minZ, g.minGain, g.accTolPt], ["legacy", 4, 2.5, 0.003, 1]);
      assert.strictEqual(mt.corpusGateOptions({ gateMode: "cv" }).mode, "cv", "呼び出し側の指定が環境変数より優先");
      process.env.CORPUS_GATE_CV_FOLDS = "99"; assert.strictEqual(mt.corpusGateOptions({}).folds, 10);
      process.env.CORPUS_GATE_CV_FOLDS = "abc"; assert.strictEqual(mt.corpusGateOptions({}).folds, 5);
    } finally { for (const k of ["CORPUS_GATE_MODE", "CORPUS_GATE_CV_FOLDS", "CORPUS_GATE_MIN_Z", "CORPUS_GATE_MIN_LOGLOSS_GAIN", "CORPUS_GATE_ACCURACY_TOLERANCE_PT"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  });

  console.log("■ 5. 自社予想の記録での確認");
  const ownRecords = (n, trueW, seed) => {
    const rnd = rng(seed); const out = [];
    for (let i = 0; i < n; i++) {
      const features = { formDiff: (rnd() - 0.5) * 4, venueDiff: (rnd() - 0.5) * 1.2, standingsDiff: (rnd() - 0.5) * 2, marketEdge: (rnd() - 0.5) * 0.8 };
      const { homeLambda, awayLambda } = pm.predictOutcomeV2(features, trueW);
      const hg = poisson(rnd, homeLambda), ag = poisson(rnd, awayLambda);
      out.push({ resolved: true, features, actualWinner: hg > ag ? "home" : hg < ag ? "away" : "draw" });
    }
    return out;
  };
  await t("記録が100件未満なら確認しない(通す・その旨を残す)。現行より悪くなる重みは止める。同等以上の重みは通す", () => {
    const truth = { ...W0, sensitivity: 0.25, standingsSensitivity: 0.2 };
    const recs = ownRecords(1500, truth, 7);
    const few = mt.ownRecordsGuard(recs.slice(0, 99), W0, truth, GATE);
    assert.deepStrictEqual([few.checked, few.ok, few.n], [false, true, 99]); assert.ok(/99件で、確認に必要な100件に達していない/.test(few.reasonJa));
    const good = mt.ownRecordsGuard(recs, W0, truth, GATE);
    assert.strictEqual(good.checked, true); assert.strictEqual(good.ok, true); assert.ok(good.gain > 0 && good.candLogLoss < good.baseLogLoss); assert.ok(/でも悪化していません/.test(good.reasonJa));
    const bad = mt.ownRecordsGuard(recs, truth, { ...truth, sensitivity: -0.4, standingsSensitivity: -0.3 }, GATE);
    assert.strictEqual(bad.ok, false); assert.ok(bad.gain < -0.002); assert.ok(/では悪化しました/.test(bad.reasonJa)); assert.ok(!/。.+。/.test(bad.reasonJa.slice(0, -1)), "理由の文の途中に句点がある(画面の訳が1文ずつ区切れない): " + bad.reasonJa);
    const same = mt.ownRecordsGuard(recs, truth, { ...truth }, GATE);
    assert.strictEqual(same.ok, true); assert.strictEqual(same.gain, 0);
    // 使えない記録(特徴量なし・結果なし)は数えない
    assert.strictEqual(mt.ownRecordsGuard([{ actualWinner: "home" }, { features: {} }, null, ...recs.slice(0, 120)], W0, truth, GATE).n, 120);
    assert.strictEqual(mt.ownRecordsGuard(null, W0, truth, GATE).checked, false);
  });

  console.log("■ 6. 毎日の調整(tuneModelOnHistory)への組み込み");
  // 保存済みのデータセットがある状態を作る(取り直しは起きない)
  async function tuneWith(rows, base, opts, env) {
    const mock = createMockRedis();
    const runAt = new Date(Date.parse(rows[rows.length - 1].date) + 86400000);
    await hb.saveDataset({ upstashEnabled: true, ...mock }, rows, { builtAt: runAt.toISOString(), leagues: hb.DEFAULT_BACKFILL_LEAGUES.filter((l) => !l.verify).map((l) => l.id) });
    await mock.upstashSetJSON(hb.LEAGUE_CHECK_KEY, { byId: Object.fromEntries([...hb.VERIFY_LEAGUE_IDS].map((id) => [id, { ok: false, reasonJa: "テスト用", checkedAt: runAt.toISOString(), specVersion: 1 }])) });
    await mock.upstashSetJSON("learn:weights", base);
    const beats = [];
    const saved = {};
    for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    let out;
    try {
      out = await mt.tuneModelOnHistory({ upstashEnabled: true, ...mock, callApiFootball: async () => ({ response: [] }), heartbeat: async (d) => { beats.push(d); } }, base, runAt, { dateKey: "2026-11-18", ...(opts || {}) });
    } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    const log = (mock.store.get(mt.TUNING_LOG_KEY) || []).map((x) => JSON.parse(x));
    return { out, mock, beats, log, weightsAfter: JSON.parse(mock.store.get("learn:weights")) };
  }
  const BASE33 = { ...W0, version: 33, updatedAt: "2026-10-15T00:00:00.000Z" };
  let ADOPT;
  await t("改善が確かめられたとき: 重みを保存する(版が1つ進む・method は corpus_cv)。記録に交差検証の中身・リーグ別の表が残る", async () => {
    ADOPT = await tuneWith(BIGROWS, BASE33, { guardRecords: [] });
    const o = ADOPT.out;
    assert.strictEqual(o.adopted, true, o.reasonJa); assert.strictEqual(o.gateMode, "cv"); assert.strictEqual(o.method, "corpus_cv");
    assert.strictEqual(ADOPT.weightsAfter.version, 34); assert.notStrictEqual(ADOPT.weightsAfter.updatedAt, BASE33.updatedAt);
    assert.ok(pm.isSaneWeights(ADOPT.weightsAfter));
    assert.ok(o.cv && o.cv.passed === true && o.cv.scheme === "forward" && o.cv.folds === 5 && o.cv.n > 1000 && o.cv.pooledGain >= 0.001 && o.cv.z >= 1.64);
    assert.ok(Array.isArray(o.cv.byLeague) && o.cv.byLeague.length === 2 && o.cv.byLeague.every((l) => Number.isFinite(l.baseLogLoss) && Number.isFinite(l.candLogLoss) && typeof l.verdictJa === "string"));
    assert.ok(Array.isArray(o.cv.perFold) && o.cv.perFold.length === 4 && o.cv.ratingFits.length === 4);
    assert.deepStrictEqual([o.ownRecordsGuard.checked, o.ownRecordsGuard.ok], [false, true]);
    assert.ok(o.holdoutBaseEval && Number.isFinite(o.holdoutBaseEval.logLoss), "従来と同じ測り方(新しい3割)の現行の成績が無い");
    assert.ok(/^過去試合\d+件を、古い順に5つの時期に分け、/.test(o.reasonJa) && /全件で学習し直した重みを採用します。$/.test(o.reasonJa), o.reasonJa);
    assert.ok(/^\| リーグ \| 試合数 \| LogLoss\(現行→候補\) \| 的中率\(現行→候補\) \| 判定 \|/.test(o.leagueTableJa), String(o.leagueTableJa).slice(0, 80));
    assert.ok(o.leagueTableJa.includes("プレミアリーグ"), "表のリーグ名がIDのまま");
    assert.ok(/全体: 検証\d+件・LogLoss [\d.]+→[\d.]+\(改善 [\d.]+・z=[\d.]+\)/.test(o.leagueTableJa));
    // 記録(履歴)にも同じものが残る
    assert.strictEqual(ADOPT.log.length, 1); assert.strictEqual(ADOPT.log[0].gateMode, "cv"); assert.strictEqual(ADOPT.log[0].method, "corpus_cv"); assert.strictEqual(ADOPT.log[0].adopted, true);
    assert.strictEqual(ADOPT.log[0].date, "2026-11-18"); assert.ok(ADOPT.log[0].cv && ADOPT.log[0].holdoutBaseEval);
    assert.ok(ADOPT.log[0].oldEval.logLoss > ADOPT.log[0].newEval.logLoss, "履歴の LogLoss(束ねた検証での 現行→候補)");
    // 途中で進捗の心拍を打っている
    assert.ok(ADOPT.beats.some((b) => /過去試合の交差検証/.test(b)), JSON.stringify(ADOPT.beats));
    // 学習の対象でない重みは、保存後も元のまま
    for (const k of ["marketEdgeSensitivity", "injurySensitivity", "marketBlend"]) if (k in BASE33) assert.strictEqual(ADOPT.weightsAfter[k], BASE33[k], k);
  });
  await t("改善が確かめられないとき: 重みは1つも変えない(版もそのまま)。理由が残る", async () => {
    const r = await tuneWith(BIGROWS, { ...ADOPT.weightsAfter }, { guardRecords: [] });
    assert.strictEqual(r.out.adopted, false, r.out.reasonJa); assert.strictEqual(r.out.gateMode, "cv");
    assert.strictEqual(r.weightsAfter.version, 34); assert.deepStrictEqual(r.weightsAfter, ADOPT.weightsAfter);
    assert.ok(/モデルは変更しません。$/.test(r.out.reasonJa), r.out.reasonJa);
    assert.strictEqual(r.out.cv.passed, false); assert.strictEqual(r.out.ownRecordsGuard, null);
    assert.ok(typeof r.out.leagueTableJa === "string" && r.out.leagueTableJa.includes("| リーグ |"), "採用しない日も、リーグ別の表は出す");
    assert.strictEqual(r.log[0].adopted, false);
  });
  await t("過去試合では通っても、自社予想の記録で悪化するなら採用しない(重みは変えない)", async () => {
    // 自社予想の記録の世界は「過去試合で学ぶ向きと逆」: 地力の差(レーティングの期待得点の差)が大きいほどアウェイが勝つ。
    //   現行の重みは地力の差を使っていない(重み 0)ので影響を受けず、過去試合で学んだ重み(地力の差を正の向きに使う)だけが悪くなる。
    assert.strictEqual(BASE33.ratingSensitivity || 0, 0, "この検査の前提: 現行の重みは地力の差を使っていない");
    assert.ok(ADOPT.weightsAfter.ratingSensitivity > 0.05, "この検査の前提: 過去試合で学んだ重みは地力の差を正の向きに使う: " + ADOPT.weightsAfter.ratingSensitivity);
    const rnd = rng(77); const recs = [];
    for (let i = 0; i < 600; i++) {
      const d = (rnd() - 0.5) * 1.6;
      const features = { ratingLambdaDiff: d };
      const lamH = Math.max(0.2, 1.4 - d * 0.9), lamA = Math.max(0.2, 1.2 + d * 0.9);
      const hg = poisson(rnd, lamH), ag = poisson(rnd, lamA);
      recs.push({ resolved: true, features, actualWinner: hg > ag ? "home" : hg < ag ? "away" : "draw" });
    }
    const r = await tuneWith(BIGROWS, BASE33, { guardRecords: recs });
    assert.strictEqual(r.out.cv.passed, true, "過去試合の交差検証は通るはず");
    assert.strictEqual(r.out.adopted, false, r.out.reasonJa);
    assert.deepStrictEqual([r.out.ownRecordsGuard.checked, r.out.ownRecordsGuard.ok, r.out.ownRecordsGuard.n], [true, false, 600]);
    assert.strictEqual(r.weightsAfter.version, 33); assert.deepStrictEqual(r.weightsAfter, BASE33);
    assert.ok(/自社予想の記録600件では悪化しました/.test(r.out.reasonJa) && /そのため採用しません。$/.test(r.out.reasonJa), r.out.reasonJa);
  });
  await t("CORPUS_GATE_MODE=legacy で、v101 までの関門(7:3 の1回分割+多指標)に戻る", async () => {
    const r = await tuneWith(BIGROWS, BASE33, { guardRecords: [] }, { CORPUS_GATE_MODE: "legacy" });
    assert.strictEqual(r.out.gateMode, "legacy"); assert.notStrictEqual(r.out.method, "corpus_cv");
    assert.strictEqual(r.out.cv, null); assert.strictEqual(r.out.ownRecordsGuard, null);
    assert.ok(r.out.oldEval && Number.isFinite(r.out.oldEval.brier), "従来の多指標(Brier など)が無い");
    assert.ok(!/前向きの交差検証/.test(r.out.reasonJa || ""));
    assert.ok(typeof r.out.leagueTableJa === "string" && /LogLoss\(旧→新\)/.test(r.out.leagueTableJa), "従来のリーグ別の表が出ていない");
  });

  console.log("■ 7. 画面に出す理由の文・リーグ別の表");
  await t("理由の文は、1文ずつ独立した形で並ぶ(文の中に別の文を埋め込まない = 画面が1文ずつ訳せる)", () => {
    const d = (st) => cvg.decideCvGate(st, { minN: 1000, minGain: 0.001, minZ: 1.64, accTolPt: 0.5 });
    const ok = { n: 36000, gain: 0.0041, se: 0.0009, z: 4.56, accDeltaPt: 0.3, foldsWithCandidate: 4, positiveFolds: 4 };
    const guardOk = { ok: true, reasonJa: "自社予想の記録1601件でも悪化していません(LogLoss 0.9856→0.9841・的中率の変化 +0.2pt)。" };
    const guardNg = { ok: false, reasonJa: "自社予想の記録1601件では悪化しました(LogLoss 0.9856→0.9901・的中率の変化 -0.8pt/許容は LogLoss +0.002 まで・的中率 −0.5pt まで)。" };
    const cases = [
      [{ rows: 45000, folds: 5, decision: d(ok), hasFinalWeights: true, guard: guardOk }, 5, /全件で学習し直した重みを採用します。$/],
      [{ rows: 45000, folds: 5, decision: d(ok), hasFinalWeights: true, guard: guardNg }, 5, /そのため採用しません。$/],
      [{ rows: 45000, folds: 5, decision: d(ok), hasFinalWeights: false, guard: null }, 4, /ため、モデルは変更しません。$/],
      [{ rows: 45000, folds: 5, decision: d({ ...ok, gain: 0.0002 }), hasFinalWeights: false, guard: null }, 3, /モデルは変更しません。$/],
      [{ rows: 45000, folds: 5, decision: d({ ...ok, z: 0.9 }), hasFinalWeights: false, guard: null }, 3, /偶然と区別できる水準/],
      [{ rows: 45000, folds: 5, decision: d({ ...ok, positiveFolds: 2 }), hasFinalWeights: false, guard: null }, 3, /改善した区間が2\/4で/],
      [{ rows: 45000, folds: 5, decision: d({ ...ok, accDeltaPt: -0.9 }), hasFinalWeights: false, guard: null }, 3, /許容幅\(−0\.5pt\)を超えて下がりました/],
      [{ rows: 900, folds: 5, decision: d({ ...ok, n: 720 }), hasFinalWeights: false, guard: null }, 3, /統計的に判断できる件数\(1000件\)/],
      [{ rows: 45000, folds: 5, decision: d({ ...ok, foldsWithCandidate: 0, positiveFolds: 0 }), hasFinalWeights: false, guard: null }, 3, /どの区間でも候補を作れなかった/],
    ];
    for (const [arg, sentences, re] of cases) {
      const s = mt.composeCorpusCvReasonJa(arg);
      assert.ok(re.test(s), s);
      assert.ok(s.startsWith(`過去試合${arg.rows}件を、古い順に5つの時期に分け、前の時期だけで学習した重みを次の時期で確かめました(前向きの交差検証)。`), s);
      assert.strictEqual(s.split("。").length - 1, sentences, `文の数: ${s}`);
      assert.ok(s.endsWith("。") && !/。[)\uFF09]/.test(s), "括弧の中に句点がある: " + s);
      assert.ok(!/折/.test(s), "利用者に見せる文に「折」が残っている: " + s);
    }
  });
  await t("リーグ別の表: 試合の少ないリーグは「判定不可」・有意に良ければ「改善」・有意に悪ければ「悪化」・どちらでもなければ「差は誤差の範囲」", () => {
    const rows = mt.cvLeagueRows({ byGroup: [
      { key: 39, n: 2000, gain: 0.004, z: 3.1, baseNll: 0.99, candNll: 0.986, accBasePct: 52.1, accCandPct: 52.6 },
      { key: 179, n: 900, gain: -0.003, z: -2.0, baseNll: 1.0, candNll: 1.003, accBasePct: 50, accCandPct: 49.5 },
      { key: 253, n: 1500, gain: 0.0004, z: 0.4, baseNll: 1.02, candNll: 1.0196, accBasePct: 47, accCandPct: 47 },
      { key: 9999, n: 40, gain: 0.05, z: 2.5, baseNll: 1.1, candNll: 1.05, accBasePct: 40, accCandPct: 45 },
    ] });
    assert.deepStrictEqual(rows.map((r) => r.verdictJa), ["改善", "悪化", "差は誤差の範囲", "判定不可(試合が少ない)"]);
    assert.deepStrictEqual(rows.map((r) => r.leagueJa), ["プレミアリーグ", "スコティッシュ・プレミアシップ", "MLS(メジャーリーグサッカー)", "リーグ9999"]);
    const table = mt.formatCvLeagueTableJa(rows, { n: 4440, baseLogLoss: 1.0012, candLogLoss: 0.9991, pooledGain: 0.0021, z: 2.4 });
    const lines = table.split("\n");
    assert.strictEqual(lines[0], "| リーグ | 試合数 | LogLoss(現行→候補) | 的中率(現行→候補) | 判定 |");
    assert.strictEqual(lines[2], "| プレミアリーグ | 2000 | 0.99→0.986 | 52.1%→52.6% | 改善 |");
    assert.strictEqual(lines[lines.length - 1], "全体: 検証4440件・LogLoss 1.0012→0.9991(改善 0.0021・z=2.4)");
    assert.strictEqual(mt.formatCvLeagueTableJa([], null), "リーグ別の比較はできませんでした。");
    assert.deepStrictEqual(mt.cvLeagueRows(null), []); assert.deepStrictEqual(mt.cvLeagueRows({}), []);
  });
  await t("毎日の学習は、自社予想の記録を「悪化していないことの確認」に渡し、成長ログに関門の中身を残す", () => {
    const src = fs.readFileSync(path.join(S, "learning", "dailyJob.js"), "utf8");
    for (const s of ["baseForTune, runAt, { dateKey, guardRecords }", "gateMode: modelTuning.gateMode ?? null,", "cv: modelTuning.cv ?? null,", "ownRecordsGuard: modelTuning.ownRecordsGuard ?? null,", "holdoutBaseEval: modelTuning.holdoutBaseEval ?? null,", "leagueChecks: modelTuning.leagueChecks ?? null,", "learnedLeagueIds: activeLeagueIds(),", "callApiFootball: rawCallApiFootball, apiBudget, heartbeat, clubEloLookup, xgLookup, noteWarning: warn }"]) {
      assert.ok(src.includes(s), "無い: " + s);
    }
  });

  console.log("■ 8. 毎日の学習(runDailyLearning)を実際にまわす");
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
  await t("保存済みの過去試合がある状態で1日ぶんの学習をまわす: ④-b が交差検証で採用 → 重みの版が進み、重みの変更履歴・「学習して変更した内容」・成長ログに残る", async () => {
    const { runDailyLearning } = require(path.join(S, "learning", "dailyJob.js"));
    const mock = createFullMockRedis();
    const runAt = new Date(Date.parse(BIGROWS[BIGROWS.length - 1].date) + 86400000);
    const coreIds = hb.DEFAULT_BACKFILL_LEAGUES.filter((l) => !l.verify).map((l) => l.id);
    await hb.saveDataset({ upstashEnabled: true, ...mock }, BIGROWS, { builtAt: new Date(runAt.getTime() - 3600000).toISOString(), leagues: coreIds, droppedOldest: 0 });
    await mock.upstashSetJSON("learn:weights", BASE33);
    const result = await runDailyLearning({
      callApiFootball: async () => ({ response: [] }), resolveTeamId: async () => null,
      upstashEnabled: true, ...mock, now: () => runAt,
    });
    hb.setActivatedLeagues([]);
    const tune = result.modelTuning;
    assert.ok(tune, "成長ログに modelTuning が無い");
    assert.strictEqual(tune.adopted, true, tune.reasonJa); assert.strictEqual(tune.gateMode, "cv"); assert.strictEqual(tune.method, "corpus_cv");
    assert.ok(tune.cv && tune.cv.passed === true && tune.cv.n > 1000 && Array.isArray(tune.cv.byLeague));
    assert.ok(tune.ownRecordsGuard && tune.ownRecordsGuard.checked === false, "自社予想の記録が無いので、確認は「行っていない」と残る");
    assert.ok(tune.holdoutBaseEval && Number.isFinite(tune.holdoutBaseEval.logLoss));
    assert.ok(tune.leagueChecks && tune.leagueChecks.total === 16, "新リーグの照合の結果が成長ログに無い");
    assert.deepStrictEqual(tune.learnedLeagueIds, coreIds, "模擬の提供元は新リーグを返さないので、学習した大会は従来の15のまま");
    assert.strictEqual(tune.leaguesInDataset, 15); assert.strictEqual(tune.droppedOldest, 0);
    // 重みの版
    const w = JSON.parse(mock.store.get("learn:weights"));
    assert.strictEqual(w.version, 34); assert.ok(w.ratingSensitivity > 0.05);
    // 重みの変更履歴(これまで ④-b の採用は載らなかった)
    const history = (mock.store.get("learn:weights:history") || []).map((x) => JSON.parse(x));
    const entry = history.find((h) => h.adopted && h.method === "corpus_cv");
    assert.ok(entry, "過去試合での採用が、重みの変更履歴に残っていない: " + JSON.stringify(history.map((h) => [h.method, h.adopted])));
    assert.strictEqual(entry.gate, "cv"); assert.strictEqual(entry.source, "corpus"); assert.strictEqual(entry.sampleSize, tune.cv.n);
    assert.strictEqual(entry.oldLogLoss, tune.cv.baseLogLoss); assert.strictEqual(entry.newLogLoss, tune.cv.candLogLoss); assert.ok(entry.oldLogLoss > entry.newLogLoss);
    assert.strictEqual(entry.oldWeights.version, 33); assert.strictEqual(entry.newWeights.ratingSensitivity, w.ratingSensitivity);
    assert.strictEqual(entry.note, tune.reasonJa);
    // 画面の「AIが実際に学習して変更した内容」
    const summary = pm.buildLearningSummary(history, 5);
    const shown = summary.find((x) => x.method === "corpus_cv");
    assert.ok(shown, "学習の要約に出ていない");
    assert.strictEqual(shown.methodLabelJa, "過去試合の学習(前向きの交差検証)");
    assert.ok(shown.bullets.some((b) => /チームの地力\(長期レーティング\)の重要度を.*強めました/.test(b)), JSON.stringify(shown.bullets));
    assert.ok(/交差検証で、確率の質を表す LogLoss\(小さいほど良い\)が[\d.]+→[\d.]+に改善したため\(過去試合の学習\(前向きの交差検証\)\)。/.test(shown.reason), shown.reason);
    assert.ok(!/上がったため/.test(shown.reason));
    // ④(自社予想の記録の関門)は、答え合わせ済みの記録が1件も無いので動いていない(重みを変えたのは ④-b だけ)
    assert.strictEqual(result.weightGate, null); assert.strictEqual(result.weightsUpdated, false);
    assert.strictEqual(history.filter((h) => h.adopted).length, 1);
    // 同じ日にもう一度まわしても、履歴に二重に残さない(④-b は1日1回)
    const before = history.filter((h) => h.method === "corpus_cv").length;
    await runDailyLearning({ callApiFootball: async () => ({ response: [] }), resolveTeamId: async () => null, upstashEnabled: true, ...mock, now: () => new Date(runAt.getTime() + 3600000) });
    hb.setActivatedLeagues([]);
    const after = (mock.store.get("learn:weights:history") || []).map((x) => JSON.parse(x)).filter((h) => h.method === "corpus_cv").length;
    assert.strictEqual(after, before, "同じ日の再実行で、採用の記録が二重に残った");
    assert.strictEqual(JSON.parse(mock.store.get("learn:weights")).version, 34, "同じ日の再実行で、重みの版がさらに進んだ");
  });

  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
