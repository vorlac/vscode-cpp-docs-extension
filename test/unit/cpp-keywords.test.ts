// Unit tests for the shared keyword sets in `src/resolver/cpp-keywords.ts`.
//
// These tests pin down:
//   1. KEYWORDS_TO_SKIP — coverage of canonical C++ keywords. The set
//      is consumed by both the front-of-chain keyword strategy and
//      the fallback strategy's keyword rescue. Drift between them was
//      the bug that motivated extracting this module; the tests are a
//      back-stop against that.
//   2. EXPRESSION_SPECIFIERS — the subset that takes a paren-arg
//      (`decltype(auto)`, `sizeof(T)`, `noexcept(expr)`, the four
//      `*_cast` operators, and the GCC/Clang underscore-prefixed
//      vendor variants). The hover-parser and definition-walker use
//      this to skip past `<specifier>(...)` runs when scanning a
//      declaration line for the function name.
//   3. EXPRESSION_SPECIFIERS ⊆ KEYWORDS_TO_SKIP — every expression
//      specifier must also be a keyword (the keyword-skip path is the
//      first gate the fallback applies).
//   4. isExpressionSpecifier — pure predicate sanity check.
//
// The sets are intentionally hand-maintained rather than generated;
// the tests document the expected contents.

import { describe, expect, it } from 'vitest';
import {
    EXPRESSION_SPECIFIERS,
    KEYWORDS_TO_SKIP,
    isExpressionSpecifier
} from '../../src/resolver/cpp-keywords.js';

