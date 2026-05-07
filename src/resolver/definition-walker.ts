// Strategy 3 — definition walker.
//
// Per docs/03-symbol-resolution.md § "Strategy 3 — definition walker":
// when neither clangd's symbolInfo (Strategy 1) nor the hover parser
// (Strategy 2) has produced a hit, follow `executeDefinitionProvider`
// to the declaration site, read ~30 lines around it, and parse the
// surrounding `namespace`/`class`/`struct` chain plus the declaration
// line's identifier into a fully-qualified name.
//
// This is best-effort. Templated specializations, `friend`
// declarations, `using` aliases, macro-expanded declarations and
// `extern "C"` blocks all have failure modes that the simple line/brace
// walker can't fully resolve. That's why this is third in the chain
// (per docs/03 pipeline) — Strategy 4 (fallback) catches the residual.
//
// `vscode` is dependency-injected so this module can be unit-tested
// without spinning up the extension host. The pure parser
// (`parseDefinitionContext`) needs no vscode at all.
import type * as vscode from 'vscode';
import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy
} from './types.js';
import { isExpressionSpecifier } from './cpp-keywords.js';
import { stripTemplateArgs } from '../util/fqn.js';
import { findMatchingParen } from '../util/parse-helpers.js';
import { makeAbortError } from '../util/abort.js';

// ---------------------------------------------------------------------------
// Layer 1: pure parser
// ---------------------------------------------------------------------------

/** Inputs to the pure parser. */
export interface DefinitionWalkerInput {
    /** Lines of the target document, in order. */
    lines: string[];
    /** Zero-based line index where the cursor's definition was found. */
    defLine: number;
}

/** Output of the pure parser. */
export interface ParsedDefinition {
    /** Identifier on the definition line (function name, class name, etc.). */
    name: string;
    /** Enclosing scope chain, outermost first: ['std', 'vector']. */
    scopeChain: string[];
    /** Joined: `std::vector::push_back`. */
    fqn: string;
}

/**
 * Walk upward from `defLine` to line 0 collecting enclosing
 * `namespace`/`class`/`struct` scopes via brace counting, then extract
 * the declaration's identifier from `defLine` (joining forward up to
 * 5 lines if the declaration line clearly continues onto subsequent
 * lines). Concatenate scopes + identifier with `::` to produce an FQN.
 *
 * Returns `undefined` when no identifier can be extracted from the
 * definition line, e.g. when the cursor lands on a macro expansion or
 * a `using` alias the walker won't follow.
 */
export function parseDefinitionContext(
    input: DefinitionWalkerInput
): ParsedDefinition | undefined {
    const { lines, defLine } = input;
    if (defLine < 0 || defLine >= lines.length) return undefined;

    // Pull the declaration line, possibly stitching forward a few lines
    // when the line ends in a continuation token (binary operator or
    // comma) — covers the common multi-line return-type / template form.
    const stitched = stitchDeclarationLine(lines, defLine);

    // Identifier extraction. If the declaration line already carries a
    // qualified name (`std::vector<int>::push_back`), the qualifier IS
    // the answer — return it directly with template args stripped and
    // skip the scope walk entirely.
    const qualified = extractQualifiedNameFromLine(stitched);
    if (qualified !== undefined) {
        const cleaned = stripTemplateArgs(qualified);
        if (cleaned.length === 0) return undefined;
        const parts = cleaned.split('::');
        const last = parts[parts.length - 1] ?? '';
        if (last.length === 0) return undefined;
        const scopeChain = parts.slice(0, -1);
        return { name: last, scopeChain, fqn: cleaned };
    }

    const name = extractIdentifierFromLine(stitched);
    if (name === undefined) return undefined;

    const scopeChain = walkEnclosingScopes(lines, defLine);
    const fqn = scopeChain.length > 0 ? `${scopeChain.join('::')}::${name}` : name;
    return { name, scopeChain, fqn };
}

