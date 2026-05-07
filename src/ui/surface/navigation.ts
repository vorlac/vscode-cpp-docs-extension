/**
 * In-memory navigation history per surface, sized to a fixed cap. The
 * `cppDocs.back`/`cppDocs.forward` commands operate on the active surface's
 * history; on push, the forward stack clears (browser-style).
 *
 * Snapshots are JSON-safe so a surface's history can be persisted to
 * `globalState` (Phase-2 polish) or threaded through the webview-panel
 * serializer for restart-restoration.
 */
export interface NavTarget {
    docsetId: number;
    /** Path relative to the docset's documents directory (forward slashes). */
    pagePath: string;
    /** Optional scroll position in the page. */
    scrollY?: number;
    /** Optional anchor to scroll to on load. */
    anchor?: string;
}

export interface HistorySnapshot {
    active: NavTarget | null;
    back: NavTarget[];
    forward: NavTarget[];
}

const DEFAULT_CAP = 50;

export class NavigationHistory {
    private backStack: NavTarget[] = [];
    private forwardStack: NavTarget[] = [];
    private active: NavTarget | undefined;
    private readonly cap: number;

    constructor(cap = DEFAULT_CAP) {
        this.cap = Math.max(1, cap);
    }

    current(): NavTarget | undefined {
        return this.active;
    }

    /**
     * Replace the active target without disturbing back/forward stacks.
     * Used by the host's `onState` handler to fold an updated `scrollY`
     * (or anchor) into the current entry. No-op when there's nothing
     * active.
     */
    replaceCurrent(target: NavTarget): void {
        if (this.active) this.active = target;
    }

    /** Navigate to a new page (clears the forward stack). */
    push(target: NavTarget): void {
        if (this.active) {
            this.backStack.push(this.active);
            while (this.backStack.length > this.cap) this.backStack.shift();
        }
        this.active = target;
        this.forwardStack = [];
    }

    /** Move one step back; returns the new active target or undefined if at start. */
    goBack(): NavTarget | undefined {
        const prev = this.backStack.pop();
        if (!prev) return undefined;
        if (this.active) this.forwardStack.push(this.active);
        this.active = prev;
        return this.active;
    }

    /** Move one step forward; returns the new active target or undefined if at tip. */
    goForward(): NavTarget | undefined {
        const next = this.forwardStack.pop();
        if (!next) return undefined;
        if (this.active) this.backStack.push(this.active);
        this.active = next;
        return this.active;
    }

    canGoBack(): boolean {
        return this.backStack.length > 0;
    }

    canGoForward(): boolean {
        return this.forwardStack.length > 0;
    }

    snapshot(): HistorySnapshot {
        return {
            active: this.active ?? null,
            back: [...this.backStack],
            forward: [...this.forwardStack]
        };
    }

    restore(snapshot: Partial<HistorySnapshot>): void {
        this.active = snapshot.active ?? undefined;
        this.backStack = [...(snapshot.back ?? [])];
        this.forwardStack = [...(snapshot.forward ?? [])];
        while (this.backStack.length > this.cap) this.backStack.shift();
        while (this.forwardStack.length > this.cap) this.forwardStack.shift();
    }
}

/**
 * Resolve a clicked anchor's resolved-href (a webview-cdn URL after
 * `<base>` resolution) to a NavTarget by matching against the installed
 * docsets' webview-resource prefixes. Returns undefined when the href
 * doesn't start with any docset's documents-dir prefix — the caller
 * should fall back to `openExternal`.
 */
export interface DocsetWebviewBase {
    docsetId: number;
    webviewBase: string;
}

export function hrefToTarget(
    href: string,
    bases: readonly DocsetWebviewBase[]
): NavTarget | undefined {
    const hashIdx = href.indexOf('#');
    const queryIdx = href.indexOf('?');
    const cutIdx =
        hashIdx >= 0 && queryIdx >= 0
            ? Math.min(hashIdx, queryIdx)
            : hashIdx >= 0
            ? hashIdx
            : queryIdx >= 0
            ? queryIdx
            : href.length;
    const path = href.slice(0, cutIdx);
    const anchor =
        hashIdx >= 0 ? href.slice(hashIdx + 1).split('?')[0] : undefined;
    for (const { docsetId, webviewBase } of bases) {
        if (path.length < webviewBase.length) continue;
        if (!path.startsWith(webviewBase)) continue;
        const pagePath = path.slice(webviewBase.length);
        if (pagePath.length === 0) continue;
        return {
            docsetId,
            pagePath,
            ...(anchor !== undefined && anchor.length > 0 ? { anchor } : {})
        };
    }
    return undefined;
}
