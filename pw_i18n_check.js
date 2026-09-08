/**
 * scripts/pw_i18n_check.js — v82多言語の「日本語漏れゼロ」実表示検査。
 *   EN/ZH/ES の各言語で全タブを実際に開き、見えているテキストノードに
 *   日本語が残っていないかを機械検査する(ZHは漢字を共有するため仮名のみ検査)。
 * 実行: 事前に `python3 -m http.server 8787` をルートで起動してから
 *       node scripts/pw_i18n_check.js
 * 意図した例外(検査から除外):
 *   ・言語セレクタの「🌐 日本語」「🌐 中文(简体)」(言語名の自己表記)
 *   ・input等の値(データ値は日本語のまま検索に使う設計。表示訳はpick時に適用)
 */
"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = (() => {
  if (fs.existsSync(path.join(__dirname, "..", "server", "server.js"))) return path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(__dirname, "server.js")) && fs.existsSync(path.join(__dirname, "learning"))) return __dirname;
  if (fs.existsSync(path.join(__dirname, "..", "server.js")) && fs.existsSync(path.join(__dirname, "..", "learning"))) return path.resolve(__dirname, "..");
  return path.resolve(__dirname, "..", "..");
})();

const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 400) : ""}`); };

(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const BASE = "http://127.0.0.1:8787/index.html";

  async function collectLeaks(lang) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript((lg) => { try { localStorage.setItem("appLang", lg); } catch (e) {} }, lang);
    let packStatus = null;
    page.on("response", (r) => { if (r.url().includes(`i18n.${lang}.json`)) packStatus = r.status(); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    // 全タブを順に開く(存在するボタンだけ・エラーは無視して続行)
    const tabs = await page.$$eval("#modeSwitch button", (bs) => bs.map((b) => b.dataset.mode).filter(Boolean)).catch(() => []);
    for (const mode of tabs) {
      await page.click(`#modeSwitch button[data-mode="${mode}"]`).catch(() => {});
      await page.waitForTimeout(1200);
      // details要素を全展開(推理・楽屋裏の折りたたみの中身も検査対象にする)
      await page.$$eval("details:not([open])", (ds) => ds.forEach((d) => { d.open = true; })).catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1500);
    const leaks = await page.evaluate((lg) => {
      const kanaRe = /[ぁ-んァ-ヶ]/;
      const jaRe = /[ぁ-んァ-ヶ一-龥]/;
      const re = lg === "zh" ? kanaRe : jaRe;
      const bad = new Map();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentElement;
        if (!p) continue;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") continue;
        // 非表示要素はスキップ(display:none配下)
        if (!p.offsetParent && getComputedStyle(p).position !== "fixed") continue;
        const s = (n.nodeValue || "").trim();
        if (!s || !re.test(s)) continue;
        // 意図した例外: 言語名の自己表記
        if (s === "🌐 日本語" || s === "🌐 中文(简体)" || s === "日本語" || s === "中文(简体)") continue;
        bad.set(s.slice(0, 120), (bad.get(s.slice(0, 120)) || 0) + 1);
      }
      return [...bad.entries()];
    }, lang);
    await ctx.close();
    return { leaks, packStatus };
  }

  for (const lang of ["en", "zh", "es"]) {
    const { leaks, packStatus } = await collectLeaks(lang);
    ck(`${lang}: 言語パック(i18n.${lang}.json)が読み込まれる`, packStatus === 200, `status=${packStatus}`);
    ck(`${lang}: 表示テキストに日本語${lang === "zh" ? "(仮名)" : ""}が残っていない — 漏れ${leaks.length}種`,
      leaks.length === 0,
      leaks.slice(0, 12).map(([s, c]) => `[×${c}] ${s}`).join(" | "));
    if (leaks.length) {
      fs.writeFileSync(path.join(__dirname, `i18n_leaks_${lang}.json`), JSON.stringify(leaks, null, 1));
      console.log(`    → 全${leaks.length}種を scripts/i18n_leaks_${lang}.json に保存`);
    }
  }

  // 日本語表示の無傷確認: ja では辞書もパックも一切適用されない(1ビットも変えない)
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem("appLang", "ja"); } catch (e) {} });
    const reqs = [];
    page.on("request", (r) => { if (r.url().includes("i18n.")) reqs.push(r.url()); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const heroJa = await page.$eval("h1, .hero, header", (el) => document.body.innerText.slice(0, 400)).catch(() => "");
    ck("ja: 言語パックを一切読み込まない(日本語利用者への影響ゼロ)", reqs.length === 0, JSON.stringify(reqs));
    ck("ja: 日本語表示が保たれている", /サッカー分析AI|予想/.test(heroJa), heroJa.slice(0, 80));
    await ctx.close();
  }

  await browser.close();
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
