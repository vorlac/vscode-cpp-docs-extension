import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { IndexDB } from '../../src/docset/index.js';
import {
    collectCInsertsFromDisk,
    collectDiskInserts,
    collectInserts,
    extractTitleTokens,
    indexTagXml,
    resolveDiskSymbol
} from '../../src/docset/cppreference-indexer.js';

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tagfile>
  <compound kind="namespace">
    <name>std</name>
    <member kind="function">
      <name>sort</name>
      <anchorfile>en/cpp/algorithm/sort.html</anchorfile>
      <anchor></anchor>
      <arglist>(RandomIt first, RandomIt last)</arglist>
    </member>
    <member kind="enumeration">
      <name>cv_status</name>
      <anchorfile>en/cpp/thread/cv_status.html</anchorfile>
      <anchor></anchor>
      <arglist></arglist>
    </member>
    <member kind="variable">
      <name>endl</name>
      <anchorfile>en/cpp/io/endl.html</anchorfile>
      <anchor></anchor>
      <arglist></arglist>
    </member>
  </compound>
  <compound kind="class">
    <name>std::vector</name>
    <filename>cpp/container/vector</filename>
    <member kind="function">
      <name>push_back</name>
      <anchorfile>en/cpp/container/vector/push_back.html</anchorfile>
      <anchor></anchor>
      <arglist>(const T&amp; value)</arglist>
    </member>
    <member kind="function">
      <name>pop_back</name>
      <anchorfile>en/cpp/container/vector/pop_back.html</anchorfile>
      <anchor></anchor>
      <arglist>()</arglist>
    </member>
    <member kind="typedef">
      <name>iterator</name>
      <anchorfile>en/cpp/container/vector.html</anchorfile>
      <anchor>iterator</anchor>
      <arglist></arglist>
    </member>
    <member kind="friend">
      <name>operator==</name>
      <anchorfile>en/cpp/container/vector/operator_cmp.html</anchorfile>
      <anchor></anchor>
      <arglist></arglist>
    </member>
  </compound>
  <compound kind="file">
    <name>algorithm</name>
    <namespace>std::ranges</namespace>
    <member kind="function">
      <name>find_if</name>
      <anchorfile>en/cpp/algorithm/ranges/find.html</anchorfile>
      <anchor></anchor>
      <arglist></arglist>
    </member>
    <member kind="define">
      <name>__cpp_lib_ranges</name>
      <anchorfile>en/cpp/feature_test.html</anchorfile>
      <anchor>cpp_lib_ranges</anchor>
      <arglist></arglist>
    </member>
  </compound>
