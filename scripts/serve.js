// Minimal static file server that sends the cross-origin isolation headers
// (COOP/COEP/CORP) required for SharedArrayBuffer — which the multithreaded
// ffmpeg-core needs. `http-server` has no header support (its --headers flag is
// a silent no-op), so the previous `serve` script never actually sent these and
// the MT tests could not run. Dependency-free (Node built-ins only).
//
// Usage: node scripts/serve.js [port] [rootDir] [--no-coi]
//
// --no-coi omits COOP/COEP so the page is NOT cross-origin isolated. The
// single-threaded core exists to run without isolation; its test lane must use
// this mode or it only ever proves the core works under the very headers it is
// meant to avoid.
const http = require("http");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const NO_COI = args.includes("--no-coi");
const positional = args.filter((a) => !a.startsWith("--"));
const PORT = Number(positional[0] || 3000);
const ROOT = path.resolve(positional[1] || process.cwd());

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ttf": "font/ttf",
};

const COI_HEADERS = {
  ...(NO_COI
    ? {}
    : {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      }),
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-cache, no-store, must-revalidate",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  // Health-check root: return 200 so start-server-and-test / wait-on consider
  // the server ready (there is no index.html at the repo root).
  if (urlPath === "/") {
    res.writeHead(200, { ...COI_HEADERS, "Content-Type": "text/plain" });
    return res.end(
      `ffmpeg.wasm dev server (${NO_COI ? "NOT isolated" : "cross-origin isolated"})`
    );
  }
  const filePath = path.join(ROOT, urlPath);
  // Prevent path traversal outside ROOT.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, COI_HEADERS);
    return res.end("Forbidden");
  }
  fs.stat(filePath, (err, stat) => {
    const target = !err && stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, COI_HEADERS);
        return res.end("Not found: " + urlPath);
      }
      res.writeHead(200, {
        ...COI_HEADERS,
        "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length": data.length,
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(
    `serve: http://localhost:${PORT} (root=${ROOT}, ${NO_COI ? "NOT isolated" : "cross-origin isolated"})`
  );
});
