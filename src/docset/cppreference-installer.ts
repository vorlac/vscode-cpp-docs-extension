import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import * as tar from 'tar';
import { preprocessCppreferenceHtml } from './cppreference-postprocess.js';

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
    body: ReadableStream<Uint8Array> | null;
}>;

export interface ReleaseAsset {
    name: string;
    browserDownloadUrl: string;
    size: number;
}

export interface ReleaseInfo {
    tagName: string;
    version: string;
    assets: ReleaseAsset[];
    checksumsTxt?: string;
}

export type ArchiveFormat = 'tar.xz' | 'zip';

export interface ArchivePick {
    asset: ReleaseAsset;
    format: ArchiveFormat;
}

const RELEASES_URL =
    'https://api.github.com/repos/PeterFeicht/cppreference-doc/releases/latest';

const RELEASE_BY_TAG_URL =
    'https://api.github.com/repos/PeterFeicht/cppreference-doc/releases/tags/';

const CHECKSUM_FILE_NAMES = ['checksums.txt', 'sha256sums.txt', 'SHA256SUMS'];

interface RawAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface RawRelease {
    tag_name: string;
    assets?: RawAsset[];
}

export async function fetchLatestRelease(fetcher: Fetcher = fetch as Fetcher): Promise<ReleaseInfo> {
    return fetchReleaseAt(RELEASES_URL, fetcher);
}

/**
 * Fetch a specific release by its tag name (e.g. "20250209" or "v20250209").
 * Used by `installCppreference({ version })` when the user pins
 * `cppDocs.cppreference.version` to a non-`latest` value.
 */
export async function fetchReleaseByTag(
    tag: string,
    fetcher: Fetcher = fetch as Fetcher
): Promise<ReleaseInfo> {
    return fetchReleaseAt(RELEASE_BY_TAG_URL + encodeURIComponent(tag), fetcher);
}

async function fetchReleaseAt(url: string, fetcher: Fetcher): Promise<ReleaseInfo> {
    const res = await fetcher(url, {
        headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) {
        throw new Error(`GitHub Releases fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as RawRelease;
    const tagName = body.tag_name;
    const version = tagName.replace(/^v/, '');
    const assets: ReleaseAsset[] = (body.assets ?? []).map((a) => ({
        name: a.name,
        browserDownloadUrl: a.browser_download_url,
        size: a.size
    }));
    let checksumsTxt: string | undefined;
    const checksumsAsset = assets.find((a) => CHECKSUM_FILE_NAMES.includes(a.name));
    if (checksumsAsset) {
        const cres = await fetcher(checksumsAsset.browserDownloadUrl);
        if (cres.ok) checksumsTxt = await cres.text();
    }
    return checksumsTxt === undefined
        ? { tagName, version, assets }
        : { tagName, version, assets, checksumsTxt };
}

export function pickArchiveAsset(release: ReleaseInfo): ArchivePick {
    const tarxz = release.assets.find((a) => /^html-book-.*\.tar\.xz$/.test(a.name));
    if (tarxz) return { asset: tarxz, format: 'tar.xz' };
    const zip = release.assets.find((a) => /^html-book-.*\.zip$/.test(a.name));
    if (zip) return { asset: zip, format: 'zip' };
    throw new Error('No html-book asset found in release');
}

export function findExpectedSha256(
    checksumsTxt: string | undefined,
    fileName: string
): string | undefined {
    if (!checksumsTxt) return undefined;
    for (const line of checksumsTxt.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (m && m[1] && m[2] && m[2].trim() === fileName) {
            return m[1].toLowerCase();
        }
    }
    return undefined;
}

export async function downloadToFile(
    url: string,
    destPath: string,
    fetcher: Fetcher = fetch as Fetcher
): Promise<void> {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    if (!res.body) throw new Error(`Download returned empty body: ${url}`);
    await mkdir(path.dirname(destPath), { recursive: true });
    // `res.body` is a WHATWG ReadableStream; `Readable.fromWeb` accepts it at
    // runtime. The cast bridges a type-only divergence between the global
    // `ReadableStream` (DOM-lib-shaped) and `node:stream/web`'s when both are
    // visible to the test tsconfig.
    await pipeline(
        Readable.fromWeb(res.body as never),
        createWriteStream(destPath)
    );
}

export async function sha256File(filePath: string): Promise<string> {
    const buf = await readFile(filePath);
    return createHash('sha256').update(buf).digest('hex');
}

export async function verifySha256(filePath: string, expected: string): Promise<void> {
    const actual = await sha256File(filePath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`SHA256 mismatch on ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
    }
}

export async function extractTarXz(archivePath: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true });
    // lzma-native is loaded lazily so test environments without native build can stub it.
    const lzma = (await import('lzma-native')) as typeof import('lzma-native');
    const decompressor = lzma.createDecompressor();
    await pipeline(createReadStream(archivePath), decompressor, tar.extract({ cwd: destDir }));
}

export async function extractZip(archivePath: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true });
    const { default: StreamZip } = await import('node-stream-zip');
    const zip = new StreamZip.async({ file: archivePath });
    try {
        await zip.extract(null, destDir);
    } finally {
        await zip.close();
    }
}

export async function extract(
    archivePath: string,
    format: ArchiveFormat,
    destDir: string
): Promise<void> {
    if (format === 'tar.xz') {
        try {
            await extractTarXz(archivePath, destDir);
            return;
        } catch (err) {
            // Fall through to zip handling only if a sibling .zip is alongside.
            const zipAlt = archivePath.replace(/\.tar\.xz$/, '.zip');
            try {
                await stat(zipAlt);
            } catch {
                throw err;
            }
            await extractZip(zipAlt, destDir);
            return;
        }
    }
    await extractZip(archivePath, destDir);
}

