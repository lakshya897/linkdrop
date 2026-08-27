# Session & Signaling API Specification

This document details the API endpoints, payloads, WebSocket communication envelopes, and Redis state mapping for the LinkDrop signaling service.

## 1. REST API endpoints

All REST API endpoints validate inputs using runtime schema validation (e.g., Zod) and return JSON responses.

### 1. Create Ephemeral Session

Creates an ephemeral transfer session on the server.

- **Path:** `POST /api/sessions`
- **Request Payload:**
  ```json
  {
    "files": [
      {
        "name": "project_archive.zip",
        "size": 524288000,
        "mime": "application/zip"
      }
    ]
  }
  ```
- **Response Payload (201 Created):**
  ```json
  {
    "sessionId": "sess-a94f8e02-b2d9-4f76-88a4-39f99e3a6cd4",
    "joinToken": "tok-7c82a1739f72b64a82cd739fbc8271e1a8",
    "joinCode": "384920",
    "expiresAt": 1785265200000
  }
  ```

### 2. Join Session

Validates a join token and returns session access keys.

- **Path:** `POST /api/sessions/join`
- **Request Payload:**
  ```json
  {
    "joinToken": "tok-7c82a1739f72b64a82cd739fbc8271e1a8"
  }
  ```
- **Response Payload (200 OK):**
  ```json
  {
    "sessionId": "sess-a94f8e02-b2d9-4f76-88a4-39f99e3a6cd4",
    "participantId": "part-9f72b64a-28cd-41e1-88f2-bc8271e1a82f",
    "expiresAt": 1785265200000
  }
  ```

### 3. Get Session Status

Retrieves the sanitized state of the session. Does not return tokens or codes.

- **Path:** `GET /api/sessions/:id/status`
- **Response Payload (200 OK):**
  ```json
  {
    "sessionId": "sess-a94f8e02-b2d9-4f76-88a4-39f99e3a6cd4",
    "status": "WAITING_FOR_RECEIVER",
    "expiresAt": 1785265200000,
    "files": [
      {
        "name": "project_archive.zip",
        "size": 524288000
      }
    ]
  }
  ```

### 4. Cancel Session

Explicitly cancels a session and deletes its ephemeral state.

- **Path:** `POST /api/sessions/:id/cancel`
- **Response Payload (204 No Content):**
  - _Empty response._

---

## 2. WebSocket Signaling Protocol (`WSS /ws`)

The WebSocket interface is used to exchange connection metadata (SDP and ICE). Clients must authenticate using a short-lived token generated during the API call.

### Signaling Envelope Structure:

```json
{
  "type": "MESSAGE_TYPE",
  "sessionId": "sess-a94f8e02-b2d9-4f76-88a4-39f99e3a6cd4",
  "messageId": "msg-88d1234b-cf10-482a-a92f-b4812a7f8b91",
  "timestamp": 1785265000000,
  "payload": {}
}
```

### Allowed Messages Types:

- `SESSION_JOINED`: Sent to the sender when the receiver joins.
- `PEER_READY`: Indicates that a peer has initialized its local WebRTC stack.
- `OFFER` / `ANSWER`: Relays SDP parameters.
- `ICE_CANDIDATE`: Relays connectivity paths.
- `VERIFICATION_CODE`: Coordinates out-of-band verification checks.
- `VERIFY`: Confirms out-of-band verification approval.
- `TRANSFER_READY` / `TRANSFER_CANCEL` / `TRANSFER_ERROR`: Coordinates state transitions.
- `SESSION_EXPIRED`: Sent when the session TTL is reached.
- `PING` / `PONG`: Monitors connection liveness.

---

## 3. Ephemeral Redis State Management

LinkDrop uses Redis to coordinate sessions across multiple server instances. The server does not use a persistent database (e.g., PostgreSQL). All state is ephemeral and backed by TTL expiration.

### Redis Key Schemas:

1.  **Session Metadata:** `session:metadata:{sessionId}` (Hash)
    - _Fields:_ `files`, `expiresAt`, `status`, `senderId`, `receiverId`.
    - _TTL:_ 15 minutes (or 60 minutes for active transfers).
2.  **Join Code Mapping:** `session:join_code:{joinCode}` (String)
    - _Value:_ `{joinToken}` (resolves code to token).
    - _TTL:_ 15 minutes.
3.  **Join Token Mapping:** `session:join_token:{joinToken}` (String)
    - _Value:_ `{sessionId}`.
    - _TTL:_ 15 minutes.
4.  **Rate Limiter Counter:** `rate_limit:{ip}:{action}` (String)
    - _Value:_ Integer counter.
    - _TTL:_ Rolling window.
