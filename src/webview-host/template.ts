import { randomBytes } from 'node:crypto';
import {
    buildCodeThemeCssVars,
    getCodeTheme,
    getCodeThemeMenuEntries,
    type CodeTheme
} from './code-themes.js';

const BASE62 =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface TemplateContext {
    /** Webview's CSP source token (i.e. `webview.cspSource`). */
    cspSource: string;
    /** Per-render nonce. Generate via `generateNonce()`. */
    nonce: string;
    /** Webview-URI string for the docset root. Emitted as `<base href>` when set. */
    baseHref?: string;
    /** Webview-URI of the bootstrap bundle. Omitted = no external script tag. */
    bootstrapScriptUri?: string;
    /**
     * Webview-URI prefix that the click interceptor compares against to classify
     * an `<a>` as in-docset vs external. Usually identical to `baseHref`.
     */
    docsetWebviewBase: string;
    /** Resolved C++ standard for filtering (e.g. `cxx20`). Defaults to most permissive. */
    cppStandard?: string;
    /**
     * Generated standard-filter CSS body — typically `buildAllStandardFiltersCss()`.
     * When omitted, no filter style block is injected (placeholder pages don't
     * carry cppreference markers, so filtering is moot).
     */
    standardFilterCss?: string;
    /**
     * When false, omit the VSCode-theme override style block entirely so
     * cppreference renders with its stock light palette. Honors the
     * `cppDocs.theme.respectVSCodeTheme` setting — defaults to true at
     * the call site if not provided here.
     */
    respectVSCodeTheme?: boolean;
    /**
     * Initial zoom level for the panel (e.g. 1.0 = 100%, 1.5 = 150%).
     * Embedded in `window.__cppref.zoomLevel`; the client reads it on
     * page load and applies it via `document.documentElement.style.zoom`.
     * Defaults to 1.0.
     */
    zoomLevel?: number;
    /**
     * Per-render scroll instruction the webview-client honors on
     * `DOMContentLoaded`. The host emits a fresh value for every page
     * load (and placeholder render), so each navigation lands at a
     * predictable position rather than inheriting the scroll offset
     * persisted by the previous page.
     *
     * - `{ anchor: 'id' }` — scroll the element with that id into view
     *   (cross-page link with `#fragment`, hover-to-section deep link).
     * - `{}` or `undefined` — scroll to the top of the document.
     *
     * Embedded in `window.__cppref.scrollTarget`. The client treats
     * an absent value as "scroll to top" — that's the right behavior
     * for first-time renders and for cleanly recycled pages. The
     * persisted `scrollY` (from `vscode.setState`) is no longer
     * restored at page-load time: each `loadPageInWebview` represents
     * a fresh navigation, and the user requested every open to start
     * at the top (or at the linked subsection) regardless of prior
     * visits.
     */
    scrollTarget?: { anchor?: string };
    /**
     * Base16 palette used to color highlight.js-tokenized code blocks.
     * When omitted, the default (`hybrid`) palette is used — that
     * preserves the prior look. The palette is materialized into a
     * dedicated `<style id="cppref-code-theme-vars">` block so the
     * webview-client can swap palettes live by replacing the block's
     * textContent (see `setCodeTheme` message).
     */
    codeTheme?: CodeTheme;
    /**
     * Surface kind hosting this render. The webview-client uses it to
     * pick the right "move location" button: `'view'` shows a pop-out
     * button (move to editor tab); `'panel'` shows a dock-in-sidebar
     * button. Falls back to `'view'` if omitted.
     */
    surfaceKind?: 'view' | 'panel';
    /**
     * Visibility toggles for the floating in-panel controls. Each
     * defaults to `true` when omitted. Backed by user settings under
     * `cppDocs.controls.*` so the user can hide any control they don't
     * want chrome real estate spent on.
     */
    controls?: {
        showZoom?: boolean;
        showThemePicker?: boolean;
        showNavButtons?: boolean;
    };
}

export interface AttributionContext {
    /** Original cppreference path, e.g. `cpp/container/vector/push_back`. */
    pagePath: string;
    /**
     * Whether the footer is visually shown. The markup is always emitted —
     * CC BY-SA attribution is a legal obligation; only the visual block is
     * suppressed via the `cppref-attribution--hidden` class.
     */
    enabled: boolean;
}

export function generateNonce(): string {
    const bytes = randomBytes(32);
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += BASE62[bytes[i]! % 62];
    }
    return out;
}

export function buildCspContent(ctx: {
    cspSource: string;
    nonce: string;
}): string {
    return [
        `default-src 'none'`,
        `img-src ${ctx.cspSource} https: data:`,
        `font-src ${ctx.cspSource}`,
        `style-src ${ctx.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${ctx.nonce}'`
    ].join('; ');
}

