import { Parser } from 'htmlparser2';
import { escapeText } from '../util/html-escape.js';
import { VOID_TAGS, serializeAttrs, type AttrFilter } from './html-serializer.js';
import {
    buildAttributionFooter,
    buildBreadcrumbHtml,
    buildHeadEarlyInjections,
    buildHeadLateInjections,
    type AttributionContext,
    type TemplateContext
} from './template.js';

/**
 * Top-level tables that should NOT be wrapped in a scroll container.
 * cppreference uses `<table>` for both content (declarations, member
 * lists, parameter blocks — wrap these) AND chrome (the navbar header
 * and its hover dropdowns — wrapping breaks dropdown positioning).
 *
 * Defaulting to wrap-everything-except-chrome, rather than whitelisting
 * the dozen-or-so content classes individually, means new cppreference
 * release variants automatically get the responsive treatment without
 * the rewriter needing an update.
 */
const NO_WRAP_TABLE_CLASSES = [
    't-navbar-head',
    't-navbar-menu',
    't-navbar',
    't-noprint'
];

function shouldWrapTable(attribs: Record<string, string>): boolean {
    const cls = attribs['class'];
    if (!cls) return true;
    const classes = cls.split(/\s+/);
    for (const c of NO_WRAP_TABLE_CLASSES) {
        if (classes.includes(c)) return false;
    }
    return true;
}

export interface RewriteContext {
    template: TemplateContext;
    attribution: AttributionContext;
}

/**
 * Compute the page's directory path relative to the docset documents root,
 * e.g. "en/cpp/container/" for a vector.html page. Returns empty string when
 * the template context lacks baseHref or docsetWebviewBase.
 */
function getPageRelDir(template: TemplateContext): string {
    const base = template.docsetWebviewBase;
    const pageDir = template.baseHref;
    if (!base || !pageDir || !pageDir.startsWith(base)) return '';
    return pageDir.slice(base.length); // already has trailing slash from withTrailingSlash
}

/**
 * Resolve a relative href against the page's directory (expressed as a path
 * relative to the docset root, e.g. "en/cpp/container/") and return the
 * docset-relative pagePath (e.g. "en/cpp/memory/allocator.html"), or
 * undefined if the href is external, absolute, non-HTML, or escapes the
 * docset root.
 *
 * Uses a synthetic "https://x.y/" base so URL resolution is done by the
 * URL constructor — no filesystem access, no encoding issues.
 */
function resolveInDocsetHref(href: string, pageRelDir: string): string | undefined {
    if (!href) return undefined;
    // Absolute URL schemes — skip external / command / data / anchor links.
    if (
        href.startsWith('#') ||
        href.startsWith('javascript:') ||
        href.startsWith('data:') ||
        href.startsWith('mailto:') ||
        href.startsWith('command:') ||
        /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(href)
    ) {
        return undefined;
    }
    try {
        const syntheticBase = new URL('https://x.y/' + pageRelDir);
        const resolved = new URL(href, syntheticBase);
        if (resolved.host !== 'x.y') return undefined;
        const pagePath = resolved.pathname.slice(1); // strip leading /
        if (!pagePath.endsWith('.html') || pagePath.length === 0) return undefined;
        return pagePath;
    } catch {
        return undefined;
    }
}

export interface RewriteOptions {
    /**
     * If true, drop every `<script>` tag (and its body) regardless of source.
     * Defense in depth: cppreference HTML carries inline GTM / MediaWiki scripts
     * that CSP would block at runtime anyway. Stripping keeps the DOM clean and
     * avoids console warnings. Per docs/04-rendering.md (install-time strip
     * section) and the M2 acceptance bullet "Stripped: GTM, MediaWiki analytics".
     * Default: true.
     */
    stripScripts?: boolean;
}

