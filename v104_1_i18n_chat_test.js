/**
 * v104_1_i18n_chat_test.js — 会話(AIチャット)の「日本語漏れ」を、型の全数で照らす検査(v104.1 新設)
 *
 * ■ なぜ必要か(v104.1 の実ブラウザ検査で分かったこと)
 *   ・v104 の実ブラウザ検査は、会話の全文を1行として読み、利用者が打った語(マンチェスター)を含む行を
 *     除外していた。会話全体が1行なので、全部が除外され、何も検査していなかった(偽の合格)。
 *   ・既存の「日本語漏れゼロ」検査(pw_i18n_check.js)は会話を一度も通っていなかった。
 *   その結果、英語・中国語・スペイン語の画面で次が日本語のまま残っていた:
 *     v104 から … 「🧰 AIが確認したデータ」の行・聞き返しの文・予想の「注意:」の見出し・
 *                 確信度の内訳の一部(「・」を含む項目名を割っていた)
 *     v82 から  … 「🧭 この結論に至るまでの検討」の中身(6段階の熟考の文)・「※」付きの注記
 *
 * ■ この検査がすること(ブラウザを使わない=毎回の全テストで回せる)
 *   1. index.html の翻訳エンジン(辞書+型)を Node の vm に読み込み、言語ごとに window.t を使えるようにする
 *   2. サーバーの実モジュール(reasoning/deliberation.js・hypothesisGenerator.js・discuss/tools.js・
 *      discuss/grounding.js・discuss/subjectResolver.js)を実際に動かして、会話に出る文を全分岐ぶん作る
 *   3. index.html の描画関数(道具の1行・裏取りの注記・聞き返し)を取り出して実行し、できた HTML の
 *      文字の節(テキストノード)を、画面と同じ規則(前後の空白を除いて辞書→型)で訳す
 *   4. 英語・スペイン語は「かな・漢字」、中国語は「かな・日本語にしか無い字体の漢字」が残っていないことを確かめる
 *   5. 日本語の画面では、従来と1文字も変わらないことを確かめる(劣化禁止)
 *
 * 実行: node v104_1_i18n_chat_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const D = require(path.join(__dirname, "reasoning/deliberation.js"));
const H = require(path.join(__dirname, "reasoning/hypothesisGenerator.js"));
const TOOLS = require(path.join(__dirname, "discuss/tools.js"));
const G = require(path.join(__dirname, "discuss/grounding.js"));
const SR = require(path.join(__dirname, "discuss/subjectResolver.js"));

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

// ---------------------------------------------------------------------------
// 翻訳エンジン(index.html の辞書と型)を vm に読み込む
// ---------------------------------------------------------------------------
function loadEngine(lang) {
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m, code = null;
  while ((m = re.exec(HTML))) { if (m[2].includes("var X = {};") && m[2].includes("function add(map)")) { code = m[2]; break; } }
  assert.ok(code, "翻訳エンジンの script が見つからない");
  const sandbox = {
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; }, createElement() { return { setAttribute() {}, appendChild() {}, style: {} }; }, body: null, documentElement: { setAttribute() {}, lang: "" } },
    localStorage: { getItem: (k) => (k === "appLang" ? lang : null), setItem() {} },
    location: { reload() {}, href: "http://localhost/" }, navigator: { language: "en" },
    console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("no fetch")),
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "i18n-engine.js" });
  return sandbox;
}

/** index.html から関数(または const 宣言)の本体を名前で取り出す */
function extractFunction(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.ok(start >= 0, "関数が見つからない: " + name);
  let i = HTML.indexOf("{", HTML.indexOf(")", start));
  let depth = 0, inStr = null, inTpl = 0;
  for (let j = i; j < HTML.length; j++) {
    const ch = HTML[j], prev = HTML[j - 1];
    if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "`") { inTpl = inTpl ? 0 : 1; continue; }
    if (inTpl) { continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return HTML.slice(start, j + 1); }
  }
  throw new Error("関数の終わりが見つからない: " + name);
}
function extractConst(name) {
  const start = HTML.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, "定数が見つからない: " + name);
  const end = HTML.indexOf("};", start);
  return HTML.slice(start, end + 2);
}

/** 描画関数を、指定した言語の画面として実行できる箱を作る */
function renderSandbox(lang) {
  const sb = { window: { appLang: lang }, Number, String, Array, JSON, Object, Math };
  vm.createContext(sb);
  vm.runInContext("function escapeHtml(s) { return String(s).replace(/[&<>\"']/g, c => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c])); }", sb);
  vm.runInContext(extractConst("DISCUSS_TOOL_LABELS_JA").replace(/^const /, "var "), sb);
  for (const fn of ["toolCallSummaryHtml", "toolsLineHtml", "groundingNoteHtml", "renderClarifyHtml"]) vm.runInContext(extractFunction(fn), sb);
  return sb;
}

const unescapeHtml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const JA_ANY = /[ぁ-んァ-ヶ一-龥]/;
/** 画面と同じ規則で、HTML の文字の節を1つずつ訳す(前後の空白を除いた全文を辞書→型で引く) */
function translateNodes(html, engine) {
  return html.split(/<[^>]+>/).map((chunk) => {
    const raw = unescapeHtml(chunk);
    const s = raw.trim();
    if (!s || !JA_ANY.test(s)) return raw;
    const rep = engine.window.t(s);
    return raw.replace(s, rep);
  });
}
// 日本語が残っているか。英語・スペイン語=かな・漢字。中国語=かな、または簡体字には無い日本の字体の漢字。
const KANA = /[ぁ-んァ-ヶ]/;
const JA_ONLY_KANJI = /[実対戦検験価拠関続変現順勝試場質権伝団選過監結評論説績態様離職験発転戻軽気単図総経営数]/; // 数・気 などは下で除く
const ZH_OK = /[数气]/;
function leftover(text, lang, allow) {
  let s = String(text);
  for (const a of allow || []) s = s.split(a).join("");
  if (lang === "zh") {
    if (KANA.test(s)) return true;
    for (const ch of s) if (JA_ONLY_KANJI.test(ch) && !ZH_OK.test(ch)) return true;
    return false;
  }
  return JA_ANY.test(s);
}
const LANGS = ["en", "zh", "es"];
const engines = Object.fromEntries(LANGS.map((l) => [l, loadEngine(l)]));
const engineJa = loadEngine("ja");

// ---------------------------------------------------------------------------
// 会話に出る文を、実モジュールで全分岐ぶん作る
// ---------------------------------------------------------------------------
function deliberationStrings() {
  const out = { delib: new Set(), reason: new Set() };
  const ev = (n, type) => Array.from({ length: n }, () => ({ type: type || "fact" }));
  for (const [factors, specs, subj] of [[H.HYPOTHESIS_FACTORS, D.REQUIRED_DATA_SPECS, "アーセナル"], [H.PLAYER_HYPOTHESIS_FACTORS, D.PLAYER_DATA_SPECS, "久保建英"]]) {
    const hypM = factors.map((f) => ({ id: f.id, label: f.label, statement: f.buildStatement(subj, [1]), evidence: ev(3), score: 6, factualCount: 3 }));
    const hypU = factors.map((f) => ({ id: f.id, label: f.label, statement: f.buildStatement(subj, []), evidence: [], score: 0, factualCount: 0 }));
    for (const h of [...hypM, ...hypU]) out.delib.add(h.statement);
    // 段階1: データの揃い具合(全部不足・1つだけある・1つだけ無い・全部ある × 必要な項目の選び方3通り)
    const keys = specs.map((s) => s.key);
    const avails = [{}, Object.fromEntries(keys.map((k) => [k, true]))];
    for (const k of keys) { avails.push({ [k]: true }); avails.push(Object.fromEntries(keys.filter((x) => x !== k).map((x) => [x, true]))); }
    const das = [];
    for (const a of avails) for (const req of [undefined, keys.slice(0, 3), keys.slice(2, 6)]) das.push(D.assessDataAvailability(a, req, specs));
    das.forEach((d) => out.delib.add(d.summaryJa));
    const rankedSets = [[]];
    for (let i = 0; i < factors.length; i++) {
      const j = (i + 1) % factors.length;
      rankedSets.push([hypM[i]]);
      rankedSets.push([hypU[i]]);
      rankedSets.push([{ ...hypM[i], score: 6 }, { ...hypM[j], score: 6 }]);
      rankedSets.push([{ ...hypM[i], score: 9 }, { ...hypM[j], score: 3 }]);
      rankedSets.push([{ ...hypM[i], score: 9 }, hypU[j]]);
      rankedSets.push([{ ...hypM[i], score: 2, factualCount: 1, evidence: ev(1) }, { ...hypM[j], score: 1, factualCount: 1, evidence: ev(1) }]);
      rankedSets.push([{ ...hypM[i], score: 2, factualCount: 0, evidence: ev(2, "aiEstimate").map((e) => ({ ...e, isAiGenerated: true })) }, hypU[j]]);
    }
    for (const ranked of rankedSets) {
      for (const da of [das[0], das[1], das[5], das[das.length - 1]]) {
        for (const prev of [null, { statement: hypM[0].statement }, { statement: hypM[1].statement }]) {
          const cmp = D.compareHypotheses(ranked);
          const evl = D.evaluateEvidence(cmp, da, ranked);
          const con = D.buildFinalConclusion(cmp, evl, prev);
          const ctr = D.buildCounterArgument(cmp);
          out.delib.add(cmp.marginJa); out.delib.add(ctr.statementJa); out.delib.add(con.headlineJa);
          // 段階2 の要約は画面(index.html)が組み立てる。同じ式で作る
          if (ranked.length) out.delib.add(`${ranked.length}本の仮説を検討(最有力: ${ranked[0].label}・根拠${(ranked[0].evidence || []).length}件)`);
          out.reason.add(evl.confidenceReasonJa);
          if (con.changedFromPrevious && con.changedFromPrevious.noteJa) out.delib.add(con.changedFromPrevious.noteJa);
        }
      }
    }
  }
  return out;
}

