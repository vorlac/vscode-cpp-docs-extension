# Symbol Resolution

The resolver is the core intelligence of the extension. Given a cursor position in a C++ source file, it must determine the fully-qualified name (FQN) of the symbol under the cursor so that the correct documentation page can be looked up in the index.

## Architecture

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
flowchart TD
    INPUT["cursor position + document"]:::neutral --> DA["directive-aware wrapper"]:::neutral
    DA -->|"non-#if context"| IA["include-aware wrapper"]:::neutral
    IA -->|"#include context"| INCLUDE_RESULT["Header lookup"]:::success
    IA -->|"normal code"| CACHE["LRU cache wrapper<br/>256 entries"]:::blue
    CACHE -->|"cache hit"| RESULT["ResolvedSymbol"]:::success
    CACHE -->|"cache miss"| CHAIN["Strategy chain"]:::accent

    subgraph Chain["Strategy Chain"]
        S0["0: keyword<br/>KEYWORDS_TO_SKIP + exact lookup"]:::neutral
        S1["1: clangd-bridge<br/>textDocument/symbolInfo LSP"]:::neutral
        S2["2: hover-parser<br/>clangd hover text parse"]:::neutral
        S3["3: definition-walker<br/>source text scope walk"]:::neutral
        S4["4: fallback<br/>source scope + IndexDB"]:::neutral
        S0 -->|miss| S1
        S1 -->|miss| S2
        S2 -->|miss| S3
        S3 -->|miss| S4
    end

    CHAIN --> S0
    S4 --> RESULT
    RESULT --> OUTPUT["ResolvedSymbol or undefined"]:::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
```

Each strategy races against a configurable timeout via `AbortController`. If it times out, the next strategy is tried.

## Resolver Types

[src/resolver/types.ts](src/resolver/types.ts)

```typescript
interface ResolveContext {
    document: TextDocument;
    position: Position;
    signal: AbortSignal;   // cancellation from cursor change or hover timeout
}

interface ResolvedSymbol {
    fqn: string;           // "std::vector::push_back"
    source?: string;       // which strategy resolved it
    usr?: string;          // clangd USR if available
    anchor?: string;       // fragment id for anchor scroll
}

type ResolverStrategyName = 'keyword' | 'clangd' | 'hover' | 'definition' | 'fallback';

interface ResolverStrategy {
    name: ResolverStrategyName;
    resolve(ctx: ResolveContext): Promise<ResolvedSymbol | undefined>;
}
```

## Strategy Composition

[src/resolver/cpp.ts](src/resolver/cpp.ts)

`composeResolver(strategies, timeoutMs)` iterates the strategy array in order. Each strategy is raced against a timeout:

```typescript
async function raceStrategy(
    strategy: ResolverStrategy,
    ctx: ResolveContext,
    timeoutMs: number
): Promise<ResolvedSymbol | undefined> {
    return Promise.race([
        strategy.resolve(ctx),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs))
    ]);
}
```

`buildProductionResolver()` assembles the full chain with wrappers:

```typescript
const composed = composeResolver([keyword, clangd, hover, definition, fallback]);
const withCache = wrapWithCache(composed, cache);
const withInclude = wrapWithIncludeAwareness(withCache, indexDb);
const withDirective = wrapWithDirectiveAwareness(withInclude);
return withDirective;
```

**Wrapper order matters:**
- `wrapWithDirectiveAwareness` is outermost: catches `#if`/`#ifdef` directives before the keyword strategy would try to look them up.
- `wrapWithIncludeAwareness` is next: `#include <vector>` routes to a Header lookup, bypassing the full chain.
- `wrapWithCache` is innermost: cache keying only fires on actual code symbols (after directive/include filtering).

## Cache Wrapper

[src/resolver/cache.ts](src/resolver/cache.ts)

Map-based LRU, capacity 256. Cache key: `"${uri}|${version}|${line}:${character}"`.

