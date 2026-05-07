import type { ClientToHostMessage } from '../webview-host/messages.js';

/**
 * Persisted state shape — must match `SerializedPanelState` in
 * `src/ui/surface/serializer.ts` so the WebviewPanelSerializer can
 * revive the panel onto the same page after a VSCode restart.
 *
 * Per C-1 in docs/CODE-REVIEW-2026-05-07.md: the prior shape was
 * `{ scrollY, page }` which the serializer never read, so panel revival
 * always fell through to the welcome placeholder.
 */
export interface PersistedState {
    active?: {
        docsetId: number;
        pagePath: string;
        scrollY?: number;
    };
}

interface VsCodeApi {
    postMessage(msg: unknown): void;
    setState(state: unknown): void;
    getState(): unknown;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function getApi(): VsCodeApi {
    if (!api) api = acquireVsCodeApi();
    return api;
}

export function getPersistedState(): PersistedState {
    const s = getApi().getState();
    if (s && typeof s === 'object') return s as PersistedState;
    return {};
}

export function setPersistedState(state: PersistedState): void {
    getApi().setState(state);
}

export function postHostMessage(msg: ClientToHostMessage): void {
    getApi().postMessage(msg);
}

/**
 * Update the persisted "active" page record. Called when the host
 * tells us which page is rendered (via the `setActive` message).
 */
export function setActivePage(docsetId: number, pagePath: string): void {
    setPersistedState({ active: { docsetId, pagePath } });
}

/**
 * Persist scroll position on debounced scroll events, and apply the
 * per-render scroll target on `DOMContentLoaded`.
 *
 * The host emits a `scrollTarget` in the bootstrap data for every page
 * render (see `TemplateContext.scrollTarget`):
 *   - `{ anchor: 'id' }` → scroll the named element into view.
 *   - `{}`              → scroll to the top of the document.
 *
 * Pre-fix this handler restored the persisted `scrollY` on every
 * `DOMContentLoaded`, which meant revisiting a page (or even clicking
 * a fresh link after scrolling somewhere else) silently picked up an
 * old offset. The user reported this as confusing — they expect every
 * page open to start at the top (or land on a specific subsection).
 * The scrollY save remains because it's still useful for diagnostic
 * purposes and the serializer's restart-restoration path (the host
 * can decide later whether to honor it).
 */
export function installScrollPersistence(debounceMs = 100): void {
    // Prevent the browser from auto-restoring a prior scroll position when
    // VSCode replaces the webview's HTML. Without this, navigating back to
    // a previously-visited page can land mid-document on the position the
    // user last scrolled to — directly contradicting the per-render
    // scroll target embedded in `window.__cppref.scrollTarget`.
    try {
        if ('scrollRestoration' in history) {
            history.scrollRestoration = 'manual';
        }
    } catch {
        // Some sandboxed contexts disallow writes here; the absence of
        // explicit manual mode just means we rely on `applyScrollTarget`
        // alone, which is still correct in the common case.
    }

    let pending: number | undefined;
    window.addEventListener(
        'scroll',
        () => {
            if (pending !== undefined) clearTimeout(pending);
            pending = window.setTimeout(() => {
                const prev = getPersistedState();
                const scrollY = window.scrollY;
                const active = prev.active
                    ? { ...prev.active, scrollY }
                    : undefined;
                const next: PersistedState = active ? { active } : {};
                setPersistedState(next);
                postHostMessage({ type: 'setState', scrollY });
            }, debounceMs);
        },
        { passive: true }
    );

    // Apply the per-render scroll target as soon as we can. If the
    // document is still loading, wait for DOMContentLoaded; otherwise
    // (defensive — the bootstrap script may have loaded late or this is
    // a re-invocation after content was already parsed), apply now.
    if (document.readyState === 'loading') {
        window.addEventListener(
            'DOMContentLoaded',
            () => applyScrollTarget(),
            { once: true }
        );
    } else {
        applyScrollTarget();
    }
}

/**
 * Auto-hide the sticky breadcrumb when the user scrolls away from
 * the top of the page; restore it when they return to the top.
 * Sets `body[data-cppref-scrolled="1"]` to drive the CSS transition
 * (see `.cppref-breadcrumb` rules in `template.ts`).
 *
 * The threshold is intentionally tiny (any scroll past the very top
 * hides the bar) per the user's requested behavior: "force it to
 * scroll up and stay hidden as soon as the user scrolls down at all
 * in the file." A small dead-zone (`HIDE_AT_PX`) prevents a single
 * pixel of overscroll bounce from flipping the state, but the bar
 * is effectively at-top-only.
 */
const HIDE_AT_PX = 4;
export function installBreadcrumbAutoHide(): void {
    let pending = false;
    const update = (): void => {
        if (!document.body) return;
        const y = window.scrollY || window.pageYOffset || 0;
        const scrolled = y > HIDE_AT_PX;
        const current = document.body.dataset['cpprefScrolled'] === '1';
        if (scrolled !== current) {
            document.body.dataset['cpprefScrolled'] = scrolled ? '1' : '0';
        }
    };
    window.addEventListener(
        'scroll',
        () => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                update();
            });
        },
        { passive: true }
    );
    // First-paint sync: avoid a flash of the breadcrumb on revival
    // when the page is restored mid-scroll.
    if (document.body) update();
    else
        window.addEventListener('DOMContentLoaded', () => update(), {
            once: true
        });
}

/**
 * Apply the per-render scroll target embedded in `window.__cppref`.
 * Falls through to a scroll-to-top when no anchor is set (or the
 * named element doesn't exist on this page). Exported for tests.
 *
 * Two-pass approach: call immediately (DOMContentLoaded / bootstrap
 * time) AND schedule a requestAnimationFrame follow-up. The first call
 * handles the common case; the rAF fires after the first layout+paint,
 * overriding Chromium's deferred scroll-restoration pass which can run
 * between DOMContentLoaded and the first paint and silently undo the
 * initial scrollTo(0,0) — this is the root cause of pages opening
 * mid-scroll when the webview reuses the same Chromium renderer context
 * across webview.html reassignments.
 */
export function applyScrollTarget(): void {
    const target = window.__cppref?.scrollTarget;
    const anchor = target?.anchor;
    if (typeof anchor === 'string' && anchor.length > 0) {
        const el = document.getElementById(anchor);
        if (el) {
            // `auto` (instant) rather than smooth so the user doesn't see
            // the page flash through scroll positions on first paint.
            el.scrollIntoView({ block: 'start', behavior: 'auto' });
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'auto' });
                });
            }
            return;
        }
        // Fall through to top if the anchor doesn't resolve — at least
        // the user sees the beginning of the page they asked for.
    }
    window.scrollTo(0, 0);
    // Belt-and-suspenders: re-apply after the first layout+paint so
    // Chromium's deferred scroll restoration can't override us.
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => window.scrollTo(0, 0));
    }
}
