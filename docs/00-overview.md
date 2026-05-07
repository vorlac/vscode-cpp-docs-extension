 # cpp-docs: Extension Overview

`cpp-docs` is a VSCode extension that brings the complete offline cppreference.com documentation set directly into the editor. When you hover over a C++ symbol, the extension resolves it to an exact documentation page, renders that page with full styling inside a WebviewView or WebviewPanel, and optionally follows your cursor as you type — all without opening a browser.

## Core Features

| Feature                    | Description                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| **Offline documentation**  | Downloads and indexes cppreference HTML archives locally; no internet required after install |
| **Cursor-follow mode**     | Automatically shows docs for the symbol under the cursor as you navigate                     |
| **Hover previews**         | Inline hover markdown with a synopsis excerpt, linked to the full page                       |
| **Symbol resolution**      | 5-strategy chain (keyword → clangd → hover-parser → definition-walker → fallback)            |
| **C++ standard filtering** | Hide deprecated/future APIs via a standard selector (C++11 through C++26)                    |
| **Code theme picker**      | 30 base16 themes (15 dark / 15 light) applied live without page reload                       |
| **Full-text search**       | FTS5-powered Porter-stemmer search across all installed doc pages                            |
| **Symbol tree**            | TreeView of all indexed symbols, filterable by kind                                          |
| **Navigation history**     | Browser-style back/forward inside the docs panel                                             |
| **Table of contents**      | Auto-generated sticky TOC with IntersectionObserver scroll-spy                               |
| **Breadcrumb trail**       | Sticky breadcrumb reflecting the cppreference path hierarchy                                 |

## What Gets Installed

```
~/.vscode/extensions/orlac.cpp-docs-*/
  dist/
    host/extension.js          ← Node CJS bundle (runs in extension host)
    client/bootstrap.js        ← Browser IIFE bundle (runs in webview)
  media/
    cpp-docs.svg               ← Activity bar icon
    cpp-docs-viewer.svg        ← Panel icon
    cpp-docset-library.svg     ← Tree view icon

<docsetStoragePath>/           ← Configurable; default: OS app-data dir
  cppreference-<version>/
    en/cpp/...                 ← HTML pages (post-processed at install time)
    Docs/cppreference.tag      ← Doxygen tag XML
  cpp-docs.db                  ← SQLite index (symbols + FTS)
```

## How It Works — The Fast Path

```
User hovers over std::vector::push_back
        │
        ▼
  CppDocsHoverProvider.provideHover()
        │
        ▼
  Resolver chain resolves FQN
  → "std::vector::push_back"
        │
        ▼
  IndexDB.lookupBest("std::vector::push_back")
  → { filePath: "en/cpp/container/vector/push_back.html", anchor: "" }
        │
        ▼
  extractSnippet(filePath)
  → { synopsis: "<table class='t-dcl-begin'>...", intro: "<p>Appends..." }
        │
        ▼
  CppDocsHoverProvider returns MarkdownString
  with synopsis HTML + "Open docs" command link
        │
        ▼
  User clicks "Open docs"
        │
        ▼
  loadPageInWebview(docsetId, pagePath)
        │
        ▼
  rewriteHtml(rawHtml, ctx)
  → inject CSP + base href + theme CSS + breadcrumb
        │
        ▼
  webview.html = rewritten page
  webview-client bootstrap.js runs in webview
  → syntax highlight, TOC, scroll, nav intercept
```

## Panel Placement

The docs panel can live in two places, controlled by `cppDocs.location`:

- **`sidebar`** (default) — A `WebviewView` anchored to the secondary sidebar or a custom viewcontainer. Persistent; stays open across file switches.
- **`editor`** — A `WebviewPanel` in the editor tab group. Opened like a file tab.

Only one surface is active at a time (the `SurfaceManager` single-instance invariant).

## Docset Sources

| Source       | Format                                    | How indexed                 |
| ------------ | ----------------------------------------- | --------------------------- |
| cppreference | `html-book-*.tar.xz` from GitHub Releases | Doxygen tag XML + disk walk |

## File Layout

```
src/
  extension.ts            ← Activation, command registration, wiring
  docset/
    manager.ts            ← DocsetManager: orchestrates IndexDB
    index.ts              ← IndexDB: SQLite-WASM in-memory DB
    schema.ts             ← SQL DDL (docsets, symbols, fts_pages)
    types.ts              ← Shared data shapes
    cppreference-installer.ts  ← Download + extract + postprocess
    cppreference-indexer.ts    ← Tag XML + disk walk → IndexDB
    cppreference-postprocess.ts ← Install-time HTML chrome strip
    update-check.ts       ← GitHub Releases polling
  resolver/
    cpp.ts                ← composeResolver + buildProductionResolver
    cache.ts              ← LRU wrapper (256 entries)
    clangd-bridge.ts      ← Strategy: clangd LSP symbolInfo
    hover-parser.ts       ← Strategy: clangd hover text parsing
    definition-walker.ts  ← Strategy: scope-walk source text
    fallback.ts           ← Strategy: scope-walk + IndexDB lookup
    keyword.ts            ← Strategy: C++ keyword table
    include-aware.ts      ← Wrapper: #include context detection
    cursor-follow.ts      ← Cursor change handler
    types.ts              ← ResolveContext, ResolvedSymbol, etc.
    cpp-keywords.ts       ← KEYWORDS_TO_SKIP set
  ui/
    hover-provider.ts     ← CppDocsHoverProvider
    cpp-standard.ts       ← Standard token types + CSS generation
    cpp-standard-manager.ts ← Standard change subscription
    surface/
      manager.ts          ← SurfaceManager (single-instance invariant)
      navigation.ts       ← NavigationHistory (back/forward stacks)
      page-loader.ts      ← loadPageInWebview + placeholder renderers
      serialize/          ← WebviewPanelSerializer
  webview-host/
    rewriter.ts           ← htmlparser2 SAX rewriter
    template.ts           ← CSS/HTML generation for injection
    snippet.ts            ← extractSnippet FSM
    snippet-cache.ts      ← LRU snippet cache (64 entries)
    code-themes.ts        ← 30 base16 code themes
    hover-highlight.ts    ← Server-side GeSHi → hljs conversion
    messages.ts           ← Typed message union (client ↔ host)
  webview-client/
    index.ts              ← Bootstrap entry point
    syntax.ts             ← Client-side hljs re-tokenization
    toc.ts                ← TOC builder + IntersectionObserver
    nav.ts                ← Click interception + nav message posting
    state.ts              ← VSCode API state persistence + scroll
    code-theme.ts         ← Code theme picker
  util/
    debounce.ts           ← Trailing-edge debounce with cancel/flush
    fqn.ts                ← ABI namespace stripping
    output.ts             ← Structured output channel logging
```

## Technology Choices

| Choice                    | Rationale                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@sqlite.org/sqlite-wasm` | Cross-platform (no native addon to compile); same API surface as `better-sqlite3` but runs in-process via WASM |
| `htmlparser2`             | Fast SAX-style streaming parser; handles malformed cppreference HTML robustly                                  |
| `highlight.js`            | Self-contained browser-compatible; bundled in client IIFE                                                      |
| `saxes`                   | Standards-compliant XML parser for Doxygen tag files                                                           |
| esbuild dual-bundle       | Node CJS for extension host, browser IIFE for webview; external packages stay unbundled                        |
| Base16 palettes           | Industry-standard 16-slot color system; maps directly to hljs token classes                                    |
