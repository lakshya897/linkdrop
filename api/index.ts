import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';

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

function generatePin(): string {
  let pin = '';
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (pinToSessionId.has(pin));
  return pin;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      pinToSessionId.delete(session.pairingPin);
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

    const sessionId = randomUUID();
    const pairingPin = generatePin();
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
    pinToSessionId.set(pairingPin, sessionId);

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

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found or expired' });
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

    const sessionId = pinToSessionId.get(pairingPin);
    if (!sessionId) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Invalid or expired pairing PIN' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }

    const existingPeer = session.peers.find(p => p.peerId === peerId);
    if (!existingPeer) {
      session.peers.push({ peerId, role: 'receiver', connected: true });
      session.messages[peerId] = [];
    }

    if (session.peers.length >= 2) {
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
    } else {
      session.status = 'WAITING_FOR_PEER';
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
