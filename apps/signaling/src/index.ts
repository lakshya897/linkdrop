import fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { z } from 'zod';
import { 
  PROTOCOL_VERSION, 
  JoinSessionRequestSchema, 
  SignalingMessageSchema, 
  SafeSessionState 
} from '@linkdrop/protocol';
import { LinkDropError } from '@linkdrop/shared';
import { SessionManager } from './session.js';
import { InMemoryRateLimiter } from './rateLimit.js';

const server = fastify({ logger: true });

// Register CORS
await server.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

// 1. Register WebSockets
await server.register(websocket);

// 2. Instantiate managers
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const sessionManager = new SessionManager(SESSION_TTL_MS);

const maxCreations = process.env.NODE_ENV === 'production' ? 10 : 10000;
const sessionCreateLimiter = new InMemoryRateLimiter(maxCreations, 60 * 60 * 1000);
const pinGuessLimiter = new InMemoryRateLimiter(50, 10 * 60 * 1000);

// 3. Error Handling hook
server.setErrorHandler((error, _request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (error instanceof LinkDropError) {
    reply.status(error.statusCode).send({
      code: error.code,
      message: error.message
    });
  } else if (error.validation) {
    reply.status(400).send({
      code: 'INVALID_REQUEST',
      message: error.message
    });
  } else {
    server.log.error(error);
    reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'An internal server error occurred'
    });
  }
});

// 4. REST Routes
server.get('/health', async () => {
  return { status: 'ok', protocolVersion: PROTOCOL_VERSION };
});

server.get('/error-test', async () => {
  throw new LinkDropError('TEST_ERROR', 'This is a test error primitive', 400);
});

server.post('/api/sessions', async (request) => {
  const ip = request.ip;
  sessionCreateLimiter.check(ip);

  const bodySchema = z.object({ creatorPeerId: z.string().uuid() });
  const result = bodySchema.safeParse(request.body);
  if (!result.success) {
    throw new LinkDropError('INVALID_REQUEST', 'Invalid creatorPeerId', 400);
  }

  const session = sessionManager.createSession(result.data.creatorPeerId);
  return {
    sessionId: session.sessionId,
    pairingPin: session.pairingPin,
    expiresAt: session.expiresAt
  };
});

server.get('/api/sessions/:sessionId', async (request) => {
  const paramsSchema = z.object({ sessionId: z.string().uuid() });
  const paramsResult = paramsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    throw new LinkDropError('INVALID_REQUEST', 'Invalid sessionId', 400);
  }

  const session = sessionManager.getSession(paramsResult.data.sessionId);
  if (!session) {
    throw new LinkDropError('SESSION_NOT_FOUND', 'Session not found or expired', 404);
  }

  const safePeers = session.peers.map(p => ({
    peerId: p.peerId,
    role: p.role,
    connected: p.connected
  }));

  const response: SafeSessionState = {
    sessionId: session.sessionId,
    creatorPeerId: session.creatorPeerId,
    status: session.status,
    peers: safePeers,
    expiresAt: session.expiresAt
  };
  return response;
});

server.post('/api/sessions/join', async (request) => {
  const ip = request.ip;
  pinGuessLimiter.check(ip);

  const result = JoinSessionRequestSchema.safeParse(request.body);
  if (!result.success) {
    throw new LinkDropError('INVALID_REQUEST', 'Invalid join parameters', 400);
  }

  const { pairingPin, peerId } = result.data;
  const session = sessionManager.joinSession(pairingPin, peerId);

  // Successfully joined, reset limit
  pinGuessLimiter.reset(ip);

  return {
    sessionId: session.sessionId,
    creatorPeerId: session.creatorPeerId,
    status: session.status
  };
});

