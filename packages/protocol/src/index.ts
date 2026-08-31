import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [1];

// 1. Session Domain Model Schemas & Types
export const SessionStateSchema = z.enum([
  'CREATED',
  'WAITING_FOR_PEER',
  'PAIRING',
  'PAIRED',
  'CLOSING',
  'EXPIRED'
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const PeerRoleSchema = z.enum(['sender', 'receiver']);
export type PeerRole = z.infer<typeof PeerRoleSchema>;

export const PeerSchema = z.object({
  peerId: z.string().uuid(),
  role: PeerRoleSchema,
  connected: z.boolean(),
  joinedAt: z.number(),
  lastSeen: z.number()
});
export type Peer = z.infer<typeof PeerSchema>;

export const SessionSchema = z.object({
  sessionId: z.string().uuid(),
  pairingPin: z.string().length(6),
  creatorPeerId: z.string().uuid(),
  peers: z.array(PeerSchema),
  status: SessionStateSchema,
  createdAt: z.number(),
  expiresAt: z.number(),
  maxPeers: z.number()
});
export type Session = z.infer<typeof SessionSchema>;

// 2. REST API Request / Response Schemas
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  pairingPin: z.string().length(6),
  expiresAt: z.number()
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const SafeSessionStateSchema = z.object({
  sessionId: z.string().uuid(),
  creatorPeerId: z.string().uuid(),
  status: SessionStateSchema,
  peers: z.array(z.object({
    peerId: z.string().uuid(),
    role: PeerRoleSchema,
    connected: z.boolean()
  })),
  expiresAt: z.number()
});
export type SafeSessionState = z.infer<typeof SafeSessionStateSchema>;

export const JoinSessionRequestSchema = z.object({
  pairingPin: z.string().length(6),
  peerId: z.string().uuid()
});
export type JoinSessionRequest = z.infer<typeof JoinSessionRequestSchema>;

// 3. WebSocket Message Schemas
export const SignalingMessageTypeSchema = z.enum([
  'CLIENT_HELLO',
  'SESSION_JOIN',
  'PEER_JOINED',
  'PEER_LEFT',
  'PEER_READY',
  'SESSION_PAIRED',
  'SESSION_ERROR',
  'PING',
  'PONG',
  'SESSION_CLOSE',
  // Future WebRTC messages
  'WEBRTC_OFFER',
  'WEBRTC_ANSWER',
  'ICE_CANDIDATE',
  // File transfer signaling messages
  'FILE_TRANSFER_START',
  'FILE_TRANSFER_COMPLETE',
  'FILE_TRANSFER_CANCEL',
  'FILE_TRANSFER_ERROR'
]);
export type SignalingMessageType = z.infer<typeof SignalingMessageTypeSchema>;

export const SignalingMessageSchema = z.object({
  type: SignalingMessageTypeSchema,
  sessionId: z.string().uuid(),
  peerId: z.string().uuid(),
  payload: z.any().optional()
});
export type SignalingMessage = z.infer<typeof SignalingMessageSchema>;

// 4. Protocol Error Codes
export const ErrorCodeSchema = z.enum([
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'SESSION_FULL',
  'INVALID_PIN',
  'ALREADY_JOINED',
  'INVALID_MESSAGE',
  'PEER_DISCONNECTED',
  'WEBSOCKET_CLOSED',
  'RATE_LIMITED',
  'INTERNAL_ERROR'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// 5. WebRTC Payload Schemas
export const WebRtcOfferPayloadSchema = z.object({
  type: z.literal('offer'),
  sdp: z.string()
});
export type WebRtcOfferPayload = z.infer<typeof WebRtcOfferPayloadSchema>;

export const WebRtcAnswerPayloadSchema = z.object({
  type: z.literal('answer'),
  sdp: z.string()
});
export type WebRtcAnswerPayload = z.infer<typeof WebRtcAnswerPayloadSchema>;

export const IceCandidatePayloadSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional()
});
export type IceCandidatePayload = z.infer<typeof IceCandidatePayloadSchema>;

// 6. File Transfer Payload Schemas
export const FileTransferStartPayloadSchema = z.object({
  transferId: z.string().uuid(),
  fileName: z.string(),
  fileSize: z.number().positive(),
  mimeType: z.string(),
  totalChunks: z.number().positive(),
  chunkSize: z.number().positive(),
  hash: z.string()
});
export type FileTransferStartPayload = z.infer<typeof FileTransferStartPayloadSchema>;

export const FileTransferCancelPayloadSchema = z.object({
  transferId: z.string().uuid(),
  reason: z.string()
});
export type FileTransferCancelPayload = z.infer<typeof FileTransferCancelPayloadSchema>;

export const FileTransferErrorPayloadSchema = z.object({
  transferId: z.string().uuid(),
  message: z.string()
});
export type FileTransferErrorPayload = z.infer<typeof FileTransferErrorPayloadSchema>;

export const FileTransferCompletePayloadSchema = z.object({
  transferId: z.string().uuid()
});
export type FileTransferCompletePayload = z.infer<typeof FileTransferCompletePayloadSchema>;