(async () => {
  console.log("■ 翻訳エンジンの読み込み");
  await t("E1 index.html の辞書と型を vm に読み込める(英語・中国語・スペイン語・日本語)。日本語では何も置き換えない", () => {
    for (const l of LANGS) { assert.strictEqual(typeof engines[l].window.t, "function"); assert.strictEqual(typeof engines[l].window.translateDelibJa, "function"); assert.strictEqual(typeof engines[l].window.translateReasonJa, "function"); }
    assert.strictEqual(engines.en.window.t("数字の裏取り"), "Number check");
    for (const s of ["数字の裏取り", "データ収集", "0/5種類のデータが揃っています(不足: 監督)。"]) {
      assert.strictEqual(engineJa.window.t(s), s); assert.strictEqual(engineJa.window.translateDelibJa(s), s); assert.strictEqual(engineJa.window.translateReasonJa(s), s);
    }
  });

  console.log("■ 検討の過程(6段階の熟考)");
  const strs = deliberationStrings();
  await t(`D1 熟考の文を実モジュールで全分岐ぶん作り(${strs.delib.size}通り)、3言語すべてで日本語が残らない`, () => {
    assert.ok(strs.delib.size >= 250, "作れた文が少なすぎる: " + strs.delib.size);
    for (const l of LANGS) {
      const bad = [];
      for (const s of strs.delib) { const tr = engines[l].window.translateDelibJa(s); if (leftover(tr, l) || tr === s) bad.push(`${s} → ${tr}`); }
      assert.strictEqual(bad.length, 0, `${l}: 訳し切れない文が ${bad.length} 件: ` + bad.slice(0, 3).join(" ｜ ").slice(0, 600));
    }
  });
  await t(`D2 確信度の内訳(${strs.reason.size}通り): 理由に「、」を含むもの・項目名に「・」を含むものを割らずに訳す`, () => {
    for (const l of LANGS) {
      const bad = [];
      for (const s of strs.reason) { const tr = engines[l].window.translateReasonJa(s); if (leftover(tr, l) || tr === s) bad.push(`${s} → ${tr}`); }
      assert.strictEqual(bad.length, 0, `${l}: 訳し切れない理由が ${bad.length} 件: ` + bad.slice(0, 2).join(" ｜ ").slice(0, 600));
    }
    // v104 の不具合の再発防止: 「得点力・失点率」「怪我人・出場停止」を「・」で割って片方だけ訳さない
    const r = engines.en.window.translateReasonJa("直近の試合結果(フォーム)・得点力・失点率・怪我人・出場停止・監督・ホーム/アウェイ別の成績のデータが不足しているため。");
    assert.ok(/Scoring and concession rates/.test(r) && /injuries and suspensions/.test(r) && !/Scoring threat/.test(r), r);
    const p = engines.es.window.translateReasonJa("得点関与(ゴール・アシスト)の実績・チャンスメイク指標(キーパス・パス成功率など)・守備・対人指標(タックル・デュエルなど)のデータが不足しているため。");
    assert.ok(/participación en goles \(goles y asistencias\), métricas de creación \(pases clave, precisión, etc\.\), métricas defensivas y de duelos \(entradas, duelos, etc\.\)/.test(p), p);
    // 中国語: 漢字だけの半端な訳(「得点力・失点率・順位・勝点・怪我名」)を訳せたことにしない
    const z = engines.zh.window.translateReasonJa("直近の試合結果(フォーム)・得点力・失点率・順位・勝点・怪我人・出場停止のデータが不足しているため。");
    assert.ok(/近期比赛结果\(状态\)、进球与失球率、排名与积分、伤病・停赛的数据不足/.test(z) && !/怪我|得点力|順位|勝点/.test(z), z);
  });
  await t("D3 段階1の要約: 件数と「不足」の一覧を各言語の語順で組み立てる。段階の名前(5つ)と「反論の検討:」も訳がある", () => {
    const s1 = "3/5種類のデータが揃っています(不足: 怪我人・出場停止・監督)。";
    assert.strictEqual(engines.en.window.translateDelibJa(s1), "3 of the 5 kinds of data needed are available (missing: injuries and suspensions, Manager).");
    assert.strictEqual(engines.zh.window.translateDelibJa(s1), "所需的5类数据中已有3类(缺少: 伤病・停赛、主教练)。");
    assert.strictEqual(engines.es.window.translateDelibJa(s1), "Se dispone de 3 de los 5 tipos de datos necesarios (faltan: lesiones y sanciones, Entrenador).");
    const s2 = "この質問の分析に必要な3種類のデータがすべて揃っています。(今回の質問には必須ではありませんが、過去の対戦成績・xG(チャンスの質)は取得していません。)";
    assert.strictEqual(engines.en.window.translateDelibJa(s2), "All 3 kinds of data needed for this question are available. (Not required for this question, but not fetched: head-to-head record, xG (chance quality).)");
    for (const l of LANGS) for (const k of ["データ収集", "仮説の列挙", "仮説の比較", "根拠の評価", "最終結論", "反論の検討:"]) { const tr = engines[l].window.t(k); assert.ok(tr !== k && !leftover(tr, l), `${l}: ${k} → ${tr}`); }
    // 画面は、要約と反論を「別の要素」に入れてから訳す(見出しと同じ文字の節に入れると型が効かない)
    assert.ok(HTML.includes("`: <span>${escapeHtml(trDelib(st.summaryJa))}</span>`") && HTML.includes("🔄 <span>反論の検討:</span> <span>${escapeHtml(trDelib(del.counterArgumentJa))}</span>"));
    assert.ok(!/🔄 反論の検討: \$\{escapeHtml\(del\.counterArgumentJa\)\}/.test(HTML));
  });

  console.log("■ 「🧰 AIが確認したデータ」の行");
  // 実際の道具(discuss/tools.js)を、偽の取得関数で動かす
  const entry = (id, home, away, rank) => ({ fixtureId: id, kickoff: "2026-11-14T12:00:00Z", league: "Premier League", home: { name: home }, away: { name: away }, resolved: false, confidence: { displayPct: 70 }, tier: rank ? { rank } : null });
  const deps = (over) => ({
    getTodayPredictions: async () => ({ found: true, date: "2026-11-14", predictions: [entry(1, "Arsenal", "Chelsea", "S"), entry(2, "Liverpool", "Everton", "skip")], tiers: null }),
    getPredictionRecord: async (id) => (id === 1 ? entry(1, "Arsenal", "Chelsea", "S") : null),
    gatherClubFacts: async () => ["順位: 2位", "直近5試合: 3勝1分1敗"],
    resolveClub: async (name) => (/アーセナル|Arsenal/.test(name) ? { ok: true, labelEn: "Arsenal", labelJa: "アーセナル" } : { ok: false, candidates: ["マンチェスター・シティ", "マンチェスター・ユナイテッド"] }),
    getMatchAnalysis: async (home) => (/アーセナル|Arsenal/.test(home) ? { ok: true, home: { nameEn: "Arsenal", nameJa: "アーセナル" }, away: { nameEn: "Chelsea", nameJa: "チェルシー" }, probs: {} } : { ok: false, message: "クラブが特定できませんでした(バルサ)。クラブ名の表記をご確認ください。" }),
    getPlayerStats: async (name) => (/Saka/.test(name) ? { found: true, player: { name: "B. Saka" }, stats: { goals: 9 } } : { found: false, reason: "選手が見つかりません" }),
    getRecentResolved: async () => [{ resolved: true, correct: false, homeTeamEn: "Arsenal", awayTeamEn: "Chelsea", predictedWinner: "home", actualWinner: "away", fixtureId: 9 }],
    getAccuracySummary: async () => ({ hitRatePct: 54 }),
    ...(over || {}),
  });
  const runAll = async () => {
    const calls = [];
    const push = async (name, input, d) => { const r = await TOOLS.executeTool(name, input, d || deps()); calls.push({ name, input, ok: !!r.ok, elapsedMs: r.elapsedMs, summaryJa: r.summaryJa, summary: r.summary, resultJson: r.resultJson }); };
    await push("get_today_predictions", {});
    await push("get_today_predictions", { rank: "S" });
    await push("get_today_predictions", { rank: "skip" });
    await push("get_today_predictions", { rank: "A" }, deps({ getTodayPredictions: async () => ({ found: true, predictions: [], upcomingPredictions: [entry(3, "Arsenal", "Spurs", "A")] }) }));
    await push("get_today_predictions", {}, deps({ getTodayPredictions: async () => ({ found: true, predictions: [], upcomingPredictions: [entry(3, "Arsenal", "Spurs", "A")] }) }));
    await push("get_prediction_detail", { fixtureId: 1 });
    await push("get_team_snapshot", { team: "アーセナル" });
    await push("get_match_analysis", { home: "アーセナル", away: "チェルシー" });
    await push("get_player_stats", { name: "Saka" });
    await push("get_recent_misses", {});
    await push("get_accuracy_summary", {});
    // 取得できなかった場合(理由は日本語の文)
    await push("get_today_predictions", {}, deps({ getTodayPredictions: async () => ({ found: false, noteJa: "本日の試合一覧を取得できませんでした" }) }));
    await push("get_prediction_detail", { fixtureId: 999 });
    await push("get_team_snapshot", { team: "マンチェスター" });
    await push("get_match_analysis", { home: "バルサ", away: "レアル" });
    await push("get_player_stats", { name: "だれか" });
    await push("get_recent_misses", {}, deps({ getRecentResolved: async () => null }));
    await push("get_accuracy_summary", {}, deps({ getAccuracySummary: async () => { throw new Error("boom"); } }));
    return calls;
  };
  const calls = await runAll();
  await t("T1 道具の結果に、言語に依らない要約(summary)が付く。回答AIに渡す結果(resultJson)には入れない(AIが読む内容は従来と同じ)", () => {
    assert.strictEqual(calls.length, 18);
    const kinds = calls.map((c) => c.summary && c.summary.kind);
    assert.deepStrictEqual(kinds, ["today_predictions", "today_predictions", "today_predictions", "today_predictions", "today_predictions", "prediction_detail", "team_snapshot", "match_analysis", "player_stats", "recent_misses", "accuracy_summary", "failed", "failed", "failed", "failed", "failed", "failed", "failed"]);
    assert.deepStrictEqual(calls[1].summary, { kind: "today_predictions", count: 1, rank: "S", upcoming: false, tool: "get_today_predictions" });
    assert.deepStrictEqual(calls[3].summary, { kind: "today_predictions", count: 1, rank: "A", upcoming: true, tool: "get_today_predictions" });
    assert.deepStrictEqual(calls[6].summary, { kind: "team_snapshot", teamJa: "アーセナル", teamEn: "Arsenal", facts: 2, tool: "get_team_snapshot" });
    assert.deepStrictEqual(calls[7].summary, { kind: "match_analysis", home: "アーセナル", away: "チェルシー", homeEn: "Arsenal", awayEn: "Chelsea", tool: "get_match_analysis" });
    for (const c of calls) { assert.ok(c.summaryJa && typeof c.summaryJa === "string"); assert.ok(!/"summary":\{/.test(c.resultJson), "resultJson に summary が入っている: " + c.name); }
    assert.ok(/"summaryJa":"今日のAI予想: 2件"/.test(calls[0].resultJson), "summaryJa は従来どおり結果に含まれる");
  });
  await t("T2 日本語の画面: 行は従来と同じ文(見出し+各項目の1行)。見出しと各項目は別の要素になっている", () => {
    const sb = renderSandbox("ja");
    const html = sb.toolsLineHtml({ meta: { tools: { calls_list: calls, exhausted: true } } });
    const text = unescapeHtml(html.replace(/<[^>]+>/g, ""));
    assert.strictEqual(text, "🧰 AIが確認したデータ: " + calls.map((c) => c.summaryJa).join(" / ") + "(確認回数の上限に達したため、ここまでの情報で回答)");
    assert.ok(html.includes("🧰 <span>AIが確認したデータ:</span> <span>今日のAI予想: 2件</span> / <span>今日のAI予想: 1件(ランクS)</span>"), html.slice(0, 200));
    assert.strictEqual(sb.toolsLineHtml({ meta: { tools: { calls_list: [] } } }), ""); assert.strictEqual(sb.toolsLineHtml({}), ""); assert.strictEqual(sb.toolsLineHtml(null), "");
  });
  await t("T3 英語・中国語・スペイン語の画面: 全項目(成功11通り・失敗7通り)が訳され、日本語が残らない。クラブ名は英語名、失敗は「取得できませんでした」", () => {
    for (const l of LANGS) {
      const sb = renderSandbox(l);
      const html = sb.toolsLineHtml({ meta: { tools: { calls_list: calls, exhausted: true } } });
      const nodes = translateNodes(html, engines[l]);
      const bad = nodes.filter((n) => leftover(n, l));
      assert.strictEqual(bad.length, 0, `${l}: 日本語が残った節 ${bad.length} 件: ` + bad.slice(0, 5).join(" ｜ "));
      const text = nodes.join("").replace(/\s+/g, " ");
      if (l === "en") {
        assert.ok(text.startsWith("🧰 Data the AI checked: Today's AI predictions: 2 / Today's AI predictions: 1 (rank S) / Today's AI predictions: 1 (rank Pass) / Today's AI predictions: 1 (rank A, next matches) / Today's AI predictions: 1 (next matches) / Prediction details: fixture 1 / Club status: Arsenal (2 facts) / Head-to-head analysis: Arsenal vs Chelsea / Player's season stats: B. Saka / Missed predictions: 1 (of 1 in the window) / Measured accuracy / Today's AI predictions: could not be retrieved / Prediction details: could not be retrieved / Club status: could not be retrieved / Head-to-head analysis: could not be retrieved / Player's season stats: could not be retrieved / Review of missed predictions: could not be retrieved / Measured accuracy: could not be retrieved"), text);
        assert.ok(text.endsWith("(reached the lookup limit, so answered with the information so far)"), text.slice(-120));
      }
    }
  });
  await t("T4 要約の無い応答(v104 のサーバー)でも壊れない: 従来の1行をそのまま要素に入れ、型で訳せるものは訳す", () => {
    const old = [{ name: "get_today_predictions", ok: true, summaryJa: "今日のAI予想: 3件" }, { name: "get_recent_misses", ok: true, summaryJa: "外した予想: 2件(窓内 40件)" }, { name: "x_unknown" }];
    const sb = renderSandbox("en");
    const nodes = translateNodes(sb.toolsLineHtml({ meta: { tools: { calls_list: old } } }), engines.en);
    assert.strictEqual(nodes.join("").replace(/\s+/g, " "), "🧰 Data the AI checked: Today's AI predictions: 3 / Missed predictions: 2 (of 40 in the window) / x_unknown");
    assert.ok(!renderSandbox("ja").toolsLineHtml({ meta: { tools: { calls_list: [{ name: "x", summaryJa: "<b>危険</b>" }] } } }).includes("<b>危険</b>"), "要約は必ずエスケープする");
  });

  console.log("■ 数字の裏取りの注記・聞き返し・注記の見出し");
  await t("N1 裏取りの注記(実際の照合結果 7 通り): 3言語すべてで日本語が残らない。数字の一覧はそのまま", () => {
    const earlier = ["ワールドカップには48チームが出場し、決勝の会場は82500人を収容します。"];
    const cases = [
      G.checkGrounding({ answerTexts: ["勝つ確率は62%、勝点42。"], corpusTexts: ["homeWinPct: 62 / points 42"], dataUsed: true }),
      G.checkGrounding({ answerTexts: ["勝つ確率は62%、得失点差は+25、成功率31%。"], corpusTexts: ["homeWinPct: 62"], dataUsed: true }),
      G.checkGrounding({ answerTexts: ["勝点は63、得失点差は+41。会場は82500人収容です。"], corpusTexts: ["勝点 63"], earlierAnswerTexts: earlier, dataUsed: true }),
      G.checkGrounding({ answerTexts: ["勝点は63です。会場は82500人収容です。"], corpusTexts: ["勝点 63"], earlierAnswerTexts: earlier, dataUsed: true }),
      G.checkGrounding({ answerTexts: ["48チームが出場します。"], corpusTexts: [], dataUsed: false }),
      G.checkGrounding({ answerTexts: ["48チームです。"], corpusTexts: ["順位 2位"], earlierAnswerTexts: earlier, dataUsed: true }),
      G.checkGrounding({ answerTexts: ["数字は 11%、12%、13%、14%、15%、16%、17.5、18.5 です。"], corpusTexts: ["x"], dataUsed: true }),
    ];
    assert.deepStrictEqual(cases.map((c) => c.verdict), ["all_supported", "partial", "partial", "all_supported", "general_knowledge", "repeated_only", "partial"]);
    for (const l of LANGS) {
      const sb = renderSandbox(l);
      for (const g of cases) {
        const html = sb.groundingNoteHtml({ grounding: g });
        assert.ok(html, "注記が空: " + g.verdict);
        const nodes = translateNodes(html, engines[l]);
        const bad = nodes.filter((n) => leftover(n, l, ["、"]));
        assert.strictEqual(bad.length, 0, `${l}/${g.verdict}: 日本語が残った節: ` + bad.join(" ｜ "));
      }
    }
    const en = translateNodes(renderSandbox("en").groundingNoteHtml({ grounding: cases[2] }), engines.en).join("").replace(/\s+/g, " ");
    assert.strictEqual(en, "⚠️ Number check: 1 of the 2 checked numbers match the fetched data. The following numbers have no identical value in the fetched data (they may be values the AI calculated or estimated, or taken from its general knowledge): 41 ・ another 1 numbers repeat figures from earlier answers (not re-checked this time)");
  });
  await t("N2 聞き返し: 日本語は従来と同じ1行。他の言語では質問文・「(候補:」・候補のクラブ名がそれぞれ訳される", () => {
    const clarify = { token: "マンチェスター", candidates: ["マンチェスター・シティ", "マンチェスター・ユナイテッド"] };
    const resp = { mode: "clarify", question: SR.clarifyMessageJa(clarify), options: clarify.candidates.map((n) => ({ label: n, subject: { type: "club", labelJa: n, labelEn: n } })), meta: { subjectResolution: { method: "ambiguous", token: clarify.token, candidates: clarify.candidates } } };
    const ja = renderSandbox("ja").renderClarifyHtml(resp, "マンチェスターはどう?");
    assert.strictEqual(unescapeHtml(ja.text.replace(/<[^>]+>/g, "")), "❓ " + resp.question, "日本語の見え方が変わっている");
    for (const l of LANGS) {
      const r = renderSandbox(l).renderClarifyHtml(resp, "How is マンチェスター doing?");
      const nodes = translateNodes(r.text, engines[l]);
      const bad = nodes.filter((n) => leftover(n, l, ["マンチェスター"])); // 利用者が打った語そのものは訳さない
      assert.strictEqual(bad.length, 0, `${l}: ` + bad.join(" ｜ "));
      // 候補のボタン(「・」+クラブ名)も訳される
      const btn = translateNodes(r.extras, engines[l]).filter((n) => leftover(n, l));
      assert.strictEqual(btn.length, 0, `${l} ボタン: ` + btn.join(" ｜ "));
    }
    assert.strictEqual(translateNodes(renderSandbox("en").renderClarifyHtml(resp, "q").text, engines.en).join("").replace(/\s+/g, " "), "❓ Which club do you mean by \"マンチェスター\"? (candidates: Manchester City / Manchester United)");
    // 候補の情報が無い応答(v104 のサーバー)は、質問文をそのまま1つの要素に入れる
    const old = renderSandbox("en").renderClarifyHtml({ question: "どのクラブのことでしょうか?", options: [] }, "q");
    assert.strictEqual(translateNodes(old.text, engines.en).join(""), "❓ Which club do you mean?");
  });
  await t("N3 絵文字や「※」と同じ文字の節に、訳す見出し・文を入れていない(注意・形式の注記)。辞書にも訳がある", () => {
    assert.ok(HTML.includes("⚠️ <span>注意:</span> ${escapeHtml(p.caution)}") && !HTML.includes("⚠️ 注意: ${escapeHtml(p.caution)}"));
    assert.strictEqual((HTML.match(/※ <span>\$\{escapeHtml\(resp\.formatNoteJa\)\}<\/span>/g) || []).length, 3, "形式の注記3か所");
    assert.ok(!/※ \$\{escapeHtml\(resp\.formatNoteJa\)\}/.test(HTML));
    for (const l of LANGS) {
      for (const k of ["注意:", "AIの回答をうまく受け取れなかったため、今回はお答えできませんでした。お手数ですが、もう一度お試しください。", "AIの回答を、いつもの6つの観点(一般論/AIの意見/反対意見/最終結論/今後の見通し/最も重要な点)に整えることができませんでした。以下はAIが述べた内容そのものです。", "AIが確認したデータ:", "(確認回数の上限に達したため、ここまでの情報で回答)", "取得できませんでした", "(候補:"]) {
        const tr = engines[l].window.t(k);
        // 中国語は「注意:」のように日本語と同じ表記になる語がある(かな・日本の字体が残っていなければよい)
        assert.ok(!leftover(tr, l) && (tr !== k || l === "zh"), `${l}: ${k} → ${tr}`);
      }
    }
    // 議論(7欄)の回答にも「AIが確認したデータ」を出す
    assert.ok(HTML.includes("${ragHtml}${toolsLineHtml(resp)}${groundingNoteHtml(resp)}${deliberationHtml}"));
  });

  await t("N4 多段思考の注記・根拠の利用の行: 規則で組み立てた文は訳す。調査計画AIが日本語で書く「論点」は日本語の画面でだけ出す", () => {
    const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    // サーバーが組み立てる2通りの文(実物の式がそのまま server.js にあること)
    assert.ok(SERVER.includes("`多段思考: 調査計画AIが追加データ${msPlan.actions.length}件を要求し、実データ${exec.addedFacts.length}件を追加取得しました。`") && SERVER.includes('"多段思考: 調査計画AIは「追加データは不要」と判断しました(手元の実データで十分)。"'));
    for (const l of LANGS) {
      for (const s of ["多段思考: 調査計画AIが追加データ2件を要求し、実データ5件を追加取得しました。", "多段思考: 調査計画AIは「追加データは不要」と判断しました(手元の実データで十分)。"]) {
        const tr = engines[l].window.t(s); assert.ok(tr !== s && !leftover(tr, l), `${l}: ${s} → ${tr}`);
      }
    }
    // (訳そのものは v47/v82 の辞書に以前からあった。訳されなかったのは「🔁 」と同じ文字の節に入っていたため)
    assert.strictEqual(engines.en.window.t("多段思考: 調査計画AIが追加データ2件を要求し、実データ5件を追加取得しました。"), "Multi-step thinking: the planner AI requested 2 extra data items and 5 real data items were fetched.");
    // v104.1(総点検): 翻訳の仕組みそのものが、先頭の絵文字・全体を囲む括弧・後ろに続く文を「剥がして」訳せるようになった
    //   (実データを入れた総点検で、訳はあるのに絵文字や括弧が付いていて当たらない文が多数見つかったため)。
    //   剥がした残りがすべて訳せるときだけ採用し、訳せない文は原文のまま返す(半端な訳は作らない)。
    assert.strictEqual(engines.en.window.t("🔁 多段思考: 調査計画AIが追加データ2件を要求し、実データ5件を追加取得しました。"), "🔁 Multi-step thinking: the planner AI requested 2 extra data items and 5 real data items were fetched.", "先頭の絵文字を剥がして訳す");
    assert.strictEqual(engines.en.window.t("(本日の学習実行の実測値です。)"), "(Measured values from today's learning run.)", "全体を囲む括弧を剥がして訳す");
    assert.strictEqual(engines.en.window.t("条件に合う選手が見つかりませんでした。条件をゆるめてお試しください。"), "No players matching the criteria were found. Try loosening the filters.", "複数の文は、すべて訳せるときだけ文ごとに訳す");
    assert.strictEqual(engines.en.window.t("🔎 未登録の語句"), "🔎 未登録の語句", "剥がした残りが訳せない文は原文のまま(剥がした分だけ訳す、という半端な訳は作らない)");
    assert.strictEqual(engines.en.window.t("条件に合う選手が見つかりませんでした。未登録の語句。"), "条件に合う選手が見つかりませんでした。未登録の語句。", "1文でも訳せなければ全体を原文のまま");
    for (const l of ["en", "zh", "es"]) for (const s of ["🧠 今日のAIは昨日より賢くなったか?", "ほか8試合の予想は「📡 本日の実際の試合」から見られます。", "(まだ終わっていない 13件 / 終了済みで照合待ち 0件)", "最後の答え合わせ 8時間前", "自動照合の最終実行 0時間前", "若手有望株: 19歳・出場1580分・平均評価6.84", "22歳・直近4試合の平均評価 8.23", "出場1950分・平均評価 8.01", "GK(ゴールキーパー)", "好調な若手", "安定した主力", "ホーム勝率", "予測の自信", "2軍・女子・ユースのチームは収集の対象外のため、選手データはありません(このAIは男子のトップチームを対象にしています)。", "AIが追跡している別のクラブと同じ名前のチームのため、選手データは表示しません(別のクラブの情報を混ぜないための措置です)。"]) {
      const tr = engines[l].window.t(s); assert.ok(tr !== s && !leftover(tr, l), `${l}: ${s} → ${tr}`);
    }
    assert.ok(HTML.includes("🔁 <span>${escapeHtml(msMeta.noteJa)}</span>") && HTML.includes("(msMeta.focusJa && !nonJaUi) ? ` <span>論点:</span> ${escapeHtml(msMeta.focusJa)}` : \"\""), "注記は別の要素・論点は日本語の画面だけ");
    // 根拠の利用: 候補の件数はサーバーが返す poolCount から出す(従来は存在しない項目を読んで常に「—」だった)
    assert.ok(SERVER.includes("poolCount: quality.rag.poolCount, usedCount: quality.rag.usedCount,"), "サーバーの項目名");
    assert.ok(HTML.includes("候補${ragNum(ragU.candidates ?? ragU.retrieved ?? ragU.poolCount)}件のうち"), "画面が poolCount を読む");
    assert.strictEqual(engines.en.window.t("🔍 根拠の利用: 候補5件のうち"), "🔍 Evidence usage: of 5 candidates,");
    assert.strictEqual(engines.en.window.t("を回答に使いました(40%)"), " were used in the answer (40%)");
    // 言語選択の画面の注記: 会話の詳細に引用される保存済みの知識が日本語のまま残る場合があることを、3言語で正直に書いている
    assert.ok(/stored knowledge quoted in the AI chat's details/.test(HTML) && /AI问答详情中引用的已存知识/.test(HTML) && /conocimiento guardado que se cita en los detalles del chat de IA/.test(HTML)
      // v104.1(総点検): 実データを入れると残る範囲(一部のクラブ名・選手名、毎日の自己点検の質問と答え、学習の記録と反省)も書いてあること。
      //   「すべてあなたの言語で」という言い過ぎの文面は残っていないこと。
      && /some club and player names, the daily self-check questions and answers, learning logs and reflections/.test(HTML)
      && /部分俱乐部名和球员名、每日自检的问题与回答、学习日志与反思/.test(HTML)
      && /algunos nombres de clubes y jugadores, las preguntas y respuestas diarias de autocomprobación/.test(HTML)
      && !/Fully available in your language/.test(HTML));
  });

  // ---------------------------------------------------------------------------
  // 翻訳エンジンの速さと同値性(v104.1 総点検)
  //   型(約700個の正規表現)を、すべての文字列に実行していたため、読点・句点が何十回も続く長い文
  //   (1,000文字級)では「後戻り」が積み重なり、1つの文字列に約1秒かかっていた(日本語以外の表示で画面が固まる)。
  //   「固定部分が順番どおりに含まれるか」を先に線形時間で確かめ、満たさないときは正規表現を実行しない。
  // ---------------------------------------------------------------------------
  /** 翻訳エンジンを、内部の型の一覧(P)・辞書(X)が見える形で読み込む */
  function loadEngineWithInternals(lang) {
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
    let m, code = null;
    while ((m = re.exec(HTML))) { if (m[2].includes("var X = {};") && m[2].includes("function add(map)")) { code = m[2]; break; } }
    const hook = "  window.t = function (s) {";
    assert.ok(code && code.includes(hook), "翻訳エンジンの差し込み位置が見つからない");
    code = code.replace(hook, "  window.__P = P; window.__X = X;\n" + hook);
    const sandbox = {
      document: { readyState: "loading", addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; }, createElement() { return { setAttribute() {}, appendChild() {}, style: {} }; }, body: null, documentElement: { setAttribute() {}, lang: "" } },
      localStorage: { getItem: (k) => (k === "appLang" ? lang : null), setItem() {} },
      location: { reload() {}, href: "http://localhost/" }, navigator: { language: "en" },
      console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("no fetch")),
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "i18n-engine.js" });
    return sandbox;
  }

  await t("N5 型の事前判定は、訳の結果を変えない: 全ての型 × 文字列(辞書の見出し・型に値を入れた文・惜しい文・改行入り)で、元の正規表現と一致/不一致・取り出した中身が完全に同じ", () => {
    const E = loadEngineWithInternals("en");
    const P = E.__P, X = E.__X;
    assert.ok(Array.isArray(P) && P.length >= 600, "型の一覧を取り出せない");
    const pats = P.map((row) => ({ neu: row[0], old: new RegExp(row[0].source) }));
    const guarded = pats.filter((p) => Object.prototype.toString.call(p.neu) !== "[object RegExp]").length;
    assert.ok(guarded >= pats.length * 0.95, `事前判定つきの型が少ない: ${guarded}/${pats.length}`);
    const lits = [], templates = [];
    for (const p of pats) { const parts = p.old.source.slice(1, -1).split("(.*?)").map((x) => x.replace(/\\(.)/g, "$1")); templates.push(parts); for (const x of parts) if (x) lits.push(x); }
    let seed = 20261114; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const fillers = ["3", "12.5", "レアル・マドリード", "Arsenal", "", "A、B", "(参考)", "50%", "勝ち・引き分け", "2026年11月14日", "件", "。", "⚽ 得点", "1-0", " ", "x(y)z", "試合", "です。"];
    const corpus = new Set();
    const keys = Object.keys(X); for (let i = 0; i < keys.length; i += 3) corpus.add(keys[i]);
    for (const parts of templates) {
      for (let rep = 0; rep < 3; rep++) {
        let str = parts[0];
        for (let i = 1; i < parts.length; i++) str += (rep === 0 ? pick(fillers) : rep === 1 ? pick(lits) : pick(fillers) + pick(lits)) + parts[i];
        corpus.add(str);
        if (rep === 0) { corpus.add("🧠 " + str); corpus.add(str + " ✅"); corpus.add(str + "\n" + str); corpus.add(str.slice(0, -1)); corpus.add(str.slice(1)); corpus.add(str + str); }
      }
    }
    for (let i = 0; i < 800; i++) { let str = ""; const n = 1 + Math.floor(rnd() * 5); for (let j = 0; j < n; j++) str += pick(lits) + (rnd() < 0.5 ? pick(fillers) : ""); corpus.add(str); }
    corpus.add(""); corpus.add("改行\nあり"); corpus.add("\r\n");
    let pairs = 0, matches = 0;
    for (const str of corpus) {
      for (let k = 0; k < pats.length; k++) {
        const a = pats[k].old.exec(str), b = pats[k].neu.exec(str); pairs++;
        if (a) matches++;
        const same = (a === null && b === null) || (a && b && a.length === b.length && a.index === b.index && a.every((v, i) => v === b[i]));
        if (!same) assert.fail(`結果が違う: 型 ${pats[k].old.source.slice(0, 80)} / 文字列 ${JSON.stringify(str.slice(0, 80))} / 元 ${JSON.stringify(a && [...a])} / 新 ${JSON.stringify(b && [...b])}`);
      }
    }
    assert.ok(pairs > 2000000 && matches > 2000, `突き合わせの量が足りない: ${pairs} 組・一致 ${matches}`);
  });

  await t("N6 読点・句点が何十回も続く長い文(1,000文字級)でも、翻訳に時間が掛からない(直す前: 1つの文字列に約1秒 → いま: 数ミリ秒)。訳せない文は原文のまま返す", () => {
    const longS = "これは辞書に無い長い文章で、翻訳の型にも一致しないように書いてあります";
    const cases = ["⚠️ " + (longS + "、").repeat(30) + "。", "🧠 " + (longS + "。").repeat(6) + " ✅", "(" + (longS + "。").repeat(5) + ")", ("・" + longS + "(12件)。").repeat(6)];
    for (const lang of ["en", "zh", "es"]) {
      const E = loadEngine(lang);
      E.window.t("準備"); // 1回目の呼び出し(初期化)を計測に入れない
      for (const str of cases) {
        const t0 = process.hrtime.bigint();
        const out = E.window.t(str);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 150, `${lang}: ${str.length}文字の翻訳に ${ms.toFixed(0)}ms かかった`);
        assert.strictEqual(typeof out, "string");
      }
      // 訳せる文は従来どおり訳す(速くしただけで、訳を落としていない)
      assert.ok(!/[ぁ-んァ-ヶ]/.test(E.window.t("(モデル生値62%・同じ自信帯の実測187件に基づく補正)")), lang + ": 型の訳が効いていない");
    }
  });

  // ---------------------------------------------------------------------------
  // 総点検・第2回(11月14日 夜): 模擬の実データを入れた画面を実ブラウザで総当たりし、翻訳エンジンが受け取った原文を
  //   すべて記録して調べた結果の再発防止。崩れた訳(半端な訳)・訳されないまま残る文・起動時の無駄を固定する。
  // ---------------------------------------------------------------------------
  console.log("■ 総点検・第2回: 崩れた訳を出さない / 文のまとまり・並び・記号の端 / 名前の対応表");
  /** 画面と同じ条件にする: 言語パック(/i18n.<言語>.json)と、本体の script にある名前の対応表(クラブ・登録選手)も読み込む */
  async function loadEngineFull(lang) {
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
    let m, code = null;
    while ((m = re.exec(HTML))) { if (m[2].includes("var X = {};") && m[2].includes("function add(map)")) { code = m[2]; break; } }
    assert.ok(code, "翻訳エンジンの script が見つからない");
    const sandbox = {
      document: { readyState: "complete", title: "", addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return { setAttribute() {}, appendChild() {}, style: {} }; }, body: null, documentElement: { setAttribute() {}, lang: "" } },
      localStorage: { getItem: (k) => (k === "appLang" ? lang : null), setItem() {} },
      location: { reload() {}, href: "http://localhost/" }, navigator: { language: "en" },
      console, setTimeout, clearTimeout,
      fetch: (u) => { const mm = /\/i18n\.(\w+)\.json/.exec(String(u)); if (!mm) return Promise.reject(new Error("no fetch")); return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(__dirname, `i18n.${mm[1]}.json`), "utf8"))) }); },
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "i18n-engine.js" });
    for (const name of ["UNIVERSE_CLUB_JA_TO_EN", "CLUB_JA_TO_EN", "PLAYERS"]) {
      const st = HTML.indexOf(`\nconst ${name} = {`);
      assert.ok(st >= 0, name + " が index.html に無い");
      const en = HTML.indexOf("\n};", st);
      vm.runInContext(HTML.slice(st + 1, en + 3), sandbox, { filename: name + ".js" });
    }
    await new Promise((r) => setTimeout(r, 30)); // 言語パックの読み込み(fetch の then)を待つ
    return sandbox;
  }
  const EN2 = { en: await loadEngineFull("en"), zh: await loadEngineFull("zh"), es: await loadEngineFull("es") };
  assert.ok(EN2.en.window.t("ゴール前での得点力はさらなる上積みが期待される") !== "ゴール前での得点力はさらなる上積みが期待される", "言語パックが読み込めていない");
  const KANA = /[ぁ-んァ-ヶ]/, KANA_KANJI = /[ぁ-んァ-ヶ一-龥]/;
  const leftJa = (out, l) => (l === "zh" ? KANA : KANA_KANJI).test(out);
  const fullAll = (src) => { for (const l of ["en", "zh", "es"]) { const out = EN2[l].window.t(src); assert.ok(!leftJa(out, l), `${l}: 日本語が残った: ${src} → ${out}`); } };

  await t("N7 崩れた訳を出さない: 「⦿年⦿月」「⦿歳」「⦿勝ち」のような短い型が、文や項目の並びの端だけに当たって語順を崩さない", () => {
    const E = EN2.en.window;
    // 直す前: 「8/完全移籍(移籍金あり) ・ トッテナム・ホットスパーより ・ 2023」
    assert.strictEqual(E.t("完全移籍(移籍金あり) ・ トッテナム・ホットスパーより ・ 2023年8月"), "Permanent transfer (fee paid) ・ from Tottenham Hotspur ・ 8/2023");
    assert.strictEqual(E.t("完全移籍(移籍金あり) ・ レアル・ソシエダ経由レアル・マドリードより ・ 2021年8月"), "Permanent transfer (fee paid) ・ from Real Madrid via Real Sociedad ・ 8/2021");
    assert.strictEqual(E.t("RBライプツィヒ(下部組織)より ・ 2015年"), "from RB Leipzig (academy) ・ 2015");
    // 直す前: 「avg rating age 7.64・川崎フロンターレ・21」(入れ子の半端な訳を完訳として確定していた)
    assert.strictEqual(E.t("平均評価 7.64・川崎フロンターレ・21歳"), "avg rating 7.64, Kawasaki Frontale, age 21");
    assert.strictEqual(E.t(": ゴール 11・ヴィッセル神戸・19歳"), ": Goals 11, Vissel Kobe, age 19");
    // 直す前: 勝ちだけ「win」になり、負け・分けと(ホーム)が日本語のまま混ざっていた
    assert.strictEqual(E.t("2026-11-19 Premier League Tottenham(ホーム) 3-1 勝ち"), "2026-11-19 Premier League Tottenham (home) 3-1 win");
    assert.strictEqual(E.t("2026-11-21 Premier League Chelsea(アウェイ) 0-2 負け"), "2026-11-21 Premier League Chelsea (away) 0-2 loss");
    assert.strictEqual(E.t("2026-11-17 Premier League Manchester United(アウェイ) 2-2 分け"), "2026-11-17 Premier League Manchester United (away) 2-2 draw");
    for (const src of ["完全移籍(移籍金あり) ・ トッテナム・ホットスパーより ・ 2023年8月", "平均評価 7.64・川崎フロンターレ・21歳", "2026-11-21 Premier League Chelsea(アウェイ) 0-2 負け", "約€18〜22m(報道により幅あり)", "約$13.5〜22m(出来高含む、報道により幅あり)", "£27m(完全移籍、レンタル移籍からの買取)", "2016年7月(加入後レンタルを経てトップチーム昇格)", "2025年2月頃", "生え抜き(移籍金なし)", "リーグID 10(144人)"]) fullAll(src);
  });

  await t("N8 訳せない文は、原文のまま出す(日本語が多く残る・語順の崩れた「半端な訳」を出さない)。ほぼ訳せた文(半分以上が訳せて、残りが原文どおり1か所)だけ従来どおり使う", () => {
    for (const l of ["en", "zh", "es"]) {
      const E = EN2[l].window;
      // 直す前(英語): 「draws の可能性も残ります。」「🌍 General view: 一般に is 守備が安定した側が有利.」
      for (const src of ["引き分けの可能性も残ります。", "一般には守備が安定した側が有利です。", "中盤の主導権が鍵だと考えます。", "ブレイクする時間帯)", "の「最近5試合」: API-Footballの選手検索で「Tom Bischof」に一致する選手が見つかりませんでした"]) {
        assert.strictEqual(E.t(src), src, `${l}: 訳せない文を書き換えた: ${src} → ${E.t(src)}`);
      }
    }
    // ほぼ訳せた文(残る日本語が1か所・少量)は、従来どおり訳して出す
    const r = EN2.en.window.t("理由: 直近25試合の検証結果で、的中率が20%→20%に上がったため(拡張特徴量モデル(v2))。");
    assert.ok(/^Reason: Because validation on the last 25 matches/.test(r), r);
    // v102: 学習の種類の名前(基本モデル・拡張特徴量モデルなど)にも訳を付けたので、この文は全部訳される
    const r2 = EN2.en.window.t("理由: 直近21試合の検証結果で、的中率が28.6%→28.6%に上がったため(基本モデル(v1・フォーム差のみ))。");
    assert.ok(/^Reason: Because validation on the last 21 matches/.test(r2) && /\(Basic model \(v1, form difference only\)\)/.test(r2) && !/[ぁ-んァ-ヶ一-龥]/.test(r2), r2);
    // 「ほぼ訳せた文(残りが原文どおり1か所)」の確認は、辞書に無い名前で行う
    const r2b = EN2.en.window.t("理由: 直近21試合の検証結果で、的中率が28.6%→28.6%に上がったため(ズワルキコモデル)。");
    assert.ok(/^Reason: Because validation on the last 21 matches/.test(r2b) && /\(ズワルキコモデル\)/.test(r2b), r2b); // 残りは原文どおり1か所
    const r3 = EN2.en.window.t("ℹ️ 128クラブ(パリ・サンジェルマン・PSVアイントホーフェン・アヤックスほか)は、データ提供元での表記が異なるため今回は収集できませんでした。");
    assert.ok(/128 clubs/.test(r3) && /couldn't be collected/.test(r3), r3);
  });

  await t("N9 文のまとまり: 「2〜3文で1つの型」と「1文の型」が続く文字列を、まとまりに区切って訳す(端末内の簡易チャットの回答・選手比較)", () => {
    const answers = [
      "AIが能力値から算出した最適戦術は「ポゼッション」(★4/5)です。次点は「ビルドアップ」(★4/5)。監督タイプとの相性では「規律型の堅守速攻(伝統的イタリア式)」との適性が高いと推定されています。 逆に最も適性が低い戦術は「ロングボール主体」(★3/5)で、能力値の重み付け(スピード・フィジカル・戦術理解など)から算出しています。",
      "AIが分析するDeclan Riceの課題は「ゴール前での得点力はさらなる上積みが期待される」です。スカウティングレポートでは「得点関与はさらなる上積みの余地がある。」ともコメントされています。 能力値内訳ではシュート(50)が最も低く、対戦相手からはここを狙われやすいと推定されます。",
      "Declan Riceは27歳で脂の乗った年代に入っており、AIの将来性評価は★☆☆☆☆、即戦力評価は★★★★☆です。大きな伸びよりも高いレベルでの安定的な活躍が期待されます。 ビッグクラブ適性は★★★★☆と評価されています。",
      "🤖 Declan RiceとErling Haalandの能力値ベクトルの類似度はAI計算で69%です。総合評価はErling Haalandが8.0ポイント上回っています。最も差が大きい項目は「守備」で、Declan Riceが56ポイント上回っています。プレースタイル診断ではDeclan Riceが🧠司令塔タイプ、Erling Haalandが🐆ハンタータイプと分析されています。 🤖 AIのおすすめ: 総合力だけで選ぶならErling Haalandです。ただしDeclan Riceは🧠司令塔タイプとしての持ち味があるため、チームの戦術や欲しい役割によってはDeclan Riceを選ぶ選択肢も十分にあります。",
      "API-Football(有料API)から取得した2026シーズンの成績です(2026-11-22時点・キャッシュ済みの場合あり)。所属: Tottenham。",
      "この報告はすべて、保存されている実測値と実際の実行結果から機械的に作っています。AIが文章を作って「賢くなりました」と述べているのではありません。取得できていないものは、取得できていないと書いています。",
      "[似たクラブ] 実測データ(リーグ順位・xG収支・ホーム勝率・怪我人数)の距離では、FCバルセロナがベンフィカに最も近い状態のクラブです。共通点: 同じ基本布陣(4-3-3)・怪我人数も同水準(2人)。監督はHiro Dubois。(毎晩更新の索引による機械的な判定)",
      "検索条件にできない項目: 利き足は API-Football が提供していないため、検索条件にできません(推測で埋めることはしません)。 市場価値は API-Football が提供していないため、検索条件にできません(Transfermarkt等の別ソースが必要です)。 契約状況(契約満了年など)は API-Football が提供していないため、検索条件にできません。",
    ];
    for (const a of answers) fullAll(a);
    // 日本語を含まない文が混ざっていても、そこはそのまま通す
    const mixed = EN2.en.window.t("Declan Riceは27歳で脂の乗った年代に入っており、AIの将来性評価は★☆☆☆☆、即戦力評価は★★★★☆です。大きな伸びよりも高いレベルでの安定的な活躍が期待されます。 OK.");
    assert.ok(/OK\.$/.test(mixed) && !KANA_KANJI.test(mixed), mixed);
  });

  await t("N10 記号の端: 色付きの印や太字の前後で切れた断片(「…展開です。(」「バイエルン・ミュンヘン /」「: このAI自身の予想…」)を訳す。対になった括弧は中身の一部として残す", () => {
    const E = EN2.en.window;
    assert.strictEqual(E.t("アーセナルFCが主導権を握る時間が長いと予想されますが、バイエルン・ミュンヘンにもチャンスがある展開です。("), "Arsenal FC is expected to control long spells, but the pattern still offers Bayern Munich chances.(");
    assert.strictEqual(E.t("バイエルン・ミュンヘン /"), "Bayern Munich /");
    assert.strictEqual(E.t(": このAI自身の予想: Benfica勝利(予想スコア 1-0)"), ": This AI's own prediction: Benfica win (predicted score 1-0)");
    assert.strictEqual(E.t("🎯 ハリー・ケイン(総合評価 90.0)"), "🎯 Harry Kane (overall 90.0)");
    assert.strictEqual(E.t("得点:"), "Goals:");
    assert.strictEqual(E.t("(本日の学習実行の実測値です。)"), "(Measured values from today's learning run.)"); // 対の括弧は従来どおり
    for (const src of ["📋 マンチェスター・シティ 予想フォーメーション", "レアル・マドリードはボール保持を軸にした組み立てが持ち味、対するマンチェスター・シティはスピードと決定力を活かした縦への速さが持ち味とAIは分析しています。マンチェスター・シティがやや優勢という分析です。", "✅ FCバルセロナは攻撃力で相手を上回っており(平均90.0 対 84.0)、ここが試合を優位に進める鍵になるとAIは予想しています。", "・なぜ評価87なの？", "・イングランド代表なら？", "🔴 LIVE 前半"]) fullAll(src);
  });

  await t("N11 名前の対応表: 辞書に無いクラブ名・登録選手名は、アプリ本体の対応表(日本語名 → アルファベット表記)で出す。自己点検の質問(全問)と答えの型が訳される", () => {
    const AUTOQA_SRC = fs.readFileSync(path.join(__dirname, "learning/autoQA.js"), "utf8");
    const qs = [...AUTOQA_SRC.matchAll(/questionJa: "([^"]+)"/g)].map((m) => m[1]);
    const targets = [...AUTOQA_SRC.matchAll(/targetJa: "([^"]+)"/g)].map((m) => m[1]);
    const clubs = [...AUTOQA_SRC.matchAll(/kind: "club", questionJa: "[^"]+", nameEn: "[^"]+", nameJa: "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(qs.length >= 80 && targets.length >= 40 && clubs.length >= 40, `自己点検の質問を読み取れていない: ${qs.length}/${targets.length}/${clubs.length}`);
    for (const q of qs) fullAll(q);
    for (const tg of targets) fullAll(`「${tg}」は選手索引にまだ入っていないため、答えられません。`);
    for (const c of clubs) { fullAll(`${c}の調査ファイルがまだ作られていません。`); fullAll(`(${c})`); }
    const U = require(path.join(__dirname, "learning/clubUniverse.js")).CLUB_UNIVERSE;
    for (const c of U) fullAll(c.nameJa); // 推しクラブの選択肢(172クラブ)
    for (const src of ["昨日と同じ内容です(15項目)。この質問については新しい情報が入っていません。", "✅ 本日(2026-11-22)の学習は14段階すべてを通って完走しました(所要 0分)。", "直近の1試合平均得点", "直近7日間の試合数", "上位の並べ替えなので、増えた数にも減った数にも入れていません(順位が変わっただけで、その選手について答えられなくなったわけではありません)。"]) fullAll(src);
    // 調査ファイルの「変化」の文(knowledge/clubDossier.js の型)。文末の「。」あり・なしの両方
    for (const base of ["バイエルン・ミュンヘンの直近フォーム(1試合平均得失点差)が1.2から0.6へ下向きました", "FCポルトの国内リーグ順位が4位から5位に下がりました", "セレッソ大阪の負傷・出場停止者が3人から2人に減りました", "アーセナルの監督が交代しました: A. Smith → B. Jones", "リヴァプールの基本布陣が変わりました: 4-3-3 → 4-2-3-1", "ナポリの登録選手数が25人から26人に変わりました"]) {
      fullAll(base); fullAll(base + "。"); fullAll(`[学習エンジン 2026-11-16] ${base}。`); fullAll(`[最近の変化 2026-11-21] ${base}`);
    }
  });

  await t("N12 漢字だけの語(かなを含まないため従来の検査に掛からなかったもの)も、英語・スペイン語で訳される: 成績表の単位・能力の名前・契約の語", () => {
    const E = EN2.en.window;
    assert.strictEqual(E.t("18試合"), "18 matches");
    assert.strictEqual(E.t("1200分"), "1200 min");
    for (const src of ["18試合", "1200分", "3点", "18本", "54回", "3枚", "10項目", "攻撃力", "守備", "消化試合", "勝点", "市場価値", "契約", "最重要", "完全移籍(移籍金非公開)", "…他240件", "負傷・出場停止: S. Muller(Knee Injury)"]) {
      for (const l of ["en", "es"]) { const out = EN2[l].window.t(src); assert.ok(!KANA_KANJI.test(out), `${l}: ${src} → ${out}`); }
    }
    // 短い単位の型は、数字1つのような「ひとかたまりの値」にしか当たらない(文の端を動かさない)
    assert.strictEqual(E.t("今回"), "今回");
    assert.strictEqual(E.t("前半45分"), "前半45分");
  });

  await t("N13 <script> や <style> の中身・入力欄(textarea)は訳さない(日本語以外の画面の起動時に、プログラム本体を丸ごと翻訳にかけていた無駄の再発防止)", () => {
    const fn = extractFunction("translateTextNode");
    assert.ok(/SKIP_PARENT\[pn\.nodeName\] === 1\) return;/.test(fn), "translateTextNode が親要素を見ていない");
    assert.ok(/var SKIP_PARENT = \{ SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 \};/.test(HTML));
    // 実際に動かす: 親が SCRIPT の節は書き換えず、親が P の節は訳す
    // 実際に動かす: 関数を取り出し、親が SCRIPT / STYLE / TEXTAREA の節は書き換えず、親が P の節は訳すことを確かめる
    const run = new Function("tr", "seen", "SKIP_PARENT", `${fn}; return translateTextNode;`);
    const tnode = run((s0) => (s0 === "閉じる" ? "Close" : null), null, { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 });
    const mk = (parentName) => ({ nodeType: 3, nodeValue: " 閉じる ", parentNode: { nodeType: 1, nodeName: parentName } });
    for (const tag of ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]) { const n = mk(tag); tnode(n); assert.strictEqual(n.nodeValue, " 閉じる ", tag + " の中身を書き換えた"); }
    const pNode = mk("P"); tnode(pNode); assert.strictEqual(pNode.nodeValue, " Close ");
  });

  await t("N15 端末内の簡易チャット(選手カード)の回答: 長所・課題が「A」「B」「C」と並ぶ形、スカウティングの文が2つ以上、年齢・ベテラン・代表の回答が訳される(直す前: 登録選手107人 × 質問25通りの回答1,819件のうち、英語で728件に日本語が残っていた)", () => {
    const answers = [
      "AIが分析するLionel Messiの課題は「空中戦」「ハイプレスへの継続的な参加」「守備範囲」です。スカウティングレポートでは「守備時の運動量は全盛期より減少。 空中戦は武器ではない。」ともコメントされています。 能力値内訳では守備(42)が最も低く、対戦相手からはここを狙われやすいと推定されます。",
      "Lionel Messiは39歳(1987-06-24生まれ)です。",
      "Lionel Messiは39歳でキャリア後半に差し掛かっており、AIの将来性評価は★☆☆☆☆です。急激な能力向上より、経験を生かした活躍が期待される時期です。 ビッグクラブ適性は★★★★★と評価されています。",
      "Piero Hincapiéがエクアドル代表でプレーする場合、AI分析では🛡️守備職人タイプとして「ポゼッションサッカー」を志向するチームとの相性が良いと推定されます。",
      "Felipe Chávezがペルー代表でプレーする場合、AI分析では🚄スプリンタータイプとして「ポゼッションサッカー」を志向するチームとの相性が良いと推定されます。",
      // 契約の回答は、日本語以外の画面では「項目の並び」で返す(contractAnswerText)
      "Lionel Messi ・ フリー移籍(移籍金なし) ・ パリ・サンジェルマンより ・ 2023年7月 ・ 契約満了に伴うフリー移籍でインテル・マイアミへ。",
      "Martin Ødegaard ・ 約€35〜40m(レンタルからの完全移籍) ・ レアル・ソシエダ経由レアル・マドリードより ・ 2021年8月 ・ 2021年1月にレンタル加入後、同年8月に完全移籍。",
      "Manuel Neuer ・ 約€18〜22m(報道により幅あり) ・ FCシャルケ04より ・ 2011年",
    ];
    for (const a of answers) fullAll(a);
    // 引用符のつなぎは各言語のもの(日本語の「」「を英語・スペイン語の文に残さない)
    const en = EN2.en.window.t(answers[0]), es = EN2.es.window.t(answers[0]), zh = EN2.zh.window.t(answers[0]);
    assert.ok(/"Aerial duels", "[^"]+", "[^"]+"\./.test(en) && !/」「/.test(en), en);
    assert.ok(/«[^»]+», «[^»]+», «[^»]+»/.test(es) && !/」「/.test(es), es);
    assert.ok(/」「/.test(zh), zh);
    // 画面の関数が、日本語以外では並びの形を返す(日本語の画面の文は従来どおり)
    const fn = extractFunction("contractAnswerText");
    assert.ok(/if \(uiIsNonJa\(\)\) return \[player\.name, headline, c\.fromClub \? c\.fromClub \+ "より" : "", c\.date \|\| "", c\.note \|\| ""\]\.filter\(Boolean\)\.join\(" ・ "\);/.test(fn), "contractAnswerText が日本語以外で並びの形を返していない");
    const mk = (nonJa) => new Function("uiIsNonJa", "CONTRACT_TYPE_LABEL", `${fn}; return contractAnswerText;`)(() => nonJa, { free: "フリー移籍(移籍金なし)" });
    const pl = { name: "Lionel Messi", contract: { type: "free", fromClub: "パリ・サンジェルマン", date: "2023年7月", note: "契約満了に伴うフリー移籍でインテル・マイアミへ。" } };
    assert.strictEqual(mk(false)(pl), "Lionel Messiはパリ・サンジェルマンからフリー移籍(移籍金なし)(2023年7月)で加入しました。契約満了に伴うフリー移籍でインテル・マイアミへ。"); // 日本語は1文字も変えない
    assert.strictEqual(mk(true)(pl), answers[5]);
  });

  await t("N16 空白つきの「 / 」で並べた項目(選手検索の候補の「クラブ / ポジション / 国」)を1つずつ訳す。既存の「 / 」入りの型は従来どおり", () => {
    for (const src of ["スポルティングCP / GK(ゴールキーパー) / Portugal", "サンフレッチェ広島 / GK(ゴールキーパー) / Japan", "ボルシア・ドルトムント / FW(フォワード) / Germany", "Argentina / DF(ディフェンダー) / World"]) fullAll(src);
    assert.strictEqual(EN2.en.window.t("サンフレッチェ広島 / GK(ゴールキーパー) / Japan").split(" / ")[0], "Sanfrecce Hiroshima");
    fullAll("今週の成績: 3勝 / 5試合(60%)");
  });

  await t("N17 「、」で並べた名前(クラブ概要の回答の中心選手など)を1つずつ訳す。文の中の読点は割らない(項目がすべて辞書か名前の対応表にあるときだけ)", () => {
    const E = EN2.en.window;
    assert.strictEqual(E.t("ハリー・ケイン、ヨシュア・キミッヒ、ジャマル・ムシアラ"), "Harry Kane, Joshua Kimmich, Jamal Musiala");
    fullAll("中心選手はハリー・ケイン、ヨシュア・キミッヒ、ジャマル・ムシアラで、特にハリー・ケイン(評価90.0)がチームの核と分析されています。");
    fullAll("バイエルン・ミュンヘンには現在34人の選手が登録されており、AI総合評価の平均は77.7/100です。中心選手はハリー・ケイン、ヨシュア・キミッヒ、ジャマル・ムシアラで、特にハリー・ケイン(評価90.0)がチームの核と分析されています。登録選手の能力値からAIが推定する最適戦術は「ポゼッションサッカー」です。平均スピードの高さが、この戦術評価の主因になっています。");
    fullAll("解放条項を行使しての完全移籍 ・ ボルシア・ドルトムントより ・ 2022年7月");
    // 読点を含むふつうの文は、割って訳したことにしない(原文のまま)
    for (const src of ["予想はホームチームの勝利でしたが、実際は引き分けでした。", "守備、攻撃、戦術のすべてで上回りました"]) assert.strictEqual(E.t(src), src);
  });

  await t("N14 速さ: 新しい処理(まとまり・並び・記号の端・入れ子5段)を足しても、訳せない長文で時間が掛からない", () => {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(`これは${i}番目の訳せない文で、読点、中黒・括弧(かっこ)、数字${i * 37}件や${i}年${i + 1}月を含みます。`);
    const longStr = parts.join(" ");
    const listStr = Array.from({ length: 10 }, (_, i) => `項目その${i}`).join("・");
    for (const l of ["en", "zh", "es"]) {
      const E = EN2[l].window;
      for (const str of [longStr, listStr, "(" + longStr, longStr + "(", "🧠 " + longStr]) {
        const t0 = process.hrtime.bigint();
        const out = E.t(str);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 150, `${l}: ${str.length}文字の翻訳に ${ms.toFixed(0)}ms かかった`);
        assert.strictEqual(out, str, `${l}: 訳せない文を書き換えた: ${out.slice(0, 80)}`);
      }
    }
  });

  console.log(`\nv104.1 i18n chat: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
