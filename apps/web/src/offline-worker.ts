import { AtlasReader } from "../../../packages/format/src/reader";
import { extract, type Selection } from "../../../packages/offline/src/index";
let sequence = 0;
const reads = new Map<
  number,
  { resolve(bytes: Uint8Array): void; reject(error: Error): void }
>();
function read(start: number, end: number): Promise<Uint8Array> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    reads.set(id, { resolve, reject });
    self.postMessage({ type: "read", id, start, end });
  });
}
self.onmessage = async (
  event: MessageEvent<{
    type: string;
    id?: number;
    bytes?: Uint8Array;
    error?: string;
    snapshot: string;
    selection: Selection;
  }>,
) => {
  const m = event.data;
  if (m.type === "reply") {
    const pending = reads.get(m.id!);
    reads.delete(m.id!);
    if (m.error) pending?.reject(new Error(m.error));
    else pending?.resolve(m.bytes!);
    return;
  }
  if (m.type !== "export") return;
  let reader: AtlasReader | undefined;
  try {
    // Parent retains the verified source, provider choices and session cache.
    reader = await new AtlasReader({ read }).open();
    if (reader.index.manifest.snapshot !== m.snapshot)
      throw new Error("Source snapshot changed. Reopen it before exporting.");
    const blob = await extract(reader, m.selection, (message) =>
      self.postMessage({ message }),
    );
    self.postMessage({ blob });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    reader?.dispose();
  }
};
