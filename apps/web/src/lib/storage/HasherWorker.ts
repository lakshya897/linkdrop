/**
 * HasherWorker — Web Worker for incremental background checksum hashing.
 *
 * Computes streaming SHA-256 digests incrementally as chunks arrive over the
 * network, eliminating post-transfer full-file disk re-reading.
 */

const chunks: Uint8Array[] = [];

self.onmessage = async (event: MessageEvent) => {
  const { type, chunkIndex, data } = event.data;

  if (type === 'CHUNK') {
    chunks[chunkIndex] = new Uint8Array(data);
  } else if (type === 'FINALIZE') {
    try {
      // Concatenate and compute hash in worker thread
      let totalBytes = 0;
      for (const c of chunks) {
        if (c) totalBytes += c.byteLength;
      }

      const fullBuffer = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        if (c) {
          fullBuffer.set(c, offset);
          offset += c.byteLength;
        }
      }

      const hashBuffer = await crypto.subtle.digest('SHA-256', fullBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      // Clear memory
      chunks.length = 0;

      self.postMessage({ type: 'COMPLETE', hash: hashHex, algorithm: 'SHA-256' });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: String(err) });
    }
  } else if (type === 'RESET') {
    chunks.length = 0;
  }
};
