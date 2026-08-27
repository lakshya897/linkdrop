# Deployment Architecture & Configuration

This document describes the production deployment topology, infrastructure requirements, and environment variables configuration for LinkDrop.

## 1. Production Topology

LinkDrop separates frontend static asset hosting, signaling logic, and TURN relay routing to optimize cost and performance:

```
                          DNS Record
                              |
                       HTTPS Requests
                              |
                    Reverse Proxy / Ingress
                    (Cloudflare / Ingress)
                     /                  \
                    v                    v
          [ Frontend Assets ]   [ API & WebSocket ]
          (Static CDN / Vercel)  (Node.js App Server)
                                         |
                                         v
                                  [ Redis Cache ]
                               (Ephemeral session state)
```

### Components:

- **Frontend Client:** Compiled to static HTML/JS/CSS assets and distributed via a CDN (e.g., Vercel, Netlify, or Cloudflare Pages) for fast load times.
- **Signaling Server:** A stateless Node.js container (e.g., Fastify on AWS ECS Fargate or Fly.io) managing WebSocket connections.
- **TURN Server:** Deployed on separate virtual machines (e.g., hardened coturn on AWS EC2 or utilizing a managed service like Twilio).
- **Redis State Store:** Ephemeral memory cache coordinating websocket messages across multiple server nodes.

---

## 2. Environment Variables Specification

The signaling server requires the following configuration values:

| Variable                       | Description                                                    | Default / Example                 |
| :----------------------------- | :------------------------------------------------------------- | :-------------------------------- |
| `NODE_ENV`                     | Mode of operation.                                             | `production` / `development`      |
| `PORT`                         | Local network port.                                            | `3000`                            |
| `PUBLIC_BASE_URL`              | Domain address of the web application.                         | `https://linkdrop.app`            |
| `REDIS_URL`                    | Connection string for Redis.                                   | `redis://localhost:6379`          |
| `TURN_URLS`                    | Array of TURN server hosts.                                    | `["turn:turn.linkdrop.app:3478"]` |
| `TURN_CREDENTIAL_ISSUER`       | Identifier for the TURN authorization issuer.                  | `linkdrop-issuer`                 |
| `TURN_SECRET`                  | Shared secret key for generating short-lived TURN credentials. | _Keep secret_                     |
| `SESSION_TTL_SECONDS`          | Time-to-live for a waiting session.                            | `900` (15 minutes)                |
| `ACTIVE_SESSION_TTL_SECONDS`   | Maximum duration of an active transfer session.                | `3600` (60 minutes)               |
| `MAX_FILE_SIZE_BYTES`          | Maximum file size allowed.                                     | `2147483648` (2 GB)               |
| `MAX_SESSION_BYTES`            | Maximum total bytes allowed per session.                       | `2147483648` (2 GB)               |
| `MAX_FILE_COUNT`               | Maximum number of files per session.                           | `50`                              |
| `CHUNK_SIZE_BYTES`             | Size of binary data segments.                                  | `32768` (32 KiB)                  |
| `DATA_CHANNEL_HIGH_WATER_MARK` | Buffer limit to pause transmission.                            | `4194304` (4 MiB)                 |
| `DATA_CHANNEL_LOW_WATER_MARK`  | Buffer limit to resume transmission.                           | `1048576` (1 MiB)                 |
| `RATE_LIMIT_SESSION_CREATE`    | Rate limit for creating sessions per IP.                       | `10/hour`                         |
| `RATE_LIMIT_JOIN`              | Rate limit for joining sessions per IP.                        | `20/10min`                        |
| `RATE_LIMIT_VERIFY`            | Maximum verification attempts per session.                     | `5`                               |
| `ALLOWED_ORIGINS`              | CORS allowed origins.                                          | `["https://linkdrop.app"]`        |
