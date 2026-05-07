// Unit tests for src/resolver/hover-parser.ts (M4.2 Strategy 2).
//
// Three layers under test, mirroring the source file's structure:
//   1. Pure markdown parsers (`parseClangdHover`, `parseMsCppHover`) — fed
//      hover-shaped strings copied from clangd / MS C/C++ examples in
//      docs/03-symbol-resolution.md.
//   2. Normalization helpers (`stripTemplateArgs`, `normalizeConstructor`,
//      `normalizeDestructor`, `normalizeOperator`, `normalizeFqn`).
//   3. The full strategy (`createHoverStrategy`) wired against a stub
//      `vscode` namespace that simulates `executeHoverProvider` returning
//      various hover-array shapes (own marker filtering, multi-provider
//      ordering, abort behavior, error pass-through).
//
// `vscode` is stubbed structurally — we only need the surface
// `commands.executeCommand`, `Hover` (a duck-typed `{ contents }`
// container), and `MarkdownString` (a `{ value }` container).

import { describe, expect, it, vi } from 'vitest';
import {
    createHoverStrategy,
    normalizeConstructor,
    normalizeDestructor,
    normalizeFqn,
    normalizeOperator,
    OPERATOR_NAME_MAP,
    parseClangdHover,
    parseMsCppHover,
    type HoverStrategyDeps
} from '../../src/resolver/hover-parser.js';
import { stripTemplateArgs } from '../../src/util/fqn.js';
import type { ResolveContext } from '../../src/resolver/types.js';

// ---------------------------------------------------------------------------
// Shared stubs.
// ---------------------------------------------------------------------------

interface StubMarkdown {
    value: string;
}
interface StubHover {
    contents: Array<StubMarkdown | string>;
}

function md(value: string): StubMarkdown {
    return { value };
}

function hover(...parts: Array<string | StubMarkdown>): StubHover {
    return { contents: parts.map((p) => (typeof p === 'string' ? md(p) : p)) };
}

interface StubVscode {
    commands: {
        executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
    };
}

function makeContext(signal?: AbortSignal): ResolveContext {
    const controller = new AbortController();
    return {
        document: {
            uri: { toString: () => 'file:///tmp/x.cpp' },
            version: 1,
            languageId: 'cpp',
            getText: () => ''
        } as unknown as ResolveContext['document'],
        position: { line: 0, character: 0 } as unknown as ResolveContext['position'],
        signal: signal ?? controller.signal
    };
}

function mkDeps(
    exec: (command: string, ...args: unknown[]) => Promise<unknown>,
    ownHoverMarker?: string
): HoverStrategyDeps {
    const stubVscode: StubVscode = {
        commands: { executeCommand: exec }
    };
    return {
        vscode: stubVscode as unknown as HoverStrategyDeps['vscode'],
        ownHoverMarker
    };
}

// ---------------------------------------------------------------------------
// Fixture markdown blobs — minimal but plausible shapes from real LSPs.
// ---------------------------------------------------------------------------

const CLANGD_FREE_FUNCTION = `### function std::sort

→ void

\`\`\`cpp
void sort(RandomIt first, RandomIt last);
\`\`\``;

const CLANGD_METHOD_TEMPLATED = `### method std::vector<int>::push_back

→ void

\`\`\`cpp
void push_back(const value_type& value);
\`\`\``;

const CLANGD_METHOD_NESTED_TEMPLATES = `### method std::vector<std::pair<int, int>, std::allocator<std::pair<int, int>>>::push_back

→ void

\`\`\`cpp
void push_back(const value_type& value);
\`\`\``;

const CLANGD_CONSTRUCTOR = `### constructor std::vector<int>

\`\`\`cpp
vector(size_type count);
\`\`\``;

const CLANGD_DESTRUCTOR = `### method std::list::~list

\`\`\`cpp
~list();
\`\`\``;

const CLANGD_OPERATOR = `### method std::ostream::operator<<

\`\`\`cpp
ostream& operator<<(int value);
\`\`\``;

