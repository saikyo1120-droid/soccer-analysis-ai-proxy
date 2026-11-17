"use strict";
/**
 * v102(2026年11月17日)・画面に出る新しい文の、英語・中国語・スペイン語の訳の検証
 * ----------------------------------------------------------------------------
 *   v102 でサーバーが返す文が変わった(学習している大会の数・過去試合の交差検証の理由・学習の種類の名前など)。
 *   日本語以外の画面で、それらが日本語のまま残らないことを確かめる。
 *   文は、サーバーの実際の関数に作らせる(テストに文を書き写さない = サーバーの文が変わったら、ここで気づく)。
 *   訳は、index.html の中の翻訳の仕組みをそのまま読み込んで実行する(ブラウザは使わない)。
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const S = __dirname;
const hb = require(path.join(S, "learning", "historicalBackfill.js"));
const lc = require(path.join(S, "learning", "learnedCompetitions.js"));
const mt = require(path.join(S, "learning", "modelTuning.js"));
const pm = require(path.join(S, "learning", "predictionModel.js"));
const cvg = require(path.join(S, "learning", "cvGate.js"));
const HTML = fs.readFileSync(path.join(S, "index.html"), "utf8");
const SERVER_SRC = fs.readFileSync(path.join(S, "server.js"), "utf8");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

/** index.html の翻訳の仕組みを、その言語で読み込む(window.t が使える) */
function loadEngine(lang) {
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m, code = null;
  while ((m = re.exec(HTML))) { if (m[2].includes("var X = {};") && m[2].includes("function add(map)")) { code = m[2]; break; } }
  assert.ok(code && code.includes("  window.t = function (s) {"), "翻訳の仕組みが見つからない");
  const sandbox = {
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; }, createElement() { return { setAttribute() {}, appendChild() {}, style: {} }; }, documentElement: { setAttribute() {}, lang: "" }, body: null },
    localStorage: { getItem: (k) => (k === "appLang" ? lang : null), setItem() {} },
    location: { reload() {}, href: "http://localhost/" }, navigator: { language: "en" },
    console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("no fetch")),
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "i18n-engine.js" });
  return sandbox;
}
const ENGINES = { en: loadEngine("en"), zh: loadEngine("zh"), es: loadEngine("es") };
const JA_ANY = /[ぁ-んァ-ヶ一-龥]/;   // 英語・スペイン語: かな・漢字が残っていないこと
const KANA = /[ぁ-んァ-ヶ]/;           // 中国語: 漢字は共有するので、かなが残っていないこと
/** 3言語すべてで、日本語が残らずに訳されること。数字(numbers)がそのまま入っていること */
function assertTranslated(ja, numbers) {
  assert.ok(typeof ja === "string" && ja.length > 0, "文が空");
  for (const lang of ["en", "zh", "es"]) {
    const out = ENGINES[lang].t(ja);
    assert.ok(typeof out === "string" && out.length > 0, `${lang}: 訳が空: ${ja}`);
    assert.notStrictEqual(out, ja, `${lang}: 訳されていない: ${ja}`);
    assert.ok(!(lang === "zh" ? KANA : JA_ANY).test(out), `${lang}: 日本語が残っている: ${out}  ← ${ja}`);
    for (const n of numbers || []) assert.ok(out.includes(String(n)), `${lang}: 数字 ${n} が訳に無い: ${out}`);
  }
}
/** server.js の中の「テンプレート文字列」を1つ取り出して、渡した値で組み立てる(サーバーと同じ文を作るため) */
function serverTemplate(startMarker, vars) {
  const i = SERVER_SRC.indexOf(startMarker);
  assert.ok(i >= 0, "server.js に見つからない: " + startMarker);
  const from = SERVER_SRC.indexOf("`", i);
  let j = from + 1, depth = 0;
  for (; j < SERVER_SRC.length; j++) {
    const c = SERVER_SRC[j];
    if (c === "\\") { j++; continue; }
    if (c === "$" && SERVER_SRC[j + 1] === "{") { depth++; j++; continue; }
    if (depth > 0 && c === "}") { depth--; continue; }
    if (depth === 0 && c === "`") break;
    if (depth > 0 && c === "`") { // 入れ子のテンプレート文字列を読み飛ばす
      let k = j + 1, d2 = 0;
      for (; k < SERVER_SRC.length; k++) { const c2 = SERVER_SRC[k]; if (c2 === "\\") { k++; continue; } if (c2 === "$" && SERVER_SRC[k + 1] === "{") { d2++; k++; continue; } if (d2 > 0 && c2 === "}") { d2--; continue; } if (d2 === 0 && c2 === "`") break; }
      j = k;
    }
  }
  const tpl = SERVER_SRC.slice(from, j + 1);
  const names = Object.keys(vars);
  return new Function(...names, `return ${tpl};`)(...names.map((k) => vars[k])); // eslint-disable-line no-new-func
}
const NEW_IDS = [...hb.VERIFY_LEAGUE_IDS];
const withAllLeagues = (fn) => { hb.setActivatedLeagues(NEW_IDS); try { return fn(); } finally { hb.setActivatedLeagues([]); } };

