export {};
const result = await Bun.build({
  entrypoints: [
    "apps/web/src/main.ts",
    "apps/web/src/offline-worker.ts",
    "apps/web/src/routing-worker.ts",
  ],
  outdir: "dist",
  target: "browser",
  minify: true,
  sourcemap: "external",
});
if (!result.success) throw new AggregateError(result.logs, "Web build failed");
console.log(`Built ${result.outputs.length} web artifacts`);
