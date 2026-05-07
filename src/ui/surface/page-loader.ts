import * as path from 'node:path';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { DocsetManager } from '../../docset/manager.js';
import type { CppStandardManager } from '../cpp-standard-manager.js';
import type { HostToClientMessage } from '../../webview-host/messages.js';
import { renderPage, renderPlaceholder, type SharedRenderContext } from './shared.js';
import {
    hrefToTarget,
    type DocsetWebviewBase,
    type NavTarget
} from './navigation.js';

export interface PageLoaderDeps {
    docsets: DocsetManager;
    cppStandard: CppStandardManager;
    /** Reads `cppDocs.attribution.enabled` (defaults to true). */
    attributionEnabled: () => boolean;
    /**
     * Reads `cppDocs.theme.respectVSCodeTheme` (defaults to true). When
     * false, the VSCode-variable theme override style block is omitted
     * and cppreference renders with its stock palette.
     */
    respectVSCodeTheme?: () => boolean;
    /** Reads `cppDocs.panel.zoomLevel` (defaults to 1.0). */
    zoomLevel?: () => number;
    /**
     * Reads `cppDocs.codeTheme`. Unknown or missing ids fall back to the
     * default (`hybrid`) palette in `webview-host/code-themes.ts`.
     */
    codeTheme?: () => string | undefined;
    /**
     * Reads the `cppDocs.controls.show*` settings. Each defaults to
     * `true` when omitted. Plumbed into the bootstrap payload so the
     * webview-client can skip injecting controls the user has hidden.
     */
    controls?: () => {
        showZoom?: boolean;
        showThemePicker?: boolean;
        showNavButtons?: boolean;
    };
    /**
     * Surface kind hosting this render. Plumbed through to the webview-
     * client so the floating "location" button picks the right
     * direction (move-to-editor vs dock-in-sidebar).
     */
    surfaceKind?: 'view' | 'panel';
}

/**
 * Produce the webview-resource prefix for each installed docset's
 * documents directory. Used by the click-intercept message handler to
 * classify an `<a>.href` (already resolved against `<base>`) as in-docset
 * or external.
 */
export function docsetWebviewBases(
    webview: vscode.Webview,
    docsets: DocsetManager
): DocsetWebviewBase[] {
    return docsets.listDocsets().map((d) => {
        const uri = vscode.Uri.file(d.documentsDir);
        let base = webview.asWebviewUri(uri).toString();
        if (!base.endsWith('/')) base += '/';
        return { docsetId: d.id, webviewBase: base };
    });
}

/** Convert a click href to a NavTarget against the installed docsets. */
export function resolveNavHref(
    href: string,
    webview: vscode.Webview,
    docsets: DocsetManager
): NavTarget | undefined {
    return hrefToTarget(href, docsetWebviewBases(webview, docsets));
}

/**
 * Resolve a pre-computed docset-relative pagePath (embedded by the rewriter
 * as `data-cppref-nav`) to a NavTarget. Iterates installed docsets and
 * returns the first one whose documents directory contains the file.
 * Uses synchronous existsSync — fast for a single filesystem stat.
 */
export function resolveNavHrefByPagePath(
    pagePath: string,
    docsets: DocsetManager
): NavTarget | undefined {
    for (const d of docsets.listDocsets()) {
        if (existsSync(path.join(d.documentsDir, pagePath))) {
            return { docsetId: d.id, pagePath };
        }
    }
    return undefined;
}

/**
 * Fallback nav resolver that works by decoding the URL's pathname directly
 * and matching against each docset's filesystem `documentsDir`. This is
 * scheme-agnostic and handles cases where `asWebviewUri` produces a
 * different string format than what the browser returns via `a.href` (e.g.
 * encoding differences, the `https://file+.vscode-resource.vscode-cdn.net`
 * format used in modern VSCode vs the older `vscode-webview-resource://`
 * format). Used as a fallback when `resolveNavHref` returns undefined.
 *
 * Modern VSCode webview URIs have the form:
 *   https://file+.vscode-resource.vscode-cdn.net/path/to/file
 * so `url.pathname` === `/path/to/file` (percent-encoded). Decoding it
 * gives the filesystem path, which we can compare directly against each
 * docset's `documentsDir`.
 */