/**
 * Filter inline `style="…"` declarations down to the rules that don't
 * paint over the VSCode theme. cppreference's HTML carries a *lot* of
 * inline `background:`, `background-color:`, and `color:` declarations
 * — these have inline-style specificity, which beats anything in our
 * injected `<style>` block short of `!important` on every selector
 * (and even there, a matching `!important` inline-style would win).
 *
 * Stripping them at the rewriter is the simplest way to guarantee the
 * theme block lands. Layout-relevant rules (`width`, `padding`,
 * `text-align`, etc.) are preserved.
 */
function sanitizeInlineStyle(value: string): string {
    if (!value) return value;
    const declarations = value.split(';');
    const kept: string[] = [];
    for (const raw of declarations) {
        const decl = raw.trim();
        if (!decl) continue;
        const colon = decl.indexOf(':');
        if (colon < 0) {
            kept.push(decl);
            continue;
        }
        const prop = decl.slice(0, colon).trim().toLowerCase();
        if (
            prop === 'background' ||
            prop === 'background-color' ||
            prop === 'background-image' ||
            prop === 'color' ||
            prop === 'border' ||
            prop === 'border-color' ||
            prop === 'border-top-color' ||
            prop === 'border-right-color' ||
            prop === 'border-bottom-color' ||
            prop === 'border-left-color'
        ) {
            continue;
        }
        kept.push(decl);
    }
    return kept.join('; ');
}

/**
 * Attribute filter for the shared serializeAttrs: drops `bgcolor` entirely
 * (bypasses CSS specificity), sanitizes `style` values to strip theme-busting
 * color/background declarations, and drops `style` if nothing survives.
 */
const rewriterAttrFilter: AttrFilter = (k, v, _tag) => {
    // Drop the legacy `bgcolor` HTML attribute entirely — it bypasses
    // CSS specificity and hard-codes a light-palette background that
    // our theme block can't override.
    if (k === 'bgcolor') return null;
    if (k === 'style') {
        const sanitized = sanitizeInlineStyle(v);
        return sanitized || null;
    }
    return v;
};

/**
 * Stream-rewrite a cppreference HTML page through htmlparser2:
 *  - inject the EARLY head block (CSP, base, bootstrap data, bootstrap
 *    script) as the first children of `<head>` so the bootstrap script runs
 *    before any page-emitted script and CSP applies to everything that
 *    follows (docs/06-gotchas.md #1)
 *  - inject the LATE head block (theme + standard-filter `<style>`) as
 *    the LAST children of `<head>` (immediately before `</head>`). These
 *    must come AFTER cppreference's own `<link rel="stylesheet" href=
 *    ".../ext.css">` so source order makes our VSCode-theme-bound rules
 *    win at equal specificity. Otherwise cppreference's stylesheet would
 *    override `body { background, color }` and the page would render
 *    with cppreference's stock light palette regardless of the active
 *    VSCode theme.
 *  - strip `<script>` tags entirely (CSP would block them anyway)
 *  - inject the attribution footer immediately before `</body>`
 *  - re-escape text and attribute content (docs/06-gotchas.md #2)
 *  - omit closing tags for void elements (docs/06-gotchas.md #4)
 *
 * Asset URL rewriting is not done per-tag — `<base href>` injection in the
 * early head block handles relative URLs naturally (docs/04-rendering.md
 * §"Asset URL rewriting", Decision A).
 */
