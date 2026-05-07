import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildAllStandardFiltersCss,
    buildStandardFilterCssFor,
    compileCommandsCandidates,
    parseStdFromCmd,
    parseStdFromCompileDb,
    resolveCppStandard,
    settingToToken,
    tokenToSetting,
    SELECTABLE_STANDARDS,
    FILTER_STANDARDS
} from '../../src/ui/cpp-standard.js';

describe('settingToToken', () => {
    it('maps c++NN to cxxNN for selectable standards', () => {
        expect(settingToToken('c++11')).toBe('cxx11');
        expect(settingToToken('c++14')).toBe('cxx14');
        expect(settingToToken('c++17')).toBe('cxx17');
        expect(settingToToken('c++20')).toBe('cxx20');
        expect(settingToToken('c++23')).toBe('cxx23');
        expect(settingToToken('c++26')).toBe('cxx26');
    });

    it('normalizes gnu++NN to cxxNN (docs/06-gotchas.md N)', () => {
        expect(settingToToken('gnu++17')).toBe('cxx17');
        expect(settingToToken('gnu++20')).toBe('cxx20');
    });

    it('is case-insensitive', () => {
        expect(settingToToken('C++17')).toBe('cxx17');
        expect(settingToToken('GNU++20')).toBe('cxx20');
    });

    it('returns undefined for pre-C++11 versions', () => {
        expect(settingToToken('c++98')).toBeUndefined();
        expect(settingToToken('c++03')).toBeUndefined();
    });

    it('returns undefined for "auto" and other non-versions', () => {
        expect(settingToToken('auto')).toBeUndefined();
        expect(settingToToken('c++latest')).toBeUndefined();
        expect(settingToToken('')).toBeUndefined();
        expect(settingToToken(undefined)).toBeUndefined();
    });
});

describe('tokenToSetting', () => {
    it('maps cxxNN back to c++NN for round-trip', () => {
        for (const tok of SELECTABLE_STANDARDS) {
            expect(settingToToken(tokenToSetting(tok))).toBe(tok);
        }
    });
});

describe('parseStdFromCmd', () => {
    it('extracts -std=c++NN from a command string', () => {
        expect(parseStdFromCmd('clang++ -std=c++17 -O2 main.cpp')).toBe('cxx17');
        expect(parseStdFromCmd('clang++ -O2 -std=c++23 main.cpp')).toBe('cxx23');
    });

    it('extracts -std=gnu++NN', () => {
        expect(parseStdFromCmd('g++ -std=gnu++20 main.cpp')).toBe('cxx20');
    });

    it('extracts double-dashed --std= form', () => {
        expect(parseStdFromCmd('clang++ --std=c++17 main.cpp')).toBe('cxx17');
    });

    it('returns undefined when no -std= is present', () => {
        expect(parseStdFromCmd('clang++ -O2 main.cpp')).toBeUndefined();
    });

    it('returns undefined for unknown standards', () => {
        expect(parseStdFromCmd('clang++ -std=c++latest main.cpp')).toBeUndefined();
    });

    it('does not match -std= embedded in another flag (must follow whitespace or start)', () => {
        expect(parseStdFromCmd('clang++ -Wno-cstd=c++17 main.cpp')).toBeUndefined();
    });
});

describe('parseStdFromCompileDb', () => {
    const target = '/proj/src/main.cpp';

    it('matches absolute file paths', () => {
        const entries = [
            {
                directory: '/proj',
                file: '/proj/src/main.cpp',
                command: 'clang++ -std=c++20 main.cpp'
            }
        ];
        expect(parseStdFromCompileDb(entries, target)).toBe('cxx20');
    });

    it('resolves relative file paths against the entry directory', () => {
        const entries = [
            {
                directory: '/proj',
                file: 'src/main.cpp',
                command: 'clang++ -std=c++17 src/main.cpp'
            }
        ];
        expect(parseStdFromCompileDb(entries, target)).toBe('cxx17');
    });

    it('extracts -std= from the arguments array when no command is set', () => {
        const entries = [
            {
                directory: '/proj',
                file: '/proj/src/main.cpp',
                arguments: ['clang++', '-std=c++23', '-O2', '/proj/src/main.cpp']
            }
        ];
        expect(parseStdFromCompileDb(entries, target)).toBe('cxx23');
    });

    it('skips non-matching files', () => {
        const entries = [
            {
                directory: '/proj',
                file: '/proj/src/other.cpp',
                command: 'clang++ -std=c++17 other.cpp'
            }
        ];
        expect(parseStdFromCompileDb(entries, target)).toBeUndefined();
    });

    it('returns undefined for non-array input', () => {
        expect(parseStdFromCompileDb({}, target)).toBeUndefined();
        expect(parseStdFromCompileDb(null, target)).toBeUndefined();
        expect(parseStdFromCompileDb('not an array', target)).toBeUndefined();
    });
});

describe('compileCommandsCandidates', () => {
    it('includes the workspace root and well-known build dirs', () => {
        const got = compileCommandsCandidates('/proj');
        expect(got).toEqual([
            path.join('/proj', 'compile_commands.json'),
            path.join('/proj', 'build', 'compile_commands.json'),
            path.join('/proj', 'build', 'Debug', 'compile_commands.json'),
            path.join('/proj', 'build', 'Release', 'compile_commands.json'),
            path.join('/proj', 'out', 'compile_commands.json'),
            path.join('/proj', '.vscode', 'compile_commands.json')
        ]);
    });
});

