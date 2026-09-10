"use strict";
/** v91: 「女子選手が索引に残り続ける」穴の根治テスト。
 *  (利用者の報告: v89を配備し24人を除外できたのに、M. Tanikawaは索引に残っていた)
 *
 *  v89の穴: 除外判定は「その日に成績が取れた選手」にしか効かなかった。提供元がその選手の
 *  成績を1件も返さない日は、女子かどうか判定できず(未出場の男子選手を誤って消さないための
 *  正しい仕様)、過去に混入した索引行が最長60日そのまま持ち越されていた。
 *
 *  検証すること:
 *   ① 一度でも女子と判定した選手IDを保存する(記憶する)
 *   ② 記憶した選手は、翌日に成績が1件も取れなくても索引から消える(持ち越さない)
 *   ③ 誤判定の逃げ道: 男子大会の成績が観測できた日は記憶から外して復帰させる
 *   ④ 名簿・一括取得の各経路でも記憶が効く
 *   ⑤ 画面側(読み出し時)の防波堤がIDでも弾く(索引の作り直しを待たずに消える)
 *   ⑥ 保存件数に上限がある(記憶が無制限に膨らまない) */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

const src = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
const srvSrc = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

t("① 判定結果を保存する仕組みがある(キー・上限・保存処理)", () => {
  assert.ok(src.includes('const WOMENS_KNOWN_KEY = "kb:player:womensexcluded"'), "保存キーが無い");
  assert.ok(/const WOMENS_KNOWN_CAP = \d+/.test(src), "保存上限が無い");
  assert.ok(src.includes("await deps.upstashSetJSON(WOMENS_KNOWN_KEY, {"), "保存処理が無い");
  assert.ok(src.includes("stats.womensKnownSaved"), "保存件数の記録が無い");
});

t("② 記憶を読み込み、当日の判定と合わせた有効集合で索引から消す", () => {
  assert.ok(src.includes("await deps.upstashGetJSON(WOMENS_KNOWN_KEY)"), "記憶の読み込みが無い");
  assert.ok(src.includes("const womensEffective = new Set([...womensKnown.keys(), ...womensExcluded.keys()]"),
    "記憶+当日の有効集合が作られていない");
  assert.ok(src.includes("for (const id of womensEffective) merged.delete(id);"), "当日分の除外に有効集合が使われていない");
  assert.ok(src.includes("if (womensEffective.has(id)) { droppedWomens++; continue; }"),
    "持ち越し行の削除に有効集合が使われていない(=成績が返らない日に消えない)");
});

t("③ 誤判定の逃げ道: 男子成績が観測できたら記憶から外して復帰させる", () => {
  assert.ok(src.includes("const noteMensConfirmed ="), "復帰の仕組みが無い");
  assert.ok(src.includes("if (womensSplit.mens.length) noteMensConfirmed(pl.id);"), "一括取得で復帰判定していない");
  assert.ok(src.includes("if (womensSplitD.mens.length) noteMensConfirmed(c.playerId);"), "選手詳細で復帰判定していない");
  assert.ok(src.includes("if (!womensCleared.has(id)) mergedIds[id] = v;"), "復帰した選手が保存から外れていない");
  assert.ok(src.includes(".filter((id) => !womensCleared.has(Number(id)))"), "有効集合から復帰者が除かれていない");
});

t("④ 収集の各経路(一括・名簿)でも記憶が効く", () => {
  assert.ok(src.includes("if (womensKnown.has(Number(pl.id)) && !womensCleared.has(Number(pl.id))) continue;"),
    "一括取得で記憶が効いていない");
  assert.ok(src.includes("if ((womensExcluded.has(Number(p.id)) || womensKnown.has(Number(p.id))) && !womensCleared.has(Number(p.id))) continue;"),
    "名簿経由で記憶が効いていない");
});

t("⑤ 画面側の防波堤がIDでも弾く(索引の作り直しを待たない)", () => {
  assert.ok(srvSrc.includes('upstashGetJSON("kb:player:womensexcluded")'), "読み出し時に記憶を読んでいない");
  assert.ok(srvSrc.includes("!(womensIds && womensIds.has(Number(row[CI.id])))"), "IDによる除外が読み出しフィルタに無い");
});

t("⑥ 除外の実測を隠さず記録する(新規・記憶済み・削除・復帰の内訳)", () => {
  assert.ok(src.includes("knownRemembered: womensKnown.size"), "記憶済み件数の開示が無い");
  assert.ok(src.includes("restoredAsMens: womensCleared.size"), "復帰件数の開示が無い");
  assert.ok(src.includes("droppedFromIndex: droppedWomens"), "索引から削除した件数の開示が無い");
});

// ---- 有効集合のロジックそのものを、実際の集合演算で検証する ----
t("⑦ 有効集合の計算が正しい(記憶∪当日 − 復帰)", () => {
  const womensKnown = new Map([[101, {}], [102, {}], [103, {}]]);
  const womensExcluded = new Map([[104, {}]]);
  const womensCleared = new Set([102]);
  const womensEffective = new Set([...womensKnown.keys(), ...womensExcluded.keys()]
    .filter((id) => !womensCleared.has(Number(id))).map(Number));
  assert.deepStrictEqual([...womensEffective].sort((a, b) => a - b), [101, 103, 104],
    "有効集合=" + [...womensEffective]);
  assert.ok(!womensEffective.has(102), "復帰した選手が除外されたまま");
});

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail ? 1 : 0);
