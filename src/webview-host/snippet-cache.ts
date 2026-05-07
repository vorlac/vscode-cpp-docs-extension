// Snippet cache (M6.3.A).
//
// Hovering on the same symbol twice (or hovering on multiple symbols
// that map to the same docs page) re-reads the file from disk and
// re-runs `extractSnippet` even though the inputs are identical. An
// LRU keyed on (filePath, mtimeMs, maxChars) collapses those repeats.
//
// Per docs/04-rendering.md § "Snippet extraction" + docs/05-plan.md M6
// ("Performance pass: query latency, snippet extraction caching,
// debounce tuning").

import type { ExtractedSnippet } from './snippet.js';

export interface SnippetCacheKey {
    /** Absolute path. */
    filePath: string;
    /** File mtime in epoch ms (or 0 if unavailable). */
    mtimeMs: number;
    /** Max chars. */
    maxChars: number;
}

export interface SnippetCache {
    get(key: SnippetCacheKey): ExtractedSnippet | undefined;
    set(key: SnippetCacheKey, value: ExtractedSnippet): void;
    clear(): void;
    size(): number;
}

const DEFAULT_CAPACITY = 64;

function keyOf(k: SnippetCacheKey): string {
    return `${k.filePath}|${k.mtimeMs}|${k.maxChars}`;
}

/**
 * `Map`-backed LRU. JavaScript's `Map` preserves insertion order, so
 * `delete + set` after a hit moves the entry to the end (most-recently-
 * used) without rebuilding the structure. Capacity bound is enforced
 * on `set` by trimming the oldest entry (the first `keys()` value)
 * until size <= capacity.
 *
 * No TTL — the `mtimeMs` field in the key bakes in cache invalidation:
 * if the file is rewritten on disk (cppreference reinstall), the
 * caller computes a different key and the old entry naturally ages out
 * via the LRU eviction.
 */
export function createSnippetCache(
    capacity: number = DEFAULT_CAPACITY
): SnippetCache {
    if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error(
            `createSnippetCache: capacity must be a positive integer (got ${capacity})`
        );
    }
    const store = new Map<string, ExtractedSnippet>();

    return {
        get(key) {
            const k = keyOf(key);
            const v = store.get(k);
            if (v === undefined) return undefined;
            // Refresh recency: re-insert moves to the end of the iteration
            // order, which is what LRU eviction relies on.
            store.delete(k);
            store.set(k, v);
            return v;
        },
        set(key, value) {
            const k = keyOf(key);
            if (store.has(k)) store.delete(k);
            store.set(k, value);
            while (store.size > capacity) {
                const oldest = store.keys().next().value;
                if (oldest === undefined) break;
                store.delete(oldest);
            }
        },
        clear() {
            store.clear();
        },
        size() {
            return store.size;
        }
    };
}
