import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Keep diagnostics outside the native heap, including a signal and the last durable progress report. */
export function nativeDiagnostics(
  child: ChildProcess,
  progress: (line: string) => void,
) {
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void exited.catch(() => {});
  let lastLine = "",
    checkpoint = "";
  const accept = (line: string) => {
    if (!line) return;
    lastLine = line.slice(-4096);
    if (line.startsWith("ATLAS_PROGRESS ")) {
      try {
        const p = JSON.parse(line.slice(15));
        if (
          typeof p.message === "string" &&
          Number.isFinite(p.completed) &&
          Number.isFinite(p.total)
        )
          checkpoint =
            `${p.message}: ${p.completed}/${p.total} ${p.unit ?? "items"}`.slice(
              0,
              4096,
            );
      } catch {
        /* A malformed diagnostic must not hide a native failure. */
      }
    }
    progress(lastLine);
  };
  const stderr = (async () => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    if (child.stderr)
      for await (const chunk of child.stderr) {
        const lines = (pending + decoder.write(chunk)).split(/[\r\n]/);
        pending = (lines.pop() ?? "").slice(-8192);
        for (const line of lines) accept(line);
      }
    accept(pending + decoder.end());
  })();
  void stderr.catch(() => {});
  const failure = async (label: string) => {
    const [{ code, signal }] = await Promise.all([exited, stderr]);
    return new Error(
      `${label} ${signal ? `terminated by ${signal}` : `failed (exit ${code})`}${lastLine ? `: ${lastLine}` : ""}${checkpoint && !lastLine.startsWith("ATLAS_PROGRESS ") ? `. Last reported checkpoint: ${checkpoint}` : ""}`,
    );
  };
  return { exited, stderr, failure };
}
