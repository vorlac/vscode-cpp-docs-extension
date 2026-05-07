import { Parser } from 'htmlparser2';
import { escapeText } from '../util/html-escape.js';
import { VOID_TAGS, serializeAttrs as _serializeAttrs, type AttrFilter } from './html-serializer.js';

/**
 * Extracts a hover-sized snippet from a cppreference HTML page.
 *
 * Pure function — no fs, no vscode imports. The caller reads the file (or
 * uses a cached string) and passes the raw HTML in. Output is consumed by
 * `ui/hover-provider.ts` (M5.2) which embeds `synopsisHtml + paragraphHtml`
 * into a `MarkdownString` with `supportHtml: true`. Per docs/04-rendering.md
 * § "Snippet extraction (for hover)".
 *
 * Targets cppreference's "Synopsis" table — class `t-dcl-begin` in the
 * `cppreference-doc` archives we ship (verified across vector::push_back,
 * algorithm/sort, basic_string/data fixtures). The historical archive has
 * carried this class since at least 2020; if a future archive renames it
 * the matcher below tolerates `t-dcl` as a synonym.
 */

const SYNOPSIS_CLASSES = ['t-dcl-begin', 't-dcl'];

/**
 * Tags whose output is unsafe (or pointless) inside a `MarkdownString`
 * with `supportHtml: true`. `MarkdownString.supportHtml` already restricts
 * to a small allowlist; this is belt-and-suspenders so the producer never
 * emits something the consumer would have to scrub. `<style>` is excluded
 * because hover popups inherit theme variables and we don't want page
 * styles leaking into them.
 */
const STRIPPED_TAGS = new Set([
    'script',
    'iframe',
    'form',
    'input',
    'button',
    'style'
]);

export interface SnippetOptions {
    /** Maximum characters in the returned content. Default 600. */
    maxChars?: number;
    /** Trim leading/trailing whitespace. Default true. */
    trim?: boolean;
}

export interface ExtractedSnippet {
    /** The synopsis HTML (or empty string if not found). */
    synopsisHtml: string;
    /** The first descriptive paragraph as HTML. */
    paragraphHtml: string;
    /** Synopsis as plain text. */
    synopsisText: string;
    /** Paragraph as plain text. */
    paragraphText: string;
    /** Total character count of synopsisText + paragraphText. */
    totalChars: number;
    /** True if the content was truncated to fit `maxChars`. */
    truncated: boolean;
}

const DEFAULT_MAX_CHARS = 600;
const ELLIPSIS = '…';

/**
 * Filter for `serializeAttrs`: strips navigation attributes on `<a>` tags.
 * The snippet is rendered inside a VSCode hover MarkdownString; relative hrefs
 * there resolve against the active editor's file URI, so clicking a link like
 * `<a href="string.html">strings</a>` opens that path as a TEXT DOCUMENT in
 * the editor rather than navigating in the docs panel.  We have no equivalent
 * of the webview-client click interceptor in a hover, so the safest fix is to
 * drop the href entirely and let the link render as inert prose. The user's
 * intended in-panel navigation is the explicit "Open full reference"
 * command-URI link below the snippet (see buildHoverMarkdown).
 */
const anchorFilter: AttrFilter = (k, v, tag) =>
    tag === 'a' && (k === 'href' || k === 'target' || k === 'rel') ? null : v;

function serializeAttrs(attribs: Record<string, string>, tagName?: string): string {
    return _serializeAttrs(attribs, tagName ?? '', anchorFilter);
}

function classListContainsAny(
    attribs: Record<string, string>,
    tokens: readonly string[]
): boolean {
    const cls = attribs.class;
    if (!cls) return false;
    const parts = cls.split(/\s+/);
    for (const t of tokens) {
        if (parts.includes(t)) return true;
    }
    return false;
}

interface CaptureBuffer {
    html: string[];
    text: string[];
    /** Plain-text length captured so far (matches what `text.join('')` would yield). */
    textLen: number;
}

function newBuffer(): CaptureBuffer {
    return { html: [], text: [], textLen: 0 };
}

function bufferText(buf: CaptureBuffer): string {
    return buf.text.join('');
}

function bufferHtml(buf: CaptureBuffer): string {
    return buf.html.join('');
}

/**
 * Walk the HTML once with htmlparser2 and capture two regions:
 *   1. The contents of the first `<table class="t-dcl-begin">…</table>` (the
 *      "Synopsis").
 *   2. The first `<p>…</p>` that appears AFTER that synopsis table at the
 *      same nesting level (or anywhere later if the synopsis was absent).
 *
 * Truncation is applied across both regions combined: as soon as the running
 * plain-text count exceeds `maxChars`, we stop appending text to the active
 * buffer and mark `truncated: true`. Tag chunks (open/close) continue to
 * emit so the resulting HTML stays well-formed; the budget is a *text*
 * budget, not an HTML byte budget.
 */
