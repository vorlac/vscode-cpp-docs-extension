// Strategy 2: parse `vscode.executeHoverProvider` output to recover an FQN.
//
// Per docs/03-symbol-resolution.md § "Strategy 2 — parse executeHoverProvider
// output" and docs/06-gotchas.md items 10, 11, 22, 23, 24.
//
// Pipeline:
//   1. Ask VSCode for all hovers at the cursor position.
//   2. Filter out any hover whose first content block starts with our own
//      marker (default `**cppreference**`) — we will be the only hover
//      provider using this prefix once M5 wires us in. Without this filter
//      the parser sees its own output and can loop on certain inputs
//      (gotcha #10).
//   3. Join the remaining hovers' MarkdownString content blocks into one
//      string and try clangd's grammar first, then MS C/C++'s.
//   4. Normalize: strip template arguments, expand constructor/destructor
//      forms, and return the canonical FQN.
//
// `vscode` is imported via `import type` only at module scope; the runtime
// surface is provided by callers through `HoverStrategyDeps.vscode`. This
// keeps the file unit-testable in plain Node without a vscode shim.

import type * as vscode from 'vscode';

import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy
} from './types.js';
import { stripAbiNamespaces, stripTemplateArgs } from '../util/fqn.js';
import { isExpressionSpecifier } from './cpp-keywords.js';
import { raceWithAbort } from '../util/abort.js';
import { findMatchingParen } from '../util/parse-helpers.js';

// ---------------------------------------------------------------------------
// Layer 1: pure markdown extractors.
// ---------------------------------------------------------------------------

/**
 * Result shape shared by the two parsers. `isConstructor` / `isDestructor`
 * flags are hints lifted from clangd's marker line; `normalizeFqn` consumes
 * them to expand `Foo` into `Foo::Foo` and `~Foo` into `Foo::~Foo`.
 */
export interface ParsedHover {
    fqn: string;
    isConstructor?: boolean;
    isDestructor?: boolean;
}

