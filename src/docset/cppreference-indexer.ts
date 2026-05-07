import { createReadStream } from 'node:fs';
import { SaxesParser } from 'saxes';
import type { IndexDB } from './index.js';
import type { SymbolInsert } from './types.js';
import { decodeHtmlEntities } from '../util/html-escape.js';

/**
 * Monotonic indexer-logic version. Bump when the disk walker's row shape,
 * naming, or coverage changes in a way that requires existing users'
 * indexes to be rebuilt against the cached on-disk cppreference files.
 *
 * The extension reads the last-applied version from `globalState` and, if
 * less than this constant, silently re-runs `checkForUpdates` on next
 * activation so the new logic populates the index without the user having
 * to remove and reinstall the docset.
 *
 *  - v1: original title-derived directive rows (`conditional`, `replace`, ...)
 *  - v2: per-page directive names (`if`, `define`, `embed`, ...); see
 *    docs/superpowers/plans/2026-05-22-preprocessor-directive-resolution.md
 */
export const INDEXER_VERSION = 2;

export const INDEXER_VERSION_KEY = 'cppDocs.indexerVersion';

function stripHtmlToText(html: string): string {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100_000);
}

/**
 * Doxygen tag XML kinds (member-level) → symbol type vocabulary.
 *
 * Members inside `<compound kind="class|struct">` whose Doxygen kind is
 * `function` are mapped to `Method` instead of `Function` (handled below).
 *
 * `enumvalue` is mapped to `Constant` so the tree's `Enum` category lists
 * only enumeration types — individual enum values appear under `Constant`.
 */
const MEMBER_KIND_MAP: Readonly<Record<string, string>> = {
    function: 'Function',
    variable: 'Variable',
    typedef: 'Type',
    enumeration: 'Enum',
    enumvalue: 'Constant',
    define: 'Macro',
    friend: 'Friend'
};

interface CompoundContext {
    kind: string;
    name: string;
    filename: string;
    fileNamespace: string | null;
}

interface MemberContext {
    kind: string;
    name: string;
    anchorfile: string;
    anchor: string;
    arglist: string;
}

export interface IndexResult {
    inserted: number;
    byKind: Record<string, number>;
}

/**
 * Split `s` on commas that are NOT nested inside angle brackets.
 * Handles templates like `std::pair<T,U>` — the `,` inside `<>` is
 * preserved so tokens don't get split at template parameters.
 */
function splitOnTopLevelCommas(s: string): string[] {
    const parts: string[] = [];

    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<')
            depth++;
        else if (c === '>' && depth > 0)
            depth--;
        else if (c === ',' && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }

    parts.push(s.slice(start));
    return parts;
}

export async function indexTagXml(
    xmlPath: string,
    db: IndexDB,
    docsetId: number,
    documentsDir?: string
): Promise<IndexResult> {
    const tagInserts = await collectInserts(xmlPath);
    // Doxygen-tag XML for cppreference covers ~10% of pages on disk —
    // ~640 of ~6,640 HTML pages have a tag entry. Everything under
    // `en/c/` (626 pages — entire C library) and large swaths of
    // `en/cpp/` (`ranges/`, `language/`, `named_req/`, `concepts/`,
    // `keyword/`, `preprocessor/`, `algorithm/`, `header/`, …) are
    // present on disk but absent from the tag file.
    //
    // Walk the on-disk HTML to fill the gap. Pages whose `file_path`
    // already appears in a tag entry are skipped (the tag entries
    // carry richer metadata: parent class, arglist, member kind).
    const diskInserts = documentsDir
        ? await collectDiskInserts(documentsDir, new Set(tagInserts.map((s) => s.filePath)))
        : [];
    // Order matters for `lookupExact`'s "first row wins" tie-break: tag
    // entries (more authoritative) come first, then disk entries.
    const all = [...tagInserts, ...diskInserts];
    db.insertSymbols(docsetId, all);
    if (documentsDir)
        await indexFtsContent(documentsDir, db, docsetId);

    const byKind: Record<string, number> = {};
    for (const r of all)
        byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

    return {
        inserted: all.length,
        byKind
    };
}

