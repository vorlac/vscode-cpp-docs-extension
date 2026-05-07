# Rendering Pipeline

The rendering pipeline transforms raw cppreference HTML into a styled, interactive document that integrates seamlessly with the active VSCode theme. This involves two passes: a host-side SAX rewrite (extension host process) and a client-side bootstrap (webview Chromium process).

## Overview

```mermaid
---
config:
    theme: 'base'
    curve: 'straight'
    themeVariables:
        darkMode: true
        clusterBkg: '#22272f62'
        clusterBorder: '#6a6f77ff'
        clusterTextColor: '#6a6f77ff'
        lineColor: '#C1C4CAAA'
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#C1C4CAff'
        primaryBorderColor: '#6a6f77ff'
        primaryLabelBkg: '#262B33'
        nodeTextColor: '#C1C4CA'
        defaultLinkColor: '#C1C4CA'
        edgeLabelBackground: '#262B33'
        edgeLabelBorderColor: '#C1C4CA'
        labelTextColor: '#C1C4CA'
        flowchart:
            curve: 'basis'
            nodeSpacing: 50
            rankSpacing: 50
            subGraphTitleMargin:
                top: 15
                bottom: 15
                left: 15
                right: 15
---
flowchart LR
    subgraph Host["Extension Host"]
        RAW["Raw HTML from disk"]:::neutral
        RW["rewriter.ts<br/>SAX pipeline"]:::accent
        TM["template.ts<br/>CSS + HTML generation"]:::neutral
        OUT["Rewritten HTML"]:::blue
    end

    subgraph Web["Webview (Chromium)"]
        DOM["DOM parsed by Chromium"]:::neutral
        BS["bootstrap.js<br/>client entry"]:::accent
        SX["syntax.ts<br/>hljs"]:::neutral
        TOC["toc.ts"]:::neutral
        NAV["nav.ts"]:::neutral
        ST["state.ts"]:::neutral
    end

    RAW --> RW
    TM -->|injections| RW
    RW --> OUT
    OUT ==>|"webview.html ="| DOM
    DOM --> BS
    BS --> SX & TOC & NAV & ST

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
```

## Host-Side Rewriter

[src/webview-host/rewriter.ts](src/webview-host/rewriter.ts) — SAX-based streaming HTML transformer using `htmlparser2`.

### Injection Points

```
<html>
  <head>
    ← EARLY HEAD (injected as first children)
       • <meta http-equiv="Content-Security-Policy" ...>
       • <base href="...">
       • <script>window.__cppref = { bootstrapData }</script>
       • <script nonce="..." src="bootstrap.js"></script>

    [cppreference original <link rel="stylesheet"> tags]

    ← LATE HEAD (injected as last children, BEFORE </head>)
       • <style>  VSCode theme CSS vars + reset + table system  </style>
       • <style id="cppref-code-theme-vars">  base16 code theme vars  </style>
       • <style>  C++ standard filter CSS  </style>
  </head>
  <body>
    ← BREADCRUMB (injected as first child of <body>)
       • <nav class="cppref-breadcrumb">cpp / container / vector</nav>

    [cppreference content]

    ← ATTRIBUTION FOOTER (injected before </body>)
       • CC BY-SA 3.0 + GFDL notice
  </body>
</html>
```

**Why EARLY + LATE head split?** The CSP `<meta>` and `<base href>` must come first so they apply to everything that follows. But the theme `<style>` must come *after* cppreference's own `<link rel="stylesheet">` so our VSCode-variable-bound rules win at equal specificity via source order. A single injection point can't satisfy both constraints.

### SAX Pipeline Handlers

