import { spawn } from "node:child_process";
/** Kill the whole compiler process group on cancellation, including Cargo/Rust children. */
export async function runCompiler(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
) {
  signal.throwIfAborted();
  const child = spawn(args[0]!, args.slice(1), {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = () => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  let tail = "";
  const consume = async (stream: NodeJS.ReadableStream) => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = pending.split(/[\r\n]/);
      pending = (lines.pop() ?? "").slice(-4000);
      for (const line of lines) {
        tail = (tail + line + "\n").slice(-4000);
        if (line.trim()) onLine(line.slice(0, 500));
      }
    }
    if (pending) onLine(pending.slice(0, 500));
  };
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const [code] = await Promise.all([
      exited,
      consume(child.stdout!),
      consume(child.stderr!),
    ]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${tail}`);
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
  }
}