export async function indexFtsContent(
    documentsDir: string,
    db: IndexDB,
    docsetId: number
): Promise<void> {
    const { readFile, readdir, stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const enRoot = path.join(documentsDir, 'en');

    let exists = false;
    try {
        const s = await stat(enRoot);
        exists = s.isDirectory();
    } catch {
        exists = false;
    }

    if (!exists)
        return;

    const BATCH_SIZE = 200;
    let batch: {
        filePath: string;
        title: string;
        body: string
    }[] = [];

    const flush = (): void => {
        if (batch.length === 0)
            return;

        db.indexPageContent(docsetId, batch);
        batch = [];
    };

    const stack: string[] = [enRoot];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                stack.push(path.join(dir, entry.name));
                continue;
            }

            if (!entry.name.endsWith('.html'))
                continue;

            const full = path.join(dir, entry.name);
            const filePath = path.relative(documentsDir, full).replace(/\\/g, '/');
            try {
                const html = await readFile(full, 'utf8');
                const titleMatch = /<title>\s*([^<]+?)\s*<\/title>/i.exec(html);
                const rawTitle = titleMatch?.[1] ?? entry.name.slice(0, -5);
                const title = rawTitle.replace(/\s*-\s*cppreference\.com\s*$/i, '').trim();
                const body = stripHtmlToText(html);

                batch.push({ filePath, title, body });

                if (batch.length >= BATCH_SIZE)
                    flush();
            } catch {
                // skip unreadable files
            }
        }
    }
    flush();
    db.finalizePageContent();
}

interface DiskCategoryRule {
    /** Path-relative-to-documents-dir prefix that triggers this rule. */
    pathPrefix: string;
    /** Symbol kind to emit. */
    kind: string;
    /** Default parent for every row this rule emits (null = top-level). */
    parent: string | null;
    /** Optional title prefix to strip before splitting. */
    titlePrefix?: RegExp;
    /**
     * Whether to skip the page entirely. Used for index/landing pages
     * that aren't symbols themselves (e.g. `cpp/symbol_index/`).
     */
    skip?: boolean;
    /**
     * Whether to skip files that are TOC pages (stem matches a sibling
     * directory). C has no namespaces, so its section landing pages
     * (e.g. `en/c/string.html` for `en/c/string/`) are not symbols.
     */
    skipToc?: boolean;
    /**
     * Explicit list of symbol names to emit for a given page basename,
     * overriding title-based extraction. cppreference's preprocessor pages
     * carry prose titles ("Conditional inclusion") that don't contain the
     * directive names — this map supplies them directly.
     *
     * Keyed by filename basename WITHOUT the `.html` extension
     * (e.g. `'conditional'` matches `en/cpp/preprocessor/conditional.html`).
     * When a page matches an entry, the title parser is bypassed and one
     * SymbolInsert is emitted per name, all sharing the same filePath.
     */
    names?: Record<string, string[]>;
}

/**
 * Canonical directive names per preprocessor page basename. Same map used
 * for both `en/cpp/preprocessor/` and `en/c/preprocessor/` because the
 * C and C++ preprocessor share the same set of directive names
 * (including the C23/C++23 additions `elifdef`, `elifndef`, `embed`).
 *
 * Keep this map in sync with the actual cppreference HTML — if a future
 * docset adds a new preprocessor page, add an entry here and an indexer
 * test asserting the resulting symbols.
 */
const PREPROCESSOR_DIRECTIVE_NAMES: Record<string, string[]> = {
    conditional: ['if', 'ifdef', 'ifndef', 'elif', 'elifdef', 'elifndef', 'else', 'endif'],
    replace: ['define', 'undef'],
    include: ['include'],
    error: ['error', 'warning'],
    impl: ['pragma'],
    line: ['line'],
    embed: ['embed']
};

