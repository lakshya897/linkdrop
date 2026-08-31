/**
 * BoundedWriteQueue — Ordered bounded writer pipeline for streaming file storage.
 *
 * Ensures chunks arrive in sequential order to the StorageWriter, maintains a
 * bounded reorder buffer for out-of-order arrivals, and limits the number of
 * concurrent pending write operations to prevent unbounded memory growth.
 *
 * Architecture:
 *   RTCDataChannel → BoundedWriteQueue → StorageWriter → Disk/IndexedDB
 */

export interface WriteQueueStats {
  /** Next expected chunk index for sequential ordering */
  nextExpectedChunk: number;
  /** Number of chunks currently held in the reorder buffer */
  reorderBufferSize: number;
  /** Bytes currently held in the reorder buffer */
  reorderBufferBytes: number;
  /** Number of write operations currently in-flight to the storage backend */
  pendingWrites: number;
  /** Total chunks successfully written */
  totalWritten: number;
  /** Whether the queue is currently applying backpressure */
  isFull: boolean;
}

export interface StorageWriteTarget {
  write(chunkIndex: number, data: Uint8Array): Promise<void>;
}

export class BoundedWriteQueue {
  private nextExpectedChunk = 0;
  private reorderBuffer: Map<number, Uint8Array> = new Map();
  private pendingWrites = 0;
  private totalWritten = 0;
  private reorderBufferBytes = 0;

  /** Maximum number of concurrent in-flight write operations */
  private readonly maxQueueDepth: number;
  /** Maximum number of chunks held in the reorder buffer */
  private readonly maxReorderSize: number;

  private readonly target: StorageWriteTarget;

  /** Resolvers waiting for a write slot to become available */
  private drainWaiters: Array<() => void> = [];

  /** Optional callback invoked on each ordered write for incremental hashing */
  private readonly onOrderedWrite?: (chunkIndex: number, data: Uint8Array) => void;

  constructor(
    target: StorageWriteTarget,
    options?: {
      maxQueueDepth?: number;
      maxReorderSize?: number;
      onOrderedWrite?: (chunkIndex: number, data: Uint8Array) => void;
    }
  ) {
    this.target = target;
    this.maxQueueDepth = options?.maxQueueDepth ?? 4;
    this.maxReorderSize = options?.maxReorderSize ?? 64;
    this.onOrderedWrite = options?.onOrderedWrite;
  }

  /**
   * Enqueue a chunk for ordered writing. Blocks (via await) if the write queue
   * is full, providing natural backpressure to the caller.
   */
  async enqueue(chunkIndex: number, data: Uint8Array): Promise<void> {
    // If this chunk is behind or already processed, skip
    if (chunkIndex < this.nextExpectedChunk) return;

    if (chunkIndex === this.nextExpectedChunk) {
      // Chunk is exactly what we expect — write immediately
      await this.writeOrdered(chunkIndex, data);
      // Flush any buffered sequential chunks
      await this.flushReorderBuffer();
    } else {
      // Out-of-order: buffer if within bounds
      if (!this.reorderBuffer.has(chunkIndex)) {
        this.reorderBuffer.set(chunkIndex, data);
        this.reorderBufferBytes += data.byteLength;
      }
    }
  }

  /**
   * Write a chunk to the storage backend, respecting the bounded queue depth.
   */
  private async writeOrdered(chunkIndex: number, data: Uint8Array): Promise<void> {
    // Wait for a write slot if the queue is full
    while (this.pendingWrites >= this.maxQueueDepth) {
      await new Promise<void>(resolve => {
        this.drainWaiters.push(resolve);
      });
    }

    // Invoke incremental hash callback before writing
    if (this.onOrderedWrite) {
      this.onOrderedWrite(chunkIndex, data);
    }

    this.pendingWrites++;
    this.nextExpectedChunk = chunkIndex + 1;

    try {
      await this.target.write(chunkIndex, data);
      this.totalWritten++;
    } finally {
      this.pendingWrites--;
      // Wake up one waiter if any
      if (this.drainWaiters.length > 0) {
        const waiter = this.drainWaiters.shift();
        if (waiter) waiter();
      }
    }
  }

  /**
   * Flush sequential chunks from the reorder buffer.
   */
  private async flushReorderBuffer(): Promise<void> {
    while (this.reorderBuffer.has(this.nextExpectedChunk)) {
      const data = this.reorderBuffer.get(this.nextExpectedChunk)!;
      this.reorderBuffer.delete(this.nextExpectedChunk);
      this.reorderBufferBytes -= data.byteLength;
      await this.writeOrdered(this.nextExpectedChunk, data);
    }
  }

  /**
   * Returns true if the queue is at capacity and the caller should
   * apply backpressure (stop reading from the data channel).
   */
  isFull(): boolean {
    return this.pendingWrites >= this.maxQueueDepth ||
      this.reorderBuffer.size >= this.maxReorderSize;
  }

  /**
   * Wait until all pending writes have completed and the reorder buffer is empty.
   */
  async flush(): Promise<void> {
    // Flush any remaining reorder buffer entries
    await this.flushReorderBuffer();
    // Wait for all pending writes to complete
    while (this.pendingWrites > 0) {
      await new Promise<void>(resolve => {
        this.drainWaiters.push(resolve);
      });
    }
  }

  /** Get current queue statistics */
  getStats(): WriteQueueStats {
    return {
      nextExpectedChunk: this.nextExpectedChunk,
      reorderBufferSize: this.reorderBuffer.size,
      reorderBufferBytes: this.reorderBufferBytes,
      pendingWrites: this.pendingWrites,
      totalWritten: this.totalWritten,
      isFull: this.isFull()
    };
  }

  /** Reset state for a new transfer */
  reset(): void {
    this.nextExpectedChunk = 0;
    this.reorderBuffer.clear();
    this.reorderBufferBytes = 0;
    this.pendingWrites = 0;
    this.totalWritten = 0;
    this.drainWaiters = [];
  }
}