```typescript
type CacheEntry = ResolvedSymbol | null;
// null = cached miss (symbol looked up but not found)
// undefined = not in cache (never looked up)
```

The `null` vs `undefined` distinction is critical:
- `null` cached entry → skip the inner resolver (it already failed here), return `undefined` to caller.
- `undefined` in cache map → call the inner resolver, then store the result (`ResolvedSymbol`) or `null` (for miss).

This means a failed lookup at a position is not retried on subsequent hovers, which prevents the resolver chain from running 5 strategies every time the cursor sits on an unresolvable token.

Document `version` is included in the key so edits immediately invalidate the cached entry for that position without needing to flush the whole cache.

## Strategy 0: Keyword

[src/resolver/keyword.ts](src/resolver/keyword.ts)

The fastest strategy. Checks the word at the cursor against a hardcoded skip-list and then the IndexDB.

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
    START(["keyword.resolve"]):::neutral --> WORD["Get word at cursor"]:::neutral
    WORD --> ELLIPSIS{"is '...'"}:::warning
    ELLIPSIS -->|yes| UNDEF(["undefined"]):::error
    ELLIPSIS -->|no| SKIP{"in KEYWORDS_TO_SKIP"}:::warning
    SKIP -->|yes| UNDEF2(["undefined"]):::error
    SKIP -->|no| EXACT["lookupExact word"]:::blue
    EXACT --> HIT{"keyword hit?"}:::warning
    HIT -->|yes| RESULT(["ResolvedSymbol"]):::success
    HIT -->|no| STD["lookupExact 'std::' + word"]:::blue
    STD --> HIT2{"keyword hit?"}:::warning
    HIT2 -->|yes| RESULT2(["ResolvedSymbol"]):::success
    HIT2 -->|no| UNDEF3(["undefined"]):::error

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
    classDef error fill:#724848,stroke:#ac9696,color:#ffffff
```

**`isKeywordHit()`** accepts a symbol row as a keyword match if either:
- `kind === 'Keyword'` or `kind === 'Language'`, or
- `filePath` matches `/(?:keywords?|language)\//` (some cppreference pages are filed under `keyword/` directory).

**`KEYWORDS_TO_SKIP`** — C++ keywords that don't have documentation pages and would produce false IndexDB matches if looked up: `if`, `else`, `for`, `while`, `return`, `auto`, `this`, `true`, `false`, `nullptr`, etc.

**`isOnEllipsis()`** detects parameter-pack `...` which shouldn't be resolved.

The `std::` fallback lookup exists because some cppreference pages are indexed under their standard-qualified name (`std::nullptr_t`) but the cursor word is just `nullptr_t`.

## Strategy 1: Clangd Bridge

[src/resolver/clangd-bridge.ts](src/resolver/clangd-bridge.ts)

Uses the `textDocument/symbolInfo` LSP request to get the symbol's fully-qualified name and USR directly from clangd.

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
    START(["clangd.resolve"]):::neutral --> EXT["Get vscode-clangd extension"]:::neutral
    EXT --> ACT{"Not activated?"}:::warning
    ACT -->|activate| WAIT["await extension.activate"]:::neutral
    WAIT --> LC["Get languageClient from exports"]:::neutral
    LC --> VER{"Check server version"}:::warning
    VER -->|"clangd >= 23"| SKIP(["undefined — symbolInfo removed"]):::error
    VER -->|"clangd < 23"| REQ["Send textDocument/symbolInfo LSP request"]:::blue
    REQ --> RESP{"Response?"}:::warning
    RESP -->|empty| UNDEF(["undefined"]):::error
    RESP -->|"has info"| BUILD["buildFqnFromSymbolInfo"]:::accent
    BUILD --> RESULT(["ResolvedSymbol with usr"]):::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
    classDef error fill:#724848,stroke:#ac9696,color:#ffffff