/**
 * Per-subtree rules driving the disk walker. The first matching prefix
 * wins; entries are listed in priority order so more specific paths
 * (e.g. `en/cpp/header/`) match before their parent (`en/cpp/`).
 *
 * Title parsing: each rule's `titlePrefix` strips a stable boilerplate
 * (e.g. `C++ named requirements: `) so the rest of the title is the
 * real symbol name(s). The walker then splits on commas to register
 * multiple aliases for pages that document overload sets — that's how
 * cppreference itself groups `find`, `find_if`, `find_if_not`, etc.
 */
const DISK_RULES: DiskCategoryRule[] = [
    // Skip — these are toc/index pages, not symbols.
    { pathPrefix: 'en/cpp/symbol_index/', kind: 'Other', parent: null, skip: true },
    { pathPrefix: 'en/cpp/links/', kind: 'Other', parent: null, skip: true },
    // C++ language pages — `cpp/language/auto.html` etc.
    {
        pathPrefix: 'en/cpp/language/',
        kind: 'Language',
        parent: null
    },
    // C++ keywords — `cpp/keyword/auto.html`. Title shape:
    // `C++ keyword: auto - cppreference.com`.
    {
        pathPrefix: 'en/cpp/keyword/',
        kind: 'Keyword',
        parent: null,
        titlePrefix: /^C\+\+\s+keyword:\s+/i
    },
    // C++ keywords — PLURAL variant. cppreference's offline dump puts a
    // handful of keyword pages under `en/cpp/keywords/` instead of
    // `en/cpp/keyword/` (notably `typename.html`, `if.html`, and
    // `static.html` as of the 2025-02-09 release). Without this rule
    // they fell through to the catch-all `en/cpp/` rule and were
    // indexed as `std::typename` / `std::if` / `std::static` — the
    // keyword resolver strategy then couldn't find them by their bare
    // name. Mirror the singular rule exactly so both directories
    // produce identical bare-name Keyword rows.
    {
        pathPrefix: 'en/cpp/keywords/',
        kind: 'Keyword',
        parent: null,
        titlePrefix: /^C\+\+\s+keywords?:\s+/i
    },
    // C++ identifiers-with-special-meaning — `cpp/identifier_with_special_meaning/final.html`,
    // `override.html`, `module.html`, `import.html`. These aren't true
    // C++ keywords (the standard reserves them as "identifiers with
    // special meaning"); cppreference documents them alongside keywords
    // because users encounter them in the same contexts. Treat them as
    // bare-name Keyword rows so cursor-on-`module` / cursor-on-`override`
    // resolves to the right page without falling through to the
    // `std::` catch-all.
    {
        pathPrefix: 'en/cpp/identifier_with_special_meaning/',
        kind: 'Keyword',
        parent: null
    },
    // C++ preprocessor directives. Page titles are prose ("Conditional
    // inclusion") that don't contain the directive names; PREPROCESSOR_DIRECTIVE_NAMES
    // supplies the canonical names per file so each page emits one row
    // per directive it documents.
    {
        pathPrefix: 'en/cpp/preprocessor/',
        kind: 'Directive',
        parent: null,
        names: PREPROCESSOR_DIRECTIVE_NAMES
    },
    // Named requirements — `cpp/named_req/Container.html`. Title:
    // `C++ named requirements: Container - cppreference.com`.
    {
        pathPrefix: 'en/cpp/named_req/',
        kind: 'Requirement',
        parent: null,
        titlePrefix: /^C\+\+\s+named\s+requirements?:\s+/i
    },
    // Concepts (both `concept` and `concepts` paths exist across
    // cppreference releases). Pages live under `std::`.
    {
        pathPrefix: 'en/cpp/concepts/',
        kind: 'Concept',
        parent: 'std'
    },
    {
        pathPrefix: 'en/cpp/concept/',
        kind: 'Concept',
        parent: 'std'
    },
    // Header pages — `cpp/header/vector.html`. Title is typically
    // `Standard library header <vector> - cppreference.com`.
    {
        pathPrefix: 'en/cpp/header/',
        kind: 'Header',
        parent: null,
        titlePrefix: /^Standard\s+library\s+header\s+/i
    },
    // C language pages.
    {
        pathPrefix: 'en/c/language/',
        kind: 'Language',
        parent: null
    },
    // C keywords — `c/keyword/static.html`. Title: `C keywords: static`.
    {
        pathPrefix: 'en/c/keyword/',
        kind: 'Keyword',
        parent: null,
        titlePrefix: /^C\s+keywords?:\s+/i
    },
    // C preprocessor directives. Same per-page name map as the C++ side
    // (the directive vocabulary is identical between the two languages).
    {
        pathPrefix: 'en/c/preprocessor/',
        kind: 'Directive',
        parent: null,
        names: PREPROCESSOR_DIRECTIVE_NAMES
    },
    // C header pages (e.g. `c/header/stdio.html`).
    {
        pathPrefix: 'en/c/header/',
        kind: 'Header',
        parent: null,
        titlePrefix: /^Standard\s+library\s+header\s+/i
    },
    // Catch-all for the rest of the C library — `c/string/byte/isdigit.html`,
    // `c/io/printf.html`, etc. C symbols are top-level. Section landing pages
    // (e.g. `en/c/string.html` paired with `en/c/string/`) are skipped because
    // C has no namespaces — they're just category overviews, not symbols.
    {
        pathPrefix: 'en/c/',
        kind: 'Function',
        parent: null,
        skipToc: true
    },
    // Catch-all for `cpp/...` pages not covered by a more specific rule.
    // Default parent is `std` since cppreference uses the C++ stdlib
    // namespace for nearly everything under en/cpp/. The walker re-derives
    // the actual parent from each comma-separated name token below
    // (e.g. `std::ranges::sort` → parent `std::ranges`).
    {
        pathPrefix: 'en/cpp/',
        kind: 'Function',
        parent: 'std'
    }
];

