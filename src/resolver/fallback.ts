// Strategy 4 — word + namespace heuristic.
//
// Per docs/03-symbol-resolution.md § "Strategy 4 — word + namespace
// heuristic" and § "Disambiguation": this is the "no language server"
// path. It MUST NOT depend on clangd or the Microsoft C/C++ extension.
// The only external runtime dependencies are `vscode` (for word-range
// extraction at the cursor) and the aggregate `IndexDB` (for the
// disambiguation lookup).
//
// Approach:
//   1. extract the bare identifier under the cursor
//   2. walk the document upward from the cursor, tracking
//      `namespace X { ... }` (and `class`/`struct`) braces to derive the
//      enclosing-scope chain, plus collecting `using namespace X;`
//      directives that apply at the cursor
//   3. build candidate FQNs: innermost enclosing scope first, then
//      outer, then `using` aliases, then the bare word
//   4. try `lookupExact` against each candidate in order — first hit
//      wins (this matches the user's mental model where the innermost
//      scope shadows outer ones)
//   5. fall back to `lookupByUnqualified(name, scopes ∪ usings)` —
//      the safety-net per docs §Disambiguation: in follow mode "silently
//      pick the top result"
//
// Brace-depth tracking is a deliberate independent re-implementation of
// the same logic in `definition-walker.ts` (M4.3). M4.6 will DRY them
// once both have landed and we can see the shared shape.
import type * as vscode from 'vscode';
import type { IndexDB } from '../docset/index.js';
import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy
} from './types.js';
import { KEYWORDS_TO_SKIP, DEFAULT_WORD_PATTERN } from './cpp-keywords.js';
import { makeAbortError } from '../util/abort.js';

/**
 * Pure helpers — testable without a vscode shim or an IndexDB.
 */

export interface ScopeWalkInput {
    /** Document lines, ordered. The walker stops at `cursorLine`. */
    lines: string[];
    /** Zero-based cursor line. Lines after this are ignored. */
    cursorLine: number;
}

export interface ScopeWalkResult {
    /**
     * Enclosing namespace/class/struct chain at the cursor, outermost
     * first. For `namespace std { namespace detail { ...cursor... } }`
     * the result is `['std', 'detail']`.
     */
    enclosingScopes: string[];
    /**
     * Imported namespaces from `using namespace X;` directives that
     * appear textually above the cursor. `using namespace X::Y;` is
     * stored as the literal `'X::Y'` — `buildFqnCandidates` consumes
     * each entry as a single qualifier prefix.
     */
    usingNamespaces: string[];
}

/**
 * A scope-stack entry. `openDepth` is the brace depth *at which the
 * scope was opened* — i.e. the depth before incrementing for the
 * `{`. Closing braces pop entries whose `openDepth` matches the
 * current pre-decrement depth - 1.
 */
interface ScopeStackEntry {
    /** Scope name; undefined for anonymous/sentinel scopes that don't appear in output. */
    name: string | undefined;
    openDepth: number;
}

// KEYWORDS_TO_SKIP is imported from `./cpp-keywords.js`. The shared
// module is the source of truth so the keyword strategy and the
// fallback's keyword-rescue path can never drift out of sync.

/**
 * Strip line/block comments and string/char literals from a single
 * line of source, replacing each character with a space. Preserves
 * column offsets so callers that index by column stay aligned. We don't
 * attempt to span multi-line block comments — `walkScopes` calls this
 * line-by-line and a stray `{` or `}` *inside* a multi-line comment
 * will throw the brace counter off. That's acceptable for a heuristic
 * fallback; the strategies higher in the chain will already have won
 * for code where this matters.
 */
function stripCommentsAndStrings(line: string): string {
    let out = '';
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];
        if (ch === '/' && next === '/') {
            // Rest of the line is comment; replace with spaces.
            out += ' '.repeat(line.length - i);
            break;
        }
        if (ch === '/' && next === '*') {
            // Block comment — find end on this line, else replace through EOL.
            const end = line.indexOf('*/', i + 2);
            if (end === -1) {
                out += ' '.repeat(line.length - i);
                break;
            }
            out += ' '.repeat(end + 2 - i);
            i = end + 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            // String/char literal — find unescaped closer, else replace through EOL.
            const quote = ch;
            out += ' ';
            i++;
            while (i < line.length) {
                const c = line[i];
                if (c === '\\' && i + 1 < line.length) {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (c === quote) {
                    out += ' ';
                    i++;
                    break;
                }
                out += ' ';
                i++;
            }
            continue;
        }
        out += ch ?? '';
        i++;
    }
    return out;
}