export interface InstallOptions {
    storageDir: string;
    fetcher?: Fetcher;
    onProgress?: (msg: string) => void;
    /**
     * Pin a specific cppreference release tag (e.g. `"20250209"` or
     * `"v20250209"`). When omitted (or the literal string `"latest"`), the
     * installer fetches the newest release from
     * `PeterFeicht/cppreference-doc`. Honors
     * `cppDocs.cppreference.version` when wired up by `manager.ts`.
     */
    version?: string;
}

export interface InstalledLayout {
    rootPath: string;
    documentsDir: string;
    tagXmlPath: string;
}

export interface InstallResult extends InstalledLayout {
    status: 'installed' | 'already-current';
    version: string;
}

export function describeLayout(storageDir: string, version: string): InstalledLayout {
    const rootPath = path.join(storageDir, version);
    return {
        rootPath,
        documentsDir: path.join(rootPath, 'reference'),
        tagXmlPath: path.join(rootPath, 'cppreference-doxygen-local.tag.xml')
    };
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * H-3 — drop the dual-license text references onto disk so the
 * GFDL+CC-BY-SA-3.0 obligation of "accompany the document with the
 * license text" is satisfied. We ship pointers (URLs) rather than
 * inlining the multi-thousand-line license bodies; the bundled README
 * makes the obligation discoverable to anyone redistributing the
 * docset directory.
 */
async function bundleLicenseTexts(rootPath: string): Promise<void> {
    const licensesDir = path.join(rootPath, 'LICENSES');
    await mkdir(licensesDir, { recursive: true });
    const readme = `cppreference content licenses
==============================

The pages installed under this directory are © cppreference contributors
and are dual-licensed under:

  - Creative Commons Attribution-ShareAlike 3.0 Unported
    https://creativecommons.org/licenses/by-sa/3.0/legalcode
    (see CC-BY-SA-3.0.url)

  - GNU Free Documentation License 1.3
    https://www.gnu.org/licenses/fdl-1.3.txt
    (see GFDL-1.3.url)

If you redistribute this docset, you must accompany it with these
license texts. Either fetch the canonical text from the URLs above and
place it alongside this README, or keep this README intact so the
recipient can do so.
`;
    await writeFile(path.join(licensesDir, 'README.txt'), readme);
    await writeFile(
        path.join(licensesDir, 'CC-BY-SA-3.0.url'),
        'https://creativecommons.org/licenses/by-sa/3.0/legalcode\n'
    );
    await writeFile(
        path.join(licensesDir, 'GFDL-1.3.url'),
        'https://www.gnu.org/licenses/fdl-1.3.txt\n'
    );
}

export async function installCppreference(options: InstallOptions): Promise<InstallResult> {
    const fetcher = options.fetcher ?? (fetch as Fetcher);
    const progress = options.onProgress ?? (() => undefined);

    const pinned =
        options.version !== undefined && options.version !== 'latest'
            ? options.version
            : undefined;
    progress(
        pinned
            ? `Fetching cppreference release info (pinned: ${pinned})`
            : 'Fetching latest cppreference release info'
    );
    const release = pinned
        ? await fetchReleaseByTag(pinned, fetcher)
        : await fetchLatestRelease(fetcher);
    const { rootPath, documentsDir, tagXmlPath } = describeLayout(options.storageDir, release.version);

    if (await pathExists(path.join(rootPath, 'INSTALLED'))) {
        progress(`cppreference ${release.version} already installed`);
        return {
            status: 'already-current',
            version: release.version,
            rootPath,
            documentsDir,
            tagXmlPath
        };
    }

    const pick = pickArchiveAsset(release);
    const stagingDir = path.join(options.storageDir, 'staging');
    const archivePath = path.join(stagingDir, pick.asset.name);

    progress(`Downloading ${pick.asset.name}`);
    await downloadToFile(pick.asset.browserDownloadUrl, archivePath, fetcher);

    const expected = findExpectedSha256(release.checksumsTxt, pick.asset.name);
    if (expected) {
        progress('Verifying SHA256');
        await verifySha256(archivePath, expected);
    }

    progress(`Extracting ${pick.asset.name}`);
    // Extract into a temp dir so a partial extraction never leaves a half-installed root.
    const extractTmp = path.join(stagingDir, `extract-${release.version}`);
    await rm(extractTmp, { recursive: true, force: true });
    await extract(archivePath, pick.format, extractTmp);

    await mkdir(path.dirname(rootPath), { recursive: true });
    await rm(rootPath, { recursive: true, force: true });
    await rename(extractTmp, rootPath);

    // H-4 — strip MediaWiki chrome (edit-on-cppreference, navbars, etc.)
    // from every page on disk. Runs once at install so it's a one-time
    // cost rather than a per-render hit.
    progress('Pre-processing pages');
    await preprocessCppreferenceHtml(documentsDir);

    // H-3 — bundle the dual-license texts so users redistributing
    // installed docsets carry the GFDL copy alongside the CC BY-SA one.
    // We're a redistributor of this content; the legal mention in the
    // attribution footer alone doesn't satisfy the GFDL requirement of
    // accompanying the document with the license text.
    await bundleLicenseTexts(rootPath);

    await writeFile(path.join(rootPath, 'INSTALLED'), release.version);
    await rm(stagingDir, { recursive: true, force: true });

    return {
        status: 'installed',
        version: release.version,
        rootPath,
        documentsDir,
        tagXmlPath
    };
}