// clangd's marker line shape, as documented in docs/03-symbol-resolution.md.
//
// Two on-the-wire formats observed across clangd versions:
//
//   clangd 16 and earlier:
//     ### function std::sort
//     ### method std::vector<int>::push_back
//     ### constructor std::vector<int>
//     ### class std::vector
//
//   clangd 17+:
//     function std::sort                     (bare)
//     **function** std::sort                 (bold)
//     function begin                         (unqualified — see NAMESPACE_HINT_RE below)
//     variable v                             (gotcha: name is the IDENTIFIER,
//                                             we want its TYPE — see
//                                             extractVariableType)
//
// The `###` prefix is OPTIONAL so we accept both. We also tolerate a single
// pair of surrounding `*` or `**` emphasis markers around the kind keyword.
// Anchored at start-of-line; the trailing capture is non-greedy up to a
// newline so it stops before the body.
// `type-alias` (hyphen) is what `clang::index::SymbolKindToString` emits for
// `using` / `typedef` declarations on clangd 17+. Earlier clangd versions
// rendered the same kind as `type alias` (space). Accept both spellings —
// without the hyphen variant a hover on `std::string_view` falls through to
// the fence-based path, which can't recover the alias name and ends up
// resolving to `std::basic_string_view` (or worse, the type+alias pair as
// a space-joined string that misses the index).
const CLANGD_MARKER_RE =
    /^(?:###\s+)?\*{0,2}(function|method|constructor|destructor|class|struct|union|enum|namespace|variable|field|type alias|type-alias|type|typedef)\*{0,2}\s+([^\n]+?)\s*$/m;

// clangd 17+ emits a "// In namespace XXX" comment in the markdown body
// above the declaration code-fence. When the marker line carries an
// unqualified name (e.g. `function begin`), we use this hint to recover
// the FQN (`std::begin`). See user report 1 in the M-iter-34 fix notes.
const NAMESPACE_HINT_RE = /^\/\/\s+In\s+namespace\s+([A-Za-z_][\w:]*)\s*$/m;

// `Type:` line emitted by clangd for variable / field hovers:
//
//   variable v
//
//   Type: std::vector<int>
//
// We prefer the type over the variable name because cppreference indexes
// types, not user-named instances (user report 2).
const VARIABLE_TYPE_RE = /^Type:\s*([^\n]+?)\s*$/m;

// Generic "<rettype> <FQN>(args)" shape from a code-fenced declaration.
// Captures the qualified name immediately preceding the parameter list.
// We anchor on `(` because every function-like declaration in clangd /
// MS C/C++'s hovers ends the name at the open-paren.
const DECL_NAME_RE = /([A-Za-z_~][\w:~<>,\s*&]*?)\s*\(/;

// MS C/C++ class/struct/namespace markers — bare `class T`, `struct T`,
// `namespace ns::sub`. These appear as the first line inside MS C/C++'s
// hover code-fence with no header preamble.
const TYPE_DECL_RE = /^\s*(?:class|struct|union|enum|namespace)\s+([A-Za-z_][\w:]*)/m;

/**
 * Pull the namespace hint out of the markdown body. clangd 17+ writes
 * `// In namespace std` (sometimes inside the cpp code-fence, sometimes as
 * a free-standing comment line above it) when the marker line carries an
 * unqualified identifier. Returns the namespace string (e.g. `std`) or
 * undefined when no hint is present.
 */
function extractNamespaceHint(md: string): string | undefined {
    const m = NAMESPACE_HINT_RE.exec(md);
    return m && m[1] ? m[1].trim() : undefined;
}

/**
 * Pull the "type" out of a variable / field hover so that we look up the
 * type's docs page instead of the user's variable name.
 *
 * Two formats handled:
 *
 *   A. Explicit `Type:` line (clangd's modern format):
 *        variable v
 *
 *        Type: std::vector<int>
 *
 *   B. The type appears in the cpp code-fence as part of the declaration
 *      line — we take everything up to the LAST depth-0 whitespace as the
 *      type, treating the trailing token as the variable name:
 *        variable v
 *
 *        ```cpp
 *        std::vector<int> v
 *        ```
 *
 * Returns the type string (raw — `normalizeFqn` strips templates) or
 * undefined if neither format yielded something usable.
 */
function extractVariableType(md: string): string | undefined {
    const explicit = VARIABLE_TYPE_RE.exec(md);
    if (explicit && explicit[1]) return explicit[1].trim();

    const fence = extractFirstCppFence(md);
    if (!fence) return undefined;
    const line = fence
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0];
    if (!line) return undefined;
    return extractTypeFromDecl(line);
}

/**
 * Mirror of `trimToQualifiedName` but scanning LEFT-to-right and returning
 * the prefix up to the last depth-0 whitespace — that's the type, with the
 * trailing variable identifier discarded.
 */
function extractTypeFromDecl(s: string): string | undefined {
    let depth = 0;
    let lastSpace = -1;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<') depth++;
        else if (c === '>') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (c === ' ' || c === '\t')) lastSpace = i;
    }
    if (lastSpace <= 0) return undefined;
    return s.slice(0, lastSpace).trim();
}

/**
 * Strip leading/trailing emphasis (`**`, `*`, backticks, underscores) from
 * an extracted name. clangd 17+ sometimes wraps the identifier in inline
 * markdown emphasis: `function `std::sort``.
 */
function stripEmphasis(name: string): string {
    return name.replace(/^[*`_]+|[*`_]+$/g, '').trim();
}

/**
 * Apply clangd 17+'s "// In namespace XXX" hint to an unqualified name.
 * Caller-provided FQNs that already contain `::` are left alone.
 */
function applyNamespaceHint(name: string, md: string): string {
    if (name.includes('::')) return name;
    const ns = extractNamespaceHint(md);
    return ns ? `${ns}::${name}` : name;
}

/**
 * Parse a clangd-shaped hover into an FQN candidate.
 *
 * Three paths in priority order:
 *   1. `[###] function|method|constructor|destructor|class|... <FQN>`
 *      header (the `###` prefix is optional — clangd 16 emits it, clangd
 *      17+ does not). Most reliable signal; clangd emits it for every
 *      named symbol it recognizes.
 *   2. For `variable` / `field` markers, the type-extraction path takes
 *      over: cppreference indexes types, not user-instance names.
 *   3. The first ` ```cpp ` code-fence: extract the declaration line and
 *      pull out the qualified name immediately before the parameter list.
 *      Used when the marker is missing (some symbol kinds don't get one).
 *
 * In all three paths, when the resulting FQN is unqualified we fall back
 * to the markdown-body `// In namespace XXX` hint (clangd 17+).
 */
