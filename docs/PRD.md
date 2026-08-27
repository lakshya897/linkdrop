# Product Requirements Document (PRD)

## 1. Product Definition & MVP Goal

LinkDrop is a privacy-first, cross-platform file handoff service that allows two people to transfer files directly between devices with zero setup, zero configuration, no account creation, and no native app installation.

- **MVP Goal:** Prove that two users can transfer files between different OS ecosystems (specifically Android and iOS) without using permanent server-side storage or relaying binary payload data through WebSockets.
- **Primary Validation Flow:** Latest stable Android Chrome -> Latest stable iOS Safari, across different networks (cellular/Wi-Fi).
- **Core Principle:** Users think about the device they want to send to, not the operating system.

---

## 2. MVP Scope (Must Build vs. Future)

### MUST HAVE (MVP Scope)

- **Responsive Web Application:** Client-side SPA built with React + TypeScript + Vite.
- **Pairing Protocols:** QR-code-based pairing (carrying high-entropy join URLs) and manual short human-readable join codes.
- **Out-of-band Verification:** A short confirmation code displayed on both screens for human-in-the-loop verification.
- **Ephemeral Session Management:** WebSocket-based signaling layer backed by Redis for temporary session state coordination.
- **WebRTC DataChannel Transfer:** Direct P2P transfer utilizing STUN and authenticated TURN relays.
- **DataChannel Backpressure:** Bounded chunk sending flow control based on data channel buffer state.
- **SHA-256 Integrity Verification:** Client-side incremental hashing and final checksum validation.
- **Configurable Limits:** Initial MVP limits:
  - Maximum file size: **2 GB**
  - Maximum session byte quota: **2 GB**
  - Maximum file count per session: **50**
- **Reconnection Logic:** Support for resuming transfer if connection is temporarily lost, provided both browser tabs remain open.

### NOT IN MVP (Future Roadmap)

- **Persistent Resume:** Resuming transfers after closing or reloading the browser (V1.1).
- **Native Platforms:** Native Android/iOS applications, Share Sheet extensions, background transfer systems (V1.1/V1.5/V2.0).
- **Multi-User Features:** Group distribution, broadcast rooms, public QR drops, or contact lists.
- **Accounts & Persistence:** User registration, billing systems, database integration, or history logs.

---

## 3. Target User Journeys

1.  **Sender Flow:**
    - Opens LinkDrop -> Selects files (validated against limits) -> Creates ephemeral session.
    - Displays QR code, short code, and session URL -> Expiry countdown starts (15 min default).
    - Wait for receiver connection.
    - Displays receiver information (device/browser) and verification code.
    - Confirms verification code matches.
    - P2P channel negotiates (Direct if possible, TURN relay fallback).
    - Streams chunks, displays progress, rates, and connection status.
    - SHA-256 validation completes -> Ends/expires session.
2.  **Receiver Flow:**
    - Scans QR code (or enters join code) -> Establishes connection to signaling server.
    - Prompts receiver to accept incoming file name/size.
    - Displays verification code matching the sender's.
    - Accepts transfer -> WebRTC negotiates -> Receives binary chunks.
    - Saves chunk data to sandboxed browser storage.
    - Finalizes file -> Triggers native browser download dialog on success -> Closes session.