export function buildThemeStyleBlock(nonce: string): string {
    // Nuclear theme override. cppreference's `ext.css` paints `body`,
    // tables, code blocks, and dozens of `.t-*` / `.mw-*` containers
    // with hard-coded light-palette backgrounds — sometimes via inline
    // `style="…"` attributes, sometimes via `bgcolor="…"` HTML
    // attributes. Anything short of a universal-selector `!important`
    // reset on `background-color` lets the light palette leak through.
    //
    // The strategy:
    //   1. Bind every element's background to `transparent !important`
    //      so the light palette CAN'T render anywhere in the descendant
    //      tree.
    //   2. Re-introduce theme-aware backgrounds on the canvas
    //      (`html`, `body`) and on selectors we WANT visually distinct
    //      (code blocks, table headers).
    //   3. Bind colors to VSCode CSS variables and apply `!important` on
    //      every selector that cppreference might paint.
    //   4. Map Pygments token classes (.k, .kt, .nf, etc.) to VSCode
    //      semantic token colors so syntax highlighting in code blocks
    //      matches the active editor theme.
    return `<style nonce="${nonce}">
:root {
  /* Panel background: slightly offset from editor so the doc pane
     reads as a distinct surface (like the chat/sidebar pane vs editor
     tabs). Uses the sidebar background token; falls back to a slight
     darkening of the editor background via a translucent overlay. */
  --cppref-bg: var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)));
  --cppref-fg: var(--vscode-editor-foreground);
  --cppref-link: var(--vscode-textLink-foreground);
  --cppref-link-active: var(--vscode-textLink-activeForeground);
  --cppref-code-bg: var(--vscode-textCodeBlock-background, var(--vscode-textBlockQuote-background, rgba(127,127,127,0.12)));
  --cppref-code-fg: var(--vscode-editor-foreground);
  /* Inline code (markdown backtick-wrapped tokens). VSCode's
     --vscode-textPreformat-foreground is the same color the markdown
     renderer uses for inline code — typically a warm yellow in dark
     themes (e.g. #ce9178 on Dark+, #bf8b30 on Light+). Falls back to
     the editor's keyword color, then to a literal warm yellow so the
     signal lands in every theme. */
  --cppref-inline-code-fg: var(--vscode-textPreformat-foreground, var(--vscode-symbolIcon-keywordForeground, #d7ba7d));
  --cppref-inline-code-bg: var(--vscode-textPreformat-background, var(--cppref-code-bg));
  --cppref-border: var(--vscode-panel-border, var(--vscode-editorWidget-border, rgba(127,127,127,0.4)));
  --cppref-muted: var(--vscode-descriptionForeground);
  --cppref-table-header-bg: var(--vscode-editorWidget-background, var(--vscode-textBlockQuote-background, rgba(127,127,127,0.18)));
  --cppref-table-zebra-bg: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08));
  /* Single source of truth for the corner radius of every page-level
     box outline (tables, code blocks, example blocks). Inline chips
     (.t-c, backticked code) use their own smaller radius — they're
     glyph-scale rather than container-scale. */
  --cppref-radius: 6px;
  /* Inner padding for every bordered/filled inline chip (.t-c, inline
     code, breadcrumb pill, picker select). Sized to keep glyph
     ascenders/descenders clear of the chip border at every supported
     editor font, so text never reads as kissing the outline. Block-
     level bordered containers (tables, pre, example blocks) have their
     own padding well above this floor. */
  --cppref-chip-pad-y: 3px;
  --cppref-chip-pad-x: 7px;
  /* Warm accent reserved for outlines that frame text/code snippets
     (code blocks, example output) — i.e. content callouts that aren't
     tables. Tables use the neutral --cppref-border; code blocks use
     this warmer tone so the two outline categories read as distinct
     at a glance without shouting. Tuned to be quiet on both dark and
     light themes; light theme gets a slightly darker hue + more alpha
     to maintain visibility against a bright page background. */
  --cppref-accent-warm: rgba(95, 84, 73, 0.55);
  /* Operators and punctuation always track the editor foreground. */
  --cppref-syn-operator: var(--vscode-editor-foreground);
  --cppref-syn-punct: var(--vscode-editor-foreground);
}
/* Syntax token colors — concrete values matching the VS Code Dark+ / Light+
   token palette. Using body class selectors (injected by VSCode itself) is
   the only reliable way to pick dark vs light colors inside a webview:
   the symbolIcon CSS variables are sidebar icon colors, not editor token
   colors, and mapping through them was the source of incorrect coloring
   (comments and preprocessor both resolved to symbolIcon-colorForeground,
   giving them the same value regardless of theme). */
body.vscode-dark,
body.vscode-high-contrast {
  --cppref-syn-keyword:  #569cd6;
  --cppref-syn-type:     #4ec9b0;
  --cppref-syn-builtin:  #4ec9b0;
  --cppref-syn-function: #dcdcaa;
  --cppref-syn-string:   #ce9178;
  --cppref-syn-number:   #b5cea8;
  --cppref-syn-comment:  #6a9955;
  --cppref-syn-preproc:  #c586c0;
  --cppref-syn-namespace:#4ec9b0;
  --cppref-syn-variable: #9cdcfe;
}
body.vscode-light,
body.vscode-high-contrast-light {
  --cppref-syn-keyword:  #0000ff;
  --cppref-syn-type:     #267f99;
  --cppref-syn-builtin:  #267f99;
  --cppref-syn-function: #795e26;
  --cppref-syn-string:   #a31515;
  --cppref-syn-number:   #098658;
  --cppref-syn-comment:  #008000;
  --cppref-syn-preproc:  #af00db;
  --cppref-syn-namespace:#267f99;
  --cppref-syn-variable: #001080;
  /* Light theme: warm accent reads with more saturation against a
     bright background, so push the hue darker and lift the alpha. */
  --cppref-accent-warm: rgba(146, 91, 32, 0.65);
}
html, body {
  background-color: var(--cppref-bg) !important;
  background-image: none !important;
  color: var(--cppref-fg) !important;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-editor-font-size, var(--vscode-font-size));
  line-height: 1.55;
  /* cppreference's ext.css ships a body min-width of 780px, which
     prevents the page from reflowing when the panel is dragged narrower
     than that — content just clips/scrolls instead. Reset to 0 so the
     fluid body rule below is the only thing controlling width. */
  min-width: 0 !important;
}
/* Same family of fixed widths in ext.css / site_modules.css that block
   reflow at narrow panel sizes:
     - body                          min-width: 780px (handled above)
     - div#cpp-head-first/second     width: 780px
     - div#content                   width: 780px -- main page wrapper,
                                                     id-specificity beats
                                                     anything we set on body
     - div#footer                    width: 780px
     - div#bodyContent               inherits #content's width
     - .t-example-live-link          width: 55em
   The id selectors are prefixed with the body type selector so our
   specificity reaches (1,0,1) and beats cppreference's bare #content
   rule. The !important on top is defense-in-depth: cppreference's stock
   CSS uses it liberally on its own width rules and we want ours to win
   unambiguously regardless of cascade order. Without this rule the
   entire page wrapper is pinned to 780px while the viewport may be
   much narrower (sidebar mode is typically ~250-350px), producing the
   "page is half cut-off horizontally" symptom. */
body #cpp-content-base,
body #content,
body #cpp-head-first,
body #cpp-head-second,
body #footer,
body #bodyContent,
body #mw-content-text {
  width: auto !important;
  max-width: 100% !important;
  margin: 0 auto !important;
  box-sizing: border-box;
}
body .t-example-live-link {
  display: none !important;
}
body footer:not(.cppref-attribution) {
  width: auto !important;
  max-width: 100%;
}
/* Fluid container: never exceeds a comfortable reading width on wide
   panels, never overflows a narrow panel. min(64rem, 100%) lets the
   body shrink to the viewport at sidebar widths (no floor -- the old
   clamp() had a 28rem floor that forced horizontal overflow whenever
   the panel was dragged narrower than 448px). margin: 0 auto centers
   the body inside whatever extra horizontal space the panel offers,
   so on a wide editor-column panel the content reads as a centered
   column rather than a left-pinned slab. Padding scales with viewport
   via clamp() so narrow panels stay legible without crowding.
   overflow-wrap: anywhere lets long single tokens (template parameters,
   fully-qualified identifiers) break mid-word when no whitespace is
   available -- block code is exempt via white-space: pre on pre, and
   the .cppref-table-wrap / overflow-x: auto pair handles wide tables. */
body {
  margin: 0 auto;
  padding: clamp(0.75rem, 2vw, 1.75rem) clamp(0.85rem, 3vw, 2rem) 3rem;
  max-width: min(64rem, 100%);
  box-sizing: border-box;
  overflow-wrap: anywhere;
}
/* Themed scrollbars — match the rest of VSCode rather than the OS default
   white-on-white. Rendered for any element that scrolls (body, table-wrap,
   pre, etc.). */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(127,127,127,0.3));
  border-radius: 5px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(127,127,127,0.5));
}
::-webkit-scrollbar-thumb:active {
  background: var(--vscode-scrollbarSlider-activeBackground, rgba(127,127,127,0.7));
}
::-webkit-scrollbar-corner { background: transparent; }
/* Wrap that contains a wide cppreference table so its overflow scrolls
   the table — not the whole page. The rewriter wraps every top-level
   body table in this div. The wrap is the scroll container; the table
   inside keeps its natural width. */
.cppref-table-wrap {
  /* Shrink to the inner table's natural width (clamped to 100% of the
     parent column) so the rounded outer frame hugs the content. With a
     fixed-width wrap we used to draw a long rectangle around narrow
     tables (single-row "See also" callouts, etc.), and the gap between
     the table's right edge and the wrap's right border read as a
     phantom empty cell. fit-content removes that gap entirely; for
     tables wider than the column, max-width:100% engages overflow-x. */
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow-x: auto;
  margin: 0.6em 0;
  /* The wrap owns the outer frame for every top-level table, which
     lets us round the corners without depending on border-collapse:
     separate on the table itself (most cppreference tables use
     collapse and clipping the table directly would slice the border
     at the corners). */
  border: 1px solid var(--cppref-border);
  border-radius: var(--cppref-radius);
}
/* Syntax synopses (.t-sdsc-begin) and parameter lists (.t-par-begin)
   use <table> as a layout primitive with intentional structural empty
   cells and stock cppreference row separators (.t-sdsc-sep with a 1px
   silver top border) drawing the visible grid lines between rows. The
   wrap's rounded outline competes with that internal separator system
   and reads as a redundant box around what is really a list of code
   shapes. Hide the wrap chrome for these table classes; the inner
   separators carry the structure on their own. */
.cppref-table-wrap:has(> table.t-sdsc-begin),
.cppref-table-wrap:has(> table.t-par-begin) {
  border: none;
  border-radius: 0;
  /* Let these tables stretch to their natural max — there is no outer
     frame here, so shrinking the wrap to fit only creates a narrow
     island inside a wide column. */
  width: 100%;
}
/* Wrapped tables defer their outer frame to .cppref-table-wrap; without
   this override the table's own border would draw a square inside the
   rounded wrap and produce a visible double-outline at the corners. */
.cppref-table-wrap > table {
  border: none !important;
  margin: 0 !important;
}
/* Force every cppreference table to never push past its container; the
   wrap above provides horizontal scroll when the natural width exceeds
   the viewport. Without this, wide template declarations or member
   tables cause the whole body to scroll horizontally. */
body table { max-width: 100%; }
/* Long inline tokens (template parameters with long namespace prefixes,
   typedef'd alias names, etc.) in declaration tables get a chance to
   break — without this, even with the table-wrap, declarations push
   their cells to widths that force the scroll container. */
body .t-dcl-begin code,
body .t-dcl-begin .t-c,
body .t-dsc-begin .t-dsc code {
  white-space: normal;
  word-break: break-word;
}
/* Images and SVGs cap at the container width and keep their aspect
   ratio. cppreference embeds explanatory diagrams without responsive
   constraints; without this rule a wide diagram pushes horizontal
   scroll the same way a wide table would. */
body img,
body svg {
  max-width: 100%;
  height: auto;
}
/* Pre/code-blocks: hard cap at container width so even with no table
   above them, a long line scrolls within the block instead of the
   page. The overflow-x:auto declaration on .mw-highlight and pre
   below provides the actual scroll; this rule just stops them from
   claiming a wider width than their parent. */
body pre,
body .mw-highlight,
body .mw-geshi,
body .source-cpp,
body .source-text,
body .t-example,
body .t-example-live {
  max-width: 100% !important;
  width: auto !important;
}
/* Universal background reset — every descendant of body is forced to
   transparent so cppreference's class-based and inline-style
   backgrounds can't render. The :not(...) chain re-permits backgrounds
   on the surfaces where we want a visually distinct fill (code,
   tables, dropdowns, our own attribution footer). */
body *:not(code):not(pre):not(kbd):not(samp):not(th):not(.t-c):not(.t-cc):not(.mw-code):not(.mw-highlight):not(.source-cpp):not(.source-c):not(.cppref-attribution):not(.cppref-attribution *):not(.t-navbar-menu):not(.t-navbar-menu *) {
  background-color: transparent !important;
  background-image: none !important;
}
/* cppreference hover-dropdown nav menus — give them a solid themed
   background so they're visible against the page canvas. Without
   this, the nuclear transparent rule above makes them invisible.
   cppreference's site_modules.css paints '.t-navbar-menu > div' (the
   inner container) with a hard-coded light-palette fill, so we must
   re-tone both the outer wrapper and the inner div to keep the menu
   from reading as a bright box on dark themes. The visible outline,
   however, lives on the outer wrapper only — the inner div used to
   carry a redundant border that drew a second square outline 1px
   inside the rounded one, producing the "messy nested outline" look. */
body .t-navbar-menu {
  background-color: var(--cppref-bg) !important;
  border: 1px solid var(--cppref-border) !important;
  border-radius: var(--cppref-radius);
  overflow: hidden;
}
body .t-navbar-menu > div {
  background-color: var(--cppref-bg) !important;
  border: none !important;
}
/* Menu section headers (.t-nv-h1, .t-nv-h2) and their cells — force
   theme foreground so they're legible on dark backgrounds. */
body .t-navbar-menu .t-nv-h1 td,
body .t-navbar-menu .t-nv-h2 td {
  color: var(--cppref-fg) !important;
  background-color: var(--cppref-table-header-bg) !important;
}
/* Menu links — override any inherited silver/gray from site_modules.css. */
body .t-navbar-menu a,
body .t-navbar-menu .t-nv td a {
  color: var(--cppref-link) !important;
}
body .t-navbar-menu a:hover,
body .t-navbar-menu a:focus {
  color: var(--cppref-link-active) !important;
}
body, body * {
  border-color: var(--cppref-border);
}
body, body p, body div, body section, body article, body main, body header,
body footer, body aside, body span, body li, body ul, body ol,
body dt, body dd, body dl, body h1, body h2, body h3, body h4, body h5,
body h6, body blockquote, body figure, body figcaption,
body table, body tbody, body thead, body tfoot, body tr, body td {
  color: var(--cppref-fg) !important;
}
body a, html body a {
  color: var(--cppref-link) !important;
  background-color: transparent !important;
}
body a:hover, body a:focus, html body a:hover, html body a:focus {
  color: var(--cppref-link-active) !important;
}

/* Tabular link cells -- cppreference's .t-dsc-member-div (description
   tables) and .t-nv-ln-table (navigation tables) wrap the symbol
   name in [a][span class=t-lines]...[/span][/a]. The inner spans
   carry their own color rules from cppreference's stock CSS, which
   override the body-a color via specificity and leave the link text
   rendering as plain code-yellow with no link affordance. Force the
   anchor to win and explicitly make every inner element inherit, so
   the user can see at a glance which cells are clickable.

   The hover state adds an underline so the click affordance is
   unambiguous regardless of color contrast in the active theme. */
body .t-dsc-member-div a,
body .t-nv-ln-table a,
body .t-dsc td:first-child a,
body td .t-lines a,
body a > .t-lines,
body a > .t-lines * {
  color: var(--cppref-link) !important;
}
body .t-dsc-member-div a *,
body .t-nv-ln-table a *,
body .t-dsc td:first-child a *,
body td .t-lines a * {
  color: inherit !important;
}
body .t-dsc-member-div a:hover,
body .t-nv-ln-table a:hover,
body .t-dsc td:first-child a:hover,
body td .t-lines a:hover,
body .t-dsc-member-div a:focus,
body .t-nv-ln-table a:focus,
body .t-dsc td:first-child a:focus,
body td .t-lines a:focus {
  color: var(--cppref-link-active) !important;
  text-decoration: underline !important;
}
body .t-dsc-member-div a:hover *,
body .t-nv-ln-table a:hover *,
body .t-dsc td:first-child a:hover *,
body td .t-lines a:hover *,
body .t-dsc-member-div a:focus *,
body .t-nv-ln-table a:focus *,
body .t-dsc td:first-child a:focus *,
body td .t-lines a:focus * {
  color: inherit !important;
}
/* ======================================================================
   TABLE SYSTEM — polished editorial grid.

   cppreference's mediawiki source emits a handful of recurring table
   shapes whose stock CSS in site_modules.css has surprisingly strong
   opinions about padding / widths / wrapping. The two most disruptive
   rules we have to neutralize:

     .t-dsc > td:first-child  { width:0%; padding:0.2em 0 0.25em 0.75em;
                                white-space:nowrap }
     .t-dcl > td:first-child  { padding:0.3em 2em 0.2em 1em;
                                font-size:1.0em }

   The width:0% collapses the cell to its content intrinsic width, and
   padding-right:0 puts that intrinsic edge flush against the cell
   right border — the visual symptom is text touching the border on
   the right. The inline .t-c code wrapper inside makes it worse
   because it adds its OWN border, so the user sees what looks like
   two stacked outlines kissing.

   Our overrides win in two ways:
     1. Selectors here mirror the cppreference shapes (.t-dsc td,
        .t-dcl td, .t-nv td, etc.) so they tie on specificity, and
        source-order picks ours.
     2. !important on the padding / width / white-space lines
        guarantees the rule lands even if cppreference stock CSS
        gets reordered upstream.

   Visual goals (editorial / technical-reference aesthetic):
     - Quiet inner cell borders that recede so content reads first
     - Strong outer table frame so each table reads as a unit
     - Generous horizontal padding so nothing breathes against the
       grid lines
     - Header rows with a subtle tint + tracking for visual hierarchy
       without shouting
     - Very subtle row hover for "yes this cell is interactive when
       it has a link inside" hint
     - Inline code wrappers (.t-c, .t-cc) shed their busy borders and
       carry only background + text color — the table cell IS the
       containment, the inline code shouldnt double up
   ====================================================================== */

/* The outer frame: a single visible border around the whole table,
   slightly stronger than the inner cell borders so the table reads
   as a unit. For top-level tables the rounded outer frame is drawn
   by .cppref-table-wrap (which overrides this border to none on its
   child); this rule still applies to any nested tables that aren't
   wrapped, where a square outline is fine because nested tables
   shouldn't read as their own contained unit. */
body table {
  border-collapse: collapse;
  border: 1px solid var(--cppref-border) !important;
  margin: 1em 0;
  background-color: transparent !important;
}

/* Vertical alignment: top-align everything so multi-line cells line
   up at their first baseline. Applies universally; safe across all
   table shapes. */
body th, body td {
  vertical-align: top;
}

/* Per-cell borders ONLY on the truly tabular shapes — description
   grids (.t-dsc-begin), navigation lists (.t-nv-begin), and any
   <table> not carrying a special t-* class. cppreference also uses
   <table> as a layout primitive for syntax synopses (.t-sdsc-begin)
   and parameter lists (.t-par-begin), where per-cell borders would
   draw boxes around structural empty cells and make the layout look
   like a broken data grid. Those shapes get only the outer table
   border (rule above), not the per-cell grid. */
body .t-dsc-begin th, body .t-dsc-begin td,
body .t-nv-begin th, body .t-nv-begin td,
body .dsctable th, body .dsctable td,
body .wikitable th, body .wikitable td {
  border: 1px solid var(--cppref-border) !important;
}

/* Drop the outer frame on pure layout tables — syntax synopses and
   parameter lists use <table> as a layout primitive with intentional
   structural empty cells, so a visible border reads as a broken grid. */
body table.t-sdsc-begin,
body table.t-par-begin {
  border: none !important;
}

/* Declaration tables (.t-dcl-begin) get a subtle outer frame so the
   numbered constructor/overload block reads as a contained unit, matching
   the note boxes that appear later on the same page.
   - display:table overrides cppreference's display:block, which lets the
     anonymous internal table shrink to content width and leaves the cells
     narrower than the container — with display:table + width:100% the
     cells always fill the full box.
   - border-collapse:separate + border-spacing:0 allows border-radius on
     the table element and lets cell borders extend to the content edges. */
body table.t-dcl-begin {
  display: table !important;
  width: 100% !important;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  border-radius: var(--cppref-radius) !important;
  overflow: hidden;
}
.cppref-table-wrap:has(> table.t-dcl-begin) {
  border-radius: var(--cppref-radius);
  /* Declaration tables are meant to read as full-width framed sections
     (the inner table is forced to width:100%); without an explicit
     override the fit-content wrap would shrink to the table's intrinsic
     max-content and undo that intent. */
  width: 100%;
}

/* Inner row separators: cppreference draws these as border-top:#cccccc on
   .t-dcl and .t-dcl-sep cells. Retheme to --cppref-border so they match
   the outer frame, and strip side borders to keep only horizontal lines.
   With display:table + width:100% + border-spacing:0, the three cells in
   each row are flush and together span the full table width, so the
   combined border-top reads as one unbroken edge-to-edge line. */
body .t-dcl-begin .t-dcl > td,
body .t-dcl-begin .t-dcl-sep > td,
body .t-dcl-begin .t-dcl-h > td {
  border-top: 1px solid var(--cppref-border) !important;
  border-right: none !important;
  border-bottom: none !important;
  border-left: none !important;
}

/* Separator rows hold empty cells whose sole job is the border-top line.
   cppreference's own CSS sets padding:0 on .t-dcl-sep for exactly this
   reason; our generic body td rule overrides that and inflates the row
   into a visible empty section at the table bottom. */
body .t-dcl-begin .t-dcl-sep > td {
  padding: 0 !important;
}

/* cppreference appends a trailing empty .t-dcl-sep row to every declaration
   table — on their site it acts as the table's bottom edge (their tables
   have no outer border). Our outer frame + border-radius already provide
   that edge, so the trailing sep is a redundant inner divider above the
   rounded bottom. :last-child keeps the few in-table seps that act as
   meaningful section dividers (cpp/types/size_t, cpp/atomic/atomic). */
body .t-dcl-begin tr.t-dcl-sep:last-child {
  display: none !important;
}

/* The outer table frame is the top boundary for the first row —
   suppress the inner top border there to avoid a doubled line. */
body .t-dcl-begin tbody tr:first-child > td {
  border-top: none !important;
}

/* ======================================================================
   Revision markers (.t-rev-begin, .t-rev, .t-mark-rev, .t-rev-inl).

   Cppreference encodes "this paragraph applies only to a specific C++
   standard" two ways. (1) Block form: a 2-column table.t-rev-begin
   where each tr.t-rev has two td's. First holds the prose; second
   holds a span.t-mark-rev like "(since C++20)". Stock cppreference
   CSS gives the first td a 3-sided silver border (right:none) and
   the second the mirrored 3-sided border (left:none) so collapsed
   together they look like one box. (2) Inline form: span.t-rev-inl
   wraps inline prose plus a trailing span.t-mark-rev inside the
   running text.

   Symptoms before this rule:
     - body table border-collapse:collapse kills border-radius on
       .t-rev-begin, leaving square corners that clash with the
       rounded outlines applied to every other bordered container.
     - The split-border trick reads as two separate boxes inside our
       theme because generic body-td padding inflates the visible
       gap between the prose cell and the chip cell.
     - The chip itself gets stripped of its background by the
       universal transparent reset, so "(since C++20)" reads as an
       empty hollow outline — the white-border artifact.
     - .t-rev-inl had no border treatment of its own and inherited
       cppreference's silver 1px border with square corners.

   Fix mirrors the .t-dcl-begin handling above: switch to
   border-collapse:separate + 0 spacing so border-radius can clip
   cleanly; strip the cppreference split-border on every cell and
   replace with a single outer frame; pin the chip cell to shrink-
   to-fit right; restore the chip background as a filled badge;
   round .t-rev-inl with matching radius and padding.
   ====================================================================== */
body table.t-rev-begin {
  display: table !important;
  width: 100% !important;
  border-collapse: separate !important;
  border-spacing: 0 !important;
  border-radius: var(--cppref-radius) !important;
  overflow: hidden;
  margin: 0.85em 0;
}
.cppref-table-wrap:has(> table.t-rev-begin) {
  border-radius: var(--cppref-radius);
  /* Revision callouts (.t-rev-begin) frame conditional version-gated
     content and should read as full-width sections like declarations
     do, so override the wrap's default fit-content sizing. */
  width: 100%;
}
/* All revision-block cells drop the cppreference split-border pattern.
   The outer table border + the per-row top-border below provide all
   the rules we need; anything else would double up. */
body table.t-rev-begin > tbody > tr > td {
  border: none !important;
  padding: 0.6rem !important;
  vertical-align: middle;
}
/* Row separators between adjacent revision entries in the same table.
   The first row's top edge is the outer frame, so only later rows
   draw a top border. */
body table.t-rev-begin > tbody > tr + tr > td {
  border-top: 1px solid var(--cppref-border) !important;
}
/* First cell: takes all the remaining horizontal space. */
body table.t-rev-begin > tbody > tr > td:first-child {
  width: 100%;
}
/* Chip cell: shrink to the chip's intrinsic width, hug the right edge,
   and use a slightly tighter left/right padding so the chip floats
   visually near the corner without crowding it. */
body table.t-rev-begin > tbody > tr > td:nth-child(2) {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  padding-left: 0.5rem !important;
}
/* The chip itself — restore the badge fill the universal transparent
   reset stripped, and round it to match the system radius scale at a
   smaller end of the curve so it stays visually subordinate to the
   block it labels. */
body span.t-mark-rev,
body span.t-mark {
  display: inline-block;
  font-size: 0.78em;
  padding: 2px 7px;
  border: 1px solid var(--cppref-border) !important;
  border-radius: 4px;
  background-color: var(--cppref-table-header-bg) !important;
  color: var(--cppref-muted) !important;
  white-space: nowrap;
  vertical-align: middle;
  letter-spacing: 0.01em;
}
/* Inline-flow revision wrappers. Cppreference ships these with a 1px
   silver border around a sentence fragment; without our intervention
   they render as a square-cornered chip sitting in the middle of
   running prose. Match the rounded-outline system, tighten the
   padding for inline rhythm. */
body span.t-rev-inl {
  display: inline;
  border: 1px solid var(--cppref-border) !important;
  border-radius: 4px;
  padding: 1px 6px;
  background-color: var(--cppref-table-zebra-bg) !important;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
body span.t-rev-inl.t-rev-inl-noborder {
  border: none !important;
  background-color: transparent !important;
  padding: 0;
}
/* When a .t-mark-rev chip sits inside an inline .t-rev-inl, it would
   double-outline (the wrapper has its own border now). Strip the chip
   chrome in that nested context — the surrounding wrapper carries the
   "this is a revision" signal. */
body span.t-rev-inl span.t-mark-rev {
  border: none !important;
  background-color: transparent !important;
  padding: 0 0 0 0.25em;
  color: var(--cppref-muted) !important;
}

/* Headers: same background tint we already had + tracking + slightly
   heavier weight for hierarchy. Apply to both <th> and the implicit
   header rows cppreference uses (.t-dsc-hitem, .t-dcl-rev-hitem). */
body th,
body tr.t-dsc-hitem > td,
body tr.t-dcl-rev-hitem > td {
  background-color: var(--cppref-table-header-bg) !important;
  color: var(--cppref-fg) !important;
  font-weight: 600;
  letter-spacing: 0.01em;
}

/* The padding fix, scoped narrowly.

   Earlier iteration applied 0.65rem 1rem to every table cell. That
   broke three cppreference table shapes that depend on careful
   per-column padding:
     .t-par   — parameter table with nowrap first col + width-100%
                third col; uniform padding squeezed the first col to
                a single character per line
     .t-sdsc  — syntax synopsis with intentional empty layout cells
                (.t-sdsc-nopad) that should stay zero-padded
     .t-dcl-h / .t-dcl-sep / .t-dcl-rev-aux — declaration table
                header / separator / auxiliary rows that need to
                stay tight (cppreference uses padding:0 on .t-dcl-sep
                to draw thin divider lines)

   The original bug we needed to fix was specifically
   .t-dsc > td:first-child having padding-right:0 + width:0%, so the
   fix targets only that shape (plus general body th/td as a default
   for any future tables we add or that cppreference uses without a
   t-* class). */

/* Generic default for plain <th>/<td> — applies when no t-* class
   wins specificity. */
body th, body td {
  padding: 0.55rem 0.85rem;
}

/* Description-table cells: the shape we actually had to fix.
   Uniform 0.65rem 1rem, no special-case for first-child padding
   beyond the right-side bump below. */
body .t-dsc > td,
body .t-dsc-hitem > td,
body .t-dsc-header > td {
  padding: 0.65rem 1rem !important;
}

/* Description first-col: fix the cppreference padding-right:0 +
   width:0% + white-space:nowrap collapse. This is the root bug
   that caused text to touch the cell's right border. We keep the
   targeted fix narrow — only .t-dsc benefits, the other shapes
   (which use their first-col nowrap intentionally) stay untouched. */
body .t-dsc > td:first-child {
  width: auto !important;
  white-space: normal !important;
  font-weight: 500;
  padding: 0.65rem 1.5rem 0.65rem 1rem !important;
}
/* The global \`body td code/.t-c/.t-cc { overflow-wrap: anywhere }\` rule
   lets the browser split identifiers at any character when a column is
   squeezed narrow — causing short names like \`type\` to wrap as \`typ\`/\`e\`.
   The name column only contains short identifiers, so mid-word breaking
   is never useful here. Mirror the same fix already applied to .wikitable
   and .dsctable. */
body .t-dsc > td:first-child code,
body .t-dsc > td:first-child .t-c,
body .t-dsc > td:first-child .t-cc {
  overflow-wrap: normal;
  word-break: normal;
}

/* .dsctable — the four-column "Statement | Pre/Post | Semantics |
   Complexity" tables used by named-requirements pages
   (AllocatorAwareContainer, Container, etc.). cppreference stock
   CSS sets width:0% + white-space:nowrap + tiny padding on every
   cell, which interacts disastrously with our body-level
   overflow-wrap:anywhere:

     - width:0% lets the description column (which has the most
       content) hog the available width
     - the other columns get squeezed to their minimum
     - overflow-wrap:anywhere lets the browser break those squeezed
       single-word labels ("Precondition") at every character

   We unstick width/wrap, restore generous padding, and reset
   overflow-wrap to normal on cell text. Code blocks inside cells
   keep their own break-word behavior via the existing
   .t-dsc-begin .t-dsc code rule + an explicit allow below. */
body .dsctable > tbody > tr > td,
body .dsctable > tbody > tr > th {
  width: auto !important;
  white-space: normal !important;
  overflow-wrap: normal !important;
  word-break: normal !important;
  padding: 0.65rem 1rem !important;
}

/* .wikitable — MediaWiki's general-purpose data table. cppreference
   emits style="width: 0" on the first-column <th> of feature-test
   macro tables to tell the browser to minimize that column's width.
   The general 'body td code { overflow-wrap: anywhere }' rule below
   compounds this: 'overflow-wrap: anywhere' reduces code elements'
   min-content-width to ~0 (the spec says soft wrap opportunities from
   anywhere-breaking are considered in min-content intrinsic size), so
   the auto-layout algorithm shrinks the macro-name column to a few
   characters and the names wrap at every character.

   Fix: override width and white-space on all wikitable cells, and
   restore normal overflow-wrap on their code content. cppreference
   inserts intentional 'display:inline-block' zero-width <span>s inside
   long macro names as soft break points; those are still honored with
   overflow-wrap: normal because inline-block element boundaries are
   always soft wrap opportunities regardless of overflow-wrap. */
body .wikitable th,
body .wikitable td {
  width: auto !important;
  white-space: normal !important;
}
body .wikitable td code, body .wikitable td .t-c, body .wikitable td .t-cc,
body .wikitable th code, body .wikitable th .t-c, body .wikitable th .t-cc {
  overflow-wrap: normal;
  word-break: normal;
}

/* Cell-level overflow-wrap reset for ALL table shapes so prose text
   never wraps mid-word in a squeezed column. The body-level
   overflow-wrap:anywhere is meant for long template identifiers in
   prose, NOT for table cells where columns can shrink unpredictably
   under content-driven sizing. Code blocks inside cells re-enable
   anywhere-breaking below so long template-instantiated identifiers
   can still wrap to fit. */
body td, body th {
  overflow-wrap: normal;
  word-break: normal;
}
body td code, body td .t-c, body td .t-cc,
body th code, body th .t-c, body th .t-cc {
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Zebra rows. The cppreference rule is nth-child(even); we keep the
   same selectors but lighten the tint by half so its a hint rather
   than an alternating bar. Combined with the always-present cell
   borders, even very faint zebra is enough to track rows. */
body tr.t-dsc-hitem, body tr.t-dcl-rev-hitem,
body .t-dcl-begin tr:nth-child(even),
body .t-dsc-begin tr:nth-child(even) {
  background-color: var(--cppref-table-zebra-bg) !important;
}

/* Hover state: a hair of theme-aware highlight on data rows so the
   user gets feedback when scanning a table with link cells. Skip
   header rows so they don't read as clickable. */
body .t-dsc-begin tr:not(.t-dsc-hitem):not(.t-nv-h1):not(.t-nv-h2):hover,
body .t-dcl-begin tr:not(.t-dcl-rev-hitem):not(.t-dcl-h):hover {
  background-color: var(--cppref-table-zebra-bg) !important;
  /* Subtle tint shift on hover via a slight box-shadow inset.
     Keeps the row visually distinct without changing geometry. */
  box-shadow: inset 0 0 0 9999px rgba(127, 127, 127, 0.04);
}
body code, body pre, body kbd, body samp,
body .t-c, body .t-cc, body .mw-code, body .mw-highlight,
body .source-cpp, body .source-c {
  font-family: var(--vscode-editor-font-family) !important;
  background-color: var(--cppref-code-bg) !important;
  color: var(--cppref-code-fg) !important;
}

/* Inline-code wrapper polish. cppreference stock CSS gives .t-c a
   silver 1px border + 3px radius + 2px padding to read as a chip.
   Without overrides that border stacks against our cell border and
   reads as a cluttered double-outline. We keep the chip feel (dark
   background, warm text, tight padding) but make the border the
   same color as the surrounding theme so it visually merges with
   the cell rather than competing. */
body .t-c,
body .t-cc,
body .t-spar {
  border-color: var(--cppref-border) !important;
  border-radius: 3px;
  padding: var(--cppref-chip-pad-y) var(--cppref-chip-pad-x);
}

/* Pseudo-code listings. cppreference encodes multi-line pseudo-code
   (exposition-only function bodies, "the effect is equivalent to"
   blocks, noexcept-spec expansions, etc.) by alternating segments
   inside a single <p>:

       <p>
         <span class="t-c">
           <span class="mw-geshi cpp source-cpp">…token spans…</span><br>
           <span class="mw-geshi cpp source-cpp">…more tokens…</span><br>
           <code>    </code><code><i>apply-impl</i></code>
           <span class="mw-geshi cpp source-cpp">…tokens…</span>
           …
         </span>
       </p>

   Each .t-c, every leading <code> indent, and every italic
   placeholder gets the chip treatment by default — producing a row
   of disconnected boxes inside what is conceptually ONE code
   listing. Strip the chip styling from these wrappers so the
   listing reads as a single fluid block of monospace with the
   inner GeSHi token coloring intact. */

/* .t-c that directly contains a .mw-geshi block: the inner block
   already carries the code-tokenized look; the outer .t-c chip is
   redundant and creates the fragmented appearance. Browser support
   for :has is universal in the Electron Chromium VSCode ships with. */
body .t-c:has(.mw-geshi),
body .t-c:has(.source-cpp),
body .t-c:has(.source-c) {
  background-color: transparent !important;
  border: none !important;
  padding: 0 !important;
  display: inline;
}

/* Exposition-only italic identifiers: <code><i>apply-impl</i></code>
   or <tt><i>INVOKE</i></tt>. cppreference uses this pattern for
   parameter names / pseudo-function names that don't have real
   docs. Rendered as chips they read as nested boxes inside the
   listing; we strip the chip but keep the italic + monospace
   styling so the placeholder identity stays clear. We color these
   with the variable / parameter accent so they're visually distinct
   from real tokens. */
body code:has(> i),
body tt:has(> i),
body p > code:has(> i),
body p > tt:has(> i) {
  background-color: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  font-style: italic;
  color: var(--cppref-syn-variable) !important;
}
body code > i,
body tt > i {
  font-style: italic;
  color: inherit !important;
}

/* The indent-only <code>    </code> wrappers cppreference uses to
   space pseudo-code listings: render as transparent monospace so
   the indent stays but the chip backing doesn't show as a stray
   box of whitespace. The :empty check + the whitespace-only text
   check via the empty-state pseudo would be ideal but no CSS
   selector captures "contains only whitespace"; instead we
   target any <code> whose only content is whitespace via the
   ":not(:has(*))" structural check + width clue. The safer fallback
   is to strip the chip from all <code> elements that appear as
   direct children of a <p> AND that sit adjacent to a .t-c, but
   that's too narrow. Instead: when a <p> contains a .mw-geshi
   block anywhere inside, treat every <code> child as a transparent
   inline wrapper. Real prose-level inline code (a <code> in a
   paragraph of text) still gets the inline-code chip because such
   paragraphs never contain .mw-geshi children. */
body p:has(.mw-geshi) > code {
  background-color: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
}
/* Inline code (the inline code/tt elements) — distinct from block
   code. The warm yellow signals 'this is a token' the same way the
   markdown renderer's inline backticks do, separating tokens from
   prose. Block code (inside pre or syntax-highlight wrappers) keeps
   the editor foreground so multi-line snippets read uniformly. */
body :not(pre) > code, body :not(pre) > kbd, body :not(pre) > samp,
body :not(pre) > tt,
body :not(.mw-highlight) > .t-cc,
body :not(.mw-highlight) > .t-spar {
  color: var(--cppref-inline-code-fg) !important;
  background-color: var(--cppref-inline-code-bg) !important;
  padding: var(--cppref-chip-pad-y) var(--cppref-chip-pad-x);
  border-radius: 4px;
  font-size: 0.92em;
}
body pre, body .t-example-live, body .mw-highlight {
  padding: 0.85rem;
  overflow-x: auto;
  border: 1px solid var(--cppref-accent-warm) !important;
  border-radius: var(--cppref-radius);
  margin: 0.85em 0;
  /* No inset box-shadow: the 1px shadow we used to layer here read
     as a faint second outline 1px inside the border on every code
     and Output block (visible in dark themes against the code-bg
     fill). The border alone provides enough containment. */
  box-shadow: none !important;
}
/* For plain-text Output blocks (where syntax.ts does NOT rewrite
   the wrapper because the block is not C/C++), cppreference's
   site_modules.css puts a border on BOTH the outer div.mw-geshi
   and the inner pre. The outer wrapper is the one that reads as
   chrome (rounded, padded, themed via the body-* border-color
   rule); the inner pre's border sits flush against the text and
   shows up as a tight second outline. Keep the outer one, strip
   the inner pre's styling when it lives inside an .mw-geshi.
   For C/C++ code blocks this branch never matches — syntax.ts
   replaces the whole .mw-geshi wrapper with pre.cppref-hljs-pre. */
body div.mw-geshi pre {
  border: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  background-color: transparent !important;
  box-shadow: none !important;
}
body hr { border: none !important; border-top: 1px solid var(--cppref-border) !important; }
/* -----------------------------------------------------------------------
   Syntax highlighting for cppreference code blocks.

   cppreference's offline HTML wraps code in a span with classes
   "mw-geshi cpp source-cpp" and emits one nested span per token using
   GeSHi class names:
     kw1-kw4   language keywords/types/builtins (if, for, void, int, ...)
     kw5+      library identifiers (kw663, kw704, ... auto-generated by
               GeSHi for std:: members)
     me0-me2   member / method access
     co1, co2, coMULTI   comments
     st0, st_h           string literals
     es1, es2            escape sequences inside strings
     nu0-nu*             numeric literals
     sy0-sy*, br0        symbols / operators / brackets
     de1, de2            default text (whitespace-only spans)

   Strategy:
     1. Default everything inside .source-cpp to the editor foreground
        so unknown tokens stay legible.
     2. Color only the tokens that carry semantic weight, mapping each
        to a VSCode --vscode-symbolIcon-* variable so the palette
        tracks the active theme.
     3. Order rules so specific selectors override the catch-all: an
        attribute selector class-prefix-match has the same specificity
        as a single class selector, so source order picks the winner.
        The catch-all rule comes BEFORE the specific overrides.
     4. !important on every rule because cppreference embeds per-page
        GeSHi style blocks with hard-coded light-palette colors that
        otherwise win.
   ----------------------------------------------------------------------- */

/* Selectors target .mw-geshi — the container class GeSHi emits for
   both C++ code blocks (inner class source-cpp) and C code blocks
   (inner class source-c). Earlier versions selected only source-cpp,
   which silently skipped every C page and left the example uniformly
   colored. */

/* Default for unknown tokens inside a code block — editor foreground.
   Keeps whitespace and any class GeSHi didn't tag from rendering as
   the per-page light-palette default. */
body .mw-geshi,
body .mw-geshi span,
body .mw-geshi .de1,
body .mw-geshi .de2 {
  color: var(--cppref-code-fg) !important;
  background-color: transparent !important;
}

/* Library identifiers (kw5, kw6, ..., kwN) — every span whose class
   starts with kw. The kw1-kw4 keyword rule below overrides this for
   actual language keywords. Must come BEFORE the keyword rule because
   the kw-prefix attribute selector and the .kw1 class selector have
   equal specificity; source order picks the winner. */
body .mw-geshi [class^="kw"] {
  color: var(--cppref-syn-type) !important;
}

/* Language keywords: if/for/while/class/struct/template/auto/void/int/... */
body .mw-geshi .kw1,
body .mw-geshi .kw2,
body .mw-geshi .kw3,
body .mw-geshi .kw4 {
  color: var(--cppref-syn-keyword) !important;
}

/* Member / method names */
body .mw-geshi .me0,
body .mw-geshi .me1,
body .mw-geshi .me2 {
  color: var(--cppref-syn-function) !important;
}

/* Comments — italic the way the editor renders them. */
body .mw-geshi .co1,
body .mw-geshi .co2,
body .mw-geshi .coMULTI {
  color: var(--cppref-syn-comment) !important;
  font-style: italic;
}

/* String literals + their escape sequences. */
body .mw-geshi .st0,
body .mw-geshi .st_h,
body .mw-geshi [class^="st"],
body .mw-geshi [class^="es"] {
  color: var(--cppref-syn-string) !important;
}

/* Numeric literals. */
body .mw-geshi [class^="nu"] {
  color: var(--cppref-syn-number) !important;
}

/* Operators, symbols, brackets, punctuation. Editor foreground in most
   themes so they read as part of the structure rather than highlighted
   noise. */
body .mw-geshi [class^="sy"],
body .mw-geshi .br0 {
  color: var(--cppref-syn-operator) !important;
}

/* Preprocessor directives (#include, #define, ...). cppreference emits
   them as kw4 in some pages and as a span with class re0 in others. */
body .mw-geshi .re0,
body .mw-geshi .re1 {
  color: var(--cppref-syn-preproc) !important;
}

/* ----------------------------------------------------------------------
   highlight.js re-tokenization. Token colors come from the active
   base16 code theme (see code-themes.ts). The variables consumed
   below — --cppref-hljs-bg, --cppref-hljs-fg, --cppref-hljs-keyword,
   ... — are declared in the separate cppref-code-theme-vars style
   block emitted by buildCodeThemeVarsBlock. Swapping themes is a pure
   variable swap (the webview-client posts setCodeTheme and the host
   replies by rewriting just that block); no re-tokenization is needed.

   Selectors are scoped to "body code.hljs ..." so the rules never
   affect non-hljs content. Every property carries !important to
   outweigh the per-page GeSHi stylesheet cppreference ships.
   ---------------------------------------------------------------------- */
body pre.cppref-hljs-pre {
  background-color: var(--cppref-hljs-bg) !important;
  border: 1px solid var(--cppref-accent-warm) !important;
  border-radius: var(--cppref-radius);
  padding: 0.85em;
  margin: 0.7rem 0;
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
  font-size: 0.92em;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  tab-size: 4;
}
body pre.cppref-hljs-pre > code.hljs {
  display: block;
  background: transparent !important;
  padding: 0 !important;
  color: var(--cppref-hljs-fg) !important;
  font-family: inherit !important;
}

/* Token palette — class groupings mirror the canonical highlight.js
   base16 family (e.g. tomorrow-night, default-dark, dracula) so token
   additions in future highlight.js versions stay correctly colored
   without us having to chase them per-class. */
body code.hljs .hljs-name,
body code.hljs .hljs-title {
  color: var(--cppref-hljs-title) !important;
}
body code.hljs .hljs-comment,
body code.hljs .hljs-meta,
body code.hljs .hljs-meta .hljs-keyword {
  color: var(--cppref-hljs-comment) !important;
}
body code.hljs .hljs-deletion,
body code.hljs .hljs-link,
body code.hljs .hljs-literal,
body code.hljs .hljs-number,
body code.hljs .hljs-symbol {
  color: var(--cppref-hljs-number) !important;
}
body code.hljs .hljs-addition,
body code.hljs .hljs-doctag,
body code.hljs .hljs-regexp,
body code.hljs .hljs-selector-attr,
body code.hljs .hljs-selector-pseudo,
body code.hljs .hljs-string {
  color: var(--cppref-hljs-string) !important;
}
body code.hljs .hljs-attribute,
body code.hljs .hljs-code,
body code.hljs .hljs-selector-id {
  color: var(--cppref-hljs-attribute) !important;
}
body code.hljs .hljs-bullet,
body code.hljs .hljs-keyword,
body code.hljs .hljs-selector-tag,
body code.hljs .hljs-tag {
  color: var(--cppref-hljs-keyword) !important;
}
body code.hljs .hljs-subst,
body code.hljs .hljs-template-tag,
body code.hljs .hljs-template-variable,
body code.hljs .hljs-variable {
  color: var(--cppref-hljs-variable) !important;
}
body code.hljs .hljs-built_in,
body code.hljs .hljs-quote,
body code.hljs .hljs-section,
body code.hljs .hljs-selector-class,
body code.hljs .hljs-type {
  color: var(--cppref-hljs-type) !important;
}
body code.hljs .hljs-emphasis { font-style: italic !important; }
body code.hljs .hljs-strong { font-weight: 700 !important; }

/* Selection — track the active theme's selection slot (base02). Scoped
   to .hljs only so the rule never leaks out of code blocks. */
body code.hljs::selection,
body code.hljs span::selection {
  background: var(--cppref-hljs-selection) !important;
}
body code.hljs::-moz-selection,
body code.hljs span::-moz-selection {
  background: var(--cppref-hljs-selection) !important;
}

body img { background-color: transparent !important; }
.cppref-attribution {
  margin-top: 2.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--cppref-border) !important;
  color: var(--cppref-muted) !important;
  background-color: transparent !important;
  font-size: 0.85em;
}
.cppref-attribution--hidden { display: none !important; }
/* Zoom controls — fixed overlay, bottom-right, fades when idle */
.cppref-zoom-controls {
  position: fixed;
  bottom: 0.6rem;
  right: 0.6rem;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  z-index: 9999;
  opacity: 0.25;
  transition: opacity 0.15s;
  font-family: var(--vscode-font-family);
  font-size: 0.75rem;
}
.cppref-zoom-controls:hover { opacity: 1; }

/* Code-theme picker — small inline select element that lives inside
   the zoom-controls bar so it inherits the same opacity-on-hover
   behavior. The leading glyph is a cheap visual hint that the dropdown
   is about palette / theme rather than zoom. */
.cppref-code-theme-picker {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-right: 0.4rem;
  font-size: 0.72rem;
  color: var(--cppref-muted);
}
.cppref-code-theme-glyph {
  font-size: 0.85rem;
  line-height: 1;
  user-select: none;
}
.cppref-code-theme-picker select {
  background: var(--vscode-button-secondaryBackground, var(--vscode-editor-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  border: 1px solid var(--cppref-border);
  border-radius: 3px;
  height: 1.4rem;
  padding: var(--cppref-chip-pad-y) var(--cppref-chip-pad-x);
  font-family: var(--vscode-font-family);
  font-size: 0.72rem;
  cursor: pointer;
  max-width: 9rem;
}
.cppref-code-theme-picker select:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}
.cppref-code-theme-picker select:focus-visible {
  outline: 1px solid var(--cppref-link-active);
  outline-offset: 1px;
}

/* Back/forward navigation controls — fixed overlay, top-right.
   Visible at low opacity by default (so they don't compete with the
   page content visually) and fully opaque on hover. Mirrors the zoom
   controls' interaction pattern. */
.cppref-nav-controls {
  position: fixed;
  top: 0.6rem;
  right: 0.6rem;
  display: flex;
  gap: 0.15rem;
  z-index: 9999;
  opacity: 0.35;
  transition: opacity 0.15s, transform 0.22s ease;
  font-family: var(--vscode-font-family);
}
.cppref-nav-controls:hover { opacity: 1; }
/* When a breadcrumb is rendered AND visible (user hasn't scrolled
   past the top), slide the nav controls down so they sit just below
   the sticky bar instead of fighting it for the same pixels. The
   :has() guard skips pages with no breadcrumb (single-segment /
   welcome) and the data-cppref-scrolled check matches the
   breadcrumb's own hide transition, so the buttons snap back up in
   sync as the bar slides away. */
body:has(> .cppref-breadcrumb):not([data-cppref-scrolled="1"]) .cppref-nav-controls {
  transform: translateY(2.4rem);
}
.cppref-nav-btn {
  background: var(--vscode-button-secondaryBackground, var(--vscode-editor-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  border: 1px solid var(--cppref-border);
  border-radius: 3px;
  width: 1.7rem;
  height: 1.7rem;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cppref-nav-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  color: var(--cppref-link-active);
}
.cppref-nav-btn:focus-visible {
  outline: 1px solid var(--cppref-link-active);
  outline-offset: 1px;
}
/* Separator before the location-move button so it reads as a
   distinct affordance, not a third history-navigation arrow. */
.cppref-location-btn {
  margin-left: 0.4rem;
  border-left-color: var(--cppref-border);
  position: relative;
}
.cppref-location-btn::before {
  content: '';
  position: absolute;
  left: -0.25rem;
  top: 15%;
  bottom: 15%;
  width: 1px;
  background: var(--cppref-border);
  opacity: 0.6;
}

.cppref-zoom-btn {
  background: var(--vscode-button-secondaryBackground, var(--vscode-editor-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  border: 1px solid var(--cppref-border);
  border-radius: 3px;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cppref-zoom-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}
.cppref-zoom-label {
  min-width: 2.8rem;
  text-align: center;
  color: var(--cppref-muted);
  user-select: none;
}
.cppref-attribution a, html body .cppref-attribution a {
  color: var(--cppref-muted) !important;
}
.cppref-attribution a:hover, .cppref-attribution a:focus,
html body .cppref-attribution a:hover, html body .cppref-attribution a:focus {
  color: var(--cppref-link-active) !important;
}
body.vscode-high-contrast a,
body.vscode-high-contrast-light a { text-decoration: underline; }
body.vscode-high-contrast .cppref-attribution,
body.vscode-high-contrast-light .cppref-attribution {
  border-top-width: 2px !important;
}
/* -----------------------------------------------------------------------
   Typography scale. cppreference's source HTML doesn't impose its own
   heading sizes (it leans on the user agent), so a panel without these
   rules renders h1..h4 in indistinguishable browser defaults. The scale
   below gives each level a clear visual rank and tightens vertical
   rhythm so sections read as cohesive blocks rather than a long ribbon
   of paragraphs.
   ----------------------------------------------------------------------- */
body h1, body h2, body h3, body h4, body h5, body h6 {
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  /* More top than bottom margin: a heading visually attaches to the
     content it labels, with breathing room separating it from the
     previous section. */
  margin: 1.6em 0 0.5em;
}
body h1 { font-size: 1.6em; margin-top: 0.4em; }
body h2 {
  font-size: 1.3em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--cppref-border) !important;
}
body h3 { font-size: 1.15em; }
body h4 { font-size: 1.02em; }
body h5, body h6 { font-size: 0.95em; color: var(--cppref-muted) !important; }
body p, body ul, body ol, body dl { margin: 0.55em 0; }
body li { margin: 0.2em 0; }
body blockquote {
  margin: 0.85em 0;
  padding: 0.55em 1em;
  border-left: 3px solid var(--cppref-link) !important;
  background-color: var(--cppref-table-zebra-bg) !important;
  border-top-right-radius: var(--cppref-radius);
  border-bottom-right-radius: var(--cppref-radius);
  color: var(--cppref-fg) !important;
}
/* Heading anchor affordance — pilcrow appears on hover and copies the
   anchor link to the clipboard via the client-side toc module. The
   marker only shows when the heading has an id (cppreference emits one
   for every section). */
body :is(h1,h2,h3,h4,h5,h6)[id] .cppref-anchor {
  opacity: 0;
  margin-left: 0.4em;
  font-weight: 400;
  color: var(--cppref-muted) !important;
  text-decoration: none !important;
  transition: opacity 0.12s;
  user-select: none;
}
body :is(h1,h2,h3,h4,h5,h6)[id]:hover .cppref-anchor,
body :is(h1,h2,h3,h4,h5,h6)[id] .cppref-anchor:focus {
  opacity: 1;
}
body :is(h1,h2,h3,h4,h5,h6)[id] .cppref-anchor:hover {
  color: var(--cppref-link-active) !important;
}

/* -----------------------------------------------------------------------
   Sticky breadcrumb header — emits e.g. cpp > container > vector plus
   a C++ standard chip on the right. Sticks to the top of the viewport
   so the user always knows where they are inside the docset. The
   rewriter injects the markup as the first child of body.
   ----------------------------------------------------------------------- */
.cppref-breadcrumb {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: calc(-1 * clamp(0.75rem, 2vw, 1.75rem)) calc(-1 * clamp(0.85rem, 3vw, 2rem)) 1.2rem;
  padding: 0.55rem clamp(0.85rem, 3vw, 2rem);
  /* Solid panel background -- must fully occlude content scrolling
     underneath. Pre-fix this used --vscode-editorWidget-background,
     which is translucent in many modern VSCode themes (and inherits
     any blur from the host); the result was section headings like
     "Data members" bleeding through the sticky breadcrumb. Anchoring
     on --cppref-bg (resolves to the sidebar / panel / editor color)
     keeps the bar in the IDE palette while guaranteeing it is opaque.
     The bottom border keeps the chrome visually distinct from the
     page canvas. */
  background-color: var(--cppref-bg) !important;
  border-bottom: 1px solid var(--cppref-border) !important;
  font-size: 0.85em;
  color: var(--cppref-muted) !important;
  flex-wrap: wrap;
  /* Auto-hide on scroll: the client (state.ts:installBreadcrumbAutoHide)
     toggles body[data-cppref-scrolled="1"] when the user has scrolled
     past the top of the page. We slide the bar out of view via a
     transform so it animates cleanly and doesn't reflow the content
     while it's hidden. opacity zeroes out simultaneously so the bar
     doesn't blend with content during the transition. */
  transform: translateY(0);
  opacity: 1;
  transition: transform 0.22s ease, opacity 0.18s ease;
  will-change: transform, opacity;
  pointer-events: auto;
}
body[data-cppref-scrolled="1"] .cppref-breadcrumb {
  /* Translate by 100% of own height — guaranteed off-screen regardless
     of viewport size. pointer-events:none so any links inside don't
     intercept clicks while the bar is hidden. */
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}
.cppref-breadcrumb a {
  color: var(--cppref-muted) !important;
  text-decoration: none !important;
}
.cppref-breadcrumb a:hover,
.cppref-breadcrumb a:focus {
  color: var(--cppref-link-active) !important;
}
.cppref-breadcrumb .cppref-bc-sep {
  color: var(--cppref-border) !important;
  margin: 0 0.15em;
  user-select: none;
}
.cppref-breadcrumb .cppref-bc-current {
  color: var(--cppref-fg) !important;
  font-weight: 500;
}
.cppref-breadcrumb .cppref-bc-spacer { flex: 1 1 auto; }
.cppref-breadcrumb .cppref-bc-std {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8em;
  padding: var(--cppref-chip-pad-y) calc(var(--cppref-chip-pad-x) + 1px);
  border: 1px solid var(--cppref-border) !important;
  border-radius: 4px;
  background: var(--cppref-table-header-bg) !important;
  color: var(--cppref-muted) !important;
  letter-spacing: 0.02em;
}

/* -----------------------------------------------------------------------
   Auto-generated TOC (right rail). The client-side toc module walks
   h2 / h3 after the page mounts and emits an aside.cppref-toc
   floated to the right. Hides on viewports narrower than ~75rem so it
   doesn't crowd the content column on a sidebar-mode panel.
   ----------------------------------------------------------------------- */
.cppref-toc {
  position: fixed;
  top: 3.5rem;
  right: max(1rem, calc((100vw - 64rem) / 2 - 14rem));
  width: 13rem;
  max-height: calc(100vh - 6rem);
  overflow-y: auto;
  padding: 0.6rem 0.75rem;
  font-size: 0.82em;
  line-height: 1.45;
  border-left: 1px solid var(--cppref-border) !important;
  color: var(--cppref-muted) !important;
}
.cppref-toc-title {
  font-size: 0.78em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cppref-muted) !important;
  margin-bottom: 0.5em;
  user-select: none;
}
.cppref-toc ul {
  list-style: none !important;
  padding: 0 !important;
  margin: 0 !important;
}
.cppref-toc li { margin: 0.15em 0 !important; }
.cppref-toc li.cppref-toc-h3 { padding-left: 0.85em; }
.cppref-toc a {
  display: block;
  padding: 0.15em 0.4em;
  border-radius: 3px;
  border-left: 2px solid transparent;
  color: var(--cppref-muted) !important;
  text-decoration: none !important;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cppref-toc a:hover {
  background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08));
  color: var(--cppref-fg) !important;
}
.cppref-toc a.is-active {
  color: var(--cppref-fg) !important;
  border-left-color: var(--cppref-link) !important;
  background: var(--vscode-list-activeSelectionBackground, rgba(127,127,127,0.10));
}
@media (max-width: 80rem) {
  .cppref-toc { display: none; }
}

/* -----------------------------------------------------------------------
   Cppreference navbar dropdown — clamp width so it doesn't overflow
   narrow panels (sidebar mode is ~25rem wide; the menu's natural width
   is ~30rem and would push horizontal scroll on body).
   ----------------------------------------------------------------------- */
body .t-navbar-menu {
  max-width: min(40rem, 95vw) !important;
  overflow-x: auto;
}

/* -----------------------------------------------------------------------
   Generalize zebra striping to every wikitable / declaration table.
   cppreference's stock CSS only zebra-strides specific containers;
   adding a default tbody-level rule makes all member-list and
   declaration tables read more easily.
   ----------------------------------------------------------------------- */
body table.wikitable tbody tr:nth-child(even),
body table.t-rev-begin tbody tr:nth-child(even) {
  background-color: var(--cppref-table-zebra-bg) !important;
}
</style>`;
}