export function parseClangdHover(md: string): ParsedHover | undefined {
    if (typeof md !== 'string' || md.length === 0) return undefined;

    const markerMatch = CLANGD_MARKER_RE.exec(md);
    if (markerMatch) {
        const kind = markerMatch[1];
        let name = markerMatch[2]?.trim();
        if (!name) return undefined;

        // clangd writes constructors with the type as the "name" — the FQN of
        // the constructor itself is `T::T` (see gotcha #23). Same shape for
        // destructors though clangd usually emits the `~T` form already.
        const isConstructor = kind === 'constructor';
        const isDestructor = kind === 'destructor';

        // Strip any trailing junk after the qualified name. clangd sometimes
        // appends `<- Foo` style annotations on the same line; we only want
        // the qualified identifier.
        name = name.replace(/\s+(?:->|<-).*$/, '').trim();
        // Strip any markdown emphasis the modern format wraps the name in
        // (e.g. `function `std::sort`` → `std::sort`).
        name = stripEmphasis(name);
        if (!name) return undefined;

        // Variable / field hovers: the marker name is the user's instance
        // (`variable v`); cppreference wants the TYPE. See user report 2.
        if (kind === 'variable' || kind === 'field') {
            const typeName = extractVariableType(md);
            if (typeName) {
                return { fqn: applyNamespaceHint(typeName, md) };
            }
            // No type recovered — fall through to the variable name as a last
            // resort (will likely miss in cppreference, but keeps the chain
            // going so other strategies can take over).
            return { fqn: applyNamespaceHint(name, md) };
        }

        return {
            fqn: applyNamespaceHint(name, md),
            isConstructor,
            isDestructor
        };
    }

    // Fallback: extract from the first ```cpp code-fence.
    const fence = extractFirstCppFence(md);
    if (!fence) return undefined;
    const parsed = parseDeclarationLine(fence);
    if (!parsed) return undefined;
    return { ...parsed, fqn: applyNamespaceHint(parsed.fqn, md) };
}

/**
 * Parse a Microsoft C/C++ extension hover. MS C/C++ uses the same fenced
 * code-block shape as clangd but omits the `### function`-style marker; the
 * fence content is the one signal we have.
 *
 * The namespace-hint fallback is harmless here — MS C/C++ doesn't emit
 * `// In namespace XXX` so the hint extractor will simply miss.
 */
export function parseMsCppHover(md: string): ParsedHover | undefined {
    if (typeof md !== 'string' || md.length === 0) return undefined;

    const fence = extractFirstCppFence(md);
    if (!fence) return undefined;

    // Type declaration: `class std::vector<int>` etc. The whole fence body is
    // a single such line for class/struct/namespace hovers.
    const typeMatch = TYPE_DECL_RE.exec(fence);
    if (typeMatch && typeMatch[1]) {
        return { fqn: applyNamespaceHint(typeMatch[1].trim(), md) };
    }

    // Function declaration: `<rettype> <FQN>(args)`.
    const parsed = parseDeclarationLine(fence);
    if (!parsed) return undefined;
    return { ...parsed, fqn: applyNamespaceHint(parsed.fqn, md) };
}

/**
 * Pull the body of the first ` ```cpp ` (or ` ```c++ `) code-fence out of a
 * markdown string. Falls back to the first untyped fence if no language tag
 * is present.
 */
function extractFirstCppFence(md: string): string | undefined {
    // Prefer typed fences, fall back to bare ```.
    const typed = /```(?:cpp|c\+\+)\s*\n([\s\S]*?)```/i.exec(md);
    if (typed && typed[1]) return typed[1].trim();
    const bare = /```\s*\n([\s\S]*?)```/.exec(md);
    if (bare && bare[1]) return bare[1].trim();
    return undefined;
}

