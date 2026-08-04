// 優先順位⑩: 最重要要因バナー・キャッシュ・ボタン文言の純粋関数レベル検証
const fs = require("fs");
const html = fs.readFileSync("/tmp/soccer-analysis-ai/index.html", "utf8");
let failures = 0;
const ok = (c, m) => { if (c) console.log("  [OK] " + m); else { console.error("FAIL: " + m); failures++; } };

// buildMostImportantFactorBanner を切り出して評価する
const start = html.indexOf("function buildMostImportantFactorBanner");
const end = html.indexOf("\n}", start) + 2;
const src = html.slice(start, end);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const buildMostImportantFactorBanner = eval("(" + src.replace("function buildMostImportantFactorBanner", "function") + ")");

ok(buildMostImportantFactorBanner(null) === "", "分析データが無ければバナーを出さない");
ok(buildMostImportantFactorBanner({}) === "", "予測データが無ければバナーを出さない(でっち上げない)");
const b1 = buildMostImportantFactorBanner({ prediction: { mostImportantFactor: "怪我人" } });
ok(b1.includes("AIが今回もっとも重要だと判断した要因"), "見出しが出る");
ok(b1.includes("怪我人"), "要因名が出る");
const b2 = buildMostImportantFactorBanner({ prediction: { keyFactors: [{ labelJa: "直近フォーム", stars: 2, starsDisplay: "★★" }, { labelJa: "xG", stars: 5, starsDisplay: "★★★★★" }] } });
ok(b2.includes("xG"), "keyFactorsからは★が最大のものを選ぶ");
ok(b2.includes("★★★★★"), "重要度も併記する");
const b3 = buildMostImportantFactorBanner({ prediction: { keyFactors: [{ labelJa: "直近フォーム", stars: 0 }] } });
ok(b3 === "", "まだ学習されていない(★0)要素を『最重要』として出さない");
const b4 = buildMostImportantFactorBanner({ prediction: { mostImportantFactor: "<script>x</script>" } });
ok(!b4.includes("<script>"), "HTMLエスケープされる");

// キャッシュTTLの設定確認
ok(/FIXTURE_ANALYSIS_TTL_MS\s*=\s*\{[^}]*live:\s*60 \* 1000/.test(html), "試合中は短いTTL(60秒)");
ok(/finished:\s*30 \* 60 \* 1000/.test(html), "終了後は長いTTL(30分)");
ok(html.includes("if (cached && cached.expiresAt > Date.now()) return cached.data;"), "キャッシュ有効時は通信しない");
ok(html.includes('${group === "finished" ? "答え合わせを見る ▶" : "AI分析を見る ▶"}'), "終了試合は「答え合わせを見る」に変わる");
ok(html.includes("buildMostImportantFactorBanner(analysis) + bodyHtml"), "バナーが本文より前に置かれる");

console.log(failures === 0 ? "\nPriority-10 frontend checks PASSED." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
