// Runs the static file server and every pw_*_check.js Playwright script from
// within a single Node process (avoids relying on shell job control / background
// processes, which this sandbox sometimes kills silently between tool calls).
// IMPORTANT: uses async spawn (not spawnSync) — spawnSync blocks the entire
// event loop, which would prevent this same process's HTTP server from ever
// responding to the child Playwright processes' requests.
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

function runCheck(file) {
  return new Promise((resolve) => {
    console.log(`\n=== ${file} ===`);
    const child = spawn("node", [path.join(__dirname, file)], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
  });
}

const checks = process.argv.slice(2);

server.listen(8787, async () => {
  let failures = 0;
  for (const check of checks) {
    const ok = await runCheck(check);
    if (!ok) failures++;
  }
  server.close(() => {
    console.log(failures === 0 ? "\nALL PLAYWRIGHT CHECKS PASSED." : `\n${failures} CHECK FILE(S) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
});