/**
 * Given a declaration line (or block) like `void std::sort(Iter, Iter)`,
 * extract the qualified function name immediately preceding the open-paren.
 * Returns `undefined` if no parenthesized parameter list is present.
 *
 * Expression-specifier skip: clangd / MS C/C++ commonly emit return-type
 * specifiers that look like `name(...)` themselves — `decltype(auto)`,
 * `decltype(*p)`, `noexcept(expr)`, `sizeof(T)`. Without skipping these,
 * the non-greedy regex match picks the FIRST `name(` pair, which is the
 * specifier (not the function name). E.g. `constexpr decltype(auto)
 * apply(F&& f, Tuple&& t)` would resolve to `decltype` instead of
 * `apply`. We scan left-to-right, skipping past any `<specifier>(...)`
 * runs we hit, and stop at the first `name(` where `name` is not an
 * expression specifier.
 */
function parseDeclarationLine(decl: string): ParsedHover | undefined {
    // Take the first non-empty line. clangd's fences sometimes have leading
    // attribute/comment lines; the declaration we care about ends with `(`.
    const lines = decl.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const fqn = pickFunctionNameFromLine(line);
        if (fqn) return { fqn };
    }
    return undefined;
}

/**
 * Walk `line` left-to-right, looking for the first identifier whose
 * immediately-following `(` is the function's argument-list opener.
 * Skips past expression specifiers (`decltype`, `sizeof`, `noexcept`,
 * casts, etc.) — those look like function calls but their parens
 * delimit a TYPE / EXPR operand, not the function-decl arg list.
 *
 * Returns the qualified name (template args still attached) or
 * undefined when no function name can be located.
 */
function pickFunctionNameFromLine(line: string): string | undefined {
    let i = 0;
    while (i < line.length) {
        // Find the next identifier-then-paren occurrence.
        const match = DECL_NAME_RE.exec(line.slice(i));
        if (!match) return undefined;
        const captureStartInSlice = match.index;
        const captureLenInSlice = match[0].length;
        const namePart = match[1]?.trim();
        if (!namePart) {
            // Defensive: advance past this match and keep looking.
            i += captureStartInSlice + Math.max(1, captureLenInSlice);
            continue;
        }
        const fqn = trimToQualifiedName(namePart);
        if (!fqn) {
            i += captureStartInSlice + Math.max(1, captureLenInSlice);
            continue;
        }
        // Reject when the captured name is a bare expression specifier.
        // The unqualified specifier name is what we test (`decltype`, not
        // `std::decltype` — clangd never qualifies these). When `fqn` is
        // already qualified (`std::sort`), the last segment is the
        // function name and the specifier check naturally doesn't apply.
        // We also strip template args from the last segment so
        // `static_cast<int>` matches the bare `static_cast` specifier —
        // template casts (`static_cast<T>(x)`, `dynamic_cast<T>(p)`, ...)
        // are the same problem class as `decltype(auto)` and must be
        // skipped past, not returned as the function name.
        const lastWithTemplate = fqn.split('::').pop() ?? fqn;
        const last = lastWithTemplate.split('<')[0] ?? lastWithTemplate;
        if (isExpressionSpecifier(last)) {
            // Skip past the entire `specifier(...)` group — find the matching
            // close paren so we land cleanly on whatever comes after. Without
            // this advance we'd keep matching the same `decltype(` over and
            // over because the regex resets to the start of the residual.
            const sliceStart = i + captureStartInSlice;
            const parenIdx = line.indexOf('(', sliceStart);
            if (parenIdx === -1) {
                // Defensive: shouldn't happen since the regex required `\s*\(`.
                i = sliceStart + captureLenInSlice;
                continue;
            }
            const closeIdx = findMatchingParen(line, parenIdx);
            i = closeIdx === -1 ? sliceStart + captureLenInSlice : closeIdx + 1;
            continue;
        }
        return fqn;
    }
    return undefined;
}

/**
 * Walk a string from the right and chop off any return-type prefix.
 *   `void std::vector<int>::push_back` → `std::vector<int>::push_back`
 *   `std::pair<int, int> std::map<...>::insert` → `std::map<...>::insert`
 *
 * We respect `<...>` nesting so a space inside template arguments doesn't
 * count as a token boundary. Stop at the first depth-0 whitespace.
 */
function trimToQualifiedName(s: string): string {
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
        const c = s[i];
        if (c === '>') depth++;
        else if (c === '<') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (c === ' ' || c === '\t')) {
            // Strip leading & and * — clangd writes `const T &std::min` where the
            // & is the return-type ref qualifier attached to the function name
            // rather than the type, so the slice after the last depth-0 space can
            // start with & or *.
            return s.slice(i + 1).replace(/^[*&]+/, '').trim();
        }
    }
    return s.replace(/^[*&]+/, '').trim();
}

