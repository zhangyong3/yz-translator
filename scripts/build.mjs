import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(resolve(root, "public"), outdir, { recursive: true });
await build({
  entryPoints: {
    background: resolve(root, "src/background.ts"),
    content: resolve(root, "src/content/index.ts"),
    panel: resolve(root, "src/panel.ts"),
    options: resolve(root, "src/options.ts")
  },
  bundle: true,
  outdir,
  format: "iife",
  target: "chrome120",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' }
});
