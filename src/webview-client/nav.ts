import { postHostMessage } from './state.js';

declare global {
    interface Window {
        __cppref?: {
            docsetWebviewBase: string;
            cppStandard: string;
            zoomLevel?: number;
            /**
             * Per-render scroll target the host injects on every page load.
             * `state.ts:applyScrollTarget` honors this on `DOMContentLoaded`
             * — anchor present → scroll element into view; anchor absent →
             * scroll to top. Defaults to `{}` when the host doesn't emit
             * one (older bootstrap payloads), in which case the client
             * still defaults to scrolling to top.
             */
            scrollTarget?: { anchor?: string };
            /** Active base16 code-snippet theme id at first paint. */
            codeTheme?: string;
            /** Available themes for the in-panel picker dropdown. */
            codeThemes?: ReadonlyArray<{
                id: string;
                label: string;
                kind: 'dark' | 'light';
            }>;
            /**
             * Which surface kind is hosting this render. The location
             * controls' button uses it to pick between "pop out to editor
             * tab" and "dock in side panel" affordances.
             */
            surfaceKind?: 'view' | 'panel';
            /**
             * Visibility toggles for the floating in-panel controls. The
             * host populates each from a corresponding user setting under
             * `cppDocs.controls.*`. Absent / `true` ⇒ render; `false` ⇒
             * skip the inject.
             */
            controls?: {
                showZoom?: boolean;
                showThemePicker?: boolean;
                showNavButtons?: boolean;
            };
        };
    }
}

export type ClickDecision =
    | { kind: 'skip' }
    | { kind: 'anchor'; id: string }
    | { kind: 'nav'; href: string }
    | { kind: 'external'; href: string };

export interface ClickInput {
    /** Raw `href` attribute value (may be percent-encoded). */
    rawHref: string;
    /** Resolved `.href` (after `<base>` resolution; absolute URL). */
    resolvedHref: string;
    /** Anchor or any ancestor carries `data-cppref-external`. */
    hasExternalMarker: boolean;
    /** Anchor sits inside our own UI (`.cppref-no-intercept`). */
    inNoIntercept: boolean;
    /** Anchor sits inside `summary`/`button`/`input` —
     *  let those native semantics win (docs/06-gotchas.md #14). */
    inInteractiveAncestor: boolean;
    /** Mouse button (0 = left). */
    button: number;
    /** Cmd/Ctrl/Shift/Alt held — user wants browser-style external open. */
    modifierKeyPressed: boolean;
    /** Webview-URI prefix that scopes "in-docset" links. */
    docsetWebviewBase: string;
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/**
 * Pure click-decision logic. Inputs are extracted from the DOM event by
 * the listener installed in `installNavListener`; the function itself has
 * no DOM dependencies and is the testable surface.
 *
 * Order of precedence:
 *   1. Skip non-left-click and right/middle clicks.
 *   2. Skip clicks inside our own UI (`.cppref-no-intercept`).
 *   3. Skip clicks inside summary/button/input — let native
 *      focus management, etc. work.
 *   4. Hash-only `#id` → in-page anchor scroll.
 *   5. Anchor flagged with `data-cppref-external` → openExternal.
 *   6. Modifier-key click → openExternal (cmd-click "open in browser").
 *   7. URL inside the docset prefix → nav.
 *   8. Anything else → openExternal.
 */
export function classifyClick(input: ClickInput): ClickDecision {
    if (input.button !== 0) return { kind: 'skip' };
    if (input.inNoIntercept) return { kind: 'skip' };
    if (input.inInteractiveAncestor) return { kind: 'skip' };

    const decoded = safeDecode(input.rawHref);
    if (decoded.startsWith('#')) {
        return { kind: 'anchor', id: decoded.slice(1) };
    }

    if (input.hasExternalMarker) {
        return { kind: 'external', href: input.resolvedHref };
    }

    if (input.modifierKeyPressed) {
        return { kind: 'external', href: input.resolvedHref };
    }

    if (
        input.docsetWebviewBase.length > 0 &&
        input.resolvedHref.startsWith(input.docsetWebviewBase)
    ) {
        return { kind: 'nav', href: input.resolvedHref };
    }

    return { kind: 'external', href: input.resolvedHref };
}

export function installNavListener(): void {
    document.addEventListener(
        'click',
        (e: MouseEvent) => {
            const target = e.target as Element | null;
            const a = target?.closest('a[href]') as HTMLAnchorElement | null;
            if (!a) return;

            // Fast path: rewriter pre-computed the docset-relative pagePath and
            // embedded it as data-cppref-nav. Use it directly — no URI parsing,
            // no encoding mismatches, no format differences across VSCode versions.
            const precomputedNavPath = (a as HTMLElement).dataset['cpprefNav'];
            if (precomputedNavPath) {
                if (a.closest('.cppref-no-intercept')) return;
                if (!!a.closest('summary, button, input')) return;
                if (e.button !== 0) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                    // modifier-click: open externally
                    e.preventDefault();
                    e.stopPropagation();
                    postHostMessage({ type: 'openExternal', href: a.href });
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                postHostMessage({ type: 'nav', href: 'cppref:' + precomputedNavPath });
                return;
            }

            const docsetWebviewBase =
                (typeof window !== 'undefined' && window.__cppref?.docsetWebviewBase) ||
                '';

            const rawHref = a.getAttribute('href') ?? '';
            const resolvedHref = a.href;
            const hasExternalMarker =
                a.matches('[data-cppref-external]') ||
                !!a.closest('[data-cppref-external]');
            const inInteractiveAncestor = !!a.closest(
                'summary, button, input'
            );

            const decision = classifyClick({
                rawHref,
                resolvedHref,
                hasExternalMarker,
                inNoIntercept: !!a.closest('.cppref-no-intercept'),
                inInteractiveAncestor,
                button: e.button,
                modifierKeyPressed:
                    e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
                docsetWebviewBase
            });

            // Diagnostic: forward every classification decision to the host.
            postHostMessage({
                type: 'click',
                decision: decision.kind === 'anchor'
                    ? 'anchor'
                    : decision.kind === 'nav'
                        ? 'nav'
                        : decision.kind === 'external'
                            ? 'external'
                            : 'skip',
                rawHref,
                resolvedHref,
                docsetWebviewBase,
                hasExternalMarker,
                inInteractiveAncestor
            });

            if (decision.kind === 'skip') return;

            e.preventDefault();
            e.stopPropagation();

            switch (decision.kind) {
                case 'anchor':
                    if (decision.id) {
                        document
                            .getElementById(decision.id)
                            ?.scrollIntoView({ block: 'start' });
                    }
                    break;
                case 'nav':
                    postHostMessage({ type: 'nav', href: decision.href });
                    break;
                case 'external':
                    postHostMessage({ type: 'openExternal', href: decision.href });
                    break;
            }
        },
    /* capture */ true
    );
}
