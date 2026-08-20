/** Encodes bounded binary data without exceeding function argument limits. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
