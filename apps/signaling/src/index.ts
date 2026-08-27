import fastify from 'fastify';
import { PROTOCOL_VERSION } from '@linkdrop/protocol';
import { LinkDropError } from '@linkdrop/shared';

const server = fastify({ logger: true });

server.get('/health', async () => {
  return { status: 'ok', protocolVersion: PROTOCOL_VERSION };
});

server.get('/error-test', async () => {
  throw new LinkDropError('TEST_ERROR', 'This is a test error primitive', 400);
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Signaling server running on port ${port} (protocol version ${PROTOCOL_VERSION})`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

// Start server if this is the main module
if (import.meta.url.startsWith('file:')) {
  const modulePath = new URL(import.meta.url).pathname;
  const scriptPath = process.argv[1];
  // Simplistic check for execution context
  if (modulePath.includes(scriptPath) || scriptPath?.endsWith('index.js')) {
    start();
  }
}

export { server };
