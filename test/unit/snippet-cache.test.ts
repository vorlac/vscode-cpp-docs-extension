// Unit tests for `src/webview-host/snippet-cache.ts` (M6.3.A).
import { describe, expect, it } from 'vitest';
import {
    createSnippetCache,
    type SnippetCacheKey
} from '../../src/webview-host/snippet-cache.js';
import type { ExtractedSnippet } from '../../src/webview-host/snippet.js';

function makeSnippet(tag: string): ExtractedSnippet {
    return {
        synopsisHtml: `<table>${tag}</table>`,
        paragraphHtml: `<p>${tag}</p>`,
        synopsisText: tag,
        paragraphText: tag,
        totalChars: tag.length * 2,
        truncated: false
    };
}

const k = (
    filePath: string,
    mtimeMs = 1,
    maxChars = 600
): SnippetCacheKey => ({ filePath, mtimeMs, maxChars });

describe('createSnippetCache', () => {
    it('hits the same key written + read back', () => {
        const cache = createSnippetCache();
        const v = makeSnippet('a');
        cache.set(k('/a.html'), v);
        expect(cache.get(k('/a.html'))).toBe(v);
        expect(cache.size()).toBe(1);
    });

    it('misses on a different filePath', () => {
        const cache = createSnippetCache();
        cache.set(k('/a.html'), makeSnippet('a'));
        expect(cache.get(k('/b.html'))).toBeUndefined();
    });

    it('misses on a different mtimeMs (file was rewritten)', () => {
        const cache = createSnippetCache();
        cache.set(k('/a.html', 1), makeSnippet('a'));
        expect(cache.get(k('/a.html', 2))).toBeUndefined();
    });

    it('misses on a different maxChars (different snippet budget)', () => {
        const cache = createSnippetCache();
        cache.set(k('/a.html', 1, 600), makeSnippet('a'));
        expect(cache.get(k('/a.html', 1, 800))).toBeUndefined();
    });

    it('overwrites the same key on repeated set', () => {
        const cache = createSnippetCache();
        cache.set(k('/a.html'), makeSnippet('a'));
        cache.set(k('/a.html'), makeSnippet('b'));
        expect(cache.size()).toBe(1);
        expect(cache.get(k('/a.html'))?.synopsisText).toBe('b');
    });

    it('clear empties the store', () => {
        const cache = createSnippetCache();
        cache.set(k('/a.html'), makeSnippet('a'));
        cache.set(k('/b.html'), makeSnippet('b'));
        cache.clear();
        expect(cache.size()).toBe(0);
        expect(cache.get(k('/a.html'))).toBeUndefined();
    });

    it('evicts the oldest entry once capacity is exceeded', () => {
        const cache = createSnippetCache(2);
        cache.set(k('/a.html'), makeSnippet('a'));
        cache.set(k('/b.html'), makeSnippet('b'));
        cache.set(k('/c.html'), makeSnippet('c'));
        expect(cache.size()).toBe(2);
        expect(cache.get(k('/a.html'))).toBeUndefined();
        expect(cache.get(k('/b.html'))?.synopsisText).toBe('b');
        expect(cache.get(k('/c.html'))?.synopsisText).toBe('c');
    });

    it('refreshes recency on get (LRU, not FIFO)', () => {
        const cache = createSnippetCache(2);
        cache.set(k('/a.html'), makeSnippet('a'));
        cache.set(k('/b.html'), makeSnippet('b'));
        // Reading 'a' makes it the most recently used; the next eviction
        // should drop 'b' instead of 'a'.
        cache.get(k('/a.html'));
        cache.set(k('/c.html'), makeSnippet('c'));
        expect(cache.get(k('/a.html'))?.synopsisText).toBe('a');
        expect(cache.get(k('/b.html'))).toBeUndefined();
        expect(cache.get(k('/c.html'))?.synopsisText).toBe('c');
    });

    it('rejects non-positive capacity', () => {
        expect(() => createSnippetCache(0)).toThrow();
        expect(() => createSnippetCache(-1)).toThrow();
        expect(() => createSnippetCache(1.5)).toThrow();
    });
});
