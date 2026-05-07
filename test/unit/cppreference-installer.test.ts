import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import JSZip from 'jszip';
import {
    type Fetcher,
    fetchLatestRelease,
    fetchReleaseByTag,
    pickArchiveAsset,
    findExpectedSha256,
    verifySha256,
    extractTarXz,
    extractZip,
    installCppreference
} from '../../src/docset/cppreference-installer.js';

interface MockResponseOpts {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
    body?: Uint8Array;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

function makeMockResponse(opts: MockResponseOpts): Awaited<ReturnType<Fetcher>> {
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
        body: opts.body ? bytesToStream(opts.body) : null
    };
}

function routeFetcher(routes: Array<[RegExp | string, () => MockResponseOpts]>): Fetcher {
    return async (url: string) => {
        for (const [pattern, handler] of routes) {
            const matched =
                typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
            if (matched) return makeMockResponse(handler());
        }
        throw new Error(`Unrouted fetch: ${url}`);
    };
}

async function lzmaCompress(input: Buffer): Promise<Buffer> {
    const lzma = (await import('lzma-native')) as typeof import('lzma-native');
    const chunks: Buffer[] = [];
    await pipeline(
        Readable.from([input]),
        lzma.createCompressor(),
        new Writable({
            write(chunk, _enc, cb) {
                chunks.push(chunk as Buffer);
                cb();
            }
        })
    );
    return Buffer.concat(chunks);
}

async function buildTarXzFixture(srcDir: string, destPath: string): Promise<void> {
    const tarPath = destPath.replace(/\.xz$/, '');
    await tar.create({ cwd: srcDir, file: tarPath }, ['.']);
    const tarBuf = await readFile(tarPath);
    const xzBuf = await lzmaCompress(tarBuf);
    await writeFile(destPath, xzBuf);
    await rm(tarPath);
}

async function buildZipFixture(
    files: Record<string, string>,
    destPath: string
): Promise<void> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
        zip.file(name, content);
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(destPath, buf);
}

const FIXTURE_FILES = {
    'cppreference-doxygen-local.tag.xml':
        '<?xml version="1.0"?>\n<tagfile>\n  <compound kind="namespace"><name>std</name></compound>\n</tagfile>\n',
    'reference/en/cpp/algorithm/sort.html': '<html><body>sort</body></html>\n',
    'reference/en/cpp/container/vector/push_back.html':
        '<html><body>push_back</body></html>\n'
};

describe('cppreference-installer pure helpers', () => {
    it('parses a sha256sums-style checksums file', () => {
        const txt = [
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  html-book-99999999.tar.xz',
            'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210 *html-book-99999999.zip',
            'unrelated line'
        ].join('\n');
        expect(findExpectedSha256(txt, 'html-book-99999999.tar.xz')).toBe(
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        );
        expect(findExpectedSha256(txt, 'html-book-99999999.zip')).toBe(
            'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
        );
        expect(findExpectedSha256(txt, 'missing.tar.xz')).toBeUndefined();
        expect(findExpectedSha256(undefined, 'anything')).toBeUndefined();
    });

    it('prefers tar.xz over zip when picking an asset', () => {
        const tarxz = {
            name: 'html-book-99999999.tar.xz',
            browserDownloadUrl: 'u1',
            size: 1
        };
        const zip = { name: 'html-book-99999999.zip', browserDownloadUrl: 'u2', size: 2 };
        const release = {
            tagName: 'v99999999',
            version: '99999999',
            assets: [zip, tarxz]
        };
        expect(pickArchiveAsset(release).format).toBe('tar.xz');
        expect(pickArchiveAsset({ ...release, assets: [zip] }).format).toBe('zip');
        expect(() => pickArchiveAsset({ ...release, assets: [] })).toThrow();
    });

    it('throws on SHA256 mismatch', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'cpp-installer-'));
        const f = path.join(tmp, 'a.bin');
        await writeFile(f, 'hello');
        const real = createHash('sha256').update('hello').digest('hex');
        await expect(verifySha256(f, real)).resolves.toBeUndefined();
        await expect(verifySha256(f, 'a'.repeat(64))).rejects.toThrow(/SHA256 mismatch/);
        await rm(tmp, { recursive: true });
    });

    it('fetchReleaseByTag hits the by-tag URL with the requested tag', async () => {
        const fetcher = routeFetcher([
            [
                'releases/tags/20250209',
                () => ({
                    json: {
                        tag_name: 'v20250209',
                        assets: [
                            {
                                name: 'html-book-20250209.tar.xz',
                                browser_download_url: 'http://example/archive',
                                size: 100
                            }
                        ]
                    }
                })
            ]
        ]);
        const info = await fetchReleaseByTag('20250209', fetcher);
        expect(info.version).toBe('20250209');
        expect(info.tagName).toBe('v20250209');
        expect(info.assets).toHaveLength(1);
    });

    it('fetchLatestRelease normalizes the release JSON and pulls checksums', async () => {
        const fetcher = routeFetcher([
            [
                'releases/latest',
                () => ({
                    json: {
                        tag_name: 'v99999999',
                        assets: [
                            {
                                name: 'html-book-99999999.tar.xz',
                                browser_download_url: 'http://example/archive',
                                size: 100
                            },
                            {
                                name: 'checksums.txt',
                                browser_download_url: 'http://example/checksums',
                                size: 64
                            }
                        ]
                    }
                })
            ],
            ['/checksums', () => ({ text: 'abc  html-book-99999999.tar.xz' })]
        ]);
        const info = await fetchLatestRelease(fetcher);
        expect(info.version).toBe('99999999');
        expect(info.tagName).toBe('v99999999');
        expect(info.assets).toHaveLength(2);
        expect(info.checksumsTxt).toContain('html-book-99999999.tar.xz');
    });
});