```mermaid
---
config:
    theme: 'base'
    curve: 'straight'
    themeVariables:
        darkMode: true
        clusterBkg: '#22272f62'
        clusterBorder: '#6a6f77ff'
        clusterTextColor: '#6a6f77ff'
        lineColor: '#C1C4CAAA'
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#C1C4CAff'
        primaryBorderColor: '#6a6f77ff'
        primaryLabelBkg: '#262B33'
        nodeTextColor: '#C1C4CA'
        defaultLinkColor: '#C1C4CA'
        edgeLabelBackground: '#262B33'
        edgeLabelBorderColor: '#C1C4CA'
        labelTextColor: '#C1C4CA'
        flowchart:
            curve: 'basis'
            nodeSpacing: 50
            rankSpacing: 50
---
flowchart TD
    PI["onprocessinginstruction"]:::neutral --> EMIT_PI["emit as-is"]:::neutral
    OPEN["onopentag"]:::accent --> STRIP_SCRIPT{"name == script<br/>and stripScripts?"}:::warning
    STRIP_SCRIPT -->|yes| SKIP_INC["skipDepth++"]:::neutral
    STRIP_SCRIPT -->|no| REWRITE_A{"name == a<br/>has href?"}:::warning
    REWRITE_A -->|yes| NAVPATH["resolveInDocsetHref<br/>add data-cppref-nav attr"]:::neutral
    NAVPATH --> TABLE_CHK{"name == table?"}:::warning
    REWRITE_A -->|no| TABLE_CHK
    TABLE_CHK -->|"yes, top-level, not chrome"| WRAP["emit div.cppref-table-wrap"]:::neutral
    TABLE_CHK --> EMIT_TAG["emit open tag with sanitized attrs"]:::neutral
    EMIT_TAG --> HEAD_EARLY{"name == head<br/>and not yet injected?"}:::warning
    HEAD_EARLY -->|yes| INJECT_EARLY["buildHeadEarlyInjections"]:::blue
    EMIT_TAG --> BODY_OPEN{"name == body<br/>and not yet breadcrumb?"}:::warning
    BODY_OPEN -->|yes| INJECT_BC["buildBreadcrumbHtml"]:::blue
    TEXT["ontext"]:::neutral --> ESCAPE["escapeText → emit"]:::neutral
    CLOSE["onclosetag"]:::accent --> SKIP_CLOSE{"skipDepth > 0?"}:::warning
    SKIP_CLOSE -->|"script end"| SKIP_DEC["skipDepth--"]:::neutral
    SKIP_CLOSE -->|no| VOID_CHK{"void tag?"}:::warning
    VOID_CHK -->|yes| DROP["skip — no close tag"]:::neutral
    VOID_CHK -->|no| HEAD_LATE{"name == head<br/>not yet late?"}:::warning
    HEAD_LATE -->|yes| INJECT_LATE["buildHeadLateInjections"]:::blue
    HEAD_LATE --> BODY_CLOSE{"name == body<br/>not yet footer?"}:::warning
    BODY_CLOSE -->|yes| INJECT_FOOTER["buildAttributionFooter"]:::blue
    BODY_CLOSE --> EMIT_CLOSE["emit close tag"]:::neutral
    TABLE_CLOSE{"name == table?"}:::warning -->|"was wrapped"| CLOSE_WRAP["emit /div"]:::neutral

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
```

### Inline Style Sanitization

`sanitizeInlineStyle(value)` strips CSS properties that would override the VSCode theme:

**Dropped properties:** `background`, `background-color`, `background-image`, `color`, `border`, `border-color`, `border-top-color`, `border-right-color`, `border-bottom-color`, `border-left-color`

**Kept properties:** `width`, `height`, `padding`, `margin`, `text-align`, `vertical-align`, `display`, and all other layout properties.

The `bgcolor` HTML attribute is also dropped entirely (it bypasses CSS cascade).

### In-Docset Link Rewriting

For every `<a href>` tag, `resolveInDocsetHref()` checks if the href points to another page within the same docset. If so, it computes the docset-relative `pagePath` and stores it as `data-cppref-nav`:

```html
<!-- Before rewrite -->
<a href="../memory/allocator.html">std::allocator</a>

<!-- After rewrite -->
<a href="../memory/allocator.html" data-cppref-nav="en/cpp/memory/allocator.html">
  std::allocator
</a>
```

