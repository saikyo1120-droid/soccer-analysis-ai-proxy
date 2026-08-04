/**
 * /api/debug-status: AUTO_COLLECT_SECRETが設定されている場合、他の保護付き
 * エンドポイント(run-daily/auto-collect)と同じ ?key= 方式で保護されることを確認する。
 * 別プロセス(別ファイル)にしているのは、AUTO_COLLECT_SECRETがserver.js読み込み時に
 * 一度だけ読まれるため、他のテスト(未設定ケース)と同じプロセス内では両方を
 * 検証できないため。
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
process.env.AUTO_COLLECT_SECRET = "s3cr3t";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); } });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  const r1 = await get(port, "/api/debug-status");
  ok(r1.status === 403, "keyなしだと403で拒否される, got " + r1.status);

  const r2 = await get(port, "/api/debug-status?key=wrong");
  ok(r2.status === 403, "keyが間違っていると403で拒否される, got " + r2.status);

  const r3 = await get(port, "/api/debug-status?key=s3cr3t");
  ok(r3.status === 200, "正しいkeyなら200が返る, got " + r3.status);

  server.close();
  console.log(failures === 0 ? "\n/api/debug-status secret-protection test PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