/**
 * Build the standard-filter `<style>` block for the resolved C++ standard
 * range. Caller passes the CSS body (typically the output of
 * `buildAllStandardFiltersCss()` from `ui/cpp-standard.ts`) so this module
 * stays free of cppstd-resolution coupling.
 */
export function buildStandardFilterStyleBlock(
    nonce: string,
    filterCss: string
): string {
    if (filterCss.toLowerCase().includes('</style>')) {
        throw new Error('filterCss contains </style> — potential injection');
    }
    return `<style nonce="${nonce}">
${filterCss}
</style>`;
}

/**
 * Emit the CSS-variable block that supplies the active code-snippet
 * palette. The variables are consumed by the hljs selectors inside
 * `buildThemeStyleBlock`. We carve this into a dedicated `<style>`
 * element with a stable id (`cppref-code-theme-vars`) so the
 * webview-client can swap palettes live by replacing the element's
 * textContent — no full re-render required.
 *
 * Emitted *after* the main theme block so the variables resolve in
 * the cascade for any rule that references them.
 */
export function buildCodeThemeVarsBlock(
    nonce: string,
    theme: CodeTheme
): string {
    const body = buildCodeThemeCssVars(theme);
    return `<style id="cppref-code-theme-vars" nonce="${nonce}" data-cppref-code-theme="${theme.id}">
:root { ${body} }
</style>`;
}