function pickRule(relPath: string): DiskCategoryRule | undefined {
    for (const rule of DISK_RULES) {
        if (relPath.startsWith(rule.pathPrefix)) return rule;
    }
    return undefined;
}

/**
 * Parse a title like `std::sort, std::stable_sort` into individual
 * symbol tokens. Trims ` - cppreference.com` and any leading prefix
 * matched by `titlePrefix`. Whitespace and `(<header>)` annotations
 * are removed. Returns the raw token list — the caller decides how
 * to derive `qualifiedName` / `unqualified` / `parent`.
 */
export function extractTitleTokens(
    rawTitle: string,
    titlePrefix?: RegExp
): string[] {
    // Decode HTML entities FIRST so that `&lt;T,U&gt;` becomes `<T,U>`
    // before we strip the cppreference suffix and split on commas. Without
    // this decode, `std::expected&lt;T,E&gt;::and_then` would be split at
    // the literal `,` in `E&gt;`, producing garbled tokens.
    let title = decodeHtmlEntities(rawTitle)
        .replace(/\s*-\s*cppreference\.com\s*$/i, '')
        .trim();

    if (titlePrefix) {
        const stripped = title.replace(titlePrefix, '').trim();
        if (stripped)
            title = stripped;
    }
    // splitOnTopLevelCommas skips commas inside <> so template parameter
    // lists are not split into spurious extra tokens.
    return splitOnTopLevelCommas(title)
        .map((t) => t.replace(/\s*\(<[^>]+>\)\s*$/, '').trim())
        .filter((t) => t.length > 0);
}

/**
 * Decide the (qualifiedName, unqualified, parent) triple for a single
 * title token under the given rule. Tokens that contain `::` are taken
 * verbatim (the embedded scope wins over the rule's default parent).
 * Bare identifiers fall back to the rule's `parent`.
 *
 * Returns `undefined` for tokens that don't look like a C/C++ symbol
 * (purely-prose titles like "Conditional inclusion") so the walker
 * skips them.
 */