export function resolveNavHrefByPath(
    href: string,
    docsets: DocsetManager
): NavTarget | undefined {
    let decodedPath: string;
    try {
        const url = new URL(href);
        decodedPath = decodeURIComponent(url.pathname);
    } catch {
        return undefined;
    }
    for (const d of docsets.listDocsets()) {
        const base = d.documentsDir.replace(/\/+$/, '');
        if (decodedPath.startsWith(base + '/')) {
            const pagePath = decodedPath.slice(base.length + 1);
            if (pagePath.length > 0 && pagePath.endsWith('.html')) {
                return { docsetId: d.id, pagePath };
            }
        }
    }
    return undefined;
}

function makeSharedCtx(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    deps: PageLoaderDeps
): SharedRenderContext {
    return {
        webview,
        bootstrapUri,
        respectVSCodeTheme: deps.respectVSCodeTheme?.() ?? true,
        zoomLevel: deps.zoomLevel?.() ?? 1.0,
        codeTheme: deps.codeTheme?.(),
        surfaceKind: deps.surfaceKind,
        ...(deps.controls ? { controls: deps.controls() } : {})
    };
}

/**
 * Render `target` into the given webview. Returns true on success, false
 * when the target's docset has been removed or the file no longer exists.
 *
 * Caller is responsible for pushing the target onto the appropriate
 * `NavigationHistory` (success path) before/after this call.
 */
export async function loadPageInWebview(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    target: NavTarget,
    deps: PageLoaderDeps
): Promise<boolean> {
    const docset = deps.docsets.getDocsetById(target.docsetId);
    if (!docset) return false;

    const filePath = path.join(docset.documentsDir, target.pagePath);
    const resolvedFile = path.resolve(filePath);
    const resolvedBase = path.resolve(docset.documentsDir);
    if (!resolvedFile.startsWith(resolvedBase + path.sep) && resolvedFile !== resolvedBase) {
        return false;
    }
    const pageDirUri = vscode.Uri.file(path.dirname(filePath));
    const documentsDir = vscode.Uri.file(docset.documentsDir);

    const ctx = makeSharedCtx(webview, bootstrapUri, deps);
    const html = await renderPage(ctx, {
        filePath,
        pagePath: pagePathForAttribution(target.pagePath),
        pageDirUri,
        documentsDir,
        attributionEnabled: deps.attributionEnabled(),
        cppStandard: deps.cppStandard.current().token,
        // Per-load scroll target: anchor when the click carried `#frag`,
        // otherwise undefined which the template treats as "scroll to top".
        // This is the wire-level half of the user-requested behavior — every
        // open lands at the top (or the named subsection), regardless of
        // whether this page was visited before.
        ...(target.anchor !== undefined && target.anchor.length > 0
            ? { anchor: target.anchor }
            : {})
    });
    webview.html = html;
    // C-1: tell the client which page is now active so its persisted
    // state (and our serializer's restart-restoration path) carries the
    // identity of the page rather than an undefined `active` slot.
    // `postMessage` is safe to fire-and-forget — if the bootstrap script
    // hasn't loaded yet, the client buffers via `vscode-webview`'s
    // implementation. `pagePath` is the docset-relative path identical
    // to what the serializer reads back as `state.active.pagePath`.
    const setActive: HostToClientMessage = {
        type: 'setActive',
        docsetId: target.docsetId,
        pagePath: target.pagePath
    };
    void webview.postMessage(setActive);
    return true;
}

/**
 * The attribution footer's link is `https://en.cppreference.com/w/<pagePath>`,
 * where `<pagePath>` is the cppreference path *without* the `en/` locale
 * prefix and *without* the `.html` extension (cppreference.com URLs are
 * extensionless). cppreference's html-book stores files at `en/cpp/...html`,
 * so we strip both.
 */