describe('KEYWORDS_TO_SKIP', () => {
    it('includes canonical control-flow keywords', () => {
        for (const kw of ['if', 'else', 'for', 'while', 'do', 'switch',
            'case', 'default', 'break', 'continue',
            'return', 'goto', 'try', 'catch', 'throw']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes storage / type / declaration specifiers', () => {
        for (const kw of ['static', 'inline', 'constexpr', 'consteval',
            'constinit', 'const', 'volatile', 'mutable',
            'virtual', 'explicit', 'extern', 'using',
            'namespace', 'typedef', 'thread_local']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes type / scope keywords', () => {
        for (const kw of ['auto', 'class', 'struct', 'union', 'enum',
            'template', 'typename', 'concept', 'requires']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes expression keywords (sizeof / decltype / noexcept / typeid / alignof)', () => {
        for (const kw of ['sizeof', 'decltype', 'noexcept', 'typeid',
            'alignof', 'alignas']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes all four `*_cast` operators', () => {
        for (const kw of ['static_cast', 'dynamic_cast', 'const_cast',
            'reinterpret_cast']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes literal / `this` keywords', () => {
        for (const kw of ['true', 'false', 'nullptr', 'this']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes alternative operator-token spellings', () => {
        for (const kw of ['and', 'or', 'not', 'xor', 'bitand', 'bitor',
            'compl', 'and_eq', 'or_eq', 'xor_eq', 'not_eq']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes coroutine keywords (C++20)', () => {
        for (const kw of ['co_await', 'co_yield', 'co_return']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('includes module keywords (C++20)', () => {
        for (const kw of ['export', 'module', 'import']) {
            expect(KEYWORDS_TO_SKIP.has(kw)).toBe(true);
        }
    });

    it('does not contain identifiers that aren’t keywords', () => {
        // Sanity check the negative side — these are common identifiers
        // a user might cursor onto, and they must NOT short-circuit the
        // resolver chain through the keyword-skip gate.
        for (const id of ['apply', 'std', 'vector', 'push_back', 'sort',
            'main', 'foo', 'bar', '', 'My_Class']) {
            expect(KEYWORDS_TO_SKIP.has(id)).toBe(false);
        }
    });
});

describe('EXPRESSION_SPECIFIERS', () => {
    it('includes `decltype`, `sizeof`, `alignof`, `typeid`, `noexcept`', () => {
        for (const sp of ['decltype', 'sizeof', 'alignof', 'typeid', 'noexcept']) {
            expect(EXPRESSION_SPECIFIERS.has(sp)).toBe(true);
        }
    });

    it('includes all four `*_cast` operators and `static_assert`', () => {
        for (const sp of ['static_cast', 'dynamic_cast', 'const_cast',
            'reinterpret_cast', 'static_assert']) {
            expect(EXPRESSION_SPECIFIERS.has(sp)).toBe(true);
        }
    });

    it('includes GCC / Clang underscore-prefixed vendor variants', () => {
        // Without these, vendor-extended declarations like clangd's
        // `__decltype(...)` would fall through the same wrong-match bug
        // that `decltype` was fixed for.
        for (const sp of ['__decltype', '__typeof', '__typeof__',
            '__alignof', '__alignof__']) {
            expect(EXPRESSION_SPECIFIERS.has(sp)).toBe(true);
        }
    });

    it('does NOT include keywords that don’t take a paren-arg', () => {
        // `static` / `inline` / `constexpr` / `template` / `using` and
        // friends are keywords, but they aren’t expression specifiers —
        // they don’t take a parenthesized operand and the declaration-
        // line scanner shouldn’t skip past them.
        for (const kw of ['static', 'inline', 'constexpr', 'template',
            'using', 'auto', 'class', 'struct', 'namespace',
            'if', 'else', 'return', 'true', 'false']) {
            expect(EXPRESSION_SPECIFIERS.has(kw)).toBe(false);
        }
    });
});

describe('EXPRESSION_SPECIFIERS ⊆ KEYWORDS_TO_SKIP (subset invariant)', () => {
    // Every "real" expression specifier listed in EXPRESSION_SPECIFIERS
    // should also be in KEYWORDS_TO_SKIP, except for the vendor-extended
    // `__decltype` / `__typeof` / etc. — those are GCC/Clang
    // extensions, not standard keywords, so they have no entry in the
    // canonical keyword set. The fallback's keyword-skip gate is
    // intentionally restricted to the standard keyword list; the
    // vendor variants only matter for the hover-/definition-parser
    // expression-specifier skip.
    it('every standard EXPRESSION_SPECIFIERS entry is also in KEYWORDS_TO_SKIP', () => {
        for (const sp of EXPRESSION_SPECIFIERS) {
            if (sp.startsWith('__')) continue; // vendor extension
            expect(
                KEYWORDS_TO_SKIP.has(sp),
                `${sp} is an expression specifier but missing from KEYWORDS_TO_SKIP`
            ).toBe(true);
        }
    });
});

describe('isExpressionSpecifier', () => {
    it('returns true for canonical expression specifiers', () => {
        expect(isExpressionSpecifier('decltype')).toBe(true);
        expect(isExpressionSpecifier('sizeof')).toBe(true);
        expect(isExpressionSpecifier('noexcept')).toBe(true);
        expect(isExpressionSpecifier('static_cast')).toBe(true);
        expect(isExpressionSpecifier('dynamic_cast')).toBe(true);
        expect(isExpressionSpecifier('const_cast')).toBe(true);
        expect(isExpressionSpecifier('reinterpret_cast')).toBe(true);
        expect(isExpressionSpecifier('alignof')).toBe(true);
        expect(isExpressionSpecifier('typeid')).toBe(true);
        expect(isExpressionSpecifier('static_assert')).toBe(true);
    });

    it('returns true for the GCC/Clang vendor variants', () => {
        expect(isExpressionSpecifier('__decltype')).toBe(true);
        expect(isExpressionSpecifier('__typeof__')).toBe(true);
        expect(isExpressionSpecifier('__typeof')).toBe(true);
        expect(isExpressionSpecifier('__alignof')).toBe(true);
        expect(isExpressionSpecifier('__alignof__')).toBe(true);
    });

    it('returns false for identifiers that look function-call-shaped but aren’t specifiers', () => {
        // These are the false-positive cases the bug-fix was about: an
        // ordinary identifier followed by `(` is a real function name,
        // not a language construct to skip past.
        for (const id of ['apply', 'std::apply', 'sort', 'push_back',
            'foo', 'main', 'cast', 'cast_to']) {
            expect(isExpressionSpecifier(id)).toBe(false);
        }
    });

    it('returns false for keywords that aren’t expression specifiers', () => {
        for (const kw of ['int', 'class', 'template', 'static', 'inline',
            'constexpr', 'using', 'namespace', 'return']) {
            expect(isExpressionSpecifier(kw)).toBe(false);
        }
    });

    it('returns false for the empty string', () => {
        expect(isExpressionSpecifier('')).toBe(false);
    });
});