export function rewriteHtml(
    input: string,
    ctx: RewriteContext,
    options: RewriteOptions = {}
): string {
    const stripScripts = options.stripScripts ?? true;
    const pageRelDir = getPageRelDir(ctx.template);

    const out: string[] = [];
    let skipDepth = 0;
    let injectedHeadEarly = false;
    let injectedHeadLate = false;
    let footerInjected = false;
    let breadcrumbInjected = false;
    // Depth of currently-open `<table>` elements. We only wrap top-level
    // tables (depth 1 at open) so nested tables (e.g. `t-nv-ln-table` inside
    // a `t-nv-begin`) don't get redundant scroll containers.
    let tableDepth = 0;
    // Stack of booleans tracking, for each currently-open table, whether
    // we emitted a `.cppref-table-wrap` opening div for it. We use this on
    // close to decide whether to emit the matching closing `</div>`.
    const tableWrapped: boolean[] = [];

    const parser = new Parser(
        {
            onprocessinginstruction(_name: string, data: string) {
                if (skipDepth > 0) return;
                out.push('<' + data + '>');
            },
            onopentag(name, attribs) {
                if (stripScripts && name === 'script') {
                    skipDepth++;
                    return;
                }
                if (skipDepth > 0) return;

                // Rewrite in-docset <a href> links: pre-compute the docset-relative
                // pagePath and embed it as data-cppref-nav. The client click interceptor
                // reads this attribute and sends it directly as a nav message, bypassing
                // fragile webview-URI string matching entirely.
                if (name === 'a' && attribs['href'] && pageRelDir) {
                    const navPath = resolveInDocsetHref(attribs['href'], pageRelDir);
                    if (navPath) attribs['data-cppref-nav'] = navPath;
                }

                // Wrap top-level content tables in a `.cppref-table-wrap` div so
                // overflow scrolls inside the wrap rather than pushing horizontal
                // scroll onto the whole page. Nested tables (depth > 0 at the
                // moment we see this open tag) ride on the outer wrap and don't
                // get their own.
                if (name === 'table') {
                    const wrap = tableDepth === 0 && shouldWrapTable(attribs);
                    if (wrap) out.push('<div class="cppref-table-wrap">');
                    tableWrapped.push(wrap);
                    tableDepth++;
                }

                out.push('<' + name + serializeAttrs(attribs, name, rewriterAttrFilter) + '>');

                if (name === 'head' && !injectedHeadEarly) {
                    out.push('\n');
                    out.push(buildHeadEarlyInjections(ctx.template));
                    out.push('\n');
                    injectedHeadEarly = true;
                }

                // Inject the sticky breadcrumb as the first child of <body>. The
                // attribution context's pagePath (e.g. "cpp/container/vector")
                // is already locale- and extension-stripped, perfect for
                // segment-by-segment links.
                if (name === 'body' && !breadcrumbInjected) {
                    const bc = buildBreadcrumbHtml({
                        pagePath: ctx.attribution.pagePath,
                        cppStandard: ctx.template.cppStandard
                    });
                    if (bc) {
                        out.push('\n');
                        out.push(bc);
                        out.push('\n');
                    }
                    breadcrumbInjected = true;
                }
            },
            ontext(text) {
                if (skipDepth > 0) return;
                out.push(escapeText(text));
            },
            onclosetag(name) {
                if (stripScripts && name === 'script') {
                    if (skipDepth > 0) skipDepth--;
                    return;
                }
                if (skipDepth > 0) return;

                if (VOID_TAGS.has(name)) return;

                if (name === 'head' && !injectedHeadLate) {
                    const late = buildHeadLateInjections(ctx.template);
                    if (late.length > 0) {
                        out.push('\n');
                        out.push(late);
                        out.push('\n');
                    }
                    injectedHeadLate = true;
                }

                if (name === 'body' && !footerInjected) {
                    out.push('\n');
                    out.push(buildAttributionFooter(ctx.attribution));
                    out.push('\n');
                    footerInjected = true;
                }

                out.push('</' + name + '>');

                // Close the matching `.cppref-table-wrap` if we opened one for
                // this table. Pop the stack regardless to keep depth balanced.
                if (name === 'table' && tableDepth > 0) {
                    tableDepth--;
                    const wasWrapped = tableWrapped.pop() ?? false;
                    if (wasWrapped) out.push('</div>');
                }
            },
            oncomment(_data) {
                // Drop HTML comments: a comment body containing '-->' would terminate
                // the comment early and cause the remainder to be parsed as HTML.
                return;
            }
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
    );

    parser.write(input);
    parser.end();

    return out.join('');
}
