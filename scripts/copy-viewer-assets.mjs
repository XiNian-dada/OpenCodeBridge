import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const target = new URL("../dist/viewer/public/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL("../src/viewer/public/", import.meta.url), target, { recursive: true });
// Keep the viewer self-contained: no CDN, extra asset routes, or runtime modules.
await build({
  entryPoints: [fileURLToPath(new URL("../src/viewer/public/app.js", import.meta.url))],
  outfile: fileURLToPath(new URL("app.js", target)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  legalComments: "eof",
});
