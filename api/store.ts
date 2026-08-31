export interface Peer {
  peerId: string;
  role: 'sender' | 'receiver';
  connected: boolean;
}

export interface Session {
  sessionId: string;
  pairingPin: string;
  creatorPeerId: string;
  status: 'CREATED' | 'WAITING_FOR_PEER' | 'PAIRED' | 'EXPIRED';
  peers: Peer[];
  createdAt: number;
  expiresAt: number;
  messages: Record<string, any[]>; // recipientPeerId -> pending signaling messages
}

// Global store across serverless warm invocations
const g = global as unknown as {
  __linkdrop_sessions?: Map<string, Session>;
  __linkdrop_pins?: Map<string, string>;
};

if (!g.__linkdrop_sessions) {
  g.__linkdrop_sessions = new Map<string, Session>();
}
if (!g.__linkdrop_pins) {
  g.__linkdrop_pins = new Map<string, string>();
}

export const sessions = g.__linkdrop_sessions;
export const pinToSessionId = g.__linkdrop_pins;

export function generatePin(): string {
  let pin = '';
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (pinToSessionId.has(pin));
  return pin;
}

export function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      pinToSessionId.delete(session.pairingPin);
      sessions.delete(id);
    }
  }
}