</tagfile>
`;

describe('cppreference-indexer collectInserts', () => {
    let tmp: string;
    let xmlPath: string;

    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-indexer-'));
        xmlPath = path.join(tmp, 'sample.tag.xml');
        await writeFile(xmlPath, FIXTURE_XML, 'utf8');
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('emits a Function row for namespace members', async () => {
        const inserts = await collectInserts(xmlPath);
        const sort = inserts.find((s) => s.qualifiedName === 'std::sort');
        expect(sort).toBeDefined();
        expect(sort?.kind).toBe('Function');
        expect(sort?.parent).toBe('std');
        expect(sort?.filePath).toBe('en/cpp/algorithm/sort.html');
        expect(sort?.arglist).toBe('(RandomIt first, RandomIt last)');
    });

    it('emits a Method row when a function is inside a class compound', async () => {
        const inserts = await collectInserts(xmlPath);
        const push = inserts.find((s) => s.qualifiedName === 'std::vector::push_back');
        expect(push).toBeDefined();
        expect(push?.kind).toBe('Method');
        expect(push?.parent).toBe('std::vector');
    });

    it('emits a Class row for class compounds with a derived en/<filename>.html path', async () => {
        const inserts = await collectInserts(xmlPath);
        const cls = inserts.find(
            (s) => s.qualifiedName === 'std::vector' && s.kind === 'Class'
        );
        expect(cls).toBeDefined();
        expect(cls?.filePath).toBe('en/cpp/container/vector.html');
        expect(cls?.parent).toBe('std');
    });

    it('honors the kind="file" namespace conditional for member parents', async () => {
        const inserts = await collectInserts(xmlPath);
        const findIf = inserts.find((s) => s.qualifiedName === 'std::ranges::find_if');
        expect(findIf).toBeDefined();
        expect(findIf?.parent).toBe('std::ranges');
        expect(findIf?.kind).toBe('Function');
        const macro = inserts.find((s) => s.qualifiedName === 'std::ranges::__cpp_lib_ranges');
        expect(macro?.kind).toBe('Macro');
    });

    it('does not silently drop typedef, enumeration, define, friend, or variable members', async () => {
        const inserts = await collectInserts(xmlPath);
        const kinds = new Set(inserts.map((s) => s.kind));
        for (const expected of ['Function', 'Method', 'Type', 'Enum', 'Macro', 'Friend', 'Variable', 'Class']) {
            expect(kinds).toContain(expected);
        }
    });

    it('handles XML entity decoding in arglist', async () => {
        const inserts = await collectInserts(xmlPath);
        const push = inserts.find((s) => s.qualifiedName === 'std::vector::push_back');
        expect(push?.arglist).toBe('(const T& value)');
    });

    it('picks up adjacent <member> siblings (no SAX sibling-skipping)', async () => {
        const inserts = await collectInserts(xmlPath);
        expect(
            inserts.filter((s) => s.parent === 'std::vector' && s.kind === 'Method').map((s) => s.unqualified).sort()
        ).toEqual(['pop_back', 'push_back']);
    });
});

describe('cppreference-indexer cleans (<header>) suffix from member names', () => {
    let tmp: string;
    let xmlPath: string;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-indexer-clean-'));
        xmlPath = path.join(tmp, 'sample.tag.xml');
        await writeFile(
            xmlPath,
            `<?xml version="1.0" encoding="UTF-8"?>
<tagfile>
  <compound kind="file">
    <name>cctype</name>
    <namespace>std</namespace>
    <member kind="function">
      <name>isdigit (&lt;cctype&gt;)</name>
      <anchorfile>en/cpp/string/byte/isdigit.html</anchorfile>
      <anchor></anchor>
      <arglist>(int ch)</arglist>
    </member>
  </compound>
