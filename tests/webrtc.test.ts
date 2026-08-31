import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRtcManager } from '../apps/web/src/lib/webrtc/WebRtcManager';

describe('WebRtcManager (Unit Tests)', () => {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let mockPC: any;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      readyState: 'connecting',
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    mockPC = {
      connectionState: 'new',
      iceConnectionState: 'new',
      signalingState: 'stable',
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'local-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'remote-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      createDataChannel: vi.fn().mockReturnValue(mockChannel),
      close: vi.fn(),
      getStats: vi.fn().mockResolvedValue(new Map())
    };

    // Mock globals
    vi.stubGlobal('RTCPeerConnection', vi.fn().mockImplementation(() => mockPC));
    vi.stubGlobal('RTCSessionDescription', vi.fn().mockImplementation((init) => init));
    vi.stubGlobal('RTCIceCandidate', vi.fn().mockImplementation((init) => init));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should initialize RTCPeerConnection with configured ICE servers', () => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const manager = new WebRtcManager({
      iceServers,
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    const pc = manager.createPeerConnection();
    expect(pc).toBe(mockPC);
    expect(globalThis.RTCPeerConnection).toHaveBeenCalledWith({ iceServers });
  });

  it('should generate SDP offer and set local description', async () => {
    const manager = new WebRtcManager({
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    manager.createPeerConnection();
    const offer = await manager.createOffer();

    expect(offer.sdp).toBe('local-sdp');
    expect(mockPC.createOffer).toHaveBeenCalled();
    expect(mockPC.setLocalDescription).toHaveBeenCalledWith(offer);
  });

  it('should handle remote SDP offer and generate answer', async () => {
    const manager = new WebRtcManager({
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    manager.createPeerConnection();
    const answer = await manager.handleOffer({ type: 'offer', sdp: 'remote-sdp' });

    expect(answer.sdp).toBe('remote-sdp');
    expect(mockPC.setRemoteDescription).toHaveBeenCalled();
    expect(mockPC.createAnswer).toHaveBeenCalled();
    expect(mockPC.setLocalDescription).toHaveBeenCalled();
  });

  it('should queue candidates until remote description is set', async () => {
    const manager = new WebRtcManager({
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    manager.createPeerConnection();
    
    // Remote description is not set yet, so candidate is queued
    mockPC.remoteDescription = null;
    await manager.handleIceCandidate({ candidate: 'candidate-string' });
    expect(mockPC.addIceCandidate).not.toHaveBeenCalled();

    // Set remote description and process
    mockPC.remoteDescription = { type: 'offer', sdp: 'sdp' };
    await manager.handleAnswer({ type: 'answer', sdp: 'sdp' });
    expect(mockPC.addIceCandidate).toHaveBeenCalledWith({ candidate: 'candidate-string' });
  });

  it('should create ordered control data channel', () => {
    const manager = new WebRtcManager({
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    manager.createPeerConnection();
    const channel = manager.createControlChannel();

    expect(channel).toBe(mockChannel);
    expect(mockPC.createDataChannel).toHaveBeenCalledWith('control', { ordered: true });
  });

  it('should close peer connection and channel during cleanup', () => {
    const manager = new WebRtcManager({
      onSignalingMessage: vi.fn(),
      onStateChange: vi.fn(),
      onDataChannelMessage: vi.fn(),
      onDataChannelStateChange: vi.fn()
    });

    manager.createPeerConnection();
    manager.createControlChannel();
    manager.close();

    expect(mockPC.close).toHaveBeenCalled();
    expect(mockChannel.close).toHaveBeenCalled();
  });
});