export function resolveDiskSymbol(
    token: string,
    rulePathPrefix: string,
    ruleParent: string | null
): { qualifiedName: string; unqualified: string; parent: string | null } | undefined {
    const cleaned = token.trim();
    if (!cleaned)
        return undefined;

    // Hyphens, parentheses, and prose phrases mean this token isn't a
    // symbol. Allow operator overloads (`operator<<` etc.).
    if (cleaned.startsWith('operator')) {
        const rest = cleaned.slice('operator'.length);
        // operator<<, operator(), operator[], operator T() — accept any
        // non-whitespace tail.
        if (rest.length === 0 || /^\s/.test(rest)) {
            // bare `operator` — skip
        } else {
            return {
                qualifiedName: ruleParent ? `${ruleParent}::${cleaned}` : cleaned,
                unqualified: cleaned,
                parent: ruleParent
            };
        }
    }
    if (cleaned.includes('::')) {
        const segs = cleaned.split('::');
        const last = segs[segs.length - 1] ?? '';
        if (!isIdentifierLike(last)) return undefined;
        const parent = segs.slice(0, -1).join('::') || null;
        return { qualifiedName: cleaned, unqualified: last, parent };
    }
    if (!isIdentifierLike(cleaned)) {
        // Prose-only titles — fall back to using the URL stem if the
        // rule wants pages indexed regardless. We let the caller handle
        // this branch via the path-stem fallback.
        return undefined;
    }
    // Use the rule's path prefix to suppress "always under std::"
    // synthesis for known C/non-namespace categories.
    const useRuleParent =
        rulePathPrefix === 'en/cpp/' ||
        rulePathPrefix === 'en/cpp/concepts/' ||
        rulePathPrefix === 'en/cpp/concept/';
    const parent = useRuleParent ? ruleParent : null;
    return {
        qualifiedName: parent ? `${parent}::${cleaned}` : cleaned,
        unqualified: cleaned,
        parent
    };
}

function isIdentifierLike(s: string): boolean {
    return /^[A-Za-z_~][A-Za-z0-9_]*$/.test(s);
}

/**
 * Inspect the first declaration block in a cppreference HTML page to
 * determine whether it documents a macro, a constant, or something else.
 * Only called for pages that would otherwise default to kind='Function'.
 * Returns undefined when no strong signal is found.
 */
