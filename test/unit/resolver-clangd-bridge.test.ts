// Unit tests for the M4.1 clangd-bridge strategy.
//
// Two layers:
//   1. Pure helpers (`parseClangdMajorVersion`, `buildFqnFromSymbolInfo`)
//      — exercised directly with no vscode dependency.
//   2. End-to-end strategy (`createClangdStrategy`) — exercised against
//      a hand-rolled vscode shim that satisfies the structural shape
//      the strategy actually touches: `extensions.getExtension`, plus
//      the `Extension` / language-client surfaces.
//
// The strategy is meant to fail silently in every "miss" case (the
// composer falls through to the next strategy). `ctx.signal.abort()`
// is the only condition that throws — and the test for it accepts
// either an `AbortError` throw or a plain `undefined` return, since
// either is a "miss" to the composer (per the M4.1 sub-task brief).

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
    buildFqnFromSymbolInfo,
    createClangdStrategy,
    parseClangdMajorVersion,
    type ClangdExports,
    type ClangdSymbolInfo
} from '../../src/resolver/clangd-bridge.js';
import type { ResolveContext } from '../../src/resolver/types.js';

// ---- pure helpers ---------------------------------------------------

describe('parseClangdMajorVersion', () => {
    it('parses bare semver strings', () => {
        expect(parseClangdMajorVersion('19.1.0')).toBe(19);
        expect(parseClangdMajorVersion('22.0.0')).toBe(22);
        expect(parseClangdMajorVersion('23.0.0')).toBe(23);
    });

    it('parses pre-release semver suffixes', () => {
        expect(parseClangdMajorVersion('23.0.0-rc1')).toBe(23);
    });

    it('parses the embedded LLVM build banner', () => {
        expect(
            parseClangdMajorVersion('clangd version 21.1.0 (https://example.invalid)')
        ).toBe(21);
    });

    it('returns undefined for unparseable inputs', () => {
        expect(parseClangdMajorVersion('unknown')).toBeUndefined();
        expect(parseClangdMajorVersion('')).toBeUndefined();
        expect(parseClangdMajorVersion(undefined)).toBeUndefined();
    });
});

describe('buildFqnFromSymbolInfo', () => {
    it('returns the bare name when there is no container', () => {
        expect(buildFqnFromSymbolInfo({ name: 'sort' })).toBe('sort');
    });

    it('joins container and name with `::`', () => {
        expect(buildFqnFromSymbolInfo({ name: 'sort', containerName: 'std' })).toBe(
            'std::sort'
        );
    });

    it('strips a single template-arg list from the container', () => {
        expect(
            buildFqnFromSymbolInfo({
                name: 'push_back',
                containerName: 'std::vector<int, std::allocator<int>>'
            })
        ).toBe('std::vector::push_back');
    });

    it('strips nested template-arg lists with balanced angles', () => {
        expect(
            buildFqnFromSymbolInfo({
                name: 'push_back',
                containerName:
                    'std::vector<std::pair<int, int>, std::allocator<std::pair<int, int>>>'
            })
        ).toBe('std::vector::push_back');
    });

    it('handles operator names', () => {
        expect(
            buildFqnFromSymbolInfo({
                name: 'operator()',
                containerName: 'std::less<int>'
            })
        ).toBe('std::less::operator()');
    });

    it('returns empty string for an empty name (caller treats as miss)', () => {
        expect(buildFqnFromSymbolInfo({ name: '', containerName: 'std' })).toBe('');
    });
});

// ---- end-to-end strategy with a vscode shim -------------------------

interface ShimExtension {
    isActive: boolean;
    exports: unknown;
    activate(): Promise<unknown>;
}

interface MockClient {
    initializeResult?: ClangdExports['languageClient'] extends infer C
    ? C extends { initializeResult?: infer R }
    ? R
    : never
    : never;
    sendRequest: <T>(method: string, params: unknown) => Promise<T>;
}

interface ShimOpts {
    extension?: ShimExtension | null;
}

function makeShim(opts: ShimOpts = {}): typeof vscode {
    const ext = opts.extension ?? null;
    return {
        extensions: {
            getExtension: (id: string): ShimExtension | undefined => {
                if (!ext) return undefined;
                // The strategy calls getExtension with a concrete id; we don't
                // gate on it here — tests pass the id they expect.
                void id;
                return ext;
            }
        }
    } as unknown as typeof vscode;
}

function makeContext(signal?: AbortSignal): ResolveContext {
    const document = {
        uri: { toString: (): string => 'file:///tmp/x.cpp' },
        version: 1,
        languageId: 'cpp'
    } as unknown as ResolveContext['document'];
    const position = { line: 10, character: 4 } as unknown as ResolveContext['position'];
    return {
        document,
        position,
        signal: signal ?? new AbortController().signal
    };
}

function makeClient(
    version: string | undefined,
    responder: (method: string, params: unknown) => Promise<unknown>
): MockClient {
    const client: MockClient = {
        sendRequest: async <T>(method: string, params: unknown): Promise<T> =>
            (await responder(method, params)) as T
    };
    if (version !== undefined) {
        client.initializeResult = {
            serverInfo: { name: 'clangd', version }
        } as MockClient['initializeResult'];
    }
    return client;
}