/**
 * Walk up the file from `defLine - 1` collecting enclosing
 * `namespace`/`class`/`struct` scopes. We track brace depth so we only
 * pick up scopes whose `{` is above and whose matching `}` is below
 * `defLine`. Forward declarations (`class X;`), namespace aliases
 * (`namespace X = Y;`) and anonymous namespaces (`namespace { ... }`)
 * are skipped per the algorithm spec.
 *
 * Approach: scan forward from line 0 to `defLine`, maintaining a stack
 * of currently-open named scopes. On every `{` opened on a scope-intro
 * line, push the scope name; on every closing `}` not part of a
 * scope-intro line, pop. The stack at line `defLine` is the answer.
 *
 * This is fundamentally a per-character pass — we strip strings,
 * char literals, and comments first so braces inside them don't
 * mislead us.
 */
function walkEnclosingScopes(lines: string[], defLine: number): string[] {
    // Concatenate all lines up to (but not including) defLine, then scrub.
    const upto = lines.slice(0, defLine).join('\n');
    const scrubbed = scrubStringsAndComments(upto);

    // Per-character scan. Maintain a stack of either a scope name (when
    // a named namespace/class/struct opens) or `null` (when an unnamed
    // brace opens — e.g. function body, anonymous namespace, initializer
    // list). The final stack filtered to non-null gives the scope chain.
    const stack: Array<string | null> = [];

    // Buffer of recent non-brace characters we haven't yet decided about;
    // when we hit a `{` we look back at this buffer to decide the kind
    // of scope. When we hit `;` we discard the buffer (forward decl /
    // statement). When we hit `}` we just pop.
    let buffer = '';

    for (let i = 0; i < scrubbed.length; i++) {
        const ch = scrubbed[i];
        if (ch === undefined) continue;
        if (ch === '{') {
            const scope = classifyOpenBrace(buffer);
            stack.push(scope);
            buffer = '';
            continue;
        }
        if (ch === '}') {
            stack.pop();
            buffer = '';
            continue;
        }
        if (ch === ';') {
            // A statement-terminating semicolon clears the lookahead buffer
            // — anything we'd built up was a forward decl, function-pointer
            // typedef, alias, etc., none of which open a scope.
            buffer = '';
            continue;
        }
        buffer += ch;
    }

    return stack.filter((s): s is string => s !== null);
}

/**
 * Given the textual prefix immediately before a `{`, decide what kind
 * of scope it opens.
 *
 * Returns:
 *  - the scope name if it's a named `namespace`/`class`/`struct`
 *  - `null` for any other brace (function body, anon namespace,
 *    initializer list, lambda, etc.)
 *
 * Class base lists (`class Derived : public Base`) are handled by
 * trimming everything from the first colon onward when we look for the
 * identifier.
 */
function classifyOpenBrace(prefix: string): string | null {
    // Take only the trailing run after the last `;` or `}` we already
    // consumed (we consumed those, so the caller's buffer is already
    // post-trim — but we also need to handle in-line cases where the
    // buffer carries the entire intro of a class definition).
    const trimmed = prefix.trim();
    if (trimmed.length === 0) return null;

    // Drop any base-spec list: `class Derived : public Base` — we want
    // `class Derived`.
    const beforeColon = trimmed.split(/[:]/, 1)[0] ?? trimmed;
    const tokens = beforeColon.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return null;

    // Last token is the candidate identifier; previous tokens carry the
    // keyword. We scan backwards for `namespace` / `class` / `struct`
    // because templated class intros put `template<...>` before the
    // keyword, and `final` may appear after the name.
    //
    // Strip a trailing `final` qualifier (C++11) from the tokens.
    const filtered = tokens[tokens.length - 1] === 'final'
        ? tokens.slice(0, -1)
        : tokens;
    if (filtered.length === 0) return null;

    // Find the LAST occurrence of namespace/class/struct so that
    // `template<...> class Foo` works; the keyword precedes the name.
    let kwIndex = -1;
    for (let i = filtered.length - 1; i >= 0; i--) {
        const tok = filtered[i];
        if (tok === 'namespace' || tok === 'class' || tok === 'struct') {
            kwIndex = i;
            break;
        }
    }
    if (kwIndex === -1) return null;

    const keyword = filtered[kwIndex];
    // Identifier is the first token AFTER the keyword that — once
    // template args are stripped — looks like a bare identifier.
    // Explicit specialization heads (`template<> class Foo<int>`) leave
    // the `<int>` attached; we strip first, then test.
    let candidate: string | undefined;
    for (const tok of filtered.slice(kwIndex + 1)) {
        const stripped = stripTemplateArgs(tok);
        if (/^[A-Za-z_][\w]*$/.test(stripped)) {
            candidate = stripped;
            break;
        }
    }
    if (candidate === undefined) {
        // `namespace { ... }` — anonymous namespace. Per spec: skip (not
        // a scope for our purposes).
        if (keyword === 'namespace') return null;
        // `class { ... }` / `struct { ... }` — anonymous; nothing useful
        // to add to the chain.
        return null;
    }

    // `namespace X = Y;` is handled by the `;` path in the caller — we
    // never see `=` here because the brace-classifier only fires on `{`.
    return candidate;
}

