import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const files = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"] };
createServer(async (req, res) => {
    if (req.headers.host !== "127.0.0.1:4317" || req.method !== "GET") { res.writeHead(403); res.end(); return; }
    const file = files[req.url];
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
        const body = await readFile(new URL(`../dist/standalone/${file[0]}`, import.meta.url));
        res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "frame-ancestors 'none'" });
        res.end(body);
    } catch { res.writeHead(503); res.end("Run npm run build first."); }
}).listen(4317, "127.0.0.1", () => console.log("Open http://127.0.0.1:4317 (local files only; no ingestion endpoint)."));