```

**Version gate:** `textDocument/symbolInfo` was removed in clangd 23. The bridge checks `serverInfo.version` from the LSP `initialize` response and skips if major version ≥ 23.

**`buildFqnFromSymbolInfo()`** strips template arguments from the `containerName` field (clangd sometimes includes them) then concatenates `containerName + "::" + name`.

**`raceWithAbort()`** wraps the LSP Promise with the `AbortSignal` so cursor movement or hover timeout cancels the in-flight request.

## Strategy 2: Hover Parser

[src/resolver/hover-parser.ts](src/resolver/hover-parser.ts)

Calls `vscode.executeHoverProvider` (triggering clangd's hover) and parses the returned markdown to extract the FQN.

This is the most complex strategy because clangd's hover format changed significantly between versions 16 and 17+.

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
    START(["hover.resolve"]):::neutral --> REEN{"Reentrancy guard<br/>not already resolving?"}:::warning
    REEN -->|"already resolving"| UNDEF(["undefined"]):::error
    REEN -->|safe| EXEC["executeHoverProvider at position"]:::blue
    EXEC --> PARSE["Parse hover markdown"]:::neutral
    PARSE --> FMT{"Detect format"}:::warning
    FMT -->|"clangd 16: ### name"| V16["Extract after ###"]:::neutral
    FMT -->|"clangd 17+: bare name"| V17["Extract from first line"]:::neutral
    FMT -->|"**bold** name"| BOLD["Extract from bold markers"]:::neutral
    V16 & V17 & BOLD --> KIND{"variable / field?"}:::warning
    KIND -->|yes| TYPE["Extract type from 'Type: X' or code fence"]:::neutral
    KIND -->|no| NAME["Extract function/class name"]:::neutral
    NAME & TYPE --> NS["Extract namespace hint '// In namespace X'"]:::neutral
    NS --> NORM["normalizeFqn pipeline"]:::accent
    NORM --> RESULT(["ResolvedSymbol"]):::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
    classDef error fill:#724848,stroke:#ac9696,color:#ffffff
```

**`normalizeFqn()` pipeline:**
1. `sanitizeAliasDecoration()` — removes `[aka ...]` suffixes clangd adds for type aliases.
2. `stripTemplateArgs()` — removes `<...>` template argument lists (with `<>` depth tracking). Special-cases `operator<`, `operator>`, `operator<<=`, etc. so operator overloads aren't mangled.
3. `stripAbiNamespaces()` — removes `::__1::`, `::__cxx11::`, `::__debug::` etc. (libc++/libstdc++ internal namespaces). Implemented in [src/util/fqn.ts](src/util/fqn.ts).
4. `normalizeConstructor()` — rewrites `std::vector::vector` → `std::vector::vector` (preserves constructor FQN).
5. `normalizeDestructor()` — rewrites `std::vector::~vector` → `std::vector::~vector` (preserves destructor FQN).

**`maskExpressionSpecifiers()`** replaces `decltype(...)`, `sizeof(...)`, `alignof(...)`, and cast operator bodies with placeholder strings before parsing. Without this, parentheses inside expression specifiers confuse the function name extraction logic.

## Strategy 3: Definition Walker

[src/resolver/definition-walker.ts](src/resolver/definition-walker.ts)

Reads the source file text and extracts the FQN by parsing the declaration at the cursor line and walking enclosing scopes.

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
    START(["definition.resolve"]):::neutral --> SKIM["parseDefinitionContext<br/>cursor line ± 5 lines"]:::neutral
    SKIM --> SCRUB["scrubStringsAndComments"]:::neutral
    SCRUB --> MASK["maskExpressionSpecifiers"]:::neutral
    MASK --> TRY1["extractQualifiedNameFromLine<br/>look for :: in declaration"]:::accent
    TRY1 --> HIT1{"has :: ?"}:::warning
    HIT1 -->|yes| RESULT1(["FQN from declaration"]):::success
    HIT1 -->|no| IDENT["extractIdentifierFromLine"]:::neutral
    IDENT --> WALK["walkEnclosingScopes<br/>scan backwards for namespace/class braces"]:::accent
    WALK --> CAND["Build FQN candidates"]:::neutral
    CAND --> LOOKUP["IndexDB lookupExact per candidate"]:::blue
    LOOKUP --> RESULT2(["ResolvedSymbol or undefined"]):::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
