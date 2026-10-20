// Isolated synthetic browser fixture; this is not an ingestion server or shipped app.
import { createServer } from "node:http";
import { build } from "esbuild";
const built = await build({ entryPoints: ["tests/browser/live-host.tsx"], bundle: true, write: false, format: "esm",
    define: { "process.env.NODE_ENV": '"production"' } });
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic host</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((req, res) => {
    if (req.headers.host !== "127.0.0.1:4319" || req.method !== "GET") { res.writeHead(403); res.end(); return; }
    const path = new URL(req.url, "http://127.0.0.1:4319").pathname;
    if (path !== "/" && path !== "/app.js") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": path === "/" ? "text/html" : "text/javascript",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'" });
    res.end(path === "/" ? html : built.outputFiles[0].text);
}).listen(4319, "127.0.0.1");
