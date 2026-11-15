"use strict";
/**
 * v104.2(2026年11月15日)・画面の「見やすさの整理」の検証(利用者のご要望)
 * ----------------------------------------------------------------------------
 *   ・自信ランクがどこに書いてあるか分かりにくい → 予想カードのいちばん上に、色つきの帯で大きく出す
 *   ・情報が多すぎて見にくい → 常に見せるのは要点だけ。根拠は「🔎 根拠をくわしく見る」にたたむ(消さない)
 *   ・地力ランキング・試合分析AI・仮の対戦(注目試合/AIマッチ分析)を画面から外す
 *   ・本日の実際の試合をたためるようにする(既定は閉じる・件数の要約つき・開閉は端末に覚える)
 *   ・「もっと見る」(選手検索・AIの反省・賢くなったか・AIの裏側)は、最初はどれも開かない
 *   ・ホームの的中率は「このAI自身の実測」を1行で(API-Football の予測の的中率は「詳しく見る」の中へ)
 * index.html の本体スクリプトを、最小限の模擬 DOM の上でそのまま評価して確かめる(外部通信なし)。
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

const SERVER_DIR = __dirname;
const htmlPath = fs.existsSync(path.join(SERVER_DIR, "index.html")) ? path.join(SERVER_DIR, "index.html") : path.join(SERVER_DIR, "..", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const strip = (h) => String(h).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// 最小限の模擬 DOM(この検査で触る部品だけ本物らしく動く)
// ---------------------------------------------------------------------------
function makeEl(id, extra) {
  const listeners = {}; const attrs = {}; const classes = new Set();
  const el = {
    id, innerHTML: "", textContent: "", value: "", style: {}, children: [], dataset: {}, hidden: false, _scrolled: 0,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    dispatch(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg || { target: el, currentTarget: el, preventDefault() {} })); },
    querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; }, matches() { return false; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild() {}, remove() {}, focus() {}, click() { el.dispatch("click"); },
    classList: {
      toggle(c, on) { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
    },
    scrollTop: 0, scrollHeight: 0, scrollIntoView() { el._scrolled++; },
  };
  return Object.assign(el, extra || {});
}
function buildDom() {
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  // 「もっと見る」の4つ
  const modes = ["player", "reflections", "smarter", "backstage"];
  const buttons = modes.map((m) => { const b = makeEl("btn-" + m); b.dataset.mode = m; b.closest = (sel) => (sel === "button" ? b : null); return b; });
  const modeSwitch = get("modeSwitch"); modeSwitch.children = buttons;
  for (const m of modes) get(m + "Section").style.display = "none";
  // たためるカード
  const cards = [["digestCard", "digest", "closed"], ["realFixturesCard", "fixtures", "closed"], ["dashboardCard", "dashboard", "open"]].map(([id, key, dflt]) => {
    const card = get(id); card.dataset.fold = key; card.dataset.foldDefault = dflt;
    const btn = makeEl(id + "-btn"), body = makeEl(id + "-body"), chev = makeEl(id + "-chev");
    btn.querySelector = (sel) => (sel === ".fold-chev" ? chev : null);
    card.querySelector = (sel) => (sel === ".fold-btn" ? btn : sel === ".fold-body" ? body : null);
    card._btn = btn; card._body = body; card._chev = chev;
    return card;
  });
  get("realFixturesCard").style.display = "none";
  const docListeners = {};
  const document = {
    getElementById: get,
    documentElement: makeEl("html"), body: makeEl("body"),
    querySelectorAll(sel) { if (sel === "#modeSwitch button[data-mode]") return buttons; if (sel === ".fold-card") return cards; return []; },
    querySelector(sel) { if (sel === "#modeSwitch button.active") return buttons.find((b) => b.classList.contains("active")) || null; return makeEl("stub"); },
    addEventListener(ev, fn, capture) { (docListeners[ev] = docListeners[ev] || []).push({ fn, capture: !!capture }); },
    createElement() { return makeEl("created"); },
  };
  return { document, get, buttons, cards, docListeners };
}
function makeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _map: m };
}
/** index.html の本体スクリプト(いちばん大きいインライン script)を模擬 DOM の上で評価する */
function loadApp(opts) {
  const o = opts || {};
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m; while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  let code = scripts.reduce((a, b) => (b.length >= a.length ? b : a), "");
  code += `\nreturn { setHomeMode, currentHomeMode, openHomeMode, HOME_MODE_SECTIONS, switchToPlayerMode, setFoldOpen, initFoldCards, foldReadState, FOLD_STATE_KEY,
    setFixturesFoldMeta, syncFixturesJumpUi, predRankBandHtml, predRankConfPct, predReasonLineHtml, predAlertsHtml, predDetailsHtml, predDetailsBodyHtml,
    predictionSummaryBlockHtml, predTierChipHtml, predStripHtml, accuracyHeadlineHtml, applyReflHeadlineToAccuracyCard, duelScoreboardHtml, predOpenDetails,
    buildRecommendedHeroQuestions, renderDashboard, renderAiAccuracyWidget, renderTodayPredictionsHero, teamAvg, renderSmarterCard,
    setRefl: (v, st) => { reflHeadlineForHero = v; reflHeadlineState = st; }, setDuelMenuOpen: (v) => { duelMenuOpen = v; }, getDuelMenuOpen: () => duelMenuOpen };`;
  const dom = buildDom();
  const storage = makeStorage(o.storage);
  const windowStub = { navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {}, location: { hash: "", origin: "http://x", pathname: "/" } };
  const fetchStub = o.fetch || (async () => { throw new Error("no network"); });
  const fn = new Function("document", "window", "navigator", "fetch", "localStorage", "location", code);
  const api = fn(dom.document, windowStub, windowStub.navigator, fetchStub, storage, windowStub.location);
  return { api, dom, storage };
}

const P_BASE = {
  fixtureId: 501, league: "Premier League", kickoff: "2026-11-15T12:00:00Z", status: "NS", resolved: false,
  home: { name: "Arsenal" }, away: { name: "Chelsea" }, predictedWinner: "home", predictedScoreline: "2-1",
  probs: { homeWinPct: 61, drawPct: 22, awayWinPct: 17 }, topFactorJa: "直近フォーム", weightsVersion: 12,
  confidence: { displayPct: 63, rawPct: 61, calibrated: true, basisN: 40, gapPt: 2, outOfRange: false },
  factors: [{ labelJa: "直近フォーム", stars: 4 }], learnedCompetition: true,
};
const tier = (rank, extra) => ({ rank, labelJa: { S: "確信", A: "有力", B: "やや優勢", skip: "見送り" }[rank], confPct: { S: 74, A: 63, B: 55, skip: 44 }[rank], stamped: true, record: { basis: "forward", window: "all", n: 30, hits: 20, hitPct: 66.7 }, ...(extra || {}) });

