// Strategy 0 — keyword + ellipsis short-circuit.
//
// Runs BEFORE every other strategy. The reason: when the cursor is on
// a C++ keyword that introduces a declaration (`static`, `inline`,
// `constexpr`, `using`, `template`, ...), clangd's hover surfaces the
// surrounding declaration's content — typically the variable's type
// or the alias's RHS. The hover-parser strategy dutifully extracts
// that and reports it as the "resolution" for the cursor position,
// even though the user pointing at `static` clearly wanted the
// keyword's docs page, not the type that follows.
//
// Putting the keyword check before the hover / definition strategies
// makes the resolution unambiguous: if the cursor word is a known C++
// keyword and the index has a Keyword or Language row for it, return
// that page immediately and skip the rest of the chain. Every C++
// keyword has at least one of those rows (verified against the
// cppreference 20250209 dump), so the strategy is exact — no
// guessing, no fallback ranking.
//
// This strategy also handles the `...` ellipsis: parameter packs in
// `Args...`, fold expressions, and template-parameter packs. The
// ellipsis isn't an identifier so the standard word-pattern path
// returns nothing; we detect it directly by examining the document
// text under the cursor.
//
// Returns undefined for any non-keyword cursor position — the chain
// then runs clangd / hover / definition / fallback as before.

import type * as vscode from 'vscode';
import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy
} from './types.js';
import { KEYWORDS_TO_SKIP, DEFAULT_WORD_PATTERN } from './cpp-keywords.js';

/**
 * Minimal index surface the strategy needs. The `Pick<>` shape lets
 * test fixtures stub with a one-method object rather than the full
 * IndexDB.
 *
 * The return shape mirrors `SymbolHit` but only the fields the
 * keyword strategy actually consumes — `kind` for the keyword /
 * language gate, `qualifiedName` so we return whatever name the
 * index has on file (necessary when the indexer mis-namespaced a
 * keyword: see the `std::typename` case below), and `filePath` so we
 * can detect keyword pages by path even when `kind` is wrong.
 */
export interface KeywordResolverIndex {
    lookupExact(qualifiedName: string):
        | { kind: string; qualifiedName: string; filePath: string }
        | undefined;
}

export interface KeywordStrategyDeps {
    index: KeywordResolverIndex;
    /**
     * Word pattern used to extract the cursor's identifier. Defaults to
     * the standard C-identifier shape ([A-Za-z_] followed by word
     * chars), matching the fallback strategy so the two stay in sync.
     * Tests can pass a narrower pattern.
     */
    wordPattern?: RegExp;
}

/**
 * The `...` ellipsis token. cppreference documents it as the
 * "parameter pack" language feature — used to declare a variadic
 * template parameter (`class...Args`), to expand a pack at the call
 * site (`f(args...)`), and as the syntactic core of fold expressions
 * (`(args ...op pattern)`). All three resolve to the same parameter
 * pack page; fold expressions get a dedicated cross-reference once
 * we plumb context detection.
 */
const ELLIPSIS_PAGE = 'parameter_pack';

/**
 * Build the keyword resolver strategy. The returned strategy:
 *
 *   1. Detects an ellipsis (`...`) at the cursor and resolves to the
 *      parameter-pack page when the index has it.
 *   2. Otherwise extracts the cursor word; if it's a C++ keyword
 *      (KEYWORDS_TO_SKIP set), looks it up in the index for a Keyword
 *      or Language row and returns the bare keyword as the FQN.
 *   3. Returns undefined for any non-keyword, non-ellipsis cursor —
 *      the chain proceeds to clangd / hover / definition / fallback.
 */