The client-side click interceptor reads `data-cppref-nav` directly — no URL parsing needed at click time. This avoids the fragile webview-URI string matching that was used previously.

### Table Wrapping

Top-level content tables are wrapped in `<div class="cppref-table-wrap">` to enable horizontal scroll inside the container instead of on the entire page:

```html
<!-- Before -->
<table class="t-dsc-begin">...</table>

<!-- After -->
<div class="cppref-table-wrap">
  <table class="t-dsc-begin">...</table>
</div>
```

Chrome tables (`t-navbar-head`, `t-navbar-menu`, `t-navbar`, `t-noprint`) are excluded because wrapping them breaks dropdown menu positioning.

Nested tables are not wrapped — only depth-0 tables get their own container.

## Template Generation

[src/webview-host/template.ts](src/webview-host/template.ts) — CSS and HTML generation for all injected content.

### TemplateContext

```typescript
interface TemplateContext {
    webview: Webview;           // for webview.asWebviewUri()
    nonce: string;              // CSP script nonce
    bootstrapUri: Uri;          // webview URI to bootstrap.js
    baseHref: string;           // page directory URL (for relative assets)
    docsetWebviewBase: string;  // documents root URL
    scrollTarget: ScrollTarget; // { anchor: 'id' } or {}
    cppStandard: CppStdToken;   // 'cxx11' | 'cxx14' | ... | 'cxx26'
    codeTheme: CodeTheme;       // selected base16 theme
    showZoom: boolean;
    showThemePicker: boolean;
    showNavButtons: boolean;
    zoomFactor: number;
}
```

### `buildHeadEarlyInjections(ctx)`

Produces:
1. **CSP `<meta>`** — `default-src 'none'; script-src 'nonce-${ctx.nonce}'; style-src 'unsafe-inline' ${cspSource}; img-src ${cspSource} data: https:; font-src ${cspSource} data:`
2. **`<base href>`** — resolves relative URLs in cppreference HTML (CSS, images, internal links) against the page's directory.
3. **Bootstrap data `<script>`** — `window.__cppref = { ... }` inline script (nonce-gated) with the `TemplateContext` fields needed by the client.
4. **Bootstrap `<script src>`** — loads `bootstrap.js` (nonce-gated).

### `buildHeadLateInjections(ctx)`

Produces:
1. **Theme `<style>`** — ~1500 lines of CSS generated by `buildThemeStyleBlock()`. Maps VSCode CSS variables (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.) to cppreference DOM elements. Includes a complete reset for cppreference's own colors and a responsive table system.
2. **Code theme `<style id="cppref-code-theme-vars">`** — base16 palette mapped to `--cppref-hljs-*` CSS custom properties. The stable `id` attribute allows live theme swapping by replacing just this element.
3. **Standard filter `<style>`** — CSS rules that show/hide `.t-since-cxxN` / `.t-until-cxxN` elements based on `body[data-cpp-std]`.

### Theme CSS Architecture

```mermaid
---
config:
    theme: 'base'
    curve: 'straight'
    themeVariables:
        darkMode: true
        clusterBkg: '#22272f62'
        clusterBorder: '#6a6f77ff'
        clusterTextColor: '#6a6f77ff'
        lineColor: '#C1C4CAAA'
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#C1C4CAff'
        primaryBorderColor: '#6a6f77ff'
        primaryLabelBkg: '#262B33'
        nodeTextColor: '#C1C4CA'
        defaultLinkColor: '#C1C4CA'
        edgeLabelBackground: '#262B33'
        edgeLabelBorderColor: '#C1C4CA'
        labelTextColor: '#C1C4CA'
        flowchart:
            curve: 'basis'
            nodeSpacing: 50
            rankSpacing: 50
---
flowchart TD
    VS["VSCode CSS variables<br/>--vscode-editor-background<br/>--vscode-editor-foreground<br/>--vscode-button-background<br/>etc."]:::accent

    subgraph Template["Template CSS"]
        MAP["Variable mapping<br/>--cppref-bg = var --vscode-editor-background<br/>--cppref-fg = var --vscode-editor-foreground"]:::neutral
        RESET["cppreference color reset<br/>body, td, th, .t-* { color: var --cppref-fg }"]:::neutral
        TABLE["Table system<br/>.cppref-table-wrap overflow-x auto<br/>table min-width 100%"]:::neutral
        BREAD["Breadcrumb<br/>.cppref-breadcrumb sticky top 0<br/>transition on body data-cppref-scrolled"]:::neutral
        TOC_CSS["TOC<br/>aside.cppref-toc fixed right<br/>scroll-spy active class"]:::neutral
    end

    VS --> MAP --> RESET & TABLE & BREAD & TOC_CSS

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
```