(async () => {
  console.log("■ 1. 画面から外したもの(地力ランキング・試合分析AI・仮の対戦)");
  await t("タブ・置き場・カード・読み込み処理が index.html に残っていない", () => {
    for (const s of ['data-mode="match"', 'data-mode="rankings"', 'id="matchSection"', 'id="rankingsSection"', 'id="aiMatchAnalysisCard"', 'id="maResultWrap"', 'id="dashFeaturedMatch"', 'id="dashRecommendedMatches"', 'id="matchList"', "⚽ 試合分析AI</button>", "🏆 地力ランキング</button>", "🧠 AIマッチ分析(クラブ対戦シミュレーション)</h2>", "⚽ 注目の試合カード</h2>", "⚽ 今日の注目試合</h3>", "🎯 AIが見るべき試合カード</h3>"]) {
      assert.ok(!html.includes(s), "残っている: " + s);
    }
    for (const name of ["MATCHUPS", "renderMatchList", "renderMatchAnalysis", "computeMatchAnalysisLocally", "getDailyFeaturedMatchup", "renderDashFeaturedMatch", "renderDashRecommendedMatches", "fetchMatchAnalysis", "renderMatchAnalysisResult", "initMatchAnalysisWidget", "renderRankingsTab", "rankingsEnsureInit", "switchToMatchMode"]) {
      assert.ok(!new RegExp("(?:function|const|let|var)\\s+" + name + "\\b").test(html), "定義が残っている: " + name);
      assert.ok(!new RegExp("\\b" + name + "\\(").test(html), "呼び出しが残っている: " + name);
    }
    assert.ok(!/API_PROXY_BASE\}\/(?:ratings\/rankings|match-analysis|predict-match)/.test(html), "外した機能の API を画面がまだ呼んでいる");
    assert.ok(!/location\.hash !== "#rankings"/.test(html), "#rankings の誘導が残っている");
  });
  await t("残すもの: 実際の試合の「AI分析を見る」・今日のAI予想・会話での対戦の質問(/api/matchup)", () => {
    assert.ok(html.includes('class="match-analyze-btn real-fixture-analyze-btn"') && html.includes("AI分析を見る ▶") && html.includes("答え合わせを見る ▶"));
    assert.ok(html.includes('id="todayPredictionsCard"') && html.includes("async function tryMatchupFlow(") && html.includes("/matchup?q="));
    assert.ok(html.includes('id="dashFeaturedPlayer"') && html.includes('id="dashTrending"') && html.includes('id="dashTrivia"') && html.includes('id="dashRecentlyViewed"'));
  });

  console.log("■ 2. 「もっと見る」(最初はどれも開かない・もう一度押すと閉じる)");
  await t("タブは4つ。最初はどれも選ばれていない(class=active が無い)。見出しと説明がある", () => {
    const bar = html.slice(html.indexOf('<div class="segmented" id="modeSwitch"'), html.indexOf("</div>", html.indexOf('<div class="segmented" id="modeSwitch"')));
    assert.deepStrictEqual([...bar.matchAll(/data-mode="([a-z]+)"/g)].map((m) => m[1]), ["player", "reflections", "smarter", "backstage"]);
    assert.ok(!/class="active"/.test(bar), "最初から選ばれているタブがある");
    assert.ok(html.includes('<h2 class="more-menu-title" id="moreMenuTitle">📂 もっと見る</h2>') && html.includes("見たい項目を押すと、この下に開きます(もう一度押すと閉じます)。"));
    for (const id of ["playerSection", "reflectionsSection", "smarterSection", "backstageSection"]) assert.ok(new RegExp(`<div id="${id}" style="display:none;">`).test(html), id + " が最初から開いている");
  });
  await t("押すと開く・別の項目に切り替わる・同じ項目をもう一度押すと閉じる(aria-pressed も合わせる)", () => {
    const { api, dom } = loadApp();
    const shown = () => Object.fromEntries(["player", "reflections", "smarter", "backstage"].map((m) => [m, dom.get(m + "Section").style.display]));
    assert.strictEqual(api.currentHomeMode(), null);
    assert.deepStrictEqual(shown(), { player: "none", reflections: "none", smarter: "none", backstage: "none" });
    const click = (m) => dom.get("modeSwitch").dispatch("click", { target: dom.buttons.find((b) => b.dataset.mode === m), currentTarget: dom.get("modeSwitch") });
    click("reflections");
    assert.strictEqual(api.currentHomeMode(), "reflections"); assert.strictEqual(shown().reflections, "block");
    assert.strictEqual(dom.buttons[1].getAttribute("aria-pressed"), "true"); assert.strictEqual(dom.buttons[0].getAttribute("aria-pressed"), "false");
    click("smarter");
    assert.deepStrictEqual(shown(), { player: "none", reflections: "none", smarter: "block", backstage: "none" });
    click("smarter");
    assert.strictEqual(api.currentHomeMode(), null); assert.deepStrictEqual(shown(), { player: "none", reflections: "none", smarter: "none", backstage: "none" });
    api.setHomeMode("does-not-exist");
    assert.strictEqual(api.currentHomeMode(), null);
  });
  await t("画面の別の場所から開くとき(openHomeMode)は、すでに開いていても閉じない。開いたら項目の並びまで動かす", async () => {
    const { api, dom } = loadApp();
    api.openHomeMode("reflections", { scroll: true });
    assert.strictEqual(api.currentHomeMode(), "reflections");
    api.openHomeMode("reflections", { scroll: true });
    assert.strictEqual(api.currentHomeMode(), "reflections", "2回目で閉じてしまった");
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(dom.get("moreMenuTitle")._scrolled >= 1, "開いた場所まで画面を動かしていない");
    api.switchToPlayerMode(); assert.strictEqual(api.currentHomeMode(), "player");
    api.switchToPlayerMode(); assert.strictEqual(api.currentHomeMode(), "player");
    assert.ok(html.includes('openHomeMode("reflections", { scroll: true });') && !/window\.scrollTo\(\{ top: 0, behavior: "smooth" \}\); \}\s*\}\);\s*\}\s*\/\/ 精度証明ラウンド③/.test(html), "反省へのリンクが画面の一番上へ動かす旧い動きのまま");
  });

  console.log("■ 3. 予想カード: 自信ランクの帯");
  const { api } = loadApp();
  await t("ランクのある予想: 「🏅 自信ランク [S] 確信 … 自信 74%」(S/A/B で色の種類が変わる。数字はランクを決めた自信)", () => {
    const s = api.predRankBandHtml({ ...P_BASE, tier: tier("S") });
    assert.ok(/class="rank-band rank-s"/.test(s) && /<span class="rank-letter">S<\/span>/.test(s), s);
    assert.strictEqual(strip(s), "🏅 自信ランクS確信自信 74%");
    assert.ok(/class="rank-band rank-a"/.test(api.predRankBandHtml({ ...P_BASE, tier: tier("A") })) && /class="rank-band rank-b"/.test(api.predRankBandHtml({ ...P_BASE, tier: tier("B") })));
    // 刻印の自信(74)と、今カードに出ている自信(63)が違っても、帯にはランクを決めた 74 を出す
    assert.strictEqual(api.predRankConfPct({ ...P_BASE, tier: tier("S") }), 74);
    // 自信の数字が tier に無い旧い形は、カードの自信で代える
    assert.strictEqual(api.predRankConfPct({ ...P_BASE, tier: { rank: "A", labelJa: "有力" } }), 63);
  });
  await t("見送り: 「見送り」「自信が低い試合」と自信の数字を出す", () => {
    const s = api.predRankBandHtml({ ...P_BASE, tier: tier("skip") });
    assert.ok(/class="rank-band rank-skip"/.test(s));
    assert.strictEqual(strip(s), "🏅 自信ランク見送り自信が低い試合自信 44%");
  });
  await t("ランクの無い予想: 同じ場所に「対象外」と、サーバーが返した理由を出す(理由を推測で書かない)", () => {
    const s = api.predRankBandHtml({ ...P_BASE, learnedCompetition: false, tier: { rank: null, stamped: false, reasonJa: "AIがまだ学習していない大会のため、ランクの対象外です。" } });
    assert.ok(/class="rank-band rank-none"/.test(s));
    assert.strictEqual(strip(s), "🏅 自信ランク–対象外AIがまだ学習していない大会のため、ランクの対象外です。");
    assert.ok(!/自信 \d/.test(strip(s)), "対象外なのに自信の数字を帯に出している");
    assert.strictEqual(strip(api.predRankBandHtml({ ...P_BASE, tier: { rank: null } })), "🏅 自信ランク–対象外");
    // tier そのものが無い応答(旧い形・読み出し失敗)では帯を出さない
    assert.strictEqual(api.predRankBandHtml({ ...P_BASE }), ""); assert.strictEqual(api.predRankBandHtml({ ...P_BASE, tier: null }), ""); assert.strictEqual(api.predRankBandHtml(null), "");
    // 文字列は HTML として解釈されない
    assert.ok(!api.predRankBandHtml({ ...P_BASE, tier: { rank: null, reasonJa: "<img src=x>" } }).includes("<img"));
    assert.ok(!api.predRankBandHtml({ ...P_BASE, tier: { rank: "A", labelJa: "<b>x</b>", confPct: 61 } }).includes("<b>x</b>"));
  });
  await t("サーバーが返しうる「ランク無し」の理由は、すべて辞書に訳がある", () => {
    const tiersSrc = fs.readFileSync(path.join(SERVER_DIR, "learning/confidenceTiers.js"), "utf8");
    const reasons = [...tiersSrc.matchAll(/eligible: false, reasonJa: "([^"]+)"/g)].map((m) => m[1]).filter((r) => r !== "予想の記録がありません。");
    const fallback = (tiersSrc.match(/reasonJa: st\.reasonJa \|\| "([^"]+)"/) || [])[1];
    assert.ok(reasons.length === 3 && fallback, JSON.stringify([reasons, fallback]));
    for (const r of [...reasons, fallback]) assert.ok(html.includes(`    "${r}": ["`), "辞書に無い: " + r);
  });

  console.log("■ 4. 予想カード: 要点だけを見せ、根拠はたたむ");
  await t("決め手ひとこと・注意(引き分け/範囲外/直前情報の変化)は、当てはまるときだけ出す", () => {
    assert.strictEqual(strip(api.predReasonLineHtml(P_BASE)), "💡 決め手: 直近フォーム");
    assert.strictEqual(api.predReasonLineHtml({ ...P_BASE, topFactorJa: null }), "");
    assert.strictEqual(api.predAlertsHtml(P_BASE), "");
    assert.strictEqual(strip(api.predAlertsHtml({ ...P_BASE, probs: { homeWinPct: 40, drawPct: 31, awayWinPct: 29 } })), "⚖️ 引き分け注意 31%");
    assert.strictEqual(api.predAlertsHtml({ ...P_BASE, predictedWinner: "draw", probs: { homeWinPct: 30, drawPct: 40, awayWinPct: 30 } }), "", "引き分け予想に引き分け注意を出している");
    assert.strictEqual(strip(api.predAlertsHtml({ ...P_BASE, confidence: { ...P_BASE.confidence, outOfRange: true } })), "⚠️ 確率は割り引いて見てください");
    assert.strictEqual(strip(api.predAlertsHtml({ ...P_BASE, preKick: { confirmed: true, blended: { predictedWinner: "away", changedFromMorning: true, probsPct: { homeWinPct: 30, drawPct: 30, awayWinPct: 40 } } } })), "⚡ 直前情報 → Chelsea 勝利 40% (朝から変化)");
    assert.strictEqual(strip(api.predAlertsHtml({ ...P_BASE, preKick: { confirmed: false, blended: { predictedWinner: "draw", changedFromMorning: true, probsPct: { homeWinPct: 33, drawPct: 35, awayWinPct: 32 } } } })), "⚡ 直前情報 → 引き分け 35% (朝から変化)");
    assert.strictEqual(strip(api.predAlertsHtml({ ...P_BASE, preKick: { blended: { changedFromMorning: true } } })), "⚡ 直前情報 (朝から変化)");
    assert.strictEqual(api.predAlertsHtml({ ...P_BASE, preKick: { confirmed: true, blended: { predictedWinner: "home", changedFromMorning: false, probsPct: { homeWinPct: 60, drawPct: 20, awayWinPct: 20 } } } }), "");
  });
  await t("「🔎 根拠をくわしく見る」は既定で閉じていて、これまでカードに出していた行が全部入っている(消していない)", () => {
    const p = {
      ...P_BASE, tier: tier("A"), similarPastJa: "似た試合の実績: ホーム勝ち3", market: { edgePt: 4.5 }, blend: { marketPct: 60, aiPct: 40 },
      basis: { used: [{ labelJa: "直近フォーム" }], missing: [] }, loggedAt: "2026-11-15T19:00:00Z",
      preKick: { confirmed: true, blended: { predictedWinner: "home", changedFromMorning: false, probsPct: { homeWinPct: 62, drawPct: 20, awayWinPct: 18 } } },
      scenarios: [{ scoreline: "2-1", pct: 11 }], derived: { bttsPct: 55, over25Pct: 58, homeCleanSheetPct: 30, awayCleanSheetPct: 15 },
    };
    const h = api.predDetailsHtml(p, '<div class="pred-actions">ボタン</div>', "hero:501");
    assert.ok(/^<details class="pred-more" data-pred-key="hero:501"><summary>/.test(h), h.slice(0, 120));
    assert.ok(!/<details class="pred-more"[^>]* open/.test(h), "既定で開いている");
    const txt = strip(h);
    for (const part of ["🔎 根拠をくわしく見る", "根拠(最重要要素): 直近フォーム ・ 学習v12の重みで予測", "🏅 自信ランク A(有力)", "このランクの実績: 66.7%", "🎚️ 確信度(実績で補正): 63%", "🧮 根拠スコア: 直近フォーム★★★★", "📦 使えたデータ: 直近フォーム", "📚 似た試合の実績: ホーム勝ち3", "🏦 市場(オッズ)比較: AIは市場より強気(+4.5pt)", "⚖️ この予想の判定: 市場60%+AI40%の合成", "⚡ 直前情報(スタメン確定)", "スコアの可能性(上位5件): 2-1 11%", "両チーム得点 55%", "🕓 予想生成:", "ボタン"]) {
      assert.ok(txt.includes(part), "たたんだ根拠に無い: " + part + " ← " + txt.slice(0, 400));
    }
    // 学習していない大会の断りも中に残る
    assert.ok(strip(api.predDetailsHtml({ ...P_BASE, learnedCompetition: false, tier: { rank: null, reasonJa: "x" } }, "", "hero:9")).includes("この大会はAIがまだ学習していません(参考予想)"));
  });
  await t("開いた「くわしく見る」は、カードを描き直しても開いたまま(対決で予想を選んだあとなど)", () => {
    api.predOpenDetails.add("hero:501");
    assert.ok(/<details class="pred-more" data-pred-key="hero:501" open>/.test(api.predDetailsHtml({ ...P_BASE, tier: tier("A") }, "", "hero:501")));
    assert.ok(!/ open>/.test(api.predDetailsHtml({ ...P_BASE, tier: tier("A") }, "", "hero:502")));
    api.predOpenDetails.delete("hero:501");
    assert.ok(html.includes('document.addEventListener("toggle", (ev) => {') && html.includes('if (d.matches("details.pred-more[data-pred-key]"))') && /\}, true\);/.test(html.slice(html.indexOf('document.addEventListener("toggle", (ev) => {'), html.indexOf('document.addEventListener("toggle", (ev) => {') + 700)), "開閉の記憶(toggle の捕捉)が無い");
  });
  await t("ホームの予想カード1件の並び: [ベストの帯] → 自信ランクの帯 → 対戦 → AIの予想 → 勝率の帯 → 決め手 → 注意 → くわしく見る", () => {
    const start = html.indexOf("  const rowHtml = (p, opts) => {");
    const body = html.slice(start, html.indexOf("  // 共有画像はこの一覧のデータから描くため、描画前に持っておく", start));
    assert.ok(start > 0 && body.length > 500);
    const order = ["${bestRibbon}${predRankBandHtml(p)}", '<div class="pred-title">', '<div class="pred-meta">', '<div class="pred-pick">🤖 AIの予想:', "${duelMyPickLineHtml(p)}", "${predBarHtml(p)}", "${predReasonLineHtml(p)}", "${predAlertsHtml(p)}", "${predDetailsHtml(p, actionsHtml,"];
    let pos = body.indexOf("return `\n      <div class=\"${itemCls}\">");
    assert.ok(pos > 0, "1件の描き方が見つからない");
    for (const part of order) { const i = body.indexOf(part, pos); assert.ok(i > pos, "順番が違う/無い: " + part); pos = i; }
    // 根拠の行は、カードの表(常に見える場所)には直接書かない
    const visible = body.slice(body.indexOf("return `\n      <div class=\"${itemCls}\">"));
    for (const hidden of ["predTierLineHtml(p)", "predConfidenceLineHtml(p)", "predFactorsLineHtml(p)", "predBasisLineHtml(p)", "predBlendLineHtml(p)", "predScenarioLineHtml(p)", "predFreshnessLineHtml(p)", "predTierChipHtml(p)"]) assert.ok(!visible.includes(hidden), "常に見える場所に根拠の行がある: " + hidden);
    // 対決で伏せているあいだは、AIの予想も自信ランクも出さない
    const duelBranch = body.slice(body.indexOf("if (duelModeOn()"), body.indexOf("const scoreStr"));
    assert.ok(duelBranch.includes("duelPickRowHtml(") && !duelBranch.includes("predRankBandHtml"), "伏せているのに自信ランクを出している");
  });
  await t("詳細画面の予想ブロックも同じ並び(帯 → 予想 → 勝率の帯 → 決め手 → 注意 → くわしく見る)", () => {
    const h = api.predictionSummaryBlockHtml({ ...P_BASE, tier: tier("S"), resolved: true, correct: true }, "🤖 試合前のAIの予想");
    const idx = ['class="rank-band rank-s"', "🤖 試合前のAIの予想", "的中", 'class="pred-reason"', '<details class="pred-more" data-pred-key="detail:501">'].map((s) => h.indexOf(s));
    assert.ok(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), JSON.stringify(idx));
    assert.strictEqual(api.predictionSummaryBlockHtml(null), "");
  });
  await t("一覧の行の小さな印は「ランク S」(文字1つだけにしない)。見送りはそのまま", () => {
    assert.strictEqual(strip(api.predTierChipHtml({ tier: tier("S") })), "ランク S");
    assert.strictEqual(strip(api.predTierChipHtml({ tier: tier("skip") })), "見送り");
    assert.strictEqual(api.predTierChipHtml({ tier: { rank: null } }), "");
  });
  await t("対決の盤面: 常に見せるのは戦績の1行。シェア・全国ランキング・OFF は「対決のメニュー」にたたむ(開閉は覚える)", () => {
    const h = api.duelScoreboardHtml();
    assert.ok(/<details id="duelMenu" style="margin-top:4px;">/.test(h), h.slice(0, 300));
    const menu = h.slice(h.indexOf("<details id=\"duelMenu\""), h.indexOf("</details>"));
    for (const id of ["duelShareBtn", "duelModeOffBtn", "duelLbToggleBtn", "duelJoinForm", "duelLbView"]) assert.ok(menu.includes(`id="${id}"`), "メニューの中に無い: " + id);
    assert.ok(strip(h.slice(0, h.indexOf("<details id=\"duelMenu\""))).includes("AIと予想対決"));
    api.setDuelMenuOpen(true);
    assert.ok(/<details id="duelMenu" style="margin-top:4px;" open>/.test(api.duelScoreboardHtml()));
    api.setDuelMenuOpen(false);
  });

  console.log("■ 5. たためるカード(本日の実際の試合・今週のAIダイジェスト・今日のサッカー)");
  await t("3枚とも見出しがボタン(aria-expanded / aria-controls)。試合一覧とダイジェストは既定で閉じ、今日のサッカーは開く", () => {
    for (const [id, key, dflt, bodyId] of [["digestCard", "digest", "closed", "digestFoldBody"], ["realFixturesCard", "fixtures", "closed", "realFixturesFoldBody"], ["dashboardCard", "dashboard", "open", "dashboardFoldBody"]]) {
      const m = html.match(new RegExp(`<div class="card fold-card" id="${id}" data-fold="${key}" data-fold-default="${dflt}"[^>]*>\\s*<h2 class="fold-h"><button type="button" class="fold-btn" id="[A-Za-z]+" aria-expanded="(true|false)" aria-controls="${bodyId}">`));
      assert.ok(m, "見出しの形が違う: " + id);
      assert.strictEqual(m[1], dflt === "open" ? "true" : "false");
      assert.ok(new RegExp(`<div class="fold-body" id="${bodyId}"${dflt === "open" ? "" : " hidden"}>`).test(html), "中身の最初の状態が違う: " + id);
    }
    // 試合一覧の検索欄・一覧は、たたむ中身の中にある
    const fx = html.slice(html.indexOf('<div class="fold-body" id="realFixturesFoldBody"'), html.indexOf('<div id="realFixtureAnalysisWrap">'));
    assert.ok(fx.includes('id="fixtureSearchInput"') && fx.includes('id="fixturesContextNote"') && fx.includes('id="realFixturesList"'));
  });
  await t("開閉: 見出しを押すと切り替わり、表示(▼ 開く / ▲ 閉じる)・aria・端末への保存が合う", () => {
    const { api: a, dom, storage } = loadApp();
    const fx = dom.get("realFixturesCard"), dg = dom.get("digestCard"), db = dom.get("dashboardCard");
    assert.deepStrictEqual([fx._body.hidden, dg._body.hidden, db._body.hidden], [true, true, false], "最初の状態");
    assert.deepStrictEqual([fx._chev.textContent, db._chev.textContent], ["▼ 開く", "▲ 閉じる"]);
    assert.strictEqual(storage.getItem(a.FOLD_STATE_KEY), null, "最初の状態を反映しただけで保存している");
    fx._btn.dispatch("click");
    assert.strictEqual(fx._body.hidden, false); assert.strictEqual(fx._btn.getAttribute("aria-expanded"), "true"); assert.strictEqual(fx._chev.textContent, "▲ 閉じる"); assert.ok(fx.classList.contains("is-open"));
    assert.deepStrictEqual(JSON.parse(storage.getItem(a.FOLD_STATE_KEY)), { fixtures: "open" });
    fx._btn.dispatch("click");
    assert.strictEqual(fx._body.hidden, true); assert.deepStrictEqual(JSON.parse(storage.getItem(a.FOLD_STATE_KEY)), { fixtures: "closed" });
    db._btn.dispatch("click");
    assert.deepStrictEqual(JSON.parse(storage.getItem(a.FOLD_STATE_KEY)), { fixtures: "closed", dashboard: "closed" });
  });
  await t("前回の開閉を覚えている。保存できない端末・壊れた保存値でも既定どおり動く", () => {
    const saved = loadApp({ storage: { homeFoldState: JSON.stringify({ fixtures: "open", dashboard: "closed", digest: "???" }) } });
    assert.deepStrictEqual([saved.dom.get("realFixturesCard")._body.hidden, saved.dom.get("dashboardCard")._body.hidden, saved.dom.get("digestCard")._body.hidden], [false, true, true]);
    const broken = loadApp({ storage: { homeFoldState: "{not json" } });
    assert.deepStrictEqual([broken.dom.get("realFixturesCard")._body.hidden, broken.dom.get("dashboardCard")._body.hidden], [true, false]);
    // localStorage が例外を投げる端末(プライベートモードなど)
    const scripts = []; const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m; while ((m = re.exec(html)) !== null) scripts.push(m[1]);
    const code = scripts.reduce((x, y) => (y.length >= x.length ? y : x), "") + "\nreturn { setFoldOpen };";
    const dom = buildDom();
    const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} };
    const w = { navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {}, location: { hash: "", origin: "http://x", pathname: "/" } };
    const app = new Function("document", "window", "navigator", "fetch", "localStorage", "location", code)(dom.document, w, w.navigator, async () => { throw new Error("no network"); }, throwing, w.location);
    const fx = dom.get("realFixturesCard");
    assert.strictEqual(fx._body.hidden, true);
    app.setFoldOpen(fx, true);
    assert.strictEqual(fx._body.hidden, false, "保存できない端末で開閉が動かない");
  });
  await t("試合一覧の見出しの要約: 試合中・これから・終了の件数(0件の区分は出さない)", () => {
    const { api: a, dom } = loadApp();
    a.setFixturesFoldMeta([{ status: "1H" }, { status: "NS" }, { status: "NS" }, { status: "FT" }, { status: "FT" }, { status: "FT" }, { status: "PST" }]);
    assert.strictEqual(strip(dom.get("realFixturesFoldMeta").innerHTML), "🔴 試合中 1 ・ ⏰ これから 2 ・ ✅ 終了 3 ・ ℹ️ その他 1");
    a.setFixturesFoldMeta([{ status: "FT" }]);
    assert.strictEqual(strip(dom.get("realFixturesFoldMeta").innerHTML), "✅ 終了 1");
    a.setFixturesFoldMeta(null);
    assert.strictEqual(dom.get("realFixturesFoldMeta").innerHTML, "");
    assert.ok(html.includes("setFixturesFoldMeta(lastFixturesToday);") && html.includes("⚠️ <span>試合一覧を取得できませんでした</span>"));
  });
  await t("予想カードの「📡 試合の詳しい分析を見る」は、試合一覧が出ているあいだだけ見せ、押すと一覧を開いてから動く", () => {
    const { api: a, dom } = loadApp();
    const btn = dom.get("jumpToFixturesBtn"); btn.style.display = "none";
    a.syncFixturesJumpUi(); assert.strictEqual(btn.style.display, "none");
    dom.get("realFixturesCard").style.display = "block";
    a.syncFixturesJumpUi(); assert.strictEqual(btn.style.display, "inline-block");
    assert.ok(html.includes('if (c && c.style.display !== "none") { setFoldOpen(c, true); c.scrollIntoView({ behavior: "smooth" }); }'));
    assert.ok(!html.includes("本日の実際の試合一覧は、データ連携サーバーに接続できたときに表示されます。</span>"), "事実と違う注記が残っている");
    assert.ok((html.match(/syncFixturesJumpUi\(\);/g) || []).length >= 3, "試合一覧の描画の各経路で合わせていない");
  });

  console.log("■ 6. ホームの的中率カード(このAI自身の実測を1行で)");
  await t("見出しは反省タブと同じ数字。読み込み中・まだ無い・取得できない、を言い分ける", () => {
    const { api: a } = loadApp();
    assert.strictEqual(strip(a.accuracyHeadlineHtml()), "🎯 このAIの的中率(実測)読み込み中…");
    a.setRefl({ hitRatePct: 60.6, hits: 117, n: 193, scope: "learned" }, "ok");
    assert.strictEqual(strip(a.accuracyHeadlineHtml()), "🎯 このAIの的中率(実測): 60.6%193件中117件的中 ・ 学習した大会の公式戦");
    a.setRefl({ hitRatePct: 54.7, hits: 162, n: 296, scope: "official" }, "ok");
    assert.ok(strip(a.accuracyHeadlineHtml()).endsWith("296件中162件的中 ・ 公式戦"));
    a.setRefl(null, "none"); assert.strictEqual(strip(a.accuracyHeadlineHtml()), "🎯 このAIの的中率(実測)答え合わせが済んだ公式戦がまだありません");
    a.setRefl(null, "failed"); assert.strictEqual(strip(a.accuracyHeadlineHtml()), "🎯 このAIの的中率(実測)取得できませんでした");
  });
  await t("API-Football の予測の的中率と運用の内訳は「詳しく見る」の中(外部の予測であることを明記)。見出しには出さない", async () => {
    const stats = { configured: true, total: 3601, resolved: 3460, correct: 1729, accuracyPct: 50, since: "2026-07-31T14:23:08.118Z", pending: 18, pendingDetail: { awaitingKickoff: 9, dueForCheck: 9 }, hoursSinceLastResolved: 0, hoursSinceLastAutoCollect: 0, stalledReasonJa: "理由の文", noteJa: "この正答率は API-Football が提供する予測の的中率です(自社モデルの実力ではありません)。", recent: [{ home: "A", away: "B", predictedWinner: "home", actualWinner: "home", correct: true }] };
    const fetchStub = async (url) => { if (String(url).includes("/accuracy-stats")) return { ok: true, status: 200, json: async () => stats, text: async () => JSON.stringify(stats) }; throw new Error("no network"); };
    const { api: a, dom } = loadApp({ fetch: fetchStub });
    a.setRefl({ hitRatePct: 60.6, hits: 117, n: 193, scope: "learned" }, "ok");
    await a.renderAiAccuracyWidget();
    const summary = strip(dom.get("aiAccuracySummary").innerHTML);
    assert.ok(summary.startsWith("🎯 このAIの的中率(実測): 60.6%") && summary.endsWith("詳しく見る ▼"), summary);
    assert.ok(!/API-Football|50%|答え合わせ待ち|記録開始/.test(summary), "見出しに外部の予測の数字や運用の内訳が出ている: " + summary);
    const details = strip(dom.get("aiAccuracyDetails").innerHTML);
    for (const part of ["🙈 このAI自身の採点記録(外れも含む全試合)を見る", "📎 比較用: 外部の予測(API-Football)の記録", "🤖 AI予測の正答率: 50%", "(1729/3460件的中)", "自社モデルの実力ではありません", "記録開始: 2026年7月31日", "答え合わせ待ち 18件", "🔎 理由の文", "✅ A vs B"]) assert.ok(details.includes(part), "詳しく見るの中に無い: " + part + " ← " + details.slice(0, 300));
    // 後から反省の数字が届いても見出しが書き換わる
    a.setRefl({ hitRatePct: 61.1, hits: 118, n: 193, scope: "learned" }, "ok");
    dom.get("aiAccuracyHeadline").innerHTML = ""; a.applyReflHeadlineToAccuracyCard();
    assert.ok(strip(dom.get("aiAccuracyHeadline").innerHTML).includes("61.1%"));
  });
  await t("外部の予測の記録が読めないときも、見出し(このAI自身の実測)は出し、状態は「詳しく見る」の中で正直に伝える", async () => {
    const { api: a, dom } = loadApp(); // fetch は必ず失敗
    a.setRefl({ hitRatePct: 60.6, hits: 117, n: 193, scope: "learned" }, "ok");
    await a.renderAiAccuracyWidget();
    assert.ok(strip(dom.get("aiAccuracySummary").innerHTML).startsWith("🎯 このAIの的中率(実測): 60.6%"));
    assert.ok(strip(dom.get("aiAccuracyDetails").innerHTML).includes("実績データを取得できませんでした"));
    assert.ok(/let reflHeadlineForHero = null;\nlet reflHeadlineState = "loading";[^\n]*\nasync function renderAiAccuracyWidget\(\)/.test(html), "宣言が最初に使う場所の前に無い(読み込み順のエラーの再発防止)");
  });

  console.log("■ 7. 今日のサッカー・おすすめ質問(仮の対戦を含まない)");
  await t("AIおすすめ質問に仮の対戦(日替わりの組み合わせ)が入らない。今日のサッカーは注目選手・豆知識・急上昇(+見たものがあるときだけ「最近見た」)", () => {
    const { api: a, dom } = loadApp();
    const qs = a.buildRecommendedHeroQuestions();
    assert.ok(qs.length >= 2 && qs.includes("今日見るべき試合は？") && !qs.some((q) => /どっちが勝つ/.test(q)), JSON.stringify(qs));
    a.renderDashboard();
    assert.ok(dom.get("dashFeaturedPlayer").innerHTML.includes("詳しく見る") && dom.get("dashTrivia").innerHTML.includes("💡") && dom.get("dashTrending").innerHTML.length > 50);
    // 「最近見た選手・試合」は、見たものがあるときだけ欄ごと出す(空のときは場所を取らない)。中の「▼ もっと見る」は無くした
    assert.strictEqual(dom.get("dashRecentlyViewed").innerHTML, ""); assert.strictEqual(dom.get("dashRecentWrap").style.display, "none");
    assert.ok(!html.includes('id="dashMoreToggleBtn"') && !html.includes('id="dashMoreDetails"') && html.includes('<div id="dashRecentWrap" style="display:none; margin-top:16px;">'));
    assert.ok(/if \(wrap\) wrap\.style\.display = parts\.length \? "block" : "none";/.test(html));
    assert.strictEqual(a.teamAvg([], "overall"), null);
  });

  console.log("■ 8. 辞書(EN/ZH/ES)・キャッシュの版");
  await t("新しい文言はすべて EN/ZH/ES の訳がある(英語・スペイン語に日本語が残らず、中国語にかなが残らない)", () => {
    const start = html.indexOf("/* ==== v104.2(2026年11月15日): 見やすさの整理");
    const part = html.slice(start, html.indexOf("/* ==== v104.1(2026年11月14日)", start));
    assert.ok(start > 0 && part.length > 1500);
    const rows = [...part.matchAll(/^\s*("(?:[^"\\]|\\.)*"):\s*\[("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\],?\s*$/gm)].map((m) => m.slice(1, 5).map((x) => JSON.parse(x)));
    assert.ok(rows.length >= 28, "行数: " + rows.length);
    for (const [ja, en, zh, es] of rows) {
      assert.ok(en && zh && es, "空の訳: " + ja);
      for (const tr of [en, es]) assert.ok(!/[ぁ-んァ-ヶ一-龥]/.test(tr), "英語・スペイン語の訳に日本語が残っている: " + ja + " → " + tr);
      assert.ok(!/[ぁ-んァ-ヶ]/.test(zh), "中国語の訳にかなが残っている: " + ja + " → " + zh);
    }
    const keys = new Set(rows.map((r) => r[0]));
    for (const k of ["▼ 開く", "試合中", "これから", "試合一覧を取得できませんでした", "📂 もっと見る", "見たい項目を押すと、この下に開きます(もう一度押すと閉じます)。", "対象外", "自信", "自信が低い試合", "決め手", "確率は割り引いて見てください", "根拠をくわしく見る", "対決のメニュー(シェア・全国ランキング・OFF)", "🎯 このAIの的中率を読み込み中…", "このAIの的中率(実測)", "学習した大会の公式戦", "公式戦", "答え合わせが済んだ公式戦がまだありません", "🙈 このAI自身の採点記録(外れも含む全試合)を見る", "比較用: 外部の予測(API-Football)の記録", "UEFAクラブランキング", "ポジション未取得", "今日ピックアップされた注目の選手と豆知識です(登録データから毎日自動で選出)。", "API-Footballから取得した本日の試合です。各試合のボタンを押すと、試合前はAIの見どころ、終了後は答え合わせを見られます。"]) {
      assert.ok(keys.has(k), "辞書に無い: " + k);
      assert.ok(html.replace(part, "").includes(k.replace(/^[🎯🙈📂▼] ?/u, "")), "辞書にあるが画面で使っていない: " + k);
    }
    // 既存の訳を使い回している語(「▲ 閉じる」「終了」「その他」「ランク」「引き分け注意」)が辞書にある
    for (const k of ["▲ 閉じる", "終了", "その他", "ランク", "引き分け注意", "自信ランク", "🎯 今日のベスト予想", "直前情報", "(朝から変化)"]) assert.ok(html.includes(`    "${k}": ["`), "辞書に無い: " + k);
  });
  await t("総点検で見つけた以前からの日本語漏れ: 選手検索の「クラブの所属選手」は、部品ごとに分けて訳せる形にした", () => {
    // 以前は「索引にあるこのクラブの選手: 18人 / UEFAクラブランキング 49位 / イングランド」「GK(ゴールキーパー)(2人)」
    // 「#1 19歳 評価 7.23」を1つの文字列で書いていたため、日本語以外の画面でまるごと日本語のまま残っていた。
    assert.ok(html.includes('<span>索引にあるこのクラブの選手:</span> <span>${psEsc(data.count)}人</span>${club.rank ? ` / <span>UEFAクラブランキング</span> <span>${psEsc(club.rank)}位</span>` : ""}${club.country ? ` / <span>${psEsc(club.country)}</span>` : ""}'));
    assert.ok(html.includes('<h3 class="sim-subhead"><span>${psEsc(labels[code] || code)}</span>(<span>${list.length}人</span>)</h3>'));
    assert.ok(html.includes('<span>評価</span> ${psNum(p.rating, "", 2)}${p.injured ? " / <span>負傷者リスト</span>" : ""}'));
    assert.ok(html.includes('<span>ポジション未取得</span>(<span>${unknown.length}人</span>)'));
    // 部品の訳(完全一致・型)が辞書にある
    for (const k of ['    "索引にあるこのクラブの選手:": ["', '    "評価": ["', '    "負傷者リスト": ["', '    "GK(ゴールキーパー)": ["', '    "DF(ディフェンダー)": ["', '    "MF(ミッドフィールダー)": ["', '    "FW(フォワード)": ["', '    "UEFAクラブランキング": ["', '    "ポジション未取得": ["', '    ["⦿人", "', '    ["⦿歳", "', '    ["⦿位", "']) assert.ok(html.includes(k), "辞書に無い: " + k);
  });
  await t("sw.js の版を進めた(古い画面が端末に残らないように)", () => {
    const sw = fs.readFileSync(path.join(SERVER_DIR, "sw.js"), "utf8");
    assert.ok(/CACHE_NAME = "soccer-ai-shell-v1042"/.test(sw), sw.slice(0, 600));
  });

  console.log("■ 9. 写真を見直して直した細かな点(「もっと見る」の並び・狭い画面のはみ出し・「賢くなったか」の見出し)");
  await t("「もっと見る」の4つは均等な格子(スマホは2列×2段・広い画面は4列)で、押しやすい高さ(44px 以上)にする", () => {
    assert.ok(/#modeSwitch \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*width: 100%;[^}]*\}/.test(html), "格子の指定が無い");
    assert.ok(/#modeSwitch button \{[^}]*white-space: normal;[^}]*min-height: 44px;[^}]*\}/.test(html), "ボタンの高さ・折り返しの指定が無い");
    assert.ok(/@media \(max-width: 640px\) \{ #modeSwitch \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/.test(html), "スマホ幅の2列の指定が無い");
    // 置き場そのもの(4つのボタン・見出し)は変えていない
    assert.ok(html.includes('<div class="segmented" id="modeSwitch" style="margin-bottom:16px; flex-wrap:wrap;">'));
  });
  await t("質問の入力欄は縮められる(幅320pxの画面で、ボタンの文字が長い言語でも行が右へはみ出さない)", () => {
    assert.ok(/\.chat-input-row input \{ flex: 1 1 0; min-width: 0;/.test(html), "入力欄に min-width:0 が無い");
    assert.ok(/\.chat-input-row button \{ flex: 0 0 auto; white-space: nowrap; \}/.test(html), "ボタンを縮めない指定が無い");
  });
  const smarterWith = async (diff) => {
    const payload = { available: true, dateKey: "2026-11-15", answers: { diff, items: [] }, learning: {}, growth: {} };
    const fetchStub = async (url) => { if (String(url).includes("/qa/latest")) return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }; throw new Error("no network"); };
    const { api: a, dom } = loadApp({ fetch: fetchStub });
    await a.renderSmarterCard();
    return dom.get("smarterBody").innerHTML;
  };
  const headlineOf = (h) => strip((h.match(/<div class="smarter-headline"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "");
  const subsOf = (h) => [...h.matchAll(/<div class="smarter-sub"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => strip(m[1]));
  await t("「賢くなったか」の見出し: 新しく言えることがある日は、これまでと同じ文と補足", async () => {
    const h = await smarterWith({ grew: true, hasYesterday: true, newFactTotal: 66, changedFactTotal: 57, lostFactTotal: 0, newlyAnswerableCount: 5, items: [] });
    assert.strictEqual(headlineOf(h), "はい。昨日は言えなかったことを 66件 言えるようになりました。");
    assert.deepStrictEqual(subsOf(h).slice(0, 2), ["そのうち 5問 は、昨日はまったく答えられなかった質問です。", "さらに 57件 の数字が新しくなりました。"]);
  });
  await t("数字が新しくなっただけの日(新しく言えることは0件)に「はい。…0件 言えるようになりました」と書かない", async () => {
    const h = await smarterWith({ grew: true, hasYesterday: true, newFactTotal: 0, changedFactTotal: 146, lostFactTotal: 0, newlyAnswerableCount: 0, items: [] });
    assert.strictEqual(headlineOf(h), "はい。146件 の数字が新しくなりました(新しく言えるようになったことは 0件)。");
    assert.ok(!/0件 言えるようになりました/.test(strip(h)), "食い違う文が残っている");
    assert.ok(!subsOf(h).some((x) => /さらに 146件/.test(x)), "見出しと同じことを補足で繰り返している: " + JSON.stringify(subsOf(h)));
    // 新しく答えられた質問だけがある日 / 内訳の数が無い応答(古い形)でも、食い違う文にならない
    const h2 = await smarterWith({ grew: true, hasYesterday: true, newFactTotal: 0, changedFactTotal: 0, lostFactTotal: 0, newlyAnswerableCount: 2, items: [] });
    assert.strictEqual(headlineOf(h2), "はい。昨日はまったく答えられなかった質問に 2問 答えられるようになりました。");
    assert.ok(!subsOf(h2).some((x) => /そのうち/.test(x)), JSON.stringify(subsOf(h2)));
    const h3 = await smarterWith({ grew: true, hasYesterday: true, items: [] });
    assert.strictEqual(headlineOf(h3), "はい。昨日より答えられることが増えました。");
  });
  await t("増えていない日・比べられない日の見出しは変えていない。減ったことは必ず併記する", async () => {
    const no = await smarterWith({ grew: false, hasYesterday: true, newFactTotal: 0, changedFactTotal: 0, lostFactTotal: 3, newlyAnswerableCount: 0, items: [] });
    assert.strictEqual(headlineOf(no), "いいえ。昨日から言えることが増えていません。");
    assert.ok(subsOf(no).some((x) => x.includes("言えなくなったことが 3件")), JSON.stringify(subsOf(no)));
    const unk = await smarterWith({ grew: null, hasYesterday: false, items: [] });
    assert.strictEqual(headlineOf(unk), "まだ判定できません(昨日の記録がありません)。");
    const lost = await smarterWith({ grew: true, hasYesterday: true, newFactTotal: 0, changedFactTotal: 4, lostFactTotal: 2, newlyAnswerableCount: 0, items: [] });
    assert.ok(subsOf(lost).some((x) => x.includes("言えなくなったことが 2件")), JSON.stringify(subsOf(lost)));
  });
  await t("新しい見出しの文は EN/ZH/ES の訳(型2つ・完全一致1つ)がある", () => {
    for (const k of ['    ["はい。⦿件 の数字が新しくなりました(新しく言えるようになったことは 0件)。", "Yes. $1 figures were refreshed (0 new things it can say).", "', '    ["はい。昨日はまったく答えられなかった質問に ⦿問 答えられるようになりました。", "Yes. It can now answer $1 questions', '    "はい。昨日より答えられることが増えました。": ["Yes. It can answer more than it could yesterday.", "']) assert.ok(html.includes(k), "辞書に無い: " + k);
  });

  console.log(`\nv104.2 ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
