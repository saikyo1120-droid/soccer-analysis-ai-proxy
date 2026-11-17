"use strict";
/**
 * v104.3(2026年11月15日)・「見た目の全面リニューアル」の検証(利用者のご要望)
 * ----------------------------------------------------------------------------
 *   「サイトを全体的に(見本の画像のように)おしゃれに。おしゃれさも大事だが、使いやすさも考える。便利に、そしておしゃれに。」
 *   ・ページの上は濃い色の帯、カードは枠線なし(影で浮かせる)、数字は大きく、当たり外れ・注意は色つきの札(印つき)
 *   ・スマホは画面の下にメニュー(予想・質問・試合・選手・もっと)。色(明るい/暗い)は端末の設定に合わせ、選んだら覚える
 *   ・飾りの絵文字は画面に出さない(文字列は変えない)。意味のある印(当たり・外れ・注意)は、そろいの印に置き換える
 *   ・「根拠をくわしく見る」の中を図に(AIが重く見たこと=5段階の目盛り、スコアの可能性=札)
 *   ・試合一覧は2チームを2行に、試合中・試合後のカードは濃い帯の見出しに、2人の比較は左右の棒に
 *   ・数字は作らない(渡された実測をそのまま描く)。色だけで意味を伝えない(白い文字を乗せる色は 4.5:1 以上)
 * index.html を読み、図の部品(VZ)と描画の関数を、最小限の模擬 DOM の上でそのまま評価して確かめる(外部通信なし)。
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const SERVER_DIR = __dirname;
const htmlPath = fs.existsSync(path.join(SERVER_DIR, "index.html")) ? path.join(SERVER_DIR, "index.html") : path.join(SERVER_DIR, "..", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const strip = (h) => String(h).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const count = (s, re) => (String(s).match(re) || []).length;

// ---------------------------------------------------------------------------
// 最小限の模擬 DOM(この検査で触る部品だけ本物らしく動く)
// ---------------------------------------------------------------------------
function makeEl(id) {
  const listeners = {}; const attrs = {}; const classes = new Set();
  const el = {
    id, innerHTML: "", textContent: "", value: "", style: {}, children: [], dataset: {}, hidden: false,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire(ev, arg) { (listeners[ev] || []).slice().forEach((fn) => fn(arg || {})); },   // 検査から、その要素の出来事(入力・キー)を起こす
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; }, matches() { return false; }, contains(x) { return x === el; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; }, hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
    appendChild() {}, remove() {}, focus() {}, click() {}, scrollIntoView() {},
    classList: { toggle(c, on) { const w = on === undefined ? !classes.has(c) : !!on; if (w) classes.add(c); else classes.delete(c); return w; }, add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
    _attrs: attrs,
  };
  return el;
}
function buildDom() {
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const docL = {};
  const document = {
    getElementById: get, documentElement: makeEl("html"), body: makeEl("body"),
    querySelectorAll() { return []; }, querySelector() { return makeEl("stub"); },
    addEventListener(ev, fn) { (docL[ev] = docL[ev] || []).push(fn); }, createElement() { return makeEl("created"); },
  };
  return { document, get, docL };
}
function makeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _map: m };
}
const mainScript = (() => {
  const scripts = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  return scripts.reduce((a, b) => (b.length >= a.length ? b : a), "");
})();
/** index.html の本体スクリプト(いちばん大きいインライン script)を模擬 DOM の上で評価する */
function loadApp(opts) {
  const o = opts || {};
  const code = mainScript + `\nreturn { VZ, vzShell, predBarHtml, predFactorsLineHtml, predScenarioLineHtml, predStripHtml, predReasonLineHtml, predictionSummaryBlockHtml,
    fixtureRowHtml, buildLiveAnalysisHtml, buildFinishedAnalysisHtml, buildUpcomingPreviewHtml, matchEventKind, MATCH_EVENT_KINDS, eventsTimelineVisualHtml, eventsTimelineHtml,
    knowledgeKeyPlayersHtml, knowledgeRecentFormHtml, knowledgeCompareHtml, matchHeroHtml, matchFlowBlockHtml, playerRatingRowHtml, psCompareDuoHtml, psCard,
    buildMostImportantFactorBanner, accuracySplitHtml, renderSmarterCard, renderDailyDiff, psRecentMatchesHtml, predsByFixtureId,
    psOpenByName, psOpenDetail, psWireCombo, psState, psScrollTo, psSearch, psEnsureInit, PLAYERS, renderComparison, psSyncToc };`;
  const dom = buildDom();
  const storage = (o.storage && typeof o.storage.getItem === "function") ? o.storage : makeStorage(o.storage);
  const windowStub = Object.assign({ navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {}, location: { hash: "", origin: "http://x", pathname: "/" } }, o.window || {});
  const fetchStub = o.fetch || (async () => { throw new Error("no network"); });
  const fn = new Function("document", "window", "navigator", "fetch", "localStorage", "location", code);
  const api = fn(dom.document, windowStub, windowStub.navigator, fetchStub, storage, windowStub.location);
  return { api, dom, storage, windowStub };
}
/** 翻訳エンジン(辞書+型)だけを vm で読み込む */
function loadI18n(lang) {
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m, code = null;
  while ((m = re.exec(html))) { if (m[2].includes("var X = {};") && m[2].includes("function add(map)")) { code = m[2]; break; } }
  assert.ok(code, "翻訳エンジンの script が見つからない");
  const el = () => ({ setAttribute() {}, appendChild() {}, style: {} });
  const sandbox = {
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: el, body: null, documentElement: { setAttribute() {}, lang: "ja" }, title: "" },
    localStorage: { getItem: (k) => (k === "appLang" ? lang : null), setItem() {} },
    location: { reload() {}, href: "http://localhost/" }, navigator: { language: "en" },
    console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("no fetch")),
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: "i18n-engine.js" });
  return sandbox.window.t;
}
// ---- 色のコントラスト(WCAG 2.x)----
const lum = (hex) => { const h = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
function tokens(blockStart) {
  const i = html.indexOf(blockStart); assert.ok(i > 0, "色の定義が見つからない: " + blockStart);
  const block = html.slice(i, html.indexOf("\n  }", i));
  const out = {}; const re = /(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g; let m;
  while ((m = re.exec(block))) out[m[1]] = m[2];
  return out;
}

(async () => {
  const { api } = loadApp();
  const VZ = api.VZ, sh = api.vzShell;

  console.log("■ 1. ページの骨組み(上の帯・下のメニュー・色の覚え方)。置き場と id は変えていない");
  await t("上の帯(id=appHero)の中に、サイト名・詳しさの切り替え・初心者モード・色の切り替え・言語がある(id は従来のまま)", () => {
    const hero = html.slice(html.indexOf('<header class="top vz-hero vz-hero-blue" id="appHero">'), html.indexOf("</header>", html.indexOf('id="appHero"')));
    assert.ok(hero.length > 300, "上の帯が見つからない");
    for (const id of ["levelSwitch", "beginnerModeToggle", "themeToggle", "langSwitchSel", "streakStrip"]) assert.ok(hero.includes(`id="${id}"`), "帯の中に無い: " + id);
    assert.ok(/<h1[^>]*>[\s\S]*サッカー分析AI[\s\S]*<\/h1>/.test(hero), "サイト名(h1)が無い");
  });
  await t("下のメニューは5つ(予想・質問・試合・選手・もっと)で、行き先は今ある場所(新しい画面は作っていない)", () => {
    const nav = html.slice(html.indexOf('<nav class="vz-nav" id="appNav"'), html.indexOf("</nav>", html.indexOf('id="appNav"')));
    assert.deepStrictEqual([...nav.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]), ["pred", "ask", "fixtures", "player", "more"]);
    assert.deepStrictEqual([...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]), ["予想", "質問", "試合", "選手", "もっと"]);
    assert.ok(nav.includes('aria-label="メニュー"'));
    for (const id of ["todayPredictionsCard", "heroAiChat", "realFixturesCard", "playerSection", "moreMenuTitle"]) { assert.ok(html.includes(`"${id}"`), "行き先が無い: " + id); assert.ok(new RegExp(`id="${id}"`).test(html), "行き先の id が無い: " + id); }
    // メニューは、狭い画面では画面の下に固定・広い画面では上に置く(本文に重ならないよう、下に余白を取る)
    assert.ok(/\.vz-nav \{[^}]*position: fixed;[^}]*bottom: 0;/.test(html), "下に固定する指定が無い");
    assert.ok(/env\(safe-area-inset-bottom/.test(html), "端末の下の余白(ホームバー)を避けていない");
  });
  await t("ホームの並び順は変えていない(予想 → 質問 → 的中率 → ダイジェスト → 本日の試合 → 今日のサッカー → もっと見る)", () => {
    const order = ['id="todayPredictionsCard"', 'id="heroAiChat"', 'id="aiAccuracyCard"', 'id="digestCard"', 'id="realFixturesCard"', 'id="dashboardCard"', 'id="moreMenuTitle"', 'id="modeSwitch"'];
    let pos = html.indexOf('<div class="app">'); assert.ok(pos > 0);
    for (const k of order) { const i = html.indexOf(k, pos); assert.ok(i > pos, "順番が違う/無い: " + k); pos = i; }
  });
  await t("色(明るい/暗い): 最初の描画の前に決める。選んだ色があればそれ、無ければ端末の設定。切り替えたら端末に覚える", () => {
    const head = html.slice(0, html.indexOf("<body>"));
    assert.ok(/localStorage\.getItem\("appTheme"\)/.test(head) && /prefers-color-scheme: dark/.test(head) && /setAttribute\("data-theme", t\)/.test(head), "head の中で色を決めていない");
    const st = makeStorage(); const { api: a, dom } = loadApp({ storage: st });
    dom.document.documentElement.setAttribute("data-theme", "light");
    a.vzShell.toggleTheme();
    assert.strictEqual(dom.document.documentElement.getAttribute("data-theme"), "dark"); assert.strictEqual(st.getItem("appTheme"), "dark");
    a.vzShell.toggleTheme();
    assert.strictEqual(dom.document.documentElement.getAttribute("data-theme"), "light"); assert.strictEqual(st.getItem("appTheme"), "light");
    // 覚えられない端末(保存が失敗する)でも、その場の切り替えはできる
    const bad = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() {} };
    const r2 = loadApp({ storage: bad }); r2.dom.document.documentElement.setAttribute("data-theme", "light");
    r2.api.vzShell.toggleTheme(); assert.strictEqual(r2.dom.document.documentElement.getAttribute("data-theme"), "dark");
  });

  console.log("■ 2. 色: 白い文字を乗せる色・本文の色は、明るい画面でも暗い画面でも読める濃さ(4.5:1 以上)");
  await t("明るい画面・暗い画面の両方で、足した色がすべて定義されている(片方だけ定義して、もう片方で色が抜けることが無い)", () => {
    const L = html.slice(html.indexOf("  :root {"), html.indexOf("\n  }", html.indexOf("  :root {")));
    const D = html.slice(html.indexOf('  :root[data-theme="dark"] {'), html.indexOf("\n  }", html.indexOf('  :root[data-theme="dark"] {')));
    for (const k of ["--hair", "--shadow-card", "--shadow-lift", "--good-strong", "--good-ink", "--good-wash", "--critical-fill", "--critical-ink", "--critical-wash", "--warning-ink", "--warning-wash", "--accent-strong", "--accent-text", "--accent-wash", "--neutral-mark", "--neutral-wash", "--ref-mark", "--draw", "--star", "--card-yellow", "--ink-chip", "--ink-chip-text", "--nav-bg"]) {
      assert.ok(L.includes(k + ":"), "明るい画面に無い: " + k); assert.ok(D.includes(k + ":"), "暗い画面に無い: " + k);
    }
  });
  await t("コントラスト: 白い文字 × 緑・赤の札、本文・補足の文字 × 地の色、濃い帯の白い文字(明暗とも 4.5:1 以上)", () => {
    const L = tokens("  :root {"), D = tokens('  :root[data-theme="dark"] {');
    const need = (name, a, b, min) => { const c = contrast(a, b); assert.ok(c >= min, `${name}: ${a} × ${b} = ${c.toFixed(2)}:1(${min} 未満)`); };
    for (const [label, T] of [["明", L], ["暗", D]]) {
      need(label + " 白×緑の札", "#ffffff", T["--good-strong"], 4.5);
      need(label + " 白×赤の札", "#ffffff", T["--critical-fill"], 4.5);
      need(label + " 濃い札の文字", T["--ink-chip-text"], T["--ink-chip"], 7);
      for (const s of ["--surface-0", "--surface-1", "--surface-2"]) { need(label + " 本文×" + s, T["--text-primary"], T[s], 7); need(label + " 補足×" + s, T["--text-secondary"], T[s], 4.5); }
      need(label + " 薄い補足×カード", T["--text-muted"], T["--surface-1"], 4.5);
      for (const k of ["--accent-text", "--good-ink", "--critical-ink", "--warning-ink"]) need(label + " " + k + "×カード", T[k], T["--surface-1"], 4.5);
    }
    need("濃い帯の白い文字(上)", "#ffffff", L["--hero-1"], 7); need("濃い帯の白い文字(下)", "#ffffff", L["--hero-0"], 7);
  });

  console.log("■ 3. 図の部品(VZ): 渡された数字をそのまま描く・文字は必ずエスケープする・値が無いときは描かない");
  await t("札(pill): 種類ごとの形、文字のエスケープ", () => {
    assert.ok(/class="vz-pill vz-good"/.test(VZ.pill("hit", "的中")) && VZ.pill("hit", "的中").includes("的中"));
    assert.ok(/class="vz-pill vz-weak"/.test(VZ.pill("miss", "外れ")) && /class="vz-pill vz-warn"/.test(VZ.pill("warn", "注意")));
    assert.ok(!VZ.pill("good", "<img src=x onerror=1>").includes("<img"), "エスケープされていない");
    assert.strictEqual(VZ.band(70), "good"); assert.strictEqual(VZ.band(69.9), "mid"); assert.strictEqual(VZ.band(30), "weak"); assert.strictEqual(VZ.band(30.1), "mid"); assert.strictEqual(VZ.band(null), "mid");
  });
  await t("勝つ可能性(prob3): 3つの数字は棒の外に文字で出す(色の上に白い数字を乗せない)。いちばん大きい数字を強調。欠けていれば何も描かない", () => {
    const h = VZ.prob3(61, 22, 17, { home: "A勝利", draw: "引分", away: "B勝利" });
    assert.ok(strip(h).includes("61%") && strip(h).includes("22%") && strip(h).includes("17%"));
    assert.ok(/<div class="vz-l vz-lead"><b>61/.test(h) && !/<div class="vz-c vz-lead">/.test(h) && !/<div class="vz-r vz-lead">/.test(h), "強調の位置");
    const bar = h.slice(h.indexOf('<div class="vz-seg"'));
    assert.ok(/flex:61/.test(bar) && /flex:22/.test(bar) && /flex:17/.test(bar), "棒の比が渡した数字と違う");
    assert.strictEqual(strip(bar), "", "棒の中に文字がある");
    assert.strictEqual(VZ.prob3(61, null, 17, {}), ""); assert.strictEqual(VZ.prob3("x", 1, 2, {}), "");
  });
  await t("評価の札(rate): 区切りはこれまでと同じ(8以上 / 7以上 / 6以上 / 6未満)。無いときは「-」か、渡した言葉", () => {
    assert.ok(/vz-good/.test(VZ.rate(8)) && /vz-fine/.test(VZ.rate(7.99)) && /vz-mid/.test(VZ.rate(6)) && /vz-weak/.test(VZ.rate(5.99)));
    assert.strictEqual(strip(VZ.rate(7)), "7.0"); assert.strictEqual(strip(VZ.rate("7.60")), "7.60"); assert.strictEqual(strip(VZ.rate(7.456)), "7.46");
    assert.strictEqual(strip(VZ.rate(null)), "-"); assert.strictEqual(strip(VZ.rate("")), "-"); assert.strictEqual(strip(VZ.rate(undefined, "未取得")), "未取得");
  });
  await t("クラブの印(crest): アルファベット表記の頭文字(FC・AC などの前置きは飛ばす)。写真の丸(avatar)は https の画像だけ通す", () => {
    const letter = (n) => strip(VZ.crest(n, "h"));
    assert.strictEqual(letter("Arsenal"), "A"); assert.strictEqual(letter("FC Barcelona"), "B"); assert.strictEqual(letter("1. FC Köln"), "K"); assert.strictEqual(letter("AC Milan"), "M");
    assert.strictEqual(letter(""), "?"); assert.ok(!VZ.crest("<b>x", "a").includes("<b>x"));
    assert.ok(/class="vz-crest vz-a/.test(VZ.crest("X", "a")) && !/vz-a/.test(VZ.crest("X", "h")));
    assert.ok(VZ.avatar("https://media.example.com/p/1.png").includes("<img"));
    for (const bad of ["javascript:alert(1)", "http://x/y.png", "https://x/y.png\" onerror=\"1", "", null]) assert.ok(!VZ.avatar(bad).includes("<img"), "通してはいけない: " + bad);
    assert.ok(/^<span class="vz-avatar vz-sm">/.test(VZ.avatar("", "vz-sm")), "ボタンの中にも置ける形(span)でない");
  });
  await t("勝ち・分け・負けの丸(form): 4言語ぶんの1文字を並べて置き、画面の言語のものだけ見せる(辞書の「分」= 時間の分 と取り違えない)", () => {
    const h = VZ.form([{ r: "W", score: "3-1" }, { r: "D", score: "0-0" }, { r: "L", score: "0-2" }, { r: "?", score: "?" }]);
    assert.strictEqual(count(h, /class="vz-w"/g), 1); assert.strictEqual(count(h, /class="vz-l"/g), 1); assert.strictEqual(count(h, /class="vz-d"/g), 2);
    for (const part of ['<span lang="ja">勝</span><span lang="en">W</span><span lang="zh">胜</span><span lang="es">G</span>', '<span lang="ja">分</span><span lang="en">D</span><span lang="zh">平</span><span lang="es">E</span>', '<span lang="ja">負</span><span lang="en">L</span><span lang="zh">负</span><span lang="es">P</span>']) assert.ok(h.includes(part), "無い: " + part);
    assert.ok(count(h, /class="vz-l10n" data-no-tr="1"/g) === 3, "翻訳の対象から外す印が無い");
    // CSS: 画面の言語のものだけ見せる
    assert.ok(/\.vz-l10n > span\[lang\] \{ display: none !important;/.test(html));
    for (const lg of ["ja", "en", "zh", "es"]) assert.ok(html.includes(`html:lang(${lg}) .vz-l10n > span[lang="${lg}"]`), "言語の切り替えが無い: " + lg);
    // 翻訳エンジンは data-no-tr の中を訳さない
    assert.ok(html.includes('if (pn && pn.nodeType === 1 && pn.closest && pn.closest("[data-no-tr]")) return;'));
  });
  await t("左右でくらべる棒(cmpRow): 太字は大きい方(少ないほど良い項目は小さい方・指定があればそれ)。片方でも欠けていれば描かない", () => {
    const lead = (h) => [/<b class="vz-lead">[^<]*<\/b><div class="vz-cmp-bar vz-l"/.test(h), /<\/div><b class="vz-lead">[^<]*<\/b><\/div><\/div>$/.test(h)];
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "勝点", h: 52, a: 42 })), [true, false]);
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "失点", h: 1.3, a: 1.5, lowerBetter: true })), [true, false]);
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "失点", h: 1.5, a: 1.3, lowerBetter: true })), [false, true]);
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "x", h: 5, a: 5 })), [false, false]);
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "年齢", h: 24, a: 32, lead: "none" })), [false, false]);
    assert.deepStrictEqual(lead(VZ.cmpRow({ label: "ゴール", h: 9, a: 11, lead: "h" })), [true, false]);
    assert.strictEqual(VZ.cmpRow({ label: "x", h: null, a: 3 }), ""); assert.strictEqual(VZ.cmpRow({ label: "x", h: 3, a: "abc" }), "");
    const w = VZ.cmpRow({ label: "勝点", h: 52, a: 26 }); assert.ok(/width:100%/.test(w) && /width:50%/.test(w), "棒の長さが値の比になっていない");
    assert.ok(VZ.cmpRow({ label: "<i>", h: 1, a: 2, hs: "<u>" }).indexOf("<i>") === -1 && VZ.cmpRow({ label: "x", h: 1, a: 2, hs: "<u>" }).indexOf("<u>") === -1);
  });
  await t("目盛り(pips)・六角形(radar)・折れ線(spark)・順位の単位: 範囲の外の値で崩れない", () => {
    assert.strictEqual(count(VZ.pips(3, 5), /class="vz-on"/g), 3); assert.strictEqual(count(VZ.pips(3, 5), /<i/g), 5);
    assert.strictEqual(count(VZ.pips(9, 5), /class="vz-on"/g), 5); assert.strictEqual(count(VZ.pips(-2, 5), /class="vz-on"/g), 0);
    assert.strictEqual(VZ.radar([{ name: "a", pct: 50 }, { name: "b", pct: 60 }]), "", "項目が2つ以下の六角形は描かない");
    const r = VZ.radar([{ name: "a", pct: 50 }, { name: "b", pct: 160 }, { name: "c", pct: -5 }, { name: "d", pct: null }]);
    assert.strictEqual(count(r, /<circle /g), 3, "測れた項目の数だけ点を打つ"); assert.ok(!/NaN|undefined/.test(r));
    assert.strictEqual(VZ.spark([5]), ""); assert.ok(/<svg class="vz-spark"/.test(VZ.spark([1, 2, 3])) && !/NaN/.test(VZ.spark([3, 3, 3])));
    assert.ok(VZ.fact(1, "順位", 3, "位", true).includes('<small class="vz-ja-only" data-no-tr="1">位</small>'), "「位」は日本語の画面だけに出す");
    assert.ok(/html:lang\(en\) \.vz-ja-only, html:lang\(zh\) \.vz-ja-only, html:lang\(es\) \.vz-ja-only \{ display: none; \}/.test(html));
  });

  console.log("■ 4. 飾りの絵文字は画面に出さない(文字列は変えない)。意味のある印は残す");
  await t("絵文字の見つけ方: 文頭・文の途中の飾りは隠す / 数え方の一部(⚽×2)・国旗・色つきの四角・文の途中の❓は触らない / ✅❌⚠ は印に置き換える", () => {
    const f = (s) => sh.findEmoji(s);
    assert.deepStrictEqual(f("🏅 自信ランク"), [{ from: 0, to: 3, mark: null, bare: false }]);
    assert.deepStrictEqual(f("How is 🛡️ Arsenal doing?").map((x) => [x.from, x.mark]), [[7, null]]);
    assert.deepStrictEqual(f("✅ 的中").map((x) => x.mark), ["hit"]); assert.deepStrictEqual(f("❌ 外れ").map((x) => x.mark), ["miss"]); assert.deepStrictEqual(f("⚠️ 注意").map((x) => x.mark), ["warn"]);
    for (const keep of ["⚽×2 👟×4", "🟨×1", "🇯🇵 日本", "これは何❓ ですか", "普通の文", "A vs B", "70〜90分+"]) assert.deepStrictEqual(f(keep), [], "触ってはいけない: " + keep);
    assert.deepStrictEqual(f("❓ ハーランドはどんな選手ですか？").map((x) => [x.from, x.to]), [[0, 2]], "文頭の❓(質問の一覧の飾り)は隠す");
    assert.strictEqual(f("⭐")[0].bare, true, "絵文字だけの文字は bare(うしろに本文が続くときだけ隠す)");
    assert.strictEqual(f("🤖 AIの予想: 🔥 A").length, 2);
  });
  await t("絵文字の見つけ方は、どんな文字列でも必ず終わる(以前、文頭の❓で止まらなくなる不具合を作って直した)", () => {
    const pool = ["❓", "❔", "✅", "❌", "⚠️", "🏅", "⚽", "🛡️", "🇯🇵", "🟨", " ", "  ", "a", "あ", "×", "2", "‍", "️", "👨‍👩‍👧", "🔴", "⭕", "(", "？"];
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const t0 = Date.now();
    for (let i = 0; i < 4000; i++) {
      let s = ""; const n = 1 + Math.floor(rnd() * 9); for (let k = 0; k < n; k++) s += pool[Math.floor(rnd() * pool.length)];
      const hits = sh.findEmoji(s);
      for (const hit of hits) assert.ok(hit.from >= 0 && hit.to > hit.from && hit.to <= s.length, "範囲がおかしい: " + JSON.stringify([s, hit]));
      for (let k = 1; k < hits.length; k++) assert.ok(hits[k].to <= hits[k - 1].from, "範囲が重なっている: " + JSON.stringify([s, hits]));
    }
    assert.ok(Date.now() - t0 < 5000, "遅すぎる");
  });
  await t("隠し方: 文字は消さず、見えない形(.emo)に包むだけ。翻訳が全文を引き直す前に元へ戻し、終わったらもう一度隠す", () => {
    assert.ok(/\.emo \{[^}]*position: absolute[^}]*\}/.test(html) || /\.emo \{[^}]*clip/.test(html), ".emo を見えなくする指定が無い");
    assert.strictEqual(count(html, /window\.__vzRestoreEmoji\(document\.body\)/g), 2, "翻訳の全文引き直し(2か所)の前に、元へ戻していない");
    const src = mainScript.slice(mainScript.indexOf("function restoreEmojiUnder("), mainScript.indexOf("function startEmojiPass("));
    assert.ok(/Promise\.resolve\(\)\.then\(\(\) => hideEmojiUnder\(r\)\)/.test(src), "元へ戻したあと、隠し直していない(文の途中の絵文字が出たままになる)");
    // 会話の吹き出し: AI の答えの文の絵文字は残す(部品の飾りだけ隠す)
    assert.ok(mainScript.includes('if (p.closest(".chat-bubble") && !p.closest(".chat-bubble summary, .chat-bubble .value-note, .chat-bubble button")) return;'));
    // 最初の1回は、翻訳が「色の切り替え」の文字を訳してから
    assert.ok(/try \{ syncThemeButton\(\); \} catch \(e\) \{\}\s*\n[\s\S]{0,400}Promise\.resolve\(\)\.then\(\(\) => \{ try \{ startEmojiPass\(\); \}/.test(mainScript), "最初の絵文字隠しが、翻訳より先に動く");
  });

  console.log("■ 5. 予想カードと「根拠をくわしく見る」: 数字は同じ・形だけ図に");
  const P = {
    fixtureId: 501, league: "Premier League", kickoff: "2026-11-15T12:00:00Z", status: "NS", resolved: false,
    home: { name: "Arsenal" }, away: { name: "Chelsea <b>" }, predictedWinner: "home", predictedScoreline: "2-1",
    probs: { homeWinPct: 61, drawPct: 22, awayWinPct: 17 }, topFactorJa: "直近フォーム",
    confidence: { displayPct: 63, rawPct: 61, calibrated: true, basisN: 40, gapPt: 20, outOfRange: false },
  };
  await t("勝率の帯: 3つの数字(61・22・17)と、チーム名つきのラベル。チーム名はエスケープ", () => {
    const h = api.predBarHtml(P);
    assert.ok(strip(h).includes("61%") && strip(h).includes("Arsenal勝利") && strip(h).includes("引分"));
    assert.ok(!h.includes("Chelsea <b>") && h.includes("Chelsea &lt;b&gt;"));
  });
  await t("AIが重く見たこと: ★の数(1〜5に収め、端数は切り捨て)と同じ数の目盛り+数字。名前はエスケープ", () => {
    const h = api.predFactorsLineHtml({ factors: [{ labelJa: "直近フォーム", stars: 4 }, { labelJa: "xG<i>", stars: 9 }, { labelJa: "怪我人", stars: 0 }, { labelJa: "日程", stars: 2.9 }] });
    const rows = [...h.matchAll(/<div class="vz-fac-row"><span>([^<]*)<\/span><span class="vz-pips" aria-hidden="true">((?:<i(?: class="vz-on")?><\/i>){5})<\/span><b>(\d)<\/b><\/div>/g)].map((m) => [m[1], count(m[2], /vz-on/g), Number(m[3])]);
    assert.deepStrictEqual(rows, [["直近フォーム", 4, 4], ["xG&lt;i&gt;", 5, 5], ["怪我人", 1, 1], ["日程", 2, 2]]);
    assert.ok(strip(h).includes("AIが重く見たこと") && strip(h).includes("影響の大きさ(5段階)") && strip(h).includes("市場オッズは予測には未使用・比較専用"));
    assert.strictEqual(api.predFactorsLineHtml({ factors: [] }), ""); assert.strictEqual(api.predFactorsLineHtml({}), "");
  });
  await t("スコアの可能性: 上位3つは札(スコア・確率・細い棒)、4つ目からは文字。派生の数字は4つとも、渡した値のまま", () => {
    const h = api.predScenarioLineHtml({ home: { name: "A" }, away: { name: "B" }, scenarios: [{ scoreline: "2-1", pct: 11 }, { scoreline: "1-0", pct: 10.5 }, { scoreline: "1-1", pct: 9 }, { scoreline: "0-0", pct: 7 }, { scoreline: "x", pct: 3 }], derived: { bttsPct: 55, over25Pct: 58, homeCleanSheetPct: 30, awayCleanSheetPct: 15 } });
    assert.strictEqual(count(h, /<div class="vz-sc">/g), 3);
    assert.ok(h.includes('<span class="vz-board vz-sm">2<i>-</i>1</span><b>11<small>%</small></b>') && h.includes("<b>10.5<small>%</small></b>"));
    assert.ok(strip(h).includes("0-0 7%") && strip(h).includes("x 3%"), "4つ目・5つ目が消えている");
    assert.strictEqual(count(h, /<div class="vz-mm-i">/g), 4);
    for (const part of ["両チーム得点55%", "3点以上58%", "完封 A30%", "完封 B15%"]) assert.ok(strip(h).replace(/ (\d)/g, "$1").includes(part.replace(/ (\d)/g, "$1")), "無い: " + part);
    assert.ok(!/<details/.test(h), "開いた中で、もう一度たたんでいる");
    // 派生の数字だけ・スコアだけの記録でも崩れない。どちらも無ければ何も足さない
    assert.ok(api.predScenarioLineHtml({ derived: { bttsPct: 1, over25Pct: 2, homeCleanSheetPct: 3, awayCleanSheetPct: 4 } }).includes('<div class="vz-mm">'));
    assert.strictEqual(api.predScenarioLineHtml({}), "");
  });
  await t("色つきの文字で意味を伝えていない: 確信度の行・一覧の確率・決め手(オレンジの文字をやめた)", () => {
    const stripHtml = api.predStripHtml({ ...P, status: "1H" }); // 試合前(NS)は、対決で予想を選ぶまで伏せる。伏せない状態(試合中)で確かめる
    assert.ok(!/color:var\(--series-2\)/.test(stripHtml), "一覧の確率がオレンジの文字のまま");
    assert.ok(/<strong>63%<\/strong>/.test(stripHtml), stripHtml);
    const blk = api.predictionSummaryBlockHtml(P, "🤖 AIの予想");
    assert.ok(!/style="color:var\(--series-2\);"/.test(blk), "予想ブロックにオレンジの文字が残っている");
    assert.strictEqual(strip(api.predReasonLineHtml(P)), "💡 決め手: 直近フォーム", "決め手の文は変えていない");
  });

  console.log("■ 6. 試合一覧と、試合のカード(試合前・試合中・試合後)");
  const fx = (o) => Object.assign({ id: 7, date: "2026-11-22T05:00:00Z", status: "NS", home: { name: "Urawa" }, away: { name: "Sanfrecce <Hiroshima>" }, score: null, venue: "Urawa Stadium", league: "J1 League" }, o);
  await t("試合一覧の1行: 2チームを2行に。点数は右。勝っている側だけ太く。点数が無ければ数字は出さない。文字はエスケープ", () => {
    const up = api.fixtureRowHtml(fx());
    assert.strictEqual(count(up, /class="vz-fx-t/g), 2); assert.ok(!/vz-fx-sc/.test(up) && !/vz-lead/.test(up) && !/vz-has-lead/.test(up));
    assert.ok(up.includes("Sanfrecce &lt;Hiroshima&gt;") && !up.includes("<Hiroshima>"));
    assert.ok(up.includes("AI分析を見る ▶") && /is-upcoming/.test(up));
    const fin = api.fixtureRowHtml(fx({ status: "FT", score: { home: 2, away: 1 } }));
    assert.ok(/<div class="vz-fx-t vz-lead"><i class="vz-sw vz-h"><\/i><span class="vz-fx-n">Urawa<\/span><b class="vz-fx-sc">2<\/b><\/div>/.test(fin), fin.slice(0, 400));
    assert.ok(/<div class="vz-fx-t"><i class="vz-sw vz-a"><\/i>/.test(fin) && /class="teams vz-has-lead"/.test(fin) && fin.includes("答え合わせを見る ▶") && /is-finished/.test(fin));
    const draw = api.fixtureRowHtml(fx({ status: "1H", score: { home: 0, away: 0 } }));
    assert.ok(!/vz-lead/.test(draw) && /is-live/.test(draw) && /live-dot/.test(draw) && count(draw, /class="vz-fx-sc">0</g) === 2);
    // 予想の1行は、ボタンのうしろ(行の幅いっぱい)
    assert.ok(up.indexOf('class="match-analyze-btn real-fixture-analyze-btn"') < up.indexOf('id="fixturePred-7"'), "予想の行がボタンより前にある");
  });
  const live = { fixture: { id: 9, home: { name: "Man United" }, away: { name: "Man <City>" }, league: "Premier League", venue: "Old Trafford", score: { home: 1, away: 0 } }, elapsed: 30,
    homePlayers: [{ name: "B. Fernandes", position: "M", minutes: 30, rating: 7.2, goals: 1, assists: 0, yellowCards: 1 }, { name: "X", position: "D", rating: null }], awayPlayers: [],
    events: [{ minute: 12, team: "Man United", player: "B. Fernandes", type: "Goal", detail: "Normal Goal", assist: "Mount" }, { minute: 20, team: "Man <City>", player: "Rodri<i>", type: "Card", detail: "Yellow Card" }, { minute: 44, extra: 2, team: "Man <City>", player: "Y", type: "Card", detail: "Red Card" }, { minute: 46, team: "Man United", player: "Z", type: "subst" }, { minute: 50, team: "Man United", player: "V", type: "Var" }] };
  await t("試合中のカード: 濃い帯に LIVE・大会・会場・いまのスコア・経過時間。結論めいた文は出さない。文字はエスケープ", () => {
    const h = api.buildLiveAnalysisHtml(live, "standard");
    assert.ok(h.includes('<header class="vz-hero vz-hero-match vz-inset">') && /<div class="vz-vs-mid"><b>1 - 0<\/b><span>30分経過<\/span><\/div>/.test(h));
    assert.ok(h.includes("LIVE") && h.includes("まだ結果は確定していません") && !h.includes("何が勝敗を分けたか"));
    assert.ok(h.includes("Man &lt;City&gt;") && !h.includes("Man <City>") && !h.includes("Rodri<i>"));
    assert.ok(/<span class="vz-hpill">Premier League<\/span><span>Old Trafford<\/span>/.test(h));
    // 選手の行: 得点などは言葉で。評価は札。評価の無い選手は「-」
    assert.ok(h.includes("<span>1得点</span>") && h.includes("🟨×1") && !h.includes("0アシスト") && /vz-rate vz-fine">7\.2</.test(h) && /vz-rate vz-na">-</.test(h));
  });
  await t("試合の流れ: 出来事の種類(得点・警告・退場・交代・その他)を、絵の記号ではなく言葉の札で示す(4言語ぶん)。図の点は出来事の数だけ", () => {
    assert.deepStrictEqual(live.events.map((e) => api.matchEventKind(e).key), ["goal", "yellow", "red", "sub", "etc"]);
    for (const k of ["goal", "red", "yellow", "sub", "etc"]) for (const lg of ["ja", "en", "zh", "es"]) assert.ok(api.MATCH_EVENT_KINDS[k][lg], `種類の名前が無い: ${k}/${lg}`);
    const list = api.eventsTimelineHtml(live.events, "Man United");
    assert.strictEqual(count(list, /<div class="vz-ev">/g), 5);
    assert.ok(list.includes('<span class="vz-ev-k vz-goal"><span class="vz-l10n" data-no-tr="1"><span lang="ja">得点</span><span lang="en">Goal</span>'));
    assert.ok(list.includes("B. Fernandes(アシスト: Mount)") && list.includes("44+2'") && list.includes("[H]") && list.includes("[A]") && list.includes("Rodri&lt;i&gt;"));
    const viz = api.eventsTimelineVisualHtml(live.events, "Man United");
    assert.strictEqual(count(viz, /class="match-timeline-marker vz-tl-m /g), 5);
    assert.strictEqual(count(viz, /vz-tl-m vz-goal vz-h"/g), 1); assert.strictEqual(count(viz, /vz-tl-m vz-yellow vz-a"/g), 1); assert.strictEqual(count(viz, /vz-tl-m vz-red vz-a"/g), 1);
    assert.ok(/aria-hidden="true"/.test(viz), "図は飾りの重複(同じ内容は文字の一覧にある)");
    assert.ok(!viz.includes("Man <City>"), "title 属性のエスケープ");
    assert.strictEqual(api.eventsTimelineVisualHtml([], "x"), ""); assert.ok(api.eventsTimelineHtml([], "x").includes("この試合のイベント情報は取得できませんでした。"));
  });
  await t("試合後のカード: 濃い帯に最終スコアと「終了」。スコアが無い試合は「(スコア不明)」。選手評価の平均は左右の棒(両方あるときだけ)", () => {
    const fin = { ...live, fixture: { ...live.fixture, score: { home: 2, away: 2 } }, awayPlayers: [{ name: "Q", position: "A", rating: 6.5 }], motmHome: { name: "B. Fernandes", rating: 7.2 }, motmAway: { name: "Q", rating: 6.5 } };
    const h = api.buildFinishedAnalysisHtml(fin, "standard");
    assert.ok(/<div class="vz-vs-mid"><b>2 - 2<\/b><span>終了<\/span><\/div>/.test(h) && h.includes("試合後の振り返り: Man United 2 - 2 Man &lt;City&gt;"));
    assert.ok(h.includes("何が勝敗を分けたか") && h.includes("選手評価(MOTM候補: B. Fernandes)"));
    assert.ok(h.includes('<div class="vz-cmp">') && h.includes("選手評価の平均値"), "左右の棒が無い");
    const noScore = api.buildFinishedAnalysisHtml({ ...live, fixture: { ...live.fixture, score: null } }, "standard");
    assert.ok(/<div class="vz-vs-mid"><b>vs<\/b><span>\(スコア不明\)<\/span><\/div>/.test(noScore));
    assert.ok(!api.buildFinishedAnalysisHtml({ ...live, events: [], awayPlayers: [] }, "standard").includes('class="vz-divide vz-flow"'), "材料が無いのに図の枠だけ出している");
    assert.ok(!/undefined|NaN/.test(h + noScore));
  });
  await t("試合前: 直近の勝ち負けは、日付が全部そろっているときだけ新しい順に並べて「左が新しい」と書く。勝敗の数は、スコアが分かる試合だけ数える", () => {
    const f1 = api.knowledgeRecentFormHtml({ recentResults: [{ date: "2026-10-25", opponent: "Z", homeAway: "H", goalsFor: 0, goalsAgainst: 1 }, { date: "2026-11-01", opponent: "X", homeAway: "H", goalsFor: 2, goalsAgainst: 0 }, { date: "2026-10-28", opponent: "Y", homeAway: "A", goalsFor: 1, goalsAgainst: 1 }] });
    assert.ok(f1.includes("(左が新しい)") && f1.includes("<span>1勝1分1敗</span>"));
    assert.deepStrictEqual([...f1.matchAll(/<b class="(vz-[wdl])">/g)].map((m) => m[1]), ["vz-w", "vz-d", "vz-l"], "新しい順になっていない");
    const f2 = api.knowledgeRecentFormHtml({ recentResults: [{ opponent: "Z", homeAway: "H", goalsFor: 0, goalsAgainst: 1 }, { date: "2026-11-01", opponent: "X", homeAway: "H", goalsFor: null, goalsAgainst: null }] });
    assert.ok(!f2.includes("(左が新しい)"), "日付が欠けているのに順番を言い切っている");
    assert.ok(f2.includes("<span>0勝0分1敗</span>") && />\?<\/b>/.test(f2), "スコアの分からない試合を数えている/印が無い");
    assert.strictEqual(api.knowledgeRecentFormHtml({ recentResults: [] }), ""); assert.strictEqual(api.knowledgeRecentFormHtml(null), "");
  });
  await t("試合前「くらべる」: 両方に値がある項目だけを出す(片方だけの項目は出さない)。値が1つも無ければ、見出しも出さない", () => {
    const side = (o) => ({ dossier: { standings: { rank: 1, points: 52, played: 25 }, form: { avgGoalsFor: 1.9, avgGoalsAgainst: 1.3 }, injuries: { count: 2 } }, squad: { reliable: true, avgRating: 7.16 }, ...o });
    const full = api.knowledgeCompareHtml("A", "B<", side(), side({ dossier: { standings: { rank: 3, points: 42, played: 25 }, form: { avgGoalsFor: 1.0, avgGoalsAgainst: 1.5 }, injuries: { count: 1 } }, squad: { reliable: true, avgRating: 7.02 } }));
    for (const part of ["くらべる", "順位", "勝点", "25試合", "直近の1試合平均得点", "直近の1試合平均失点", "少ないほど良い", "主力の平均評価点", "怪我・出場停止", "7.16", "7.02"]) assert.ok(full.includes(part), "無い: " + part);
    assert.ok(full.includes("B&lt;") && !full.includes(">B<<"));
    const part = api.knowledgeCompareHtml("A", "B", side(), { dossier: { standings: { rank: 3 } }, squad: { reliable: false, avgRating: 7 } });
    assert.ok(part.includes("順位") && !part.includes("勝点") && !part.includes("主力の平均評価点"), "片方しか無い項目を出している");
    assert.strictEqual(api.knowledgeCompareHtml("A", "B", { dossier: {} }, null), "");
  });

  console.log("■ 7. 選手まわり(検索結果・2人の比較)と、「賢くなったか」「AIの裏側」");
  await t("2人の比較: 表をやめて左右の棒に。太字はサーバーの判定(bestIndex)のまま。値の欠けた項目は棒を描かず「未取得」と書く", () => {
    const data = { winCounts: [5, 2], metrics: [{ labelJa: "平均評価", values: [8.01, 7.83], bestIndex: 0, digits: 2 }, { labelJa: "ゴール", values: [9, 11], bestIndex: 1 }, { labelJa: "年齢", values: [24, 32], bestIndex: null }, { labelJa: "身長(cm)", values: [173, null], missingCount: 1 }] };
    const h = api.psCompareDuoHtml(data, [{ id: 1, name: "N. Dubois", teamEn: "Newcastle", positionJa: "FW(フォワード)" }, { id: 2, name: "B. <Kovac>", teamEn: "Bayer Leverkusen", positionJa: "FW(フォワード)" }]);
    assert.strictEqual(count(h, /<div class="vz-cmp">/g), 3); assert.strictEqual(count(h, /class="vz-fact vz-fact-txt"/g), 1);
    assert.ok(/<b class="vz-lead">8\.01<\/b>/.test(h) && /<b class="vz-lead">11<\/b>/.test(h) && !/<b class="vz-lead">(9|24|32|7\.83)<\/b>/.test(h), "太字がサーバーの判定と違う");
    assert.ok(h.includes('<span class="muted">未取得</span>') && h.includes("1人ぶん未取得") && h.includes("項目で上回った回数: 5") && h.includes("項目で上回った回数: 2"));
    assert.ok(h.includes("B. &lt;Kovac&gt;") && !h.includes("<Kovac>"));
    assert.ok(mainScript.includes("${players.length === 2 ? psCompareDuoHtml(data, players) : `<div class=\"ps-scroll\""), "3人以上は従来の表のまま、になっていない");
  });
  await t("検索結果のカード: 写真が読めないときに空白を残さない(人の形を下に敷く)。評価は札、無ければ「未取得」", () => {
    const c = api.psCard({ id: 5, name: "A", teamEn: "Arsenal", positionJa: "FW", rating: 7.834, age: 24, nationality: "England", injured: true, formDelta: 0.2 });
    assert.ok(c.includes('<span class="vz-avatar vz-sm">') && !/onerror="this\.style\.visibility='hidden'"/.test(c));
    assert.ok(/<div class="sd-rate"><span>評価<\/span><span class="vz-rate vz-fine">7\.83<\/span><\/div>/.test(c));
    assert.ok(api.psCard({ id: 6, name: "B", rating: null }).includes('<span class="vz-rate vz-na vz-txt"><span>未取得</span></span>'));
    assert.ok(c.includes("負傷者リスト") && c.includes("詳しく見る") && c.includes("比較に追加"));
  });
  const smarterWith = async (diff) => {
    const payload = { available: true, dateKey: "2026-11-15", answers: { diff, items: [] }, learning: {}, growth: {} };
    const fetchStub = async (url) => { if (String(url).includes("/qa/latest")) return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }; throw new Error("no network"); };
    const { api: a, dom } = loadApp({ fetch: fetchStub });
    await a.renderSmarterCard();
    return dom.get("smarterBody").innerHTML;
  };
  await t("賢くなったか: 見出しの文と判定は変えず、判定の札と3つの数字(サーバーの件数)を添える。色つきの文字はやめた", async () => {
    const q = (id, extra) => Object.assign({ id, questionJa: id + "は？", canAnswerToday: true, hadYesterday: true, factCountToday: 3 }, extra);
    const items = [q("a", { changedFacts: [{ k: "勝点", from: 1, to: 2 }] }), q("b"), q("c", { canAnswerToday: false, reasonJa: "まだ" }), q("d", { newFacts: [{ k: "x", v: "y" }] }), q("e", { lostFacts: [{ k: "x", v: "y" }] }), q("f")];
    const h = await smarterWith({ grew: true, hasYesterday: true, newFactTotal: 1, changedFactTotal: 146, lostFactTotal: 1, newlyAnswerableCount: 0, items });
    assert.ok(/<div class="smarter-headline">はい。昨日は言えなかったことを 1件 言えるようになりました。<\/div>/.test(h), "見出しの文が変わっている");
    assert.ok(/class="vz-pill vz-good"[^>]*>[\s\S]*?増えました<\/span>/.test(h) && !/class="smarter-headline" style=/.test(h));
    const kpi = [...h.matchAll(/<div class="vz-kf"><span>([^<]+)<\/span><b>(\d+)<small>件<\/small><\/b>/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepStrictEqual(kpi, [["新しく言えること", 1], ["新しくなった数字", 146], ["言えなくなったこと", 1]]);
    assert.ok(/<div class="smarter-sub" data-kind="warn">いっぽうで、昨日は言えたのに今日は言えなくなったことが 1件 あります。<\/div>/.test(h), "減ったことを併記していない");
    // 質問は、変化があったものを先に見せ、残りはたたむ(消さない)
    assert.ok(/<div class="vz-smart-group"><span>変化があった質問<\/span><b>3<small>問<\/small><\/b><\/div>/.test(h));
    assert.ok(/<details class="vz-fold-list"><summary><span>昨日と同じだった質問<\/span><b>2<small>問<\/small><\/b><\/summary>/.test(h) && /<summary><span>まだ答えられない質問<\/span><b>1<small>問<\/small><\/b><\/summary>/.test(h));
    assert.strictEqual(count(h, /<div class="smarter-q">/g), 6, "質問が消えている");
    const order = [...h.matchAll(/<div class="smarter-q-head">[^ ]* ?([a-f])は？/g)].map((m) => m[1]);
    assert.deepStrictEqual(order, ["a", "d", "e", "b", "f", "c"], "組の中の並び順が元の順でない");
    const none = await smarterWith({ grew: false, hasYesterday: true, newFactTotal: 0, changedFactTotal: 0, lostFactTotal: 0, items: [q("b")] });
    assert.ok(none.includes("今日は、答えの中身が変わった質問はありませんでした。") && /増えていません<\/span>/.test(none));
    const unknown = await smarterWith({ grew: null, items: [] });
    assert.ok(/判定できません<\/span>/.test(unknown) && !/class="vz-kpi/.test(unknown), "昨日の記録が無い日に 0件 と書いている");
  });
  await t("AIの裏側「昨日から今日で変わったこと」: 4列の表(スマホで文字が縦に割れていた)をやめ、1試合1行+当たり外れの札。数字は同じ", async () => {
    const payload = { ok: true, available: true, verdictJa: "v", predictions: { available: true, resolvedCount: 2, hitCount: 1, accuracyBefore: 40, accuracyAfter: 41, accuracyDeltaPt: 1, items: [{ home: "A", away: "B<", league: "L", score: "2-1", actualWinnerJa: "A勝利", predictedWinnerJa: "A勝利", correct: true }, { home: "C", away: "D", league: "L", score: null, actualWinnerJa: "引き分け", predictedWinnerJa: "C勝利", correct: false }] },
      playerIndex: {}, playerForm: { available: true, up: [{ id: 1, name: "U", teamEn: "T", from: 6.44, to: 6.58, delta: 0.14, days: 7 }], down: [{ id: 2, name: "W", teamEn: "T", from: 6.84, to: 6.71, delta: -0.13, days: 7 }], methodJa: "m" }, clubChanges: {}, aiViews: {}, learningRun: {}, model: {} };
    const fetchStub = async (url) => { if (String(url).includes("/daily-diff")) return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }; throw new Error("no network"); };
    const { api: a, dom } = loadApp({ fetch: fetchStub });
    await a.renderDailyDiff();
    const h = dom.get("dailyDiffBody").innerHTML;
    assert.ok(!/<table class="ps-table"><thead><tr>\s*<th>試合<\/th>/.test(h), "表のまま");
    assert.strictEqual(count(h, /<div class="vz-missrow">/g), 2);
    assert.ok(h.includes('<span class="vz-pill vz-good">✅ 当たり</span>') && h.includes('<span class="vz-pill vz-weak">❌ 外れ</span>'));
    assert.ok(h.includes("<em>AIの予想</em><strong>A勝利</strong>") && h.includes("<em>実際の結果</em><strong>A勝利</strong> <span class=\"vz-sc-s\">2-1</span>") && h.includes("B&lt;"));
    assert.ok(h.includes("2件中 1件が的中。") && h.includes("正答率 40% → 41%(+1pt)"));
    assert.ok(/class="vz-pill vz-good"[^>]*>[\s\S]*?\+0\.14<\/span>/.test(h) && /class="vz-pill vz-weak"[^>]*>[\s\S]*?-0\.13<\/span>/.test(h) && !/style="color:\$\{dir/.test(h));
  });

  console.log("■ 8. 3言語の訳(新しく足した文言)と、版の番号");
  await t("新しく足した文言は、英語・中国語・スペイン語に訳せる(日本語が残らない)", () => {
    const list = ["予想", "質問", "もっと", "メニュー", "的中", "外れ", "実際", "増えました", "増えていません", "判定できません", "学習した大会の的中率(勝敗)", "公式戦の的中率(勝敗)", "スコアまで的中(何対何)", "連続的中の最長", "(保存範囲内)", "連続",
      "このAIの予測モデルについて", "選手の特徴", "同じポジションの中での位置", "上位(長所)", "中ほど", "下位(弱点)", "色つきのラベルは、同じポジションの選手の中での位置です。", "棒の長さは、同じポジションの選手の中での位置です。",
      "同じポジションの中での位置を出せる項目が、まだありません(実測できている項目が少ないためです)。", "出場のしかたは未取得", "くらべる", "少ないほど良い", "(左が新しい)", "1得点", "5得点", "1アシスト", "3アシスト", "2勝0分3敗",
      "AIが重く見たこと", "影響の大きさ(5段階)", "市場オッズは予測には未使用・比較専用", "新しく言えること", "新しくなった数字", "言えなくなったこと", "変化があった質問", "昨日と同じだった質問", "まだ答えられない質問",
      "今日は、答えの中身が変わった質問はありませんでした。", "新規登録", "上位9%", "下位49%", "(比べた相手: FW(フォワード) 279人)", "(比べた相手: DF(ディフェンダー) 1,426〜1,896人)", "Arsenal 選手評価(MOTM候補: Saka)", "1,290分", "32問"];
    for (const lang of ["en", "zh", "es"]) {
      const tr = loadI18n(lang);
      for (const s of list) {
        const out = tr(s);
        assert.ok(!/[ぁ-んァ-ヶ]/.test(out), `${lang}: かなが残る「${s}」→「${out}」`);
        if (lang !== "zh") assert.ok(!/[一-龥]/.test(out), `${lang}: 漢字が残る「${s}」→「${out}」`);
        if (lang === "zh" && /[ぁ-んァ-ヶ]/.test(s)) assert.notStrictEqual(out, s, `zh: 訳されていない「${s}」`);
      }
    }
    const en = loadI18n("en");
    assert.strictEqual(en("上位9%"), "Top 9%"); assert.strictEqual(en("1得点"), "1 goal"); assert.strictEqual(en("5得点"), "5 goals"); assert.strictEqual(en("32問"), "32");
    assert.strictEqual(en("(比べた相手: FW(フォワード) 279人)"), "(compared with: FW (forward), 279 players)");
    // 既にある訳を壊していない(短い型が、ほかの文に半端に当たらない)
    assert.strictEqual(en("得点"), "Goals"); assert.strictEqual(en("質問"), "Ask"); assert.ok(!/得点/.test(en("直近の1試合平均得点")));
  });
  await t("日本語以外の画面のお知らせは、上の帯に重ねて置くカードの下に置く(帯とカードの間に挟まって読めなくならない)", () => {
    assert.ok(html.includes('var liftEl = document.querySelector(".vz-lift");') && html.includes("afterEl.parentNode.insertBefore(d, afterEl.nextSibling);"));
    assert.ok(/<div class="vz-lift">\s*<div class="card vz-lifted" id="myClubCard">/.test(html));
  });
  await t("sw.js の版を進めた(古い画面が端末に残らないように)。言語パックの版(?v=98)は変えていない(パックの中身を変えていないため)", () => {
    const sw = fs.readFileSync(path.join(SERVER_DIR, "sw.js"), "utf8");
    assert.ok(/CACHE_NAME = "soccer-ai-shell-v1043"/.test(sw), sw.slice(0, 600));
    assert.ok(html.includes('fetch("/i18n." + appLang + ".json?v=98"'));
  });

  console.log("■ 9. 使いやすさ: 開いたもの・頼んだ比較が画面に出る/候補の一覧があとから開いたまま残らない(以前の版からあった不具合を、この版で直した)");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data });
  const cardOf = (i, name) => ({ id: 100 + i, name: name || ("Player " + i), teamEn: "Club " + i, position: "FW", positionJa: "FW(フォワード)", rating: 7.1, age: 25, nationality: "Spain" });
  /** 選手まわりの通信の模擬。名前なしの検索 = 24人、名前つき = mode が "hit" なら同じ名前の1人・それ以外は0人。通信には少し時間がかかる(本番と同じ順番にするため) */
  const playerFetch = (st) => async (url) => {
    url = String(url); st.calls.push(url.replace(/^https?:\/\/[^/]+/, ""));
    if (/\/players\/suggest/.test(url)) { if (st.suggestGate) await st.suggestGate; return jsonRes({ ok: true, items: [{ value: "Lionel Messi", labelJa: "Lionel Messi" }] }); }
    if (/\/knowledge\/player-facets/.test(url)) return jsonRes({ ok: true, available: true, indexedCount: 1260, leagues: [], positions: [], detailedPositions: [] });
    if (/\/knowledge\/players\?/.test(url)) {
      await sleep(st.delay);
      const nm = /[?&]name=([^&]+)/.exec(url); const name = nm ? decodeURIComponent(nm[1].replace(/\+/g, " ")) : "";
      if (!name) {
        const pages = st.pages || 1; const pg = Number((/[?&]page=(\d+)/.exec(url) || [])[1]) || 1;
        return jsonRes({ ok: true, available: true, items: Array.from({ length: 24 }, (_, i) => cardOf((pg - 1) * 24 + i)), total: 24 * pages, page: pg, totalPages: pages, indexedCount: 1260 });
      }
      if (st.hitNames ? st.hitNames.has(name) : st.mode === "hit") return jsonRes({ ok: true, available: true, items: [cardOf(77, name)], total: 1, page: 1, totalPages: 1, indexedCount: 1260 });
      return jsonRes({ ok: true, available: true, items: [], total: 0, page: 1, totalPages: 1, indexedCount: 1260 });
    }
    if (/\/knowledge\/player\?id=/.test(url)) {
      await sleep(st.detailDelay !== undefined ? st.detailDelay : st.delay);
      const id = Number((/[?&]id=(\d+)/.exec(url) || [])[1]);
      return jsonRes({ ok: true, player: { id, name: id === 177 ? (st.detailName || "Lionel Messi") : ("Player " + id), teamEn: "Inter Miami", positionJa: "FW(フォワード)" }, analysis: {}, seasonStats: {}, positionRanks: {}, tookMs: 3 });
    }
    if (/\/players\/highlights/.test(url)) return jsonRes({ ok: true, available: false });
    return jsonRes({ ok: false });
  };
  /** 押された部品の模擬(本物の要素と同じく closest / isConnected を持つ) */
  const actEl = (dataset) => ({ dataset, isConnected: true, closest: () => null });
  const matchMediaStub = (reduce) => (q) => ({ matches: reduce && /prefers-reduced-motion/.test(String(q)), addEventListener() {}, addListener() {} });
  /** 選手の画面を初期化済み(検索結果に24人が並んでいる)の状態にして返す。動いた先(どの要素へ・そのとき検索結果がどうなっていたか)を log に記録する */
  async function openPlayerPage(mode) {
    const st = { calls: [], mode: mode || "nohit", delay: 15 };
    const app = loadApp({ fetch: playerFetch(st), window: { matchMedia: matchMediaStub(false), innerHeight: 800 } });
    const log = [];
    const cardsNow = () => (String(app.dom.get("psResults").innerHTML).match(/data-act="psCompareAdd"/g) || []).length;
    for (const id of ["playerCardWrap", "psDetail", "psSearchCard"]) {
      app.dom.get(id).scrollIntoView = (o) => log.push({ id, behavior: o && o.behavior, cards: cardsNow(), searching: /検索中/.test(String(app.dom.get("psResults").innerHTML)) });
    }
    await app.api.psEnsureInit(); await sleep(40);
    assert.strictEqual(cardsNow(), 24, "前提: 検索結果に24人が並んでいる");
    log.length = 0; st.calls.length = 0;
    return { st, app, log, cardsNow, names: Object.values(app.api.PLAYERS).map((p) => p.nameJa), keys: Object.keys(app.api.PLAYERS) };
  }

  await t("登録選手を開く(索引に居ない場合): 検索を始めて一覧が置き換わってからカードへ動き、出そろったあとにもう一度カードの先頭へ合わせる", async () => {
    const { app, log, names, keys } = await openPlayerPage("nohit");
    await app.api.psOpenByName(names[0]); await sleep(40);
    assert.deepStrictEqual(log.map((x) => x.id), ["playerCardWrap", "playerCardWrap"], JSON.stringify(log));
    // 1回目に動く時点で、前の検索結果(24人)はもう無い = 動く先を測るときの高さが、あとで変わらない
    assert.strictEqual(log[0].cards, 0, "24人の一覧が残ったまま動き始めている"); assert.strictEqual(log[0].searching, true);
    assert.strictEqual(log[1].searching, false, "仕上げは、検索が済んでから");
    assert.strictEqual(app.dom.get("psName").value, "Lionel Messi"); assert.strictEqual(app.api.psState.curatedKey, keys[0]);
    assert.notStrictEqual(app.dom.get("playerCardWrap").style.display, "none");
  });
  await t("登録選手を開く(索引にも居る場合): 仕上げは実データの詳細の先頭へ。登録選手のカードは、そのすぐ下に残る", async () => {
    const { app, log, names } = await openPlayerPage("hit");
    await app.api.psOpenByName(names[0]); await sleep(40);
    assert.deepStrictEqual(log.map((x) => x.id), ["playerCardWrap", "psDetail"], JSON.stringify(log));
    assert.ok(app.dom.get("psDetail").innerHTML.length > 1000, "実データの詳細が描かれている");
    assert.notStrictEqual(app.dom.get("playerCardWrap").style.display, "none");
  });
  await t("登録選手ではない名前(試合のカードや会話から): 索引に居れば詳細へ、居なければ検索欄へ(従来どおり・1回だけ動く)", async () => {
    const a = await openPlayerPage("hit");
    a.st.detailName = "Zzz Qqq";
    await a.app.api.psOpenByName("Zzz Qqq"); await sleep(40);
    assert.deepStrictEqual(a.log.map((x) => x.id), ["psDetail"], JSON.stringify(a.log));
    assert.strictEqual(a.app.dom.get("playerCardWrap").style.display, "none", "登録選手のカードは出さない");
    const b = await openPlayerPage("nohit");
    await b.app.api.psOpenByName("Zzz Qqq"); await sleep(40);
    assert.deepStrictEqual(b.log.map((x) => x.id), ["psSearchCard"], JSON.stringify(b.log));
  });
  await t("続けて2人開いたとき(1人目の検索が返る前に2人目): 動くのも、「いま開いている登録選手」の記録も、2人目だけ", async () => {
    const { app, log, names, keys } = await openPlayerPage("nohit");
    const p1 = app.api.psOpenByName(names[0]); const p2 = app.api.psOpenByName(names[1]);
    await Promise.all([p1, p2]); await sleep(40);
    assert.deepStrictEqual(log.map((x) => x.id), ["playerCardWrap", "playerCardWrap"], JSON.stringify(log));
    // 以前は1人目の続きが実行され、記録が1人目に戻っていた(詳しさを切り替えると、1人目のカードに描き変わった)
    assert.strictEqual(app.api.psState.curatedKey, keys[1]);
    assert.strictEqual(app.api.psState.lastOpenedName, names[1]);
  });
  await t("名前で選手を開いたら、前に開いていた別の選手のページ(実データの詳細)は片づける(上に別の選手が残らない)", async () => {
    const { app, st, names } = await openPlayerPage("nohit");
    await app.api.psOpenDetail(105); await sleep(20);
    assert.ok(/Player 105/.test(app.dom.get("psDetail").innerHTML), "前提: 別の選手(Player 105)の詳細が開いている");
    st.calls.length = 0;
    await app.api.psOpenByName(names[0]); await sleep(40);
    assert.strictEqual(app.dom.get("psDetail").innerHTML, "", "前の選手の詳細が残っている");
    assert.notStrictEqual(app.dom.get("playerCardWrap").style.display, "none");
  });
  await t("1人目(索引に居る)の詳細を読み込んでいる間に2人目(索引に居ない)を開いたら、1人目の詳細とカードをあとから出さない", async () => {
    const { app, st, log, names, keys } = await openPlayerPage("nohit");
    st.hitNames = new Set(["Lionel Messi"]); st.detailDelay = 90;
    const p1 = app.api.psOpenByName(names[0]);           // 1人目: 検索(15ms)→ 一致 → 詳細の読み込み(90ms)
    await sleep(45);
    assert.ok(st.calls.some((u) => /\/knowledge\/player\?id=177/.test(u)), "前提: 1人目の詳細を読み込み中");
    const p2 = app.api.psOpenByName(names[1]);           // その間に2人目
    await Promise.all([p1, p2]); await sleep(120);
    assert.strictEqual(app.dom.get("psDetail").innerHTML, "", "1人目の詳細(または読み込み中の表示)が残っている");
    assert.strictEqual(app.api.psState.curatedKey, keys[1]); assert.strictEqual(app.dom.get("psName").value, app.api.PLAYERS[keys[1]].name);
    assert.ok(app.dom.get("playerCardWrap").innerHTML.includes(app.api.PLAYERS[keys[1]].nameJa), "出ているカードが2人目ではない");
    assert.ok(!app.dom.get("playerCardWrap").innerHTML.includes(app.api.PLAYERS[keys[0]].nameJa + "</"), "1人目のカードに描き変わっている");
    assert.strictEqual(log[log.length - 1].id, "playerCardWrap");
  });
  await t("名前で開いている途中(検索の返事待ち)に、検索結果の「詳しく見る」を押したら、あとから名前のほうの選手を割り込ませない", async () => {
    const { app, st, names } = await openPlayerPage("hit");
    st.delay = 60; st.detailDelay = 10;
    const root = app.dom.get("playerSection"); root.contains = () => true;
    const press = (act, id) => root._fire("click", { target: { closest: () => actEl({ act, id: String(id) }) } });
    const p1 = app.api.psOpenByName(names[0]);           // 検索の返事待ち(60ms)
    await sleep(10);
    press("psDetail", 105);                              // 利用者が別の選手の「詳しく見る」を押す
    await p1; await sleep(120);
    assert.ok(/Player 105/.test(app.dom.get("psDetail").innerHTML), "押した選手(Player 105)の詳細が出ていない");
    assert.ok(!st.calls.some((u) => /\/knowledge\/player\?id=177/.test(u)), "名前のほうの選手の詳細を、あとから読み込んでいる");
    assert.strictEqual(app.api.psState.lastOpenedName, null);
  });
  await t("詳細を読み込んでいる間に「閉じる」を押したら、あとから届いた詳細で開き直さない", async () => {
    const { app, st } = await openPlayerPage("nohit");
    st.detailDelay = 60;
    const root = app.dom.get("playerSection"); root.contains = () => true;
    const press = (act) => root._fire("click", { target: { closest: () => actEl({ act }) } });
    const p = app.api.psOpenDetail(105);
    await sleep(10);
    assert.ok(/読み込んでいます/.test(app.dom.get("psDetail").innerHTML), "前提: 読み込み中の表示");
    press("psCloseDetail");
    await p; await sleep(80);
    assert.strictEqual(app.dom.get("psDetail").innerHTML, "", "閉じたのに、あとから開き直している");
  });
  await t("通信がすぐ返った場合(仕上げが先に済んだ場合)は、あとからカードへ動き直さない(詳細の先頭に合わせたのを崩さない)", async () => {
    const o = await openPlayerPage("hit"); o.st.delay = 0;
    // 0ミリ秒の待ち(setTimeout)より先に、検索と詳細が返る状況を作る: 待ちを使わずに返す
    const fast = async (url) => {
      url = String(url);
      if (/\/knowledge\/players\?/.test(url)) return jsonRes({ ok: true, available: true, items: [cardOf(77, "Lionel Messi")], total: 1, page: 1, totalPages: 1, indexedCount: 1260 });
      if (/\/knowledge\/player\?id=/.test(url)) return jsonRes({ ok: true, player: { id: 177, name: "Lionel Messi" }, analysis: {}, seasonStats: {}, positionRanks: {}, tookMs: 1 });
      return jsonRes({ ok: false });
    };
    const app = loadApp({ fetch: fast, window: { matchMedia: matchMediaStub(false), innerHeight: 800 } });
    const log = [];
    for (const id of ["playerCardWrap", "psDetail", "psSearchCard"]) app.dom.get(id).scrollIntoView = () => log.push(id);
    await app.api.psEnsureInit(); await sleep(20); log.length = 0;
    await app.api.psOpenByName(Object.values(app.api.PLAYERS)[0].nameJa); await sleep(40);
    assert.strictEqual(log[log.length - 1], "psDetail", JSON.stringify(log));
    assert.ok(log.length <= 2 && log.filter((x) => x === "psDetail").length === 1, JSON.stringify(log));
  });
  await t("開いたあとに続けて行うこと(会話から頼まれた比較など)は、表示が出そろってから1回だけ実行し、返された要素へ合わせる。失敗しても開く処理は終える", async () => {
    const a = await openPlayerPage("hit");
    const target = a.app.dom.get("afterTarget"); const seen = [];
    target.scrollIntoView = () => a.log.push({ id: "afterTarget" });
    await a.app.api.psOpenByName(a.names[0], { after: () => { seen.push({ detailLen: a.app.dom.get("psDetail").innerHTML.length, cards: a.cardsNow() }); return target; } });
    await sleep(40);
    assert.strictEqual(seen.length, 1); assert.ok(seen[0].detailLen > 1000 && seen[0].cards === 1, "検索と詳細が出そろう前に実行している: " + JSON.stringify(seen));
    assert.deepStrictEqual(a.log.map((x) => x.id), ["playerCardWrap", "afterTarget"], JSON.stringify(a.log));
    // 続きの処理が失敗したら、いつもの場所(ここでは登録選手のカード)へ合わせる
    const b = await openPlayerPage("nohit");
    const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
    try { await b.app.api.psOpenByName(b.names[0], { after: () => { throw new Error("boom"); } }); } finally { console.warn = warn; }
    await sleep(40);
    assert.strictEqual(b.log[b.log.length - 1].id, "playerCardWrap"); assert.strictEqual(warned, 1, "失敗を黙って握りつぶさない");
    // 続けて2人開いたとき、1人目の続きの処理は実行しない
    const c = await openPlayerPage("nohit"); let ran1 = 0, ran2 = 0;
    await Promise.all([c.app.api.psOpenByName(c.names[0], { after: () => { ran1++; return null; } }), c.app.api.psOpenByName(c.names[1], { after: () => { ran2++; return null; } })]);
    await sleep(40);
    assert.strictEqual(ran1, 0); assert.strictEqual(ran2, 1);
  });
  await t("ホームの会話から「AとBを比較して」: 選手を開く処理に任せ、出そろってから比較を描く。詳細分析は、閉じているときだけ開く(開いているのを閉じない)", () => {
    const i = html.indexOf("if (mentioned.length >= 2 && comparisonKeyword) {"); assert.ok(i > 0);
    const block = html.slice(i, html.indexOf("} else if (mentioned.length === 1) {", i));
    assert.ok(block.includes("psOpenByName(cmpA.nameJa, { after: () => {"), block.slice(0, 900));
    assert.ok(block.includes('if (expandBtn && moreWrap && moreWrap.style.display !== "block") expandBtn.click();'));
    assert.ok(block.includes("renderComparison(cmpA, cmpB.key);") && block.includes('return document.getElementById("compareResultWrap");'));
    assert.ok(!/if \(expandBtn\) expandBtn\.click\(\);/.test(block), "開いているときにも押して、閉じてしまう書き方が残っている");
    assert.ok(!/setTimeout\(\(\) => \{\s*const sel = document\.getElementById\("compareSelect"\)/.test(block), "読み込みを待たずに動く書き方が残っている");
    // 1人だけ名前が出た質問: 同じカードを2回描かない・2回動かさない(選手を開く処理に一本化)
    const j = html.indexOf("} else if (mentioned.length === 1) {", i); const single = html.slice(j, html.indexOf("const ruleAnswer = answerPlayerQuestion(mentioned[0], q, state.level);", j));
    assert.ok(single.includes("psOpenByName(mentioned[0].nameJa);") && !single.includes("renderPlayerCard(") && !single.includes("scrollToEl("), single);
    // id を渡して動く古い関数は無くした(動く処理は、選手の画面の psScrollTo と、メニューの scrollToEl(要素)だけ)
    assert.ok(!/function scrollToEl\(id\)/.test(html) && !/scrollToEl\("/.test(html));
  });
  await t("登録選手どうしの比較: 列の見出しは絵文字ではなく名前(色の印つき)。数字はそのまま。相手を選ぶ欄の選択肢にも絵文字を出さない", async () => {
    const o = await openPlayerPage("nohit");
    await o.app.api.psOpenByName(o.names[0]); await sleep(40);
    const P = o.app.api.PLAYERS, kA = o.keys[0], kB = o.keys[1];
    const opts = o.app.dom.get("compareSelect").innerHTML;
    assert.ok(opts.includes(`<option value="${kB}">${P[kB].nameJa}</option>`), opts.slice(0, 300));
    assert.ok(!/\p{Extended_Pictographic}/u.test(opts), "選択肢に絵文字が残っている");
    assert.ok(!opts.includes(`value="${kA}"`), "自分自身は選択肢に出さない(従来どおり)");
    o.app.api.renderComparison({ key: kA, ...P[kA] }, kB);
    const h = o.app.dom.get("compareResultWrap").innerHTML;
    const head = /<div class="compare-attr-row vz-ca-head">([\s\S]*?)<\/div>/.exec(h); assert.ok(head, h.slice(0, 400));
    assert.ok(head[1].includes(`<span class="vz-ca-who"><i class="vz-sw vz-h"></i><span>${P[kA].nameJa}</span></span>`) && head[1].includes(`<span class="vz-ca-who vz-r"><span>${P[kB].nameJa}</span><i class="vz-sw vz-a"></i></span>`), head[1]);
    assert.ok(!/\p{Extended_Pictographic}/u.test(head[1]), "見出しに絵文字が残っている");
    assert.ok(h.includes(`<div class="name"><i class="vz-sw vz-h"></i><span>${P[kA].nameJa}</span></div>`) && h.includes(`<div class="name"><i class="vz-sw vz-a"></i><span>${P[kB].nameJa}</span></div>`));
    // 数字: 登録データの能力値をそのまま(高いほうに強調)
    const rows = [...h.matchAll(/<div class="compare-attr-row">\s*<span class="ca-val ([^"]*)">(\d+)<\/span>\s*<span class="ca-label">([^<]+)<\/span>\s*<span class="ca-val ([^"]*)">(\d+)<\/span>/g)];
    const keys = Object.keys(P[kA].attrs); assert.strictEqual(rows.length, keys.length);
    rows.forEach((r, idx) => { const av = P[kA].attrs[keys[idx]], bv = P[kB].attrs[keys[idx]]; assert.strictEqual(Number(r[2]), av); assert.strictEqual(Number(r[5]), bv); assert.strictEqual(/ca-lead/.test(r[1]), av >= bv); assert.strictEqual(/ca-lead/.test(r[4]), bv >= av); });
    assert.ok(/\.compare-attr-row\.vz-ca-head \{ grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/.test(html) && /\.vz-ca-who > span \{ min-width: 0; word-break: keep-all; overflow-wrap: anywhere; \}/.test(html));
  });
  await t("着いたあとの見届け: 動きが止まってから位置を確かめ、あとから上の内容が増えてずれたら合わせ直す。触れたら・別の移動が始まったら、やめる", async () => {
    const mkWin = () => { const L = {}; return { L, scrollY: 0, innerHeight: 800, matchMedia: matchMediaStub(false), addEventListener(ev, fn) { (L[ev] = L[ev] || []).push(fn); }, removeEventListener(ev, fn) { L[ev] = (L[ev] || []).filter((f) => f !== fn); } }; };
    const mk = () => { const w = mkWin(); const app = loadApp({ window: w }); const el = app.dom.get("settleTarget"); const s = { w, app, el, top: 14, calls: [] };
      el.getBoundingClientRect = () => ({ top: s.top }); el.scrollIntoView = (o) => { s.calls.push(o.behavior); if (o.behavior === "auto") s.top = 14; }; return s; };
    // (a) 止まったら1回確かめる。あとからずれたら合わせ直す。ずれていなければ何もしない
    const a = mk(); const n0 = (a.w.L.touchstart || []).length;
    a.app.api.psScrollTo(a.el, { settle: true });
    assert.deepStrictEqual(a.calls, ["smooth"]); assert.strictEqual((a.w.L.touchstart || []).length, n0 + 1, "触れたかどうかの見張りを付けている");
    await sleep(400); assert.deepStrictEqual(a.calls, ["smooth", "auto"]);
    a.top = 240;                                   // あとから上の内容が増えて、見ていた場所が下へずれた
    await sleep(400); assert.deepStrictEqual(a.calls, ["smooth", "auto", "auto"]); assert.strictEqual(a.top, 14);
    await sleep(400); assert.strictEqual(a.calls.length, 3);
    await sleep(2600); assert.strictEqual((a.w.L.touchstart || []).length, n0, "見届けが終わったら見張りを外す(最長で約3秒)");
    a.top = 500; await sleep(300); assert.strictEqual(a.calls.length, 3, "見届けが終わったあとは動かさない");
    // (b) 利用者が画面に触れたら、そこでやめる
    const b = mk(); const m0 = (b.w.L.touchstart || []).length;
    b.app.api.psScrollTo(b.el, { settle: true });
    (b.w.L.touchstart || []).slice(m0).forEach((fn) => fn({})); b.top = 300;
    await sleep(500); assert.deepStrictEqual(b.calls, ["smooth"]); assert.strictEqual((b.w.L.touchstart || []).length, m0);
    // (c) 別の移動が始まったら、前の見届けはやめる
    const c = mk(); const other = c.app.dom.get("otherTarget"); other.scrollIntoView = () => {};
    c.app.api.psScrollTo(c.el, { settle: true }); c.app.api.psScrollTo(other); c.top = 300;
    await sleep(500); assert.deepStrictEqual(c.calls, ["smooth"]);
    // (d) 動いている間(画面の位置が変わり続けている間)は確かめない
    const d = mk(); d.app.api.psScrollTo(d.el, { settle: true });
    const iv = setInterval(() => { d.app.windowStub.scrollY += 40; }, 50);   // アプリが見ている window(loadApp が写しを作る)の位置を動かす
    await sleep(700); assert.deepStrictEqual(d.calls, ["smooth"], "動いている途中で合わせ直している");
    clearInterval(iv); await sleep(450); assert.deepStrictEqual(d.calls, ["smooth", "auto"]);
    // (e) 見届けを頼まない移動(従来の移動)では、何も足さない
    const e = mk(); const k0 = (e.w.L.touchstart || []).length; e.app.api.psScrollTo(e.el); await sleep(400);
    assert.deepStrictEqual(e.calls, ["smooth"]); assert.strictEqual((e.w.L.touchstart || []).length, k0);
  });
  await t("動かし方: ふだんは なめらかに。動く先が1画面ぶん以上「上」にあるとき(仕上げだけ)と、「動きを減らす」設定の端末では、すぐその場所を出す", () => {
    const mk = (reduce) => {
      const app = loadApp({ window: { matchMedia: matchMediaStub(reduce), innerHeight: 800 } });
      const el = app.dom.get("anyTarget"); const got = [];
      el.scrollIntoView = (o) => got.push(o.behavior + "/" + o.block);
      return { ps: app.api.psScrollTo, el, got };
    };
    const a = mk(false);
    a.ps(a.el); assert.deepStrictEqual(a.got, ["smooth/start"]);
    a.el.getBoundingClientRect = () => ({ top: -5000 }); a.ps(a.el, { jumpIfFarAbove: true }); assert.strictEqual(a.got[1], "auto/start");
    a.el.getBoundingClientRect = () => ({ top: -300 }); a.ps(a.el, { jumpIfFarAbove: true }); assert.strictEqual(a.got[2], "smooth/start");
    a.el.getBoundingClientRect = () => ({ top: 4000 }); a.ps(a.el, { jumpIfFarAbove: true }); assert.strictEqual(a.got[3], "smooth/start", "下にあるときは、なめらかに(続けて動く)");
    a.el.getBoundingClientRect = () => ({ top: -5000 }); a.ps(a.el); assert.strictEqual(a.got[4], "smooth/start", "指定が無い移動は従来どおり");
    a.el.getBoundingClientRect = () => { throw new Error("no layout"); }; a.ps(a.el, { jumpIfFarAbove: true }); assert.strictEqual(a.got[5], "smooth/start", "位置を測れないときは、なめらかに");
    const b = mk(true);
    b.ps(b.el); assert.deepStrictEqual(b.got, ["auto/start"]);
    assert.doesNotThrow(() => a.ps(null));
  });
  await t("動いた先がメニューの下に隠れない: 広い画面は上のメニューのぶん、スマホは下のメニューのぶんを画面の端から空ける。動く先には 14px の余白", () => {
    assert.ok(html.includes("html { scroll-padding-bottom: calc(66px + env(safe-area-inset-bottom, 0px)); }"));
    assert.ok(html.includes("@media (min-width: 761px) { html { scroll-padding-top: 64px; scroll-padding-bottom: 0px; } }"));
    const m = /#todayPredictionsCard, #heroAiChat, #realFixturesCard, #playerSection, #moreMenuTitle,\s*#psSearchCard, #psSummary, #psDetail, #playerCardWrap, #psCompare, #realFixtureAnalysisWrap, #compareResultWrap, #aiRankingsCard, #scoutFeedCard \{ scroll-margin-top: 14px; \}/.exec(html);
    assert.ok(m, "動く先の余白の指定が見つからない");
    assert.ok(!/scroll-margin-top:\s*78px/.test(html), "広い画面の余白は、画面の端の空き(64px)+14px で作る(二重に足さない)");
    // 上のメニュー(広い画面)は 上端10px・ボタンの高さ40px+内側の余白5px×2 = 下端60px。64px 空ければ隠れない
    assert.ok(/\.vz-nav \{ position: sticky; top: 10px;/.test(html) && /\.vz-nav button \{ flex-direction: row; gap: 7px; min-height: 40px;/.test(html));
  });
  await t("候補の一覧: 名前を打ってすぐ Enter で検索したら、候補の問い合わせを送らない・あとから一覧を開かない", async () => {
    const st = { calls: [], mode: "nohit", delay: 0 };
    const app = loadApp({ fetch: playerFetch(st), window: { matchMedia: matchMediaStub(false) } });
    app.api.psWireCombo("tName", "tNameList", "name", () => {});
    const input = app.dom.get("tName"), list = app.dom.get("tNameList");
    input.value = "mes"; input._fire("input", {});
    let prevented = 0;
    input._fire("keydown", { key: "Enter", preventDefault() { prevented++; } });   // 0.15 秒の待ちが明ける前に検索
    await sleep(330);
    assert.strictEqual(prevented, 1);
    assert.ok(!st.calls.some((u) => /\/players\/suggest/.test(u)), "候補の問い合わせが送られた: " + st.calls.join(" | "));
    assert.ok(st.calls.some((u) => /\/knowledge\/players\?/.test(u)), "検索は走る");
    assert.strictEqual(list.classList.contains("open"), false);
  });
  await t("候補の一覧: 問い合わせの返事を待っている間に欄の外(検索ボタンなど)を押したら、あとから届いた候補で一覧を開かない", async () => {
    const st = { calls: [], mode: "nohit", delay: 0 }; let release; st.suggestGate = new Promise((r) => { release = r; });
    const app = loadApp({ fetch: playerFetch(st), window: { matchMedia: matchMediaStub(false) } });
    const before = (app.dom.docL.click || []).length;
    app.api.psWireCombo("tName", "tNameList", "name", () => {});
    const input = app.dom.get("tName"), list = app.dom.get("tNameList");
    input.value = "mes"; input._fire("input", {});
    await sleep(220);
    assert.ok(st.calls.some((u) => /\/players\/suggest\?field=name&q=mes/.test(u)), "前提: 候補の問い合わせが出ている");
    const mine = (app.dom.docL.click || []).slice(before); assert.strictEqual(mine.length, 1, "欄の外を押したときの処理が1つ登録されている");
    mine[0]({ target: app.dom.get("psSearchBtn") });   // 欄の外を押す
    release(); await sleep(40);
    assert.strictEqual(list.classList.contains("open"), false, "あとから届いた候補で開いてしまった");
    assert.strictEqual(list.innerHTML, "");
    // 欄の中を押したときは閉じない(待っている候補も取り消さない)
    st.suggestGate = null; input.value = "mess"; input._fire("input", {}); await sleep(60);
    mine[0]({ target: input }); await sleep(200);
    assert.strictEqual(list.classList.contains("open"), true);
  });
  await t("候補の一覧: ふつうに待てば開く(従来どおり)。Tab で次の欄へ移ったら閉じる。Esc でも閉じる。打ち直せばまた開く", async () => {
    const st = { calls: [], mode: "nohit", delay: 0 };
    const app = loadApp({ fetch: playerFetch(st), window: { matchMedia: matchMediaStub(false) } });
    app.api.psWireCombo("tName", "tNameList", "name", () => {});
    const input = app.dom.get("tName"), list = app.dom.get("tNameList");
    input.value = "mes"; input._fire("input", {}); await sleep(230);
    assert.strictEqual(list.classList.contains("open"), true); assert.ok(/Lionel Messi/.test(list.innerHTML)); assert.strictEqual(input.getAttribute("aria-expanded"), "true");
    let prevented = 0;
    input._fire("keydown", { key: "Tab", preventDefault() { prevented++; } });
    assert.strictEqual(list.classList.contains("open"), false); assert.strictEqual(list.innerHTML, ""); assert.strictEqual(input.getAttribute("aria-expanded"), "false");
    assert.strictEqual(prevented, 0, "Tab そのものの動き(次の欄へ移る)は止めない");
    input.value = "messi"; input._fire("input", {}); await sleep(230);
    assert.strictEqual(list.classList.contains("open"), true);
    input._fire("keydown", { key: "Escape", preventDefault() {} });
    assert.strictEqual(list.classList.contains("open"), false);
    // 日本語入力の変換を確定する Enter では、検索も、閉じることもしない(v97 の動きを保つ)
    input.value = "めっし"; input._fire("input", {}); await sleep(230);
    const n = st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length;
    input._fire("keydown", { key: "Enter", isComposing: true, preventDefault() {} });
    assert.strictEqual(list.classList.contains("open"), true); assert.strictEqual(st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length, n);
  });
  await t("候補の一覧のいちばん下に「入力した文字で検索する」: 一覧が「検索する」ボタンを覆っていても検索できる。入力した文字は訳さず、エスケープする", async () => {
    const st = { calls: [], mode: "nohit", delay: 0 };
    const app = loadApp({ fetch: playerFetch(st), window: { matchMedia: matchMediaStub(false) } });
    app.api.psWireCombo("tName", "tNameList", "name", () => {});
    const input = app.dom.get("tName"), list = app.dom.get("tNameList");
    input.value = 'me<b>s'; input._fire("input", {}); await sleep(230);
    const h = String(list.innerHTML);
    const go = /<button type="button" class="ps-opt ps-opt-go" role="option" data-search="1">([\s\S]*?)<\/button>/.exec(h); assert.ok(go, h.slice(-600));
    assert.ok(h.trim().endsWith("</button>") && h.lastIndexOf('class="ps-opt ps-opt-go"') > h.lastIndexOf('data-value="Lionel Messi"'), "検索の行は、候補のあと(いちばん下)");
    assert.ok(go[1].includes('<span data-no-tr="1">me&lt;b&gt;s</span>'), "入力した文字は、訳さない印つき・エスケープ済みで出す: " + go[1]);
    // 前後の言葉は4言語ぶんを並べ、画面の言語のものだけを見せる
    for (const [lang, a, b] of [["ja", "「", "」で検索する"], ["en", "Search for “", "”"], ["zh", "搜索“", "”"], ["es", "Buscar «", "»"]]) {
      assert.ok(go[1].includes(`<span lang="${lang}">${a}</span>`) && go[1].includes(`<span lang="${lang}">${b}</span>`), lang + ": " + go[1]);
    }
    // 押すと、一覧を閉じて検索する
    const n = st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length;
    list._fire("click", { target: { closest: () => ({ dataset: { search: "1" } }) } }); await sleep(30);
    assert.strictEqual(list.classList.contains("open"), false);
    assert.strictEqual(st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length, n + 1);
    // 候補そのものを押したときの動き(その候補を選ぶ)は従来どおり
    input.value = "mes"; input._fire("input", {}); await sleep(230);
    let picked = null; app.api.psWireCombo("tName2", "tName2List", "name", (p) => { picked = p; });
    const in2 = app.dom.get("tName2"), l2 = app.dom.get("tName2List");
    in2.value = "mes"; in2._fire("input", {}); await sleep(230);
    l2._fire("click", { target: { closest: () => ({ dataset: { value: "Lionel Messi", id: "154" } }) } });
    assert.deepStrictEqual(picked, { value: "Lionel Messi", id: 154 }); assert.strictEqual(in2.value, "Lionel Messi");
    // 候補が無いとき(「候補が見つかりませんでした」)は、検索の行を出さない
    const st2 = { calls: [], mode: "nohit", delay: 0 };
    const app2 = loadApp({ fetch: async (url) => (/\/players\/suggest/.test(String(url)) ? jsonRes({ ok: true, items: [] }) : jsonRes({ ok: false })), window: { matchMedia: matchMediaStub(false) } });
    app2.api.psWireCombo("tName", "tNameList", "name", () => {});
    const in3 = app2.dom.get("tName"), l3 = app2.dom.get("tNameList");
    in3.value = "zzz"; in3._fire("input", {}); await sleep(230);
    assert.ok(/候補が見つかりませんでした/.test(l3.innerHTML) && !/ps-opt-go/.test(l3.innerHTML), l3.innerHTML);
    // 候補の写真: 読めないときに空白だけを残さない(人の形の印を下に敷く)。ページのどこにも「読めなければ見えなくするだけ」の写真は残っていない
    const st3 = { calls: [], mode: "nohit", delay: 0 };
    const app3 = loadApp({ fetch: async (url) => (/\/players\/suggest/.test(String(url)) ? jsonRes({ ok: true, items: [{ value: "Lionel Messi", labelJa: "Lionel Messi", subJa: "Inter Miami", id: 154, photo: "https://media.example.com/p/154.png" }] }) : playerFetch(st3)(url)), window: { matchMedia: matchMediaStub(false) } });
    app3.api.psWireCombo("tName", "tNameList", "name", () => {});
    const in4 = app3.dom.get("tName"), l4 = app3.dom.get("tNameList");
    in4.value = "mes"; in4._fire("input", {}); await sleep(230);
    assert.ok(/<span class="vz-avatar vz-xs"><svg[\s\S]*?<\/svg><img src="https:\/\/media\.example\.com\/p\/154\.png" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this\.remove\(\)"><\/span>/.test(l4.innerHTML), l4.innerHTML.slice(0, 500));
    assert.ok(!/visibility='hidden'/.test(html));
    // スマホのキーボードの確定キーを「検索」と表示させる(3つの欄とも)
    for (const id of ["psName", "psNat", "psClub"]) assert.ok(new RegExp('<input type="text" id="' + id + '"[^>]*enterkeyhint="search">').test(html), id);
    assert.ok(/\.ps-opt\.ps-opt-go \{ position: sticky; bottom: 0; min-height: 44px; justify-content: center;/.test(html));
    // 候補の各行は左ぞろえ(スマホ幅の「ボタンの中身をまん中に寄せる」共通の規則より、あとに書いて勝たせる)
    const iCommon = html.indexOf("button { display: inline-flex; align-items: center; justify-content: center; }"), iRow = html.indexOf(".ps-opt { justify-content: flex-start; }");
    assert.ok(iCommon > 0 && iRow > iCommon, "候補の行の左ぞろえの指定が無い/共通の規則より前にある");
  });

  console.log("■ 10. 選手の画面: 検索結果の下にあるもの(ランキング・スカウト速報)へ行き着ける");
  await t("検索結果の続きは「もっと見る」を押したときだけ読み込む(下へ送っただけでは足さない=下にあるランキングなどが遠ざからない)", async () => {
    // 自動で足す仕組み(一覧の下端を見張る)は無くした。ほかの場所にも、同じ見張りは無い
    assert.ok(!/psSentinel/.test(html) && !/IntersectionObserver/.test(mainScript), "一覧の下端を見張って自動で足す処理が残っている");
    const o = await openPlayerPage("nohit"); o.st.pages = 3;
    await o.app.api.psSearch(1, false); await sleep(30);
    const more = () => String(o.app.dom.get("psMore").innerHTML);
    assert.strictEqual(o.cardsNow(), 24); assert.ok(/id="psMoreBtn"[^>]*>もっと見る\(1\/3ページ\)</.test(more()), more());
    const n = o.st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length;
    await sleep(120);
    assert.strictEqual(o.st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length, n, "何もしていないのに続きを読み込んでいる");
    o.app.dom.get("psMoreBtn")._fire("click", {}); await sleep(60);
    assert.ok(o.st.calls.some((u) => /[?&]page=2\b/.test(u)), "押したのに2ページ目を読み込んでいない");
    assert.strictEqual(o.cardsNow(), 48); assert.ok(/もっと見る\(2\/3ページ\)/.test(more()), more());
    o.app.dom.get("psMoreBtn")._fire("click", {}); await sleep(60);
    assert.strictEqual(o.cardsNow(), 72); assert.ok(/すべて表示しました\(72人\)/.test(more()) && !/psMoreBtn/.test(more()), more());
  });
  await t("選手の画面の上に行き先を並べる(選手を探す・ランキング・スカウト速報)。押すとその場所へ動く。スカウト速報は、カードが出ているときだけ", async () => {
    const m = /<div class="vz-toc" id="psToc">([\s\S]*?)<\/div>/.exec(html); assert.ok(m, "行き先の並びが無い");
    assert.ok(m[1].includes('<span class="vz-toc-l">この画面の中身</span>'));
    assert.ok(m[1].includes('<button type="button" class="vz-toc-b" data-act="psToc" data-target="psSearchCard">選手を探す</button>'));
    assert.ok(m[1].includes('<button type="button" class="vz-toc-b" data-act="psToc" data-target="aiRankingsCard">ランキング</button>'));
    assert.ok(m[1].includes('<button type="button" class="vz-toc-b" id="psTocScout" data-act="psToc" data-target="scoutFeedCard" hidden>スカウト速報</button>'), "スカウト速報は、はじめは出さない(記録を読めてから)");
    // 行き先の id は、実際にその画面にある
    for (const id of ["psSearchCard", "aiRankingsCard", "scoutFeedCard"]) assert.ok(new RegExp('<div class="card" id="' + id + '"').test(html), id + " が無い");
    assert.ok(html.indexOf('id="psToc"') > html.indexOf('<div id="playerSection"') && html.indexOf('id="psToc"') < html.indexOf('id="psHighlightCard"'), "置き場は、選手の画面のいちばん上");
    assert.ok(/\.vz-toc-b \{[^}]*min-height: 40px;/.test(html) && /\.vz-toc-b\[hidden\] \{ display: none; \}/.test(html));
    const o = await openPlayerPage("nohit");
    const root = o.app.dom.get("playerSection"); root.contains = () => true;
    const went = [];
    for (const id of ["psSearchCard", "aiRankingsCard", "scoutFeedCard"]) o.app.dom.get(id).scrollIntoView = () => went.push(id);
    for (const id of ["aiRankingsCard", "scoutFeedCard", "psSearchCard"]) root._fire("click", { target: { closest: () => actEl({ act: "psToc", target: id }) } });
    assert.deepStrictEqual(went, ["aiRankingsCard", "scoutFeedCard", "psSearchCard"]);
    // 行き先を押しても、名前で開いている途中の処理は止めない(別のものを開いたわけではない)
    o.app.api.psState.lastOpenedName = "x"; root._fire("click", { target: { closest: () => actEl({ act: "psToc", target: "aiRankingsCard" }) } });
    assert.strictEqual(o.app.api.psState.lastOpenedName, "x");
    // スカウト速報のボタン: カードが出ているときだけ
    const chip = o.app.dom.get("psTocScout"), card = o.app.dom.get("scoutFeedCard");
    card.style.display = ""; o.app.api.psSyncToc(); assert.strictEqual(chip.hidden, false);
    card.style.display = "none"; o.app.api.psSyncToc(); assert.strictEqual(chip.hidden, true);
    assert.ok(html.includes("Promise.resolve(renderScoutFeed()).then(psSyncToc, psSyncToc);"), "スカウト速報を読み終えたあとに、ボタンの出し分けをしていない");
  });
  await t("選手・クラブのページを「閉じる」と、開いたときに押した場所(一覧のカードなど)へ戻る。もう画面に無ければ、従来どおり検索欄へ", async () => {
    const mk = async () => {
      const o = await openPlayerPage("nohit"); o.st.detailDelay = 5;
      const root = o.app.dom.get("playerSection"); root.contains = () => true;
      const went = [];
      o.app.dom.get("psSearchCard").scrollIntoView = (x) => went.push("psSearchCard/" + x.block);
      const card = { dataset: { id: "105" }, scrollIntoView: (x) => went.push("card105/" + x.block) };
      const btn = { dataset: { act: "psDetail", id: "105" }, isConnected: true, closest: (sel) => (/\.sd-card/.test(sel) ? card : null) };
      const fire = (el) => root._fire("click", { target: { closest: () => el } });
      return { o, root, went, card, btn, fire };
    };
    // (a) 一覧のカードの「詳しく見る」から開いて閉じる → そのカードへ(画面のまん中に)
    const a = await mk();
    a.fire(a.btn); await sleep(40);
    assert.ok(/Player 105/.test(a.o.app.dom.get("psDetail").innerHTML));
    a.fire(actEl({ act: "psCloseDetail" })); await sleep(10);
    assert.deepStrictEqual(a.went, ["card105/center"]); assert.strictEqual(a.o.app.dom.get("psDetail").innerHTML, "");
    // もう一度「閉じる」に当たる操作が来ても、覚えた場所は使い切っている(検索欄へ)
    a.fire(actEl({ act: "psCloseDetail" })); assert.deepStrictEqual(a.went, ["card105/center", "psSearchCard/start"]);
    // (b) 開いたページの中のリンク(似ている選手)から続けて開いても、戻る先は最初に押したカード
    const b = await mk();
    b.fire(b.btn); await sleep(40);
    const inner = actEl({ act: "psDetail", id: "106" }); b.o.app.dom.get("psDetail").contains = (x) => x === inner;
    b.fire(inner); await sleep(40);
    assert.ok(/Player 106/.test(b.o.app.dom.get("psDetail").innerHTML));
    b.fire(actEl({ act: "psCloseDetail" })); await sleep(10);
    assert.deepStrictEqual(b.went, ["card105/center"]);
    // (c) 一覧が描き直されて、押した部品が入れ替わっていたら、同じ選手のカードを探して戻る
    const c = await mk();
    c.fire(c.btn); await sleep(40);
    c.btn.isConnected = false;
    const fresh = { scrollIntoView: (x) => c.went.push("fresh105/" + x.block) };
    c.o.app.dom.document.querySelector = (sel) => (sel === '#psResults .sd-card[data-id="105"]' ? fresh : null);
    c.fire(actEl({ act: "psCloseDetail" })); await sleep(10);
    assert.deepStrictEqual(c.went, ["fresh105/center"]);
    // (d) そのカードがもう画面に無い(別の検索をした)→ 検索欄へ
    const d = await mk();
    d.fire(d.btn); await sleep(40);
    d.btn.isConnected = false; d.o.app.dom.document.querySelector = () => null;
    d.fire(actEl({ act: "psCloseDetail" })); await sleep(10);
    assert.deepStrictEqual(d.went, ["psSearchCard/start"]);
    // (e) 名前で開いた(ホーム・ランキング・会話から)ときは、押した場所を覚えていない → 検索欄へ
    const e = await mk();
    await e.o.app.api.psOpenByName(e.o.names[0]); await sleep(40);
    e.fire(actEl({ act: "psCloseDetail" })); await sleep(10);
    assert.deepStrictEqual(e.went, ["psSearchCard/start"]);
    assert.strictEqual(e.o.app.dom.get("playerCardWrap").style.display, "none", "閉じたら、登録選手のカードも片づける(従来どおり)");
  });
  await t("新しく足した文言(行き先の並び)は3言語に訳せる。スカウト速報は、カードの見出しの訳と同じ言葉", () => {
    const exp = { en: ["On this page", "Find players", "Rankings", "Scout bulletin"], zh: ["本页内容", "查找球员", "排行榜", "球探快报"], es: ["En esta página", "Buscar jugadores", "Rankings", "Boletín de ojeo"] };
    for (const lang of ["en", "zh", "es"]) {
      const tr = loadI18n(lang);
      assert.deepStrictEqual(["この画面の中身", "選手を探す", "ランキング", "スカウト速報"].map((s) => tr(s)), exp[lang]);
      assert.ok(tr("🛰️ スカウト速報(AIが自動で見つけた動き)").includes(exp[lang][3]), lang + ": 見出しの訳と言葉が違う");
      // 既にある訳を壊していない(短い語「ランキング」が、ほかの見出しに半端に当たらない)
      assert.ok(!/[ぁ-んァ-ヶ]/.test(tr("🏆 AIオリジナルランキング")) && !/[ぁ-んァ-ヶ]/.test(tr("もっと見る(1/53ページ)")));
    }
  });

  console.log("■ 11. 仕上げの見直しで足した確認(前の版との数字の突き合わせ/修正を1つずつ外して検査が気づくかの確認、で見つけたもの)");
  await t("AIの反省「連続的中の最長」には、ホームの帯と同じ断り書き「保存範囲内」を添える(全期間の記録のように読ませない)。3言語にも訳せる", () => {
    assert.ok(html.includes('kp.push({ label: "連続的中の最長", value: stBest, unit: "連続", sub: "(保存範囲内)" });'), "添え書きが無い");
    assert.ok(html.includes("const stBest = d.streak && d.streak.official && Number.isFinite(Number(d.streak.official.best)) ? Number(d.streak.official.best) : null;"), "サーバーの値(streak.official.best)をそのまま使う");
    assert.strictEqual(count(html, /\(保存範囲内の最長: \$\{Number\(st\.best\)\}連続/g), 3, "ホームの帯の言葉(保存範囲内の最長)は変えていない");
    // 大きな数字の部品は、添え書き(sub)を数字の下に出す
    const k = VZ.kpi([{ label: "連続的中の最長", value: 3, unit: "連続", sub: "(保存範囲内)" }], "vz-sm");
    assert.ok(k.includes("<span>連続的中の最長</span><b>3<small>連続</small></b><em>(保存範囲内)</em>"), k);
    const exp = { en: "(within stored records)", zh: "(保存范围内)", es: "(en los registros guardados)" };
    for (const lang of ["en", "zh", "es"]) assert.strictEqual(loadI18n(lang)("(保存範囲内)"), exp[lang]);
  });
  await t("試合前の直近5試合の下の行: 点数が無い試合は「?」(「null」と出さない)。ホームかアウェイかが無い試合に、H/A を決めつけて書かない", () => {
    const h = api.knowledgeRecentFormHtml({ recentResults: [
      { date: "2026-11-01", opponent: "X", homeAway: "H", goalsFor: 2, goalsAgainst: 0 },
      { date: "2026-10-28", opponent: "Y<", homeAway: "A", goalsFor: null, goalsAgainst: null },
      { date: "2026-10-25", opponent: "Z", homeAway: null, goalsFor: 1, goalsAgainst: undefined },
      { date: "2026-10-20", opponent: "W", goalsFor: "3", goalsAgainst: 3 }] });
    assert.ok(h.includes('<div class="value-note" style="margin-top:5px;">H 2-0 X / A ?-? Y&lt; / 1-? Z / 3-3 W</div>'), h.slice(-300));
    assert.ok(!/null|undefined|NaN/.test(h), "分からない値が、そのままの文字で出ている");
    assert.ok(h.includes("<span>1勝1分0敗</span>"), "点数が両方そろった試合だけを数える");
    // ふつうの記録(H/A・点数あり)の出し方は、これまでと同じ
    const g = api.knowledgeRecentFormHtml({ recentResults: [{ opponent: "Al Ahli", homeAway: "A", goalsFor: 0, goalsAgainst: 4 }, { opponent: "Jeddah", homeAway: "H", goalsFor: 2, goalsAgainst: 3 }] });
    assert.ok(g.includes(">A 0-4 Al Ahli / H 2-3 Jeddah</div>"), g.slice(-200));
  });
  await t("「採点の記録を見る」の2つの文字リンクは、押せる範囲を上下に広げてある(文の中の細いリンクのままにしない)", () => {
    assert.ok(html.includes("#predsToReflectionsLink, #accuracyToReflectionsLink { display: inline-block; padding: 9px 0; }"), "押せる範囲を広げる指定が無い");
    for (const id of ["predsToReflectionsLink", "accuracyToReflectionsLink"]) assert.strictEqual(count(html, new RegExp('<a [^>]*id="' + id + '"', "g")), 1, id);
  });
  await t("すぐその場所を出したあと(動く先が1画面ぶん以上、上にあったとき)は、画面が2回描かれたあとにもう一度だけ同じ場所へ合わせる。その間に別の移動が始まっていたら何もしない", () => {
    const had = Object.prototype.hasOwnProperty.call(global, "requestAnimationFrame"), prev = global.requestAnimationFrame;
    const q = []; global.requestAnimationFrame = (fn) => { q.push(fn); return q.length; };
    try {
      const app = loadApp({ window: { matchMedia: matchMediaStub(false), innerHeight: 800 } });
      q.length = 0;
      const el = app.dom.get("anyTarget"), other = app.dom.get("otherTarget"); const got = [];
      el.scrollIntoView = (o) => got.push("el:" + o.behavior + "/" + o.block); other.scrollIntoView = (o) => got.push("other:" + o.behavior);
      el.getBoundingClientRect = () => ({ top: -5000 });
      app.api.psScrollTo(el, { jumpIfFarAbove: true });
      assert.deepStrictEqual(got, ["el:auto/start"]); assert.strictEqual(q.length, 1, "1コマ目を待つ");
      q.shift()(); assert.strictEqual(q.length, 1, "2コマ目を待つ"); assert.deepStrictEqual(got, ["el:auto/start"], "1コマ目では、まだ合わせない");
      q.shift()(); assert.deepStrictEqual(got, ["el:auto/start", "el:auto/start"], "2コマ目で、もう一度だけ合わせる"); assert.strictEqual(q.length, 0);
      // なめらかに動いたとき(すぐ出していないとき)は、合わせ直しを待たない
      el.getBoundingClientRect = () => ({ top: 300 }); got.length = 0;
      app.api.psScrollTo(el, { jumpIfFarAbove: true }); assert.deepStrictEqual(got, ["el:smooth/start"]); assert.strictEqual(q.length, 0);
      // 合わせ直しを待っている間に別の移動が始まったら、古いほうは何もしない
      el.getBoundingClientRect = () => ({ top: -5000 }); got.length = 0;
      app.api.psScrollTo(el, { jumpIfFarAbove: true }); const first = q.shift();
      app.api.psScrollTo(other);
      first(); while (q.length) q.shift()();
      assert.deepStrictEqual(got, ["el:auto/start", "other:smooth"], JSON.stringify(got));
    } finally { if (had) global.requestAnimationFrame = prev; else delete global.requestAnimationFrame; }
  });
  await t("選手の詳細を読み込んでいる間に、クラブで絞り込む検索へ移ったら(psClubToSearch)、あとから届いた詳細を描かない", async () => {
    const { app, st } = await openPlayerPage("nohit");
    st.detailDelay = 60;
    const root = app.dom.get("playerSection"); root.contains = () => true;
    const p = app.api.psOpenDetail(105);
    await sleep(10);
    assert.ok(/読み込んでいます/.test(app.dom.get("psDetail").innerHTML), "前提: 読み込み中の表示");
    const n = st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length;
    root._fire("click", { target: { closest: () => actEl({ act: "psClubToSearch", club: "Club 5" }) } });
    assert.strictEqual(app.dom.get("psDetail").innerHTML, "", "検索へ移ったら、読み込み中の表示は片づける");
    await p; await sleep(90);
    assert.strictEqual(app.dom.get("psDetail").innerHTML, "", "検索へ移ったのに、あとから届いた詳細を描いている");
    assert.strictEqual(app.dom.get("psClub").value, "Club 5");
    assert.strictEqual(st.calls.filter((u) => /\/knowledge\/players\?/.test(u)).length, n + 1, "クラブで絞り込んだ検索を1回行う");
  });
  await t("会話で選手1人の名前が出たとき: 選手を開く処理(psOpenByName)に任せるだけで、ほかの移動を足さない(同じ場所へ2回動かさない)", () => {
    const i = html.indexOf("} else if (mentioned.length === 1) {"); assert.ok(i > 0);
    const j = html.indexOf("const ruleAnswer = answerPlayerQuestion(mentioned[0], q, state.level);", i); assert.ok(j > i);
    const single = html.slice(i, j);
    const codeOnly = single.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.strictEqual(count(codeOnly, /psOpenByName\(mentioned\[0\]\.nameJa\);/g), 1);
    assert.ok(!/scrollIntoView|psScrollTo\(|scrollTo\(|setTimeout\(|renderPlayerCard\(/.test(codeOnly), codeOnly);
  });

  console.log(`\nv104.3 ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
