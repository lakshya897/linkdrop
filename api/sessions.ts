import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sessions, pinToSessionId, generatePin, cleanupExpired } from './store.js';
import { randomUUID } from 'crypto';

export default function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanupExpired();

  if (req.method === 'POST') {
    const { creatorPeerId } = req.body || {};
    if (!creatorPeerId || typeof creatorPeerId !== 'string') {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'creatorPeerId is required' });
    }

    const sessionId = randomUUID();
    const pairingPin = generatePin();
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;

    const session = {
      sessionId,
      pairingPin,
      creatorPeerId,
      status: 'CREATED' as const,
      peers: [{ peerId: creatorPeerId, role: 'sender' as const, connected: true }],
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

  if (req.method === 'GET') {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId query parameter is required' });
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

  return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}
