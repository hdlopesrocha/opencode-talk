import type { Event as NostrEvent, Filter } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";

export interface SubHandle {
  close(): void;
}

/**
 * Relay I/O abstraction. The production implementation wraps SimplePool;
 * tests inject a fake. Kept deliberately narrow (publish + one-shot
 * subscriptions) so alternative transports stay trivial.
 */
export interface RelayTransport {
  publish(relays: string[], event: NostrEvent): Promise<void>;
  subscribe(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): SubHandle;
  close(relays: string[]): void;
}

export class SimplePoolTransport implements RelayTransport {
  private pool = new SimplePool();

  async publish(relays: string[], event: NostrEvent): Promise<void> {
    const results = this.pool.publish(relays, event);
    // Promise.any: one accepting relay is enough; private relays may reject.
    await Promise.any(results);
  }

  subscribe(relays: string[], filter: Filter, onEvent: (event: NostrEvent) => void): SubHandle {
    const sub = this.pool.subscribeMany(relays, filter, { onevent: onEvent });
    return {
      close: () => {
        try {
          sub.close();
        } catch {
          /* ignore */
        }
      },
    };
  }

  close(relays: string[]): void {
    try {
      this.pool.close(relays);
    } catch {
      /* ignore */
    }
  }
}