describe('extractTarXz', () => {
    let tmp: string;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-extract-tarxz-'));
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('extracts a fixture tar.xz to disk', async () => {
        const srcDir = path.join(tmp, 'src');
        for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
            const full = path.join(srcDir, rel);
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, content);
        }
        const archive = path.join(tmp, 'fixture.tar.xz');
        await buildTarXzFixture(srcDir, archive);
        const dest = path.join(tmp, 'out');
        await extractTarXz(archive, dest);
        expect(existsSync(path.join(dest, 'cppreference-doxygen-local.tag.xml'))).toBe(true);
        expect(existsSync(path.join(dest, 'reference/en/cpp/algorithm/sort.html'))).toBe(true);
    });
});

describe('extractZip', () => {
    let tmp: string;
    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-extract-zip-'));
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('extracts a fixture zip to disk', async () => {
        const archive = path.join(tmp, 'fixture.zip');
        await buildZipFixture(FIXTURE_FILES, archive);
        const dest = path.join(tmp, 'out');
        await extractZip(archive, dest);
        expect(existsSync(path.join(dest, 'cppreference-doxygen-local.tag.xml'))).toBe(true);
        expect(existsSync(path.join(dest, 'reference/en/cpp/algorithm/sort.html'))).toBe(true);
    });
});

describe('installCppreference end-to-end', () => {
    let tmp: string;

    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'cpp-install-'));
    });
    afterAll(async () => {
        await rm(tmp, { recursive: true });
    });

    it('downloads + verifies + extracts + writes INSTALLED, idempotent on repeat', async () => {
        const srcDir = path.join(tmp, 'src');
        for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
            const full = path.join(srcDir, rel);
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, content);
        }
        const archive = path.join(tmp, 'html-book-99999999.tar.xz');
        await buildTarXzFixture(srcDir, archive);
        const archiveBytes = await readFile(archive);
        const sha = createHash('sha256').update(archiveBytes).digest('hex');
        const checksumsTxt = `${sha}  html-book-99999999.tar.xz\n`;

        const releaseJson = {
            tag_name: 'v99999999',
            assets: [
                {
                    name: 'html-book-99999999.tar.xz',
                    browser_download_url: 'http://example/archive',
                    size: archiveBytes.length
                },
                {
                    name: 'checksums.txt',
                    browser_download_url: 'http://example/checksums',
                    size: checksumsTxt.length
                }
            ]
        };

        const fetcher = routeFetcher([
            ['releases/latest', () => ({ json: releaseJson })],
            ['/archive', () => ({ body: new Uint8Array(archiveBytes) })],
            ['/checksums', () => ({ text: checksumsTxt })]
        ]);

        const storageDir = path.join(tmp, 'storage');
        const first = await installCppreference({ storageDir, fetcher });
        expect(first.status).toBe('installed');
        expect(first.version).toBe('99999999');
        expect(existsSync(first.tagXmlPath)).toBe(true);
        expect(existsSync(path.join(first.rootPath, 'INSTALLED'))).toBe(true);

        const second = await installCppreference({ storageDir, fetcher });
        expect(second.status).toBe('already-current');
        expect(second.rootPath).toBe(first.rootPath);
    }, 30_000);

    it('rejects when the SHA256 does not match', async () => {
        const srcDir = path.join(tmp, 'src2');
        for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
            const full = path.join(srcDir, rel);
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, content);
        }
        const archive = path.join(tmp, 'html-book-88888888.tar.xz');
        await buildTarXzFixture(srcDir, archive);
        const archiveBytes = await readFile(archive);
        const wrongSha = 'a'.repeat(64);
        const checksumsTxt = `${wrongSha}  html-book-88888888.tar.xz\n`;

        const releaseJson = {
            tag_name: 'v88888888',
            assets: [
                {
                    name: 'html-book-88888888.tar.xz',
                    browser_download_url: 'http://example/archive',
                    size: archiveBytes.length
                },
                {
                    name: 'checksums.txt',
                    browser_download_url: 'http://example/checksums',
                    size: checksumsTxt.length
                }
            ]
        };

        const fetcher = routeFetcher([
            ['releases/latest', () => ({ json: releaseJson })],
            ['/archive', () => ({ body: new Uint8Array(archiveBytes) })],
            ['/checksums', () => ({ text: checksumsTxt })]
        ]);

        const storageDir = path.join(tmp, 'storage-bad');
        await expect(installCppreference({ storageDir, fetcher })).rejects.toThrow(
            /SHA256 mismatch/
        );
    }, 30_000);
});

describe('createReadStream sanity', () => {
    it('exists for a touched file (sanity)', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'cpp-rs-'));
        const f = path.join(tmp, 'x');
        await writeFile(f, 'hi');
        let bytes = 0;
        await pipeline(
            createReadStream(f),
            new Writable({
                write(chunk, _enc, cb) {
                    bytes += (chunk as Buffer).length;
                    cb();
                }
            })
        );
        expect(bytes).toBe(2);
        await rm(tmp, { recursive: true });
    });
});
