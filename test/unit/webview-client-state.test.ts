import { beforeEach, describe, expect, it, vi } from 'vitest';

let storedState: unknown = undefined;
const mockApi = {
    postMessage: vi.fn(),
    setState: vi.fn((s: unknown) => {
        storedState = s;
    }),
    getState: vi.fn(() => storedState)
};

(globalThis as unknown as { acquireVsCodeApi: () => typeof mockApi }).acquireVsCodeApi =
    () => mockApi;

import {
    applyScrollTarget,
    getPersistedState,
    postHostMessage,
    setActivePage,
    setPersistedState
} from '../../src/webview-client/state.js';

describe('webview-client state', () => {
    beforeEach(() => {
        storedState = undefined;
        mockApi.postMessage.mockClear();
        mockApi.setState.mockClear();
        mockApi.getState.mockClear();
    });

    it('getPersistedState returns {} when no state has been set', () => {
        expect(getPersistedState()).toEqual({});
    });

    it('coerces non-object getState() values to {}', () => {
        storedState = 42;
        expect(getPersistedState()).toEqual({});
        storedState = 'hello';
        expect(getPersistedState()).toEqual({});
        storedState = null;
        expect(getPersistedState()).toEqual({});
    });

    it('round-trips PersistedState through setState/getState', () => {
        setPersistedState({
            active: {
                docsetId: 1,
                pagePath: 'cpp/algorithm/sort.html',
                scrollY: 1234
            }
        });
        expect(getPersistedState()).toEqual({
            active: {
                docsetId: 1,
                pagePath: 'cpp/algorithm/sort.html',
                scrollY: 1234
            }
        });
    });

    it('setActivePage writes the canonical PersistedState shape (C-1 fix)', () => {
        setActivePage(42, 'en/cpp/container/vector/push_back.html');
        expect(getPersistedState()).toEqual({
            active: {
                docsetId: 42,
                pagePath: 'en/cpp/container/vector/push_back.html'
            }
        });
    });

    it('setActivePage drops prior scrollY when switching pages', () => {
        setPersistedState({
            active: { docsetId: 1, pagePath: 'a.html', scrollY: 200 }
        });
        setActivePage(1, 'b.html');
        expect(getPersistedState()).toEqual({
            active: { docsetId: 1, pagePath: 'b.html' }
        });
    });

    it('postHostMessage forwards typed messages to vscode.postMessage', () => {
        postHostMessage({ type: 'ready' });
        postHostMessage({ type: 'nav', href: 'foo.html' });
        expect(mockApi.postMessage).toHaveBeenNthCalledWith(1, { type: 'ready' });
        expect(mockApi.postMessage).toHaveBeenNthCalledWith(2, {
            type: 'nav',
            href: 'foo.html'
        });
    });
});

// ---------------------------------------------------------------------------
// applyScrollTarget — honors window.__cppref.scrollTarget on every page
// render so each load lands at the top of the document (or the named
// subsection when the click carried a `#fragment`). Replaces the prior
// "restore persisted scrollY on every DOMContentLoaded" behavior, which
// silently inherited an offset from the previously visited page.
// ---------------------------------------------------------------------------

interface ScrollTargetWindow {
    __cppref?: { scrollTarget?: { anchor?: string } };
    scrollTo: (...args: unknown[]) => void;
    addEventListener?: (...args: unknown[]) => void;
}

describe('applyScrollTarget', () => {
    let scrollToCalls: unknown[][];
    let elementScrolledIntoView: string | undefined;

    beforeEach(() => {
        scrollToCalls = [];
        elementScrolledIntoView = undefined;
        // Vitest's default `node` environment doesn't provide `window` /
        // `document`. Install minimal shims on globalThis so the
        // state module's references resolve when imported.
        const win: ScrollTargetWindow = {
            __cppref: undefined,
            scrollTo: (...args: unknown[]) => {
                scrollToCalls.push(args);
            },
            addEventListener: () => {
                // installScrollPersistence isn't exercised here; absorb any
                // accidental wiring without throwing.
            }
        };
        (globalThis as unknown as { window: ScrollTargetWindow }).window = win;
        (globalThis as unknown as { document: unknown }).document = {
            getElementById: (id: string) => {
                if (id === 'present-anchor') {
                    return {
                        scrollIntoView: (_opts?: unknown) => {
                            elementScrolledIntoView = id;
                        }
                    };
                }
                return null;
            }
        };
        // `applyScrollTarget` reads through `window.scrollTo` AND the bare
        // `scrollTo` (some implementations call one or the other); keep
        // both pointing at the same spy.
        (globalThis as unknown as { scrollTo: ScrollTargetWindow['scrollTo'] }).scrollTo =
            win.scrollTo;
    });

    it('scrolls to top when no scrollTarget is present in the bootstrap payload', () => {
        (globalThis as unknown as { window: ScrollTargetWindow }).window.__cppref =
            undefined;
        applyScrollTarget();
        expect(scrollToCalls).toEqual([[0, 0]]);
        expect(elementScrolledIntoView).toBeUndefined();
    });

    it('scrolls to top when scrollTarget is the empty object', () => {
        (globalThis as unknown as { window: ScrollTargetWindow }).window.__cppref = {
            scrollTarget: {}
        };
        applyScrollTarget();
        expect(scrollToCalls).toEqual([[0, 0]]);
    });

    it('scrolls the named element into view when scrollTarget.anchor matches a DOM node', () => {
        (globalThis as unknown as { window: ScrollTargetWindow }).window.__cppref = {
            scrollTarget: { anchor: 'present-anchor' }
        };
        applyScrollTarget();
        expect(elementScrolledIntoView).toBe('present-anchor');
        // The top-of-page fallback must NOT also fire when the anchor
        // resolves — otherwise the user sees a brief flash before the
        // scrollIntoView settles.
        expect(scrollToCalls).toEqual([]);
    });

    it('falls back to scroll-to-top when scrollTarget.anchor does not resolve to an element', () => {
        (globalThis as unknown as { window: ScrollTargetWindow }).window.__cppref = {
            scrollTarget: { anchor: 'no-such-id' }
        };
        applyScrollTarget();
        expect(elementScrolledIntoView).toBeUndefined();
        expect(scrollToCalls).toEqual([[0, 0]]);
    });

    it('scrolls to top when scrollTarget.anchor is the empty string', () => {
        (globalThis as unknown as { window: ScrollTargetWindow }).window.__cppref = {
            scrollTarget: { anchor: '' }
        };
        applyScrollTarget();
        expect(scrollToCalls).toEqual([[0, 0]]);
    });
});