// ---------------------------------------------------------------------------
// Layer 2: normalization helpers.
// ---------------------------------------------------------------------------

/**
 * Operator name → cppreference URL-suffix table. cppreference's HTML paths
 * sometimes encode operators as `operator_lshift` etc. instead of the
 * literal `operator<<`. The Doxygen-derived qualified names emitted by
 * the indexer preserve the literal form, so the FQN we return through
 * this strategy stays literal too. The map is exported for the URL
 * synthesis path in `cppDocs.openCurrentInBrowser` and reserved for
 * future expansion if the cppreference URL grammar diverges further.
 */
export const OPERATOR_NAME_MAP: Readonly<Record<string, string>> = {};

/**
 * Strip clangd / MS C/C++ "aka"-style alias decorations and any trailing
 * `= <type>` clause from an extracted name. Examples (input → output):
 *
 *   `std::basic_string_view<char> (aka std::string_view)`
 *       → `std::string_view`         (prefer the alias the user wrote)
 *   `std::basic_string_view<char> aka std::string_view`
 *       → `std::string_view`         (older clangd format, no parens)
 *   `std::vector<int> = vec_int`
 *       → `std::vector<int>`          (drop the RHS of an alias clause)
 *   `std::basic_string_view<char> std::string_view`
 *       → `std::string_view`         (bare type-pair; take the alias on
 *                                     the right — matches clangd's print
 *                                     order `<canonical> <alias>`)
 *
 * The point of doing this here, before `stripTemplateArgs`, is so that a
 * `Type:` line lifted out of clangd's variable / type-alias hover doesn't
 * leak through to the index as a space-joined two-FQN string that the
 * indexer can't match.
 *
 * The function is conservative — it never invents identifiers. If the
 * input has no decoration to strip and no internal whitespace at depth
 * 0, it's returned unchanged.
 */
export function sanitizeAliasDecoration(name: string): string {
    if (typeof name !== 'string') return '';
    let s = name.trim();
    // `... (aka X)` — clangd's modern alias hover decoration. Prefer the
    // alias inside the parens because that's the name the user is most
    // likely thinking about.
    const akaParens = /\s*\(\s*aka\s*[: ]\s*([^()]+?)\s*\)\s*$/i.exec(s);
    if (akaParens) {
        const inner = akaParens[1]?.trim();
        if (inner && inner.length > 0) return inner;
    }
    // `... aka X` (no parens — older clangd format).
    const akaPlain = /\baka\s*[: ]\s*(.+)$/i.exec(s);
    if (akaPlain) {
        const rest = akaPlain[1]?.trim();
        if (rest && rest.length > 0) return rest;
    }
    // `<type> = <alias>` — strip the trailing RHS. This shows up on hover
    // strings the parser lifts out of `using X = Y` declarations: with the
    // `=` intact the FQN would be unparseable. Restrict to a literal
    // ` = ` (space-equals-space) at depth 0, so method names that include
    // `=` (operator overloads like `operator=`, `operator+=`, `operator<=>`)
    // are left alone — those never have a space immediately before the `=`.
    const eqIdx = indexOfDepth0Substring(s, ' = ');
    if (eqIdx !== -1) {
        s = s.slice(0, eqIdx).trim();
    }
    // If after all of the above there's still internal whitespace at
    // depth 0 (i.e. the marker / type line concatenated two qualified
    // names — `std::basic_string_view<char> std::string_view`), take the
    // last whitespace-separated token. clangd's `<canonical> <alias>`
    // print order makes the trailing token the user-facing alias name,
    // which is what the index can resolve. We respect `<...>` depth so
    // template arg spaces don't trigger this branch.
    const lastSpace = lastDepth0Space(s);
    if (lastSpace !== -1) {
        s = s.slice(lastSpace + 1).trim();
    }
    return s;
}

/**
 * Index of the first occurrence of `needle` in `s` where every character
 * of the match sits at depth 0 (outside `<...>` / `(...)`). Returns -1
 * when no such occurrence exists. Used to find the ` = ` separator in an
 * alias clause without false-matching on operator names containing `=`.
 */
