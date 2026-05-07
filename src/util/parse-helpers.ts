export function findMatchingParen(s: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}
