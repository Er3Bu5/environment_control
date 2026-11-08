/* Builds the panel into the integration: host.js copied exactly as written, and frame.js holding the sandboxed frame's
   whole page. The frame gets a CSP that allows no network and only its own script, by hash, so a script that wasn't
   built in can't run. Roboto is inlined because the frame can't fetch anything. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "custom_components", "environment_control", "frontend");
const manifest = JSON.parse(readFileSync(join(here, "..", "custom_components", "environment_control", "manifest.json"), "utf8"));
const version = process.env.EC_VERSION || manifest.version;

const bundle = await build({
  entryPoints: [join(here, "src", "frame", "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(version) },
});
const script = bundle.outputFiles[0].text;
if (script.toLowerCase().includes("</script")) throw new Error("the frame's script contains </script");

export const CSP_PREFIX = "default-src 'none'; script-src 'sha256-";
const digest = createHash("sha256").update(script, "utf8").digest("base64");
const csp = `${CSP_PREFIX}${digest}'; style-src 'unsafe-inline'; font-src data:`;
const font = readFileSync(join(here, "fonts", "roboto-latin.woff2")).toString("base64");
const html =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<style>@font-face{font-family:Roboto;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900;font-display:block}` +
  `html,body{margin:0}</style></head><body><ec-app></ec-app><script>${script}</script></body></html>`;

mkdirSync(out, { recursive: true });
const asJs = JSON.stringify(html).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
writeFileSync(join(out, "frame.js"), `/* Built by frontend/build.mjs: the sandboxed frame's whole page. Version ${version}. */\nexport default ${asJs};\n`);
copyFileSync(join(here, "src", "host.js"), join(out, "host.js"));
console.log(`built ${version}: host.js ${readFileSync(join(out, "host.js")).length} B, frame.js ${Math.round(asJs.length / 1024)} KB`);