</tagfile>
`,
            'utf8'
        );
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('strips the doxygen "(<header>)" suffix so lookupExact("std::isdigit") matches', async () => {
        const inserts = await collectInserts(xmlPath);
        const isdigit = inserts.find((s) => s.qualifiedName === 'std::isdigit');
        expect(isdigit).toBeDefined();
        expect(isdigit?.unqualified).toBe('isdigit');
        expect(isdigit?.parent).toBe('std');
        expect(isdigit?.filePath).toBe('en/cpp/string/byte/isdigit.html');
    });
});

describe('cppreference-indexer indexTagXml -> IndexDB', () => {
    let tmp: string;
    let xmlPath: string;
    let db: IndexDB;
    let docsetId: number;

    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-indexer-db-'));
        xmlPath = path.join(tmp, 'sample.tag.xml');
        await writeFile(xmlPath, FIXTURE_XML, 'utf8');
        db = await IndexDB.open(':memory:');
        docsetId = db.insertDocset({
            name: 'cppreference',
            source: 'cppreference',
            version: '99999999',
            rootPath: tmp,
            documentsDir: path.join(tmp, 'reference'),
            indexFormat: 'searchIndex',
            installedAt: 1
        });
    });
    afterAll(async () => {
        db.close();
        await rm(tmp, { recursive: true });
    });

    it('writes rows into the symbols table that lookupExact can resolve', async () => {
        const result = await indexTagXml(xmlPath, db, docsetId);
        expect(result.inserted).toBeGreaterThan(0);
        expect(result.byKind['Method']).toBeGreaterThan(0);
        const hit = db.lookupExact('std::vector::push_back', docsetId);
        expect(hit?.filePath).toBe('en/cpp/container/vector/push_back.html');
        expect(hit?.kind).toBe('Method');
    });
});

describe('cppreference-indexer C content scanner', () => {
    let tmp: string;
    let documentsDir: string;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-indexer-c-'));
        documentsDir = path.join(tmp, 'reference');
        const cByteDir = path.join(documentsDir, 'en', 'c', 'string', 'byte');
        const cIoDir = path.join(documentsDir, 'en', 'c', 'io');
        await mkdir(cByteDir, { recursive: true });
        await mkdir(cIoDir, { recursive: true });
        await writeFile(
            path.join(cByteDir, 'isdigit.html'),
            '<html><head><title>isdigit - cppreference.com</title></head><body>...</body></html>',
            'utf8'
        );
        await writeFile(
            path.join(cIoDir, 'fclose.html'),
            '<html><head><title>fclose - cppreference.com</title></head><body>...</body></html>',
            'utf8'
        );
        // Multi-name page (cppreference uses these for sibling overloads).
        await writeFile(
            path.join(cIoDir, 'printf.html'),
            '<html><head><title>printf, fprintf, sprintf - cppreference.com</title></head></html>',
            'utf8'
        );
        // TOC-style page that doubles as a sibling-dir name.
        await writeFile(
            path.join(documentsDir, 'en', 'c', 'string', 'byte.html'),
            '<html><head><title>Null-terminated byte strings - cppreference.com</title></head></html>',
            'utf8'
        );
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('emits a top-level row for each C reference page', async () => {
        const inserts = await collectCInsertsFromDisk(documentsDir);
        const isdigit = inserts.find((s) => s.qualifiedName === 'isdigit');
        expect(isdigit).toBeDefined();
        expect(isdigit?.parent).toBeNull();
        expect(isdigit?.kind).toBe('Function');
        expect(isdigit?.filePath).toBe('en/c/string/byte/isdigit.html');
        const fclose = inserts.find((s) => s.qualifiedName === 'fclose');
        expect(fclose?.filePath).toBe('en/c/io/fclose.html');
    });

    it('takes the first comma-separated name from multi-symbol page titles', async () => {
        const inserts = await collectCInsertsFromDisk(documentsDir);
        const printf = inserts.find((s) => s.qualifiedName === 'printf');
        expect(printf).toBeDefined();
        expect(printf?.filePath).toBe('en/c/io/printf.html');
    });

    it('skips C section landing pages (TOC pages paired with a same-name sibling directory)', async () => {
        // C has no namespaces — `en/c/string/byte.html` (overview for the
        // `en/c/string/byte/` subsection) is a category landing page, not a
        // symbol. The C catch-all rule carries skipToc:true so these pages
        // are omitted entirely rather than appearing as spurious Namespace entries.
        const inserts = await collectCInsertsFromDisk(documentsDir);
        const overview = inserts.find((s) => s.filePath === 'en/c/string/byte.html');
        expect(overview).toBeUndefined();
    });

    it('returns an empty array when documentsDir/en/c does not exist', async () => {
        const empty = await mkdtemp(path.join(tmpdir(), 'cpp-indexer-c-empty-'));
        try {
            const inserts = await collectCInsertsFromDisk(empty);
            expect(inserts).toEqual([]);
        } finally {
            await rm(empty, { recursive: true });
        }
    });
});

describe('extractTitleTokens', () => {
    it('strips the "- cppreference.com" suffix', () => {
        expect(extractTitleTokens('std::sort - cppreference.com')).toEqual(['std::sort']);
    });

    it('splits multi-symbol pages into separate tokens', () => {
        expect(
            extractTitleTokens('std::find, std::find_if, std::find_if_not - cppreference.com')
        ).toEqual(['std::find', 'std::find_if', 'std::find_if_not']);
    });

    it('strips the supplied prefix regex (e.g. "C++ named requirements: ")', () => {
        expect(
            extractTitleTokens(
                'C++ named requirements: Container - cppreference.com',
                /^C\+\+\s+named\s+requirements?:\s+/i
            )
        ).toEqual(['Container']);
    });

    it('strips trailing (<header>) annotations', () => {
        expect(
            extractTitleTokens('std::isdigit (<cctype>) - cppreference.com')
        ).toEqual(['std::isdigit']);
    });

    it('drops empty tokens from comma noise', () => {
        expect(extractTitleTokens('std::a, , std::b - cppreference.com')).toEqual([
            'std::a',
            'std::b'
        ]);
    });
});

describe('resolveDiskSymbol', () => {
    it('takes scope from the token when "::" is present', () => {
        expect(resolveDiskSymbol('std::ranges::sort', 'en/cpp/', 'std')).toEqual({
            qualifiedName: 'std::ranges::sort',
            unqualified: 'sort',
            parent: 'std::ranges'
        });
    });

    it('uses the rule parent for bare cpp/ identifiers', () => {
        expect(resolveDiskSymbol('sort', 'en/cpp/', 'std')).toEqual({
            qualifiedName: 'std::sort',
            unqualified: 'sort',
            parent: 'std'
        });
    });

    it('keeps c/ identifiers top-level even when rule parent is set', () => {
        expect(resolveDiskSymbol('isdigit', 'en/c/', null)).toEqual({
            qualifiedName: 'isdigit',
            unqualified: 'isdigit',
            parent: null
        });
    });

    it('returns undefined for prose tokens', () => {
        expect(resolveDiskSymbol('Conditional inclusion', 'en/cpp/preprocessor/', null)).toBeUndefined();
    });

    it('passes operator overloads through verbatim', () => {
        const result = resolveDiskSymbol('operator<<', 'en/cpp/', 'std');
        expect(result?.qualifiedName).toBe('std::operator<<');
    });
});

describe('collectDiskInserts — multi-subtree coverage', () => {
    let tmp: string;
    let documentsDir: string;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-disk-walker-'));
        documentsDir = path.join(tmp, 'reference');
        const langDir = path.join(documentsDir, 'en', 'cpp', 'language');
        const reqDir = path.join(documentsDir, 'en', 'cpp', 'named_req');
        const conceptsDir = path.join(documentsDir, 'en', 'cpp', 'concepts');
        const headerDir = path.join(documentsDir, 'en', 'cpp', 'header');
        const keywordCppDir = path.join(documentsDir, 'en', 'cpp', 'keyword');
        const indexDir = path.join(documentsDir, 'en', 'cpp', 'symbol_index');
        const algoDir = path.join(documentsDir, 'en', 'cpp', 'algorithm');
        const cIoDir = path.join(documentsDir, 'en', 'c', 'io');
        // Regression: cppreference's offline dump puts a handful of
        // keyword pages under PLURAL `keywords/` and under
        // `identifier_with_special_meaning/`. The indexer must bucket
        // those as Keyword rows with parent=null, not let them fall
        // through to the catch-all `en/cpp/` rule (which would record
        // them as `std::<name>` with kind=Function).
        const keywordsPluralDir = path.join(
            documentsDir,
            'en',
            'cpp',
            'keywords'
        );
        const iwsmDir = path.join(
            documentsDir,
            'en',
            'cpp',
            'identifier_with_special_meaning'
        );
        await mkdir(langDir, { recursive: true });
        await mkdir(reqDir, { recursive: true });
        await mkdir(conceptsDir, { recursive: true });
        await mkdir(headerDir, { recursive: true });
        await mkdir(keywordCppDir, { recursive: true });
        await mkdir(keywordsPluralDir, { recursive: true });
        await mkdir(iwsmDir, { recursive: true });
        await mkdir(indexDir, { recursive: true });
        await mkdir(algoDir, { recursive: true });
        await mkdir(cIoDir, { recursive: true });
        await writeFile(
            path.join(langDir, 'auto.html'),
            '<html><head><title>Placeholder type specifiers (since C++11) - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(reqDir, 'Container.html'),
            '<html><head><title>C++ named requirements: Container - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(conceptsDir, 'integral.html'),
            '<html><head><title>std::integral - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(headerDir, 'vector.html'),
            '<html><head><title>Standard library header &lt;vector&gt; - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(keywordCppDir, 'auto.html'),
            '<html><head><title>C++ keyword: auto - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(indexDir, 'index.html'),
            '<html><head><title>Symbol index - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(algoDir, 'find.html'),
            '<html><head><title>std::find, std::find_if, std::find_if_not - cppreference.com</title></head></html>',
            'utf8'
        );
        await writeFile(
            path.join(cIoDir, 'fclose.html'),
            '<html><head><title>fclose - cppreference.com</title></head></html>',
            'utf8'
        );
        // PLURAL `keywords/` — cppreference 20250209 puts `typename.html`,
        // `if.html`, `static.html` here. Same title pattern as singular.
        await writeFile(
            path.join(keywordsPluralDir, 'typename.html'),
            '<html><head><title>C++ keywords: typename - cppreference.com</title></head></html>',
            'utf8'
        );
        // identifier_with_special_meaning/ — cppreference uses this dir
        // for `final.html`, `override.html`, `module.html`, `import.html`.
        // Titles vary (no consistent prefix), so the rule has no
        // titlePrefix; the disk walker falls through to the URL-stem
        // fallback when the title isn't a clean identifier.
        await writeFile(
            path.join(iwsmDir, 'module.html'),
            '<html><head><title>module - cppreference.com</title></head></html>',
            'utf8'
        );
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('emits a Language row for cpp/language/ pages with parent=null', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const auto = inserts.find(
            (s) => s.filePath === 'en/cpp/language/auto.html'
        );
        expect(auto?.qualifiedName).toBe('auto');
        expect(auto?.kind).toBe('Language');
        expect(auto?.parent).toBeNull();
    });

    it('emits a Requirement row for cpp/named_req/ pages, stripping the title prefix', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const container = inserts.find(
            (s) => s.filePath === 'en/cpp/named_req/Container.html'
        );
        expect(container?.qualifiedName).toBe('Container');
        expect(container?.kind).toBe('Requirement');
        expect(container?.parent).toBeNull();
    });

    it('emits a Concept row for cpp/concepts/ pages under std::', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const integral = inserts.find(
            (s) => s.filePath === 'en/cpp/concepts/integral.html'
        );
        expect(integral?.qualifiedName).toBe('std::integral');
        expect(integral?.kind).toBe('Concept');
        expect(integral?.parent).toBe('std');
    });

    it('emits a Header row for cpp/header/ pages with parent=null', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const vec = inserts.find(
            (s) => s.filePath === 'en/cpp/header/vector.html'
        );
        expect(vec?.qualifiedName).toBe('vector');
        expect(vec?.kind).toBe('Header');
    });

    it('emits a Keyword row for cpp/keyword/ pages, stripping "C++ keyword: "', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const auto = inserts.find(
            (s) => s.filePath === 'en/cpp/keyword/auto.html'
        );
        expect(auto?.qualifiedName).toBe('auto');
        expect(auto?.kind).toBe('Keyword');
    });

    // Regression: cppreference's 2025-02-09 dump ships `typename.html`,
    // `if.html`, `static.html` under PLURAL `cpp/keywords/`. The
    // singular `cpp/keyword/` rule didn't match these paths, so they
    // fell through to the catch-all `cpp/` rule and got recorded as
    // `std::typename` / `std::if` / `std::static` with kind=Function.
    // The plural-rule fix is what makes the keyword strategy resolve
    // `typename` to its docs page.
    it('emits a Keyword row for cpp/keywords/ (PLURAL) pages with parent=null', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const tn = inserts.find(
            (s) => s.filePath === 'en/cpp/keywords/typename.html'
        );
        expect(tn?.qualifiedName).toBe('typename');
        expect(tn?.kind).toBe('Keyword');
        expect(tn?.parent).toBeNull();
        // Sanity: there must NOT be a `std::typename` row for the same
        // file — the plural rule has higher priority than the catch-all
        // and produces exactly one row.
        const stdTypename = inserts.find(
            (s) => s.qualifiedName === 'std::typename'
        );
        expect(stdTypename).toBeUndefined();
    });

    it('emits a Keyword row for cpp/identifier_with_special_meaning/ pages with parent=null', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const mod = inserts.find(
            (s) =>
                s.filePath === 'en/cpp/identifier_with_special_meaning/module.html'
        );
        expect(mod?.qualifiedName).toBe('module');
        expect(mod?.kind).toBe('Keyword');
        expect(mod?.parent).toBeNull();
        const stdModule = inserts.find((s) => s.qualifiedName === 'std::module');
        expect(stdModule).toBeUndefined();
    });

    it('skips cpp/symbol_index/ pages entirely', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        expect(
            inserts.find((s) => s.filePath.startsWith('en/cpp/symbol_index/'))
        ).toBeUndefined();
    });

    it('emits one row per comma-separated token for multi-symbol pages', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const findRows = inserts.filter(
            (s) => s.filePath === 'en/cpp/algorithm/find.html'
        );
        expect(findRows.map((r) => r.qualifiedName).sort()).toEqual([
            'std::find',
            'std::find_if',
            'std::find_if_not'
        ]);
    });

    it('still indexes en/c/ pages as top-level (regression)', async () => {
        const inserts = await collectDiskInserts(documentsDir);
        const fclose = inserts.find(
            (s) => s.filePath === 'en/c/io/fclose.html'
        );
        expect(fclose?.qualifiedName).toBe('fclose');
        expect(fclose?.parent).toBeNull();
    });

    it('skips pages already present in the alreadyIndexedPaths set', async () => {
        const dedup = new Set(['en/cpp/algorithm/find.html']);
        const inserts = await collectDiskInserts(documentsDir, dedup);
        expect(
            inserts.find((s) => s.filePath === 'en/cpp/algorithm/find.html')
        ).toBeUndefined();
        // Other pages are still emitted.
        expect(
            inserts.find((s) => s.filePath === 'en/cpp/header/vector.html')
        ).toBeDefined();
    });
});

describe('preprocessor directive indexing', () => {
    it('emits one Directive row per directive name for every preprocessor page (cpp + c)', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'cppref-pp-'));
        try {
            // Mirror cppreference's preprocessor page basenames for both
            // languages. Title content is intentionally prose — exactly what
            // cppreference ships — so this test proves the indexer does NOT
            // rely on titles for these pages.
            const pages = [
                ['en/cpp/preprocessor/conditional.html', 'Conditional inclusion'],
                ['en/cpp/preprocessor/replace.html', 'Replacing text macros'],
                ['en/cpp/preprocessor/include.html', 'Source file inclusion'],
                ['en/cpp/preprocessor/error.html', 'Diagnostic directives'],
                ['en/cpp/preprocessor/impl.html', 'Implementation defined behavior control'],
                ['en/cpp/preprocessor/line.html', 'Filename and line information'],
                ['en/cpp/preprocessor/embed.html', 'Binary resource inclusion'],
                ['en/c/preprocessor/conditional.html', 'Conditional inclusion'],
                ['en/c/preprocessor/replace.html', 'Replacing text macros'],
                ['en/c/preprocessor/include.html', 'Source file inclusion'],
                ['en/c/preprocessor/error.html', 'Diagnostic directives'],
                ['en/c/preprocessor/impl.html', 'Implementation defined behavior control'],
                ['en/c/preprocessor/line.html', 'Filename and line information'],
                ['en/c/preprocessor/embed.html', 'Binary resource inclusion']
            ] as const;
            for (const [rel, title] of pages) {
                const full = path.join(dir, rel);
                await mkdir(path.dirname(full), { recursive: true });
                await writeFile(
                    full,
                    `<html><head><title>${title} - cppreference.com</title></head><body></body></html>`,
                    'utf8'
                );
            }

            const inserts = await collectDiskInserts(dir);

            const expected = [
                'if', 'ifdef', 'ifndef', 'elif', 'elifdef', 'elifndef', 'else', 'endif',
                'define', 'undef', 'include', 'error', 'warning', 'pragma', 'line', 'embed'
            ];
            for (const lang of ['cpp', 'c'] as const) {
                const langRows = inserts.filter(
                    (i) => i.kind === 'Directive' && i.filePath.startsWith(`en/${lang}/preprocessor/`)
                );
                const names = new Set(langRows.map((i) => i.qualifiedName));
                for (const d of expected) {
                    expect(names, `${lang}: missing #${d}`).toContain(d);
                }
                for (const row of langRows) {
                    expect(row.filePath).toMatch(new RegExp(`^en/${lang}/preprocessor/[a-z]+\\.html$`));
                    expect(row.parent).toBeNull();
                    expect(row.unqualified).toBe(row.qualifiedName);
                }
                const conditional = langRows.filter(
                    (i) => i.filePath === `en/${lang}/preprocessor/conditional.html`
                );
                expect(conditional.map((i) => i.qualifiedName).sort()).toEqual(
                    ['elif', 'elifdef', 'elifndef', 'else', 'endif', 'if', 'ifdef', 'ifndef']
                );
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
