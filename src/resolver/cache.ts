// LRU cache layered on top of the composed resolver.
//
// Per docs/03-symbol-resolution.md § "Caching": keyed by
// `(uri, doc.version, line, character)`, capacity 256, no TTL. Document
// version invalidates entries automatically — typing on the line bumps
// `doc.version`, which makes the previous key unreachable.
//
// Two roles in this module:
//
//   1. `createResolverCache` — a plain LRU keyed by the composite tuple
//      above. Stores `ResolvedSymbol | null`: a `null` value records a
//      *cached miss* so the wrapper can short-circuit a cursor parked
//      on whitespace without re-running the (expensive) four-strategy
//      chain on every debounce tick. Returning `undefined` from `get`
//      means "not in cache"; returning `null` means "cached miss".
//
//   2. `wrapWithCache` — produces a new `Resolver` whose `resolve`
//      consults the cache before delegating, and writes the result
//      (hit or miss) back. The wrapper preserves the inner resolver's
//      `strategyOrder` so debug surfaces stay accurate.
//
// LRU is implemented via a `Map`: insertion order is iteration order,
// and `Map.delete + Map.set` bumps recency. This is the canonical
// allocation-free TS LRU pattern and is what we rely on for both the
// "evict oldest" behavior and the recency bump on hit.
//
// Notes:
//   - URIs are passed through verbatim (`doc.uri.toString()`). vscode's
//     URI strings are already canonicalized for filesystem paths;
//     round-tripping through `Uri.parse` could change the form (e.g.
//     case folding on Windows) and split the cache by accident. The
//     caller is expected to feed the same string per logical document.
//   - `version` is a non-negative integer per the vscode contract; we
//     don't guard against negatives or overflow. The composer (M4.6)
//     never synthesizes versions.
//   - `clear()` is a total wipe. Selective per-document eviction on
//     `onDidCloseTextDocument` is M4.6's job.
import type {
    ResolvedSymbol,
    Resolver
} from './types.js';

/**
 * The cached value carries `null` as a sentinel for a *cached miss* —
 * "the resolver chain ran on this exact key and produced no FQN; don't
 * recompute until the document version changes." `undefined` from `get`
 * means the key has never been seen.
 */
type CacheEntry = ResolvedSymbol | null;

export interface ResolverCache {
    get(
        uri: string,
        version: number,
        line: number,
        character: number
    ): CacheEntry | undefined;

    set(
        uri: string,
        version: number,
        line: number,
        character: number,
        value: CacheEntry
    ): void;

    clear(): void;
    size(): number;
    capacity(): number;
}

export interface CacheOptions {
    capacity?: number;
}

const DEFAULT_CAPACITY = 256;

function makeKey(
    uri: string,
    version: number,
    line: number,
    character: number
): string {
    return `${uri}|${version}|${line}:${character}`;
}

/**
 * Create a fresh LRU cache. Capacity defaults to 256 per docs/03.
 *
 * The cache stores both hits (`ResolvedSymbol`) and misses (`null`);
 * see the file header for why negative caching matters.
 */
export function createResolverCache(options?: CacheOptions): ResolverCache {
    const cap = options?.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(cap) || cap <= 0) {
        throw new Error(
            `createResolverCache: capacity must be a positive integer, got ${String(cap)}`
        );
    }
    // `Map` preserves insertion order; we use that as recency order.
    const store = new Map<string, CacheEntry>();

    return {
        get(uri, version, line, character) {
            const key = makeKey(uri, version, line, character);
            if (!store.has(key))
                return undefined;

            // Bump recency: delete + reinsert moves the entry to the tail.
            const value = store.get(key) as CacheEntry;

            store.delete(key);
            store.set(key, value);
            return value;
        },

        set(uri, version, line, character, value) {
            const key = makeKey(uri, version, line, character);
            // If the key already exists, drop it so the reinsert below puts
            // it at the tail (most-recently-used).
            if (store.has(key))
                store.delete(key);
            else if (store.size >= cap) {
                // Evict the oldest entry (head of insertion order).
                const oldest = store.keys().next();
                if (!oldest.done)
                    store.delete(oldest.value);
            }

            store.set(key, value);
        },

        clear() {
            store.clear();
        },

        size() {
            return store.size;
        },

        capacity() {
            return cap;
        }
    };
}

/**
 * Wrap a resolver with cache lookups.
 *
 * Behavior:
 *   - `cache.get(...)` returning `undefined` → not in cache; delegate
 *     to the inner resolver and cache the result (hit or miss).
 *   - `cache.get(...)` returning `null` → cached miss; return
 *     `undefined` immediately, do not invoke the inner resolver.
 *   - `cache.get(...)` returning a `ResolvedSymbol` → cached hit;
 *     return it immediately.
 *
 * `strategyOrder` is forwarded from the inner resolver unchanged.
 */
export function wrapWithCache(
    resolver: Resolver,
    cache: ResolverCache
): Resolver {
    return {
        strategyOrder: resolver.strategyOrder,
        async resolve(document, position) {
            const uri = document.uri.toString();
            const cached = cache.get(uri,
                document.version,
                position.line,
                position.character);

            if (cached !== undefined)
                return cached === null ? undefined : cached;

            const result = await resolver.resolve(document, position);
            cache.set(
                uri,
                document.version,
                position.line,
                position.character,
                result ?? null
            );

            return result;
        }
    };
}
