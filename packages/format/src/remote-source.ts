import type { ByteSource } from './reader';
/** Remote snapshot identity without any delivery implementation. */
export abstract class RemoteSource implements ByteSource {
  constructor(
    readonly url: string,
    readonly apiUrl?: string,
  ) {}
  abstract read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}