/**
 * Stitch the declaration line onto up to 5 successor lines if it ends
 * with a continuation token (binary operator or `,`). This handles the
 * common shape:
 *
 *   void                            // line N
 *   std::vector<int>::push_back(    // line N+1   ← defLine
 *     const int& v
 *   ) { ... }                       // line N+3
 *
 * We always include `defLine` itself; the stitch only matters when the
 * caller picked an upstream line as the def line.
 */
function stitchDeclarationLine(lines: string[], defLine: number): string {
    let acc = lines[defLine] ?? '';
    let cur = defLine;
    while (
        cur < lines.length - 1 &&
        cur - defLine < 5 &&
        isContinuationLine(acc)
    ) {
        cur++;
        acc += ' ' + (lines[cur] ?? '');
    }
    return acc;
}

/**
 * A line is a "continuation" — i.e. the declaration almost certainly
 * extends to the next line — if either:
 *
 *  1. its trailing non-comment, non-whitespace character is a binary
 *     operator, `,`, `(`, `<`, `:`, or backslash continuation, OR
 *  2. it is a "naked declaration prefix" — contains no `(`, `;`, `{`,
 *     or `}`, and isn't just whitespace. The classic shape is a return
 *     type on its own line (`void` followed by `sort(...)` on the next).
 *
 * Conservative — false positives just pull in one more line of
 * context, which is harmless because the parser only inspects the
 * first identifier-before-`(` it finds.
 */
function isContinuationLine(line: string): boolean {
    const cleaned = line.replace(/\/\/.*$/, '').trimEnd();
    if (cleaned.length === 0) return true; // empty / whitespace continues
    const last = cleaned[cleaned.length - 1] ?? '';
    if (
        last === ',' ||
        last === '(' ||
        last === '<' ||
        last === ':' ||
        last === '&' ||
        last === '*' ||
        last === '+' ||
        last === '-' ||
        last === '|' ||
        last === '=' ||
        last === '\\'
    ) {
        return true;
    }
    // "Naked declaration prefix" — a return-type-only line like `void`.
    if (!/[(){};]/.test(cleaned)) return true;
    return false;
}

/**
 * If the declaration line carries a qualified name like
 * `void std::vector<int>::push_back(...)` or
 * `class std::vector<int>::iterator`, return the qualified portion
 * (`std::vector<int>::push_back`). Returns `undefined` otherwise so
 * the caller falls back to bare-identifier extraction.
 *
 * We look for the first run of identifier/template/`::` characters
 * that contains at least one `::` and is followed by `(` (function /
 * method definition) — that's the safest heuristic. For class /
 * struct out-of-line declarations the unqualified path is enough; we
 * don't try to handle `class T::U {` here (rare, and it would conflict
 * with the brace-walker's scope tracking).
 */