### Breadcrumb Generation

`buildBreadcrumbHtml({ pagePath, cppStandard })` converts a docset-relative path like `cpp/container/vector` into a linked breadcrumb trail:

```html
<nav class="cppref-breadcrumb" aria-label="Documentation path">
  <ol>
    <li><a href="..." data-cppref-nav="en/cpp/index.html">cpp</a></li>
    <li><a href="..." data-cppref-nav="en/cpp/container/index.html">container</a></li>
    <li><span>vector</span></li>  <!-- last segment: no link -->
  </ol>
</nav>
```

The breadcrumb is sticky and auto-hides on scroll (at 4px threshold) via `body[data-cppref-scrolled="1"]` which is toggled by the client's `installBreadcrumbAutoHide()`.

## Snippet Extraction

[src/webview-host/snippet.ts](src/webview-host/snippet.ts)

`extractSnippet(html, maxChars)` uses a finite-state machine to extract the declaration synopsis and first paragraph from a cppreference page, for use in hover previews.

```mermaid
---
config:
    theme: 'base'
    themeVariables:
        darkMode: true
        background: '#262B33'
        primaryColor: '#262B33'
        primaryTextColor: '#C1C4CA'
        primaryBorderColor: '#779DC9'
        edgeLabelBackground: '#262B33'
        edgeLabelBorderColor: '#779DC9'
        lineColor: '#C1C4CA'
        stateBkg: '#2b4268ff'
        stateLabelColor: '#C1C4CA'
        startStateColor: '#425f5fff'
        endStateColor: '#724848ff'
        labelBackgroundColor: '#262B33'
        labelBorderColor: '#779DC9'
        transitionColor: '#C1C4CA'
        transitionLabelColor: '#C1C4CA'
        transitionBorderColor: '#779DC9'
        stateColor: '#2b4268ff'
        noteColor: '#7a7253ff'
        noteBkgColor: '#3a3f47ff'
        noteTextColor: '#C1C4CA'
        noteBorderColor: '#6a6f77ff'
---
stateDiagram-v2
    searching --> searching_in_p: div.t-dcl-begin
    searching_in_p --> in_synopsis: open p
    searching_in_p --> done: close div (table closed without p)
    in_synopsis --> after_synopsis: close table inside dcl-begin
    after_synopsis --> in_paragraph: open p
    in_paragraph --> done: close p or maxChars reached
    in_synopsis --> in_synopsis: accumulate HTML
    in_paragraph --> in_paragraph: accumulate HTML

    note right of in_synopsis
        Captures t-dcl-begin declaration table
    end note
    note right of in_paragraph
        Captures first descriptive paragraph
    end note
```

**Text budget:** The `maxChars` limit applies to extracted text content (not HTML). When the budget is hit mid-tag, the FSM closes any open tags to preserve valid HTML structure rather than truncating abruptly.

**Stripped tags:** `<script>`, `<style>`, `<iframe>`, `<button>`, `<form>`, `<input>` — interactive elements have no meaning in a hover tooltip.