/**
 * Head injections to emit as the FIRST children of `<head>` (before any
 * page script and BEFORE cppreference's own `<link rel="stylesheet">`
 * chain — see docs/06-gotchas.md #1). Used by the rewriter on `onopentag`
 * for `<head>`.
 *
 * Order matters: CSP meta → base href → bootstrap data → bootstrap script.
 * Resource-loading tags (script) come after CSP so the policy applies;
 * bootstrap data precedes the bootstrap script so the script can read
 * `window.__cppref` synchronously. Theme/filter `<style>` blocks are NOT
 * emitted here — see `buildHeadLateInjections` for why.
 */
export function buildHeadEarlyInjections(ctx: TemplateContext): string {
    const csp = buildCspContent({ cspSource: ctx.cspSource, nonce: ctx.nonce });
    const parts: string[] = [];
    parts.push(
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    );
    if (ctx.baseHref) {
        parts.push(`<base href="${ctx.baseHref}">`);
    }
    const activeCodeTheme = getCodeTheme(ctx.codeTheme?.id);
    const bootstrapData = JSON.stringify({
        docsetWebviewBase: ctx.docsetWebviewBase,
        cppStandard: ctx.cppStandard ?? 'cxx26',
        zoomLevel: ctx.zoomLevel ?? 1.0,
        // Per-render scroll instruction — always emitted so the client
        // can land each navigation at a predictable position. `anchor`
        // present → scroll to the named element; otherwise → scroll to
        // top. See `scrollTarget` doc on TemplateContext for rationale.
        scrollTarget: ctx.scrollTarget ?? {},
        codeTheme: activeCodeTheme.id,
        codeThemes: getCodeThemeMenuEntries(),
        surfaceKind: ctx.surfaceKind ?? 'view',
        controls: {
            showZoom: ctx.controls?.showZoom ?? true,
            showThemePicker: ctx.controls?.showThemePicker ?? true,
            showNavButtons: ctx.controls?.showNavButtons ?? true
        }
    });
    const safeBootstrap = bootstrapData.replace(/<\/script>/gi, '<\\/script>');
    parts.push(
        `<script nonce="${ctx.nonce}">window.__cppref = ${safeBootstrap};` +
        // Defensive scroll reset that runs before any cppreference HTML
        // is parsed. Two layers: (1) disable browser-managed scroll
        // restoration so a webview state revival can't land us mid-page,
        // (2) explicit `scrollTo(0, 0)` so even when VSCode preserves
        // scroll position across `webview.html` reassignments, we start
        // at the top. `applyScrollTarget` (state.ts) runs at
        // DOMContentLoaded and replaces this with the requested anchor
        // when one is set; otherwise the (0, 0) already applied here
        // stays put.
        `try{if('scrollRestoration' in history)history.scrollRestoration='manual';` +
        `if(!window.__cppref.scrollTarget||!window.__cppref.scrollTarget.anchor){` +
        `window.scrollTo(0,0);` +
        // A second pass via rAF fires after the first layout+paint and
        // wins any race against Chromium's deferred scroll-restoration
        // (which runs between DOMContentLoaded and first paint and can
        // silently undo the synchronous scrollTo above).
        `requestAnimationFrame(function(){window.scrollTo(0,0);});` +
        `}}catch(_){}` +
        `</script>`
    );
    if (ctx.bootstrapScriptUri) {
        parts.push(
            `<script nonce="${ctx.nonce}" src="${ctx.bootstrapScriptUri}"></script>`
        );
    }
    return parts.join('\n');
}