(async () => {
  console.log("■ 1. 学習している大会の数(決め打ちをやめた文)");
  await t("「学習した大会(◯大会)」と、その説明(従来の15大会のまま/あとから加えたリーグがある)", () => {
    assertTranslated("学習した大会(15大会)", [15]);
    assertTranslated("学習した大会(31大会)", [31]);
    assertTranslated("学習した大会(18大会)", [18]);
    assertTranslated(lc.learnedScopeNoteJa(), [15]);
    withAllLeagues(() => assertTranslated(lc.learnedScopeNoteJa(), [31, 16]));
    hb.setActivatedLeagues([179, 253, 141]); try { assertTranslated(lc.learnedScopeNoteJa(), [18, 3]); } finally { hb.setActivatedLeagues([]); }
  });
  await t("学習していない大会の説明(大会名あり・なし)。数が変わっても訳される", () => {
    assertTranslated(lc.classifyLearnedCompetition(999, null).reasonJa, [15]);
    withAllLeagues(() => {
      assertTranslated(lc.classifyLearnedCompetition(999, null).reasonJa, [31]);
      // 大会名つき(従来は先頭の「「大会名」は」が日本語のまま残っていた)
      const withName = lc.classifyLearnedCompetition(999, "Liga MX").reasonJa;
      assertTranslated(withName, [31, "Liga MX"]);
      assert.ok(/^“Liga MX” isn't in the AI's learning data/.test(ENGINES.en.t(withName)), ENGINES.en.t(withName));
    });
  });
  await t("地力レーティングの説明(サーバーの文をそのまま組み立てる): 従来の15大会のまま・31大会", () => {
    const build = (ratings, unnamedCount) => serverTemplate("noteJa: `${learnedComp.ratingsScopeJa()}の実試合", { learnedComp: lc, ratings, unnamedCount });
    const s15 = build({ matchesUsed: 21824, minMatches: 40 }, 0);
    assert.ok(s15.startsWith("15大会×5シーズン(欧州カップ戦・J1・イングランド2部・ブラジルを含む)の実試合(21824試合)から、"), s15.slice(0, 80));
    assertTranslated(s15, [15, 21824, 40]);
    withAllLeagues(() => {
      const s31 = build({ matchesUsed: 44190, minMatches: 40 }, 0);
      assert.ok(s31.startsWith("31大会×5シーズン(欧州カップ戦・J1・イングランド2部・ブラジル・各国リーグ16大会を含む)の実試合(44190試合)から、"), s31.slice(0, 90));
      assertTranslated(s31, [31, 16, 44190, 40]);
      assertTranslated(build({ matchesUsed: null }, 0), [31, 16]);
      // まだレーティングが無いとき(初回)の文
      const first = serverTemplate("reasonJa: `地力レーティングは、次の朝の学習(", { learnedComp: lc });
      assert.ok(first.includes("(31大会×5シーズンの実試合からの初回学習)"), first);
      assertTranslated(first, [31]);
    });
    assertTranslated(serverTemplate("reasonJa: `地力レーティングは、次の朝の学習(", { learnedComp: lc }), [15]);
  });
  await t("「このAIの予測モデルについて」の説明文(画面の本文そのもの)", () => {
    const m = /<p class="value-note"[^>]*>(🧠 予測モデルは、[^<]+)<\/p>/.exec(HTML);
    assert.ok(m, "説明文が見つからない");
    assert.ok(!/15大会|約200クラブ/.test(m[1]), "数の決め打ちが残っている: " + m[1].slice(0, 80));
    assertTranslated(m[1], [5]);
  });

  console.log("■ 2. 過去試合によるモデル調整(前向きの交差検証)の理由");
  const gate = { minN: 1000, minGain: 0.001, minZ: 1.64, accTolPt: 0.5 };
  const okStats = { n: 36151, gain: 0.0041, se: 0.0009, z: 4.56, accDeltaPt: 0.3, foldsWithCandidate: 4, positiveFolds: 4 };
  const G = mt.corpusGateOptions({});
  // 自社予想の記録での確認の文(実際の関数に作らせる)
  function rng(seed0) { let seed = seed0 >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  const poisson = (rnd, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const W0 = { ...pm.EXTENDED_DEFAULT_WEIGHTS };
  const truth = { ...W0, sensitivity: 0.25, standingsSensitivity: 0.2 };
  const recs = (() => { const rnd = rng(7); const out = []; for (let i = 0; i < 700; i++) { const features = { formDiff: (rnd() - 0.5) * 4, standingsDiff: (rnd() - 0.5) * 2 }; const { homeLambda, awayLambda } = pm.predictOutcomeV2(features, truth); const hg = poisson(rnd, homeLambda), ag = poisson(rnd, awayLambda); out.push({ features, actualWinner: hg > ag ? "home" : hg < ag ? "away" : "draw" }); } return out; })();
  const guardOk = mt.ownRecordsGuard(recs, W0, truth, G);
  const guardNg = mt.ownRecordsGuard(recs, truth, { ...truth, sensitivity: -0.4, standingsSensitivity: -0.3 }, G);
  const guardFew = mt.ownRecordsGuard(recs.slice(0, 60), W0, truth, G);
  await t("前提: 確認の文が3通り(悪化なし・悪化・件数不足)とも作れている", () => {
    assert.deepStrictEqual([guardOk.ok, guardNg.ok, guardFew.checked], [true, false, false]);
  });
  await t("採用する・自社予想の記録で悪化するので採用しない・収束しない・改善が小さい・偶然と区別できない・一部の時期だけ・的中率が下がる・件数不足・候補なし", () => {
    const d = (st) => cvg.decideCvGate(st, gate);
    const cases = [
      { rows: 45190, folds: 5, decision: d(okStats), hasFinalWeights: true, guard: guardOk },
      { rows: 45190, folds: 5, decision: d(okStats), hasFinalWeights: true, guard: guardFew },
      { rows: 45190, folds: 5, decision: d(okStats), hasFinalWeights: true, guard: guardNg },
      { rows: 45190, folds: 5, decision: d(okStats), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, gain: 0.0002 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, gain: -0.0013 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, z: 0.92 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, positiveFolds: 2 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, accDeltaPt: -0.9 }), hasFinalWeights: false, guard: null },
      { rows: 912, folds: 5, decision: d({ ...okStats, n: 730 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, foldsWithCandidate: 0, positiveFolds: 0 }), hasFinalWeights: false, guard: null },
      { rows: 45190, folds: 5, decision: d({ ...okStats, z: Infinity }), hasFinalWeights: true, guard: guardOk },
    ];
    const seen = new Set();
    for (const c of cases) {
      const s = mt.composeCorpusCvReasonJa(c);
      seen.add(s);
      assertTranslated(s, [c.rows, 5]);
    }
    assert.strictEqual(seen.size, cases.length, "同じ文になっている場合がある(場合分けを作れていない)");
    assertTranslated("採用条件は満たしましたが、保存に失敗したためモデルは変更されていません。");
  });
  // 実際の取り直しの関数に文を作らせるための、模擬の提供元・模擬の保存先(failSet = 保存を失敗させるキーの判定)
  const makeRefreshDeps = (failSet) => {
    const store = new Map();
    return {
      store,
      upstashEnabled: true,
      upstashCmd: async (c) => { if (c[0] === "GET") return store.has(c[1]) ? store.get(c[1]) : null; if (c[0] === "SET") { store.set(c[1], c[2]); return "OK"; } if (c[0] === "DEL") return store.delete(c[1]) ? 1 : 0; return null; },
      upstashGetJSON: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      upstashSetJSON: async (k, v) => { if (failSet && failSet(k)) return false; store.set(k, JSON.stringify(v)); return true; },
      callApiFootball: async (ep, p) => {
        if (ep === "/leagues") return { response: p.id === 179 ? [{ league: { id: 179, name: "Premiership", type: "League" }, country: { name: "Scotland" }, seasons: [{ year: 2026 }] }] : [] };
        if (ep === "/fixtures" && p.league) {
          const out = []; let n = 0; const ids = [1, 2, 3, 4, 5, 6].map((k) => p.league * 100 + k);
          for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { if (i === j) continue; n++; out.push({ fixture: { id: p.league * 1000000 + (p.season % 100) * 10000 + n, date: new Date(Date.UTC(p.season, 7, 1) + n * 3 * 86400000).toISOString(), status: { short: "FT" } }, teams: { home: { id: ids[i], name: "a" }, away: { id: ids[j], name: "b" } }, goals: { home: (i + n) % 3, away: (j + n) % 2 } }); }
          return { response: out };
        }
        return { response: [] };
      },
    };
  };
  const RUN_AT = new Date("2026-11-17T19:17:00Z");
  await t("過去試合を取り直した日の説明(リーグの数が変わっても訳される)", async () => {
    const ds = await mt.ensureDataset(makeRefreshDeps(), RUN_AT);
    hb.setActivatedLeagues([]);
    assert.strictEqual(ds.saved, true);
    assert.ok(/^過去5シーズン×16リーグから\d+試合を取得し、\d+件の学習データを作りました/.test(ds.reasonJa), ds.reasonJa);
    assertTranslated(ds.reasonJa, [16, 5]);
  });
  await t("学習データの保存に失敗した日の説明(ブロックの保存の失敗・目次の保存の失敗)。1文ずつ独立していて、強調の記号を画面に出さない", async () => {
    const shardFail = await mt.ensureDataset(makeRefreshDeps((k) => /^learn:backfill:dataset:s\d+$/.test(k)), RUN_AT);
    hb.setActivatedLeagues([]);
    assert.strictEqual(shardFail.saved, false);
    assert.ok(/^過去試合\d+件から\d+件の学習データを作りましたが、保存に失敗しました。学習データの保存に失敗しました\(\d+\/\d+ブロック\)。次回の実行で作り直します。今日の学習には使いますが、次回は取り直しになります。$/.test(shardFail.reasonJa), shardFail.reasonJa);
    const metaFail = await mt.ensureDataset(makeRefreshDeps((k) => k === hb.BACKFILL_META_KEY), RUN_AT);
    hb.setActivatedLeagues([]);
    assert.strictEqual(metaFail.saved, false);
    assert.ok(/保存に失敗しました。学習データの目次の保存に失敗しました。今日の学習には使いますが、次回は取り直しになります。$/.test(metaFail.reasonJa), metaFail.reasonJa);
    for (const s of [shardFail.reasonJa, metaFail.reasonJa]) {
      assert.ok(!/\*\*/.test(s), "強調の記号が残っている: " + s); assert.ok(!/。[)\uFF09]/.test(s), "かっこの中に文の終わりがある: " + s);
      assertTranslated(s);
    }
    // 上限を超えて保存しなかった行があるときの文(保存の関数に作らせる)
    const cap = hb.BACKFILL_MAX_SHARDS * hb.BACKFILL_SHARD_SIZE;
    const big = []; for (let i = 0; i < cap + 3; i++) big.push({ date: new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString(), leagueId: 39, homeId: 1, awayId: 2, homeCtx: {}, awayCtx: {}, actualHomeGoals: 1, actualAwayGoals: 0 });
    const over = await hb.saveDataset(makeRefreshDeps(), big, { builtAt: RUN_AT.toISOString(), leagues: [39] });
    assert.strictEqual(over.reasonJa, `上限を超えた3件は保存していません(直近${cap}件を保存)。`);
    assertTranslated(over.reasonJa, [3, cap]);
    // 保存先が未設定・データがまだ無いときの文
    assertTranslated((await mt.ensureDataset({ upstashEnabled: false }, RUN_AT)).reasonJa);
    assertTranslated((await hb.saveDataset({ upstashEnabled: false }, [], {})).reasonJa);
    assertTranslated((await mt.tuneModelOnHistory({ upstashEnabled: false }, W0, RUN_AT, {})).reasonJa);
  });
  await t("過去試合によるモデル調整の安全弁: 前回が途中で止まったあとの「軽い設定」の理由(1回め・2回め)と、そのときのデータの注記", async () => {
    const deps = makeRefreshDeps();
    const first = await mt.ensureDataset(deps, RUN_AT);
    hb.setActivatedLeagues([]);
    assert.strictEqual(first.saved, true);
    // 1回め: 前回の「実行中の印」が残っている
    deps.store.set(mt.TUNE_INFLIGHT_KEY, JSON.stringify({ startedAt: "2026-11-17T19:17:00.000Z", date: "2026-11-18", commit: null, boot: "another-process", phase: "重みの検証の前" }));
    const g1 = await mt.readCrashGuard(deps, new Date("2026-11-17T19:55:00Z"));
    assert.strictEqual(g1.safeMode, true); assert.strictEqual(g1.strikes, 1);
    assert.ok(g1.reasonJa.includes("前回(日本時間 2026-11-18 04:17 に開始)") && g1.reasonJa.includes("日本時間 2026-11-21 までは軽い設定で動かします"), g1.reasonJa);
    assertTranslated(`${g1.reasonJa}モデルは変更しません。`, ["2026-11-18 04:17", "2026-11-21"]);
    // そのときのデータの注記(画面では「(…)」の中に入る)
    const ds = await mt.ensureDataset(deps, new Date("2026-11-17T19:55:00Z"), { safeMode: true });
    assert.ok(/^軽い設定で動かしているため、保存済みの過去試合のうち新しい\d+件だけを使い、取り直しは見送りました。$/.test(ds.reasonJa), ds.reasonJa);
    assertTranslated(ds.reasonJa, [ds.rows.length]);
    assertTranslated(`(${ds.reasonJa})`, [ds.rows.length]);
    // 2回め: 期間が終わって通常の設定で確かめた回でも、印が残っている
    deps.store.set(mt.TUNE_INFLIGHT_KEY, JSON.stringify({ startedAt: "2026-11-21T19:17:00.000Z", date: "2026-11-22", commit: null, boot: "another-process" }));
    const g2 = await mt.readCrashGuard(deps, new Date("2026-11-21T19:58:00Z"));
    assert.strictEqual(g2.safeMode, true); assert.strictEqual(g2.strikes, 2);
    assert.ok(g2.reasonJa.includes("(2回め)") && g2.reasonJa.includes("日本時間 2026-12-06 までは"), g2.reasonJa);
    assertTranslated(`${g2.reasonJa}モデルは変更しません。`, [2, "2026-12-06"]);
    // 状態を読めない古い記録だったときの文(予備)
    assertTranslated("前回の過去試合によるモデル調整が途中で止まったため、軽い設定で動かしています。モデルは変更しません。");
    // 軽い設定のあいだに、保存済みの過去試合を読めなかった日の文(実際の関数に作らせる)
    const failingGet = async (k) => { if (/^learn:backfill:dataset:s\d+$/.test(k)) throw new Error("store down"); return deps.upstashGetJSON(k); };
    const unread = await mt.ensureDataset({ ...deps, upstashGetJSON: failingGet }, new Date("2026-11-18T19:17:00Z"), { safeMode: true });
    assert.strictEqual(unread.rows.length, 0); assert.ok(/読み出せなかったため/.test(unread.reasonJa), unread.reasonJa);
    assertTranslated(unread.reasonJa);
  });
  await t("交差検証の前のメモリの確認で、余裕が足りずに検証を見送った回の理由(Node の空き・サーバーの空き)", () => {
    const snap = { rssMb: 300, heapUsedMb: 150, heapTotalMb: 170 };
    const heapShort = mt.cvMemoryCheck(51925, snap, { heapLimitMb: 230, constrainedMb: 512 });
    const rssShort = mt.cvMemoryCheck(51925, { ...snap, rssMb: 470 }, { heapLimitMb: 2096, constrainedMb: 512 });
    assert.strictEqual(heapShort.ok, false); assert.strictEqual(rssShort.ok, false);
    assert.notStrictEqual(heapShort.reasonJa, rssShort.reasonJa);
    assertTranslated(`${heapShort.reasonJa}モデルは変更しません。`, [80, 89]);
    assertTranslated(`${rssShort.reasonJa}モデルは変更しません。`, [62, 82]);
    assert.ok(/Node free: 80MB; estimated need: 89MB/.test(ENGINES.en.t(heapShort.reasonJa)), ENGINES.en.t(heapShort.reasonJa));
  });

  await t("リーグ別の内訳の表: 見出し・判定(4通り)・注記・全体の1行・リーグの名前(31大会ぶん)が、3言語とも訳される", () => {
    // 画面の表の見出しと注記は、画面のコードから取り出す(テストに書き写さない)
    const m = /<table class="cv-league-table"[^>]*>\s*<tr[^>]*>([\s\S]*?)<\/tr>/.exec(HTML);
    assert.ok(m, "表の見出しが画面のコードに無い");
    const heads = [...m[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((x) => x[1]);
    assert.deepStrictEqual(heads, ["リーグ", "判定", "試合数", "LogLoss(現行→候補)", "的中率(現行→候補)"], "見出し(判定は、スマホで横にずらさなくても見えるように2列め)");
    // 短い語(「判定」「改善」など)は、中国語でも同じ字になることがある。中国語は「かなが残っていない」ことだけを確かめる
    const assertNoJapaneseLeft = (ja) => {
      for (const lang of ["en", "zh", "es"]) {
        const out = ENGINES[lang].t(ja);
        assert.ok(typeof out === "string" && out.length > 0, `${lang}: 訳が空: ${ja}`);
        assert.ok(!(lang === "zh" ? KANA : JA_ANY).test(out), `${lang}: 日本語が残っている: ${out}  ← ${ja}`);
        if (lang !== "zh") assert.notStrictEqual(out, ja, `${lang}: 訳されていない: ${ja}`);
      }
    };
    for (const h of heads) assertNoJapaneseLeft(h);
    const note = /<div class="value-note" style="margin-top:3px; opacity:\.85;">(各リーグの数字は、[^<]+)<\/div>/.exec(HTML);
    assert.ok(note, "表の注記が画面のコードに無い");
    assertTranslated(note[1]);
    // 画面の注記は、サーバーが文字の表に付けている注記と同じ文
    const serverTable = mt.formatCvLeagueTableJa([{ leagueJa: "x", n: 1, baseLogLoss: 1, candLogLoss: 1, baseAccuracyPct: 1, candAccuracyPct: 1, verdictJa: "改善" }], { n: 1439, baseLogLoss: 1.0555, candLogLoss: 1.0511, pooledGain: 0.0044, z: 0.5 });
    assert.ok(serverTable.includes(note[1]), "画面の注記が、サーバーの注記と違う");
    const overall = serverTable.split("\n").find((l) => l.startsWith("全体: "));
    assert.strictEqual(overall, "全体: 検証1439件・LogLoss 1.0555→1.0511(改善 0.0044・z=0.5)");
    assertTranslated(overall, [1439, "1.0555", "1.0511", "0.0044", "0.5"]);
    // 画面は、同じ全体の1行を、項目ごとの値から組み立てている(同じ型)
    assert.ok(HTML.includes("`全体: 検証${mt.cv.n}件・LogLoss ${mt.cv.baseLogLoss}→${mt.cv.candLogLoss}(改善 ${mt.cv.pooledGain}・z=${mt.cv.z})`"), "画面の全体の1行の組み立てが変わった");
    // 判定の4通り(実際の関数に作らせる)
    const rows = mt.cvLeagueRows({ byGroup: [
      { key: 39, n: 50, baseNll: 1, candNll: 1, gain: 0, z: 0, accBasePct: 40, accCandPct: 40 },
      { key: 140, n: 500, baseNll: 1, candNll: 0.98, gain: 0.02, z: 2.1, accBasePct: 40, accCandPct: 42 },
      { key: 78, n: 500, baseNll: 1, candNll: 1.02, gain: -0.02, z: -2.1, accBasePct: 40, accCandPct: 39 },
      { key: 135, n: 500, baseNll: 1, candNll: 1, gain: 0.001, z: 0.3, accBasePct: 40, accCandPct: 40 },
      { key: 999999, n: 500, baseNll: 1, candNll: 1, gain: 0.001, z: 0.3, accBasePct: 40, accCandPct: 40 },
    ] });
    assert.deepStrictEqual(rows.map((r) => r.verdictJa), ["判定不可(試合が少ない)", "改善", "悪化", "差は誤差の範囲", "差は誤差の範囲"]);
    for (const v of new Set(rows.map((r) => r.verdictJa))) assertNoJapaneseLeft(v);
    assert.strictEqual(rows[4].leagueJa, "リーグ999999", "名前の表に無い番号は、番号つきの呼び名");
    // リーグの名前: 学習の表に出る31大会ぶん、全部
    const names = hb.DEFAULT_BACKFILL_LEAGUES.map((l) => mt.LEAGUE_NAMES_JA[l.id]);
    assert.strictEqual(names.length, 31); assert.ok(names.every((n) => typeof n === "string" && n.length > 0), "名前の表に無いリーグがある");
    for (const n of names) assertTranslated(n);
    assertTranslated("リーグ別の比較はできませんでした。");
  });

  console.log("■ 3. 「AIが実際に学習して変更した内容」(学習の種類の名前と、採用の理由)");
  await t("学習の種類の名前(8種類)が、3言語とも訳される", () => {
    const methods = ["gradient_descent_v2", "market_blend", "corpus_cv", "history_gradient_descent", "grid_search", "apifb_blend", "ablation_formDiff", "grid_search_v1"];
    const labels = methods.map((m) => pm.describeWeightsHistoryEntry({ date: "2026-11-18", adopted: true, method: m, oldWeights: W0, newWeights: W0 }).methodLabelJa);
    assert.strictEqual(new Set(labels).size, 8, "名前が重複している: " + labels.join(" / "));
    assert.deepStrictEqual(labels.slice(0, 3), ["拡張特徴量モデル(v2)", "市場ブレンド(最終確率のオッズ配合)", "過去試合の学習(前向きの交差検証)"]);
    for (const l of labels) assertTranslated(l);
  });
  await t("採用の理由: 関門が交差検証・LogLoss のときは「LogLoss が改善したため」。的中率が下がっていても「上がったため」と書かない", () => {
    const base = { date: "2026-11-18", adopted: true, oldWeights: W0, newWeights: { ...W0, sensitivity: W0.sensitivity + 0.1 }, sampleSize: 1601 };
    const cv = pm.describeWeightsHistoryEntry({ ...base, method: "gradient_descent_v2", gate: "cv", oldLogLoss: 0.9856, newLogLoss: 0.9801, oldAccuracy: 52.1, newAccuracy: 51.9 });
    assert.ok(/交差検証で、確率の質を表す LogLoss\(小さいほど良い\)が0\.9856→0\.9801に改善したため\(拡張特徴量モデル\(v2\)\)。的中率は52\.1%→51\.9%でした。$/.test(cv.reason), cv.reason);
    assert.ok(!/上がったため/.test(cv.reason), "的中率が下がっているのに「上がったため」と書いている: " + cv.reason);
    assertTranslated("理由: " + cv.reason, [1601, "0.9856", "0.9801", "52.1", "51.9"]);
    const corpus = pm.describeWeightsHistoryEntry({ ...base, method: "corpus_cv", gate: "cv", oldLogLoss: 1.0012, newLogLoss: 0.9971, oldAccuracy: 50.4, newAccuracy: 50.9, sampleSize: 36151 });
    assert.ok(corpus.reason.includes("(過去試合の学習(前向きの交差検証))。"), corpus.reason);
    assertTranslated("理由: " + corpus.reason, [36151, "1.0012", "0.9971"]);
    const ll = pm.describeWeightsHistoryEntry({ ...base, method: "gradient_descent_v2", gate: "logloss", oldLogLoss: 0.99, newLogLoss: 0.985, oldAccuracy: 52, newAccuracy: 52 });
    assert.ok(/^検証1601件で、確率の質を表す LogLoss/.test(ll.reason) && !/交差検証/.test(ll.reason), ll.reason);
    assertTranslated("理由: " + ll.reason, [1601, "0.99", "0.985"]);
    // LogLoss の記録が無い採用(v99 以前の関門)は、従来の文のまま
    const old = pm.describeWeightsHistoryEntry({ ...base, method: "gradient_descent_v2", oldAccuracy: 55, newAccuracy: 63, sampleSize: 24 });
    assert.strictEqual(old.reason, "直近24試合の検証結果で、的中率が55%→63%に上がったため(拡張特徴量モデル(v2))。");
    assertTranslated("理由: " + old.reason, [24, 55, 63]);
    // 的中率の記録が無いときは、的中率の文を付けない
    const noAcc = pm.describeWeightsHistoryEntry({ ...base, method: "corpus_cv", gate: "cv", oldLogLoss: 1.0, newLogLoss: 0.99 });
    assert.ok(!/的中率/.test(noAcc.reason), noAcc.reason);
    // 見出し(「◯月◯日の学習(名前)」の名前の部分)
    assertTranslated(cv.methodLabelJa); assertTranslated(corpus.methodLabelJa);
  });

  console.log("■ 4. 市場ブレンドの比率の見直しの理由(実際の関数に作らせる)");
  const mix = (a, b, w) => ({ home: (1 - w) * a.home + w * b.home, draw: (1 - w) * a.draw + w * b.draw, away: (1 - w) * a.away + w * b.away });
  function blendRecords(n, seed, truthOf) {
    const R = rng(seed); const out = [];
    for (let i = 0; i < n; i++) {
      const lamH = 0.8 + R() * 1.4, lamA = 0.6 + R() * 1.2;
      const p = pm.computeMatchProbabilitiesRaw(lamH, lamA, undefined, 0);
      const model = { home: p.homeWin, draw: p.draw, away: p.awayWin };
      const j = (R() - 0.5) * 0.3;
      let mh = Math.min(0.85, Math.max(0.08, model.home + j)), md = 0.26, ma = Math.max(0.05, 1 - mh - md);
      const tot = mh + md + ma; mh /= tot; md /= tot; ma /= tot;
      const tr = truthOf(i / n, model, { home: mh, draw: md, away: ma });
      const u = R(); const actual = u < tr.home ? "home" : u < tr.home + tr.draw ? "draw" : "away";
      out.push({ resolved: true, actualWinner: actual, homeLambda: lamH, awayLambda: lamA, marketImplied: { homePct: mh * 100, drawPct: md * 100, awayPct: ma * 100 }, weightsSnapshot: { rho: 0 } });
    }
    return out;
  }
  await t("始める・見送る(偶然と区別できない)・AI単独が最良・続ける(比率を更新)・続ける(差は誤差の範囲)・比率を据え置く・件数不足 の文が、すべて訳される", () => {
    const want = new Set(["start", "not_started", "ai_only_best", "continue_updated", "continue_no_clear_gain", "continue_kept_ratio"]);
    const reasons = new Map(); // 決まり方+文の形 → 文
    const worlds = [(pos, m, k) => mix(m, k, 0.7), (pos, m) => m, (pos, m, k) => mix(m, k, 0.3), (pos, m, k) => k];
    for (let seed = 1; seed <= 40 && (want.size > 0 || reasons.size < 9); seed++) {
      for (const w of worlds) for (const cur of [0, 0.7, 0.9]) {
        const f = pm.fitMarketBlend(blendRecords(1250, seed * 7 + 3, w), { currentW: cur });
        want.delete(f.decision);
        const shape = f.decision + "|" + f.reasonJa.replace(/[\d.∞−-]+/g, "#");
        if (!reasons.has(shape)) reasons.set(shape, f.reasonJa);
      }
    }
    assert.strictEqual(want.size, 0, "作れなかった決まり方: " + [...want].join(","));
    assert.ok(reasons.size >= 7, "文の形の種類: " + reasons.size);
    for (const r of reasons.values()) assertTranslated(r);
    assertTranslated(pm.fitMarketBlend(blendRecords(39, 3, (pos, m, k) => k)).reasonJa, [39, 40]);
    // 重みの変更履歴に残ったブレンドの変更は、理由(note)をそのまま出す
    const d = pm.describeWeightsHistoryEntry({ date: "2026-11-18", adopted: true, method: "market_blend", oldWeights: { marketBlend: 0.9 }, newWeights: { marketBlend: 0.75 }, sampleSize: 1256, note: [...reasons.values()].find((x) => /採用しました/.test(x)) });
    assert.ok(/採用しました。/.test(d.reason)); assert.ok(d.bullets.some((b) => /市場ブレンド比率/.test(b)));
    assertTranslated("理由: " + d.reason);
    for (const b of d.bullets) assertTranslated(b);
  });

  console.log("■ 5. 学習の失敗の分類(回答AIの失敗)の見出し・意味・影響");
  await t("回答AIの残高切れ・見解を作れなかったクラブ の分類の文が、3言語とも訳される", () => {
    const hc = require(path.join(S, "learning", "healthCheck.js"));
    for (const id of ["llmCredit", "dailyViewLlm"]) {
      const rule = hc.LEARN_ERROR_RULES.find((r) => r.id === id);
      assert.ok(rule, "規則が無い: " + id);
      assertTranslated(rule.titleJa); assertTranslated(rule.meaningJa); assertTranslated(rule.effectJa);
    }
  });

  console.log(`\n=== 結果: ${pass}件成功 / ${fail}件失敗 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