function detectKindFromHtml(html: string): 'Macro' | 'Constant' | undefined {
    // Find the first declaration table (cppreference uses class="t-dcl-begin")
    const dclIdx = html.indexOf('t-dcl-begin');
    if (dclIdx === -1) return undefined;

    // Bound the search to this table only to avoid false positives
    const tableEnd = html.indexOf('</table>', dclIdx);
    const dclSection = html.slice(
        Math.max(0, dclIdx - 50),
        tableEnd > dclIdx ? tableEnd : Math.min(html.length, dclIdx + 4000)
    );

    // Strip HTML tags to get plain declaration text
    const text = dclSection.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // #define → Macro (covers both object-like and function-like macros)
    if (/#define\b/.test(text)) return 'Macro';

    // constexpr/static const variable (not function) → Constant.
    // Heuristic: the first '=' appears before the first '(' after the
    // constexpr keyword — variables have = initializer, functions have (params).
    const kwMatch = /\b(?:(?:static\s+)?constexpr|static\s+const)\b/.exec(text);
    if (kwMatch) {
        const after = text.slice(kwMatch.index);
        const eqIdx = after.indexOf('=');
        const parenIdx = after.indexOf('(');
        if (eqIdx >= 0 && (parenIdx < 0 || eqIdx < parenIdx)) {
            return 'Constant';
        }
    }

    return undefined;
}

/**
 * Walk `documentsDir/en/{cpp,c}` and emit `SymbolInsert` rows for every
 * page not already in the tag-XML index (`alreadyIndexedPaths`).
 *
 * Each page produces one row per comma-separated symbol token in the
 * title, using the per-directory rule from `DISK_RULES` to decide
 * `kind` and the default `parent`. Pages with prose-only titles fall
 * back to the URL stem as the symbol name.
 *
 * Pages whose filename collides with a sibling directory (TOC pages
 * like `cpp/algorithm.html` for `cpp/algorithm/`) are emitted with
 * kind `Namespace` so the tree groups them naturally.
 */
export async function collectDiskInserts(
    documentsDir: string,
    alreadyIndexedPaths: ReadonlySet<string> = new Set()
): Promise<SymbolInsert[]> {
    const { readFile, readdir, stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const enRoot = path.join(documentsDir, 'en');
    let exists = false;
    try {
        const s = await stat(enRoot);
        exists = s.isDirectory();
    } catch {
        exists = false;
    }
    if (!exists) return [];

    const inserts: SymbolInsert[] = [];
    const seenQualified = new Set<string>();
    const stack: string[] = [enRoot];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        // Pre-compute which sibling names are directories (for TOC detection).
        const subdirs = new Set<string>();
        for (const entry of entries) {
            if (entry.isDirectory()) subdirs.add(entry.name);
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                stack.push(path.join(dir, entry.name));
                continue;
            }
            const name = entry.name;
            if (!name.endsWith('.html')) continue;
            const full = path.join(dir, name);
            const relPath = path.relative(documentsDir, full).replace(/\\/g, '/');
            // Skip if the tag XML already has this page — its row is more
            // authoritative (carries arglist + parent class metadata).
            if (alreadyIndexedPaths.has(relPath)) continue;
            const rule = pickRule(relPath);
            if (!rule || rule.skip) continue;
            const stem = name.slice(0, -'.html'.length);
            const isToc = subdirs.has(stem);
            if (rule.skipToc && isToc) continue;
            // Explicit names override: when a rule supplies `names[stem]`,
            // emit one row per name and skip title parsing entirely. Used by
            // the preprocessor rules where cppreference page titles are prose
            // ("Conditional inclusion") that don't carry the actual directive
            // names. Each name becomes a bare top-level symbol (no parent
            // prefix unless rule.parent is set), all sharing this page's filePath.
            const explicitNames = rule.names?.[stem];
            if (explicitNames && explicitNames.length > 0) {
                const overrideRows: SymbolInsert[] = [];
                for (const name of explicitNames) {
                    const qualified = rule.parent ? `${rule.parent}::${name}` : name;
                    const dedupKey = `${qualified}|${relPath}`;
                    if (seenQualified.has(dedupKey)) continue;
                    seenQualified.add(dedupKey);
                    overrideRows.push({
                        qualifiedName: qualified,
                        unqualified: name,
                        parent: rule.parent,
                        kind: rule.kind,
                        filePath: relPath,
                        anchor: null,
                        arglist: null
                    });
                }
                inserts.push(...overrideRows);
                continue;
            }
            // Read title; fall back to stem.
            let rawTitle = stem;
            let detectedKind: 'Macro' | 'Constant' | undefined;
            try {
                const html = await readFile(full, 'utf8');
                const m = /<title>\s*([^<]+?)\s*<\/title>/i.exec(html);
                if (m && m[1]) rawTitle = m[1];
                if (!isToc && rule.kind === 'Function') {
                    detectedKind = detectKindFromHtml(html);
                }
            } catch {
                // skip — fall back to stem
            }
            const effectiveKind = detectedKind ?? rule.kind;
            const tokens = extractTitleTokens(rawTitle, rule.titlePrefix);
            // Build the symbol set: each token → one row. Tokens that don't
            // resolve to a usable identifier fall through to the stem-based
            // fallback so we still index the page under SOME name.
            // Macros are preprocessor tokens — they exist outside any namespace.
            // Strip any parent the catch-all rule would inject (e.g. 'std::').
            const isMacro = !isToc && effectiveKind === 'Macro';
            const rows: SymbolInsert[] = [];
            for (const token of tokens) {
                const resolved = resolveDiskSymbol(token, rule.pathPrefix, rule.parent);
                if (!resolved) continue;
                const rowParent = isMacro ? null : resolved.parent;
                const rowQualified = isMacro ? resolved.unqualified : resolved.qualifiedName;
                const dedupKey = `${rowQualified}|${relPath}`;
                if (seenQualified.has(dedupKey)) continue;
                seenQualified.add(dedupKey);
                rows.push({
                    qualifiedName: rowQualified,
                    unqualified: resolved.unqualified,
                    parent: rowParent,
                    kind: isToc ? 'Namespace' : effectiveKind,
                    filePath: relPath,
                    anchor: null,
                    arglist: null
                });
            }
            if (rows.length === 0) {
                // Fallback: prose-only or unparseable title. Use the URL stem
                // as the symbol name. Skip if the stem isn't a valid
                // identifier (which would imply the file is `index.html`,
                // `compiler_support.html`, etc. — best left out of the
                // searchable index).
                if (isIdentifierLike(stem)) {
                    const rowParent = isMacro ? null : rule.parent;
                    const rowQualified = isMacro ? stem : (rule.parent ? `${rule.parent}::${stem}` : stem);
                    const dedupKey = `${rowQualified}|${relPath}`;
                    if (!seenQualified.has(dedupKey)) {
                        seenQualified.add(dedupKey);
                        rows.push({
                            qualifiedName: rowQualified,
                            unqualified: stem,
                            parent: rowParent,
                            kind: isToc ? 'Namespace' : effectiveKind,
                            filePath: relPath,
                            anchor: null,
                            arglist: null
                        });
                    }
                }
            }
            inserts.push(...rows);
        }
    }
    return inserts;
}

