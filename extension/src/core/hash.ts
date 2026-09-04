/**
 * SHA-256 over file bytes for the provenance record.
 *
 * Uses WebCrypto where it exists (extension pages, workers, and Node 20+ via
 * globalThis.crypto). The hash identifies which exact bytes were converted, so
 * a manifest can be checked against the file a surveyor actually holds.
 */

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  const buffer =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
  const digest = await subtle.digest('SHA-256', buffer as ArrayBuffer);
  const view = new Uint8Array(digest);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}