// 5. WebSocket Handler
server.route({
  method: 'GET',
  url: '/ws/signaling/:sessionId/:peerId',
  handler: async (_request, reply) => {
    // Standard HTTP route fallback if websocket is not used
    reply.status(400).send({ error: 'WebSocket connection required' });
  },
  wsHandler: async (connection, request) => {
    const paramsSchema = z.object({
      sessionId: z.string().uuid(),
      peerId: z.string().uuid()
    });

    const paramsResult = paramsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      connection.socket.close(4000, 'Invalid parameters');
      return;
    }

    const { sessionId, peerId } = paramsResult.data;
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      connection.socket.close(4001, 'Session not found or expired');
      return;
    }

    const peer = session.peers.find(p => p.peerId === peerId);
    if (!peer) {
      connection.socket.close(4002, 'Peer not authorized for this session');
      return;
    }

    // Register active websocket
    sessionManager.addConnection(sessionId, peerId, connection);

    // Notify other peers in session that we joined
    sessionManager.broadcast(sessionId, {
      type: 'PEER_JOINED',
      sessionId,
      peerId,
      payload: { role: peer.role }
    }, peerId);

    // If session is fully paired, send pairing verification
    if (session.status === 'PAIRED') {
      sessionManager.broadcast(sessionId, {
        type: 'SESSION_PAIRED',
        sessionId,
        peerId,
        payload: { peers: session.peers.map(p => p.peerId) }
      });
    }

    // Handle incoming messages
    connection.socket.on('message', (rawData) => {
      try {
        // Enforce frame size limit of 4KB
        if (rawData instanceof Buffer && rawData.length > 4096) {
          connection.socket.send(JSON.stringify({
            type: 'SESSION_ERROR',
            sessionId,
            peerId,
            payload: { code: 'INVALID_MESSAGE', message: 'Message size limit exceeded (max 4KB)' }
          }));
          return;
        }

        const dataStr = rawData.toString();
        const json = JSON.parse(dataStr);
        
        // Prevent binary/file relay
        if (json.payload && (json.payload.fileBytes || json.payload.binary || json.payload.data instanceof ArrayBuffer || json.payload.type === 'binary')) {
          connection.socket.send(JSON.stringify({
            type: 'SESSION_ERROR',
            sessionId,
            peerId,
            payload: { code: 'INVALID_MESSAGE', message: 'Binary payloads are not permitted on the signaling channel' }
          }));
          return;
        }

        const parsed = SignalingMessageSchema.safeParse(json);
        if (!parsed.success) {
          console.error('[SIGNALLING INVALID MESSAGE ERROR]', parsed.error);
          console.error('[SIGNALLING INVALID MESSAGE RAW]', JSON.stringify(json));
          connection.socket.send(JSON.stringify({
            type: 'SESSION_ERROR',
            sessionId,
            peerId,
            payload: { code: 'INVALID_MESSAGE', message: 'Malformed message format' }
          }));
          return;
        }

        const msg = parsed.data;

        // Process message type
        if (msg.type === 'PING') {
          connection.socket.send(JSON.stringify({
            type: 'PONG',
            sessionId,
            peerId
          }));
          return;
        }

        if (msg.type === 'PONG') {
          const conns = sessionManager.getActiveConnections(sessionId);
          const conn = conns.find(c => c.peerId === peerId);
          if (conn) {
            conn.isAlive = true;
            console.log(`[PONG] Received from peer=${peerId}, marked isAlive=true`);
          } else {
            console.log(`[PONG] Received from peer=${peerId}, but conn NOT FOUND`);
          }
          return;
        }

        // Standard message relay to the other peer in the same session
        sessionManager.broadcast(sessionId, msg, peerId);

      } catch (err) {
        connection.socket.send(JSON.stringify({
          type: 'SESSION_ERROR',
          sessionId,
          peerId,
          payload: { code: 'INVALID_MESSAGE', message: 'Invalid JSON payload' }
        }));
      }
    });

    // Connection cleanup on close
    connection.socket.on('close', () => {
      sessionManager.removeConnection(sessionId, peerId);
      sessionManager.broadcast(sessionId, {
        type: 'PEER_LEFT',
        sessionId,
        peerId
      }, peerId);
    });

    // Error handling
    connection.socket.on('error', (err) => {
      server.log.error(err);
      connection.socket.close();
    });
  }
});

// 6. Set up periodic sweeps & heartbeats
setInterval(() => {
  sessionManager.sweepExpired();
  sessionCreateLimiter.cleanupExpired();
  pinGuessLimiter.cleanupExpired();
}, 15000);

// Heartbeat validation (every 10 seconds check WebSocket aliveness)
setInterval(() => {
  sessionManager.runHeartbeatChecks();
}, 10000);

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Signaling server running on port ${port} (protocol version ${PROTOCOL_VERSION})`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// Start server if this is the main module
if (import.meta.url.startsWith('file:')) {
  const modulePath = new URL(import.meta.url).pathname;
  const scriptPath = process.argv[1];
  if (modulePath.includes(scriptPath) || scriptPath?.endsWith('index.js')) {
    start();
  }
}

export { server, sessionManager };
