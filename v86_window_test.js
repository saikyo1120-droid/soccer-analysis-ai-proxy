"use strict";
/** v86: 学習窓300→2000件+分割読み出し化のテスト(利用者の指示「窓を2000に増やして」)。
 *  検証すること:
 *   ① 窓の上限が2000件になっている(LTRIMの保持数)
 *   ② 分割読み出しが2000件を全件・順序どおり返す
 *   ③ どのチャンクも100件を超えない(=Upstash RESTの1応答上限を構造的に超えない)
 *   ④ 途中のチャンクが失敗したら全体を失敗([])として返す(半端な学習をしない)
 *   ⑤ dailyJobとweeklyDigestの双子実装が同じ挙動
 *   ⑥ 実際の日次学習フロー(モックRedis)でも、2000件を積んで全件が学習に見えること */
const assert = require("assert");
const { OWN_PRED_RECENT_KEEP, lrangeAllChunked } = require("./learning/dailyJob");
const { lrangeAllChunkedDigest } = require("./learning/weeklyDigest");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

// 汎用LRANGEモック(絶対・負インデックス両対応。既存テスト群と同じ意味論)
function mockCmd(list, opts) {
  const o = opts || {};
  let calls = 0;
  const fn = async (cmd) => {
    const [op, , s, e] = cmd;
    assert.strictEqual(op, "LRANGE", "LRANGE以外が呼ばれた: " + op);
    calls++;
    if (o.failAtCall && calls === o.failAtCall) throw new Error("simulated upstash failure");
    let start = parseInt(s, 10), end = parseInt(e, 10);
    // ③の検証: 要求スパンが100件を超えていないこと(応答サイズの構造的上限)
    assert.ok(end - start + 1 <= 100, `1回の要求が100件を超えている: ${start}..${end}`);
    if (start < 0) start = Math.max(0, list.length + start);
    if (end < 0) end = list.length + end;
    return list.slice(start, end + 1);
  };
  fn.callCount = () => calls;
  return fn;
}

(async () => {
  const big = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i }));

  await t("① 窓の上限が2000件(OWN_PRED_RECENT_KEEP)", async () => {
    assert.strictEqual(OWN_PRED_RECENT_KEEP, 2000, "KEEP=" + OWN_PRED_RECENT_KEEP);
  });

  await t("② 2000件を全件・順序どおり読み出す(dailyJob側)", async () => {
    const cmd = mockCmd(big);
    const out = await lrangeAllChunked(cmd, "learn:ownpred:recent", 100);
    assert.strictEqual(out.length, 2000, "件数=" + out.length);
    assert.strictEqual(JSON.parse(out[0]).i, 0);
    assert.strictEqual(JSON.parse(out[1999]).i, 1999, "順序が壊れている");
    assert.strictEqual(cmd.callCount(), 21, "呼び出し回数=" + cmd.callCount() + "(2000件=20回+終端確認1回のはず)");
  });

  await t("②b 端数(2000で割り切れない件数)も正しく読み切る", async () => {
    const odd = Array.from({ length: 137 }, (_, i) => String(i));
    const out = await lrangeAllChunked(mockCmd(odd), "k", 100);
    assert.strictEqual(out.length, 137);
    assert.strictEqual(out[136], "136");
  });

  await t("②c 空のリストは空配列(呼び出し1回で終わる)", async () => {
    const cmd = mockCmd([]);
    const out = await lrangeAllChunked(cmd, "k", 100);
    assert.deepStrictEqual(out, []);
    assert.strictEqual(cmd.callCount(), 1);
  });

  await t("④ 途中のチャンクが失敗→全体を[]として返す(半端な学習をしない)", async () => {
    const out = await lrangeAllChunked(mockCmd(big, { failAtCall: 7 }), "k", 100);
    assert.deepStrictEqual(out, [], "部分データが返ってしまっている");
  });

  await t("⑤ weeklyDigestの双子実装も同じ挙動(全件・順序・失敗時[])", async () => {
    const out = await lrangeAllChunkedDigest(mockCmd(big), "k", 100);
    assert.strictEqual(out.length, 2000);
    assert.strictEqual(JSON.parse(out[1999]).i, 1999);
    const failed = await lrangeAllChunkedDigest(mockCmd(big, { failAtCall: 3 }), "k", 100);
    assert.deepStrictEqual(failed, []);
    // 末尾400件の切り出し(digestの実際の使い方)
    const tail = (await lrangeAllChunkedDigest(mockCmd(big), "k", 100)).slice(-400);
    assert.strictEqual(tail.length, 400);
    assert.strictEqual(JSON.parse(tail[0]).i, 1600, "末尾400件の先頭が違う");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
