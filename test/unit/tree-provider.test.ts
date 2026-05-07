import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal vscode mock — vitest can't import the real `vscode` (host runtime
// only). We stub just what `tree-provider.ts` references: TreeItem,
// TreeItemCollapsibleState, ThemeIcon, EventEmitter.
vi.mock('vscode', () => {
    class TreeItem {
        public id: string | undefined;
        public description: string | boolean | undefined;
        public iconPath: unknown;
        public contextValue: string | undefined;
        public command: unknown;
        constructor(
            public label: string,
            public collapsibleState: number
        ) { }
    }
    const TreeItemCollapsibleState = {
        None: 0,
        Collapsed: 1,
        Expanded: 2
    };
    class ThemeIcon {
        constructor(public id: string) { }
    }
    class EventEmitter<T> {
        private listeners: Array<(e: T) => void> = [];
        readonly event = (cb: (e: T) => void): { dispose: () => void } => {
            this.listeners.push(cb);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== cb);
                }
            };
        };
        fire(e: T): void {
            for (const l of this.listeners) l(e);
        }
        dispose(): void {
            this.listeners = [];
        }
    }
    return { TreeItem, TreeItemCollapsibleState, ThemeIcon, EventEmitter };
});

import { IndexDB } from '../../src/docset/index.js';
import type {
    DocsetInsert,
    DocsetRow,
    SymbolInsert
} from '../../src/docset/types.js';
import {
    CppDocsTreeProvider,
    OPEN_SYMBOL_FROM_TREE_COMMAND,
    SUBGROUP_THRESHOLD,
    type DocNode
} from '../../src/ui/tree-provider.js';

// General-purpose tree-behavior tests use 'external' source so they don't
// trip the C/C++ language-split layer (which only fires for
// `source: 'cppreference'` docsets — see the dedicated suite below).
const baseDocset: DocsetInsert = {
    name: 'cppreference',
    source: 'external',
    version: '20250209',
    rootPath: '/tmp/cppref',
    documentsDir: '/tmp/cppref/reference',
    indexFormat: 'searchIndex',
    installedAt: 1_700_000_000
};

function symInsert(
    qn: string,
    kind: string,
    filePath: string,
    parent: string | null | undefined = undefined
): SymbolInsert {
    const segments = qn.split('::');
    const unqualified = segments[segments.length - 1] ?? qn;
    const computedParent =
        parent === undefined
            ? segments.length > 1
                ? segments.slice(0, -1).join('::')
                : null
            : parent;
    return {
        qualifiedName: qn,
        unqualified,
        parent: computedParent,
        kind,
        filePath,
        anchor: null,
        arglist: null
    };
}

/**
 * Minimal `DocsetManager`-shaped object exposing only the methods the tree
 * provider calls. Backed by a real `IndexDB` (in-memory) per test.
 */
function makeManagerStub(db: IndexDB) {
    return {
        listDocsets: (): DocsetRow[] => db.listDocsets(),
        listKindsForDocset: (id: number, langFilter?: 'cpp' | 'c') =>
            db.listKindsForDocset(id, langFilter),
        listSymbolsByKind: (
            id: number,
            kind: string,
            parentFilter: string | null | undefined,
            limit: number,
            langFilter?: 'cpp' | 'c'
        ) => db.listSymbolsByKind(id, kind, parentFilter, limit, langFilter),
        listParentsByKind: (id: number, kind: string, langFilter?: 'cpp' | 'c') =>
            db.listParentsByKind(id, kind, langFilter),
        getSymbolById: (sid: number) => db.getSymbolById(sid),
        findSymbolByPath: (id: number, filePath: string) =>
            db.findSymbolByPath(id, filePath),
        searchSymbolsForFilter: (filter: string, limit: number) =>
            db.searchSymbolsForFilter(filter, limit)
    };
}

function makeProvider(db: IndexDB): CppDocsTreeProvider {
    const stub = makeManagerStub(db);
    // The provider only depends on the methods listed above.
    return new CppDocsTreeProvider(stub as unknown as never);
}