/**
 * @deprecated Use `collectDiskInserts` which covers `en/cpp/` and
 * `en/c/` together with deduplication against the tag XML. This
 * narrower variant is kept for the existing unit tests.
 */
export async function collectCInsertsFromDisk(
    documentsDir: string
): Promise<SymbolInsert[]> {
    const inserts = await collectDiskInserts(documentsDir, new Set());
    return inserts.filter((s) => s.filePath.startsWith('en/c/'));
}

/**
 * Streams the Doxygen tag XML and emits a SymbolInsert per `<member>` and per
 * class/struct compound. Uses event-driven parsing (not cursor "advance to
 * next sibling"), so the SAX sibling-skipping hazard documented in
 * docs/06-gotchas.md does not apply.
 */
export async function collectInserts(xmlPath: string): Promise<SymbolInsert[]> {
    const inserts: SymbolInsert[] = [];
    const parser = new SaxesParser({ xmlns: false });
    let compound: CompoundContext | null = null;
    let member: MemberContext | null = null;
    let textBuffer = '';

    parser.on('error', (err) => {
        throw err;
    });

    parser.on('opentag', (node) => {
        const tag = node.name;
        const attrs = node.attributes as Record<string, string>;
        if (tag === 'compound') {
            compound = {
                kind: attrs['kind'] ?? '',
                name: '',
                filename: '',
                fileNamespace: null
            };
        }
        else if (tag === 'member' && compound) {
            member = {
                kind: attrs['kind'] ?? '',
                name: '',
                anchorfile: '',
                anchor: '',
                arglist: ''
            };
        }
        textBuffer = '';
    });

    parser.on('text', (t) => {
        textBuffer += t;
    });

    parser.on('cdata', (t) => {
        textBuffer += t;
    });

    parser.on('closetag', (node) => {
        const tag = node.name;
        const text = textBuffer;
        textBuffer = '';

        if (member && compound) {
            switch (tag) {
                case 'name':
                    member.name = text;
                    return;
                case 'anchorfile':
                    member.anchorfile = text;
                    return;
                case 'anchor':
                    member.anchor = text;
                    return;
                case 'arglist':
                    member.arglist = text;
                    return;
                case 'member': {
                    const sym = buildMemberInsert(compound, member);
                    if (sym) inserts.push(sym);
                    member = null;
                    return;
                }
            }
            return;
        }

        if (compound) {
            switch (tag) {
                case 'name':
                    compound.name = text;
                    return;
                case 'filename':
                    compound.filename = text;
                    return;
                case 'namespace':
                    // Per docs/06-gotchas.md (B): namespace info on `kind="file"` lives in
                    // a child `<namespace>`. Class/struct compounds expose this differently
                    // (via the qualified name), so we only honor it for files.
                    if (compound.kind === 'file') compound.fileNamespace = text;
                    return;
                case 'compound': {
                    const sym = buildCompoundInsert(compound);
                    if (sym) inserts.push(sym);
                    compound = null;
                    return;
                }
            }
        }
    });

    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(xmlPath, { encoding: 'utf8' });
        stream.on('data', (chunk) => {
            try {
                parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
            } catch (err) {
                reject(err as Error);
            }
        });
        stream.on('end', () => {
            try {
                parser.close();
                resolve();
            } catch (err) {
                reject(err as Error);
            }
        });
        stream.on('error', reject);
    });

    return inserts;
}