export function createKeywordStrategy(
    deps: KeywordStrategyDeps
): ResolverStrategy {
    const wordPattern = deps.wordPattern ?? DEFAULT_WORD_PATTERN;
    const index = deps.index;

    return async function keywordStrategy(
        ctx: ResolveContext
    ): Promise<ResolvedSymbol | undefined> {
        if (ctx.signal.aborted) return undefined;

        // Ellipsis path: the cursor is on a "." character that's part of
        // a "..." run. Resolve to the parameter-pack page.
        if (isOnEllipsis(ctx.document, ctx.position)) {
            const hit = index.lookupExact(ELLIPSIS_PAGE);
            if (hit) {
                return { fqn: ELLIPSIS_PAGE, source: 'keyword' };
            }
            // No parameter-pack page in index (very old cppreference dumps).
            // Return undefined and let the chain proceed.
            return undefined;
        }

        // Keyword path: cursor's identifier matches a known C++ keyword
        // AND the index has SOME row that points at a keyword / language
        // docs page. We try two lookups in order:
        //
        //   1. lookupExact(word) — the correct shape (cppreference's
        //      `cpp/keyword/<kw>.html` and `cpp/language/<kw>.html`
        //      pages are indexed with parent=null and kind=Keyword /
        //      Language). This is the fast path that succeeds for every
        //      keyword whose page lives in the singular `keyword/` dir.
        //
        //   2. lookupExact(`std::<word>`) — fallback for keywords whose
        //      page lives somewhere the indexer doesn't recognize, so it
        //      fell through to the catch-all `en/cpp/` rule (kind=Function,
        //      parent=std). Confirmed misindexed keywords (cppref 20250209
        //      dump): `typename` and `module` and `import` live under
        //      `en/cpp/keywords/` (plural) or
        //      `en/cpp/identifier_with_special_meaning/`; the indexer's
        //      rules use the singular `cpp/keyword/` path so these miss
        //      the keyword bucket. Both the indexer fix and this
        //      defensive fallback ship together — the resolver path
        //      makes the fix work on already-installed docsets without
        //      requiring a reinstall.
        //
        // Accept the hit if EITHER (a) the kind is Keyword / Language, or
        // (b) the filePath sits in `keyword/`, `keywords/`, or `language/`
        // even if the kind got mis-classified. The path check is the
        // belt-and-suspenders that catches future regressions where the
        // indexer adds a new path it doesn't know how to bucket.
        const range = ctx.document.getWordRangeAtPosition(
            ctx.position,
            wordPattern
        );
        if (!range) return undefined;
        const word = ctx.document.getText(range);
        if (word.length === 0) return undefined;
        if (!KEYWORDS_TO_SKIP.has(word)) return undefined;

        const hit = index.lookupExact(word) ?? index.lookupExact(`std::${word}`);
        if (!hit) return undefined;
        if (!isKeywordHit(hit)) return undefined;

        // Return whatever qualifiedName the index has on file — that's
        // what cursor-follow's `lookupBest` will use to find the page.
        // For correctly-indexed keywords that's the bare word; for
        // misindexed ones (e.g. `std::typename`) that's the qualified
        // form. Either way the surface lands on the keyword's docs page.
        return { fqn: hit.qualifiedName, source: 'keyword' };
    };
}

/**
 * True when `hit` points at a keyword / language docs page. Accepts
 * EITHER the canonical kind values (Keyword, Language) OR a
 * file_path under any of the keyword-bucket directories. The path
 * check defends against indexer-rule gaps — any cppreference page
 * under `keyword/`, `keywords/`, or `language/` is by definition a
 * keyword page and should resolve here.
 */
function isKeywordHit(hit: {
    kind: string;
    filePath: string;
}): boolean {
    if (hit.kind === 'Keyword' || hit.kind === 'Language') return true;
    return /\/(?:keywords?|language)\//.test(hit.filePath);
}

/**
 * Test whether "position" sits on a "." character that's part of a
 * "..." ellipsis run.The check is intentionally lenient: any "."
 * surrounded by enough "." chars to form a contiguous "..." somewhere
 * across the cursor position is treated as an ellipsis.
 *
 * Why position - based detection rather than "getWordRangeAtPosition"
 * with a custom pattern: word - range matching only fires for identifier
 * characters by default, and a "." isn't one. We'd have to override
 * the word pattern globally to make the cursor recognize "...", which
 * would break the rest of the resolver chain.
 *
 * Exported for tests.
 */
export function isOnEllipsis(
    document: Pick<vscode.TextDocument, 'lineAt'>,
    position: Pick<vscode.Position, 'line' | 'character'>
): boolean {
    let lineText: string;
    try {
        lineText = document.lineAt(position.line).text;
    } catch {
        return false;
    }
    // Cursor column is between characters; treat both the char at the
    // cursor column and the char before it as candidates. This covers
    // VSCode's two click-position conventions (caret between chars vs
    // caret on char).
    const candidates = [position.character, position.character - 1];
    for (const col of candidates) {
        if (col < 0 || col >= lineText.length) continue;
        if (lineText[col] !== '.') continue;
        // Walk both directions from "col", counting consecutive "." chars
        // including "col" itself. If the run covers 3+ dots, this is an
        // ellipsis.
        let run = 1;
        for (let i = col - 1; i >= 0 && lineText[i] === '.'; i--) run++;
        for (let i = col + 1; i < lineText.length && lineText[i] === '.'; i++) run++;
        if (run >= 3) return true;
    }
    return false;
}