function indexOfDepth0Substring(s: string, needle: string): number {
    if (needle.length === 0) return -1;
    let angle = 0;
    let paren = 0;
    for (let i = 0; i <= s.length - needle.length; i++) {
        const c = s[i];
        if (c === '<') {
            angle++;
            continue;
        }
        if (c === '>') {
            angle = Math.max(0, angle - 1);
            continue;
        }
        if (c === '(') {
            paren++;
            continue;
        }
        if (c === ')') {
            paren = Math.max(0, paren - 1);
            continue;
        }
        if (angle !== 0 || paren !== 0) continue;
        if (s.startsWith(needle, i)) return i;
    }
    return -1;
}

/**
 * Index of the LAST whitespace character at depth-0 in `s`, or -1 if
 * none. Used by the "concatenated two-FQN" fallback path so we can take
 * the trailing token without breaking template arg lists.
 */
function lastDepth0Space(s: string): number {
    let angle = 0;
    let paren = 0;
    let last = -1;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<') angle++;
        else if (c === '>') angle = Math.max(0, angle - 1);
        else if (c === '(') paren++;
        else if (c === ')') paren = Math.max(0, paren - 1);
        else if (angle === 0 && paren === 0 && (c === ' ' || c === '\t')) {
            last = i;
        }
    }
    return last;
}

/**
 * Constructors are spelled as their type — `Foo` — in clangd's hover. The
 * cppreference URL form is `Foo::Foo`. Apply only when `isConstructor` is
 * set and the input doesn't already include `::`. If the caller already has
 * the qualified form (`std::vector::vector`), pass through.
 */
export function normalizeConstructor(name: string, isConstructor?: boolean): string {
    if (!isConstructor) return name;
    if (name.includes('::')) {
        // Already qualified — does it end with `::`? Then append the type name.
        if (name.endsWith('::')) {
            const parent = name.slice(0, -2);
            const last = parent.split('::').pop() ?? parent;
            return `${parent}::${last}`;
        }
        // Shape like `std::vector` → `std::vector::vector`.
        const last = name.split('::').pop();
        if (!last) return name;
        // If the last segment already matches the second-to-last (i.e. it is
        // `T::T`), leave it alone.
        const segments = name.split('::');
        if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
            return name;
        }
        return `${name}::${last}`;
    }
    // Bare `Foo` → `Foo::Foo`.
    return `${name}::${name}`;
}

/**
 * Destructors come back from clangd as `~Foo`. The cppreference URL form is
 * `Foo::~Foo`. Apply when the input starts with `~` (with optional scope
 * already attached, e.g. `std::list::~list` is left alone).
 */
export function normalizeDestructor(name: string, isDestructor?: boolean): string {
    if (name.startsWith('~') && !name.includes('::')) {
        const type = name.slice(1);
        return `${type}::~${type}`;
    }
    // Hint-driven path: clangd's `### destructor` marker on a bare `Foo`.
    if (isDestructor && !name.includes('~')) {
        return `${name}::~${name.split('::').pop() ?? name}`;
    }
    return name;
}

/**
 * Operators stay literal — see OPERATOR_NAME_MAP comment. This function is
 * a no-op today and is kept as a seam for the M5/M6 URL synthesis pass.
 */
export function normalizeOperator(name: string): string {
    return name;
}

/**
 * Run the full normalization chain in the documented order:
 *   1. stripTemplateArgs (must run first so `Foo<int>` matches the
 *      constructor/destructor heuristics).
 *   2. normalizeConstructor.
 *   3. normalizeDestructor.
 *   4. normalizeOperator (no-op today).
 */
export function normalizeFqn(
    name: string,
    hints?: { isConstructor?: boolean; isDestructor?: boolean }
): string {
    // Run alias decoration stripping FIRST. Decorations like `(aka X)` and
    // trailing `= Y` can themselves contain templates; running `stripTemplateArgs`
    // first would mangle them (`foo<T> (aka bar<U>)` → `foo  (aka bar)`)
    // and the aka-extraction regex would no longer match cleanly.
    let out = sanitizeAliasDecoration(name);
    out = stripTemplateArgs(out);
    // Strip leading & / * that clangd can attach to a name when the symbol is
    // used as a reference (e.g. the marker line yields `&std::min`).
    out = out.replace(/^[*&]+/, '').trim();
    out = stripAbiNamespaces(out);
    out = normalizeConstructor(out, hints?.isConstructor);
    out = normalizeDestructor(out, hints?.isDestructor);
    out = normalizeOperator(out);
    return out;
}