/**
 * Doxygen tag XML for cppreference encodes header-disambiguated names as
 * `name (<header>)` — e.g. `isdigit (<cctype>)` and `isdigit (<clocale>)`
 * for the two distinct C++ pages. The pretty-print suffix is *not* part
 * of the symbol name; strip it so the index keys reduce to the bare
 * identifier and `lookupExact("std::isdigit")` matches the page that
 * the user actually wants.
 */
function cleanMemberName(raw: string): string {
    return raw.replace(/\s*\(<[^>]+>\)\s*$/, '').trim();
}

function buildMemberInsert(c: CompoundContext, m: MemberContext): SymbolInsert | null {
    if (!m.name) return null;
    const cleaned = cleanMemberName(m.name);
    if (!cleaned) return null;
    const parent = resolveMemberParent(c);
    const qualifiedName = parent ? `${parent}::${cleaned}` : cleaned;
    const inClass = c.kind === 'class' || c.kind === 'struct';
    const symbolKind =
        inClass && m.kind === 'function'
            ? 'Method'
            : MEMBER_KIND_MAP[m.kind] ?? 'Other';

    return {
        qualifiedName,
        unqualified: cleaned,
        parent,
        kind: symbolKind,
        filePath: m.anchorfile,
        anchor: m.anchor || null,
        arglist: m.arglist || null
    };
}

function resolveMemberParent(c: CompoundContext): string | null {
    switch (c.kind) {
        case 'class':
        case 'struct':
            return c.name || null;
        case 'namespace':
            return c.name || null;
        case 'file':
            return c.fileNamespace;
        default:
            return c.name || null;
    }
}

function buildCompoundInsert(c: CompoundContext): SymbolInsert | null {
    if (!c.name || !c.filename) return null;
    let kind: string;
    switch (c.kind) {
        case 'class':
            kind = 'Class';
            break;
        case 'struct':
            kind = 'Struct';
            break;
        case 'union':
            kind = 'Union';
            break;
        case 'namespace':
            kind = 'Namespace';
            break;
        default:
            // file/group/dir compounds have no landing page — skip.
            return null;
    }
    const parts = c.name.split('::');
    const unqualified = parts[parts.length - 1] ?? c.name;
    const parent = parts.length > 1 ? parts.slice(0, -1).join('::') : null;
    return {
        qualifiedName: c.name,
        unqualified,
        parent,
        kind,
        filePath: `en/${c.filename}.html`,
        anchor: null,
        arglist: null
    };
}
