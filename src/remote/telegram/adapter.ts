/**
 * Backwards-compatible re-export: the shared Session API client now lives in
 * src/client.ts so Telegram, Nostr and future adapters use one module.
 */
export { SessionApiClient, parseSSEChunk, subscribeEvents } from "../client.js";
export type { ApiClientOptions, FetchedMedia } from "../client.js";
