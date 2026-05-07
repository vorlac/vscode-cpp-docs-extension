import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexDB } from '../../src/docset/index.js';
import type { DocsetInsert, SymbolInsert } from '../../src/docset/types.js';

const baseDocset: DocsetInsert = {
    name: 'cppreference',
    source: 'cppreference',
    version: '20250209',
    rootPath: '/tmp/cppref',
    documentsDir: '/tmp/cppref/reference',
    indexFormat: 'searchIndex',
    installedAt: 1_700_000_000
};

function sym(
    qn: string,
    kind: string,
    filePath: string,
    parent: string | null | undefined = undefined,
    anchor: string | null = null,
    arglist: string | null = null
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
        anchor,
        arglist
    };
}

describe('IndexDB', () => {
    let db: IndexDB;

    beforeEach(async () => {
        db = await IndexDB.open(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    it('applies schema and lists inserted docsets', () => {
        const id = db.insertDocset(baseDocset);
        expect(id).toBeGreaterThan(0);
        const all = db.listDocsets();
        expect(all).toHaveLength(1);
        expect(all[0]?.name).toBe('cppreference');
        expect(all[0]?.indexFormat).toBe('searchIndex');
        expect(all[0]?.isActive).toBe(true);
    });

    it('lookupExact finds an inserted symbol and returns the docset name', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::vector::push_back', 'Function', 'en/cpp/container/vector/push_back.html'),
            sym('std::vector::pop_back', 'Function', 'en/cpp/container/vector/pop_back.html')
        ]);
        const hit = db.lookupExact('std::vector::push_back');
        expect(hit?.filePath).toBe('en/cpp/container/vector/push_back.html');
        expect(hit?.docsetName).toBe('cppreference');
        expect(hit?.parent).toBe('std::vector');
        expect(hit?.unqualified).toBe('push_back');
    });

    it('lookupExact filters by docsetId when provided', () => {
        const a = db.insertDocset(baseDocset);
        const b = db.insertDocset({ ...baseDocset, name: 'mirror', source: 'cppreference' });
        db.insertSymbols(a, [sym('std::sort', 'Function', 'en/cpp/algorithm/sort.html')]);
        db.insertSymbols(b, [sym('std::sort', 'Function', 'mirror/sort.html')]);
        expect(db.lookupExact('std::sort', a)?.filePath).toBe('en/cpp/algorithm/sort.html');
        expect(db.lookupExact('std::sort', b)?.filePath).toBe('mirror/sort.html');
    });

    it('lookupByUnqualified ranks parent matches first then by shortest qualified name', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::sort', 'Function', 'en/cpp/algorithm/sort.html'),
            sym('std::list::sort', 'Function', 'en/cpp/container/list/sort.html'),
            sym('std::ranges::sort', 'Function', 'en/cpp/algorithm/ranges/sort.html'),
            sym('::sort', 'Function', 'en/c/sort.html', null)
        ]);
        const hits = db.lookupByUnqualified('sort', ['std']);
        expect(hits[0]?.qualifiedName).toBe('std::sort');
        // null-parent (::sort) should rank after the explicit std match
        expect(hits.find((h) => h.qualifiedName === '::sort')).toBeDefined();
        // entries whose parent is not 'std' and not null are filtered out
        expect(hits.find((h) => h.qualifiedName === 'std::list::sort')).toBeUndefined();
    });

    it('lookupByUnqualified with empty parents prefers top-level then std (M-4 fix)', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::sort', 'Function', 'std-sort.html'),
            sym('::malloc', 'Function', 'malloc.html', null),
            sym('std::isdigit', 'Function', 'cctype.html'),
            sym('foo::isdigit', 'Function', 'foo.html')
        ]);
        // Top-level beats std-scoped.
        const malloc = db.lookupByUnqualified('malloc', []);
        expect(malloc[0]?.qualifiedName).toBe('::malloc');
        // No top-level → std wins over other parents.
        const isdigit = db.lookupByUnqualified('isdigit', []);
        expect(isdigit[0]?.qualifiedName).toBe('std::isdigit');
    });

    it('lookupBest falls through to lookupByUnqualified for bare names', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::isdigit', 'Function', 'en/cpp/string/byte/isdigit.html')
        ]);
        expect(db.lookupBest('isdigit')?.qualifiedName).toBe('std::isdigit');
        expect(db.lookupBest('std::isdigit')?.qualifiedName).toBe('std::isdigit');
        expect(db.lookupBest('::missing')).toBeUndefined();
    });

    it('lookupBest with leading "::" strips the prefix and prefers the C top-level page', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            // C version (top-level — what `using ::isdigit` brings in).
            sym('isdigit', 'Function', 'en/c/string/byte/isdigit.html', null),
            // C++ wrapper.
            sym('std::isdigit', 'Function', 'en/cpp/string/byte/isdigit.html')
        ]);
        expect(db.lookupBest('::isdigit')?.filePath).toBe(
            'en/c/string/byte/isdigit.html'
        );
        // Bare name also resolves to the C top-level row first.
        expect(db.lookupBest('isdigit')?.filePath).toBe(
            'en/c/string/byte/isdigit.html'
        );
        // std-qualified continues to resolve to the C++ row.
        expect(db.lookupBest('std::isdigit')?.filePath).toBe(
            'en/cpp/string/byte/isdigit.html'
        );
    });

    it('searchPrefix returns matching qualified names ordered by length, capped by limit', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::vector', 'Class', 'en/cpp/container/vector.html'),
            sym('std::vector::push_back', 'Function', 'en/cpp/container/vector/push_back.html'),
            sym('std::vector::pop_back', 'Function', 'en/cpp/container/vector/pop_back.html'),
            sym('std::set', 'Class', 'en/cpp/container/set.html')
        ]);
        const all = db.searchPrefix('std::vector', 10);
        expect(all.map((h) => h.qualifiedName).sort()).toEqual(
            ['std::vector', 'std::vector::pop_back', 'std::vector::push_back'].sort()
        );
        const limited = db.searchPrefix('std::', 2);
        expect(limited).toHaveLength(2);
        expect(limited[0]?.qualifiedName).toBe('std::set');
    });

    it('searchPrefix matches only true prefixes (range comparison, not LIKE wildcards)', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::vector::push_back', 'Function', 'a.html'),
            sym('std::vectorXpush_back', 'Function', 'b.html')
        ]);
        // Range form: prefix <= qualified_name < prefix+sentinel. `std::vectorX…`
        // sorts past `std::vector::p…` so only the true prefix match is returned.
        const hits = db.searchPrefix('std::vector::p', 10);
        expect(hits.map((h) => h.qualifiedName).sort()).toEqual([
            'std::vector::push_back'
        ]);
    });

    it('searchPrefix returns rows in BINARY-collation order via the BTREE range scan', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [
            sym('std::map', 'Class', 'map.html'),
            sym('std::multimap', 'Class', 'multimap.html'),
            sym('std::map_extra', 'Function', 'map_extra.html')
        ]);
        const hits = db.searchPrefix('std::m', 10);
        // ORDER BY length asc, then name asc — shortest prefix-matches first.
        expect(hits.map((h) => h.qualifiedName)).toEqual([
            'std::map',
            'std::multimap',
            'std::map_extra'
        ]);
    });

    it('removeDocset cascades to symbols and is reflected by listDocsets', () => {
        const id = db.insertDocset(baseDocset);
        db.insertSymbols(id, [sym('std::sort', 'Function', 'sort.html')]);
        db.removeDocset(id);
        expect(db.listDocsets()).toHaveLength(0);
        expect(db.lookupExact('std::sort')).toBeUndefined();
    });

    it('lookupExact ignores docsets with is_active = 0 when no docsetId is given', () => {
        const a = db.insertDocset(baseDocset);
        const b = db.insertDocset({ ...baseDocset, name: 'inactive', isActive: false });
        db.insertSymbols(a, [sym('std::sort', 'Function', 'a.html')]);
        db.insertSymbols(b, [sym('std::sort', 'Function', 'b.html')]);
        expect(db.lookupExact('std::sort')?.filePath).toBe('a.html');
        // But you can still pull from an inactive docset by id
        expect(db.lookupExact('std::sort', b)?.filePath).toBe('b.html');
    });

    it('parameterized inserts handle apostrophes in identifiers', () => {
        const id = db.insertDocset(baseDocset);
        const qn = "std::operator''";
        db.insertSymbols(id, [sym(qn, 'Function', 'en/cpp/string/literals.html')]);
        expect(db.lookupExact(qn)?.qualifiedName).toBe(qn);
    });

    describe('searchSymbolsForFilter', () => {
        it('matches case-insensitively', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('std::vector::push_back', 'Function', 'a.html'),
                sym('std::vector::pop_back', 'Function', 'b.html')
            ]);
            const lower = db.searchSymbolsForFilter('push_back', 100);
            const upper = db.searchSymbolsForFilter('PUSH_BACK', 100);
            const mixed = db.searchSymbolsForFilter('Push_Back', 100);
            expect(lower.map((h) => h.qualifiedName)).toEqual([
                'std::vector::push_back'
            ]);
            expect(upper.map((h) => h.qualifiedName)).toEqual([
                'std::vector::push_back'
            ]);
            expect(mixed.map((h) => h.qualifiedName)).toEqual([
                'std::vector::push_back'
            ]);
        });

        it('treats % in the filter as a literal character (escaped)', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('foo%bar', 'Function', 'a.html'),
                sym('fooxbar', 'Function', 'b.html'),
                sym('foozzzbar', 'Function', 'c.html')
            ]);
            const hits = db.searchSymbolsForFilter('%', 100);
            expect(hits.map((h) => h.qualifiedName)).toEqual(['foo%bar']);
        });

        it('treats _ in the filter as a literal character (escaped)', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('foo_bar', 'Function', 'a.html'),
                sym('fooxbar', 'Function', 'b.html'),
                sym('foo!bar', 'Function', 'c.html')
            ]);
            const hits = db.searchSymbolsForFilter('_', 100);
            expect(hits.map((h) => h.qualifiedName).sort()).toEqual(['foo_bar']);
        });

        it('treats backslash in the filter as a literal character (escaped)', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('a\\b', 'Function', 'a.html'),
                sym('axb', 'Function', 'b.html')
            ]);
            const hits = db.searchSymbolsForFilter('\\', 100);
            expect(hits.map((h) => h.qualifiedName)).toEqual(['a\\b']);
        });

        it('caps results at the supplied limit', () => {
            const id = db.insertDocset(baseDocset);
            const rows: SymbolInsert[] = [];
            for (let i = 0; i < 50; i++) {
                rows.push(sym(`std::vector::m${i}`, 'Function', `m${i}.html`));
            }
            db.insertSymbols(id, rows);
            const limited = db.searchSymbolsForFilter('std::vector::m', 5);
            expect(limited).toHaveLength(5);
        });

        it('excludes inactive docsets from filter results', () => {
            const a = db.insertDocset(baseDocset);
            const b = db.insertDocset({
                ...baseDocset,
                name: 'inactive',
                isActive: false
            });
            db.insertSymbols(a, [sym('std::vector::push_back', 'Function', 'a.html')]);
            db.insertSymbols(b, [sym('std::vector::push_back', 'Function', 'b.html')]);
            const hits = db.searchSymbolsForFilter('push_back', 100);
            expect(hits.map((h) => h.docsetId)).toEqual([a]);
        });

        it('returns docsetId, kind, parent, qualifiedName, symbolId for downstream filtering', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('std::vector::push_back', 'Function', 'a.html')
            ]);
            const hits = db.searchSymbolsForFilter('push_back', 100);
            expect(hits).toHaveLength(1);
            const h = hits[0]!;
            expect(h.docsetId).toBe(id);
            expect(h.kind).toBe('Function');
            expect(h.parent).toBe('std::vector');
            expect(h.qualifiedName).toBe('std::vector::push_back');
            expect(h.symbolId).toBeGreaterThan(0);
        });
    });

    describe('findSymbolByPath', () => {
        it('returns the symbol row for an existing (docset_id, file_path) pair', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym(
                    'std::vector::push_back',
                    'Function',
                    'en/cpp/container/vector/push_back.html'
                )
            ]);
            const hit = db.findSymbolByPath(
                id,
                'en/cpp/container/vector/push_back.html'
            );
            expect(hit).toBeDefined();
            expect(hit!.qualifiedName).toBe('std::vector::push_back');
            expect(hit!.docsetId).toBe(id);
            expect(hit!.kind).toBe('Function');
        });

        it('returns undefined when no row matches the (docset_id, file_path) pair', () => {
            const id = db.insertDocset(baseDocset);
            db.insertSymbols(id, [
                sym('std::vector::push_back', 'Function', 'a/push_back.html')
            ]);
            expect(db.findSymbolByPath(id, 'does/not/exist.html')).toBeUndefined();
            // Wrong docset id but correct path — also a miss.
            expect(db.findSymbolByPath(id + 999, 'a/push_back.html')).toBeUndefined();
        });

        it('with multiple rows sharing file_path, prefers the shorter qualified_name', () => {
            const id = db.insertDocset(baseDocset);
            // Synthesize an overlap: an owner symbol and a member
            // symbol both reference the same html file. The owner's name is
            // shorter, so it wins.
            db.insertSymbols(id, [
                sym(
                    'std::vector::push_back',
                    'Method',
                    'en/cpp/container/vector/push_back.html'
                ),
                sym('std::vector', 'Class', 'en/cpp/container/vector/push_back.html')
            ]);
            const hit = db.findSymbolByPath(
                id,
                'en/cpp/container/vector/push_back.html'
            );
            expect(hit).toBeDefined();
            expect(hit!.qualifiedName).toBe('std::vector');
        });
    });
});
