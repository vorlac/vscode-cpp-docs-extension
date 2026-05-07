import * as fs from 'node:fs/promises';
import type * as vscode from 'vscode';
import { buildAllStandardFiltersCss } from '../cpp-standard.js';
import { rewriteHtml } from '../../webview-host/rewriter.js';
import { getCodeTheme } from '../../webview-host/code-themes.js';
import {
    generateNonce,
    renderShellHtml,
    type AttributionContext,
    type TemplateContext
} from '../../webview-host/template.js';

const STANDARD_FILTER_CSS = buildAllStandardFiltersCss();

/**
 * Per-render context shared between WebviewView and WebviewPanel surfaces.
 * The two surfaces only differ in their VSCode primitive; rendering itself
 * goes through the same pipeline.
 */
export interface SharedRenderContext {
    webview: vscode.Webview;
    /** Filesystem URI of the bootstrap bundle (`dist/client/bootstrap.js`). */
    bootstrapUri: vscode.Uri;
    /**
     * Honor `cppDocs.theme.respectVSCodeTheme`. When false the
     * VSCode-variable theme override is omitted and cppreference renders
     * with its stock palette. Defaults to true.
     */
    respectVSCodeTheme?: boolean;
    /** Initial zoom level (1.0 = 100%). Embedded in `window.__cppref.zoomLevel`. */
    zoomLevel?: number;
    /**
     * Base16 code-snippet theme id. Looked up in
     * `webview-host/code-themes.ts`; unknown values fall back to the
     * default palette so a typoed setting can't break the render.
     */
    codeTheme?: string;
    /**
     * Surface kind hosting this render. Plumbed to the webview-client
     * so the floating "location" button picks the right direction —
     * `'view'` shows a pop-out (move to editor tab) glyph; `'panel'`
     * shows a dock-in-sidebar glyph.
     */
    surfaceKind?: 'view' | 'panel';
    /**
     * Visibility toggles for the floating in-panel controls. Each
     * mirrors a user setting under `cppDocs.controls.*`. Default
     * `true` everywhere — passing `false` skips the corresponding
     * inject in the client bootstrap.
     */
    controls?: {
        showZoom?: boolean;
        showThemePicker?: boolean;
        showNavButtons?: boolean;
    };
}

export interface PageRenderRequest {
    /** Absolute filesystem path to the cppreference HTML page. */
    filePath: string;
    /** Cppreference path used in attribution (e.g. `cpp/container/vector/push_back`). */
    pagePath: string;
    /**
     * URI of the directory containing the page (i.e. `vscode.Uri.file(path.dirname(filePath))`).
     * Drives `<base href>` — must be the page's directory so cppreference's
     * `../../../common/ext.css` etc. resolve correctly.
     */
    pageDirUri: vscode.Uri;
    /**
     * Docset's documents-directory URI (e.g. `<rootPath>/reference/` for
     * cppreference). Drives the
     * click-intercept "in-docset" classifier (`window.__cppref.docsetWebviewBase`);
     * must be in the webview's `localResourceRoots` so the page's resources
     * can be fetched.
     */
    documentsDir: vscode.Uri;
    attributionEnabled: boolean;
    cppStandard?: string;
    /**
     * Optional in-page anchor id. When set, the webview-client scrolls
     * the matching element into view on `DOMContentLoaded` instead of
     * landing at the top of the document. Plumbed from a click that
     * carried `#fragment` (via `hrefToTarget`) or from a tree-reveal
     * that knows the exact section it wants to surface.
     */
    anchor?: string;
}

export interface PlaceholderRenderRequest {
    attribution: AttributionContext;
    cppStandard?: string;
    /** Title in the document `<title>` (also acts as the panel title). */
    title?: string;
    /** Body HTML to render inside the shell. Defaults to a generic welcome. */
    bodyHtml?: string;
    /**
     * Fix C (iter 37) — render the install-CTA welcome variant when no
     * docsets are installed. Routes the user to a clickable
     * `command:cppDocs.installCppreference` link instead of the prose
     * `<em>` instruction. Ignored when `bodyHtml` is provided explicitly
     * (the override always wins).
     */
    noDocsets?: boolean;
}

const DEFAULT_PLACEHOLDER_BODY = `<h1>C++ Docs</h1>
<p>Open a symbol via the <em>C++ Docs: Open Symbol&hellip;</em> command, or install cppreference via <em>C++ Docs: Install cppreference</em>.</p>
<p>Once installed, place your cursor on a C/C++ symbol to load its reference here.</p>`;