**Returns:**
```typescript
interface ExtractedSnippet {
    synopsis: string | undefined;   // HTML for the t-dcl-begin table
    intro: string | undefined;      // HTML for the first paragraph
}
```

### Snippet Cache

[src/webview-host/snippet-cache.ts](src/webview-host/snippet-cache.ts)

LRU cache for extracted snippets, capacity 64. Key: `"${filePath}|${mtimeMs}|${maxChars}"`.

The `mtimeMs` component provides automatic invalidation: if a cppreference reinstall rewrites the HTML file, the modified timestamp changes and the old cache entry is naturally evicted by the LRU policy.

## Hover Highlight

[src/webview-host/hover-highlight.ts](src/webview-host/hover-highlight.ts)

`highlightSynopsisHtml(html)` performs server-side syntax highlighting for the hover preview. This converts cppreference's GeSHi markup to highlight.js-colored spans.

```mermaid
---
config:
    theme: 'base'
    curve: 'straight'
    themeVariables:
        darkMode: true
        clusterBkg: '#22272f62'
        clusterBorder: '#6a6f77ff'
        clusterTextColor: '#6a6f77ff'
        lineColor: '#C1C4CAAA'
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#C1C4CAff'
        primaryBorderColor: '#6a6f77ff'
        primaryLabelBkg: '#262B33'
        nodeTextColor: '#C1C4CA'
        defaultLinkColor: '#C1C4CA'
        edgeLabelBackground: '#262B33'
        edgeLabelBorderColor: '#C1C4CA'
        labelTextColor: '#C1C4CA'
        flowchart:
            curve: 'basis'
            nodeSpacing: 50
            rankSpacing: 50
---
flowchart TD
    INPUT["Synopsis HTML with mw-geshi spans"]:::neutral
    WALK["Walk DOM tokens looking for div.mw-geshi"]:::neutral
    STRIP["Strip GeSHi child spans<br/>preserve text content"]:::neutral
    RETOK["Re-tokenize with hljs.highlight<br/>language: cpp"]:::accent
    CONVERT["Convert hljs class spans to<br/>inline style= color: var CSS"]:::neutral
    OUTPUT["Colored HTML for hover"]:::success

    INPUT --> WALK --> STRIP --> RETOK --> CONVERT --> OUTPUT

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
```

**HLJS_COLORS map** maps highlight.js class names to VSCode CSS variable references with hex fallbacks:

```typescript
const HLJS_COLORS: Record<string, string> = {
    'hljs-keyword': 'var(--vscode-editorInfo-foreground, #569cd6)',
    'hljs-string': 'var(--vscode-debugTokenExpression-string, #ce9178)',
    'hljs-number': 'var(--vscode-debugTokenExpression-number, #b5cea8)',
    'hljs-comment': 'var(--vscode-editorLineNumber-foreground, #6a9955)',
    // ... 15+ entries
};
```

Using VSCode CSS variables means the hover preview colors track the active theme, matching the webview's colors.

## Client Bootstrap

[src/webview-client/index.ts](src/webview-client/index.ts)

The browser IIFE bundle entry point. Reads `window.__cppref` (injected by the host) and wires up all client subsystems.