/**
 * Walk source lines from the top of the document down to (and
 * including) `cursorLine`, maintaining a brace-depth counter and a
 * scope stack. Returns the enclosing scopes that bracket the cursor
 * and the `using namespace` directives in scope at the cursor.
 *
 * Scope-opening shapes recognized (per the Strategy-4 brief):
 *   - `namespace X {`         — push X
 *   - `namespace X::Y {`      — push X then Y (nested form on one line)
 *   - `namespace X = Y;`      — alias, no scope opened
 *   - `namespace {`           — anonymous, push a sentinel that doesn't
 *                                appear in output but tracks depth so
 *                                the brace counter stays balanced
 *   - `class X { ... }` / `struct X { ... }` — push X (member functions
 *     defined inline are scoped under the class)
 *
 * Forward declarations (`class X;`) and member-pointer / variable
 * declarations of class type don't open a scope and are skipped.
 *
 * `using namespace X::Y;` lines above the cursor add `'X::Y'` to the
 * `usingNamespaces` output — the literal qualifier, not a split path.
 */
export function walkScopes(input: ScopeWalkInput): ScopeWalkResult {
    const stack: ScopeStackEntry[] = [];
    const usingNamespaces: string[] = [];
    let depth = 0;
    const last = Math.min(input.cursorLine, input.lines.length - 1);

    // Patterns that match anywhere on a stripped line. We re-run them
    // until the line is consumed, because one source line can legally
    // contain multiple scope-opening forms (`namespace a { namespace b {`).
    // Token shape: `[A-Za-z_]\w*` mirrors the cursor word pattern.
    const namespaceOpenRe = /\bnamespace\s+([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*\{/;
    const namespaceAliasRe = /\bnamespace\s+([A-Za-z_]\w*)\s*=\s*[^;]+;/;
    const namespaceAnonRe = /\bnamespace\s*\{/;
    const classOpenRe = /\b(?:class|struct)\s+(?:[A-Za-z_]\w*\s+)?([A-Za-z_]\w*)(?:\s*final)?(?:\s*:[^{;]*)?\s*\{/;
    const usingNsRe = /\busing\s+namespace\s+([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*;/g;
    // Hoisted: reuse a single RegExp instance across all lines; reset
    // lastIndex at the top of each iteration so exec() scans from the start.
    const usingNsReG = new RegExp(usingNsRe.source, 'g');

    for (let lineIdx = 0; lineIdx <= last; lineIdx++) {
        const raw = input.lines[lineIdx] ?? '';
        let line = stripCommentsAndStrings(raw);

        // `using namespace X;` (above cursor only — `lineIdx <= last`
        // already enforces that since we stop at cursorLine; the directive
        // applies to the rest of the enclosing scope).
        {
            usingNsReG.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = usingNsReG.exec(line)) !== null) {
                const qualifier = (m[1] ?? '').replace(/\s+/g, '');
                if (qualifier.length > 0) usingNamespaces.push(qualifier);
            }
        }

        // Walk left-to-right, advancing through scope-opens and `{` / `}`
        // tokens in source order. We re-run the regexes against the
        // remaining tail each iteration because matches can overlap on a
        // single line.
        while (line.length > 0) {
            const aliasMatch = namespaceAliasRe.exec(line);
            const nsMatch = namespaceOpenRe.exec(line);
            const anonMatch = namespaceAnonRe.exec(line);
            const classMatch = classOpenRe.exec(line);
            const openIdx = line.indexOf('{');
            const closeIdx = line.indexOf('}');

            // Pick the earliest-occurring event. Ties: prefer scope-opening
            // events over plain braces so we attach the name to the brace.
            const candidates: Array<{
                kind: 'alias' | 'ns' | 'anon' | 'class' | 'open' | 'close';
                idx: number;
                end: number;
                match?: RegExpExecArray;
            }> = [];
            if (aliasMatch) {
                candidates.push({
                    kind: 'alias',
                    idx: aliasMatch.index,
                    end: aliasMatch.index + aliasMatch[0].length,
                    match: aliasMatch
                });
            }
            if (nsMatch) {
                candidates.push({
                    kind: 'ns',
                    idx: nsMatch.index,
                    end: nsMatch.index + nsMatch[0].length,
                    match: nsMatch
                });
            }
            if (anonMatch) {
                candidates.push({
                    kind: 'anon',
                    idx: anonMatch.index,
                    end: anonMatch.index + anonMatch[0].length,
                    match: anonMatch
                });
            }
            if (classMatch) {
                candidates.push({
                    kind: 'class',
                    idx: classMatch.index,
                    end: classMatch.index + classMatch[0].length,
                    match: classMatch
                });
            }
            if (openIdx !== -1) {
                candidates.push({ kind: 'open', idx: openIdx, end: openIdx + 1 });
            }
            if (closeIdx !== -1) {
                candidates.push({ kind: 'close', idx: closeIdx, end: closeIdx + 1 });
            }

            if (candidates.length === 0) break;

            // Earliest first; on tie, the named-scope kinds beat raw-brace
            // kinds (so a `namespace X {` is consumed as one event, not as
            // a name followed by a stray `{`).
            const priority: Record<typeof candidates[number]['kind'], number> = {
                alias: 0,
                ns: 1,
                anon: 1,
                class: 1,
                open: 2,
                close: 2
            };
            candidates.sort((a, b) => a.idx - b.idx || priority[a.kind] - priority[b.kind]);
            const ev = candidates[0];
            if (!ev) break;

            switch (ev.kind) {
                case 'alias':
                    // No scope change; advance past the entire `namespace X = Y;`.
                    break;
                case 'ns': {
                    const qualified = (ev.match?.[1] ?? '').replace(/\s+/g, '');
                    const parts = qualified.split('::').filter((p) => p.length > 0);
                    for (const part of parts) {
                        stack.push({ name: part, openDepth: depth });
                        depth++;
                    }
                    break;
                }
                case 'anon':
                    // Anonymous namespace contributes no name to the chain but
                    // does open a brace pair; push a sentinel so the close-brace
                    // pop arithmetic stays correct.
                    stack.push({ name: undefined, openDepth: depth });
                    depth++;
                    break;
                case 'class': {
                    const name = ev.match?.[1] ?? '';
                    if (name.length > 0) {
                        stack.push({ name, openDepth: depth });
                        depth++;
                    } else {
                        depth++;
                    }
                    break;
                }
                case 'open':
                    depth++;
                    break;
                case 'close': {
                    // Pop any scope whose openDepth equals depth-1 (i.e. the
                    // scope opened at the depth we're closing into).
                    if (depth > 0) depth--;
                    while (stack.length > 0) {
                        const top = stack[stack.length - 1];
                        if (!top) break;
                        if (top.openDepth === depth) stack.pop();
                        else break;
                    }
                    break;
                }
            }

            line = line.slice(ev.end);
        }
    }

    const enclosingScopes = stack
        .map((s) => s.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);

    return { enclosingScopes, usingNamespaces };
}

/**
 * Given a bare identifier and the walked scope, build candidate fully-
 * qualified names in priority order:
 *
 *   1. innermost enclosing scope first: `std::detail::sort`
 *   2. each outer enclosing scope: `std::sort`
 *   3. each `using namespace` qualifier: `std::ranges::sort`
 *   4. the bare word: `sort`
 *
 * The list is deduplicated while preserving first-occurrence order, so
 * identical paths produced by overlapping enclosing/using sources don't
 * trigger duplicate index lookups.
 */
export function buildFqnCandidates(
    word: string,
    scope: ScopeWalkResult
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (s: string): void => {
        if (s.length === 0) return;
        if (seen.has(s)) return;
        seen.add(s);
        out.push(s);
    };

    // Innermost enclosing scope first. For `['std', 'detail']` we want
    // `std::detail::word` before `std::sort` — i.e. start from the full
    // chain and shrink toward the outermost.
    for (let i = scope.enclosingScopes.length; i > 0; i--) {
        const prefix = scope.enclosingScopes.slice(0, i).join('::');
        push(`${prefix}::${word}`);
    }

    // `using namespace X;` aliases.
    for (const ns of scope.usingNamespaces) {
        push(`${ns}::${word}`);
    }

    // Bare word last. The Strategy-4 trailer `lookupByUnqualified(word, …)`
    // (run after every candidate misses on `lookupExact`) is what picks
    // up bare-identifier stdlib lookups like `isdigit` → `std::isdigit`
    // — see the M-4 fix in `IndexDB.lookupByUnqualified`.
    push(word);

    return out;
}

/**
 * Dependencies for `createFallbackStrategy`. `vscode` is injected so
 * the strategy can be unit-tested against a structural shim; `index`
 * is the aggregate `IndexDB` used for disambiguation. Only the two
 * lookup methods this strategy actually calls are required — narrowed
 * via `Pick<>` so test mocks can satisfy the contract minimally.
 */
export interface FallbackStrategyDeps {
    vscode: typeof vscode;
    index: Pick<IndexDB, 'lookupByUnqualified' | 'lookupExact'>;
    /**
     * Word pattern. Defaults to `[A-Za-z_]\w` (one or more) per
     * docs §Strategy 4 — matching identifier characters only, the
     * shape passed to `getWordRangeAtPosition`.
     */
    wordPattern?: RegExp;
}

/**
 * Build the Strategy-4 resolver bound to a vscode runtime and an
 * aggregate index.
 *
 * The returned strategy:
 *   1. extracts the word under the cursor; misses if there's no range
 *   2. C++ keywords: checked against the index first (Keyword-kind entries
 *      like `template`, `explicit`, `requires` resolve to their pages);
 *      keywords with no Keyword-kind index entry return undefined early
 *   3. reads the document line-by-line up through the cursor line
 *   4. walks scopes via `walkScopes`
 *   5. builds FQN candidates via `buildFqnCandidates`
 *   6. tries each candidate against `lookupExact`; first hit wins
 *   7. falls back to `lookupByUnqualified(word, scopes ∪ usings)` —
 *      the disambiguation lookup per docs §Disambiguation
 *   8. honors `ctx.signal`: throws `AbortError` on entry if already
 *      aborted; `lookupExact` / `lookupByUnqualified` are synchronous
 *      so there's no mid-flight abort to plumb past those calls
 */
export function createFallbackStrategy(
    deps: FallbackStrategyDeps
): ResolverStrategy {
    const wordPattern = deps.wordPattern ?? DEFAULT_WORD_PATTERN;
    const index = deps.index;

    return async function fallbackStrategy(
        ctx: ResolveContext
    ): Promise<ResolvedSymbol | undefined> {
        if (ctx.signal.aborted) throw makeAbortError();

        const range = ctx.document.getWordRangeAtPosition(ctx.position, wordPattern);
        if (!range) return undefined;
        const word = ctx.document.getText(range);
        if (word.length === 0) return undefined;

        // Detect member access immediately before the word range. The fallback
        // sees these cursor positions when clangd is absent / failed (e.g.
        // `vec.data()`, `TStr::data()`, `ptr->next`): without type info we
        // can't resolve them, but the prior behavior was to fall through to
        // `lookupByUnqualified(word, …)` which happily matched a same-named
        // free function (`data` → `std::data`). That false positive is worse
        // than no result. The guard below short-circuits to undefined for
        // `.` / `->` access, and (for `::` access) restricts candidates to
        // `<receiver>::<word>` so we never match an unrelated top-level.
        const memberAccess = detectMemberAccess(ctx.document, range.start);
        if (memberAccess?.kind === 'dot' || memberAccess?.kind === 'arrow') {
            return undefined;
        }
        if (KEYWORDS_TO_SKIP.has(word)) {
            // C++ keywords are skipped for normal identifier resolution, but many
            // have dedicated cppreference pages. cppreference often ships TWO rows
            // per keyword: a `cpp/keyword/<kw>` page (kind=Keyword) and a
            // `cpp/language/<kw>` page (kind=Language) — the Language page is
            // usually the tutorial-style explanation users actually want. Accept
            // either kind so `while`/`if`/`for`/`static`/`constexpr` resolve.
            const kwHit = index.lookupExact(word);
            if (kwHit && (kwHit.kind === 'Keyword' || kwHit.kind === 'Language')) {
                return { fqn: word, source: 'fallback' };
            }
            return undefined;
        }

        if (ctx.signal.aborted) throw makeAbortError();

        const lines = readDocumentLines(ctx.document, ctx.position.line);
        const scope = walkScopes({ lines, cursorLine: ctx.position.line });

        // `::`-access: the cursor sits after `Receiver::`. Restrict the
        // candidate set to forms that include the receiver as a parent so
        // we never bottom out on a same-named top-level (`TStr::data` would
        // otherwise fall through to `std::data`). The receiver may itself
        // be a typedef the index doesn't know about; in that case we simply
        // return undefined rather than synthesize a wrong answer.
        if (memberAccess?.kind === 'colon' && memberAccess.receiver.length > 0) {
            const receiver = memberAccess.receiver;
            const scopedCandidates: string[] = [];
            const push = (c: string): void => {
                if (!scopedCandidates.includes(c)) scopedCandidates.push(c);
            };
            // Innermost-enclosing-scope first, mirroring `buildFqnCandidates`'
            // priority order, then the receiver qualified by each `using
            // namespace` directive, then the bare `Receiver::word` form.
            for (let i = scope.enclosingScopes.length; i > 0; i--) {
                const prefix = scope.enclosingScopes.slice(0, i).join('::');
                push(`${prefix}::${receiver}::${word}`);
            }
            for (const ns of scope.usingNamespaces) {
                push(`${ns}::${receiver}::${word}`);
            }
            push(`${receiver}::${word}`);
            for (const candidate of scopedCandidates) {
                const hit = index.lookupExact(candidate);
                if (hit) return { fqn: candidate, source: 'fallback' };
            }
            return undefined;
        }

        const candidates = buildFqnCandidates(word, scope);

        if (ctx.signal.aborted) throw makeAbortError();

        for (const candidate of candidates) {
            const hit = index.lookupExact(candidate);
            if (hit) {
                return { fqn: candidate, source: 'fallback' };
            }
        }

        if (ctx.signal.aborted) throw makeAbortError();

        const parents = [...scope.enclosingScopes, ...scope.usingNamespaces];
        const ranked = index.lookupByUnqualified(word, parents, undefined);
        const top = ranked[0];
        if (top) {
            return { fqn: top.qualifiedName, source: 'fallback' };
        }

        return undefined;
    };
}

/**
 * Classify whether the cursor's word-range start sits immediately after
 * a member-access token (`.`, `->`, or `::`). For `::` we also recover
 * the receiver identifier the user typed to the left of the operator so
 * the caller can synthesize `Receiver::word` candidates.
 *
 * Returns `undefined` when there's no member-access prefix. Whitespace
 * between the operator and the cursor word is tolerated.
 */
export interface MemberAccessContext {
    kind: 'dot' | 'arrow' | 'colon';
    /** Identifier to the left of `::`; empty string for `.` and `->`. */
    receiver: string;
}

export function detectMemberAccess(
    document: Pick<vscode.TextDocument, 'lineAt'>,
    start: vscode.Position
): MemberAccessContext | undefined {
    // Defensive: a test or stub may pass a position without `line` /
    // `character` (the existing fallback unit tests build a minimal
    // `ShimRange` for `getWordRangeAtPosition`). Treat that as "no
    // member-access context detected" rather than throwing.
    if (
        start === undefined ||
        start === null ||
        typeof start.line !== 'number' ||
        typeof start.character !== 'number'
    ) {
        return undefined;
    }
    let line: string;
    try {
        line = document.lineAt(start.line).text;
    } catch {
        return undefined;
    }
    // Walk left from the column just before the word, skipping any spaces
    // / tabs the user left between the operator and the identifier.
    let i = start.character - 1;
    while (i >= 0 && (line[i] === ' ' || line[i] === '\t')) i--;
    if (i < 0) return undefined;
    const c = line[i];
    if (c === '.') return { kind: 'dot', receiver: '' };
    if (c === '>' && i >= 1 && line[i - 1] === '-') {
        return { kind: 'arrow', receiver: '' };
    }
    if (c === ':' && i >= 1 && line[i - 1] === ':') {
        // Walk further left to recover the receiver token. The receiver
        // may itself be qualified (`a::b::c::word`), so we keep extending
        // through identifier characters and additional `::` separators.
        // Tolerate whitespace adjacent to each `::` (some users style
        // qualifier chains as `Foo :: Bar :: name`).
        let j = i - 2;
        while (j >= 0 && (line[j] === ' ' || line[j] === '\t')) j--;
        const tokenChars: string[] = [];
        while (j >= 0) {
            const ch = line[j] ?? '';
            if (/[A-Za-z0-9_]/.test(ch)) {
                tokenChars.unshift(ch);
                j--;
                continue;
            }
            if (ch === ' ' || ch === '\t') {
                // Skip whitespace, but only if the next non-space is a `::`.
                let k = j;
                while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
                if (k >= 1 && line[k] === ':' && line[k - 1] === ':') {
                    tokenChars.unshift(':', ':');
                    j = k - 2;
                    continue;
                }
                break;
            }
            if (ch === ':' && j >= 1 && line[j - 1] === ':') {
                tokenChars.unshift(':', ':');
                j -= 2;
                continue;
            }
            break;
        }
        const receiver = tokenChars.join('').replace(/^:+/, '');
        return { kind: 'colon', receiver };
    }
    return undefined;
}

/**
 * Read the document's lines up to and including `upToLine` without
 * splitting the whole text on newlines — `TextDocument.lineAt` is the
 * API the rest of the extension uses and it normalizes CRLF/LF for us.
 * Falls back to a `getText().split` if `lineAt` isn't present (test
 * shims that only implement the bare minimum).
 */
function readDocumentLines(doc: vscode.TextDocument, upToLine: number): string[] {
    if (typeof doc.lineAt === 'function' && typeof doc.lineCount === 'number') {
        const limit = Math.min(upToLine + 1, doc.lineCount);
        const out: string[] = new Array(limit);
        for (let i = 0; i < limit; i++) {
            out[i] = doc.lineAt(i).text;
        }
        return out;
    }
    return doc.getText().split(/\r?\n/);
}