```

**`scrubStringsAndComments()`** handles:
- `//` line comments (mask rest of line)
- `/* */` block comments (track nesting depth)
- `"..."` string literals (handle `\"` escaping)
- `'...'` char literals
- `R"(...)"` raw string literals

This is necessary because `{` inside strings and comments would corrupt the brace-depth counting used for scope detection.

**`walkEnclosingScopes()`** scans backwards from the cursor line:
- Tracks `{` / `}` depth to find enclosing scope openings.
- At each scope opener, tries to parse a `namespace X` or `class/struct X` declaration.
- Builds the scope stack innermost-first.

**`extractQualifiedNameFromLine()`** looks for patterns like `ReturnType Scope::method(args)` in out-of-line definitions and extracts the `Scope::method` part directly — avoiding the scope walk entirely for this common case.

## Strategy 4: Fallback

[src/resolver/fallback.ts](src/resolver/fallback.ts)

The last resort. Performs a source-level scope walk to build candidate FQNs, then looks each up in the IndexDB.

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
    START(["fallback.resolve"]):::neutral --> WALK["walkScopes<br/>build scope stack + using-namespace list"]:::accent
    WALK --> WORD2["Get word at cursor"]:::neutral
    WORD2 --> MEMBER["detectMemberAccess<br/>before cursor: '.', '->', '::'"]:::warning
    MEMBER -->|dot/arrow| UNDEF(["undefined — member access, skip"]):::error
    MEMBER -->|double-colon| RESTRICT["Restricted candidate set"]:::neutral
    MEMBER -->|none| FULL["Full candidate set"]:::neutral
    FULL & RESTRICT --> CANDS["buildFqnCandidates<br/>innermost scope first"]:::accent
    CANDS --> EACH["For each candidate"]:::neutral
    EACH --> EXACT2["IndexDB.lookupExact"]:::blue
    EXACT2 -->|hit| RESULT(["ResolvedSymbol"]):::success
    EXACT2 -->|miss| NEXT["next candidate"]:::neutral
    NEXT --> EACH
    NEXT -->|"all miss"| UNQUAL["IndexDB.lookupByUnqualified<br/>safety net"]:::blue
    UNQUAL --> RESULT2(["ResolvedSymbol or undefined"]):::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
    classDef error fill:#724848,stroke:#ac9696,color:#ffffff
```

**`buildFqnCandidates()`** generates candidates in this priority order:
1. Innermost scope: `InnermostClass::word`
2. Each enclosing scope outward: `Outer::Inner::word`, `Outer::word`
3. Each `using namespace X`: `X::word`
4. Bare word: `word`

**`detectMemberAccess()`** scans the source text immediately before the cursor position (ignoring whitespace) to detect:
- `.` — instance member access → skip (member name without object type is not resolvable)
- `->` — pointer member access → skip
- `::` — scope resolution → use restricted candidate set (only fully-qualified candidates)

## Include-Aware Wrapper

[src/resolver/include-aware.ts](src/resolver/include-aware.ts)

Short-circuits the resolver chain when the cursor is inside an `#include` directive.

**`detectIncludeContext()`** examines the current line:
- `#include "..."` (quoted) → always returns `undefined`. Project headers don't appear in the docs index.
- `#include <X>` (system header) → returns `{ kind: 'system', header: X }`.

For system headers, calls `indexDb.lookupExact(X)` restricted to `kind === 'Header'`. If found, returns the Header symbol. Otherwise `undefined`.

This means hovering over `#include <vector>` takes you directly to the `<vector>` header page without running any of the five strategies.

## Cursor Follow

[src/resolver/cursor-follow.ts](src/resolver/cursor-follow.ts)

