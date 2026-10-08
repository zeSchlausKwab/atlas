import {
  AtlasReader,
  FileSource,
  HttpSource,
} from "../../../packages/format/src/reader";
import { extract, type Selection } from "../../../packages/offline/src/index";
self.onmessage = async (
  event: MessageEvent<{
    file?: Blob;
    url?: string;
    snapshot: string;
    selection: Selection;
  }>,
) => {
  try {
    const { file, url, snapshot, selection } = event.data;
    const reader = await new AtlasReader(
      file ? new FileSource(file) : new HttpSource(url!),
    ).open();
    if (reader.index.manifest.snapshot !== snapshot)
      throw new Error("Source snapshot changed. Reopen it before exporting.");
    const blob = await extract(reader, selection, (message) =>
      self.postMessage({ message }),
    );
    self.postMessage({ blob });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