export function extractSnippet(
    html: string,
    options?: SnippetOptions
): ExtractedSnippet {
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
    const trim = options?.trim ?? true;

    const synopsis = newBuffer();
    const paragraph = newBuffer();

    /**
     * Mode FSM:
     *   'searching'         — before any synopsis or chosen paragraph. Watching
     *                          for either a synopsis `<table>` or the first
     *                          substantive `<p>`.
     *   'searching-in-p'    — inside a candidate leading `<p>` (fallback for
     *                          prose-only "language" pages). Capture into
     *                          `paragraph` but keep watching for a synopsis;
     *                          if one appears later, the captured paragraph
     *                          is discarded.
     *   'in-synopsis'       — inside the synopsis `<table>`; capture into
     *                          `synopsis`.
     *   'after-synopsis'    — synopsis closed; waiting for next `<p>`.
     *   'in-paragraph'      — inside the post-synopsis `<p>`; capture into
     *                          `paragraph`.
     *   'done'              — both regions resolved; ignore the rest.
     */
    type Mode =
        | 'searching'
        | 'searching-in-p'
        | 'in-synopsis'
        | 'after-synopsis'
        | 'in-paragraph'
        | 'done';
    let mode: Mode = 'searching';

    /**
     * True once any `<p>` (even an empty one) has been seen or claimed as a
     * candidate. Subsequent leading `<p>` tags are ignored unless the prior
     * candidate was empty (we keep trying to find a substantive one).
     */
    let leadingParagraphClaimed = false;
    /** Track whether we hit the text budget while capturing was active. */
    let budgetExhausted = false;
    /** Depth of nested `<table>` tags while inside the synopsis. */
    let synopsisTableDepth = 0;
    /** Depth of nested elements while inside the chosen `<p>`. */
    let paragraphDepth = 0;
    /** Depth of stripped-tag subtrees we are currently dropping. */
    let skipDepth = 0;

    function activeBuffer(): CaptureBuffer | null {
        if (mode === 'in-synopsis') return synopsis;
        if (mode === 'in-paragraph' || mode === 'searching-in-p') return paragraph;
        return null;
    }

    function resetParagraphBuffer(): void {
        paragraph.html.length = 0;
        paragraph.text.length = 0;
        paragraph.textLen = 0;
    }

    function emitTag(htmlChunk: string): void {
        const buf = activeBuffer();
        if (!buf) return;
        // Tag chunks always emit so the captured HTML remains well-formed even
        // after the text budget is exhausted.
        buf.html.push(htmlChunk);
    }

    function emitText(textChunk: string): void {
        const buf = activeBuffer();
        if (!buf) return;
        if (textChunk.length === 0) return;

        const currentTotal = synopsis.textLen + paragraph.textLen;
        if (currentTotal >= maxChars) {
            budgetExhausted = true;
            return;
        }
        const remaining = maxChars - currentTotal;
        if (textChunk.length <= remaining) {
            buf.html.push(escapeText(textChunk));
            buf.text.push(textChunk);
            buf.textLen += textChunk.length;
            return;
        }
        // Partial fit.
        const slice = textChunk.slice(0, remaining);
        buf.html.push(escapeText(slice));
        buf.text.push(slice);
        buf.textLen += slice.length;
        budgetExhausted = true;
    }

    const parser = new Parser(
        {
            onopentag(name, attribs) {
                if (skipDepth > 0) {
                    skipDepth++;
                    return;
                }
                if (STRIPPED_TAGS.has(name)) {
                    skipDepth = 1;
                    return;
                }
                if (mode === 'done') return;

                if (mode === 'searching' || mode === 'searching-in-p') {
                    if (
                        name === 'table' &&
                        classListContainsAny(attribs, SYNOPSIS_CLASSES)
                    ) {
                        // Synopsis trumps any tentative leading paragraph.
                        resetParagraphBuffer();
                        leadingParagraphClaimed = false;
                        paragraphDepth = 0;
                        mode = 'in-synopsis';
                        synopsisTableDepth = 1;
                        emitTag('<table' + serializeAttrs(attribs, 'table') + '>');
                        return;
                    }
                    if (name === 'p' && mode === 'searching' && !leadingParagraphClaimed) {
                        // Begin capturing a tentative leading paragraph. We keep
                        // watching for a synopsis afterwards; if one shows up the
                        // tentative buffer is discarded above.
                        mode = 'searching-in-p';
                        paragraphDepth = 1;
                        leadingParagraphClaimed = true;
                        emitTag('<p' + serializeAttrs(attribs, 'p') + '>');
                        return;
                    }
                    if (mode === 'searching-in-p') {
                        paragraphDepth++;
                        emitTag('<' + name + serializeAttrs(attribs, name) + '>');
                        return;
                    }
                    return;
                }

                if (mode === 'in-synopsis') {
                    if (name === 'table') synopsisTableDepth++;
                    emitTag('<' + name + serializeAttrs(attribs, name) + '>');
                    return;
                }

                if (mode === 'after-synopsis') {
                    if (name === 'p') {
                        mode = 'in-paragraph';
                        paragraphDepth = 1;
                        emitTag('<p' + serializeAttrs(attribs, 'p') + '>');
                        return;
                    }
                    // A section heading after the synopsis means the descriptive
                    // prose region has ended without a `<p>` (e.g. some `enum` pages).
                    if (
                        name === 'h1' ||
                        name === 'h2' ||
                        name === 'h3' ||
                        name === 'h4' ||
                        name === 'h5' ||
                        name === 'h6'
                    ) {
                        mode = 'done';
                    }
                    return;
                }

                if (mode === 'in-paragraph') {
                    paragraphDepth++;
                    emitTag('<' + name + serializeAttrs(attribs, name) + '>');
                    return;
                }
            },
            ontext(text) {
                if (skipDepth > 0) return;
                emitText(text);
            },
            onclosetag(name) {
                if (skipDepth > 0) {
                    skipDepth--;
                    return;
                }
                if (mode === 'done') return;

                if (mode === 'in-synopsis') {
                    if (name === 'table') {
                        synopsisTableDepth--;
                        if (synopsisTableDepth === 0) {
                            emitTag('</table>');
                            mode = 'after-synopsis';
                            return;
                        }
                    }
                    if (VOID_TAGS.has(name)) return;
                    emitTag('</' + name + '>');
                    return;
                }

                if (mode === 'in-paragraph') {
                    paragraphDepth--;
                    if (paragraphDepth === 0 && name === 'p') {
                        emitTag('</p>');
                        mode = 'done';
                        return;
                    }
                    if (VOID_TAGS.has(name)) return;
                    emitTag('</' + name + '>');
                    return;
                }

                if (mode === 'searching-in-p') {
                    paragraphDepth--;
                    if (paragraphDepth === 0 && name === 'p') {
                        emitTag('</p>');
                        // If the tentative paragraph was empty (e.g. cppreference's
                        // `<div class="t-page-template"><p></p></div>` placeholder),
                        // discard it and go back to fully searching — re-arming
                        // leadingParagraphClaimed so we can pick up the *next* `<p>`.
                        const txt = paragraph.text.join('').trim();
                        if (txt.length === 0) {
                            resetParagraphBuffer();
                            leadingParagraphClaimed = false;
                        }
                        mode = 'searching';
                        return;
                    }
                    if (VOID_TAGS.has(name)) return;
                    emitTag('</' + name + '>');
                    return;
                }

                // closing tags in 'searching'/'after-synopsis' are ignored
            }
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
    );

    parser.write(html);
    parser.end();

    let synopsisHtml = bufferHtml(synopsis);
    let synopsisText = bufferText(synopsis);
    let paragraphHtml = bufferHtml(paragraph);
    let paragraphText = bufferText(paragraph);

    if (trim) {
        synopsisHtml = synopsisHtml.trim();
        synopsisText = synopsisText.trim();
        paragraphHtml = paragraphHtml.trim();
        paragraphText = paragraphText.trim();
    }

    // Truncation flag:
    //   - maxChars <= 0: anything captured (or any content the FSM advanced
    //     into) counts as truncated. We also blank the captured HTML/text so
    //     the consumer doesn't have to second-guess "0-budget but tags
    //     emitted" cases.
    //   - otherwise: budgetExhausted records whether we ever blocked or sliced
    //     a text chunk. That's the precise signal — the parser keeps going
    //     either way.
    let truncated: boolean;
    if (maxChars <= 0) {
        truncated = leadingParagraphClaimed || mode !== 'searching';
        synopsisHtml = '';
        synopsisText = '';
        paragraphHtml = '';
        paragraphText = '';
    } else {
        truncated = budgetExhausted;
    }

    // Append a visible ellipsis to mark the cut. Prefer the paragraph (the
    // synopsis is structurally important and an ellipsis inside `</table>`
    // looks broken). If no paragraph was captured, append to the synopsis
    // tail. If neither was captured (maxChars: 0 with no content), nothing.
    if (truncated && maxChars > 0) {
        if (paragraphText.length > 0) {
            paragraphHtml += ELLIPSIS;
            paragraphText += ELLIPSIS;
        } else if (synopsisText.length > 0) {
            synopsisHtml += ELLIPSIS;
            synopsisText += ELLIPSIS;
        }
    }

    return {
        synopsisHtml,
        paragraphHtml,
        synopsisText,
        paragraphText,
        totalChars: synopsisText.length + paragraphText.length,
        truncated
    };
}

/**
 * Convenience wrapper: returns synopsis HTML and paragraph HTML joined by a
 * blank line, suitable for `MarkdownString.appendMarkdown(...)`.
 */
export function extractSnippetHtml(
    html: string,
    options?: SnippetOptions
): string {
    const s = extractSnippet(html, options);
    if (s.synopsisHtml && s.paragraphHtml) {
        return s.synopsisHtml + '\n\n' + s.paragraphHtml;
    }
    return s.synopsisHtml || s.paragraphHtml;
}

/**
 * Convenience wrapper: returns plain text (HTML stripped). Whitespace inside
 * the synopsis is preserved as-is from the source — cppreference indents
 * declarations with spaces, which a hover renderer should keep.
 */
export function extractSnippetText(
    html: string,
    options?: SnippetOptions
): string {
    const s = extractSnippet(html, options);
    if (s.synopsisText && s.paragraphText) {
        return s.synopsisText + '\n\n' + s.paragraphText;
    }
    return s.synopsisText || s.paragraphText;
}
