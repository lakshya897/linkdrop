import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from '@linkdrop/protocol';

describe('Protocol Package', () => {
  it('should export the correct version number', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
