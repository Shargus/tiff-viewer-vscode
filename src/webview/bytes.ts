/**
 * Bytes from the extension host, as a Uint8Array whatever form they arrived
 * in: a Node Buffer serialised to JSON comes as {type: 'Buffer', data: [...]}.
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const data = (value as { data?: unknown })?.data ?? value;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (data && typeof data === 'object') return Uint8Array.from(Object.values(data as Record<string, number>));
  throw new Error('No data received');
}
