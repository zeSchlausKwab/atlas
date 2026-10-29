import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { nativeDiagnostics } from "../packages/cli/src/native-diagnostics";

const checkpoint =
  "ATLAS_PROGRESS " +
  JSON.stringify({
    message: "Partitioning cycling",
    completed: 23000,
    total: 66000,
    unit: "ways",
  });
test("native process signal and its checkpoint survive an unterminated failure line", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stderr.write(${JSON.stringify(checkpoint + "\n")}); process.stderr.write("free(): double free detected in tcache 2"); process.kill(process.pid, "SIGTERM")`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const progress: string[] = [];
  const d = nativeDiagnostics(child, (line) => progress.push(line));
  const error = await d.failure("Partitioned graph compiler");
  expect(error.message).toContain("terminated by SIGTERM");
  expect(error.message).toContain("free(): double free detected");
  expect(error.message).toContain(
    "Last reported checkpoint: Partitioning cycling: 23000/66000 ways",
  );
  expect(error.message).not.toContain("(null)");
  expect(progress).toEqual([
    checkpoint,
    "free(): double free detected in tcache 2",
  ]);
});
test("normal exits and failed executable launches remain distinguishable", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stderr.write("ordinary error"); process.exit(7)'],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const d = nativeDiagnostics(child, () => {});
  expect((await d.failure("Compiler")).message).toBe(
    "Compiler failed (exit 7): ordinary error",
  );
  const missing = nativeDiagnostics(
    spawn("/atlas-test-no-such-executable"),
    () => {},
  );
  await expect(missing.exited).rejects.toThrow();
  await missing.stderr.catch(() => {});
});
test("diagnostic buffering is bounded and malformed progress does not hide the error", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stderr.write("ATLAS_PROGRESS bad json\\n" + "x".repeat(30000) + "tail", () => process.exit(1))`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const d = nativeDiagnostics(child, () => {});
  const error = await d.failure("Compiler");
  expect(error.message.length).toBeLessThan(4200);
  expect(error.message.endsWith("tail")).toBe(true);
});