describe('createClangdStrategy', () => {
    it('returns undefined when the clangd extension is absent', async () => {
        const strategy = createClangdStrategy({ vscode: makeShim() });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined when exports is null', async () => {
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: null,
                    activate: async () => null
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined when exports.languageClient is absent', async () => {
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    // exports surface present but missing the languageClient field
                    // (e.g. a stale or differently-versioned vscode-clangd build)
                    exports: {} as ClangdExports,
                    activate: async () => ({})
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined when activation throws', async () => {
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: false,
                    exports: undefined,
                    activate: async () => {
                        throw new Error('activation failed');
                    }
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined for clangd version >= 23 (request was removed)', async () => {
        let sent = false;
        const client = makeClient('23.0.0', async () => {
            sent = true;
            return [];
        });
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
        expect(sent).toBe(false);
    });

    it('resolves an FQN from a clangd-22 symbolInfo response', async () => {
        const sentParams: Array<{ method: string; params: unknown }> = [];
        const client = makeClient('22.1.0', async (method, params) => {
            sentParams.push({ method, params });
            const out: ClangdSymbolInfo[] = [
                {
                    name: 'push_back',
                    containerName: 'std::vector<int, std::allocator<int>>',
                    usr: 'c:@ST>2#T#T@vector@F@push_back#&&t0.0#'
                }
            ];
            return out;
        });
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });

        const result = await strategy(makeContext());
        expect(result).toEqual({
            fqn: 'std::vector::push_back',
            source: 'clangd',
            usr: 'c:@ST>2#T#T@vector@F@push_back#&&t0.0#'
        });
        expect(sentParams).toEqual([
            {
                method: 'textDocument/symbolInfo',
                params: {
                    textDocument: { uri: 'file:///tmp/x.cpp' },
                    position: { line: 10, character: 4 }
                }
            }
        ]);
    });

    it('activates an inactive extension before reading exports', async () => {
        const client = makeClient('22.0.0', async () => [
            { name: 'sort', containerName: 'std' } as ClangdSymbolInfo
        ]);
        let activateCount = 0;
        const ext: ShimExtension = {
            isActive: false,
            exports: undefined,
            activate: async () => {
                activateCount++;
                ext.isActive = true;
                ext.exports = { languageClient: client } as ClangdExports;
                return ext.exports;
            }
        };
        const strategy = createClangdStrategy({
            vscode: makeShim({ extension: ext })
        });
        const result = await strategy(makeContext());
        expect(activateCount).toBe(1);
        expect(result).toEqual({ fqn: 'std::sort', source: 'clangd' });
    });

    it('returns undefined when the LSP request rejects', async () => {
        const client = makeClient('22.0.0', async () => {
            throw new Error('clangd is busy');
        });
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined when the LSP returns []', async () => {
        const client = makeClient('22.0.0', async () => []);
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('returns undefined when the first result has an empty name', async () => {
        const client = makeClient('22.0.0', async () => [
            { name: '', containerName: 'std' } as ClangdSymbolInfo
        ]);
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        expect(await strategy(makeContext())).toBeUndefined();
    });

    it('omits usr from the result when clangd does not return one', async () => {
        const client = makeClient('22.0.0', async () => [
            { name: 'sort', containerName: 'std' } as ClangdSymbolInfo
        ]);
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        const result = await strategy(makeContext());
        expect(result).toEqual({ fqn: 'std::sort', source: 'clangd' });
        expect(result?.usr).toBeUndefined();
    });

    it('treats a request that never resolves as a miss when the signal aborts', async () => {
        // The composer treats both `AbortError` and `undefined` as a miss;
        // the strategy may surface either. Pin down whichever this build
        // chose and assert it consistently.
        const controller = new AbortController();
        const client = makeClient('22.0.0', () => new Promise(() => {
            // intentionally never resolves
        }));
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: { languageClient: client } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });

        const promise = strategy(makeContext(controller.signal));
        controller.abort();

        let threw: unknown;
        let resolved: unknown;
        try {
            resolved = await promise;
        } catch (e) {
            threw = e;
        }

        if (threw === undefined) {
            expect(resolved).toBeUndefined();
        } else {
            expect(threw).toBeInstanceOf(Error);
            expect((threw as Error).name).toBe('AbortError');
        }
    });

    it('throws AbortError synchronously if the signal is already aborted on entry', async () => {
        const controller = new AbortController();
        controller.abort();
        const strategy = createClangdStrategy({
            vscode: makeShim({
                extension: {
                    isActive: true,
                    exports: {
                        languageClient: makeClient('22.0.0', async () => [])
                    } as ClangdExports,
                    activate: async () => undefined
                }
            })
        });
        await expect(strategy(makeContext(controller.signal))).rejects.toMatchObject(
            { name: 'AbortError' }
        );
    });
});
