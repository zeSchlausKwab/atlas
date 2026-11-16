#!/usr/bin/env bun
import { addBorderDisplay } from "../packages/boundaries/src/display-upgrade";
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: bun scripts/add-border-display.ts INPUT.atlas NEW.atlas",
  );
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
console.log(
  await addBorderDisplay(input, output, controller.signal, console.log),
);