const MSCPP_CLASS = `\`\`\`cpp
class std::vector<int>
\`\`\``;

const MSCPP_FREE_FUNCTION = `\`\`\`cpp
void std::sort(RandomIt first, RandomIt last)
\`\`\``;

const OWN_HOVER = `**cppreference** [std::vector::push_back](command:cppDocs.openSymbol)

The element is appended.`;

// Modern clangd (17+) drops the `### ` prefix from the marker line.
const CLANGD_MODERN_FREE_FUNCTION = `function std::sort

→ void

\`\`\`cpp
void sort(RandomIt first, RandomIt last);
\`\`\``;

// Modern clangd with the marker wrapped in bold emphasis.
const CLANGD_MODERN_BOLD_FUNCTION = `**function** std::sort

→ void

\`\`\`cpp
void sort(RandomIt first, RandomIt last);
\`\`\``;

// Modern clangd marker emits an unqualified identifier; the namespace is
// recovered from the `// In namespace std` hint. This is the shape from
// the user's `c.begin()` cursor-follow screenshot in iter-34's bug report.
const CLANGD_MODERN_UNQUALIFIED_NAMESPACE = `function begin

provided by \`<iterator>\`

→ <dependent type>

Parameters:
  • const _Cp & __c

// In namespace std

\`\`\`cpp
template <class _Cp>
constexpr auto begin(const _Cp & __c) -> decltype(__c.begin())
\`\`\``;

// Variable hover with explicit `Type:` line — `v` is the user's name; we
// need to look up `std::vector<int>` (template-stripped to `std::vector`).
const CLANGD_VARIABLE_EXPLICIT_TYPE = `variable v

Type: std::vector<int>

\`\`\`cpp
std::vector<int> v
\`\`\``;

// Variable hover where the type only appears in the cpp code-fence.
const CLANGD_VARIABLE_FENCE_TYPE = `variable v

\`\`\`cpp
std::vector<int> v
\`\`\``;

// Field (member variable) hover.
const CLANGD_FIELD_TYPE = `field count

Type: int

\`\`\`cpp
int count
\`\`\``;

// ---------------------------------------------------------------------------
// Layer 1: parseClangdHover
// ---------------------------------------------------------------------------