/**
 * Head injections to emit as the LAST children of `<head>` (immediately
 * before `</head>`). Contains only the theme `<style>` block and the
 * standard-filter `<style>` block. These MUST land after cppreference's
 * own `<link rel="stylesheet" href="../../../common/ext.css">` so that
 * — at equal specificity — CSS source order picks ours as the winner
 * for `body { background, color, ... }` and friends. Without this split,
 * cppreference's stylesheet would override our VSCode-theme-bound rules
 * and the page would render with cppreference's stock light palette
 * regardless of the active VSCode theme.
 */
export function buildHeadLateInjections(ctx: TemplateContext): string {
    const parts: string[] = [];
    // Default to honoring the VSCode theme. Setting `respectVSCodeTheme:
    // false` explicitly disables the override block so cppreference's
    // stock palette comes through unchanged.
    if (ctx.respectVSCodeTheme !== false) {
        parts.push(buildThemeStyleBlock(ctx.nonce));
    }
    // Code-snippet palette block is emitted regardless of
    // respectVSCodeTheme — the hljs colors don't depend on whether
    // cppreference's stock palette is in play, and the user still
    // benefits from the active code theme.
    parts.push(buildCodeThemeVarsBlock(ctx.nonce, getCodeTheme(ctx.codeTheme?.id)));
    if (ctx.standardFilterCss && ctx.standardFilterCss.length > 0) {
        parts.push(
            buildStandardFilterStyleBlock(ctx.nonce, ctx.standardFilterCss)
        );
    }
    return parts.join('\n');
}