function pagePathForAttribution(rel: string): string {
    return rel.replace(/\\/g, '/').replace(/\.html?$/, '').replace(/^en\//, '');
}

/**
 * Render a blank attribution-only page on the given webview. Used by the
 * `clearPanel` value of `cppDocs.panel.onMissBehavior` (M6.3.B): when the
 * cursor lands on a resolvable FQN that no installed docset carries, the
 * previous content is wiped so the user isn't fooled into thinking the
 * stale page describes the current symbol.
 */
export function renderEmptyPage(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    deps: PageLoaderDeps
): void {
    const ctx = makeSharedCtx(webview, bootstrapUri, deps);
    const html = renderPlaceholder(ctx, {
        attribution: { pagePath: '', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        title: 'C++ Docs',
        bodyHtml: ''
    });
    webview.html = html;
}

/**
 * Render a "no docs page for `<fqn>`" placeholder. Used by the `showLink`
 * value of `cppDocs.panel.onMissBehavior` (M6.3.B). The placeholder hosts
 * a single `command:cppDocs.openSymbol?<json-args>` link pre-filled with
 * the FQN so the user can fan out into the QuickPick from one click.
 *
 * `cppDocs.openSymbol` accepts an optional first arg (string) since
 * M6.3.B; passing the FQN populates the QuickPick value, mirroring the
 * tree-filter command's "pre-fill" semantics.
 */
export function renderMissPlaceholder(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    fqn: string,
    deps: PageLoaderDeps
): void {
    const ctx = makeSharedCtx(webview, bootstrapUri, deps);
    const safeFqn = escapeHtml(fqn);
    const args = encodeURIComponent(JSON.stringify([fqn]));
    const bodyHtml = `<h1>No docs page for <code>${safeFqn}</code></h1>
<p>The resolver matched this name, but no installed docset has a page for it.</p>
<p><a href="command:cppDocs.openSymbol?${args}">Search docsets&hellip;</a></p>`;
    const html = renderPlaceholder(ctx, {
        attribution: { pagePath: '', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        title: `C++ Docs — ${fqn}`,
        bodyHtml
    });
    webview.html = html;
}

/**
 * Render a "view needs to refresh" placeholder. C-2 fix — when a
 * docset is installed / imported / removed after the WebviewView was
 * already resolved, the view's `localResourceRoots` no longer match
 * the indexed docsets and CSS / images for new pages would be blocked.
 * VSCode does not allow mutating `localResourceRoots` post-resolve, so
 * the user gets a one-click `workbench.action.reloadWindow` link.
 */
export function renderReloadPlaceholder(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    deps: PageLoaderDeps
): void {
    const ctx = makeSharedCtx(webview, bootstrapUri, deps);
    const bodyHtml = `<h1>Reload to load new docs</h1>
<p>An installed docset changed since this view opened. VSCode locks the
view's resource roots at creation time, so newly-installed pages can't
load until the view is re-created.</p>
<p><a href="command:workbench.action.reloadWindow">Reload Window</a></p>
<p>You can also <a href="command:cppDocs.moveToEditorTab">open the docs
in a new editor tab</a> instead — fresh tabs pick up the latest docsets.</p>`;
    const html = renderPlaceholder(ctx, {
        attribution: { pagePath: '', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        title: 'C++ Docs — refresh required',
        bodyHtml
    });
    webview.html = html;
}

/**
 * Render a "C++ Docs not installed" placeholder. Sibling to
 * `renderMissPlaceholder`. Used by Fix C — when the cursor lands on a
 * resolvable FQN but zero docsets are installed, surface a visible card
 * with a single `command:cppDocs.installCppreference` link so the user
 * can fix the empty-state in one click. Distinct from `renderMissPlaceholder`
 * because the user-visible action is "install", not "search".
 */
export function renderNotInstalledPlaceholder(
    webview: vscode.Webview,
    bootstrapUri: vscode.Uri,
    fqn: string,
    deps: PageLoaderDeps
): void {
    const ctx = makeSharedCtx(webview, bootstrapUri, deps);
    const safeFqn = escapeHtml(fqn);
    const bodyHtml = `<h1>C++ Docs not installed</h1>
<p>Tried to look up <code>${safeFqn}</code> but no docsets are available yet.</p>
<p><a href="command:cppDocs.installCppreference">Install cppreference (~7 MB)</a></p>
<p>Already installed but missing? <a href="command:cppDocs.checkForUpdates">Check for updates</a>.</p>`;
    const html = renderPlaceholder(ctx, {
        attribution: { pagePath: '', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        title: `C++ Docs — ${fqn}`,
        bodyHtml
    });
    webview.html = html;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
