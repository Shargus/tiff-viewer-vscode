import { getDecoder } from 'geotiff';
import type { BaseDecoder } from 'geotiff';

/**
 * Parallel tile decoding.
 *
 * The decoder worker parses the file and assembles display tiles, but
 * decompressing tiles (LZW, Deflate, Zstandard, LERC, ...) is most of the work
 * for images without overviews. The webview starts a few helper workers from
 * the same script; the decoder worker sends them compressed tiles over
 * MessagePorts and gets the decoded bytes back, so all cores decode at once.
 */

interface DecodeRequest {
  id: number;
  compression: number;
  /** Identifies `params` within the sending worker; helpers create one decoder per key. */
  key: number;
  params: unknown;
  buffer: ArrayBuffer;
}

type DecodeResponse = { id: number; data: ArrayBuffer } | { id: number; error: string };

interface Helper {
  port: MessagePort;
  busy: number;
}

export class DecodePool {
  private readonly helpers: Helper[];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (data: ArrayBuffer) => void; reject: (error: Error) => void }>();

  constructor(ports: MessagePort[]) {
    this.helpers = ports.map((port) => ({ port, busy: 0 }));
    for (const helper of this.helpers) {
      helper.port.onmessage = (event: MessageEvent<DecodeResponse>) => {
        const response = event.data;
        helper.busy--;
        const waiter = this.pending.get(response.id);
        this.pending.delete(response.id);
        if ('error' in response) waiter?.reject(new Error(response.error));
        else waiter?.resolve(response.data);
      };
    }
  }

  get size(): number {
    return this.helpers.length;
  }

  /** Decodes (and un-predicts) one tile on the least busy helper. `buffer` is transferred. */
  decode(compression: number, key: number, params: unknown, buffer: ArrayBuffer): Promise<ArrayBuffer> {
    let helper = this.helpers[0];
    for (const candidate of this.helpers) {
      if (candidate.busy < helper.busy) helper = candidate;
    }
    helper.busy++;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: DecodeRequest = { id, compression, key, params, buffer };
      helper.port.postMessage(request, [buffer]);
    });
  }
}

/** Serves decode requests from the decoder worker on `port` (runs in a helper worker). */
export function serveDecodes(port: MessagePort, registerDecoders: () => void): void {
  registerDecoders();
  const decoders = new Map<number, Promise<BaseDecoder>>();
  port.onmessage = async (event: MessageEvent<DecodeRequest>) => {
    const { id, compression, key, params, buffer } = event.data;
    try {
      let decoder = decoders.get(key);
      if (!decoder) {
        decoder = getDecoder(compression, params as never) as Promise<BaseDecoder>;
        decoders.set(key, decoder);
      }
      const decoded = await (await decoder).decode(buffer);
      const data = decoded as ArrayBuffer;
      try {
        port.postMessage({ id, data } satisfies DecodeResponse, [data]);
      } catch {
        // Not transferable (e.g. a view of WebAssembly memory): send a copy.
        port.postMessage({ id, data } satisfies DecodeResponse);
      }
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies DecodeResponse);
    }
  };
}