/**
 * Build the sticky breadcrumb header (e.g. `cpp › container › vector`)
 * for a given page path. The path is the locale-stripped, extension-
 * stripped form (same shape as `AttributionContext.pagePath`), e.g.
 * `cpp/container/vector` or `cpp/keyword/while`.
 *
 * Each segment is a clickable link that navigates to its corresponding
 * docset page (`en/<seg>/.../<seg>.html`) via the client click
 * interceptor's `data-cppref-nav` shortcut. The current (last) segment
 * is rendered as plain text. The right side carries an optional C++
 * standard chip (`cxx20`, `cxx23`, etc.) so the user can see which
 * standard the page is being filtered to.
 *
 * Returns an empty string for empty / single-segment paths so the
 * placeholder/welcome render doesn't get a stray breadcrumb.
 */
export function buildBreadcrumbHtml(args: {
    pagePath: string;
    cppStandard?: string;
}): string {
    const path = (args.pagePath ?? '').replace(/^\/+|\/+$/g, '');
    if (!path) return '';
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return '';

    const escAttr = (s: string): string =>
        s.replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    const escText = (s: string): string =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const parts: string[] = [];
    // No `cppref-no-intercept` here: the breadcrumb anchors carry
    // `data-cppref-nav` and need the global click listener to fire.
    parts.push('<nav class="cppref-breadcrumb" aria-label="Breadcrumb">');

    // Each non-final segment links to its sibling index page using
    // cppreference's actual file layout: a directory `cpp/container/`
    // has its index page at the SIBLING `cpp/container.html` — NOT at
    // `cpp/container/container.html`. So for segments [cpp, container,
    // vector] the breadcrumb links are `en/cpp.html` and
    // `en/cpp/container.html`; the final segment renders as plain text
    // because we're already on it.
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        if (i > 0) {
            parts.push('<span class="cppref-bc-sep">›</span>');
        }
        if (i === segments.length - 1) {
            parts.push(`<span class="cppref-bc-current">${escText(seg)}</span>`);
        } else {
            const navPath = `en/${segments.slice(0, i + 1).join('/')}.html`;
            parts.push(
                `<a href="#" data-cppref-nav="${escAttr(navPath)}">${escText(seg)}</a>`
            );
        }
    }

    parts.push('<span class="cppref-bc-spacer"></span>');
    if (args.cppStandard) {
        parts.push(
            `<span class="cppref-bc-std" title="Active C++ standard">${escText(args.cppStandard)}</span>`
        );
    }
    parts.push('</nav>');

    return parts.join('');
}

