/**
 * BoundedFileReader — Producer-consumer queue for streaming file chunk reading.
 *
 * Prefetches file slices into a bounded Uint8Array queue ahead of transmission,
 * decoupling file disk read latency from the WebRTC DataChannel send loop.
 * Bounded to maxQueueSize (default 32 chunks = ~1.92 MB RAM max) to prevent memory accumulation.
 */

export class BoundedFileReader {
  private fileObj: File | Blob;
  private chunkSize: number;
  private offset = 0;
  private queue: Uint8Array[] = [];
  private maxQueueSize: number;
  private isDone = false;
  private waiters: Array<() => void> = [];
  private reading = false;

  constructor(fileObj: File | Blob, chunkSize: number, maxQueueSize = 256) {
    this.fileObj = fileObj;
    this.chunkSize = chunkSize;
    this.maxQueueSize = maxQueueSize;
    this.fillQueue();
  }

  private async fillQueue(): Promise<void> {
    if (this.reading || this.isDone) return;
    this.reading = true;

    try {
      // Read 1 MB blocks (16 chunks) per disk I/O call to maximize read throughput
      const blockSize = Math.max(this.chunkSize * 16, 1024 * 1024);

      while (this.offset < this.fileObj.size && this.queue.length < this.maxQueueSize) {
        const blockEnd = Math.min(this.offset + blockSize, this.fileObj.size);
        const blockSlice = this.fileObj.slice(this.offset, blockEnd);
        const blockBuffer = await blockSlice.arrayBuffer();
        const blockBytes = new Uint8Array(blockBuffer);

        let blockOffset = 0;
        while (blockOffset < blockBytes.length && this.queue.length < this.maxQueueSize) {
          const chunkEnd = Math.min(blockOffset + this.chunkSize, blockBytes.length);
          this.queue.push(blockBytes.subarray(blockOffset, chunkEnd));
          blockOffset += this.chunkSize;
        }

        this.offset += blockOffset;

        // Wake consumer waiters
        while (this.waiters.length > 0 && this.queue.length > 0) {
          const waiter = this.waiters.shift();
          if (waiter) waiter();
        }
      }

      if (this.offset >= this.fileObj.size && this.queue.length === 0) {
        this.isDone = true;
      }
    } finally {
      this.reading = false;
      // Wake all waiters if done or paused
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (waiter) waiter();
      }
    }
  }

  async readNextChunk(): Promise<Uint8Array | null> {
    while (this.queue.length === 0 && this.offset < this.fileObj.size) {
      this.fillQueue();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    if (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      if (this.queue.length < this.maxQueueSize / 2 && this.offset < this.fileObj.size) {
        this.fillQueue();
      }
      return chunk;
    }

    return null;
  }

  reset(): void {
    this.offset = 0;
    this.queue = [];
    this.isDone = false;
    this.reading = false;
    this.waiters = [];
  }
}
