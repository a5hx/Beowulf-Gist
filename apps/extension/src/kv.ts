export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export function memoryKV(initial: Record<string, unknown> = {}): KV & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    dump: () => Object.fromEntries(data),
  };
}
