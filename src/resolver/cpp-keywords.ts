// C++ keyword sets shared across resolver strategies.
//
// Why one shared module: the fallback strategy and the new front-of-
// chain keyword strategy both need to test the cursor word against a
// canonical list of C++ keywords. Without a shared source of truth the
// two lists drift; the symptom is whack-a-mole resolver bugs where one
// strategy treats a token as a keyword and the other doesn't.
//
// Sourced from https://en.cppreference.com/w/cpp/keyword (the keyword
// index page). We omit the C99 fundamental type names that cppreference
// also lists (int, char, ...) — those have keyword pages too and we
// route them through the keyword strategy, but they don't need to be
// in the `KEYWORDS_TO_SKIP` set (the fallback already handles them via
// the bare-identifier index path).
//
// Two sets are exported:
//
//   KEYWORDS_TO_SKIP          — control-flow keywords, storage / type
//                                specifiers, access modifiers, and the
//                                token-style operators (and, or, ...).
//                                The fallback uses this to short-circuit
//                                identifier lookup; the keyword strategy
//                                uses it as its primary trigger.
//
//   EXPRESSION_SPECIFIERS     — `decltype`, `sizeof`, `alignof`, etc.
//                                These look like `name(...)` but are
//                                language constructs, not function
//                                calls. The hover / definition parsers
//                                need to skip past them when scanning
//                                a declaration for the actual function
//                                name (otherwise a hover on `std::apply`
//                                whose return type is `decltype(auto)`
//                                resolves to `decltype` instead).

/**
 * Canonical C++ keyword list. Every entry in this set has at least one
 * cppreference docs page (either `cpp/keyword/<kw>.html` (Keyword) or
 * `cpp/language/<kw>.html` (Language)) that the keyword strategy can
 * resolve to. The fallback also consults this list to skip identifier
 * lookups for keywords — see `fallback.ts`.
 */
export const KEYWORDS_TO_SKIP: ReadonlySet<string> = new Set<string>([
    // Control flow
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'return',
    'goto',
    'try',
    'catch',
    'throw',
    // Expression keywords (these double as expression specifiers — see
    // EXPRESSION_SPECIFIERS below for the subset that takes a paren-arg).
    'new',
    'delete',
    'sizeof',
    'alignof',
    'alignas',
    'typeid',
    'noexcept',
    'decltype',
    'asm',
    'operator',
    'override',
    'final',
    // Literal keywords
    'true',
    'false',
    'nullptr',
    'this',
    // Alternative operator tokens
    'and',
    'or',
    'not',
    'xor',
    'bitand',
    'bitor',
    'compl',
    'and_eq',
    'or_eq',
    'xor_eq',
    'not_eq',
    // Storage / type / declaration specifiers
    'using',
    'namespace',
    'typedef',
    'static',
    'const',
    'constexpr',
    'consteval',
    'constinit',
    'volatile',
    'mutable',
    'virtual',
    'explicit',
    'inline',
    'extern',
    'register',
    'thread_local',
    // Access modifiers
    'public',
    'private',
    'protected',
    'friend',
    // Type / scope keywords
    'auto',
    'class',
    'struct',
    'union',
    'enum',
    'template',
    'typename',
    'concept',
    'requires',
    // Module / coroutine keywords (C++20+)
    'export',
    'module',
    'import',
    'co_await',
    'co_yield',
    'co_return',
    // Casts (also expression specifiers — see EXPRESSION_SPECIFIERS)
    'static_assert',
    'static_cast',
    'dynamic_cast',
    'const_cast',
    'reinterpret_cast'
]);

/**
 * Tokens that look like `name(...)` but are language-level expression
 * specifiers, not function calls. The hover-parser and
 * definition-walker scan declaration lines for `name\s*\(` to locate
 * the function being declared; without skipping these, a return-type
 * specifier like `decltype(auto)` in
 *
 *   constexpr decltype(auto) apply(F&& f, Tuple&& t);
 *
 * matches first and the parser returns `decltype` instead of `apply`.
 *
 * Subset of KEYWORDS_TO_SKIP — only those that syntactically take a
 * parenthesized operand. Listed verbatim rather than derived from
 * KEYWORDS_TO_SKIP so it stays a closed set the parsers can rely on.
 */
export const EXPRESSION_SPECIFIERS: ReadonlySet<string> = new Set<string>([
    'decltype',
    'sizeof',
    'alignof',
    'typeid',
    'noexcept',
    'static_cast',
    'dynamic_cast',
    'const_cast',
    'reinterpret_cast',
    'static_assert',
    // GCC / Clang extensions occasionally surface in clangd output —
    // include them so vendor-extended declarations don't fall through
    // and trigger the same wrong-match bug.
    '__decltype',
    '__typeof',
    '__typeof__',
    '__alignof',
    '__alignof__'
]);

/**
 * Returns true when `word` matches an expression specifier — i.e. an
 * identifier that should NEVER be returned as the parsed function name
 * for a declaration. Used by `parseDeclarationLine` in hover-parser.ts
 * and `extractIdentifierFromLine` in definition-walker.ts to skip past
 * `decltype(auto)` / `sizeof(T)` / `noexcept(expr)` when scanning for
 * the actual function name.
 */
export function isExpressionSpecifier(word: string): boolean {
    return EXPRESSION_SPECIFIERS.has(word);
}

/**
 * The fallback word pattern used by resolver strategies to grab the
 * identifier at the cursor when the active language doesn't define one.
 */
export const DEFAULT_WORD_PATTERN = /[A-Za-z_]\w*/;
