import { finalizeEvent } from "nostr-tools";

/**
 * Minimal Blossom upload (BUD-01) so images can travel over Nostr as URLs.
 * Optional: only used when NOSTR_BLOSSOM_SERVER is configured; otherwise the
 * adapter falls back to a text note about the image.
 */
export async function uploadToBlossom(
  serverUrl: string,
  bytes: Uint8Array,
  mimeType: string,
  secretKey: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const server = serverUrl.replace(/\/$/, "");
  const now = Math.floor(Date.now() / 1000);
  const authEvent = finalizeEvent(
    {
      kind: 24242,
      tags: [
        ["t", "upload"],
        ["expiration", String(now + 60)],
      ],
      content: "blossom upload",
      created_at: now,
    },
    secretKey,
  );
  const auth = Buffer.from(JSON.stringify(authEvent), "utf8").toString("base64");
  const res = await fetchImpl(`${server}/upload`, {
    method: "PUT",
    headers: { authorization: `Nostr ${auth}` },
    body: new Blob([bytes as BlobPart], { type: mimeType }),
  });
  if (!res.ok) {
    throw new Error(`blossom upload failed (${res.status})`);
  }
  const data = (await res.json()) as { url?: string; sha256?: string };
  if (data.url) return data.url;
  if (data.sha256) return `${server}/${data.sha256}`;
  throw new Error("blossom upload returned no url");
}
