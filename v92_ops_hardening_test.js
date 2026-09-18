"use strict";
/** v92(2026年9月18日): 「この期間の実装で分かった改善点」①②③の根治テスト(利用者の指示「1→2→3の順で実装・バグでないように」)。
 *
 *  ① /api/learning/daily-report が重い(実測: キャッシュ切れ直後の1回目が6日連続でタイムアウト)
 *     原因: 30日ぶんの日次集計を30回直列に読む + 全クラブ(172)の書類を1件ずつ読む。
 *     修正: MGETでまとめ読み。**返す数字は従来と完全同一**(このテストがビット一致を確認する)。
 *  ② learning/ 配下の27か所の「黙って飲み込む catch」に痕跡(warnings)を残す。挙動は変えない。
 *  ③ 公開画面の的中率の見出しに「直近300件の窓」の開示を足す(数字は不変。利用者の承認「開示だけ追加」)。
 *
 *  検証は「ソースに文字列があるか」だけに頼らず、モックの保存先で実際に関数を動かして、
 *  往復回数・戻り値・記録の中身を確かめる(v89②と同じ方針)。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

// 開発ツリー(server/ の下にテスト・index.html は1つ上)と、配備先(すべてルート直下)の両方で動くように解決する
const findUp = (...names) => {
  for (const n of names) { for (const base of [path.join(__dirname, ".."), __dirname]) { const f = path.join(base, n); if (fs.existsSync(f)) return f; } }
  return path.join(__dirname, "..", names[0]);
};
const INDEX_HTML = findUp("index.html");
const SW_JS = findUp("sw.js");
const I18N_CHECK = findUp(path.join("scripts", "pw_i18n_check.js"), "pw_i18n_check.js");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e)); } };
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.readMode; return c; };

/** MGET対応/非対応を切り替えられる保存先モック。呼び出しを記録する。 */
function mockStore({ mget = true, mgetThrowOnCall = null } = {}) {
  const store = new Map(); const calls = []; let mgetCalls = 0;
  async function upstashCmd(cmd) {
    const [op, ...a] = cmd; calls.push(op);
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") {
      mgetCalls++;
      if (mgetThrowOnCall === mgetCalls) throw new Error("mget_failed_for_test");
      return mget ? a.map((k) => (store.has(k) ? store.get(k) : null)) : null; // 非対応モックは null を返す
    }
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "LRANGE") { const l = store.get(a[0]) || []; return l.slice(); }
    if (op === "RPUSH") { const l = store.get(a[0]) || []; l.push(a[1]); store.set(a[0], l); return l.length; }
    if (op === "EXPIRE") return 1;
    return null;
  }
  const upstashGetJSON = async (k) => { const r = await upstashCmd(["GET", k]); return r === null ? null : JSON.parse(r); };
  const upstashSetJSON = async (k, v) => { await upstashCmd(["SET", k, JSON.stringify(v)]); return true; };
  const count = (op) => calls.filter((x) => x === op).length;
  return { store, calls, count, upstashCmd, upstashGetJSON, upstashSetJSON, upstashEnabled: true };
}

const { getAccuracyTrend, buildDailyAccuracy, ACCURACY_KEY_PREFIX } = require("./learning/accuracyTracker");
const { createClubDossier } = require("./knowledge/clubDossier");
const W = require("./learning/warnings");

function seedAccuracy(m, todayKey) {
  const base = new Date(`${todayKey}T00:00:00Z`).getTime();
  for (let i = 0; i < 30; i++) {
    if (i % 3 === 2) continue; // 保存の無い日も混ぜる
    const dk = new Date(base - i * 86400000).toISOString().slice(0, 10);
    const agg = buildDailyAccuracy([
      { oneX2: { hit: i % 2 === 0, brier: 0.4 + i / 100, logLoss: 0.7, confidence: 0.5, official: true }, scoreline: { hit: i % 5 === 0, official: true } },
      { oneX2: { hit: i % 4 === 0, brier: 0.5, logLoss: 0.8, confidence: 0.6, official: false }, scoreline: { hit: false, official: false } },
    ]);
    m.store.set(`${ACCURACY_KEY_PREFIX}${dk}`, JSON.stringify(agg));
  }
}
function seedClubs(m, n) {
  const slugs = [];
  for (let i = 0; i < n; i++) {
    const slug = "club-" + i; slugs.push(slug);
    if (i % 7 === 6) continue; // 索引にあるのに書類が無いクラブも混ぜる
    m.store.set(`kb:club:${slug}`, JSON.stringify({
      nameJa: "クラブ" + i, nameEn: "Club " + i, tier: i < 10 ? "A" : "B",
      updatedAt: new Date(Date.now() - i * 10 * 3600000).toISOString(),
      sections: Object.fromEntries(Array.from({ length: i % 4 }, (_, j) => ["s" + j, {}])),
      lastChangesJa: i % 2 ? ["x"] : [],
    }));
  }
  m.store.set("kb:club:index", slugs);
  m.store.set("kb:player:count", "1234");
}

