/** Petit cache mémoire avec expiration et taille bornée (évite les fuites mémoire). */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V) {
    if (this.store.size >= this.maxEntries) {
      // Map garde l'ordre d'insertion : on retire la plus ancienne entrée.
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string) {
    this.store.delete(key);
  }

  /** Valeur en cache, sinon calculée une seule fois même si plusieurs appels arrivent en même temps. */
  private readonly pending = new Map<string, Promise<V>>();
  async wrap(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const promise = compute()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
