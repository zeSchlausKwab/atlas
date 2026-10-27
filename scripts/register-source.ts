import { registerSourceLocation } from "../apps/server/source-location";
const [directory, id, path] = process.argv.slice(2);
if (!directory || !id || !path)
  throw new Error(
    "Usage: bun scripts/register-source.ts SOURCE_CACHE_DIR SOURCE_ID MOUNTED_PBF_PATH",
  );
console.log(JSON.stringify(await registerSourceLocation(directory, id, path)));