function extractQualifiedNameFromLine(line: string): string | undefined {
    // Strip line/block comments embedded in the line, then mask out any
    // `<specifier>(...)` runs (decltype, sizeof, noexcept, the four
    // *_cast operators, ...). Masking keeps offsets stable for the
    // qualified-name scan below; without it, a qualified name inside a
    // specifier's paren group — e.g. `std::forward<T>(t)` inside
    // `decltype(std::forward<T>(t))` — wins the scan over the real
    // function name later on the line.
    const cleaned = maskExpressionSpecifiers(
        line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '')
    );

    // Walk character by character and collect runs of qualified-name
    // characters (letters, digits, `_`, `:`, `<`, `>`, spaces inside
    // template args). We track template depth so spaces inside `<>` are
    // permitted. The run terminates at a `(` — and we only return it if
    // it carries `::`.
    let i = 0;
    while (i < cleaned.length) {
        // Skip until we see an identifier-start character.
        const ch = cleaned[i];
        if (ch === undefined) break;
        if (!/[A-Za-z_]/.test(ch)) {
            i++;
            continue;
        }
        // Begin run.
        let run = '';
        let depth = 0;
        let j = i;
        while (j < cleaned.length) {
            const c = cleaned[j];
            if (c === undefined) break;
            if (c === '<') {
                depth++;
                run += c;
                j++;
                continue;
            }
            if (c === '>') {
                if (depth > 0) depth--;
                run += c;
                j++;
                continue;
            }
            if (depth > 0) {
                run += c;
                j++;
                continue;
            }
            if (/[A-Za-z0-9_:]/.test(c)) {
                run += c;
                j++;
                continue;
            }
            break;
        }
        // Now `j` points at the first char after the run. The run is a
        // qualified-name candidate iff it contains `::` AND the next
        // non-space char is `(` (a function call / definition).
        if (run.includes('::')) {
            let k = j;
            while (k < cleaned.length && cleaned[k] === ' ') k++;
            if (cleaned[k] === '(') {
                return run;
            }
        }
        i = Math.max(j, i + 1);
    }
    return undefined;
}

/**
 * Extract the unqualified identifier from a declaration line. Handles:
 *
 *   - Function decl:    `void push_back(const T& value);`        → `push_back`
 *   - Class decl:       `class vector { ... };`                  → `vector`
 *   - Struct decl:      `struct Point { ... };`                  → `Point`
 *   - Templated class:  `template<class T> class vector { ... };` → `vector`
 *   - Class with base:  `class Derived : public Base { ... };`   → `Derived`
 *   - Method param-list across lines: caller has already stitched.
 *
 * Returns `undefined` if it can't pick out a plausible identifier.
 */
function extractIdentifierFromLine(line: string): string | undefined {
    // Same masking as `extractQualifiedNameFromLine` above — blank out
    // `<specifier>(...)` runs so they can't hijack the function-name
    // scan. The check inside the loop is now redundant for masked
    // specifiers (their `(` has been overwritten with a space) but we
    // keep it as defense-in-depth for unusual cases where the masking
    // failed (mismatched parens, etc.).
    const cleaned = maskExpressionSpecifiers(
        line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '')
    );

    // class / struct head — strip a base-spec list and any trailing
    // `final` qualifier, then pull the first identifier after the
    // keyword.
    const classHead = /\b(class|struct)\b\s+([A-Za-z_]\w*)/.exec(cleaned);
    if (classHead !== null) {
        return classHead[2];
    }

    // Function-shaped: identifier directly preceding `(`. Walk through
    // every `(` left-to-right, skipping any whose preceding identifier
    // is a known expression specifier (`decltype`, `sizeof`, ...). This
    // is the same bug-fix as `pickFunctionNameFromLine` in
    // `hover-parser.ts`: a return-type specifier like `decltype(auto)`
    // would otherwise hijack the match because it precedes the actual
    // function name on the line.
    let searchFrom = 0;
    while (searchFrom < cleaned.length) {
        const parenIdx = cleaned.indexOf('(', searchFrom);
        if (parenIdx <= 0) break;
        // Skip whitespace immediately before `(`.
        let end = parenIdx - 1;
        while (end >= 0 && /\s/.test(cleaned[end] ?? '')) end--;
        if (end < 0) return undefined;
        let start = end;
        while (start > 0 && /[A-Za-z0-9_]/.test(cleaned[start - 1] ?? '')) {
            start--;
        }
        const candidate = cleaned.slice(start, end + 1);
        if (/^[A-Za-z_]\w*$/.test(candidate)) {
            // Strip template args before the specifier test so the templated
            // cast operators (`static_cast<T>`, `dynamic_cast<T>`, ...) are
            // recognized. The candidate variable holds the bare identifier
            // ending just before `(`, but the surface call site might be
            // `static_cast<int>(x)`. The `<int>` portion is whitespace-skipped
            // earlier in this loop so it never lands in `candidate`, but
            // belt-and-braces: strip anything past a `<` too.
            const bare = candidate.split('<')[0] ?? candidate;
            if (isExpressionSpecifier(bare)) {
                // Skip past the entire `specifier(...)` group and keep looking
                // for the real function-name paren. findMatchingParen handles
                // nested template-argument parens correctly so e.g.
                // `decltype(std::forward<T>(t))` lands cleanly on its closer.
                const closeIdx = findMatchingParen(cleaned, parenIdx);
                searchFrom = closeIdx === -1 ? parenIdx + 1 : closeIdx + 1;
                continue;
            }
            return candidate;
        }
        // No identifier preceded this `(` (e.g. cast operator). Advance
        // past it and keep scanning.
        searchFrom = parenIdx + 1;
    }

    return undefined;
}

