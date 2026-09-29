export type ExpandedSet = { has(url: string): boolean; add(url: string): void };

/** Collapsed results the user chose to show, kept for the tab session (sessionStorage on the Google origin). */
export function createExpandedSet(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key = 'gist-expanded'): ExpandedSet {
  let set = new Set<string>();
  try {
    set = new Set(JSON.parse(storage?.getItem(key) ?? '[]') as string[]);
  } catch {
    // corrupted or unavailable storage: start empty
  }
  return {
    has: (url) => set.has(url),
    add: (url) => {
      set.add(url);
      try {
        storage?.setItem(key, JSON.stringify([...set]));
      } catch {
        // storage full or blocked: keep in memory only
      }
    },
  };
}
