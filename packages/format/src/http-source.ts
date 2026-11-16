import { RemoteSource } from './remote-source';
export class HttpSource extends RemoteSource {
  private etag?: string;
  async read(start: number, end: number, signal?: AbortSignal) {
    const headers: Record<string, string> = {
      Range: `bytes=${start}-${end - 1}`,
    };
    if (this.etag) headers['If-Match'] = this.etag;
    const response = await fetch(this.url, {
      headers,
      cache: 'no-store',
      signal,
    });
    if (response.status === 412)
      throw new Error('Package changed on the server. Reopen it to use the new snapshot.');
    if (response.status !== 206)
      throw new Error(`Range server returned HTTP ${response.status}; expected 206`);
    const etag = response.headers.get('etag');
    if (!etag || etag.startsWith('W/')) throw new Error('Range server must provide a strong ETag');
    if (this.etag && etag !== this.etag) throw new Error('Snapshot changed during read');
    this.etag = etag;
    const range = response.headers.get('content-range');
    if (!range?.startsWith(`bytes ${start}-${end - 1}/`))
      throw new Error('Server returned the wrong byte range');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start) throw new Error('Truncated range response');
    return bytes;
  }
}