/**
 * Replace each `<expr-specifier>(...)` run in `s` with spaces, leaving
 * offsets intact. Handles both bare specifiers (`decltype(auto)`,
 * `sizeof(T)`, `noexcept(expr)`) and template-cast forms
 * (`static_cast<T>(x)`, `dynamic_cast<T>(p)`, ...). The masking is
 * what lets the qualified-name / identifier scans treat the rest of
 * the line as if the specifier group wasn't there — without this, a
 * qualified name embedded INSIDE a specifier's paren-arg (e.g.
 * `std::forward<T>(t)` inside `decltype(std::forward<T>(t))`) wins
 * the scan over the real function name appearing later on the line.
 *
 * Exported for tests; pure (no vscode / no I/O).
 */
export function maskExpressionSpecifiers(s: string): string {
    // We can't import EXPRESSION_SPECIFIERS at module load time without
    // creating a circular reference (cpp-keywords ← definition-walker
    // would also be valid if we did, but the indirection through
    // `isExpressionSpecifier` keeps the seam testable). Inline a small
    // regex that covers the names we care about. Sourced from
    // `cpp-keywords.ts`'s EXPRESSION_SPECIFIERS set; kept in sync by
    // convention — the cpp-keywords tests verify the canonical list,
    // and any addition there should mirror here.
    const SPECIFIER_RE =
        /\b(?:decltype|sizeof|alignof|typeid|noexcept|static_cast|dynamic_cast|const_cast|reinterpret_cast|static_assert|__decltype|__typeof__?|__alignof__?)(?:\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/g;
    let out = s;
    let m: RegExpExecArray | null;
    // We have to re-run the regex from the start each time we mask
    // because the mask changes the string and could affect subsequent
    // match indexes. Cap iterations defensively so we can never loop
    // forever on pathological input.
    for (let pass = 0; pass < 32; pass++) {
        SPECIFIER_RE.lastIndex = 0;
        m = SPECIFIER_RE.exec(out);
        if (!m) break;
        const matchStart = m.index;
        const parenIdx = matchStart + m[0].length - 1;
        const closeIdx = findMatchingParen(out, parenIdx);
        if (closeIdx === -1) break; // unbalanced; bail
        out =
            out.slice(0, matchStart) +
            ' '.repeat(closeIdx + 1 - matchStart) +
            out.slice(closeIdx + 1);
    }
    return out;
}

/**
 * Strip strings, char literals, and `//` / `/* *\/` comments so the
 * scope walker doesn't see braces or semicolons inside them. We
 * preserve newlines so line numbers are stable for downstream
 * diagnostics if any are added later.
 */
function scrubStringsAndComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const ch = src[i];
        if (ch === undefined) break;
        const next = src[i + 1];
        // Line comment.
        if (ch === '/' && next === '/') {
            i += 2;
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        // Block comment.
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') out += '\n';
                i++;
            }
            i += 2;
            continue;
        }
        // String literal — supports escapes and raw strings (`R"(...)"`).
        if (ch === '"') {
            // Raw-string detection: previous char is `R`.
            const prev = out[out.length - 1];
            if (prev === 'R') {
                // Drop the trailing `R` we already wrote and consume the raw
                // string up to the matching `)delim"`.
                out = out.slice(0, -1);
                i++; // skip opening `"`
                let delim = '';
                while (i < n && src[i] !== '(') {
                    delim += src[i];
                    i++;
                }
                if (src[i] === '(') i++;
                const closer = ')' + delim + '"';
                const closeIdx = src.indexOf(closer, i);
                if (closeIdx === -1) {
                    // Unterminated; bail out to end of input.
                    while (i < n) {
                        if (src[i] === '\n') out += '\n';
                        i++;
                    }
                    continue;
                }
                // Preserve newlines inside the raw string for line-number
                // stability.
                for (let k = i; k < closeIdx; k++) {
                    if (src[k] === '\n') out += '\n';
                }
                i = closeIdx + closer.length;
                continue;
            }
            // Regular string literal.
            i++; // opening "
            while (i < n && src[i] !== '"') {
                if (src[i] === '\\' && i + 1 < n) {
                    if (src[i + 1] === '\n') out += '\n';
                    i += 2;
                    continue;
                }
                if (src[i] === '\n') out += '\n';
                i++;
            }
            if (i < n) i++; // closing "
            continue;
        }
        // Char literal.
        if (ch === "'") {
            i++;
            while (i < n && src[i] !== "'") {
                if (src[i] === '\\' && i + 1 < n) {
                    i += 2;
                    continue;
                }
                i++;
            }
            if (i < n) i++;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Layer 2: the strategy function
// ---------------------------------------------------------------------------

export interface DefinitionStrategyDeps {
    /**
     * Inject vscode for tests; in production, pass
     * `import * as vscode from 'vscode'`.
     */
    vscode: typeof vscode;
}

/**
 * Build a resolver strategy bound to the given vscode runtime.
 *
 * The returned strategy:
 *   1. asks `vscode.executeDefinitionProvider` for the cursor's def site
 *   2. opens the target document (silent miss on failure)
 *   3. reads up to 30 lines around the target range (15 above, 15
 *      below; clamped at file edges)
 *   4. invokes `parseDefinitionContext` on the slice
 *   5. honors `ctx.signal` — throws `AbortError` if aborted, returning
 *      `undefined` on any other failure
 */
export function createDefinitionStrategy(
    deps: DefinitionStrategyDeps
): ResolverStrategy {
    const vscodeApi = deps.vscode;

    return async function definitionStrategy(
        ctx: ResolveContext
    ): Promise<ResolvedSymbol | undefined> {
        if (ctx.signal.aborted) throw makeAbortError();

        let defs: Array<vscode.Location | vscode.LocationLink> | undefined;
        try {
            defs = await vscodeApi.commands.executeCommand<
                Array<vscode.Location | vscode.LocationLink>
            >('vscode.executeDefinitionProvider', ctx.document.uri, ctx.position);
        } catch {
            return undefined;
        }
        if (ctx.signal.aborted) throw makeAbortError();
        if (!Array.isArray(defs) || defs.length === 0) return undefined;

        const first = defs[0];
        if (first === undefined) return undefined;

        const targetUri = isLocationLink(first) ? first.targetUri : first.uri;
        const targetRange = isLocationLink(first)
            ? (first.targetSelectionRange ?? first.targetRange)
            : first.range;
        const targetLine = targetRange.start.line;

        let doc: vscode.TextDocument;
        try {
            doc = await vscodeApi.workspace.openTextDocument(targetUri);
        } catch {
            return undefined;
        }
        if (ctx.signal.aborted) throw makeAbortError();

        // Pull a 30-line window: 15 above, 15 below the def line. Clamp
        // at file edges. The windowed slice is what we pass to the parser;
        // the def line's index *within the slice* is what matters.
        const above = 15;
        const below = 15;
        const start = Math.max(0, targetLine - above);
        const end = Math.min(doc.lineCount - 1, targetLine + below);
        const lines: string[] = [];
        for (let i = start; i <= end; i++) {
            lines.push(doc.lineAt(i).text);
        }
        const defLineInSlice = targetLine - start;

        const parsed = parseDefinitionContext({ lines, defLine: defLineInSlice });
        if (parsed === undefined) return undefined;
        if (parsed.fqn.length === 0) return undefined;

        return { fqn: parsed.fqn, source: 'definition' };
    };
}

function isLocationLink(
    loc: vscode.Location | vscode.LocationLink
): loc is vscode.LocationLink {
    return (
        typeof (loc as vscode.LocationLink).targetUri !== 'undefined' &&
        typeof (loc as vscode.LocationLink).targetRange !== 'undefined'
    );
}

