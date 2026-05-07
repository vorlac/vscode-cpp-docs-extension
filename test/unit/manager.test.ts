import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { DocsetManager } from '../../src/docset/manager.js';
import type { Fetcher } from '../../src/docset/cppreference-installer.js';

interface MockResponseOpts {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
    body?: Uint8Array;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(bytes);
            c.close();
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

function routeFetcher(routes: Array<[string, () => MockResponseOpts]>): Fetcher {
    return async (url: string) => {
        for (const [needle, handler] of routes) {
            if (url.includes(needle)) return makeMockResponse(handler());
        }
        throw new Error(`Unrouted: ${url}`);
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
    const xz = await lzmaCompress(tarBuf);
    await writeFile(destPath, xz);
    await rm(tarPath);
}

const TAG_XML = `<?xml version="1.0"?>
<tagfile>
  <compound kind="namespace">
    <name>std</name>
    <member kind="function">
      <name>sort</name>
      <anchorfile>en/cpp/algorithm/sort.html</anchorfile>
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
      <arglist></arglist>
    </member>
  </compound>
</tagfile>
`;

describe('DocsetManager — cppreference install + index', () => {
    let tmp: string;
    let manager: DocsetManager;
    let archiveBytes: Buffer;
    let sha: string;

    beforeAll(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'mgr-cpp-'));

        // Build a fixture tar.xz containing the tag XML + a couple of files.
        const src = path.join(tmp, 'src');
        await mkdir(path.join(src, 'reference', 'en', 'cpp', 'algorithm'), {
            recursive: true
        });
        await writeFile(path.join(src, 'cppreference-doxygen-local.tag.xml'), TAG_XML);
        await writeFile(
            path.join(src, 'reference', 'en', 'cpp', 'algorithm', 'sort.html'),
            '<html>sort</html>'
        );
        const archive = path.join(tmp, 'html-book-99999999.tar.xz');
        await buildTarXzFixture(src, archive);
        archiveBytes = await readFile(archive);
        sha = createHash('sha256').update(archiveBytes).digest('hex');
    });

    afterAll(async () => {
        manager?.close();
        await rm(tmp, { recursive: true });
    });

    it('installs + indexes cppreference and resolves push_back via the manager', async () => {
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
                    size: 100
                }
            ]
        };
        const fetcher = routeFetcher([
            ['releases/latest', () => ({ json: releaseJson })],
            ['/archive', () => ({ body: new Uint8Array(archiveBytes) })],
            ['/checksums', () => ({ text: `${sha}  html-book-99999999.tar.xz\n` })]
        ]);

        manager = new DocsetManager({
            storageDir: path.join(tmp, 'storage'),
            fetcher,
            now: () => 1_700_000_000_000
        });
        await manager.open();

        const result = await manager.installCppreference();
        expect(result.status).toBe('installed');
        expect(result.version).toBe('99999999');
        expect(result.inserted).toBeGreaterThan(0);

        const docsets = manager.listDocsets();
        expect(docsets.find((d) => d.source === 'cppreference')?.version).toBe('99999999');

        // Re-running re-indexes (the install command is the user's escape
        // hatch for picking up indexer changes after an extension update)
        // — file-level status is still `already-current`, but the symbol
        // count returns the freshly-indexed total rather than zero.
        const second = await manager.installCppreference();
        expect(second.status).toBe('already-current');
        expect(second.inserted).toBe(result.inserted);
    }, 30_000);
});
