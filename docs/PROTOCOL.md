# LinkDrop Data Transfer Protocol

This document defines the application-level transfer protocol run over the WebRTC `RTCDataChannel`.

## 1. Protocol Messages (JSON schemas)

All control messages exchanged over the DataChannel are JSON payloads containing the following schema fields.

```typescript
export interface DataChannelMessage {
  type: string;
  payload: any;
}

// 1. Initial Handshake
export interface HelloMessage {
  type: 'HELLO';
  payload: {
    protocolVersion: '1.0.0';
    clientName: string;
  };
}

export interface SessionReadyMessage {
  type: 'SESSION_READY';
  payload: {
    status: 'READY';
  };
}

// 2. Transfer Initialization
export interface TransferMetadata {
  type: 'TRANSFER_METADATA';
  payload: {
    protocolVersion: '1.0.0';
    transferId: string;
    fileId: string;
    filename: string;
    fileSize: number; // Max 2 GB
    mimeType: string;
    fileIndex: number;
    chunkSize: number; // Default 32768 (32 KiB)
    totalChunks: number;
    finalChecksum: string; // SHA-256 Hex Digest
  };
}

// 3. Flow Coordination
export interface FileStart {
  type: 'FILE_START';
  payload: {
    fileId: string;
  };
}

export interface FileEnd {
  type: 'FILE_END';
  payload: {
    fileId: string;
    digest: string; // SHA-256 checksum of received file
  };
}

export interface FileAck {
  type: 'FILE_ACK';
  payload: {
    fileId: string;
    status: 'SUCCESS' | 'CORRUPTED';
  };
}

export interface TransferComplete {
  type: 'TRANSFER_COMPLETE';
  payload: {
    transferId: string;
  };
}

export interface TransferError {
  type: 'TRANSFER_ERROR';
  payload: {
    transferId: string;
    code: 'FILE_TOO_LARGE' | 'STORAGE_ERROR' | 'INTEGRITY_FAILED' | 'TIMEOUT';
    message: string;
  };
}

export interface Cancel {
  type: 'CANCEL';
  payload: {
    transferId: string;
    reason: 'USER_ABORT';
  };
}
```

---

## 2. Binary File Chunk Transfer (Payload Format)

To maximize performance, binary file data chunks are transmitted as raw binary payloads on the reliable data channel instead of being base64-encoded.

```
+-------------------------------------------------------------+
|  Sequence Number  |  Payload Length  |      Raw Bytes       |
|    (4 Bytes)      |    (4 Bytes)     |   (Configurable)     |
+-------------------------------------------------------------+
```

### Binary Segment Schema:

1.  **Sequence Number (Bytes 0-3):** 32-bit Big Endian Unsigned Integer indicating the sequential index of the chunk in the transfer queue.
2.  **Payload Length (Bytes 4-7):** 32-bit Big Endian Unsigned Integer indicating the size of the raw segment (e.g., `32768` for 32 KiB chunks).
3.  **Raw Bytes (Bytes 8+):** The actual slice of file data.

### Constraints:

- **Chunk Size:** Default configuration is set to **32 KiB** (`32768` bytes). This value can be adjusted via environment parameters if testing indicates a need for size adjustment.
- **Packet Verification:** The receiver checks sequence numbers to detect out-of-order execution before writing chunks to storage.
- **Retransmission:** If a gap in sequence numbers is detected, the receiver requests a retransmission of the missing chunks.
- **Checkpoints:** The receiver periodically sends `FILE_ACK` or checkpoint status messages to the sender to confirm receipt of data blocks.
