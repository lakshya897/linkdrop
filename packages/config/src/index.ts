export const ENV_CONFIG = {
  development: {
    signalingPort: 3000,
    maxFileSize: 2 * 1024 * 1024 * 1024, // 2 GB
    sessionTtlSeconds: 900, // 15 mins
  },
  test: {
    signalingPort: 3001,
    maxFileSize: 2 * 1024 * 1024 * 1024,
    sessionTtlSeconds: 300,
  },
  production: {
    signalingPort: 8080,
    maxFileSize: 2 * 1024 * 1024 * 1024,
    sessionTtlSeconds: 900,
  },
};
export type EnvType = keyof typeof ENV_CONFIG;
