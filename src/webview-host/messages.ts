/**
 * Discriminated unions for messages exchanged between the host (extension)
 * and the webview client (bootstrap.js). Type-only — no runtime imports —
 * so both bundles can share the same source file without coupling.
 *
 * Per docs/02-architecture.md §"Message passing".
 */

export type ClientToHostMessage =
    | { type: 'ready' }
    | { type: 'nav'; href: string }
    | { type: 'openExternal'; href: string }
    | { type: 'setState'; scrollY: number }
    | { type: 'zoomDelta'; delta: number }
    | {
        /**
         * Webview-side theme picker selected a new base16 palette. The
         * host persists the choice to `cppDocs.codeTheme` and broadcasts
         * a `setCodeTheme` reply with the materialized CSS variables so
         * all open surfaces (panel + sidebar view) update together.
         */
        type: 'pickCodeTheme';
        themeId: string;
    }
    | {
        /**
         * Fires when the user clicks the in-webview back / forward
         * navigation buttons. The host resolves `command` to a known
         * VSCode command id (`cppDocs.back` / `cppDocs.forward`) before
         * dispatching, so a tampered payload can't trigger arbitrary
         * commands.
         */
        type: 'runCommand';
        command:
        | 'cppDocs.back'
        | 'cppDocs.forward'
        | 'cppDocs.moveToEditorTab'
        | 'cppDocs.dockInSidebar';
    }
    | {
        /**
         * Diagnostic — fired by the click classifier on EVERY left-click
         * inside a webview, before the routing decision is acted on. The
         * host logs these to the C++ Docs output channel so the user can
         * see exactly what was clicked, where it resolved to, and which
         * branch (nav / external / anchor / skip) was taken. Helps debug
         * "my clicks open the browser" reports.
         */
        type: 'click';
        decision: 'nav' | 'external' | 'anchor' | 'skip';
        rawHref: string;
        resolvedHref: string;
        docsetWebviewBase: string;
        hasExternalMarker: boolean;
        inInteractiveAncestor: boolean;
    };

export type HostToClientMessage =
    | {
        type: 'loadPage';
        html: string;
        baseUri: string;
        scrollY?: number;
        scrollToAnchor?: string;
    }
    | { type: 'setStandard'; value: string }
    | { type: 'setZoom'; value: number }
    | {
        /**
         * Live theme swap. The client locates the
         * `<style id="cppref-code-theme-vars">` block emitted by the
         * template and replaces its textContent so every code block
         * recolors without a re-render. `kind` lets the picker UI keep
         * its dark/light grouping in sync with the active selection.
         */
        type: 'setCodeTheme';
        themeId: string;
        kind: 'dark' | 'light';
        /** Body of the :root { ... } declaration (no enclosing braces). */
        cssVars: string;
    }
    | {
        /**
         * Tell the client which page is currently rendered. The client
         * folds this into its persisted state (`vscode.setState`) so the
         * `WebviewPanelSerializer` can revive the panel onto the same
         * page after a VSCode restart. Per C-1 in docs/CODE-REVIEW-2026-05-07.md.
         */
        type: 'setActive';
        docsetId: number;
        pagePath: string;
    };
