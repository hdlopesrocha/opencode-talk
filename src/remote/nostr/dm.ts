import { finalizeEvent, nip04 } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";

/** NIP-04 encrypted direct messages. */
export const DM_KIND = 4;
/** Keep each DM comfortably below relay size limits. */
export const MAX_DM_CHARS = 8000;

export interface ParsedDM {
  id: string;
  fromHex: string;
  toHex: string;
  text: string;
  createdAt: number;
}

/** Build a signed kind-4 DM. Encryption is local — no network involved. */
export function createDM(
  senderSecret: Uint8Array,
  recipientHex: string,
  text: string,
): NostrEvent {
  const content = nip04.encrypt(senderSecret, recipientHex, text);
  return finalizeEvent(
    {
      kind: DM_KIND,
      tags: [["p", recipientHex]],
      content,
      created_at: Math.floor(Date.now() / 1000),
    },
    senderSecret,
  );
}

/** Split long replies into DM-sized chunks at line/word boundaries. */
export function splitDM(text: string, maxLength = MAX_DM_CHARS): string[] {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.length <= maxLength) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.4) cut = rest.lastIndexOf(" ", maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Validate + decrypt an incoming kind-4 event for one of our session keys.
 * Returns null for anything not addressed to us or undecryptable (noise,
 * wrong key, other protocols). Own echoes (sent DMs relayed back) parse
 * fine — callers must skip `fromHex === ourPubkey` to avoid reply loops.
 */
export function parseDM(
  event: NostrEvent,
  ourSecretKey: Uint8Array,
  ourPubkey: string,
): ParsedDM | null {
  if (event.kind !== DM_KIND || typeof event.content !== "string") return null;
  const pTag = event.tags.find((t) => t[0] === "p")?.[1];
  const fromUs = event.pubkey === ourPubkey;
  const toUs = pTag === ourPubkey;
  if (!fromUs && !toUs) return null;
  if (fromUs && !pTag) return null;
  const peerHex = fromUs ? (pTag as string) : event.pubkey;
  try {
    const text = nip04.decrypt(ourSecretKey, peerHex, event.content);
    return { id: event.id, fromHex: event.pubkey, toHex: pTag ?? "", text, createdAt: event.created_at };
  } catch {
    return null;
  }
}