describe('CppDocsTreeProvider', () => {
    let db: IndexDB;

    beforeEach(async () => {
        db = await IndexDB.open(':memory:');
    });
    afterEach(() => {
        db.close();
    });

    it('returns [] from getChildren() on an empty database', () => {
        const provider = makeProvider(db);
        expect(provider.getChildren()).toEqual([]);
    });

    it('two docsets yield two root nodes with non-overlapping category sets', () => {
        const a = db.insertDocset({ ...baseDocset, name: 'cppref' });
        const b = db.insertDocset({
            ...baseDocset,
            name: 'mirror',
            source: 'external'
        });
        db.insertSymbols(a, [
            symInsert('std::sort', 'Function', 'a/sort.html'),
            symInsert('std::vector', 'Class', 'a/vector.html')
        ]);
        db.insertSymbols(b, [
            symInsert('NS::M', 'Macro', 'b/macro.html'),
            symInsert('NS::T', 'Typedef', 'b/typedef.html')
        ]);

        const provider = makeProvider(db);
        const roots = provider.getChildren() as DocNode[];
        expect(roots).toHaveLength(2);
        const docsetA = roots.find(
            (n) => n.kind === 'docset' && n.docsetId === a
        ) as Extract<DocNode, { kind: 'docset' }> | undefined;
        const docsetB = roots.find(
            (n) => n.kind === 'docset' && n.docsetId === b
        ) as Extract<DocNode, { kind: 'docset' }> | undefined;
        expect(docsetA?.name).toBe('cppref');
        expect(docsetB?.name).toBe('mirror');

        const aCats = (provider.getChildren(docsetA!) as DocNode[]).filter(
            (n) => n.kind === 'category'
        ) as Array<Extract<DocNode, { kind: 'category' }>>;
        const bCats = (provider.getChildren(docsetB!) as DocNode[]).filter(
            (n) => n.kind === 'category'
        ) as Array<Extract<DocNode, { kind: 'category' }>>;
        expect(aCats.map((c) => c.label).sort()).toEqual(['Class', 'Function']);
        expect(bCats.map((c) => c.label).sort()).toEqual(['Macro', 'Typedef']);
    });

    it('sub-groups large categories by parent, and re-queries on expansion', () => {
        const id = db.insertDocset(baseDocset);
        // Build N > SUBGROUP_THRESHOLD symbols of a single kind, half each across
        // two parent values.
        const N = SUBGROUP_THRESHOLD + 4;
        const half = Math.floor(N / 2);
        const rows: SymbolInsert[] = [];
        for (let i = 0; i < half; i++) {
            rows.push(
                symInsert(`std::vector::m${i}`, 'Function', `vec/m${i}.html`)
            );
        }
        for (let i = 0; i < N - half; i++) {
            rows.push(
                symInsert(`std::list::m${i}`, 'Function', `list/m${i}.html`)
            );
        }
        db.insertSymbols(id, rows);

        const provider = makeProvider(db);
        const roots = provider.getChildren() as DocNode[];
        const docset = roots.find(
            (n) => n.kind === 'docset'
        ) as Extract<DocNode, { kind: 'docset' }>;
        const cats = (provider.getChildren(docset) as DocNode[]).filter(
            (n) => n.kind === 'category'
        ) as Array<Extract<DocNode, { kind: 'category' }>>;
        expect(cats).toHaveLength(1);
        const fnCat = cats[0]!;
        expect(fnCat.label).toBe('Function');

        // Expanding the function category yields sub-groups, not symbols.
        const subgroups = (provider.getChildren(fnCat) as DocNode[]).filter(
            (n) => n.kind === 'category'
        ) as Array<Extract<DocNode, { kind: 'category' }>>;
        expect(subgroups.length).toBeGreaterThanOrEqual(2);
        const labels = subgroups.map((s) => s.label).sort();
        expect(labels).toContain('std::vector');
        expect(labels).toContain('std::list');
        // Each sub-group's typeKind must encode the parent so getChildren can
        // re-query for that parent's symbols.
        for (const sg of subgroups) {
            expect(sg.typeKind).not.toBe('Function');
            expect(sg.typeKind.startsWith('Function')).toBe(true);
        }
        const vecGroup = subgroups.find((s) => s.label === 'std::vector')!;
        const vecChildren = provider.getChildren(vecGroup) as DocNode[];
        expect(vecChildren.length).toBe(half);
        expect(
            vecChildren.every(
                (c) => c.kind === 'symbol' && c.qualified.startsWith('std::vector::')
            )
        ).toBe(true);
    });

    it('small categories list symbols directly without sub-grouping', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            symInsert('std::vector::push_back', 'Function', 'vec/push_back.html'),
            symInsert('std::vector::pop_back', 'Function', 'vec/pop_back.html')
        ]);
        const provider = makeProvider(db);
        const docset = (provider.getChildren() as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'docset' }
        >;
        const fnCat = (provider.getChildren(docset) as DocNode[]).find(
            (n) => n.kind === 'category'
        ) as Extract<DocNode, { kind: 'category' }>;
        const children = provider.getChildren(fnCat) as DocNode[];
        expect(children.every((c) => c.kind === 'symbol')).toBe(true);
        expect(children.length).toBe(2);
    });

    it('getParent: symbol → category, category → docset, docset → undefined', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            symInsert('std::vector::push_back', 'Function', 'vec/push_back.html')
        ]);
        const provider = makeProvider(db);
        const docset = (provider.getChildren() as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'docset' }
        >;
        const fnCat = (provider.getChildren(docset) as DocNode[]).find(
            (n) => n.kind === 'category'
        ) as Extract<DocNode, { kind: 'category' }>;
        const symbol = (provider.getChildren(fnCat) as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'symbol' }
        >;

        const symParent = provider.getParent(symbol) as Extract<
            DocNode,
            { kind: 'category' }
        >;
        expect(symParent.kind).toBe('category');
        expect(symParent.typeKind).toBe('Function');
        expect(symParent.docsetId).toBe(id);

        const catParent = provider.getParent(fnCat) as Extract<
            DocNode,
            { kind: 'docset' }
        >;
        expect(catParent.kind).toBe('docset');
        expect(catParent.docsetId).toBe(id);

        expect(provider.getParent(docset)).toBeUndefined();
    });

    it('getParent for symbol in a sub-grouped category returns the sub-group', () => {
        const id = db.insertDocset(baseDocset);
        const N = SUBGROUP_THRESHOLD + 2;
        const rows: SymbolInsert[] = [];
        for (let i = 0; i < N; i++) {
            rows.push(symInsert(`std::vector::m${i}`, 'Function', `vec/m${i}.html`));
        }
        db.insertSymbols(id, rows);
        const provider = makeProvider(db);
        const docset = (provider.getChildren() as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'docset' }
        >;
        const fnCat = (provider.getChildren(docset) as DocNode[]).find(
            (n) => n.kind === 'category'
        ) as Extract<DocNode, { kind: 'category' }>;
        const subgroup = (provider.getChildren(fnCat) as DocNode[]).find(
            (n) => n.kind === 'category'
        ) as Extract<DocNode, { kind: 'category' }>;
        const symbol = (provider.getChildren(subgroup) as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'symbol' }
        >;
        const parent = provider.getParent(symbol) as Extract<
            DocNode,
            { kind: 'category' }
        >;
        expect(parent.kind).toBe('category');
        expect(parent.typeKind).toBe(subgroup.typeKind);
        expect(parent.label).toBe('std::vector');

        // The sub-group's parent is the top-level category.
        const sgParent = provider.getParent(subgroup) as Extract<
            DocNode,
            { kind: 'category' }
        >;
        expect(sgParent.kind).toBe('category');
        expect(sgParent.typeKind).toBe('Function');
    });

    it('getTreeItem produces correct collapsibleState/id/label/description/command', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            symInsert('std::vector::push_back', 'Function', 'vec/push_back.html'),
            symInsert('std::vector::pop_back', 'Function', 'vec/pop_back.html')
        ]);
        const provider = makeProvider(db);
        const docset = (provider.getChildren() as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'docset' }
        >;
        const fnCat = (provider.getChildren(docset) as DocNode[]).find(
            (n) => n.kind === 'category'
        ) as Extract<DocNode, { kind: 'category' }>;
        const symbol = (provider.getChildren(fnCat) as DocNode[])[0] as Extract<
            DocNode,
            { kind: 'symbol' }
        >;

        const docItem = provider.getTreeItem(docset);
        expect(docItem.collapsibleState).toBe(1); // Collapsed
        expect(docItem.label).toBe('cppreference');
        expect(docItem.id).toBe(`docset:${id}`);
        expect(docItem.command).toBeUndefined();

        const catItem = provider.getTreeItem(fnCat);
        expect(catItem.collapsibleState).toBe(1); // Collapsed
        expect(catItem.label).toBe('Function');
        // The `_` slot is the empty language placeholder — non-cppreference
        // docsets don't carry a `lang`, but the id format reserves a slot
        // so multiple docsets can coexist in one tree without
        // id collisions.
        expect(catItem.id).toBe(`category:${id}:_:Function`);
        expect(catItem.description).toBe('2');
        expect(catItem.command).toBeUndefined();

        const symItem = provider.getTreeItem(symbol);
        expect(symItem.collapsibleState).toBe(0); // None
        // Symbols are alphabetically ordered by qualified_name; pop_back < push_back.
        expect(symItem.label).toBe('std::vector::pop_back');
        expect(symItem.id).toBe(`symbol:${id}:${symbol.symbolId}`);
        expect(symItem.command).toBeDefined();
        const cmd = symItem.command as {
            command: string;
            arguments?: unknown[];
        };
        expect(cmd.command).toBe(OPEN_SYMBOL_FROM_TREE_COMMAND);
        expect(cmd.arguments).toEqual([
            { docsetId: id, symbolId: symbol.symbolId }
        ]);
    });

    it('refresh() fires onDidChangeTreeData', () => {
        const provider = makeProvider(db);
        const fired: Array<DocNode | undefined> = [];
        const sub = provider.onDidChangeTreeData((e) => fired.push(e));
        provider.refresh();
        provider.refresh({
            kind: 'docset',
            docsetId: 1,
            name: 'x'
        });
        sub.dispose();
        expect(fired).toHaveLength(2);
        expect(fired[0]).toBeUndefined();
        expect(fired[1]).toEqual({ kind: 'docset', docsetId: 1, name: 'x' });
    });

    it('inactive docsets are excluded from the root node list', () => {
        const a = db.insertDocset(baseDocset);
        db.insertDocset({ ...baseDocset, name: 'inactive', isActive: false });
        db.insertSymbols(a, [symInsert('std::sort', 'Function', 'a.html')]);
        const provider = makeProvider(db);
        const roots = provider.getChildren() as DocNode[];
        expect(roots).toHaveLength(1);
        expect((roots[0] as Extract<DocNode, { kind: 'docset' }>).docsetId).toBe(
            a
        );
    });

    describe('filter', () => {
        function seed(): {
            provider: CppDocsTreeProvider;
            docsetA: number;
            docsetB: number;
        } {
            const docsetA = db.insertDocset({ ...baseDocset, name: 'cppref' });
            const docsetB = db.insertDocset({
                ...baseDocset,
                name: 'mirror',
                source: 'external'
            });
            db.insertSymbols(docsetA, [
                symInsert('std::vector::push_back', 'Function', 'a/push_back.html'),
                symInsert('std::vector::pop_back', 'Function', 'a/pop_back.html'),
                symInsert('std::sort', 'Function', 'a/sort.html'),
                symInsert('std::vector', 'Class', 'a/vector.html')
            ]);
            db.insertSymbols(docsetB, [
                symInsert('mylib::Foo::bar', 'Function', 'b/bar.html'),
                symInsert('mylib::Foo', 'Class', 'b/foo.html')
            ]);
            return { provider: makeProvider(db), docsetA, docsetB };
        }

        it('with no filter, getChildren() returns the full set as before', () => {
            const { provider } = seed();
            const roots = provider.getChildren() as DocNode[];
            expect(roots).toHaveLength(2);
        });

        it('setFilter narrows the root list to docsets containing a matching symbol', () => {
            const { provider, docsetA } = seed();
            provider.setFilter('push_back');
            const roots = provider.getChildren() as DocNode[];
            expect(roots).toHaveLength(1);
            const only = roots[0] as Extract<DocNode, { kind: 'docset' }>;
            expect(only.kind).toBe('docset');
            expect(only.docsetId).toBe(docsetA);
        });

        it('setFilter narrows the categories under a docset to ones with a matching symbol', () => {
            const { provider, docsetA } = seed();
            provider.setFilter('push_back');
            const docsetNode: DocNode = {
                kind: 'docset',
                docsetId: docsetA,
                name: 'cppref'
            };
            const cats = (provider.getChildren(docsetNode) as DocNode[]).filter(
                (n) => n.kind === 'category'
            ) as Array<Extract<DocNode, { kind: 'category' }>>;
            expect(cats.map((c) => c.label)).toEqual(['Function']);
        });

        it('setFilter narrows the symbols under a category to matching ones (no peers)', () => {
            const { provider, docsetA } = seed();
            provider.setFilter('push_back');
            const docsetNode: DocNode = {
                kind: 'docset',
                docsetId: docsetA,
                name: 'cppref'
            };
            const fnCat = (provider.getChildren(docsetNode) as DocNode[]).find(
                (n) => n.kind === 'category' && n.typeKind === 'Function'
            ) as Extract<DocNode, { kind: 'category' }>;
            const symbols = (provider.getChildren(fnCat) as DocNode[]).filter(
                (n) => n.kind === 'symbol'
            ) as Array<Extract<DocNode, { kind: 'symbol' }>>;
            expect(symbols.map((s) => s.qualified)).toEqual([
                'std::vector::push_back'
            ]);
        });

        it('uppercase filter matches case-insensitively', () => {
            const { provider, docsetA } = seed();
            provider.setFilter('PUSH_BACK');
            const roots = provider.getChildren() as DocNode[];
            expect(roots.map((n) => n.kind === 'docset' && n.docsetId)).toEqual([
                docsetA
            ]);
            const docsetNode = roots[0] as Extract<DocNode, { kind: 'docset' }>;
            const fnCat = (provider.getChildren(docsetNode) as DocNode[]).find(
                (n) => n.kind === 'category' && n.typeKind === 'Function'
            ) as Extract<DocNode, { kind: 'category' }>;
            const symbols = (provider.getChildren(fnCat) as DocNode[]).filter(
                (n) => n.kind === 'symbol'
            ) as Array<Extract<DocNode, { kind: 'symbol' }>>;
            expect(symbols.map((s) => s.qualified)).toEqual([
                'std::vector::push_back'
            ]);
        });

        it('a no-match filter returns [] from getChildren()', () => {
            const { provider } = seed();
            provider.setFilter('xxxx-not-present');
            expect(provider.getChildren()).toEqual([]);
        });

        it('setFilter(null) restores full results', () => {
            const { provider } = seed();
            provider.setFilter('push_back');
            expect((provider.getChildren() as DocNode[]).length).toBe(1);
            provider.setFilter(null);
            expect((provider.getChildren() as DocNode[]).length).toBe(2);
        });

        it('setFilter fires onDidChangeTreeData', () => {
            const { provider } = seed();
            const fired: Array<DocNode | undefined> = [];
            const sub = provider.onDidChangeTreeData((e) => fired.push(e));
            provider.setFilter('push_back');
            provider.setFilter(null);
            sub.dispose();
            expect(fired).toHaveLength(2);
            expect(fired[0]).toBeUndefined();
            expect(fired[1]).toBeUndefined();
        });

        it('setFilter narrows large categories (sub-grouped) to only matching sub-groups', () => {
            const id = db.insertDocset({
                ...baseDocset,
                name: 'subgrouped'
            });
            const N = SUBGROUP_THRESHOLD + 4;
            const half = Math.floor(N / 2);
            const rows = [];
            for (let i = 0; i < half; i++) {
                rows.push(symInsert(`std::vector::m${i}`, 'Function', `vec/m${i}.html`));
            }
            for (let i = 0; i < N - half; i++) {
                rows.push(symInsert(`std::list::m${i}`, 'Function', `list/m${i}.html`));
            }
            db.insertSymbols(id, rows);
            const provider = makeProvider(db);
            provider.setFilter('std::vector::m0');
            const docsetNode: DocNode = {
                kind: 'docset',
                docsetId: id,
                name: 'subgrouped'
            };
            const fnCat = (provider.getChildren(docsetNode) as DocNode[]).find(
                (n) => n.kind === 'category' && n.typeKind === 'Function'
            ) as Extract<DocNode, { kind: 'category' }>;
            const subgroups = (provider.getChildren(fnCat) as DocNode[]).filter(
                (n) => n.kind === 'category'
            ) as Array<Extract<DocNode, { kind: 'category' }>>;
            // Only the std::vector sub-group should remain visible; std::list filtered out.
            expect(subgroups.map((s) => s.label)).toEqual(['std::vector']);
        });
    });

    describe('findNodeForSymbol', () => {
        it('returns a symbol DocNode whose getParent() chain unwinds to the docset root', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                symInsert(
                    'std::vector::push_back',
                    'Function',
                    'en/cpp/container/vector/push_back.html'
                )
            ]);
            const provider = makeProvider(db);
            const hit = db.findSymbolByPath(
                id,
                'en/cpp/container/vector/push_back.html'
            );
            expect(hit).toBeDefined();
            const node = provider.findNodeForSymbol(hit!);
            expect(node).toBeDefined();
            expect(node!.kind).toBe('symbol');
            const symNode = node as Extract<DocNode, { kind: 'symbol' }>;
            expect(symNode.symbolId).toBe(hit!.id);
            expect(symNode.qualified).toBe('std::vector::push_back');

            // Unwind the parent chain — small category, so it's symbol → category → docset.
            const cat = provider.getParent(symNode) as Extract<
                DocNode,
                { kind: 'category' }
            >;
            expect(cat?.kind).toBe('category');
            expect(cat.typeKind).toBe('Function');
            const docset = provider.getParent(cat) as Extract<
                DocNode,
                { kind: 'docset' }
            >;
            expect(docset?.kind).toBe('docset');
            expect(docset.docsetId).toBe(id);
            expect(provider.getParent(docset)).toBeUndefined();
        });

        it('for a sub-grouped category, the symbol node’s parent chain runs through the sub-group', () => {
            const id = db.insertDocset(baseDocset);
            const N = SUBGROUP_THRESHOLD + 4;
            const rows: SymbolInsert[] = [];
            for (let i = 0; i < N; i++) {
                rows.push(symInsert(`std::vector::m${i}`, 'Function', `vec/m${i}.html`));
            }
            // Add a unique sentinel we can look up unambiguously.
            rows.push(
                symInsert('std::vector::push_back', 'Function', 'vec/push_back.html')
            );
            db.insertSymbols(id, rows);
            const provider = makeProvider(db);

            const hit = db.findSymbolByPath(id, 'vec/push_back.html');
            expect(hit).toBeDefined();
            const node = provider.findNodeForSymbol(hit!) as Extract<
                DocNode,
                { kind: 'symbol' }
            >;
            expect(node).toBeDefined();
            expect(node.qualified).toBe('std::vector::push_back');

            const parent = provider.getParent(node) as Extract<
                DocNode,
                { kind: 'category' }
            >;
            expect(parent.kind).toBe('category');
            // The parent must be the std::vector sub-group, not the top-level
            // 'Function' category — typeKind contains the sub-group separator.
            expect(parent.typeKind).not.toBe('Function');
            expect(parent.typeKind.startsWith('Function')).toBe(true);
            expect(parent.label).toBe('std::vector');

            const grand = provider.getParent(parent) as Extract<
                DocNode,
                { kind: 'category' }
            >;
            expect(grand.kind).toBe('category');
            expect(grand.typeKind).toBe('Function');
        });

        it('with a filter that excludes the symbol, returns undefined (caller clears the filter)', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                symInsert('std::vector::push_back', 'Function', 'a/push_back.html'),
                symInsert('std::vector::pop_back', 'Function', 'a/pop_back.html')
            ]);
            const provider = makeProvider(db);
            provider.setFilter('pop_back');

            const hit = db.findSymbolByPath(id, 'a/push_back.html');
            expect(hit).toBeDefined();
            // push_back is filtered out (filter: 'pop_back') — the contract is that
            // findNodeForSymbol returns undefined and the caller decides what to do.
            expect(provider.findNodeForSymbol(hit!)).toBeUndefined();

            // After the caller clears the filter, the same hit resolves.
            provider.setFilter(null);
            const node = provider.findNodeForSymbol(hit!);
            expect(node).toBeDefined();
            expect((node as Extract<DocNode, { kind: 'symbol' }>).qualified).toBe(
                'std::vector::push_back'
            );
        });
    });

    /**
     * cppreference-source docsets get an extra `language` layer between
     * the docset and its categories so the C and C++ trees stay visually
     * separate even when the same kind name (Keyword, Header, Language)
     * appears in both, and so duplicates of the same identifier in both
     * trees (e.g. `if`, `while`, `static`) only show up under the
     * language they belong to.
     */
    describe('language split (cppreference docsets)', () => {
        function makeCpprefDocset(): DocsetInsert {
            return { ...baseDocset, source: 'cppreference', name: 'cppref' };
        }

        it('returns C++ and C as direct children of a cppreference docset', () => {
            const id = db.insertDocset(makeCpprefDocset());
            db.insertSymbols(id, [
                symInsert('vector', 'Class', 'en/cpp/container/vector.html', 'std'),
                symInsert('printf', 'Function', 'en/c/io/printf.html', null)
            ]);
            const provider = makeProvider(db);
            const docset = provider.getChildren()[0]!;
            const children = provider.getChildren(docset);
            expect(children.map((n) => (n.kind === 'language' ? n.lang : null))).toEqual(
                ['cpp', 'c']
            );
            expect(children.map((n) => (n.kind === 'language' ? n.label : null))).toEqual(
                ['C++', 'C']
            );
        });

        it('omits a language node when no symbol belongs to that language', () => {
            const id = db.insertDocset(makeCpprefDocset());
            db.insertSymbols(id, [
                symInsert('vector', 'Class', 'en/cpp/container/vector.html', 'std')
            ]);
            const provider = makeProvider(db);
            const docset = provider.getChildren()[0]!;
            const children = provider.getChildren(docset);
            expect(children.map((n) => (n.kind === 'language' ? n.lang : null))).toEqual(
                ['cpp']
            );
        });

        it('scopes categories to the selected language', () => {
            const id = db.insertDocset(makeCpprefDocset());
            db.insertSymbols(id, [
                symInsert('vector', 'Class', 'en/cpp/container/vector.html', 'std'),
                symInsert('while', 'Keyword', 'en/cpp/keyword/while.html', null),
                symInsert('printf', 'Function', 'en/c/io/printf.html', null),
                symInsert('while', 'Keyword', 'en/c/keyword/while.html', null)
            ]);
            const provider = makeProvider(db);
            const docset = provider.getChildren()[0]!;
            const langs = provider.getChildren(docset);
            const cpp = langs.find((n) => n.kind === 'language' && n.lang === 'cpp')!;
            const c = langs.find((n) => n.kind === 'language' && n.lang === 'c')!;
            const cppKinds = provider
                .getChildren(cpp)
                .map((n) => (n.kind === 'category' ? n.typeKind : null))
                .filter(Boolean);
            const cKinds = provider
                .getChildren(c)
                .map((n) => (n.kind === 'category' ? n.typeKind : null))
                .filter(Boolean);
            expect(cppKinds).toContain('Class');
            expect(cppKinds).toContain('Keyword');
            expect(cKinds).toContain('Function');
            expect(cKinds).toContain('Keyword');
            expect(cKinds).not.toContain('Class');
        });

        it('a symbol’s parent chain runs through its language node', () => {
            const id = db.insertDocset(makeCpprefDocset());
            db.insertSymbols(id, [
                symInsert('vector', 'Class', 'en/cpp/container/vector.html', 'std')
            ]);
            const provider = makeProvider(db);
            const hit = db.findSymbolByPath(id, 'en/cpp/container/vector.html')!;
            const node = provider.findNodeForSymbol(hit)!;
            const cat = provider.getParent(node);
            expect(cat?.kind).toBe('category');
            const lang = provider.getParent(cat!);
            expect(lang?.kind).toBe('language');
            expect(lang!.kind === 'language' ? lang!.lang : '').toBe('cpp');
            const docset = provider.getParent(lang!);
            expect(docset?.kind).toBe('docset');
            expect(provider.getParent(docset!)).toBeUndefined();
        });
    });
});
