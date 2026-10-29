/** Bound streamed bodies too: Content-Length is optional and cannot be trusted alone. */
export async function limitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new Error("Request too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
