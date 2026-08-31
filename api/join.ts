import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sessions, pinToSessionId, cleanupExpired } from './store.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanupExpired();

  if (req.method === 'POST') {
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

      // Push PEER_JOINED and SESSION_PAIRED event messages for both peers
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

  return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}
