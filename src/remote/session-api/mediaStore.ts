import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("media-store");

export interface MediaRecord {
  id: string;
  sessionID: string;
  filename: string;
  mimeType: string;
  size: number;
  time: number;
  caption?: string;
}

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function mimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

export function isAllowedImage(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(mimeType.toLowerCase());
}

/**
 * Content-addressed-ish blob store for images agents send to chats.
 * Files persist under <dir>/<id>-<safe filename>; metadata in index.json.
 * SSE events reference media by id so streams stay light; clients fetch
 * bytes via GET /api/media/:id (Telegram photos, Nostr links, web UI, ...).
 */
export class MediaStore {
  private dir: string;
  private maxBytes: number;
  private meta = new Map<string, MediaRecord>();

  constructor(dir: string, maxBytes = 5 * 1024 * 1024) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    mkdirSync(dir, { recursive: true });
    this.loadIndex();
  }

  get maxSize(): number {
    return this.maxBytes;
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  private loadIndex(): void {
    try {
      const raw = readFileSync(this.indexPath(), "utf8");
      const arr = JSON.parse(raw) as MediaRecord[];
      for (const r of arr) {
        if (r?.id) this.meta.set(r.id, r);
      }
      log.info(`Loaded ${this.meta.size} media records from ${this.dir}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn(`Could not load media index: ${String(err)}`);
      }
    }
    // Drop metadata for files that no longer exist.
    for (const [id, rec] of [...this.meta]) {
      if (!existsSync(this.filePath(id, rec.filename))) this.meta.delete(id);
    }
  }

  private saveIndex(): void {
    try {
      writeFileSync(this.indexPath(), JSON.stringify([...this.meta.values()], null, 2));
    } catch (err) {
      log.warn(`Could not save media index: ${String(err)}`);
    }
  }

  private safeName(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "image";
  }

  private filePath(id: string, filename: string): string {
    return join(this.dir, `${id}-${this.safeName(filename)}`);
  }

  save(input: {
    sessionID: string;
    filename: string;
    mimeType: string;
    bytes: Buffer;
    caption?: string;
  }): MediaRecord {
    if (input.bytes.length > this.maxBytes) {
      throw new Error(`media too large (${input.bytes.length} > ${this.maxBytes} bytes)`);
    }
    if (input.bytes.length === 0) throw new Error("empty media upload");
    const id = `med_${randomBytes(8).toString("hex")}`;
    const rec: MediaRecord = {
      id,
      sessionID: input.sessionID,
      filename: this.safeName(input.filename),
      mimeType: input.mimeType,
      size: input.bytes.length,
      time: Date.now(),
      ...(input.caption ? { caption: input.caption } : {}),
    };
    writeFileSync(this.filePath(id, rec.filename), input.bytes);
    this.meta.set(id, rec);
    this.saveIndex();
    // Best-effort pruning: cap at 500 records.
    if (this.meta.size > 500) {
      const oldest = [...this.meta.values()].sort((a, b) => a.time - b.time)[0];
      if (oldest) this.delete(oldest.id);
    }
    return rec;
  }

  get(id: string): MediaRecord | undefined {
    return this.meta.get(id);
  }

  read(id: string): { record: MediaRecord; bytes: Buffer } | undefined {
    const record = this.meta.get(id);
    if (!record) return undefined;
    try {
      const bytes = readFileSync(this.filePath(id, record.filename));
      return { record, bytes };
    } catch {
      return undefined;
    }
  }

  listForSession(sessionID: string): MediaRecord[] {
    return [...this.meta.values()].filter((r) => r.sessionID === sessionID);
  }

  private delete(id: string): void {
    const rec = this.meta.get(id);
    this.meta.delete(id);
    if (rec) {
      try {
        unlinkSync(this.filePath(id, rec.filename));
      } catch {
        /* ignore */
      }
    }
    this.saveIndex();
  }

  count(): number {
    return this.meta.size;
  }
}

/** For directory startup checks. */
export function listMediaFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
