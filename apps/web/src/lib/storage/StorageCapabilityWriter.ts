/**
 * StorageCapabilityWriter — Factory and capability detection for StorageWriter backends.
 *
 * Detects browser capabilities at runtime and provides a factory function
 * to create the appropriate StorageWriter implementation.
 */

import { StorageWriter, FileSystemAccessWriter, IndexedDbWriter } from './StorageWriter';

/**
 * Detects whether the File System Access API (showSaveFilePicker) is supported.
 * This API is available in Chromium-based browsers (Chrome, Edge, Opera)
 * but NOT in Firefox, Safari, or mobile browsers.
 */
export function isFileSystemAccessSupported(): boolean {
  const winObj = window as unknown as Record<string, unknown>;
  return typeof winObj.showSaveFilePicker === 'function';
}

export interface StorageWriterOptions {
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
}

export interface CreateStorageWriterResult {
  writer: StorageWriter;
  backend: 'file-system-access' | 'indexeddb';
  /** FileSystemFileHandle for post-transfer access (FSA only) */
  fileHandle?: FileSystemFileHandle;
}

/**
 * Create a StorageWriter using the best available backend.
 *
 * For Chromium: prompts user with showSaveFilePicker() to stream directly to disk.
 * For unsupported browsers: falls back to IndexedDB.
 *
 * @throws If user cancels the file picker (AbortError)
 */
export async function createStorageWriter(
  options: StorageWriterOptions
): Promise<CreateStorageWriterResult> {
  if (isFileSystemAccessSupported()) {
    try {
      const winObj = window as unknown as Record<string, unknown>;
      const pickerFunc = winObj.showSaveFilePicker as (
        opts: unknown
      ) => Promise<FileSystemFileHandle>;

      const extension = options.fileName.includes('.')
        ? '.' + options.fileName.split('.').pop()
        : '';

      const handle = await pickerFunc({
        suggestedName: options.fileName,
        types: extension
          ? [
              {
                description: 'Save File',
                accept: { [options.mimeType]: [extension] }
              }
            ]
          : undefined
      });

      const writable = await handle.createWritable();
      const writer = new FileSystemAccessWriter(writable, options.chunkSize);

      return {
        writer,
        backend: 'file-system-access',
        fileHandle: handle
      };
    } catch (err) {
      // If user cancelled the picker, re-throw so the caller can handle it
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Other FSA errors: fall back to IndexedDB
      console.warn('FSA initialization failed, falling back to IndexedDB:', err);
    }
  }

  // Fallback: IndexedDB
  const writer = new IndexedDbWriter(
    options.transferId,
    options.totalChunks,
    options.mimeType,
    options.fileName
  );

  return {
    writer,
    backend: 'indexeddb'
  };
}

/**
 * Create an IndexedDB fallback writer directly (for use in headless/test environments
 * where FSA is explicitly disabled or unavailable).
 */
export function createFallbackWriter(options: StorageWriterOptions): CreateStorageWriterResult {
  const writer = new IndexedDbWriter(
    options.transferId,
    options.totalChunks,
    options.mimeType,
    options.fileName
  );
  return { writer, backend: 'indexeddb' };
}
