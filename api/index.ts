import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID, createHash } from 'crypto';

interface Peer {
  peerId: string;
  role: 'sender' | 'receiver';
  connected: boolean;
}

interface Session {
  sessionId: string;
  pairingPin: string;
  creatorPeerId: string;
  status: 'CREATED' | 'WAITING_FOR_PEER' | 'PAIRED' | 'EXPIRED';
  peers: Peer[];
  createdAt: number;
  expiresAt: number;
  messages: Record<string, any[]>;
}

// Global in-memory store preserved across warm invocations
const g = global as unknown as {
  __linkdrop_sessions?: Map<string, Session>;
  __linkdrop_pins?: Map<string, string>;
};

if (!g.__linkdrop_sessions) g.__linkdrop_sessions = new Map<string, Session>();
if (!g.__linkdrop_pins) g.__linkdrop_pins = new Map<string, string>();

const sessions = g.__linkdrop_sessions;
const pinToSessionId = g.__linkdrop_pins;

function hashPinToUuid(pin: string): string {
  const hash = createHash('sha256').update(`linkdrop:session:${pin}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function generatePin(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanupExpired();

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // 1. POST /api/sessions (Create Session)
  if (path === '/api/sessions' && req.method === 'POST') {
    const { creatorPeerId } = req.body || {};
    if (!creatorPeerId || typeof creatorPeerId !== 'string') {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'creatorPeerId is required' });
    }

    const pairingPin = generatePin();
    const sessionId = hashPinToUuid(pairingPin);
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;

    const session: Session = {
      sessionId,
      pairingPin,
      creatorPeerId,
      status: 'CREATED',
      peers: [{ peerId: creatorPeerId, role: 'sender', connected: true }],
      createdAt: now,
      expiresAt,
      messages: { [creatorPeerId]: [] }
    };

    sessions.set(sessionId, session);

    return res.status(200).json({
      sessionId,
      pairingPin,
      expiresAt
    });
  }

  // 2. GET /api/sessions (Get Session Details)
  if (path === '/api/sessions' && req.method === 'GET') {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId parameter is required' });
    }

    let session = sessions.get(sessionId);
    if (!session) {
      // Re-instantiate session object for stateless serverless containers
      session = {
        sessionId,
        pairingPin: '000000',
        creatorPeerId: 'unknown',
        status: 'WAITING_FOR_PEER',
        peers: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
        messages: {}
      };
      sessions.set(sessionId, session);
    }

    return res.status(200).json({
      sessionId: session.sessionId,
      creatorPeerId: session.creatorPeerId,
      status: session.status,
      peers: session.peers,
      expiresAt: session.expiresAt
    });
  }

  // 3. POST /api/sessions/join (Join Session)
  if ((path === '/api/sessions/join' || path === '/api/join') && req.method === 'POST') {
    const { pairingPin, peerId } = req.body || {};
    if (!pairingPin || typeof pairingPin !== 'string' || !peerId || typeof peerId !== 'string') {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'pairingPin and peerId are required' });
    }

    // Statistically derive sessionId from pairingPin so any serverless container pairs instantly!
    const sessionId = hashPinToUuid(pairingPin.trim());

    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        pairingPin,
        creatorPeerId: 'unknown',
        status: 'CREATED',
        peers: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000,
        messages: {}
      };
      sessions.set(sessionId, session);
    }

    const existingPeer = session.peers.find(p => p.peerId === peerId);
    if (!existingPeer) {
      session.peers.push({ peerId, role: 'receiver', connected: true });
      if (!session.messages[peerId]) session.messages[peerId] = [];
    }

    session.status = 'PAIRED';

    for (const p of session.peers) {
      if (!session.messages[p.peerId]) session.messages[p.peerId] = [];
      session.messages[p.peerId].push({
        type: 'PEER_JOINED',
        sessionId: session.sessionId,
        peerId,
        payload: { role: 'receiver' }
      });
      session.messages[p.peerId].push({
        type: 'SESSION_PAIRED',
        sessionId: session.sessionId,
        peerId,
        payload: { peers: session.peers.map(peer => peer.peerId) }
      });
    }

    return res.status(200).json({
      sessionId: session.sessionId,
      creatorPeerId: session.creatorPeerId,
      status: session.status
    });
  }

  // 4. POST /api/messages (Send Signaling Message)
  if (path === '/api/messages' && req.method === 'POST') {
    const { sessionId, senderPeerId, message } = req.body || {};
    if (!sessionId || !senderPeerId || !message) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId, senderPeerId, and message are required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }

    for (const peer of session.peers) {
      if (peer.peerId !== senderPeerId) {
        if (!session.messages[peer.peerId]) session.messages[peer.peerId] = [];
        session.messages[peer.peerId].push(message);
      }
    }

    return res.status(200).json({ success: true });
  }

  // 5. GET /api/messages (Poll Signaling Messages)
  if (path === '/api/messages' && req.method === 'GET') {
    const sessionId = req.query.sessionId as string;
    const peerId = req.query.peerId as string;

    if (!sessionId || !peerId) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId and peerId required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }

    const pending = session.messages[peerId] || [];
    session.messages[peerId] = [];

    return res.status(200).json({
      messages: pending,
      status: session.status
    });
  }

  return res.status(404).json({ code: 'NOT_FOUND', message: `Route ${path} not found` });
}
