// Unit tests for the diagnostic OutputChannel singleton (Fix B, iter 37).
//
// We mock `vscode.window.createOutputChannel` so the real
// `OutputChannel` (which only exists inside the host runtime) doesn't
// leak in. The structural stub records every `appendLine` call so the
// tests can assert the formatted line shape directly.

import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeChannel {
    lines: string[] = [];
    shown = 0;
    appendLine(s: string): void {
        this.lines.push(s);
    }
    show(): void {
        this.shown += 1;
    }
    dispose(): void { }
}

let channels: FakeChannel[] = [];

vi.mock('vscode', () => ({
    window: {
        createOutputChannel: (_name: string): FakeChannel => {
            const c = new FakeChannel();
            channels.push(c);
            return c;
        }
    }
}));

import {
    __resetOutputChannelForTests,
    getOutputChannel,
    logEvent
} from '../../src/util/output.js';

afterEach(() => {
    __resetOutputChannelForTests();
    channels = [];
});

describe('getOutputChannel', () => {
    it('lazily constructs the channel on first call and caches it', () => {
        const a = getOutputChannel();
        const b = getOutputChannel();
        expect(a).toBe(b);
        // Only one creation across both calls.
        expect(channels).toHaveLength(1);
    });
});

describe('logEvent', () => {
    it('writes a line shaped `[<iso-stamp>] <event>` when no fields are passed', () => {
        logEvent('test.event');
        const ch = channels[0]!;
        expect(ch.lines).toHaveLength(1);
        expect(ch.lines[0]).toMatch(
            /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] test\.event$/
        );
    });

    it('appends key=value pairs separated by spaces', () => {
        logEvent('test.event', { fqn: 'std::vector', count: 3 });
        const line = channels[0]!.lines[0]!;
        expect(line).toContain('test.event');
        expect(line).toContain('fqn="std::vector"');
        expect(line).toContain('count=3');
    });

    it('JSON-quotes string values so spaces do not run fields together', () => {
        logEvent('e', { msg: 'hello world', n: 1 });
        const line = channels[0]!.lines[0]!;
        expect(line).toContain('msg="hello world"');
        expect(line).toContain('n=1');
    });

    it('renders null and undefined explicitly (so absent fields stay visible)', () => {
        logEvent('e', { a: null, b: undefined });
        const line = channels[0]!.lines[0]!;
        expect(line).toContain('a=null');
        expect(line).toContain('b=undefined');
    });

    it('multiple calls go to the same channel (singleton)', () => {
        logEvent('first');
        logEvent('second');
        expect(channels).toHaveLength(1);
        expect(channels[0]!.lines).toHaveLength(2);
    });

    it('does NOT auto-show the panel — `.show()` is only called by getOutputChannel().show() callers', () => {
        logEvent('e');
        logEvent('e2');
        expect(channels[0]!.shown).toBe(0);
    });
});