```mermaid
---
config:
    theme: 'base'
    themeVariables:
        darkMode: true
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#FFFFFF'
        primaryBorderColor: '#779DC9'
        lineColor: '#C1C4CA'
        actorBkg: '#2b4268ff'
        actorBorder: '#779DC9'
        actorTextColor: '#C1C4CA'
        actorLineColor: '#779DC9'
        activationBorderColor: '#c7ac9bff'
        activationBkgColor: '#7a6253ff'
        sequenceNumberColor: '#FFFFFF'
        noteBkgColor: '#3a3f47ff'
        noteTextColor: '#C1C4CA'
        noteBorderColor: '#6a6f77ff'
        labelBoxBkgColor: '#425f5fff'
        labelBoxBorderColor: '#8c9c81ff'
        labelTextColor: '#C1C4CA'
        loopTextColor: '#82867eff'
        altSectionBkgColor: '#4d4962ff'
        altSectionBorderColor: '#8983a5ff'
        signalColor: '#C1C4CA'
        signalTextColor: '#C1C4CA'
        messageTextColor: '#C1C4CA'
---
sequenceDiagram
    participant DOM as DOMContentLoaded
    participant IDX as index.ts bootstrap
    participant SX as syntax.ts
    participant TOC as toc.ts
    participant NAV as nav.ts
    participant ST as state.ts

    IDX->>IDX: applyInitialStandard() — set body[data-cpp-std]
    IDX->>ST: installScrollPersistence()
    IDX->>ST: installBreadcrumbAutoHide()
    IDX->>NAV: installNavListener()
    IDX->>IDX: installHostMessageListener()
    IDX->>IDX: installZoomControls() [if showZoom]
    IDX->>IDX: installCodeThemePicker() [if showThemePicker]
    IDX->>IDX: installNavControls() [if showNavButtons]
    IDX->>IDX: installLocationControl() [always]
    DOM->>SX: applySyntaxHighlight()
    DOM->>TOC: installToc()
    DOM->>IDX: computeAndApplyBaseSizeCorrection()
```

**`computeAndApplyBaseSizeCorrection()`** adjusts the base font size to compensate for VSCode's webview default font-size setting, ensuring text renders at the expected size regardless of the user's VSCode font preference.

## Client: Syntax Highlighting

[src/webview-client/syntax.ts](src/webview-client/syntax.ts)

`applySyntaxHighlight()` re-tokenizes code blocks with highlight.js to produce consistent, theme-aware syntax colors.

**Target selectors:**
- `div.mw-geshi` — cppreference's GeSHi-highlighted code blocks
- `pre.source-cpp` — pre-colored C++ blocks
- `pre.source-c` — pre-colored C blocks

**Filtering:** Only blocks that are multiline OR longer than 30 characters with whitespace are highlighted. Inline code snippets (like identifiers in prose) are skipped.

**Language detection:** CSS class names on the container are parsed: `source-cpp` → `cpp`, `source-c` → `c`. If both are present, `cpp` wins.

**Idempotency:** Processed blocks receive `data-cppref-hljs="1"`. Calling `applySyntaxHighlight()` twice won't double-process a block.

**Output structure:**
```html
<pre class="cppref-hljs-pre">
  <code class="hljs language-cpp">
    <!-- hljs-tokenized spans -->
  </code>
</pre>
```

## Client: Table of Contents

[src/webview-client/toc.ts](src/webview-client/toc.ts)

`installToc()` builds a floating sidebar TOC from heading elements.

**Requirements:**
- At least 3 headings with `id` attributes required (otherwise TOC is skipped).
- Processes `h2[id]` and `h3[id]` elements.

**Structure:**
```html
<aside class="cppref-toc">
  <nav>
    <ul>
      <li class="toc-h2"><a href="#declarations">Declarations ¶</a></li>
      <li class="toc-h3"><a href="#notes">Notes ¶</a></li>
    </ul>
  </nav>
</aside>
```

**Pilcrow anchors:** Each heading gets a `¶` symbol appended as a clipboard-copy button. Clicking copies `location.href + '#' + heading.id` to the clipboard.

**Scroll-spy via IntersectionObserver:**
```typescript
new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            // mark corresponding TOC link as active
        }
    }
}, { rootMargin: '-10% 0px -70% 0px' });
```

The `rootMargin` of `-10% 0px -70% 0px` means a heading is considered "active" when it's in the upper 20% of the viewport, providing natural reading-position tracking.

## Client: Navigation

[src/webview-client/nav.ts](src/webview-client/nav.ts)

`classifyClick(event, docsetWebviewBase)` is a pure function that determines how to handle a click:

