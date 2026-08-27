# Threat Model & Mitigations

This document outlines the security threats identified for the LinkDrop architecture and details the mitigations implemented to secure the platform.

## 1. Session Threat Analysis

### 1. Brute-Force Code Guessing

- **Threat:** An attacker attempts to join random active sessions by brute-forcing the 6-digit short join code.
- **Mitigation:**
  - The short code is only a lookup key, not the authorization secret.
  - To join a session, the receiver must present the cryptographically random join token.
  - The server limits join attempts to 20 per 10 minutes per IP address. If this limit is exceeded, subsequent attempts are blocked.
  - A session is automatically destroyed after 5 failed join attempts.

### 2. Session Hijacking / Enumeration

- **Threat:** An attacker tries to guess session IDs to intercept metadata or join private connections.
- **Mitigation:**
  - Session IDs are generated using a cryptographically secure pseudo-random number generator (CSPRNG).
  - Session IDs are non-sequential and high-entropy, making them virtually impossible to guess.
  - REST and WebSocket routes require validation of session-scoped access tokens.

### 3. QR Code Theft / Shareable Link Interception

- **Threat:** An attacker intercepts the QR code or shareable link during transmission to unauthorized parties.
- **Mitigation:**
  - Even if the link is intercepted, the sender must manually approve the receiver's connection request.
  - The out-of-band verification code displayed on both screens must be verified manually by the users.
  - Sessions automatically expire after 15 minutes if no transfer begins.

---

## 2. Input & Payload Threat Analysis

### 1. Filename Path Traversal & XSS

- **Threat:** A malicious sender transmits a filename containing directory traversal characters (e.g., `../../etc/passwd`) or script tags (e.g., `<script>alert(1)</script>`) inside the `TRANSFER_METADATA` payload.
- **Mitigation:**
  - The receiver runs the filename through a sanitization function to remove path traversal sequences and convert special characters to HTML entities.
  - UI components use secure text binding to prevent rendering filenames as executable HTML.

### 2. Malformed WebSocket Messages

- **Threat:** An attacker sends oversized or malformed WebSocket payloads to crash the signaling node or exploit memory vulnerabilities.
- **Mitigation:**
  - Signaling servers validate all incoming payloads using Zod schemas.
  - The server enforces a maximum message size limit of 64 KB and terminates connections that exceed this limit.

---

## 3. Infrastructure Threat Analysis

### 1. TURN Server Abuse / Bandwidth Theft

- **Threat:** Attackers scan for LinkDrop TURN servers and route third-party traffic through them, generating high bandwidth costs.
- **Mitigation:**
  - The TURN server requires authentication.
  - Clients request short-lived credentials via an API call. These credentials expire after 15 minutes.
  - The server enforces bandwidth and allocation limits per user IP address.
  - Wildcard credentials are banned.

### 2. Server-side Data Retention / Logs Exposure

- **Threat:** Secrets, tokens, or file metadata are stored in server logs, risking exposure if logs are compromised.
- **Mitigation:**
  - The signaling server does not log sensitive information (such as raw join tokens, secrets, or file names).
  - Redis is configured to keep all data in memory and automatically delete expired session keys.
