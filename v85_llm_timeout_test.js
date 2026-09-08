"use strict";
/** v85: LLMタイムアウト修正の単体テスト(利用者の実機「AIの考察生成に失敗しました」への対応)。
 *  本物のAnthropic APIは呼ばず、ローカルのモックHTTPサーバーに向けて挙動を検証する:
 *   ①重い(遅い)モデルが時間切れの時、軽量モデルへ自動で切り替えて答えが返る
 *   ②その際 fallbackFrom で「どのモデルが時間切れだったか」を正直に開示する
 *   ③タイムアウトのフォールバック先が無い/遅すぎる時は TIMEOUT を正直に投げる
 *   ④HTTPエラー(429等)は httpStatus を保持したまま投げる(画面で原因を出し分けるため) */
const http = require("http");
const assert = require("assert");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

// モックAnthropic: モデルIDごとに「応答までの遅延」と「HTTPステータス」を制御する。
//   slow-model  … 400ms待ってから200(重いモデルの疑似。短いタイムアウトだと切れる)
//   fast-model  … 即200(軽量モデルの疑似)
//   busy-model  … 即429(レート制限の疑似)
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let model = "";
        try { model = JSON.parse(body).model; } catch (e) {}
        const replyText = (txt) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: txt }], stop_reason: "end_turn" }));
        };
        if (model === "busy-model") { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "rate_limited" } })); return; }
        if (model === "slow-model") { setTimeout(() => replyText("SLOW-OK"), 400); return; }
        replyText("FAST-OK[" + model + "]");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const srv = await startMock();
  const port = srv.address().port;
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${port}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "fast-model";       // light
  process.env.ANTHROPIC_MODEL_HEAVY = "slow-model"; // heavy(遅い)
  const anthropic = require("./llm/providers/anthropic.js");

  await t("重いモデルが時間切れ→軽量モデルへ自動切替して答えが返る(fallbackを開示)", async () => {
    const out = await anthropic.generate({
      systemPrompt: "s", userPrompt: "u", tier: "heavy",
      timeoutMs: 150,                       // slow-model(400ms)は必ず時間切れ
      truncateRetry: false,
      timeoutFallbackModel: "fast-model",
      timeoutFallbackTimeoutMs: 2000,
      timeoutFallbackMaxTokens: 1000,
    });
    assert.ok(out.text && out.text.startsWith("FAST-OK"), "軽量モデルの答えが返っていない: " + JSON.stringify(out));
    assert.strictEqual(out.model, "fast-model", "使用モデルの開示が違う: " + out.model);
    assert.strictEqual(out.fallbackFrom, "slow-model", "時間切れ元モデルの開示が無い: " + out.fallbackFrom);
  });

  await t("十分な待ち時間があれば重いモデルのまま成功する(切替は起きない)", async () => {
    const out = await anthropic.generate({
      systemPrompt: "s", userPrompt: "u", tier: "heavy",
      timeoutMs: 2000, truncateRetry: false,
      timeoutFallbackModel: "fast-model",
    });
    assert.ok(out.text === "SLOW-OK", "重いモデルの答えでない: " + out.text);
    assert.strictEqual(out.fallbackFrom, undefined, "不要な切替が起きた");
  });

  await t("フォールバック先が無く時間切れなら TIMEOUT を投げる", async () => {
    let threw = null;
    try {
      await anthropic.generate({ systemPrompt: "s", userPrompt: "u", tier: "heavy", timeoutMs: 150, truncateRetry: false });
    } catch (e) { threw = e; }
    assert.ok(threw, "例外が投げられていない");
    assert.strictEqual(threw.code, "TIMEOUT", "codeがTIMEOUTでない: " + threw.code);
  });

  await t("HTTPエラー(429)は httpStatus を保持して投げる(画面で原因を出し分けるため)", async () => {
    let threw = null;
    try {
      await anthropic.generate({ systemPrompt: "s", userPrompt: "u", tier: "light", timeoutMs: 2000 });
    } catch (e) { threw = e; }
    // light=fast-modelは200なので、429を試すにはheavyをbusyにする
    process.env.ANTHROPIC_MODEL_HEAVY = "busy-model";
    delete require.cache[require.resolve("./llm/providers/anthropic.js")];
    const anth2 = require("./llm/providers/anthropic.js");
    try {
      await anth2.generate({ systemPrompt: "s", userPrompt: "u", tier: "heavy", timeoutMs: 2000 });
    } catch (e) { threw = e; }
    assert.ok(threw, "例外が投げられていない");
    assert.strictEqual(threw.code, "HTTP_ERROR", "codeがHTTP_ERRORでない: " + threw.code);
    assert.strictEqual(threw.httpStatus, 429, "httpStatusが429でない: " + threw.httpStatus);
  });

  srv.close();
  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
