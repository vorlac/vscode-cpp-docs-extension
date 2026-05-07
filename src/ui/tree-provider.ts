import * as vscode from 'vscode';
import { detectLanguage } from '../docset/index.js';
import type { ContentHit } from '../docset/index.js';
import type { DocsetManager } from '../docset/manager.js';
import type { DocsetRow, SymbolHit } from '../docset/types.js';

/**
 * Display-only entity decode for tree labels that may contain pre-index
 * `&lt;`/`&gt;`/`&amp;` remnants. The DB read path (toHit) also decodes,
 * but this is the last-mile guard so a label never reaches VS Code's
 * TreeItem as `std::atomic_ref&lt;T&gt;::operator&amp;=`.
 * `&amp;` must be replaced LAST so we don't turn `&amp;lt;` into `&lt;`
 * mid-pass and then decode it incorrectly.
 */
function decodeEntities(s: string): string {
    if (s.indexOf('&') < 0) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&#60;/g, '<')
        .replace(/&#x3c;/gi, '<')
        .replace(/&#62;/g, '>')
        .replace(/&#x3e;/gi, '>')
        .replace(/&amp;/g, '&');
}

/** Language tree under cppreference docsets — mirrors the on-disk split. */
export type DocLang = 'cpp' | 'c';

/**
 * Tree element discriminated union, per docs/02-architecture.md
 * §"TreeView details".
 *
 * For cppreference docsets we insert a `language` node between the
 * docset and its categories so the C and C++ trees stay visually
 * separate (e.g. `if`, `while`, `for` only show up once per language
 * even though both languages have a Keyword page for them). For
 * non-cppreference docsets the language node is
 * omitted and categories are direct children of the docset, same as
 * before — `lang` is undefined on those category nodes.
 *
 * Sub-grouped (large-kind) categories are encoded by stuffing
 * `<kind>:::<parent>` into `typeKind` (a literal `<parent>` of `null` denotes
 * the no-parent bucket). The top-level category never contains `:::`. This
 * lets `getChildren`/`getParent` recover the structure without re-querying.
 */
export type DocNode =
    | { kind: 'docset'; docsetId: number; name: string }
    | { kind: 'language'; docsetId: number; lang: DocLang; label: string }
    | {
        kind: 'category';
        docsetId: number;
        typeKind: string;
        label: string;
        lang?: DocLang;
    }
    | { kind: 'symbol'; docsetId: number; symbolId: number; qualified: string }
    | { kind: 'page'; docsetId: number; filePath: string; title: string };

/** Threshold above which a top-level category sub-groups its symbols by parent. */
export const SUBGROUP_THRESHOLD = 500;

/** Hard cap on how many rows a single category can list. */
export const SYMBOL_LIST_LIMIT = 5000;

/**
 * Cap on the LIKE result-set size for the filter index query. A 1-char filter
 * over a fully populated cppreference index (~50k rows) easily blows this; the
 * tree visibly narrows further as the user keeps typing, so undercap is safe.
 */
export const FILTER_RESULT_LIMIT = 5000;

/** Sentinel within `category.typeKind` that distinguishes a sub-group node. */
export const SUBGROUP_SEPARATOR = ':::';

/** Sentinel within encoded sub-groups for `parent IS NULL`. */
const NULL_PARENT_SENTINEL = ' NULL';

/**
 * Command that the symbol tree-item fires on click. Registered separately
 * (M3.4); declared here so the test-only assertion can verify the wiring.
 */
export const OPEN_SYMBOL_FROM_TREE_COMMAND = 'cppDocs.openSymbolFromTree';

/** Command fired when a page hit node is activated from search results. */
export const OPEN_PAGE_FROM_SEARCH_COMMAND = 'cppDocs.openPageFromSearch';

interface ParsedCategory {
    kind: string;
    parent: string | null | undefined;
}

function parseCategoryKind(typeKind: string): ParsedCategory {
    const idx = typeKind.indexOf(SUBGROUP_SEPARATOR);
    if (idx < 0) return { kind: typeKind, parent: undefined };
    const kind = typeKind.slice(0, idx);
    const rest = typeKind.slice(idx + SUBGROUP_SEPARATOR.length);
    return {
        kind,
        parent: rest === NULL_PARENT_SENTINEL ? null : rest
    };
}

function encodeCategoryKind(kind: string, parent: string | null): string {
    return `${kind}${SUBGROUP_SEPARATOR}${parent === null ? NULL_PARENT_SENTINEL : parent}`;
}

function nodeId(node: DocNode): string {
    switch (node.kind) {
        case 'docset':
            return `docset:${node.docsetId}`;
        case 'language':
            return `lang:${node.docsetId}:${node.lang}`;
        case 'category':
            return `category:${node.docsetId}:${node.lang ?? '_'}:${node.typeKind}`;
        case 'symbol':
            return `symbol:${node.docsetId}:${node.symbolId}`;
        case 'page':
            return `page:${node.docsetId}:${node.filePath}`;
    }
}

const LANG_LABELS: Record<DocLang, string> = {
    cpp: 'C++',
    c: 'C'
};

/**
 * Snapshot of which (docsetId, lang, kind, parent) tuples and which symbol
 * ids are visible under the active filter. Built once per `setFilter()`
 * call by issuing a single index-side LIKE scan, then consulted by
 * `getChildren` so each level's filter check is O(1) per node.
 */
interface FilterIndex {
    /** Set of `docsetId` values containing at least one matching symbol. */
    docsetIds: Set<number>;
    /** Keyed by `${docsetId} ${lang}` for cppreference languages with a match. */
    languages: Set<string>;
    /** Keyed by `${docsetId} ${lang ?? '_'} ${kind}`. */
    topCategories: Set<string>;
    /** Keyed by `${docsetId} ${lang ?? '_'} ${kind} ${parent ?? NULL_PARENT_KEY}`. */
    subgroupCategories: Set<string>;
    /** Set of matching `symbolId` values. */
    symbolIds: Set<number>;
}

const NULL_PARENT_KEY = 'NULL';

function languageKey(docsetId: number, lang: DocLang): string {
    return `${docsetId} ${lang}`;
}

function topCategoryKey(
    docsetId: number,
    lang: DocLang | undefined,
    kind: string
): string {
    return `${docsetId} ${lang ?? '_'} ${kind}`;
}

function subgroupCategoryKey(
    docsetId: number,
    lang: DocLang | undefined,
    kind: string,
    parent: string | null
): string {
    return `${docsetId} ${lang ?? '_'} ${kind} ${parent ?? NULL_PARENT_KEY}`;
}

/** True for docsets whose disk layout splits C and C++ under en/cpp/ vs en/c/. */
function docsetIsLanguageSplit(d: DocsetRow): boolean {
    return d.source === 'cppreference';
}

export class CppDocsTreeProvider implements vscode.TreeDataProvider<DocNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<
        DocNode | undefined
    >();
    readonly onDidChangeTreeData: vscode.Event<DocNode | undefined> =
        this._onDidChangeTreeData.event;

    private filter: string | null = null;
    private filterIndex: FilterIndex | null = null;
    private pageHits: ContentHit[] = [];

    constructor(private readonly docsets: DocsetManager) { }

    refresh(node?: DocNode): void {
        this._onDidChangeTreeData.fire(node);
    }

    /**
     * Set the substring filter for the visible tree. Pass `null` (or empty
     * string) to clear. Fires `onDidChangeTreeData` so VSCode re-asks for the
     * children of every expanded node. Eagerly populates an in-memory
     * `FilterIndex` so subsequent `getChildren` calls don't re-scan the DB.
     */
    setFilter(filter: string | null): void {
        const next = filter && filter.length > 0 ? filter : null;
        this.filter = next;
        if (next === null) {
            this.filterIndex = null;
            this.pageHits = [];
        } else {
            const hits = this.docsets.searchSymbolsForFilter(next, FILTER_RESULT_LIMIT);
            this.filterIndex = this.buildFilterIndex(hits);
            this.pageHits = [];
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Set the tree to display pre-computed search results: matching symbols
     * (narrowing the docset tree) and FTS content page hits (appended at root).
     * Pass `null` query to clear all search state.
     */
    setSearchResults(
        query: string | null,
        symbolHits: { symbolId: number; docsetId: number; kind: string; parent: string | null; qualifiedName: string; filePath: string }[],
        pageHits: ContentHit[]
    ): void {
        if (!query || query.length === 0) {
            this.filter = null;
            this.filterIndex = null;
            this.pageHits = [];
        } else {
            this.filter = query;
            this.filterIndex = this.buildFilterIndex(symbolHits);
            this.pageHits = pageHits;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Whether a filter is currently applied (used by the title-bar context key). */
    isFilterActive(): boolean {
        return this.filter !== null;
    }

    /** Test-only inspection of the currently applied filter string. */
    getFilter(): string | null {
        return this.filter;
    }

    private buildFilterIndex(hits: { symbolId: number; docsetId: number; kind: string; parent: string | null; qualifiedName: string; filePath: string }[]): FilterIndex {
        const docsetIds = new Set<number>();
        const languages = new Set<string>();
        const topCategories = new Set<string>();
        const subgroupCategories = new Set<string>();
        const symbolIds = new Set<number>();
        for (const h of hits) {
            docsetIds.add(h.docsetId);
            const lang = detectLanguage(h.filePath);
            if (lang) languages.add(languageKey(h.docsetId, lang));
            topCategories.add(topCategoryKey(h.docsetId, lang, h.kind));
            subgroupCategories.add(
                subgroupCategoryKey(h.docsetId, lang, h.kind, h.parent)
            );
            symbolIds.add(h.symbolId);
        }
        return {
            docsetIds,
            languages,
            topCategories,
            subgroupCategories,
            symbolIds
        };
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: DocNode): vscode.TreeItem {
        if (element.kind === 'docset') {
            const item = new vscode.TreeItem(
                element.name,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = nodeId(element);
            item.contextValue = 'cppDocs.docset';
            item.iconPath = new vscode.ThemeIcon('library');
            return item;
        }

        if (element.kind === 'language') {
            const item = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = nodeId(element);
            item.contextValue = 'cppDocs.language';
            // Distinct icon so the C and C++ branches read as a deliberate
            // grouping rather than two more categories among the rest.
            item.iconPath = new vscode.ThemeIcon('symbol-class');
            return item;
        }

        if (element.kind === 'category') {
            const parsed = parseCategoryKind(element.typeKind);
            const item = new vscode.TreeItem(
                decodeEntities(element.label),
                vscode.TreeItemCollapsibleState.Collapsed
            );
            item.id = nodeId(element);
            item.contextValue =
                parsed.parent === undefined
                    ? 'cppDocs.category'
                    : 'cppDocs.category.subgroup';
            item.iconPath = new vscode.ThemeIcon(
                parsed.parent === undefined ? 'symbol-namespace' : 'symbol-class'
            );
            const count = this.countForCategory(
                element.docsetId,
                parsed,
                element.lang
            );
            if (count !== undefined) item.description = `${count}`;
            return item;
        }

        if (element.kind === 'page') {
            const item = new vscode.TreeItem(
                element.title,
                vscode.TreeItemCollapsibleState.None
            );
            item.id = nodeId(element);
            item.contextValue = 'cppDocs.page';
            item.iconPath = new vscode.ThemeIcon('file-code');
            item.command = {
                command: OPEN_PAGE_FROM_SEARCH_COMMAND,
                title: 'Open Page',
                arguments: [{ docsetId: element.docsetId, filePath: element.filePath }]
            };
            return item;
        }

        const item = new vscode.TreeItem(
            decodeEntities(element.qualified),
            vscode.TreeItemCollapsibleState.None
        );
        item.id = nodeId(element);
        item.contextValue = 'cppDocs.symbol';
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        item.command = {
            command: OPEN_SYMBOL_FROM_TREE_COMMAND,
            title: 'Open Symbol',
            arguments: [
                { docsetId: element.docsetId, symbolId: element.symbolId }
            ]
        };
        return item;
    }

    getChildren(element?: DocNode): DocNode[] {
        if (!element) return this.rootDocsets();

        if (element.kind === 'docset') {
            return this.childrenForDocset(element.docsetId);
        }

        if (element.kind === 'language') {
            return this.categoriesForDocset(element.docsetId, element.lang);
        }

        if (element.kind === 'category') {
            return this.childrenForCategory(element);
        }

        if (element.kind === 'page') return [];

        return [];
    }

    getParent(node: DocNode): DocNode | undefined {
        if (node.kind === 'docset') return undefined;

        if (node.kind === 'page') return undefined;

        if (node.kind === 'language') {
            return this.docsetNode(node.docsetId);
        }

        if (node.kind === 'category') {
            const parsed = parseCategoryKind(node.typeKind);
            if (parsed.parent !== undefined) {
                // Sub-group → top-level category for that kind, in the same lang.
                return {
                    kind: 'category',
                    docsetId: node.docsetId,
                    typeKind: parsed.kind,
                    label: parsed.kind,
                    ...(node.lang ? { lang: node.lang } : {})
                };
            }
            // Top-level category → language node (cppreference) or docset.
            if (node.lang) {
                return {
                    kind: 'language',
                    docsetId: node.docsetId,
                    lang: node.lang,
                    label: LANG_LABELS[node.lang]
                };
            }
            return this.docsetNode(node.docsetId);
        }

        // node.kind === 'symbol'
        const hit = this.docsets.getSymbolById(node.symbolId);
        if (!hit) return undefined;

        const docsetRow = this.docsets
            .listDocsets()
            .find((d) => d.id === hit.docsetId);
        const lang =
            docsetRow && docsetIsLanguageSplit(docsetRow)
                ? detectLanguage(hit.filePath)
                : undefined;

        const kindCounts = this.docsets.listKindsForDocset(hit.docsetId, lang);
        const total = kindCounts.find((k) => k.kind === hit.kind)?.count ?? 0;
        if (total > SUBGROUP_THRESHOLD) {
            const parentRows = this.docsets.listParentsByKind(
                hit.docsetId,
                hit.kind,
                lang
            );
            // Mirror the childrenForCategory bypass: if every symbol has null
            // parent no subgroup node is shown, so return the top-level category.
            if (!(parentRows.length === 1 && parentRows[0]?.parent === null)) {
                const encoded = encodeCategoryKind(hit.kind, hit.parent);
                return {
                    kind: 'category',
                    docsetId: hit.docsetId,
                    typeKind: encoded,
                    label: decodeEntities(hit.parent ?? '(no parent)'),
                    ...(lang ? { lang } : {})
                };
            }
            // Fall through to return top-level category below.
        }
        return {
            kind: 'category',
            docsetId: hit.docsetId,
            typeKind: hit.kind,
            label: hit.kind,
            ...(lang ? { lang } : {})
        };
    }

    /**
     * Map a `SymbolHit` (typically obtained via `IndexDB.findSymbolByPath` after
     * a successful page load) to the `DocNode` that represents it in the tree.
     * Returns `undefined` when the active filter excludes the symbol — the
     * caller (extension.ts) is the one that decides to clear the filter and
     * re-try, since the provider has no knowledge of UI context-keys. This is a
     * unit-tested contract, not the provider clearing its own filter.
     *
     * The returned node uses the same `typeKind` encoding produced by
     * `getChildren` so `getParent` walks back through the same chain — large
     * categories sub-grouped by parent yield a sub-group parent, small ones
     * yield the top-level category parent.
     */
    findNodeForSymbol(hit: SymbolHit): DocNode | undefined {
        if (this.filterIndex && !this.filterIndex.symbolIds.has(hit.id)) {
            return undefined;
        }
        return {
            kind: 'symbol',
            docsetId: hit.docsetId,
            symbolId: hit.id,
            qualified: decodeEntities(hit.qualifiedName)
        };
    }

    private countForCategory(
        docsetId: number,
        parsed: ParsedCategory,
        lang: DocLang | undefined
    ): number | undefined {
        if (parsed.parent === undefined) {
            const kinds = this.docsets.listKindsForDocset(docsetId, lang);
            return kinds.find((k) => k.kind === parsed.kind)?.count;
        }
        const parents = this.docsets.listParentsByKind(
            docsetId,
            parsed.kind,
            lang
        );
        return parents.find((p) => p.parent === parsed.parent)?.count;
    }

    private docsetNode(docsetId: number): DocNode | undefined {
        const docsets = this.docsets.listDocsets();
        const hit = docsets.find((d) => d.id === docsetId);
        return hit
            ? { kind: 'docset', docsetId: hit.id, name: hit.name }
            : undefined;
    }

    private rootDocsets(): DocNode[] {
        const all = this.docsets
            .listDocsets()
            .filter((d) => d.isActive)
            .map<DocNode>((d) => ({ kind: 'docset', docsetId: d.id, name: d.name }));

        let docsetNodes: DocNode[];
        if (!this.filterIndex) {
            docsetNodes = all;
        } else {
            const visible = this.filterIndex.docsetIds;
            docsetNodes = all.filter(
                (n) => n.kind === 'docset' && visible.has(n.docsetId)
            );
        }

        const pageNodes: DocNode[] = this.pageHits.map<DocNode>((h) => ({
            kind: 'page',
            docsetId: h.docsetId,
            filePath: h.filePath,
            title: h.title
        }));

        return [...docsetNodes, ...pageNodes];
    }

    /**
     * Children of a docset node. For cppreference docsets, this returns
     * the C++ and C language nodes (each with their own kinds inside).
     * For non-cppreference docsets the categories are direct children, same
     * shape as before the language split.
     */
    private childrenForDocset(docsetId: number): DocNode[] {
        const docset = this.docsets
            .listDocsets()
            .find((d) => d.id === docsetId);
        if (!docset) return [];
        if (!docsetIsLanguageSplit(docset)) {
            return this.categoriesForDocset(docsetId, undefined);
        }
        const langs: DocLang[] = ['cpp', 'c'];
        const nodes = langs
            .filter((lang) => {
                const kinds = this.docsets.listKindsForDocset(docsetId, lang);
                return kinds.some((k) => k.count > 0);
            })
            .map<DocNode>((lang) => ({
                kind: 'language',
                docsetId,
                lang,
                label: LANG_LABELS[lang]
            }));
        if (!this.filterIndex) return nodes;
        const visible = this.filterIndex.languages;
        return nodes.filter(
            (n) => n.kind === 'language' && visible.has(languageKey(docsetId, n.lang))
        );
    }

    private categoriesForDocset(
        docsetId: number,
        lang: DocLang | undefined
    ): DocNode[] {
        const all = this.docsets
            .listKindsForDocset(docsetId, lang)
            .map<DocNode>((row) => ({
                kind: 'category',
                docsetId,
                typeKind: row.kind,
                label: row.kind,
                ...(lang ? { lang } : {})
            }));
        if (!this.filterIndex) return all;
        const visible = this.filterIndex.topCategories;
        return all.filter(
            (n) => n.kind === 'category' && visible.has(topCategoryKey(docsetId, lang, n.typeKind))
        );
    }

    private childrenForCategory(category: {
        docsetId: number;
        typeKind: string;
        label: string;
        lang?: DocLang;
    }): DocNode[] {
        const parsed = parseCategoryKind(category.typeKind);
        const lang = category.lang;

        if (parsed.parent !== undefined) {
            // Sub-group leaf: list symbols within (kind, parent), scoped to
            // the same language as the surrounding category.
            const symbols = this.docsets
                .listSymbolsByKind(
                    category.docsetId,
                    parsed.kind,
                    parsed.parent,
                    SYMBOL_LIST_LIMIT,
                    lang
                )
                .map<DocNode>((s) => ({
                    kind: 'symbol',
                    docsetId: s.docsetId,
                    symbolId: s.id,
                    qualified: decodeEntities(s.qualifiedName)
                }));
            if (!this.filterIndex) return symbols;
            const visibleIds = this.filterIndex.symbolIds;
            return symbols.filter(
                (n) => n.kind === 'symbol' && visibleIds.has(n.symbolId)
            );
        }

        // Top-level category. Decide whether to sub-group by parent.
        const kindCounts = this.docsets.listKindsForDocset(
            category.docsetId,
            lang
        );
        const total = kindCounts.find((k) => k.kind === parsed.kind)?.count ?? 0;
        if (total > SUBGROUP_THRESHOLD) {
            const parentRows = this.docsets.listParentsByKind(
                category.docsetId,
                parsed.kind,
                lang
            );
            // When every symbol has null parent there is only one "group" and it
            // adds no information — skip the intermediate level and list directly.
            if (!(parentRows.length === 1 && parentRows[0]?.parent === null)) {
                const subgroups = parentRows.map<DocNode>((p) => ({
                    kind: 'category',
                    docsetId: category.docsetId,
                    typeKind: encodeCategoryKind(parsed.kind, p.parent),
                    label: decodeEntities(p.parent ?? '(no parent)'),
                    ...(lang ? { lang } : {})
                }));
                if (!this.filterIndex) return subgroups;
                const visible = this.filterIndex.subgroupCategories;
                return subgroups.filter((n) => {
                    if (n.kind !== 'category') return false;
                    const sgParsed = parseCategoryKind(n.typeKind);
                    if (sgParsed.parent === undefined) return false;
                    return visible.has(
                        subgroupCategoryKey(
                            n.docsetId,
                            n.lang,
                            sgParsed.kind,
                            sgParsed.parent
                        )
                    );
                });
            }
            // Fall through: all items have null parent, list symbols directly below.
        }
        const symbols = this.docsets
            .listSymbolsByKind(
                category.docsetId,
                parsed.kind,
                undefined,
                SYMBOL_LIST_LIMIT,
                lang
            )
            .map<DocNode>((s) => ({
                kind: 'symbol',
                docsetId: s.docsetId,
                symbolId: s.id,
                qualified: decodeEntities(s.qualifiedName)
            }));
        if (!this.filterIndex) return symbols;
        const visibleIds = this.filterIndex.symbolIds;
        return symbols.filter(
            (n) => n.kind === 'symbol' && visibleIds.has(n.symbolId)
        );
    }
}
