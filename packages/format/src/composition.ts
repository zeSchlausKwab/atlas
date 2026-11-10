import { AtlasReader, RemoteSource, type ByteSource } from "./reader";
import type { Manifest } from "./index";
import {
  MEMBER_CHUNK_BYTES,
  validateComposition,
  type ArchiveComposition,
} from "./composition-schema";
export {
  MEMBER_CHUNK_BYTES,
  validateComposition,
  type ArchiveComposition,
} from "./composition-schema";
export function memberKey(id: string, chunk: number) {
  return `members/${id}/26/${chunk}/0`;
}
/** Range-readable embedded archive; parent blocks are hash-verified before use. */
export class MemberSource implements ByteSource {
  constructor(
    readonly parent: AtlasReader,
    readonly member: ArchiveComposition["members"][number],
  ) {}
  async read(start: number, end: number, signal?: AbortSignal) {
    if (
      ![start, end].every(Number.isSafeInteger) ||
      start < 0 ||
      end < start ||
      end > this.member.bytes
    )
      throw new Error("Invalid member byte range");
    const output = new Uint8Array(end - start);
    for (let at = start; at < end; ) {
      signal?.throwIfAborted();
      const chunk = Math.floor(at / MEMBER_CHUNK_BYTES),
        offset = at % MEMBER_CHUNK_BYTES;
      const bytes = await this.parent.block(memberKey(this.member.id, chunk));
      const expected = Math.min(
        MEMBER_CHUNK_BYTES,
        this.member.bytes - chunk * MEMBER_CHUNK_BYTES,
      );
      if (bytes.length !== expected)
        throw new Error("Truncated embedded Atlas member");
      const length = Math.min(bytes.length - offset, end - at);
      output.set(bytes.subarray(offset, offset + length), at - start);
      at += length;
    }
    return output;
  }
}
export class RemoteMemberSource extends RemoteSource {
  private memberSource: MemberSource;
  constructor(
    readonly parent: AtlasReader,
    readonly member: ArchiveComposition["members"][number],
  ) {
    const remote = parent.source as RemoteSource;
    super(
      `${remote.url}#member=${member.id}`,
      remote.apiUrl ? `${remote.apiUrl}/members/${member.id}` : undefined,
    );
    this.memberSource = new MemberSource(parent, member);
  }
  override read(start: number, end: number, signal?: AbortSignal) {
    return this.memberSource.read(start, end, signal);
  }
}
export async function openMembers(parent: AtlasReader) {
  const composition = parent.index.manifest.composition;
  validateComposition(composition);
  if (!composition) return [];
  const result: Array<{ id: string; reader: AtlasReader; manifest: Manifest }> =
    [];
  try {
    for (const member of composition.members) {
      const reader = await new AtlasReader(
        parent.source instanceof RemoteSource
          ? new RemoteMemberSource(parent, member)
          : new MemberSource(parent, member),
      ).open();
      if (
        reader.index.manifest.snapshot !== member.snapshot ||
        reader.index.header.fileLength !== member.bytes ||
        reader.index.manifest.composition
      ) {
        reader.dispose();
        throw new Error(
          "Embedded Atlas identity mismatch or nested composition",
        );
      }
      result.push({ id: member.id, reader, manifest: reader.index.manifest });
    }
    return result;
  } catch (error) {
    result.forEach((m) => m.reader.dispose());
    throw error;
  }
}
