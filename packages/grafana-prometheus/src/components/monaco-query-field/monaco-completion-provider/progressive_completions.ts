// One in-flight completion search and the rows already received.
// A later batch appends to this list. The suggest widget reads the same list
// again instead of starting another search.

export type CompletionSnapshot<T> = {
  items: T[];
  incomplete: boolean;
  generation: number;
  stale: boolean;
};

export class ProgressiveCompletionSession<T> {
  constructor(private readonly itemKey: (item: T) => string = (item) => String(item)) {}

  private key = '';
  private generation = 0;
  private items: T[] = [];
  private incomplete = false;
  private delivered = false;
  private waiters: Array<() => void> = [];

  load(
    key: string,
    produce: (onBatch: (batch: T[]) => void) => Promise<T[]>,
    onAppended: () => void
  ): Promise<CompletionSnapshot<T>> {
    if (key !== this.key) {
      this.key = key;
      const generation = ++this.generation;
      this.items = [];
      this.incomplete = true;
      this.delivered = false;
      this.flushWaiters();

      void produce((batch) => {
        this.append(generation, batch, onAppended);
      }).then(
        (finalItems) => {
          this.settle(generation, finalItems, onAppended);
        },
        () => {
          this.settle(generation, this.items, onAppended);
        }
      );
    }

    return this.waitForSnapshot();
  }

  // The first snapshot opens the suggest popup. Batches after that refresh it.
  // A superseded search must not mark the replacement as delivered.
  markDelivered(generation: number): void {
    if (generation === this.generation) {
      this.delivered = true;
    }
  }

  private append(generation: number, batch: T[], onAppended: () => void): void {
    if (generation !== this.generation || batch.length === 0) {
      return;
    }
    const alreadyDelivered = this.delivered;
    this.items.push(...batch);
    this.flushWaiters();
    if (alreadyDelivered) {
      onAppended();
    }
  }

  private settle(generation: number, finalItems: T[], onAppended: () => void): void {
    if (generation !== this.generation) {
      return;
    }
    const alreadyDelivered = this.delivered;
    if (!alreadyDelivered) {
      this.items = finalItems.slice();
    } else if (finalItems.length > 0) {
      // The popup is already showing streamed rows. Keep that order and append
      // only labels the stream did not send, such as static function names.
      // Replacing the list would put those names in front of the batches.
      const seen = new Set(this.items.map((item) => this.itemKey(item)));
      for (const item of finalItems) {
        const key = this.itemKey(item);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        this.items.push(item);
      }
    }
    this.incomplete = false;
    this.flushWaiters();
    if (alreadyDelivered) {
      onAppended();
    }
  }

  private copy(generation: number): CompletionSnapshot<T> {
    if (generation !== this.generation) {
      return { items: [], incomplete: true, generation, stale: true };
    }
    return { items: this.items.slice(), incomplete: this.incomplete, generation, stale: false };
  }

  private waitForSnapshot(): Promise<CompletionSnapshot<T>> {
    const generation = this.generation;
    if (this.items.length > 0 || !this.incomplete) {
      return Promise.resolve(this.copy(generation));
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.copy(generation)));
    });
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}