export function buildAttributionFooter(ctx: AttributionContext): string {
    const cls = ctx.enabled
        ? 'cppref-attribution'
        : 'cppref-attribution cppref-attribution--hidden';
    const upstream = `https://en.cppreference.com/w/${encodeURIComponent(ctx.pagePath).replace(/%2F/g, '/')}`;
    // H-3 — cppreference content is dual-licensed CC BY-SA 3.0 AND
    // GFDL. The footer cites both so the in-page attribution is
    // GFDL-compliant; the bundled `LICENSES/README.txt` (written by
    // `bundleLicenseTexts` at install) carries the redistribution
    // obligation.
    return `<footer class="${cls}">
  Source: <a href="${upstream}" data-cppref-external>cppreference.com</a> &middot;
  Licensed under <a href="https://creativecommons.org/licenses/by-sa/3.0/" data-cppref-external>CC BY-SA 3.0</a>
  &amp; <a href="https://www.gnu.org/licenses/fdl-1.3.html" data-cppref-external>GFDL</a>
</footer>`;
}

export interface ShellArgs {
    template: TemplateContext;
    attribution: AttributionContext;
    /** Inner HTML of `<body>`, before the attribution footer. */
    bodyHtml: string;
    title: string;
    lang?: string;
}

export function renderShellHtml(args: ShellArgs): string {
    // Placeholder pages don't load cppreference's stylesheet, so the
    // late-vs-early ordering issue doesn't apply — bundle both halves at
    // the top of <head> for a single contiguous block.
    const early = buildHeadEarlyInjections(args.template);
    const late = buildHeadLateInjections(args.template);
    const head = late.length > 0 ? `${early}\n${late}` : early;
    const footer = buildAttributionFooter(args.attribution);
    const stdAttr = args.template.cppStandard
        ? ` data-cpp-std="${args.template.cppStandard}"`
        : '';
    const lang = args.lang ?? 'en';
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
${head}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${args.title}</title>
</head>
<body${stdAttr}>
${args.bodyHtml}
${footer}
</body>
</html>`;
}
