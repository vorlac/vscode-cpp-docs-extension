# UI Layer

The UI layer encompasses everything visible to the user: the documentation panel (WebviewView or WebviewPanel), the hover provider, the symbol tree, the search view, and the surface management infrastructure.

## Surface Manager

[src/ui/surface/manager.ts](src/ui/surface/manager.ts)

The `SurfaceManager` enforces the **single-instance invariant**: only one webview surface (either the sidebar `WebviewView` or an editor `WebviewPanel`) is active at any time.

```mermaid
---
config:
    theme: 'base'
    themeVariables:
        darkMode: true
        background: '#262B33'
        primaryColor: '#2b4268ff'
        primaryTextColor: '#C1C4CA'
        primaryBorderColor: '#3a3f47ff'
        mainBkg: '#262B33'
        secondBkg: '#425f5fff'
        textColor: '#C1C4CA'
        tertiaryBkg: '#4d4962ff'
        classText: '#C1C4CA'
        lineColor: '#978c72ff'
        labelBoxBkgColor: '#425f5fff'
        labelBoxBorderColor: '#8c9c81ff'
        labelTextColor: '#C1C4CA'
        mainContrastColor: '#FFFFFF'
        noteColor: '#7a7253ff'
        noteBkgColor: '#3a3f47ff'
        noteTextColor: '#C1C4CA'
        noteBorderColor: '#6a6f77ff'
---
classDiagram
    class SurfaceManager:::accent {
        -view: WebviewView | undefined
        -panel: WebviewPanel | undefined
        -viewHistory: NavigationHistory
        -panelHistory: NavigationHistory
        -viewDocsetIds: Set~number~
        -panelDocsetIds: Set~number~
        +onDidNavigate: EventEmitter
        +pickTarget() WebviewView | WebviewPanel | undefined
        +adoptPanelHistoryToView() void
        +adoptViewHistoryToPanel() void
        +showPage(docsetId, pagePath, anchor?) Promise
        +viewIsStale() bool
        +panelIsStale() bool
    }
    class NavigationHistory:::neutral
    class PageLoader:::neutral

    SurfaceManager --> NavigationHistory
    SurfaceManager --> PageLoader

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
```

**`pickTarget()`** returns whichever surface is currently registered (view or panel). If both somehow exist (transitional state during moves), the panel takes precedence.

