/* Serves the test page, the mock's fake HA and the built panel over http, since a browser won't import modules from a
   file. Only those three folders are served, and only to this machine. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", "..", "..", ".."));
const allowed = ["frontend/test/e2e/", "design/", "custom_components/environment_control/frontend/"];
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const port = Number(process.env.PORT || 4173);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep) || !allowed.some((a) => path.startsWith(a)) || !types[extname(file)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": `${types[extname(file)]}; charset=utf-8`, "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`serving on http://127.0.0.1:${port}`));