/**
 * No-docsets variant of the welcome body. Surfaces an explicit Install
 * CTA as a `command:` link rather than the prose `<em>` instruction in
 * the default body — the user's failure mode is "I don't see anything
 * happening", and the Install link is the one click that fixes it.
 *
 * The `cppDocs.showOutput` link points users at our diagnostic channel
 * for the cases where the install is fine but resolver/lookup is the
 * bottleneck.
 */
const NO_DOCSETS_PLACEHOLDER_BODY = `<h1>C++ Docs</h1>
<p>No docsets are installed yet. Cursor-follow and hover are silent until at least one docset is available.</p>
<p><a href="command:cppDocs.installCppreference">Install cppreference now (~7 MB)</a></p>
<p>Curious why nothing's loading? <a href="command:cppDocs.showOutput">Open the C++ Docs output channel</a> for diagnostics.</p>`;

function withTrailingSlash(s: string): string {
    return s.endsWith('/') ? s : s + '/';
}

function buildTemplate(
    ctx: SharedRenderContext,
    baseHref: string | undefined,
    docsetWebviewBase: string | undefined,
    cppStandard: string | undefined,
    includeStandardFilter: boolean,
    scrollTarget?: { anchor?: string }
): TemplateContext {
    return {
        cspSource: ctx.webview.cspSource,
        nonce: generateNonce(),
        baseHref,
        bootstrapScriptUri: ctx.webview.asWebviewUri(ctx.bootstrapUri).toString(),
        docsetWebviewBase: docsetWebviewBase ?? baseHref ?? '',
        cppStandard,
        respectVSCodeTheme: ctx.respectVSCodeTheme ?? true,
        zoomLevel: ctx.zoomLevel ?? 1.0,
        codeTheme: getCodeTheme(ctx.codeTheme),
        surfaceKind: ctx.surfaceKind ?? 'view',
        ...(ctx.controls ? { controls: ctx.controls } : {}),
        ...(includeStandardFilter ? { standardFilterCss: STANDARD_FILTER_CSS } : {}),
        // Always emit a scroll-target so each render lands at a
        // predictable position. Default (no anchor) means "scroll to top".
        scrollTarget: scrollTarget ?? {}
    };
}

/**
 * Read the cppreference page from disk and stream it through the rewriter,
 * producing the full HTML to assign to `webview.html`.
 *
 * `<base href>` is set to the **page's directory URL**, not the docset
 * root — cppreference pages use relative paths like `../../common/ext.css`
 * which only resolve correctly when the base is the page's location. The
 * `docsetWebviewBase` (used by click-intercept to detect in-docset links)
 * is the documents-dir URI prefix.
 *
 * Caller must ensure `req.documentsDir` is included in the webview's
 * `localResourceRoots` so the page's `<link>`s and `<img>`s can be fetched.
 */
export async function renderPage(
    ctx: SharedRenderContext,
    req: PageRenderRequest
): Promise<string> {
    const html = await fs.readFile(req.filePath, 'utf8');
    const baseHref = withTrailingSlash(
        ctx.webview.asWebviewUri(req.pageDirUri).toString()
    );
    const docsetWebviewBase = withTrailingSlash(
        ctx.webview.asWebviewUri(req.documentsDir).toString()
    );
    return rewriteHtml(html, {
        template: buildTemplate(
            ctx,
            baseHref,
            docsetWebviewBase,
            req.cppStandard,
      /* includeStandardFilter */ true,
            req.anchor !== undefined && req.anchor.length > 0
                ? { anchor: req.anchor }
                : {}
        ),
        attribution: { pagePath: req.pagePath, enabled: req.attributionEnabled }
    });
}

/**
 * Render a placeholder page through the same shell as real cppreference
 * pages. Used until the user picks a symbol or installs a docset.
 */
export function renderPlaceholder(
    ctx: SharedRenderContext,
    req: PlaceholderRenderRequest
): string {
    const defaultBody = req.noDocsets
        ? NO_DOCSETS_PLACEHOLDER_BODY
        : DEFAULT_PLACEHOLDER_BODY;
    return renderShellHtml({
        template: buildTemplate(
            ctx,
            undefined,
            undefined,
            req.cppStandard,
      /* includeStandardFilter */ false
        ),
        attribution: req.attribution,
        title: req.title ?? 'C++ Docs',
        bodyHtml: req.bodyHtml ?? defaultBody
    });
}