describe('parseClangdHover', () => {
    it('extracts a free-function FQN from `### function`', () => {
        const result = parseClangdHover(CLANGD_FREE_FUNCTION);
        expect(result).toEqual({
            fqn: 'std::sort',
            isConstructor: false,
            isDestructor: false
        });
    });

    it('extracts a templated method FQN from `### method`', () => {
        const result = parseClangdHover(CLANGD_METHOD_TEMPLATED);
        expect(result?.fqn).toBe('std::vector<int>::push_back');
        expect(result?.isConstructor).toBe(false);
        expect(result?.isDestructor).toBe(false);
    });

    it('handles nested template arguments in the marker line', () => {
        const result = parseClangdHover(CLANGD_METHOD_NESTED_TEMPLATES);
        expect(result?.fqn).toBe(
            'std::vector<std::pair<int, int>, std::allocator<std::pair<int, int>>>::push_back'
        );
    });

    it('flags constructors and returns the type name', () => {
        const result = parseClangdHover(CLANGD_CONSTRUCTOR);
        expect(result).toMatchObject({
            fqn: 'std::vector<int>',
            isConstructor: true,
            isDestructor: false
        });
    });

    it('flags destructors when clangd uses `### destructor`', () => {
        const md = `### destructor std::list

\`\`\`cpp
~list();
\`\`\``;
        const result = parseClangdHover(md);
        expect(result).toMatchObject({
            fqn: 'std::list',
            isConstructor: false,
            isDestructor: true
        });
    });

    it('returns the operator FQN literally', () => {
        const result = parseClangdHover(CLANGD_OPERATOR);
        expect(result?.fqn).toBe('std::ostream::operator<<');
    });

    it('falls back to the code-fence when no `### marker` is present', () => {
        const md = `\`\`\`cpp
void std::sort(int*, int*);
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('std::sort');
    });

    it('returns undefined for empty input', () => {
        expect(parseClangdHover('')).toBeUndefined();
    });

    it('returns undefined for input with no parseable shape', () => {
        expect(parseClangdHover('just some prose')).toBeUndefined();
    });

    // --- Modern clangd 17+ shapes (no `###` prefix) ---

    it('extracts an FQN from a modern bare `function` marker (no `###`)', () => {
        const result = parseClangdHover(CLANGD_MODERN_FREE_FUNCTION);
        expect(result).toMatchObject({
            fqn: 'std::sort',
            isConstructor: false,
            isDestructor: false
        });
    });

    it('extracts an FQN from a modern bold `**function**` marker', () => {
        const result = parseClangdHover(CLANGD_MODERN_BOLD_FUNCTION);
        expect(result?.fqn).toBe('std::sort');
    });

    it('prepends the namespace hint when the marker is unqualified', () => {
        // `function begin` + `// In namespace std` → `std::begin`.
        const result = parseClangdHover(CLANGD_MODERN_UNQUALIFIED_NAMESPACE);
        expect(result?.fqn).toBe('std::begin');
    });

    it('prepends the namespace hint to the code-fence fallback path too', () => {
        // No marker line at all — only the fence and a namespace hint above it.
        const md = `// In namespace std

\`\`\`cpp
void sort(int*, int*);
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('std::sort');
    });

    it('does not prepend when the marker name is already qualified', () => {
        const md = `function std::ranges::sort

// In namespace std

\`\`\`cpp
void sort(...);
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('std::ranges::sort');
    });

    // --- Variable / field hovers prefer the type ---

    it('extracts the type from a `variable` hover with explicit Type line', () => {
        const result = parseClangdHover(CLANGD_VARIABLE_EXPLICIT_TYPE);
        // Template-stripping happens downstream in normalizeFqn; the parser
        // returns the type verbatim.
        expect(result?.fqn).toBe('std::vector<int>');
    });

    it('extracts the type from a `variable` hover via the code-fence', () => {
        const result = parseClangdHover(CLANGD_VARIABLE_FENCE_TYPE);
        expect(result?.fqn).toBe('std::vector<int>');
    });

    it('extracts the type from a `field` hover', () => {
        const result = parseClangdHover(CLANGD_FIELD_TYPE);
        expect(result?.fqn).toBe('int');
    });

    it('falls back to the variable name when no type can be recovered', () => {
        const md = `variable v

(no type info available)`;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('v');
    });

    it('recognizes the hyphenated `type-alias` marker (clangd 17+)', () => {
        const md = `### type-alias std::string_view

\`\`\`cpp
using string_view = basic_string_view<char>
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('std::string_view');
    });

    it('captures the aka-decorated Type line verbatim (normalize cleans it downstream)', () => {
        // The parser's contract is to return the raw extracted string —
        // template stripping and alias-decoration handling happen in
        // `normalizeFqn`. End-to-end coverage is in the createHoverStrategy
        // suite below.
        const md = `variable sv

Type: std::basic_string_view<char> (aka std::string_view)

\`\`\`cpp
std::string_view sv
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe(
            'std::basic_string_view<char> (aka std::string_view)'
        );
    });

    // --- Expression-specifier skip (the `std::apply` / `decltype(auto)` bug) ---
    //
    // clangd's hover for `std::apply` returns a fence whose declaration line
    // is something like:
    //
    //   constexpr decltype(auto) apply(F&& f, Tuple&& t);
    //
    // The non-greedy `name(` regex would otherwise capture `decltype` and the
    // resolver would open the wrong page. parseClangdHover now skips past
    // `<specifier>(...)` runs and picks `apply`.

    it('skips a `decltype(auto)` return-type specifier to find the function name', () => {
        // Pure fence-only path: no marker line, parseDeclarationLine receives
        // the fence directly. Pre-fix this returned `decltype`.
        const md = `\`\`\`cpp
constexpr decltype(auto) apply(F&& f, Tuple&& t)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('apply');
    });

    it('skips a `noexcept(expr)` return-type specifier', () => {
        const md = `\`\`\`cpp
noexcept(noexcept(f())) foo(int x)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('foo');
    });

    it('skips a `sizeof(T)` return-type specifier', () => {
        // Synthetic but exercises the same path — `sizeof(T)` looks like a
        // function call to the regex but is a specifier we must skip.
        const md = `\`\`\`cpp
sizeof(T) foo(int x)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('foo');
    });

    it('handles nested parens inside the specifier arg', () => {
        // `decltype(std::forward<T>(t))` — nested template / function call
        // inside the specifier operand. The matching-paren scan in
        // pickFunctionNameFromLine must walk over them cleanly.
        const md = `\`\`\`cpp
constexpr decltype(std::forward<T>(t)) apply(F&& f, Tuple&& t)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('apply');
    });

    it('skips a `static_cast` expression on its own line by returning undefined', () => {
        // `static_cast<int>(x);` — a CAST expression, not a declaration.
        // No real function name precedes the parens, so the parser should
        // return undefined (and the chain proceeds). Without the specifier
        // skip, the parser would have returned `static_cast`.
        const md = `\`\`\`cpp
static_cast<int>(x);
\`\`\``;
        const result = parseClangdHover(md);
        expect(result).toBeUndefined();
    });

    it('returns undefined for a bare `decltype(auto)` line with no function', () => {
        // Edge case: just the specifier, nothing after — no function name
        // to pick. Pre-fix this would return `{ fqn: 'decltype' }`.
        const md = `\`\`\`cpp
decltype(auto)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result).toBeUndefined();
    });

    it('still recovers the function name for a plain declaration (no specifier)', () => {
        // Regression: the specifier-skip path must not break the simple case
        // where no specifier precedes the function name.
        const md = `\`\`\`cpp
void apply(int x)
\`\`\``;
        const result = parseClangdHover(md);
        expect(result?.fqn).toBe('apply');
    });
});

// ---------------------------------------------------------------------------
// Layer 1: parseMsCppHover
// ---------------------------------------------------------------------------

describe('parseMsCppHover', () => {
    it('extracts a class FQN from a code-fence', () => {
        const result = parseMsCppHover(MSCPP_CLASS);
        expect(result?.fqn).toBe('std::vector');
    });

    it('extracts a free-function FQN from a code-fence', () => {
        const result = parseMsCppHover(MSCPP_FREE_FUNCTION);
        expect(result?.fqn).toBe('std::sort');
    });

    it('returns undefined for empty input', () => {
        expect(parseMsCppHover('')).toBeUndefined();
    });

    it('returns undefined when no code-fence is present', () => {
        expect(parseMsCppHover('plain text, nothing fenced')).toBeUndefined();
    });

    // Same expression-specifier skip as parseClangdHover — MS C/C++'s hover
    // also feeds parseDeclarationLine for function-shaped fences. The bug
    // would surface identically through this path.
    it('skips `decltype(auto)` when MS C/C++ emits the same declaration shape', () => {
        const md = `\`\`\`cpp
constexpr decltype(auto) apply(F&& f, Tuple&& t)
\`\`\``;
        const result = parseMsCppHover(md);
        expect(result?.fqn).toBe('apply');
    });

    it('skips `noexcept(expr)` in MS C/C++ hover output', () => {
        const md = `\`\`\`cpp
noexcept(true) foo(int x)
\`\`\``;
        const result = parseMsCppHover(md);
        expect(result?.fqn).toBe('foo');
    });
});

// ---------------------------------------------------------------------------
// Layer 2: stripTemplateArgs
// ---------------------------------------------------------------------------

describe('stripTemplateArgs', () => {
    it('strips a single template-argument block', () => {
        expect(stripTemplateArgs('std::vector<int>')).toBe('std::vector');
    });

    it('strips nested template arguments', () => {
        expect(stripTemplateArgs('std::map<int, std::vector<float>>')).toBe('std::map');
    });

    it('strips template arguments around method names', () => {
        expect(stripTemplateArgs('Foo<Bar<Baz>>::method')).toBe('Foo::method');
    });

    it('strips clangd-shaped fully-instantiated names', () => {
        expect(
            stripTemplateArgs('std::vector<int, std::allocator<int>>::push_back')
        ).toBe('std::vector::push_back');
    });

    it('preserves names that contain no template arguments', () => {
        expect(stripTemplateArgs('std::sort')).toBe('std::sort');
    });

    // Documented behavior: unbalanced inputs (`<` without matching `>`) are
    // treated as broken hovers and the partial trailing `<...` is dropped.
    it('drops the partial trailing tail on unbalanced input', () => {
        expect(stripTemplateArgs('std::vector<int')).toBe('std::vector');
    });
});

// ---------------------------------------------------------------------------
// Layer 2: normalizeConstructor / normalizeDestructor / normalizeOperator
// ---------------------------------------------------------------------------

describe('normalizeConstructor', () => {
    it('expands a bare type name into `T::T`', () => {
        expect(normalizeConstructor('Foo', true)).toBe('Foo::Foo');
    });

    it('expands a qualified type name into `Outer::T::T`', () => {
        expect(normalizeConstructor('std::vector', true)).toBe('std::vector::vector');
    });

    it('is a no-op when isConstructor is false', () => {
        expect(normalizeConstructor('Foo', false)).toBe('Foo');
    });

    it('is a no-op for already-qualified `T::T` shapes', () => {
        expect(normalizeConstructor('std::vector::vector', true)).toBe(
            'std::vector::vector'
        );
    });
});

describe('normalizeDestructor', () => {
    it('expands `~Foo` into `Foo::~Foo`', () => {
        expect(normalizeDestructor('~Foo')).toBe('Foo::~Foo');
    });

    it('leaves an already-qualified destructor alone', () => {
        expect(normalizeDestructor('std::list::~list')).toBe('std::list::~list');
    });

    it('expands a bare type name into `T::~T` when the hint is set', () => {
        expect(normalizeDestructor('Foo', true)).toBe('Foo::~Foo');
    });
});

describe('normalizeOperator', () => {
    it('returns the operator FQN literally', () => {
        expect(normalizeOperator('std::ostream::operator<<')).toBe(
            'std::ostream::operator<<'
        );
    });

    it('keeps OPERATOR_NAME_MAP empty as a placeholder for M5/M6', () => {
        expect(Object.keys(OPERATOR_NAME_MAP)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Layer 2: normalizeFqn (full pipeline)
// ---------------------------------------------------------------------------

describe('normalizeFqn', () => {
    it('strips template args from a method', () => {
        expect(normalizeFqn('std::vector<int>::push_back')).toBe(
            'std::vector::push_back'
        );
    });

    it('strips clangd-shaped fully-instantiated method names', () => {
        expect(
            normalizeFqn(
                'std::vector<std::pair<int, int>, std::allocator<std::pair<int, int>>>::push_back'
            )
        ).toBe('std::vector::push_back');
    });

    it('expands a templated constructor into `T::T`', () => {
        expect(normalizeFqn('std::vector<int>', { isConstructor: true })).toBe(
            'std::vector::vector'
        );
    });

    it('preserves the `T::~T` form for destructors', () => {
        expect(normalizeFqn('std::list::~list')).toBe('std::list::~list');
    });

    it('expands a bare destructor hint into `T::~T`', () => {
        expect(normalizeFqn('std::list', { isDestructor: true })).toBe(
            'std::list::~list'
        );
    });

    it('preserves operators verbatim', () => {
        expect(normalizeFqn('std::ostream::operator<<')).toBe(
            'std::ostream::operator<<'
        );
    });

    // Alias-decoration handling — clangd 17+ emits "(aka X)" for type
    // aliases and the older `<canonical> <alias>` print for `Type:` lines
    // lifted out of variable hovers. Either form produced a space-joined
    // two-FQN string that the index couldn't resolve until normalizeFqn
    // learned to prefer the alias name.
    it('extracts the alias from a `(aka X)` parenthesized decoration', () => {
        expect(
            normalizeFqn('std::basic_string_view<char> (aka std::string_view)')
        ).toBe('std::string_view');
    });

    it('extracts the alias from a `(aka: X)` colon-form decoration', () => {
        expect(
            normalizeFqn('std::basic_string_view<char> (aka: std::string_view)')
        ).toBe('std::string_view');
    });

    it('extracts the alias from a bare `aka X` (no parens)', () => {
        expect(
            normalizeFqn('std::basic_string_view<char> aka std::string_view')
        ).toBe('std::string_view');
    });

    it('takes the trailing token when type and alias are space-joined', () => {
        // clangd's `<canonical> <alias>` print order — the trailing FQN is
        // the user-facing alias the index can resolve.
        expect(
            normalizeFqn('std::basic_string_view<char> std::string_view')
        ).toBe('std::string_view');
    });

    it('drops a trailing `= <type>` clause from a using-style line', () => {
        expect(normalizeFqn('std::string_view = std::basic_string_view<char>')).toBe(
            'std::string_view'
        );
    });

    it('preserves operator= (no surrounding spaces around =)', () => {
        // `operator=` has no whitespace around the `=`, so the alias-strip
        // step must not touch it.
        expect(normalizeFqn('std::vector::operator=')).toBe(
            'std::vector::operator='
        );
    });

    it('preserves operator+= and operator<=>', () => {
        expect(normalizeFqn('std::vector::operator+=')).toBe(
            'std::vector::operator+='
        );
        expect(normalizeFqn('std::vector::operator<=>')).toBe(
            'std::vector::operator<=>'
        );
    });

    it('preserves a template-bracketed name with internal whitespace at depth >0', () => {
        // The internal space between `int,` and `std::vector` is inside
        // angle brackets — depth>0 — and must not trigger the trailing-
        // token fallback.
        expect(
            normalizeFqn('std::map<int, std::vector<float>>')
        ).toBe('std::map');
    });
});

// ---------------------------------------------------------------------------
// Layer 3: createHoverStrategy
// ---------------------------------------------------------------------------

describe('createHoverStrategy', () => {
    it('returns undefined when executeHoverProvider returns []', async () => {
        const exec = vi.fn().mockResolvedValue([]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toBeUndefined();
        expect(exec).toHaveBeenCalledOnce();
    });

    it('filters out our own hover and returns undefined when only ours exists', async () => {
        const exec = vi.fn().mockResolvedValue([hover(OWN_HOVER)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toBeUndefined();
    });

    it('parses a clangd hover into a normalized FQN with source=hover', async () => {
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_METHOD_TEMPLATED)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toEqual({
            fqn: 'std::vector::push_back',
            source: 'hover'
        });
    });

    it('skips our hover and parses the next one', async () => {
        const exec = vi
            .fn()
            .mockResolvedValue([hover(OWN_HOVER), hover(CLANGD_METHOD_TEMPLATED)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::vector::push_back');
    });

    it('falls back to the MS C/C++ parser when clangd-shape misses', async () => {
        const exec = vi.fn().mockResolvedValue([hover(MSCPP_CLASS)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::vector');
    });

    it('expands constructor hovers into `T::T`', async () => {
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_CONSTRUCTOR)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::vector::vector');
    });

    it('preserves destructor `T::~T` form', async () => {
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_DESTRUCTOR)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::list::~list');
    });

    it('preserves operators literally', async () => {
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_OPERATOR)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::ostream::operator<<');
    });

    it('resolves a variable of an aliased type to the alias name', async () => {
        // End-to-end: clangd's variable hover for a `std::string_view sv`
        // typically renders the `Type:` line as either `<canonical> (aka <alias>)`
        // (modern) or `<canonical> <alias>` (older). Pre-fix this surfaced
        // the whole space-joined string as the FQN; normalizeFqn now picks
        // off the alias on the right so the index lookup succeeds.
        const md = `variable sv

Type: std::basic_string_view<char> (aka std::string_view)

\`\`\`cpp
std::string_view sv
\`\`\``;
        const exec = vi.fn().mockResolvedValue([hover(md)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::string_view');
    });

    it('recognizes the clangd 17+ `type-alias` marker (hyphen form)', async () => {
        // Modern clangd renders type aliases with a hyphen in the kind
        // keyword (`type-alias`). The space-form (`type alias`) was the
        // only spelling the regex accepted pre-fix; either should resolve.
        const md = `### type-alias std::string_view

\`\`\`cpp
using string_view = basic_string_view<char>
\`\`\``;
        const exec = vi.fn().mockResolvedValue([hover(md)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::string_view');
    });

    it('returns undefined when executeHoverProvider rejects', async () => {
        const exec = vi.fn().mockRejectedValue(new Error('boom'));
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toBeUndefined();
    });

    it('returns undefined when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const exec = vi.fn();
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext(controller.signal));
        expect(result).toBeUndefined();
        expect(exec).not.toHaveBeenCalled();
    });

    it('returns undefined when aborted while executeHoverProvider is in flight', async () => {
        const controller = new AbortController();
        let resolveExec: ((value: unknown) => void) | undefined;
        const exec = vi.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveExec = resolve;
                })
        );
        const strategy = createHoverStrategy(mkDeps(exec));
        const pending = strategy(makeContext(controller.signal));
        controller.abort();
        // Clean up the pending mock-promise so vitest doesn't complain about
        // an unresolved value; the strategy already collapsed to undefined via
        // the abort-listener race.
        resolveExec?.([]);
        const result = await pending;
        expect(result).toBeUndefined();
    });

    it('honors a custom ownHoverMarker', async () => {
        const exec = vi
            .fn()
            .mockResolvedValue([hover('@@MINE@@ filtered'), hover(CLANGD_FREE_FUNCTION)]);
        const strategy = createHoverStrategy(mkDeps(exec, '@@MINE@@'));
        const result = await strategy(makeContext());
        expect(result?.fqn).toBe('std::sort');
    });

    it('returns undefined when remaining hovers fail both parsers', async () => {
        const exec = vi.fn().mockResolvedValue([hover('plain prose, no fence')]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toBeUndefined();
    });

    // --- End-to-end: modern clangd 17+ shapes ---

    it('resolves `std::begin` end-to-end from the modern unqualified hover', async () => {
        // Mirrors the cursor-on-`begin` screenshot in the iter-34 bug report:
        // clangd 17+ emits a bare `function begin` marker plus a
        // `// In namespace std` hint. The strategy must recover `std::begin`.
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_MODERN_UNQUALIFIED_NAMESPACE)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toEqual({ fqn: 'std::begin', source: 'hover' });
    });

    it('resolves `std::vector` end-to-end from a variable hover (template stripped)', async () => {
        // User report 2: cursor on `v` where `v: std::vector<int>` should open
        // the `std::vector` page. parseClangdHover returns `std::vector<int>`,
        // normalizeFqn strips the template, the strategy returns `std::vector`.
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_VARIABLE_EXPLICIT_TYPE)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toEqual({ fqn: 'std::vector', source: 'hover' });
    });

    it('resolves `std::sort` from a modern bare-marker hover end-to-end', async () => {
        const exec = vi.fn().mockResolvedValue([hover(CLANGD_MODERN_FREE_FUNCTION)]);
        const strategy = createHoverStrategy(mkDeps(exec));
        const result = await strategy(makeContext());
        expect(result).toEqual({ fqn: 'std::sort', source: 'hover' });
    });
});
