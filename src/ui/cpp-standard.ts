import * as path from 'node:path';

/**
 * Internal token form: `cxx11`, `cxx17`, etc. Drives the
 * `body[data-cpp-std="cxxNN"]` attribute selector used by the standard-
 * filtering CSS (docs/04-rendering.md §"Standard filtering").
 *
 * The user-facing setting form is `c++17` etc. — translated via
 * `settingToToken`/`tokenToSetting`.
 *
 * Filter targets include `cxx98` and `cxx03` since cppreference content
 * carries `t-until-cxx98`/`t-until-cxx03` markers — we still need to hide
 * them when the user is on a modern standard. The user setting itself
 * cannot select `c++98`/`c++03`; resolution always lands on `cxx11`+.
 */
export type CppStdToken =
    | 'cxx11'
    | 'cxx14'
    | 'cxx17'
    | 'cxx20'
    | 'cxx23'
    | 'cxx26';

export const SELECTABLE_STANDARDS: readonly CppStdToken[] = [
    'cxx11',
    'cxx14',
    'cxx17',
    'cxx20',
    'cxx23',
    'cxx26'
] as const;

export const FILTER_STANDARDS: readonly string[] = [
    'cxx98',
    'cxx03',
    'cxx11',
    'cxx14',
    'cxx17',
    'cxx20',
    'cxx23',
    'cxx26'
] as const;

export const DEFAULT_FALLBACK: CppStdToken = 'cxx20';

export type ResolutionSource =
    | 'explicit'
    | 'mscpp'
    | 'compile-db'
    | 'fallback';

export interface ResolvedStandard {
    token: CppStdToken;
    source: ResolutionSource;
}

/**
 * Translate a setting string (`c++17`, `gnu++17`, `C++23`, etc.) to a token.
 * `gnu++NN` → `cxxNN` (docs/06-gotchas.md N). Returns undefined for
 * pre-C++11 values and any string that doesn't match.
 */
export function settingToToken(raw: string | undefined): CppStdToken | undefined {
    if (!raw) return undefined;
    const lowered = raw.trim().toLowerCase();
    const stripped = lowered.replace(/^gnu\+\+/, 'c++');
    const match = stripped.match(/^c\+\+0?(\d+)$/);
    if (!match) return undefined;
    const n = parseInt(match[1]!, 10);
    const candidate = `cxx${n}`;
    return SELECTABLE_STANDARDS.includes(candidate as CppStdToken)
        ? (candidate as CppStdToken)
        : undefined;
}

export function tokenToSetting(token: CppStdToken): string {
    return token.replace(/^cxx/, 'c++');
}

/**
 * Extract the `-std=...` value from a compile_commands `command` string or
 * `arguments` array joined to a single string. Recognizes both `c++NN` and
 * `gnu++NN`. Returns the resolved token or undefined if none matches.
 */
export function parseStdFromCmd(cmd: string): CppStdToken | undefined {
    // Allow -std=c++17 / -std=gnu++20 / --std=c++23 (some build tools use --std)
    const m = cmd.match(/(?:^|\s)-{1,2}std=((?:gnu|c)\+\+0?\d+)/i);
    if (!m) return undefined;
    return settingToToken(m[1]);
}

interface CompileEntry {
    file: string;
    directory?: string;
    command?: string;
    arguments?: string[];
}

/**
 * Look up the compile-db entry whose `file` matches `absDocPath` (resolved
 * absolutely against the entry's `directory` when `file` is relative), then
 * extract `-std=`. Returns undefined when no matching entry has a `-std`
 * flag.
 */
export function parseStdFromCompileDb(
    entries: unknown,
    absDocPath: string
): CppStdToken | undefined {
    if (!Array.isArray(entries)) return undefined;
    const target = path.resolve(absDocPath);
    for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as CompileEntry;
        if (typeof entry.file !== 'string') continue;
        const dir =
            typeof entry.directory === 'string' ? entry.directory : '';
        const entryPath = path.isAbsolute(entry.file)
            ? path.resolve(entry.file)
            : path.resolve(dir, entry.file);
        if (entryPath !== target) continue;
        let cmd = '';
        if (typeof entry.command === 'string') cmd = entry.command;
        else if (Array.isArray(entry.arguments))
            cmd = entry.arguments.filter((a) => typeof a === 'string').join(' ');
        const token = parseStdFromCmd(cmd);
        if (token) return token;
    }
    return undefined;
}

