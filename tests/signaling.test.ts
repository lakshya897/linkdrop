import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { server } from '@linkdrop/signaling';

describe('Signaling Server', () => {
  beforeAll(async () => {
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('should respond with HTTP 200 ok on /health endpoint', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.status).toBe('ok');
    expect(json.protocolVersion).toBe(1);
  });

  it('should correctly format and return error codes from custom primitives', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/error-test',
    });

    expect(response.statusCode).toBe(400);
  });
});
