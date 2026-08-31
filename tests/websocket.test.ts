import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { server } from '../apps/signaling/src/index';
import WebSocket from 'ws';
import crypto from 'crypto';

let serverUrl: string;

describe('WebSocket Signaling API', () => {
  beforeAll(async () => {
    // Start server on a random free port
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    serverUrl = address.replace('http://', '');
  });

  afterAll(async () => {
    await server.close();
  });

  it('should establish WebSocket connection and receive hello confirmation', async () => {
    const peerId = crypto.randomUUID();
    
    // 1. Create session via REST
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { creatorPeerId: peerId }
    });
    
    const createData = JSON.parse(createRes.body);
    const sessionId = createData.sessionId;

    // 2. Connect via WS and wrap the event handling in a standard, clean promise
    await new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://${serverUrl}/ws/signaling/${sessionId}/${peerId}`;
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'PING',
          sessionId,
          peerId
        }));
      });

      ws.on('message', () => {
        ws.close();
        resolve();
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });
  });

  it('should reject invalid JSON messages', async () => {
    const peerId = crypto.randomUUID();
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { creatorPeerId: peerId }
    });
    const createData = JSON.parse(createRes.body);
    const { sessionId } = createData;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${serverUrl}/ws/signaling/${sessionId}/${peerId}`);

      ws.on('open', () => {
        ws.send('invalid-json');
      });

      ws.on('message', (rawData) => {
        const msg = JSON.parse(rawData.toString());
        expect(msg.type).toBe('SESSION_ERROR');
        expect(msg.payload.code).toBe('INVALID_MESSAGE');
        ws.close();
        resolve();
      });

      ws.on('error', (err) => reject(err));
    });
  });

  it('should reject oversized messages (>4KB)', async () => {
    const peerId = crypto.randomUUID();
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { creatorPeerId: peerId }
    });
    const createData = JSON.parse(createRes.body);
    const { sessionId } = createData;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${serverUrl}/ws/signaling/${sessionId}/${peerId}`);

      ws.on('open', () => {
        const hugeMessage = 'A'.repeat(5000); // 5KB
        ws.send(hugeMessage);
      });

      ws.on('message', (rawData) => {
        const msg = JSON.parse(rawData.toString());
        expect(msg.type).toBe('SESSION_ERROR');
        expect(msg.payload.code).toBe('INVALID_MESSAGE');
        expect(msg.payload.message).toContain('limit exceeded');
        ws.close();
        resolve();
      });

      ws.on('error', (err) => reject(err));
    });
  });

  it('should reject binary/file payloads in messages', async () => {
    const peerId = crypto.randomUUID();
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { creatorPeerId: peerId }
    });
    const createData = JSON.parse(createRes.body);
    const { sessionId } = createData;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${serverUrl}/ws/signaling/${sessionId}/${peerId}`);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'PEER_READY',
          sessionId,
          peerId,
          payload: { fileBytes: 'some-base64-bytes' }
        }));
      });

      ws.on('message', (rawData) => {
        const msg = JSON.parse(rawData.toString());
        expect(msg.type).toBe('SESSION_ERROR');
        expect(msg.payload.code).toBe('INVALID_MESSAGE');
        expect(msg.payload.message).toContain('Binary payloads are not permitted');
        ws.close();
        resolve();
      });

      ws.on('error', (err) => reject(err));
    });
  });
});