| Classification | Condition                                                                      | Action                              |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `skip`         | Not an `<a>` click, or `.cppref-no-intercept` class, or `data-cppref-external` | Default browser behavior            |
| `anchor`       | `href` starts with `#`                                                         | Scroll to anchor in current page    |
| `nav`          | `data-cppref-nav` present, or href resolves within `docsetWebviewBase`         | Post `nav` message to host          |
| `external`     | All other hrefs                                                                | Post `openExternal` message to host |

**Fast path:** If the rewriter already computed `data-cppref-nav`, the click handler uses it directly without any URL parsing. The URL-based fallback handles links the rewriter couldn't pre-compute (edge cases, dynamically generated content).

Every click classification is reported back to the host via a diagnostic `click` message for observability.

## Client: Scroll and State

[src/webview-client/state.ts](src/webview-client/state.ts)

### Scroll Persistence

```mermaid
---
config:
    theme: 'base'
    themeVariables:
        darkMode: true
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#FFFFFF'
        primaryBorderColor: '#779DC9'
        lineColor: '#C1C4CA'
        actorBkg: '#2b4268ff'
        actorBorder: '#779DC9'
        actorTextColor: '#C1C4CA'
        actorLineColor: '#779DC9'
        activationBorderColor: '#c7ac9bff'
        activationBkgColor: '#7a6253ff'
        sequenceNumberColor: '#FFFFFF'
        noteBkgColor: '#3a3f47ff'
        noteTextColor: '#C1C4CA'
        noteBorderColor: '#6a6f77ff'
        labelBoxBkgColor: '#425f5fff'
        labelBoxBorderColor: '#8c9c81ff'
        labelTextColor: '#C1C4CA'
        loopTextColor: '#82867eff'
        altSectionBkgColor: '#4d4962ff'
        altSectionBorderColor: '#8983a5ff'
        signalColor: '#C1C4CA'
        signalTextColor: '#C1C4CA'
        messageTextColor: '#C1C4CA'
---
sequenceDiagram
    participant USER as User scrolls
    participant ST as state.ts
    participant VS as VSCode API
    participant HOST as Extension host

    USER->>ST: scroll event
    ST->>ST: debounce 100ms
    ST->>VS: setState({ active: { docsetId, pagePath, scrollY } })
    ST->>HOST: postMessage({ type: 'setState', scrollY })
```

`history.scrollRestoration = 'manual'` is set at startup to prevent Chromium from auto-restoring scroll positions when the webview HTML is replaced by the host.

### Scroll Target Application

`applyScrollTarget()` uses a two-pass approach:
1. **Immediate** (on DOMContentLoaded) — call `scrollIntoView()` or `scrollTo(0,0)`.
2. **rAF follow-up** — call again after the first layout+paint.

The second pass is necessary because Chromium's deferred scroll-restoration can run between DOMContentLoaded and the first paint and silently undo the initial `scrollTo(0,0)`. The rAF fires after the first paint, overriding Chromium's restoration.

### Breadcrumb Auto-Hide

`installBreadcrumbAutoHide()` sets `body[data-cppref-scrolled="0|1"]` based on scroll position (threshold: 4px). The CSS uses this attribute to slide the breadcrumb off-screen when scrolled:

```css
.cppref-breadcrumb {
    transform: translateY(0);
    transition: transform 0.2s ease;
}
body[data-cppref-scrolled="1"] .cppref-breadcrumb {
    transform: translateY(-100%);
}
```

## Client: Code Theme Picker

[src/webview-client/code-theme.ts](src/webview-client/code-theme.ts)

`installCodeThemePicker()` builds a `<select>` element with `<optgroup>` for Dark and Light themes. On change, posts `pickCodeTheme` to the host.

`handleSetCodeTheme(themeId)` receives the `setCodeTheme` host message and replaces the content of `<style id="cppref-code-theme-vars">` with the new CSS variable block — a live theme swap without page reload.

The element ID `"cppref-code-theme-vars"` is stable and defined in both the template (where the `<style>` is initially injected) and the client (where it's replaced on theme change).
