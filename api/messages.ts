import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sessions, cleanupExpired } from './store.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanupExpired();

  if (req.method === 'POST') {
    const { sessionId, senderPeerId, message } = req.body || {};
    if (!sessionId || !senderPeerId || !message) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId, senderPeerId, and message are required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }

    // Relay message to recipient peers
    for (const peer of session.peers) {
      if (peer.peerId !== senderPeerId) {
        if (!session.messages[peer.peerId]) {
          session.messages[peer.peerId] = [];
        }
        session.messages[peer.peerId].push(message);
      }
    }

    return res.status(200).json({ success: true });
  }

  if (req.method === 'GET') {
    const sessionId = req.query.sessionId as string;
    const peerId = req.query.peerId as string;

    if (!sessionId || !peerId) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'sessionId and peerId parameters are required' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }

    const pending = session.messages[peerId] || [];
    session.messages[peerId] = []; // Drain pending queue

    return res.status(200).json({
      messages: pending,
      status: session.status
    });
  }

  return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}
