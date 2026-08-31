import { describe, it, expect } from 'vitest';
import { SessionManager } from '../apps/signaling/src/session';
import crypto from 'crypto';

describe('SessionManager (Domain Logic)', () => {
  it('should create session with unique ID and 6-digit PIN', () => {
    const manager = new SessionManager(10000);
    const creatorPeerId = crypto.randomUUID();
    const session = manager.createSession(creatorPeerId);

    expect(session.sessionId).toBeDefined();
    expect(session.pairingPin).toHaveLength(6);
    expect(/^\d{6}$/.test(session.pairingPin)).toBe(true);
    expect(session.creatorPeerId).toBe(creatorPeerId);
    expect(session.status).toBe('CREATED');
    expect(session.peers).toHaveLength(1);
    expect(session.peers[0].peerId).toBe(creatorPeerId);
  });

  it('should join valid session', () => {
    const manager = new SessionManager(10000);
    const peerA = crypto.randomUUID();
    const peerB = crypto.randomUUID();
    
    const session = manager.createSession(peerA);
    const joined = manager.joinSession(session.pairingPin, peerB);

    expect(joined.peers).toHaveLength(2);
    expect(joined.peers[1].peerId).toBe(peerB);
    expect(joined.peers[1].role).toBe('receiver');
  });

  it('should reject invalid PIN', () => {
    const manager = new SessionManager(10000);
    const peerA = crypto.randomUUID();
    const peerB = crypto.randomUUID();
    
    manager.createSession(peerA);
    
    expect(() => manager.joinSession('000000', peerB)).toThrowError(/not found/i);
  });

  it('should reject expired session', () => {
    const manager = new SessionManager(-10); // Negative TTL = already expired
    const peerA = crypto.randomUUID();
    const peerB = crypto.randomUUID();
    
    const session = manager.createSession(peerA);
    
    // Attempting to retrieve or join should sweep and throw
    expect(() => manager.joinSession(session.pairingPin, peerB)).toThrowError(/expired/i);
  });

  it('should reject third peer joining', () => {
    const manager = new SessionManager(10000);
    const peerA = crypto.randomUUID();
    const peerB = crypto.randomUUID();
    const peerC = crypto.randomUUID();
    
    const session = manager.createSession(peerA);
    manager.joinSession(session.pairingPin, peerB);
    
    expect(() => manager.joinSession(session.pairingPin, peerC)).toThrowError(/full/i);
  });

  it('should reject duplicate peer joining', () => {
    const manager = new SessionManager(10000);
    const peerA = crypto.randomUUID();
    
    const session = manager.createSession(peerA);
    expect(() => manager.joinSession(session.pairingPin, peerA)).toThrowError(/already joined/i);
  });

  it('should clean up and sweep expired sessions', () => {
    const manager = new SessionManager(-10);
    const peerA = crypto.randomUUID();
    manager.createSession(peerA);

    expect(manager.getSessionCount()).toBe(1);
    manager.sweepExpired();
    expect(manager.getSessionCount()).toBe(0);
  });

  it('should support multiple independent sessions', () => {
    const manager = new SessionManager(10000);
    const s1 = manager.createSession(crypto.randomUUID());
    const s2 = manager.createSession(crypto.randomUUID());

    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(s1.pairingPin).not.toBe(s2.pairingPin);
  });
});
