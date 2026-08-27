# Security Architecture & Implementation Rules

This document outlines the security controls, validation processes, and configuration constraints designed to protect the LinkDrop application and its users.

## 1. Session Access & Authentication Architecture

LinkDrop implements a multi-tiered session authorization model to prevent session hijacking and brute-force attacks:

```
[ High-Entropy Session ID (CSPRNG) ]
                +
[ High-Entropy Join Token (Base64Url) ]  <=== Scanned via QR Code / Shared Link
                +
[ Short Human-Readable Code (6-digit PIN) ] <=== Convenience lookup mapping
                +
[ Out-of-band Verification Code (SAS) ] <=== Manual human confirmation
```

### Security Rules:

- **No Short-Code Authorization:** The 6-digit PIN is a convenience lookup identifier used to locate the session mapping on the signaling server. It is **never** used as the sole credential. Access requires a high-entropy join token.
- **High-Entropy QR Codes:** The QR code contains the full session URL including the cryptographically secure join token.
- **Out-of-Band Verification:** Once connected, both peers must display and confirm a matching 3-digit human verification code (Short Authentication String) before WebRTC connection setup begins.
- **Server-Side Expiry:** Session expiration is enforced on the server using Redis TTL parameters. Client-side timers are for UX display only.

---

## 2. Transport Encryption & E2E Claims

> [!IMPORTANT]
> **WebRTC DTLS/SCTP provides transport encryption. The application must not claim custom end-to-end encryption unless independently implemented and audited.**

- **Transport Protection:** Signaling communication is encrypted via secure WebSockets (`wss://`). WebRTC peer connections are encrypted using DTLS-SRTP, ensuring data protection against third-party interception on the network path.
- **TURN Traffic:** When using a TURN relay, the relay server routes encrypted DTLS packet streams but does not terminate the DTLS cryptographic connection.
- **No Custom Cryptography:** LinkDrop relies strictly on standardized browser Web Crypto APIs and WebRTC protocols. The development of custom encryption wrapper algorithms is forbidden.

---

## 3. Strict Input & Message Validation

To prevent cross-site scripting (XSS), injection, and buffer overflow attacks:

- **Safe Filename Handling:** Receiver sanitizes and escapes all filenames received in metadata. Filename validation strips path traversal sequences (e.g., `../`, `..\\`) and permits only safe alphanumeric characters.
- **Runtime Schema Validation:** All WebSocket messages and REST API payloads are validated against strict Zod schemas on arrival. The server discards malformed payloads immediately.
- **Fail-Closed Principle:** If any validation check, signature verification, or checksum calculation fails, the session is terminated and state is cleaned up.
- **Log Redaction:** Loggers must not record sensitive metadata (such as raw join tokens, secrets, or file contents).
