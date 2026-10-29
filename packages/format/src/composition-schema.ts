export const MEMBER_CHUNK_BYTES = 1024 ** 2;
export interface ArchiveComposition {
  version: 1;
  members: Array<{ id: string; snapshot: string; bytes: number }>;
}
export function validateComposition(
  value: unknown,
): asserts value is ArchiveComposition | undefined {
  if (value === undefined) return;
  const v = value as ArchiveComposition;
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.members) ||
    !v.members.length ||
    v.members.length > 64 ||
    new Set(v.members.map((m) => m?.id)).size !== v.members.length ||
    v.members.some(
      (m) =>
        !m ||
        !/^m[0-9]{1,3}$/.test(m.id) ||
        !/^[a-f0-9]{64}$/.test(m.snapshot) ||
        !Number.isSafeInteger(m.bytes) ||
        m.bytes <= 0 ||
        m.bytes > MEMBER_CHUNK_BYTES * 2 ** 26,
    )
  )
    throw new Error("Invalid embedded Atlas composition");
}