/** Well-known locations to check for `compile_commands.json`. */
export function compileCommandsCandidates(workspaceFolder: string): string[] {
    return [
        workspaceFolder,
        path.join(workspaceFolder, 'build'),
        path.join(workspaceFolder, 'build', 'Debug'),
        path.join(workspaceFolder, 'build', 'Release'),
        path.join(workspaceFolder, 'out'),
        path.join(workspaceFolder, '.vscode')
    ].map((d) => path.join(d, 'compile_commands.json'));
}

export interface ResolveSources {
    /** Literal value of `cppDocs.cppStandard` (e.g. `auto`, `c++17`). */
    cppDocsSetting: string;
    /** Literal value of `cppDocs.cppStandard.fallback` (e.g. `c++20`). */
    fallbackSetting: string;
    /** Literal value of `C_Cpp.default.cppStandard`, when present. */
    msCppExtSetting?: string;
    /** Already-parsed compile_commands entries (caller reads from disk). */
    compileEntries?: unknown;
    /** Absolute path of the active document, when one is open. */
    activeDocumentPath?: string;
}

/**
 * Pure resolution chain. The caller supplies all inputs; this function does
 * no IO and returns the resolved token + which source produced it. Per
 * docs/02-architecture.md §"cppDocs.cppStandard resolution order".
 */
export function resolveCppStandard(sources: ResolveSources): ResolvedStandard {
    if (sources.cppDocsSetting && sources.cppDocsSetting !== 'auto') {
        const t = settingToToken(sources.cppDocsSetting);
        if (t) return { token: t, source: 'explicit' };
    }
    if (sources.msCppExtSetting) {
        const t = settingToToken(sources.msCppExtSetting);
        if (t) return { token: t, source: 'mscpp' };
    }
    if (sources.compileEntries && sources.activeDocumentPath) {
        const t = parseStdFromCompileDb(
            sources.compileEntries,
            sources.activeDocumentPath
        );
        if (t) return { token: t, source: 'compile-db' };
    }
    const fb = settingToToken(sources.fallbackSetting) ?? DEFAULT_FALLBACK;
    return { token: fb, source: 'fallback' };
}

/**
 * Generate the standard-filter CSS for one body[data-cpp-std="cxxNN"]
 * scope: hide `.t-since-cxxN` for N strictly greater than the target, and
 * `.t-until-cxxN` for N at-or-before the target. Per docs/04-rendering.md
 * §"Standard filtering" Filter logic.
 */
export function buildStandardFilterCssFor(target: CppStdToken): string {
    const order = FILTER_STANDARDS;
    const idx = order.indexOf(target);
    if (idx < 0) return '';
    const selectors: string[] = [];
    for (let i = idx + 1; i < order.length; i++) {
        selectors.push(`body[data-cpp-std="${target}"] .t-since-${order[i]}`);
    }
    for (let i = 0; i <= idx; i++) {
        selectors.push(`body[data-cpp-std="${target}"] .t-until-${order[i]}`);
    }
    if (selectors.length === 0) return '';
    return selectors.join(',\n') + ' { display: none; }';
}

/**
 * Generate filter CSS for every selectable standard, joined into a single
 * stylesheet. Toggling between standards at runtime is then a single
 * `body.dataset.cppStd = 'cxxNN'` write — no re-render needed (the
 * `setStandard` postMessage from host to client).
 */
export function buildAllStandardFiltersCss(): string {
    return SELECTABLE_STANDARDS
        .map(buildStandardFilterCssFor)
        .filter((s) => s.length > 0)
        .join('\n\n');
}
