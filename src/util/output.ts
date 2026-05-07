// Diagnostic OutputChannel singleton.
//
// Goal: give users (and us) a single Output → "C++ Docs" stream to
// watch when something feels off — resolver missing, lookup empty, page
// not loading. Prior to Fix B (iter 37) the extension was completely
// silent on every miss path; users could only guess whether the
// resolver was firing at all.
//
// Contract:
//   - The channel is created lazily on first use. `vscode.window.createOutputChannel`
//     is a relatively cheap operation, but we still defer it so a
//     headless test run that imports this module pays nothing.
//   - We never call `.show()` from `logEvent` itself — the panel must
//     stay closed until the user opens it via `cppDocs.showOutput` or
//     the View → Output menu. Auto-popping the Output panel during
//     activation would be intrusive, especially since most users will
//     never have a reason to look at it.
//   - `logEvent` is fire-and-forget. No async, no return value, no
//     throwing on a bad write — the channel is a debug aid, never
//     load-bearing.
//
// One liner format: `[<ISO timestamp>] <event> key=value key=value`.
// The flat key=value layout (vs. JSON) keeps the channel readable
// without a JSON pretty-printer. Strings are JSON-quoted so a value
// with a space doesn't run into the next field.

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Singleton accessor for the C++ Docs output channel. Creates it lazily.
 * Exposed so `extension.ts` can register a `cppDocs.showOutput` command
 * that calls `.show()` for users who want to find the panel from the
 * command palette.
 */
export function getOutputChannel(): vscode.OutputChannel {
    if (!channel) channel = vscode.window.createOutputChannel('C++ Docs');
    return channel;
}

/**
 * Write a structured one-liner event to the diagnostic channel. The
 * stamp is ISO-8601 (millisecond precision) so log lines collate
 * sensibly with other VSCode log streams.
 *
 * Field values are formatted via `formatField`: strings are JSON-quoted
 * (so a value with a space can't run into the next field), `null` and
 * `undefined` are spelled out so a missing value is visible, and
 * everything else falls through to `String(v)`.
 */
export function logEvent(
    event: string,
    fields?: Record<string, unknown>
): void {
    const stamp = new Date().toISOString();
    const fieldStr = fields
        ? ' ' +
        Object.entries(fields)
            .map(([k, v]) => `${k}=${formatField(v)}`)
            .join(' ')
        : '';
    getOutputChannel().appendLine(`[${stamp}] ${event}${fieldStr}`);
}

function formatField(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
}

/**
 * Test-only reset for unit tests that want to assert against a fresh
 * channel. Not exported from a barrel; tests reach for it directly.
 */
export function __resetOutputChannelForTests(): void {
    channel?.dispose();
    channel = undefined;
}