// ---------------------------------------------------------------------------
// Layer 3: the strategy function.
// ---------------------------------------------------------------------------

/**
 * Runtime dependencies for the hover strategy. The `vscode` namespace is
 * injected so the strategy can be exercised from plain-Node unit tests with
 * a stub.
 */
export interface HoverStrategyDeps {
    vscode: typeof vscode;
    /**
     * Marker substring that identifies our own hover content. Hovers whose
     * first block starts with this string are filtered out before parsing
     * (gotcha #10). Default `'**cppreference**'`.
     */
    ownHoverMarker?: string;
}

const DEFAULT_OWN_HOVER_MARKER = '**cppreference**';

/**
 * Compose the hover strategy. Returns a `ResolverStrategy` wired to the
 * supplied `vscode` namespace.
 *
 * Failure mode: any thrown error from `executeHoverProvider`, parse misses,
 * empty hover lists, etc. all collapse to `undefined` (a "miss" — the chain
 * proceeds to the next strategy). We never re-throw.
 */
export function createHoverStrategy(deps: HoverStrategyDeps): ResolverStrategy {
    const { vscode: vs } = deps;
    const marker = deps.ownHoverMarker ?? DEFAULT_OWN_HOVER_MARKER;

    return async function hoverStrategy(
        ctx: ResolveContext
    ): Promise<ResolvedSymbol | undefined> {
        if (ctx.signal.aborted) return undefined;

        let hovers: vscode.Hover[] | undefined;
        try {
            hovers = await raceWithAbort(
                vs.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    ctx.document.uri,
                    ctx.position
                ),
                ctx.signal
            );
        } catch {
            return undefined;
        }

        if (!Array.isArray(hovers) || hovers.length === 0) return undefined;
        if (ctx.signal.aborted) return undefined;

        for (const hover of hovers) {
            if (!hover || !Array.isArray(hover.contents)) continue;
            if (isOwnHover(hover, marker)) continue;

            const md = joinHoverContents(hover.contents);
            if (!md) continue;

            const parsed = parseClangdHover(md) ?? parseMsCppHover(md);
            if (!parsed) continue;

            const fqn = normalizeFqn(parsed.fqn, {
                isConstructor: parsed.isConstructor,
                isDestructor: parsed.isDestructor
            });
            if (!fqn) continue;
            // Expression specifiers like `decltype(arg)` and `sizeof(T)` produce
            // FQNs with `(` that cannot be looked up in the cppreference index.
            // Reject them so the fallback strategy can handle them as keywords.
            if (fqn.includes('(')) continue;

            return { fqn, source: 'hover' };
        }

        return undefined;
    };
}

/**
 * Test whether a hover is one we emitted. The marker is matched against the
 * first content block's textual value.
 */
function isOwnHover(hover: vscode.Hover, marker: string): boolean {
    const first = hover.contents[0];
    if (first === undefined) return false;
    const text = contentToString(first);
    return text.startsWith(marker);
}

/**
 * Concatenate every MarkdownString / MarkedString in a hover's contents
 * array into a single newline-separated markdown string.
 */
function joinHoverContents(
    contents: ReadonlyArray<vscode.MarkdownString | vscode.MarkedString>
): string {
    const parts: string[] = [];
    for (const c of contents) {
        if (c === undefined) continue;
        parts.push(contentToString(c));
    }
    return parts.join('\n\n').trim();
}

/**
 * Coerce a single hover-content entry to its textual representation.
 *
 * `MarkedString` is `string | { language: string; value: string }`;
 * `MarkdownString` is an object with a `value` getter. We accept either.
 */
function contentToString(
    c: vscode.MarkdownString | vscode.MarkedString
): string {
    if (typeof c === 'string') return c;
    if (typeof c === 'object' && c !== null) {
        // MarkdownString has `.value`; the deprecated MarkedString variant has
        // `{ language, value }` — both expose `.value`, so a single check works.
        const v = (c as { value?: unknown }).value;
        if (typeof v === 'string') return v;
    }
    return '';
}
