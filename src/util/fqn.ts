/**
 * Strip ABI-detail inline namespaces injected by standard library
 * implementations. Clangd surfaces these in fully-qualified names even
 * though cppreference only documents the public-facing names:
 *
 *   std::__1::vector        → std::vector   (libc++ v1, macOS/Apple Clang)
 *   std::__2::vector        → std::vector   (libc++ v2, newer LLVM)
 *   std::__cxx11::basic_string → std::basic_string  (libstdc++, GCC)
 *   std::__debug::vector    → std::vector   (libstdc++ debug mode)
 *
 * Every identifier starting with `__` is reserved for the implementation
 * by the C++ standard (lex.name), so no user-visible namespace segment
 * will be incorrectly removed.
 */
export function stripAbiNamespaces(fqn: string): string {
    return fqn.replace(/::__\w+::/g, '::');
}

/**
 * Strip template-argument lists from a qualified name while preserving
 * `operator<`, `operator>`, `operator<<`, `operator>>`, `operator<=`,
 * `operator>=`, `operator->`, and `operator->*` (the angle brackets there
 * are part of the identifier, not template-argument delimiters).
 */
export function stripTemplateArgs(name: string): string {
    if (typeof name !== 'string') return '';
    let depth = 0;
    let out = '';
    for (let i = 0; i < name.length; i++) {
        if (
            depth === 0 &&
            (i === 0 || name[i - 1] === ':') &&
            name.startsWith('operator', i)
        ) {
            out += 'operator';
            i += 'operator'.length;
            while (i < name.length) {
                const ch = name[i];
                if (ch === ':' && name[i + 1] === ':') break;
                out += ch;
                i++;
            }
            i--;
            continue;
        }
        const c = name[i];
        if (c === '<') {
            depth++;
            continue;
        }
        if (c === '>') {
            if (depth > 0) depth--;
            continue;
        }
        if (depth === 0) out += c;
    }
    return out.trim();
}
