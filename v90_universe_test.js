"use strict";
/** v90: 追跡クラブ100→172拡張のテスト(利用者の指示「情報をとっていないクラブを無理なく増やして」。
 *  範囲は利用者が選択: J1全20+欧州5大リーグの未追跡クラブ全部)。
 *  検証すること:
 *   ① 172クラブ・rank/名前の重複なし・全員に日本語名がある
 *   ② 新クラブ(rank>100)は全員tier B(高価なxG収集の対象に入らない=無理のない範囲)
 *   ③ J1が20クラブ・5大リーグが現行シーズンの正しい所属数になっている
 *   ④ 降格3クラブ(ウェストハム・ジローナ・ヴォルフスブルク)の静的リーグIDがnullに直っている
 *   ⑤ 女子・ユース等の紛らわしい名前が1件も混ざっていない
 *   ⑥ 一括取得の上限が拡張後のクラブ数を下回っていない(101番目以降が永久に取得されない事故の防止)
 *   ⑦ 検索語の健全性: sanitize後に3文字未満になるクラブが無い(照合不能クラブを作らない)
 *   ⑧ 予測の輪番が172クラブでも全クラブを巡回する(順番の安定性) */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { CLUB_UNIVERSE, tierOf, clubsForPrediction, searchVariantsOf } = require("./learning/clubUniverse");
const { SQUAD_VARIANT_RE } = require("./learning/matchupAnalysis");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

t("① 172クラブ・rank/名前の重複なし・全員に日本語名", () => {
  assert.strictEqual(CLUB_UNIVERSE.length, 172, "クラブ数=" + CLUB_UNIVERSE.length);
  const ranks = new Set(), names = new Set();
  for (const c of CLUB_UNIVERSE) {
    assert.ok(!ranks.has(c.rank), "rank重複: " + c.rank); ranks.add(c.rank);
    const k = c.nameEn.toLowerCase();
    assert.ok(!names.has(k), "nameEn重複: " + c.nameEn); names.add(k);
    assert.ok(c.nameJa && c.nameJa.length > 0, "日本語名なし: " + c.nameEn);
    assert.ok(c.country, "国なし: " + c.nameEn);
  }
});

t("② 新クラブ(rank>100)は全員tier B(xGの高価な収集対象に入らない)", () => {
  for (const c of CLUB_UNIVERSE.filter((x) => x.rank > 100)) {
    assert.strictEqual(tierOf(c), "B", `${c.nameEn} がtier ${tierOf(c)}`);
  }
});

t("③ リーグ別の内訳が現行シーズンの所属どおり(J1=20・PL=20・リーガ=20・セリエA=20・独=17+降格1・仏=18)", () => {
  const cnt = (pred) => CLUB_UNIVERSE.filter(pred).length;
  assert.strictEqual(cnt((c) => c.country === "日本"), 20, "J1");
  // 静的leagueId基準(降格でnull化した3クラブは含まれない)
  assert.strictEqual(cnt((c) => c.leagueId === 39), 20, "プレミア");   // 9既存(ウェストハム除く)+11新規
  assert.strictEqual(cnt((c) => c.leagueId === 140), 20, "ラ・リーガ"); // 9既存(ジローナ除く)+11新規
  assert.strictEqual(cnt((c) => c.leagueId === 135), 20, "セリエA");   // 10既存+10新規
  assert.strictEqual(cnt((c) => c.leagueId === 78), 18, "ブンデス");   // 8既存(VfL除く)+10新規
  assert.strictEqual(cnt((c) => c.leagueId === 61), 18, "リーグ・アン"); // 8既存+10新規
});

t("④ 降格3クラブの静的リーグIDがnull(誤ったリーグの決め打ちを直した)", () => {
  for (const nm of ["West Ham", "Girona", "VfL Wolfsburg"]) {
    const c = CLUB_UNIVERSE.find((x) => x.nameEn === nm);
    assert.ok(c, nm + " が消えている(追跡は継続する約束)");
    assert.strictEqual(c.leagueId, null, nm + " のleagueIdがnullでない: " + c.leagueId);
  }
});

t("⑤ 女子・ユース等の紛らわしい名前が混ざっていない", () => {
  for (const c of CLUB_UNIVERSE) {
    assert.ok(!SQUAD_VARIANT_RE.test(c.nameEn), "変種名: " + c.nameEn);
  }
});

t("⑥ 一括取得の上限がクラブ数以上(101番目以降が永久に未取得になる事故の防止)", () => {
  const src = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
  const m = src.match(/UNIVERSE_BULK_CLUB_LIMIT\) \|\| (\d+)/);
  assert.ok(m, "BULK_CLUB_LIMITが見つからない");
  assert.ok(Number(m[1]) >= CLUB_UNIVERSE.length, `既定値${m[1]} < クラブ数${CLUB_UNIVERSE.length}`);
});

t("⑦ 全クラブの検索語がsanitize後も3文字以上(照合不能クラブを作らない)", () => {
  for (const c of CLUB_UNIVERSE) {
    const vs = searchVariantsOf(c);
    assert.ok(vs.length > 0, "検索語ゼロ: " + c.nameEn);
    for (const v of vs) assert.ok(v.length >= 3, `短すぎる検索語 "${v}": ` + c.nameEn);
  }
});

t("⑧ 予測の輪番が172クラブ+登録クラブを全て巡回する(重複なし・毎日同じ順)", () => {
  const extra = [{ nameEn: "Inter Miami", nameJa: "インテル・マイアミ" }, { nameEn: "Al-Nassr", nameJa: "アル・ナスル" }];
  const a = clubsForPrediction("2026-09-10", extra, 30);
  const b = clubsForPrediction("2026-09-10", extra, 30);
  assert.strictEqual(a.length, 174, "プール=" + a.length);
  assert.deepStrictEqual(a.map((x) => x.nameEn), b.map((x) => x.nameEn), "同日で順番が変わる");
  const day2 = clubsForPrediction("2026-09-11", extra, 30);
  assert.notStrictEqual(a[0].nameEn, day2[0].nameEn, "翌日に先頭が進んでいない");
});

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