**Staleness detection:** When new docsets are installed after a surface was created, `viewIsStale()` / `panelIsStale()` return `true` (the set of docset IDs registered with the surface doesn't match the current set). This triggers a reload prompt to the user so the new docset becomes available without restarting VSCode.

**History adoption:** When the user moves the panel from sidebar to editor (or vice versa), `adoptPanelHistoryToView()` / `adoptViewHistoryToPanel()` transfer the navigation stack so back/forward continuity is maintained across moves.

**`onDidNavigate` event:** Fired after every successful page load. Used by the symbol TreeView to reveal the tree node corresponding to the currently-shown page.

## Navigation History

[src/ui/surface/navigation.ts](src/ui/surface/navigation.ts)

Browser-style back/forward navigation stack. Cap: 50 entries.

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
    [*] --> Empty
    Empty --> HasHistory: push(target)

    state HasHistory {
        [*] --> AtEnd
        AtEnd --> MidStack: goBack()
        MidStack --> AtEnd: goForward()
        MidStack --> MidStack: goBack / goForward
        AtEnd --> AtEnd: push truncates forward stack
    }
```

```typescript
interface NavTarget {
    docsetId: number;
    pagePath: string;
    anchor?: string;
}

class NavigationHistory {
    push(target: NavTarget): void
    goBack(): NavTarget | undefined
    goForward(): NavTarget | undefined
    canGoBack(): boolean
    canGoForward(): boolean
    current(): NavTarget | undefined
}
```

`push()` truncates the forward stack (entries after the current position) before appending the new target — standard browser behavior. Pressing Back after navigating to a new page discards the forward history.

**`hrefToTarget(href, docsets)`** — resolves a clicked href to a `NavTarget` by matching against each docset's webview base URL. Returns `undefined` for external links.

## Page Loader

[src/ui/surface/page-loader.ts](src/ui/surface/page-loader.ts)

`loadPageInWebview(webview, docsetId, pagePath, anchor?, loaderDeps?)` is the main rendering function called by `SurfaceManager.showPage()`.

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
    START(["loadPageInWebview"]):::neutral --> FIND["Find docset row by id"]:::neutral
    FIND --> READ["Read HTML file from disk"]:::neutral
    READ --> CTX["Build TemplateContext<br/>baseHref, docsetWebviewBase, scrollTarget"]:::neutral
    CTX --> REWRITE["rewriteHtml rawHtml, RewriteContext"]:::accent
    REWRITE --> SET["webview.html = rewrittenHtml"]:::blue
    SET --> MSG["postMessage setActive to client"]:::neutral
    MSG --> EVENT["emit onDidNavigate"]:::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
```

### Placeholder Renderers

When no docset page is available, specialized placeholder pages are rendered using `renderShellHtml()` from `shared.ts`:

| Function                          | When                                  | Content                          |
| --------------------------------- | ------------------------------------- | -------------------------------- |
| `renderEmptyPage()`               | After `clearPanel` on miss            | Blank page                       |
| `renderMissPlaceholder(fqn)`      | Symbol not in index                   | "No docs for X" with search link |
| `renderReloadPlaceholder()`       | After docset install while panel open | "Click to reload" button         |
| `renderNotInstalledPlaceholder()` | No docsets at all                     | "Install cppreference" CTA       |

Placeholders use the same `buildHeadLateInjections()` + theme CSS as real pages, so they inherit the VSCode theme colors.

### Navigation Resolution

`resolveNavHref(webview, href, docsets)` → called by the click interceptor when `data-cppref-nav` is not present. Parses the href URI and compares against docset webview base URIs.

`resolveNavHrefByPagePath(docsets, pagePath, anchor?)` → called with a `data-cppref-nav` value. Direct docset-relative path lookup.

`resolveNavHrefByPath(docsets, absolutePath)` → called for file-system-URI links (rare in cppreference pages).

## WebviewPanel Serializer

`src/ui/surface/serialize/` — Implements `WebviewPanelSerializer` which VSCode calls to restore an editor panel after an IDE restart.

```typescript
interface SerializedPanelState {
    docsetId: number;
    pagePath: string;
    scrollY?: number;
}
```

On `deserializeWebviewPanel(panel, state)`:
1. Validates the state shape (guards against schema mismatches from extension updates).
2. Calls `SurfaceManager.adoptPanel(panel)` to register the restored panel.
3. Calls `loadPageInWebview()` with the persisted `pagePath` and `scrollY` as `scrollTarget`.

The state is kept in sync by the client's `setActive` message (host posts it after every `loadPageInWebview()`, client echoes back with current `scrollY`).

## Hover Provider

[src/ui/hover-provider.ts](src/ui/hover-provider.ts)

`CppDocsHoverProvider` implements `vscode.HoverProvider`. Registered for `cpp`, `c`, `cuda-cpp`, `objective-c`, `objective-cpp`.

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
    START(["provideHover"]):::neutral --> REEN{"Reentrancy guard<br/>uri+line+char already resolving?"}:::warning
    REEN -->|yes| UNDEF(["undefined"]):::error
    REEN -->|no| INSTALLED{"hasAnyDocset?"}:::warning
    INSTALLED -->|no| NOT_INSTALLED["Show 'Install docs' hover"]:::neutral
    INSTALLED -->|yes| RESOLVE["resolver.resolve at position"]:::accent
    RESOLVE --> SYM{"resolved?"}:::warning
    SYM -->|no| UNDEF2(["undefined"]):::error
    SYM -->|yes| LOOKUP["IndexDB.lookupBest fqn"]:::blue
    LOOKUP --> ROW{"row found?"}:::warning
    ROW -->|no| UNDEF3(["undefined"]):::error
    ROW -->|yes| STAT["fs.stat filePath for mtimeMs"]:::neutral
    STAT --> CACHE_CHK["snippetCache.get key"]:::neutral
    CACHE_CHK -->|hit| BUILD_MD["buildHoverMarkdown"]:::accent
    CACHE_CHK -->|miss| READ["Read HTML file"]:::neutral
    READ --> EXTRACT["extractSnippet html"]:::neutral
    EXTRACT --> HIGHLIGHT["highlightSynopsisHtml synopsis"]:::neutral
    HIGHLIGHT --> CACHE_SET["snippetCache.set key, snippet"]:::neutral
    CACHE_SET --> BUILD_MD
    BUILD_MD --> HOVER(["Hover with MarkdownString"]):::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
    classDef error fill:#724848,stroke:#ac9696,color:#ffffff
```

### Reentrancy Guard

The reentrancy guard (`resolving: Set<string>`) prevents infinite recursion. The hover-parser resolver strategy calls `vscode.executeHoverProvider`, which re-triggers `CppDocsHoverProvider.provideHover()`. Without the guard, this would recurse indefinitely.

Key: `"${uri.toString()}|${version}|${line}:${character}"` — same format as the resolver cache key.

### Hover Markdown Construction

`buildHoverMarkdown(row, snippet, fqn)` assembles the hover `MarkdownString`:

```markdown
**cppreference** · std::vector::push_back

```cpp
void push_back( const T& value );
void push_back( T&& value );
```

Appends the given element value to the end of the container...

[Open in docs panel](command:cppDocs.openPage?...) · [Search](command:cppDocs.search?...)
```

The `MarkdownString` is created with `isTrusted: { enabledCommands: ['cppDocs.openPage', 'cppDocs.search'] }` — a restricted trust mode that allows only those specific command links, not arbitrary commands. (Using `isTrusted: true` would allow any command, a security risk.)

The `HOVER_PROVENANCE_PREFIX = '**cppreference**'` constant identifies the hover as coming from this extension, helping users distinguish it from clangd's own hover or other providers.

## Symbol TreeView

The symbol tree is a standard VSCode `TreeDataProvider<TreeItem>` registered against the `cppDocs.docsetTree` view ID.

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
    ROOT["Root items:<br/>Docset names"]:::accent
    DOCSET["Docset node:<br/>'cppreference 20241030'"]:::blue
    KIND["Kind node:<br/>'Functions', 'Classes', 'Headers', ..."]:::neutral
    SYM["Symbol node:<br/>'std::vector::push_back'"]:::neutral

    ROOT --> DOCSET --> KIND --> SYM

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
```

**Filter integration:** The tree view has a built-in filter box. User input is passed to `IndexDB.searchSymbolsForFilter(query)` which runs a `LIKE '%query%' COLLATE NOCASE` search. Results are shown flat (no kind grouping) when a filter is active.

**Tree reveal sync:** `SurfaceManager.onDidNavigate` fires after each page load. The tree provider handles this event by calling `treeView.reveal(node)` for the symbol node corresponding to the current page.

## C++ Standard Manager

[src/ui/cpp-standard-manager.ts](src/ui/cpp-standard-manager.ts)

`CppStandardManager` tracks the current C++ standard and notifies subscribers when it changes.

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
    subgraph Sources["Change Sources"]
        CONFIG["workspace config change<br/>cppDocs.cppStandard"]:::neutral
        FALLBACK["workspace config change<br/>cppDocs.cppStandard.fallback"]:::neutral
        CCPP["workspace config change<br/>C_Cpp.default.cppStandard"]:::neutral
        EDITOR["active editor changed<br/>.cpp / .c file"]:::neutral
        COMPILE_DB["compile_commands.json changed<br/>filesystem watcher"]:::neutral
    end

    CONFIG & FALLBACK & CCPP & EDITOR & COMPILE_DB --> RESOLVE["resolveCppStandard<br/>pure function"]:::accent
    RESOLVE --> EMIT["EventEmitter.fire<br/>new CppStdToken"]:::blue
    EMIT --> SURFACE["surfaces.setStandard<br/>postMessage setStandard to webview"]:::neutral
    EMIT --> STATUS["statusItem.text = token"]:::neutral

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
```

**`resolveCppStandard()`** priority chain:
1. `cppDocs.cppStandard` explicit setting (highest priority)
2. `C_Cpp.default.cppStandard` from the C/C++ extension
3. Active file's `compile_commands.json` entry (`-std=c++20` flags parsed by `parseStdFromCmd()`)
4. `cppDocs.cppStandard.fallback` setting
5. `'cxx17'` hard default

**`parseStdFromCompileDb(filePath)`** reads `compile_commands.json`, finds the entry for the current file, and extracts the `-std=` flag. Cached per file path to avoid re-parsing on every cursor movement.

## C++ Standard Filtering CSS

[src/ui/cpp-standard.ts](src/ui/cpp-standard.ts)

`buildAllStandardFiltersCss(token)` generates CSS that shows only the API elements available in the selected standard:

```css
/* For cxx17: */
body[data-cpp-std="cxx17"] .t-until-cxx17 { display: none !important; }
body[data-cpp-std="cxx17"] .t-since-cxx20 { display: none !important; }
body[data-cpp-std="cxx17"] .t-since-cxx23 { display: none !important; }
body[data-cpp-std="cxx17"] .t-since-cxx26 { display: none !important; }
/* Elements available in cxx17 and below remain visible */
body[data-cpp-std="cxx17"] .t-since-cxx11 { display: block !important; }
body[data-cpp-std="cxx17"] .t-since-cxx14 { display: block !important; }
body[data-cpp-std="cxx17"] .t-since-cxx17 { display: block !important; }
```

`buildStandardFilterCssFor(token)` generates rules for a single standard, `buildAllStandardFiltersCss()` generates for all standards (the full block is injected once; only the active `body[data-cpp-std]` attribute value matters at render time).

`settingToToken()` / `tokenToSetting()` convert between the config string format (`"C++17"`, `"c++20"`) and the internal token format (`"cxx17"`, `"cxx20"`).

`parseStdFromCmd(flagString)` parses `-std=c++20`, `-std=gnu++17`, `-std=c17`, etc. from compile command strings.

## Search View

The search view is a `WebviewView` registered as `cppDocs.searchView` (shown only when `hasDocsets`). It provides full-text search across all installed documentation.

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
    participant USER as User
    participant WV as Search WebviewView
    participant HOST as Extension host
    participant IDB as IndexDB

    USER->>WV: Types query in search box
    WV->>HOST: postMessage { type: 'search', query }
    HOST->>IDB: searchContent(query)
    IDB-->>HOST: SearchResult[] ranked by FTS5 relevance
    HOST->>WV: postMessage { type: 'searchResults', results }
    USER->>WV: Clicks a result
    WV->>HOST: postMessage { type: 'nav', pagePath }
    HOST->>HOST: loadPageInWebview(...)
```

Results are ranked by FTS5's built-in relevance scoring (BM25 with Porter stemming). The top 20 results are returned.

## Status Bar Item

A `StatusBarItem` in the bottom status bar shows the active C++ standard (e.g., `C++17`). Clicking it runs `cppDocs.selectStandard` to open a quick-pick for standard selection.

When no docsets are installed, the status bar item shows a `$(cloud-download)` icon with an "Install" label. Clicking it runs `cppDocs.install`.
