/**
 * Confirms the server can serve index.html whether it's placed next to
 * server.js (the user's actual GitHub repo layout: server.js + index.html
 * both at repo root) OR one folder above server.js (the original zip layout:
 * server/server.js with index.html one level up). This was a real bug found
 * in production: the user's repo had server.js/README.md/package.json at the
 * repo root with NO index.html anywhere, and the old hardcoded
 * `path.join(__dirname, "..")` meant the app's homepage 404'd even once
 * index.html was later added next to server.js.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-root-test-"));
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server", "server.js"), "utf8");

// Stage C: server.js now requires ./llm, ./rag, ./discuss (relative to server.js's
// own folder), so any copy of server.js used in this test needs those subfolders
// copied alongside it too, or the require() calls at the top of server.js fail.
function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}
function copySupportModules(destServerDir) {
  for (const sub of ["llm", "rag", "discuss", "learning", "knowledge", "memory", "reasoning"]) {
    copyDirRecursive(path.join(__dirname, "..", "server", sub), path.join(destServerDir, sub));
  }
}

(async () => {
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };

  // Case A: index.html sits in the SAME folder as server.js (the user's real repo layout)
  const caseADir = path.join(tmpDir, "caseA");
  fs.mkdirSync(caseADir, { recursive: true });
  fs.writeFileSync(path.join(caseADir, "server.js"), serverSrc);
  fs.writeFileSync(path.join(caseADir, "index.html"), "<html>CASE_A_HOMEPAGE</html>");
  copySupportModules(caseADir);

  delete require.cache[require.resolve(path.join(caseADir, "server.js"))];
  const modA = require(path.join(caseADir, "server.js"));
  await new Promise((resolve) => (modA.server.listening ? resolve() : modA.server.on("listening", resolve)));
  const portA = modA.server.address().port;
  const bodyA = await httpGet(portA, "/");
  if (!bodyA.includes("CASE_A_HOMEPAGE")) fail("Case A (index.html next to server.js): expected homepage content, got: " + bodyA.slice(0, 100));
  modA.server.close();

  // Case B: index.html sits ONE FOLDER ABOVE server.js's own folder (original zip layout: server/server.js)
  const caseBRoot = path.join(tmpDir, "caseB");
  const caseBServerDir = path.join(caseBRoot, "server");
  fs.mkdirSync(caseBServerDir, { recursive: true });
  fs.writeFileSync(path.join(caseBServerDir, "server.js"), serverSrc);
  fs.writeFileSync(path.join(caseBRoot, "index.html"), "<html>CASE_B_HOMEPAGE</html>");
  copySupportModules(caseBServerDir);

  process.env.PORT = "0";
  delete require.cache[require.resolve(path.join(caseBServerDir, "server.js"))];
  const modB = require(path.join(caseBServerDir, "server.js"));
  await new Promise((resolve) => (modB.server.listening ? resolve() : modB.server.on("listening", resolve)));
  const portB = modB.server.address().port;
  const bodyB = await httpGet(portB, "/");
  if (!bodyB.includes("CASE_B_HOMEPAGE")) fail("Case B (index.html one folder above server.js): expected homepage content, got: " + bodyB.slice(0, 100));
  modB.server.close();

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nStatic root resolution PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();

function httpGet(port, urlPath) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}