describe('resolveCppStandard', () => {
    it('returns explicit when cppDocs.cppStandard is a concrete value', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'c++17',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx17', source: 'explicit' });
    });

    it('falls through to mscpp when cppDocs is auto', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                msCppExtSetting: 'c++23',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx23', source: 'mscpp' });
    });

    it('normalizes gnu++ from MS C/C++ extension setting', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                msCppExtSetting: 'gnu++17',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx17', source: 'mscpp' });
    });

    it('falls through to compile-db when mscpp is absent', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                fallbackSetting: 'c++20',
                compileEntries: [
                    {
                        directory: '/proj',
                        file: '/proj/src/main.cpp',
                        command: 'clang++ -std=c++23 main.cpp'
                    }
                ],
                activeDocumentPath: '/proj/src/main.cpp'
            })
        ).toEqual({ token: 'cxx23', source: 'compile-db' });
    });

    it('falls back to fallbackSetting when no source resolves', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx20', source: 'fallback' });
    });

    it('falls back to default when fallbackSetting is itself invalid', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                fallbackSetting: 'c++latest'
            })
        ).toEqual({ token: 'cxx20', source: 'fallback' });
    });

    it('honors precedence — explicit beats every other source', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'c++14',
                msCppExtSetting: 'c++23',
                compileEntries: [
                    { directory: '/proj', file: '/proj/main.cpp', command: '-std=c++26' }
                ],
                activeDocumentPath: '/proj/main.cpp',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx14', source: 'explicit' });
    });

    it('mscpp beats compile-db', () => {
        expect(
            resolveCppStandard({
                cppDocsSetting: 'auto',
                msCppExtSetting: 'c++14',
                compileEntries: [
                    { directory: '/proj', file: '/proj/main.cpp', command: '-std=c++26' }
                ],
                activeDocumentPath: '/proj/main.cpp',
                fallbackSetting: 'c++20'
            })
        ).toEqual({ token: 'cxx14', source: 'mscpp' });
    });
});

describe('buildStandardFilterCssFor', () => {
    it('hides since-cxxN for N strictly greater than target', () => {
        const css = buildStandardFilterCssFor('cxx17');
        expect(css).toContain(
            'body[data-cpp-std="cxx17"] .t-since-cxx20'
        );
        expect(css).toContain(
            'body[data-cpp-std="cxx17"] .t-since-cxx23'
        );
        expect(css).toContain(
            'body[data-cpp-std="cxx17"] .t-since-cxx26'
        );
        expect(css).not.toContain('.t-since-cxx17');
        expect(css).not.toContain('.t-since-cxx14');
    });

    it('hides until-cxxN for N at or before target', () => {
        const css = buildStandardFilterCssFor('cxx17');
        for (const earlier of ['cxx98', 'cxx03', 'cxx11', 'cxx14', 'cxx17']) {
            expect(css).toContain(
                `body[data-cpp-std="cxx17"] .t-until-${earlier}`
            );
        }
        expect(css).not.toContain('.t-until-cxx20');
        expect(css).not.toContain('.t-until-cxx23');
    });

    it('terminates the rule with display:none', () => {
        const css = buildStandardFilterCssFor('cxx17');
        expect(css).toMatch(/\}\s*$/);
        expect(css).toContain('{ display: none; }');
    });

    it('matches the docs/04-rendering.md example for cxx17 verbatim', () => {
        const css = buildStandardFilterCssFor('cxx17');
        const expectedSelectors = [
            'body[data-cpp-std="cxx17"] .t-since-cxx20',
            'body[data-cpp-std="cxx17"] .t-since-cxx23',
            'body[data-cpp-std="cxx17"] .t-since-cxx26',
            'body[data-cpp-std="cxx17"] .t-until-cxx98',
            'body[data-cpp-std="cxx17"] .t-until-cxx03',
            'body[data-cpp-std="cxx17"] .t-until-cxx11',
            'body[data-cpp-std="cxx17"] .t-until-cxx14',
            'body[data-cpp-std="cxx17"] .t-until-cxx17'
        ];
        for (const sel of expectedSelectors) expect(css).toContain(sel);
    });
});

describe('buildAllStandardFiltersCss', () => {
    const all = buildAllStandardFiltersCss();

    it('includes a rule set for every selectable standard', () => {
        for (const tok of SELECTABLE_STANDARDS) {
            expect(all).toContain(`body[data-cpp-std="${tok}"]`);
        }
    });

    it('does not produce rule sets for non-selectable filter tokens (cxx98/cxx03)', () => {
        expect(all).not.toContain('body[data-cpp-std="cxx98"]');
        expect(all).not.toContain('body[data-cpp-std="cxx03"]');
    });
});

describe('FILTER_STANDARDS / SELECTABLE_STANDARDS shape', () => {
    it('selectable is the modern subset of filter tokens', () => {
        for (const t of SELECTABLE_STANDARDS) expect(FILTER_STANDARDS).toContain(t);
        expect(FILTER_STANDARDS).toContain('cxx98');
        expect(FILTER_STANDARDS).toContain('cxx03');
    });
});
