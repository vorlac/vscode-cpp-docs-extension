import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const yml = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
    'utf8'
);

describe('CI workflow', () => {
    it('triggers on push to main and on pull requests', () => {
        expect(yml).toMatch(/branches:\s*\[\s*main\s*\]/);
        expect(yml).toMatch(/pull_request:/);
    });

    it('uses Node 20 with npm cache and npm ci', () => {
        expect(yml).toMatch(/node-version:\s*['"]?20/);
        expect(yml).toMatch(/cache:\s*['"]?npm/);
        expect(yml).toContain('npm ci');
    });

    it('runs typecheck, lint, test, and package', () => {
        expect(yml).toContain('npm run typecheck');
        expect(yml).toContain('npm run lint');
        expect(yml).toContain('npm test');
        expect(yml).toContain('npm run package');
    });

    it('uploads the produced .vsix as an artifact', () => {
        expect(yml).toMatch(/upload-artifact@v\d/);
        expect(yml).toContain("path: '*.vsix'");
    });
});
