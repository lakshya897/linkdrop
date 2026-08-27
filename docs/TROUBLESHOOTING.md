# Diagnostics & Troubleshooting

This document defines the diagnostic metrics, troubleshooting processes, and logging rules for the LinkDrop platform.

## 1. Allowed Diagnostic Metrics & Logging Rules

To protect user privacy, LinkDrop logs strictly technical performance indicators.

### Allowed Metrics:

- **Session Lifecycle Events:** Creation, join, state changes, expiry, and connection closure.
- **Connection Mode:** Indicates whether the active WebRTC path is `direct` or `relay`.
- **Throughput & Duration:** Bytes transferred, elapsed transfer time, and current transfer speed (MB/s).
- **Error Category:** Error codes (e.g., `WEBRTC_NEGOTIATION_FAILED`, `STORAGE_ERROR`, `FILE_TOO_LARGE`).
- **Browser & Platform:** Client user-agent indicators (e.g., Chrome/Android, Safari/iOS).

### Strictly Banned from Logs:

- **Raw Join Tokens:** Cryptographic join tokens are never logged.
- **Session Secrets:** Verification codes and authentication credentials.
- **File Names & Contents:** File names, extensions, and raw payload bytes are never logged.
- **Secret-Bearing URLs:** Query parameters containing access tokens.

---

## 2. Diagnostic Report Schema

LinkDrop generates a structured JSON report to help users diagnose connection issues:

```json
{
  "timestamp": 1785265000000,
  "transferId": "tx-89e472a1-cf10-41e1-88f2-bc8271e1a82f",
  "connection": {
    "mode": "relay",
    "candidatePair": "relay-relay",
    "rttMs": 48,
    "iceState": "connected"
  },
  "metrics": {
    "chunkSize": 32768,
    "bytesSent": 524288000,
    "bytesReceived": 524288000,
    "durationMs": 14200
  },
  "diagnostics": {
    "bottleneck": "NETWORK",
    "retransmissions": 4
  }
}
```

### Bottleneck Identification States:

1.  **`FILE_READ`:** Input file reading speed is slower than network capacity.
2.  **`NETWORK`:** WebRTC data channel queue is full (monitored via `bufferedAmount`).
3.  **`DISK_WRITE`:** Receiving disk write speeds block block validation loops.
4.  **`NONE`:** System operates at maximum network throughput.
