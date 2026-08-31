/**
 * StorageWriter — Abstraction layer for receiver-side file persistence.
 *
 * The transfer engine interacts exclusively through this interface,
 * remaining agnostic to the underlying storage backend.
 *
 * Implementations:
 *   FileSystemAccessWriter — Chromium direct-to-disk streaming via FSA API
 *   IndexedDbWriter — Fallback for Firefox/Safari/Mobile browsers
 */

export interface StorageWriteResult {
  /** Which storage backend was used */
  mode: 'file-system' | 'blob';
  /** Blob URL for download (only for IndexedDB fallback) */
  url?: string;
  /** SHA-256 hex hash computed incrementally during write (if available) */
  hash?: string;
}

export interface StorageWriter {
  write(chunkIndex: number, data: Uint8Array): Promise<void>;
  close(hash?: string): Promise<StorageWriteResult>;
  abort(): Promise<void>;
  /** Returns the storage backend identifier */
  getBackend(): string;
}

/**
 * Chromium FileSystem Access API Writer.
 * Streams chunks directly to disk via FileSystemWritableFileStream.
 * No IndexedDB, no Blob assembly, zero RAM accumulation.
 */
export class FileSystemAccessWriter implements StorageWriter {
  private writable: FileSystemWritableFileStream;
  private chunkSize: number;
  private closed = false;

  constructor(writable: FileSystemWritableFileStream, chunkSize: number) {
    this.writable = writable;
    this.chunkSize = chunkSize;
  }

  async write(chunkIndex: number, data: Uint8Array): Promise<void> {
    if (this.closed) return;
    // Write at the correct offset to support ordered chunks
    await this.writable.write({
      type: 'write',
      position: chunkIndex * this.chunkSize,
      data: data as unknown as BufferSource
    });
  }

  async close(hash?: string): Promise<StorageWriteResult> {
    if (this.closed) return { mode: 'file-system', hash };
    this.closed = true;
    await this.writable.close();
    return { mode: 'file-system', hash };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writable.abort();
    } catch {
      // ignore abort error if already closed or unsupported
    }
  }

  getBackend(): string {
    return 'file-system-access';
  }
}

/**
 * IndexedDB Fallback Writer.
 * Used when FileSystem Access API is unavailable (Firefox, Safari, Mobile).
 * Stores chunks in IndexedDB, assembles a Blob on close(), returns a download URL.
 */
export class IndexedDbWriter implements StorageWriter {
  private dbName = 'linkdrop-transfers';
  private storeName = 'chunks';
  private transferId: string;
  private totalChunks: number;
  private mimeType: string;
  private db: IDBDatabase | null = null;
  private closed = false;

  constructor(transferId: string, totalChunks: number, mimeType: string, _fileName: string) {
    this.transferId = transferId;
    this.totalChunks = totalChunks;
    this.mimeType = mimeType;
  }

  private initDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async write(chunkIndex: number, data: Uint8Array): Promise<void> {
    if (this.closed) return;
    const db = await this.initDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const key = `${this.transferId}-${chunkIndex}`;
      const req = store.put(data, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async close(hash?: string): Promise<StorageWriteResult> {
    if (this.closed) return { mode: 'blob', hash };
    this.closed = true;
    const db = await this.initDb();

    // Read all chunks in order using a SINGLE IndexedDB transaction
    const chunks = await this.readAllChunks(db);

    // Assemble Blob
    const blob = new Blob(chunks as unknown as BlobPart[], { type: this.mimeType });
    const url = URL.createObjectURL(blob);

    // Use provided hash or compute SHA-256
    let finalHash = hash;
    if (!finalHash) {
      const arrayBuffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      finalHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    // Cleanup DB chunks in background
    this.cleanup(db);

    return { mode: 'blob', url, hash: finalHash };
  }

  async abort(): Promise<void> {
    this.closed = true;
    if (this.db) {
      await this.cleanup(this.db);
    } else {
      try {
        const db = await this.initDb();
        await this.cleanup(db);
      } catch {
        // Ignore init failure during abort
      }
    }
  }

  getBackend(): string {
    return 'indexeddb';
  }

  private readAllChunks(db: IDBDatabase): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const chunks: Uint8Array[] = new Array(this.totalChunks);
      let count = 0;

      for (let i = 0; i < this.totalChunks; i++) {
        const key = `${this.transferId}-${i}`;
        const req = store.get(key);
        const idx = i;
        req.onsuccess = () => {
          if (!req.result) {
            reject(new Error(`Missing chunk at index ${idx}`));
            return;
          }
          chunks[idx] = req.result;
          count++;
          if (count === this.totalChunks) {
            resolve(chunks);
          }
        };
        req.onerror = () => reject(req.error);
      }
    });
  }

  private cleanup(db: IDBDatabase): Promise<void> {
    return new Promise<void>((resolve) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      for (let i = 0; i < this.totalChunks; i++) {
        store.delete(`${this.transferId}-${i}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // swallow cleanup errors
    });
  }
}
