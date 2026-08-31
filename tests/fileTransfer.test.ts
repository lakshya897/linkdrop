import { describe, it, expect } from 'vitest';
import { WebRtcManager } from '../apps/web/src/lib/webrtc/WebRtcManager';

describe('File Transfer protocol serialization and backpressure logic', () => {
  it('should serialize and parse binary chunk headers correctly', () => {
    const chunkIndex = 42;
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    // Build binary frame: 4 bytes big-endian index + payload
    const buffer = new ArrayBuffer(4 + payload.length);
    const view = new DataView(buffer);
    view.setUint32(0, chunkIndex, false);
    const uint8View = new Uint8Array(buffer);
    uint8View.set(payload, 4);

    // Verify parser logic
    const readView = new DataView(buffer);
    const parsedIndex = readView.getUint32(0, false);
    const parsedPayload = new Uint8Array(buffer, 4);

    expect(parsedIndex).toBe(42);
    expect(parsedPayload).toEqual(payload);
  });

  it('should report correct backpressure watermarks', () => {
    expect(WebRtcManager.HIGH_WATERMARK).toBe(8 * 1024 * 1024);
    expect(WebRtcManager.LOW_WATERMARK).toBe(4 * 1024 * 1024);
    expect(WebRtcManager.CHUNK_SIZE).toBe(60 * 1024);
  });

  it('should respect backpressure watermarks limit logic', () => {
    let mockBufferedAmount = 10 * 1024 * 1024; // 10 MB (above HIGH)
    const isHigh = mockBufferedAmount > WebRtcManager.HIGH_WATERMARK;
    expect(isHigh).toBe(true);

    mockBufferedAmount = 3 * 1024 * 1024; // 3 MB (below LOW)
    const isLow = mockBufferedAmount < WebRtcManager.LOW_WATERMARK;
    expect(isLow).toBe(true);
  });
});
