import crypto from 'crypto';
import { Session, Peer } from '@linkdrop/protocol';
import { LinkDropError } from '@linkdrop/shared';
import { SocketStream } from '@fastify/websocket';

// Local interface mapping socket connections to sessions
export interface ActiveConnection {
  socket: SocketStream;
  peerId: string;
  isAlive: boolean;
  missedHeartbeats: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private pinToSessionId = new Map<string, string>();
  // Maps sessionId -> array of active connections
  private connections = new Map<string, ActiveConnection[]>();
  
  constructor(private readonly sessionTtlMs: number) {}

  createSession(creatorPeerId: string): Session {
    const sessionId = crypto.randomUUID();
    const pairingPin = this.generateUniquePin();
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;

    const creatorPeer: Peer = {
      peerId: creatorPeerId,
      role: 'sender',
      connected: false,
      joinedAt: now,
      lastSeen: now
    };

    const session: Session = {
      sessionId,
      pairingPin,
      creatorPeerId,
      peers: [creatorPeer],
      status: 'CREATED',
      createdAt: now,
      expiresAt,
      maxPeers: 2
    };

    this.sessions.set(sessionId, session);
    this.pinToSessionId.set(pairingPin, sessionId);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    
    // Check expiry
    if (Date.now() > session.expiresAt) {
      this.destroySession(sessionId, 'SESSION_EXPIRED');
      return undefined;
    }
    return session;
  }

  getSessionByPin(pin: string): Session | undefined {
    const sessionId = this.pinToSessionId.get(pin);
    if (!sessionId) return undefined;
    return this.getSession(sessionId);
  }

  joinSession(pin: string, peerId: string): Session {
    const session = this.getSessionByPin(pin);
    if (!session) {
      throw new LinkDropError('SESSION_NOT_FOUND', 'Session not found or expired', 404);
    }

    if (Date.now() > session.expiresAt || session.status === 'EXPIRED') {
      throw new LinkDropError('SESSION_EXPIRED', 'Session has expired', 400);
    }

    if (session.peers.length >= session.maxPeers) {
      throw new LinkDropError('SESSION_FULL', 'Session is already full', 400);
    }

    const peerExists = session.peers.some(p => p.peerId === peerId);
    if (peerExists) {
      throw new LinkDropError('ALREADY_JOINED', 'Peer has already joined this session', 400);
    }

    const now = Date.now();
    const newPeer: Peer = {
      peerId,
      role: 'receiver',
      connected: false,
      joinedAt: now,
      lastSeen: now
    };

    session.peers.push(newPeer);
    session.status = 'WAITING_FOR_PEER'; // Wait for websocket connection
    
    return session;
  }

  addConnection(sessionId: string, peerId: string, socket: SocketStream) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const peer = session.peers.find(p => p.peerId === peerId);
    if (!peer) return;

    peer.connected = true;
    peer.lastSeen = Date.now();

    const conns = this.connections.get(sessionId) || [];
    // Remove stale connection for same peer if exists
    const filtered = conns.filter(c => c.peerId !== peerId);
    filtered.push({ socket, peerId, isAlive: true, missedHeartbeats: 0 });
    this.connections.set(sessionId, filtered);

    // Update status
    if (session.peers.length === 2 && session.peers.every(p => p.connected)) {
      session.status = 'PAIRED';
    } else {
      session.status = 'WAITING_FOR_PEER';
    }
  }

  removeConnection(sessionId: string, peerId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const peer = session.peers.find(p => p.peerId === peerId);
      if (peer) {
        peer.connected = false;
      }
      if (session.peers.every(p => !p.connected)) {
        // If all disconnected, trigger cleanup/destruction
        this.destroySession(sessionId, 'PEER_DISCONNECTED');
        return;
      }
      session.status = 'WAITING_FOR_PEER';
    }

    const conns = this.connections.get(sessionId);
    if (conns) {
      const filtered = conns.filter(c => c.peerId !== peerId);
      if (filtered.length === 0) {
        this.connections.delete(sessionId);
      } else {
        this.connections.set(sessionId, filtered);
      }
    }
  }

  broadcast(sessionId: string, message: unknown, excludePeerId?: string) {
    const conns = this.connections.get(sessionId);
    if (!conns) return;
    
    const payload = JSON.stringify(message);
    for (const conn of conns) {
      if (conn.peerId !== excludePeerId && conn.socket.socket.readyState === 1 /* OPEN */) {
        conn.socket.socket.send(payload);
      }
    }
  }

  destroySession(sessionId: string, reasonCode: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Notify remaining connections
    this.broadcast(sessionId, {
      type: 'SESSION_ERROR',
      sessionId,
      peerId: session.creatorPeerId,
      payload: { code: reasonCode, message: 'Session closed' }
    });

    // Close sockets
    const conns = this.connections.get(sessionId);
    if (conns) {
      for (const conn of conns) {
        try {
          conn.socket.socket.close();
        } catch {
          // ignore
        }
      }
      this.connections.delete(sessionId);
    }

    this.pinToSessionId.delete(session.pairingPin);
    this.sessions.delete(sessionId);
  }

  getActiveConnections(sessionId: string): ActiveConnection[] {
    return this.connections.get(sessionId) || [];
  }

  sweepExpired() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.destroySession(sessionId, 'SESSION_EXPIRED');
      }
    }
  }

  runHeartbeatChecks() {
    for (const [sessionId, conns] of this.connections.entries()) {
      for (const conn of conns) {
        if (!conn.isAlive) {
          conn.missedHeartbeats++;
          console.log(`[HEARTBEAT] peer=${conn.peerId} isAlive=false missed=${conn.missedHeartbeats}`);
          if (conn.missedHeartbeats >= 3) {
            console.log(`[HEARTBEAT] TERMINATING peer=${conn.peerId} after ${conn.missedHeartbeats} missed heartbeats`);
            try {
              conn.socket.socket.terminate();
            } catch {
              // ignore
            }
            continue;
          }
        } else {
          conn.missedHeartbeats = 0;
          console.log(`[HEARTBEAT] peer=${conn.peerId} isAlive=true (reset)`);
        }
        conn.isAlive = false;
        try {
          conn.socket.socket.send(JSON.stringify({
            type: 'PING',
            sessionId,
            peerId: conn.peerId
          }));
        } catch {
          // ignore
        }
      }
    }
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private generateUniquePin(): string {
    let pin = '';
    let attempts = 0;
    while (attempts < 1000) {
      pin = crypto.randomInt(100000, 1000000).toString();
      if (!this.pinToSessionId.has(pin)) {
        return pin;
      }
      attempts++;
    }
    throw new LinkDropError('INTERNAL_ERROR', 'Failed to generate unique PIN', 500);
  }
}