`handleCursorChange()` is the bridge between the VSCode editor selection event and the resolver + surface system. Called on every (debounced) cursor movement.

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
    START(["handleCursorChange"]):::neutral --> CHECK["Check followCursor config"]:::neutral
    CHECK -->|disabled| RETURN(["return"]):::neutral
    CHECK -->|enabled| LANG{"Language allowed?<br/>cpp/c/cuda-cpp/objc"}:::warning
    LANG -->|no| RETURN2(["return"]):::neutral
    LANG -->|yes| RESOLVE["resolver.resolve at cursor"]:::accent
    RESOLVE --> SYM{"Symbol resolved?"}:::warning
    SYM -->|no| MISS["onMissBehavior"]:::warning
    MISS -->|stay| RETURN3(["return — keep current page"]):::neutral
    MISS -->|showLink| HOVER["Show hover with search link"]:::neutral
    MISS -->|clearPanel| CLEAR["renderEmptyPage"]:::neutral
    SYM -->|yes| DOCSET{"hasAnyDocset?"}:::warning
    DOCSET -->|no| NOTINST["renderNotInstalledPlaceholder<br/>once per unique FQN"]:::neutral
    DOCSET -->|yes| DUP{"Same as lastShownSymbolId?"}:::warning
    DUP -->|yes| RETURN4(["return — already showing this"]):::neutral
    DUP -->|no| LOAD["surfaces.showPage<br/>with resolved pagePath + anchor"]:::success

    classDef neutral fill:#3a3f47,stroke:#6a6f77,color:#C1C4CA
    classDef accent fill:#4d4962,stroke:#8983a5,color:#ffffff
    classDef blue fill:#2b4268,stroke:#779DC9,color:#ffffff
    classDef success fill:#425f5f,stroke:#8c9c81,color:#ffffff
    classDef warning fill:#7a7253,stroke:#c7c19b,color:#ffffff
```

**`lastShownSymbolId`** is a module-level string `"${docsetId}:${pagePath}:${anchor}"`. This deduplication prevents unnecessary re-renders when the cursor moves but stays on the same token.

**`onMissBehavior`** (config: `cppDocs.onMissBehavior`):
- `stay` — do nothing; keep the current page visible.
- `showLink` — show a hover message with a link to search for the symbol.
- `clearPanel` — render an empty placeholder.

**Language allowlist:** Only `cpp`, `c`, `cuda-cpp`, `objective-c`, `objective-cpp` trigger cursor follow. The resolver won't fire in JavaScript, Python, etc. files even if the panel is open.

## FQN Normalization Detail

The FQN normalization pipeline (used in the hover-parser strategy) is the most delicate piece of the resolver. cppreference indexes symbols under normalized FQNs without template arguments, without ABI namespaces, and with consistent constructor/destructor names.

```
clangd hover text:               "std::__1::vector<int, std::__1::allocator<int>>::push_back"
after sanitizeAliasDecoration:   "std::__1::vector<int, std::__1::allocator<int>>::push_back"
after stripTemplateArgs:         "std::__1::vector::push_back"
after stripAbiNamespaces:        "std::vector::push_back"
after normalizeConstructor:      "std::vector::push_back"    (unchanged — not a ctor)
→ lookupBest("std::vector::push_back") → hit
```

```
clangd hover text:               "std::__cxx11::basic_string<char> [aka std::string]"
after sanitizeAliasDecoration:   "std::__cxx11::basic_string<char>"
after stripTemplateArgs:         "std::__cxx11::basic_string"
after stripAbiNamespaces:        "std::basic_string"
→ lookupBest("std::basic_string") → hit
```

**ABI namespace patterns stripped by `stripAbiNamespaces()`:**
- `::__1::` (libc++ on macOS/FreeBSD)
- `::__2::` (libc++ alternate)
- `::__cxx11::` (libstdc++ ABI)
- `::__debug::` (libstdc++ debug mode)
- `::__8::` and similar numeric suffixes

These patterns are matched by the regex `/::\__\w+::/g` applied globally.