(async () => {
  const TODAY = "2026-09-18";

  // ================= ① daily-report の重い読み出し =================
  await t("①-1 精度トレンド: MGET経路は1往復(GET 0回)、従来経路は30往復。数字は完全一致", async () => {
    const a = mockStore(), b = mockStore();
    seedAccuracy(a, TODAY); seedAccuracy(b, TODAY);
    const ra = await getAccuracyTrend(a, TODAY);
    const rb = await getAccuracyTrend({ upstashEnabled: true, upstashGetJSON: b.upstashGetJSON }, TODAY); // upstashCmd 無し=従来
    assert.strictEqual(ra.readMode, "mget"); assert.strictEqual(rb.readMode, "per-key");
    assert.strictEqual(a.count("MGET"), 1, "MGETが1回でない"); assert.strictEqual(a.count("GET"), 0, "MGET経路でGETが走った");
    assert.strictEqual(b.count("GET"), 30, "従来経路は30回のGET");
    assert.ok(ra.recordedDays === 20 && ra.available === true, "記録日数が想定と違う: " + ra.recordedDays);
    assert.deepStrictEqual(strip(ra), strip(rb), "MGET経路と従来経路の数字が一致しない");
    assert.ok(ra.last30Days && ra.last7Days && ra.today && ra.yesterday, "集計項目が欠けている");
  });

  await t("①-2 MGETが使えない保存先(nullを返す/例外を投げる)では従来経路に自動で戻り、数字は同一", async () => {
    const nullMget = mockStore({ mget: false }); seedAccuracy(nullMget, TODAY);
    const throwMget = mockStore({ mgetThrowOnCall: 1 }); seedAccuracy(throwMget, TODAY);
    const ref = mockStore(); seedAccuracy(ref, TODAY);
    const r0 = await getAccuracyTrend(ref, TODAY);
    const r1 = await getAccuracyTrend(nullMget, TODAY);
    const r2 = await getAccuracyTrend(throwMget, TODAY);
    assert.strictEqual(r1.readMode, "per-key"); assert.strictEqual(r2.readMode, "per-key");
    assert.deepStrictEqual(strip(r1), strip(r0)); assert.deepStrictEqual(strip(r2), strip(r0));
    assert.strictEqual(nullMget.count("GET"), 30, "フォールバックで30回読んでいない");
  });

  await t("①-3 クラブ網羅率: 40クラブ→MGET 3回(16件ずつ)+GET 1回。従来は41回。中身・並び順は完全一致", async () => {
    const a = mockStore(), b = mockStore({ mget: false });
    seedClubs(a, 40); seedClubs(b, 40);
    const ca = await createClubDossier(a).getCoverageSummary();
    const cb = await createClubDossier(b).getCoverageSummary();
    assert.strictEqual(ca.readMode, "mget"); assert.strictEqual(cb.readMode, "per-key");
    assert.strictEqual(a.count("MGET"), 3, "MGET回数: " + a.count("MGET"));
    assert.strictEqual(a.count("GET"), 1, "MGET経路のGET回数(kb:player:countの1回のみ): " + a.count("GET"));
    assert.strictEqual(b.count("GET"), 41, "従来経路のGET回数: " + b.count("GET"));
    assert.strictEqual(ca.clubCount, 35, "書類の無い5クラブを除いた件数");
    assert.deepStrictEqual(strip(ca), strip(cb), "まとめ読みと従来読みで中身が違う");
    assert.deepStrictEqual(ca.clubs.map((c) => c.nameEn), cb.clubs.map((c) => c.nameEn), "並び順が違う");
  });

  await t("①-4 チャンクの一部だけMGETが失敗しても、そのチャンクだけ従来読みに戻り(readMode=mixed)、中身は同一", async () => {
    const a = mockStore({ mgetThrowOnCall: 2 }), b = mockStore();
    seedClubs(a, 40); seedClubs(b, 40);
    const ca = await createClubDossier(a).getCoverageSummary();
    const cb = await createClubDossier(b).getCoverageSummary();
    assert.strictEqual(ca.readMode, "mixed");
    assert.strictEqual(a.count("GET"), 1 + 16, "失敗した1チャンク(16件)だけがGETに戻る: " + a.count("GET"));
    assert.deepStrictEqual(strip(ca), strip(cb));
  });

  await t("①-5 空の索引・Upstash無しでも従来どおり(例外を出さない)", async () => {
    const a = mockStore(); a.store.set("kb:club:index", []);
    const ca = await createClubDossier(a).getCoverageSummary();
    assert.strictEqual(ca.clubCount, 0); assert.strictEqual(ca.readMode, "mget"); // 0件=まとめ読みの失敗が無い
    const off = await createClubDossier({ upstashEnabled: false }).getCoverageSummary();
    assert.strictEqual(off.available, false);
    const tr = await getAccuracyTrend({ upstashEnabled: false }, TODAY);
    assert.strictEqual(tr.available, false);
  });

  // ================= ② 黙って飲み込む失敗に痕跡を残す =================
  await t("②-1 記録器: 上限(80)を超えた分は件数だけ数える・記録器自身は例外を出さない・合算が正しい", async () => {
    const tgt = {};
    W.noteWarning(tgt, "a", new Error("x")); W.noteWarning(tgt, "b"); W.noteWarning(tgt, "c", "str");
    for (let i = 0; i < 100; i++) W.noteWarning(tgt, "d" + i);
    assert.strictEqual(tgt.warnings.length, W.WARNINGS_CAP); assert.strictEqual(tgt.warningsDropped, 23);
    assert.deepStrictEqual(tgt.warnings.slice(0, 3), ["a:x", "b", "c:str"]);
    const sum = W.summarizeWarnings(tgt);
    assert.strictEqual(sum.count, 103); assert.strictEqual(sum.items.length, 40); assert.ok(sum.noteJa.includes("103件"));
    assert.strictEqual(W.noteWarning(null, "x"), false, "不正な対象で例外を出した");
    assert.strictEqual(W.noteVia(null, "x"), false); assert.strictEqual(W.noteVia({}, "x"), false);
    assert.strictEqual(W.noteVia({ noteWarning: () => { throw new Error("boom"); } }, "x"), false, "呼び出し先の例外が漏れた");
    let got = null; assert.strictEqual(W.noteVia({ noteWarning: (tag, e) => { got = [tag, e && e.message]; } }, "tag1", new Error("m")), true);
    assert.deepStrictEqual(got, ["tag1", "m"]);
    const merged = W.mergeWarningSummaries({ count: 2, dropped: 0, items: ["a", "b"] }, { count: 3, dropped: 0, items: ["b", "c", "d"] });
    assert.strictEqual(merged.count, 5); assert.deepStrictEqual(merged.items, ["a", "b", "c", "d"]);
    assert.deepStrictEqual(W.mergeWarningSummaries(null, { count: 1, items: ["z"] }).items, ["z"]);
    const zero = W.summarizeWarnings({}); assert.strictEqual(zero.count, 0); assert.ok(zero.noteJa.includes("ありませんでした"));
  });

  await t("②-2 learning/ 配下に「黙って続行する catch」が残っていない(許可リスト3か所のみ・理由つき)", async () => {
    const dir = path.join(__dirname, "learning");
    const found = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
      src.forEach((line, i) => { if (/catch \(e\) \{ \/\*/.test(line)) found.push(`${f}:${i + 1}`); });
    }
    // 許可リスト(失敗ではない、または痕跡が別の形で残るもの):
    //  clubElo.js      : AbortSignal.timeout の有無を調べる「機能検出」。失敗ではない。
    //  warnings.js     : 記録器の自己防衛(記録の失敗で本体を壊さない)。ここが唯一の黙認箇所。
    //  accuracyTracker : MGET不可→従来経路への切替。結果の readMode="per-key" として残る=黙っていない。
    const allowed = { "clubElo.js": 1, "warnings.js": 1, "accuracyTracker.js": 1 };
    const byFile = {};
    for (const x of found) { const f = x.split(":")[0]; byFile[f] = (byFile[f] || 0) + 1; }
    for (const [f, n] of Object.entries(byFile)) assert.ok(allowed[f] === n, `許可されていない黙認catch: ${f} ×${n}(${found.filter((x) => x.startsWith(f)).join(", ")})`);
    assert.strictEqual(found.length, 3, "許可リスト外の黙認catchがある: " + found.join(", "));
    // dailyJob.js には1つも残っていない(13か所すべてが warn(...) 経由になった)
    const dj = fs.readFileSync(path.join(dir, "dailyJob.js"), "utf8");
    assert.strictEqual((dj.match(/catch \(e\) \{ \/\*/g) || []).length, 0);
    assert.ok((dj.match(/warn\(`|warn\("/g) || []).length >= 15, "dailyJob.js の warn 呼び出しが少ない");
  });

  await t("②-3 日次ジョブの配線: warnings が成長ログに載り、同日再実行で合算され、各モジュールへ記録器が渡る", async () => {
    const dj = fs.readFileSync(path.join(__dirname, "learning", "dailyJob.js"), "utf8");
    assert.ok(dj.includes("const jobLog = { warnings: [], warningsDropped: 0 };"), "jobLog が無い");
    assert.ok(dj.includes("warnings: summarizeWarnings(jobLog),"), "成長ログに warnings が載っていない");
    assert.ok(dj.includes("warnings: mergeWarningSummaries(previous.warnings, current.warnings),"), "同日再実行の合算が無い");
    assert.ok(dj.includes("for (const w of universeStats.warnings) warn(`universe:${w}`);"), "収集側の warnings が合流していない");
    for (const call of [
      "loadTuneConfig({ upstashEnabled, upstashGetJSON, noteWarning: warn })",
      "clubEloLookup, xgLookup, noteWarning: warn }",
      "processAnswerability({ ...intelDeps, upstashCmd, noteWarning: warn }",
      "appendHistory({ upstashEnabled, upstashCmd, noteWarning: warn }",
    ]) assert.ok(dj.includes(call), "記録器が渡っていない: " + call);
    assert.ok(dj.includes("xg_fixture_stats_failed:"), "xGの取得失敗件数が記録されていない");
    assert.ok(dj.includes("learningSummaryReadWarning,"), "読み出し側(getGrowthLog)の失敗が隠れている");
    const srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(srv.includes("silentFailures: (g.warnings && typeof g.warnings === \"object\")"), "daily-report に silentFailures が無い");
  });

  await t("②-4 挙動は不変+痕跡は残る: 自己調整の読み出し失敗→既定値に戻る事実が記録される/履歴追記の失敗が件数で残る", async () => {
    const { loadTuneConfig, appendHistory, defaultTuneConfig } = require("./learning/selfImprovement");
    const log = { warnings: [], warningsDropped: 0 };
    const noteWarning = (tag, e) => W.noteWarning(log, tag, e);
    const cfg = await loadTuneConfig({ upstashEnabled: true, upstashGetJSON: async () => { throw new Error("redis_down"); }, noteWarning });
    assert.deepStrictEqual(cfg, defaultTuneConfig(), "既定値に戻る挙動が変わった");
    assert.deepStrictEqual(log.warnings, ["tune_config_read_failed:redis_down"]);
    // 記録器を渡さない旧来の呼び方でも、まったく同じ戻り値(後方互換)
    const cfg2 = await loadTuneConfig({ upstashEnabled: true, upstashGetJSON: async () => { throw new Error("redis_down"); } });
    assert.deepStrictEqual(cfg2, defaultTuneConfig());
    const n = await appendHistory({ upstashEnabled: true, upstashCmd: async () => { throw new Error("rpush_failed"); }, noteWarning },
      [{ type: "change" }, { type: "evaluation" }]);
    assert.strictEqual(n, 0, "追記件数の戻り値が変わった");
    assert.deepStrictEqual(log.warnings.slice(1), ["self_improvement_history_append_failed:change:rpush_failed", "self_improvement_history_append_failed:evaluation:rpush_failed"]);
  });

  await t("②-5 xG平均: 取れなかった試合は従来どおり平均から外し、件数(fetchFailures)だけ新たに返す", async () => {
    const { fetchTeamXgAverage } = require("./learning/features");
    const fixtures = [1, 2, 3, 4].map((id, i) => ({ fixture: { id, date: `2026-09-0${i + 1}T12:00:00Z` }, goals: { home: 1, away: 0 }, teams: { home: { id: 10 }, away: { id: 20 } } }));
    const call = async (ep, params) => {
      if (params.fixture === 3) throw new Error("api_down");
      return { response: [
        { team: { id: 10 }, statistics: [{ type: "expected_goals", value: "1.5" }] },
        { team: { id: 20 }, statistics: [{ type: "expected_goals", value: "0.5" }] },
      ] };
    };
    const r = await fetchTeamXgAverage(fixtures, 10, call, { limit: 4 });
    assert.strictEqual(r.fetchFailures, 1); assert.strictEqual(r.sampleSize, 3);
    assert.strictEqual(r.xgFor, 1.5); assert.strictEqual(r.xgAgainst, 0.5); assert.strictEqual(r.xgNet, 1);
    const ok = await fetchTeamXgAverage(fixtures, 10, async () => ({ response: [{ team: { id: 10 }, statistics: [{ type: "expected_goals", value: "2" }] }, { team: { id: 20 }, statistics: [{ type: "expected_goals", value: "1" }] }] }), { limit: 4 });
    assert.strictEqual(ok.fetchFailures, 0);
  });

  await t("②-6 収集側(universeCollector): stats に warnings が初期化され、記録器が実際に書く", async () => {
    const src = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
    assert.strictEqual((src.match(/warnings: \[\], warningsDropped: 0/g) || []).length, 2, "2つの stats に warnings が無い");
    for (const tag of ["womens_memory_read_failed", "squad_player_save_failed", "womens_memory_save_failed", "universe_run_marker_failed", "stats_index_save_failed"]) {
      assert.ok(src.includes(`noteWarning(stats, "${tag}"`) || src.includes(`noteWarning(stats, \`${tag}`), "記録が無い: " + tag);
    }
    const stats = { warnings: [], warningsDropped: 0 };
    W.noteWarning(stats, "womens_memory_read_failed", new Error("x"));
    assert.deepStrictEqual(stats.warnings, ["womens_memory_read_failed:x"]);
  });

  // ================= ③ 公開画面の窓の開示 =================
  await t("③-1 サーバー: officialSummary に windowSize=300 / windowN / windowNoteJa が付き、数字の計算は不変", async () => {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.ok(src.includes("const REFLECTIONS_WINDOW = 300;"), "窓の定数が無い");
    assert.ok(src.includes('["LRANGE", "learn:ownpred:recent", String(-REFLECTIONS_WINDOW), "-1"]'), "読み出し範囲が定数化されていない(値が変わった可能性)");
    assert.ok(src.includes("windowSize: REFLECTIONS_WINDOW,") && src.includes("windowN: recs.length,"), "窓の数値が応答に無い");
    assert.ok(src.includes("windowNoteJa: `答え合わせ済みの直近${recs.length}件(公式戦${officialRecs.length}件)の成績です。古い試合から順に入れ替わります(累計ではありません)。`"), "開示文が無い/文面が変わった");
    // 数字の計算式そのものは従来のまま
    assert.ok(src.includes("hitRatePct: officialRecs.length ? Math.round((officialHits.length / officialRecs.length) * 1000) / 10 : null,"), "的中率の式が変わった");
  });

  await t("③-2 画面: 見出しの直下に開示行を出し、古いサーバー応答(項目無し)では何も出さない。4言語の辞書行がある", async () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    assert.ok(html.includes("if (off.windowNoteJa) {"), "開示行の表示が無い/無条件表示になっている");
    assert.ok(html.includes("${esc(off.windowNoteJa)}"), "開示文がエスケープされていない");
    const rows = html.match(/\["答え合わせ済みの直近⦿件\(公式戦⦿件\)の成績です。古い試合から順に入れ替わります\(累計ではありません\)。", "([^"]+)", "([^"]+)", "([^"]+)"\]/);
    assert.ok(rows, "4言語の辞書行が無い");
    assert.ok(/\$1.*\$2/.test(rows[1]) && /\$1.*\$2/.test(rows[2]) && /\$1.*\$2/.test(rows[3]), "翻訳に数値スロット($1/$2)が両方無い");
    assert.ok(/not an all-time total/.test(rows[1]), "英語訳に「累計ではない」が無い");
    // 表示位置: 見出し(学習した大会/公式戦の的中率)の直後・スコア一致の前
    const iHead = html.indexOf("学習した大会の的中率(勝敗): ${Number(lsHead.hitRatePct)}%");
    const iNote = html.indexOf("if (off.windowNoteJa) {");
    const iSl = html.indexOf("const offSl = off.scoreline || null;");
    assert.ok(iHead > 0 && iHead < iNote && iNote < iSl, "開示行の位置が見出しの直下ではない");
  });

  await t("③-3 開示文のテンプレートは実際の数値でも辞書の型に一致する(翻訳が効く)", async () => {
    const pat = (tpl) => new RegExp("^" + tpl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/⦿/g, "(.*?)") + "$");
    const re = pat("答え合わせ済みの直近⦿件(公式戦⦿件)の成績です。古い試合から順に入れ替わります(累計ではありません)。");
    const m = "答え合わせ済みの直近297件(公式戦294件)の成績です。古い試合から順に入れ替わります(累計ではありません)。".match(re);
    assert.ok(m && m[1] === "297" && m[2] === "294", "型に一致しない: " + JSON.stringify(m));
  });

  await t("③-4 検証中に見つかった既存の翻訳漏れの修正(選手カードの一行評価6段階・外れ理由の入れ子・累計ラベル)", async () => {
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    for (const tier of ["世界最高峰の", "世界トップクラスの", "世界的な実力を持つ", "ビッグクラブ級の", "実力派の", "伸びしろのある"]) {
      assert.ok(html.includes(`["「${tier}⦿」",`), "一行評価の型が無い: " + tier);
      assert.ok(html.includes(`tier = "${tier}"`), "一行評価の段階が変わった: " + tier);
    }
    assert.ok(html.includes('"ホームチームの勝利": [') && html.includes('"アウェイチームの勝利": ['), "実際の結果ラベルの辞書行が無い");
    assert.ok(html.includes("よく外す理由(同じ期間の集計): ") && html.includes('"よく外す理由(同じ期間の集計):": ['), "「累計」ラベルの訂正が無い");
    assert.ok(!html.includes("よく外す理由(累計): </span>"), "「累計」ラベルが残っている");
    assert.ok(html.includes("return firstMatchOut !== null ? firstMatchOut : innerOut;"), "「・」剥がしの半端な訳を最後の手段に回す修正が無い");
    const chk = fs.readFileSync(I18N_CHECK, "utf8");
    assert.ok(chk.includes("async function scanAllTabsLeaks(page, lang)") && (chk.match(/scanAllTabsLeaks\(page, lang\)/g) || []).length >= 3,
      "翻訳検査がタブごとに走査していない(最後のタブしか見ない盲点が戻っている)");
    const sw = fs.readFileSync(SW_JS, "utf8");
    assert.ok(sw.includes('CACHE_NAME = "soccer-ai-shell-v92"'), "sw.js のキャッシュ名が更新されていない(利用者に新画面が配られない)");
  });

  // ================= 総合: サーバー本体を差し替え保存先で起動し、daily-report を実際に叩く =================
  await t("④ 実サーバー: /api/learning/daily-report が MGET 経路で応答し(accuracy.readMode/knowledgeCoverage.readMode)、silentFailures を返し、往復回数が少ない", async () => {
    process.env.PORT = "8905";
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; // 差し替え前に1度も本物へ出ないよう到達不能に
    process.env.UPSTASH_REDIS_REST_TOKEN = "test";
    process.env.API_FOOTBALL_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.SELF_HEAL_DAILY_LEARNING = "0"; // 起動時の自己修復学習が成長ログを書き換えないように
    process.env.LINEUP_WATCH = "0";
    const srvMod = require("./server.js");
    const m = mockStore(); seedAccuracy(m, new Date().toISOString().slice(0, 10)); seedClubs(m, 40);
    m.store.set("pred:autocollect:lastrun", JSON.stringify({ at: new Date().toISOString() })); // 自己修復の答え合わせも起動させない
    m.store.set("learn:growthlog:latest", JSON.stringify({
      date: new Date().toISOString().slice(0, 10), errors: ["x_failed"],
      warnings: { count: 3, dropped: 0, items: ["progress_save_failed:③ 新しい予測を立てる:timeout", "xg_lookup_failed:parse", "universe:womens_memory_read_failed:redis"], noteJa: "学習は完走しましたが、付加的な処理が3件記録できませんでした。" },
    }));
    srvMod.__setTestHooks({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    // appDateKey は日本日付。日次集計は「今日」が無くても他の日で判定できるよう両日分を用意する
    const jstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if (!m.store.has(`${ACCURACY_KEY_PREFIX}${jstToday}`)) m.store.set(`${ACCURACY_KEY_PREFIX}${jstToday}`, m.store.get(`${ACCURACY_KEY_PREFIX}${new Date().toISOString().slice(0, 10)}`));
    try {
      await new Promise((r) => setTimeout(r, 300));
      m.calls.length = 0;
      const body = await new Promise((resolve, reject) => {
        http.get("http://127.0.0.1:8905/api/learning/daily-report", (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
      });
      assert.strictEqual(body.ok, true, "応答がokでない: " + JSON.stringify(body).slice(0, 200));
      assert.ok(body.accuracy && body.accuracy.available, "精度トレンドが無い");
      assert.strictEqual(body.accuracy.readMode, "mget", "精度トレンドがMGET経路で読まれていない: " + body.accuracy.readMode);
      assert.ok(body.knowledgeCoverage, "網羅率が無い");
      assert.strictEqual(body.knowledgeCoverage.readMode, "mget", "網羅率がMGET経路で読まれていない");
      assert.strictEqual(body.knowledgeCoverage.clubCount, 35);
      assert.ok(body.updates && body.updates.silentFailures, "silentFailures が無い");
      assert.strictEqual(body.updates.silentFailures.count, 3);
      assert.strictEqual(body.updates.silentFailures.items.length, 3);
      assert.strictEqual(body.updates.failures, 1, "従来の errors 件数が変わった");
      // 往復回数: 従来なら 30(GET) + 41(GET) = 71回以上。いまは MGET 4回 + GET 少数
      assert.strictEqual(m.count("MGET"), 1 + 3, "MGET回数: " + m.count("MGET"));
      assert.ok(m.count("GET") <= 15, "GETが多すぎる(直列読みが残っている): " + m.count("GET") + " ops=" + JSON.stringify(m.calls));
    } finally {
      srvMod.server.close();
    }
  });

  await t("④-b v92より前の成長ログ(warnings無し)でも daily-report は壊れず、「記録されていない」と正直に返す", async () => {
    const srvMod = require("./server.js");
    const m = mockStore(); seedClubs(m, 3);
    m.store.set("learn:growthlog:latest", JSON.stringify({ date: "2026-09-01", errors: [] }));
    srvMod.__setTestHooks({ upstashCmd: m.upstashCmd, upstashGetJSON: m.upstashGetJSON, upstashSetJSON: m.upstashSetJSON });
    srvMod.__clearCacheForTest("learn:daily-report"); srvMod.__clearCacheForTest("kb:coverage");
    await new Promise((resolve, reject) => { srvMod.server.listen(8906, "127.0.0.1", resolve).on("error", reject); });
    try {
      const body = await new Promise((resolve, reject) => {
        http.get("http://127.0.0.1:8906/api/learning/daily-report", (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => resolve(JSON.parse(d))); }).on("error", reject);
      });
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.updates.silentFailures.count, null, "旧ログで0件と偽らない");
      assert.ok(body.updates.silentFailures.noteJa.includes("記録されていません"));
    } finally { srvMod.server.close(); }
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
