import { describe, it, expect } from 'vitest';
import { LinkDropError, makeSuccess, makeFailure } from '@linkdrop/shared';

describe('Shared Primitives', () => {
  it('should construct LinkDropError with correct code and details', () => {
    const error = new LinkDropError('VALIDATION_FAILED', 'Invalid input parameter', 422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('Invalid input parameter');
    expect(error.statusCode).toBe(422);
  });

  it('should correctly build success Result wrappers', () => {
    const successResult = makeSuccess('data-payload');
    expect(successResult.ok).toBe(true);
    if (successResult.ok) {
      expect(successResult.value).toBe('data-payload');
    }
  });

  it('should correctly build failure Result wrappers', () => {
    const errorPrimitive = new Error('Database connection failed');
    const failureResult = makeFailure(errorPrimitive);
    expect(failureResult.ok).toBe(false);
    if (!failureResult.ok) {
      expect(failureResult.error.message).toBe('Database connection failed');
    }
  });
});
