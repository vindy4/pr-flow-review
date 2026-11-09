export type CodeRow = {
  id: string;
  kind: 'context' | 'addition' | 'deletion' | 'hunk' | 'notice';
  text: string;
  baseLine?: number;
  headLine?: number;
};
export type TextMatch = { id: string; rowId: string; start: number; end: number };
export type ReaderSearch = { byRow: ReadonlyMap<string, TextMatch[]>; activeId?: string };

export function sourceRows(code: string, startLine = 1, side: 'base' | 'head' = 'head'): CodeRow[] {
  return code.replace(/\r?\n$/, '').split(/\r?\n/).map((text, index) => ({
    id: `source-${startLine + index}`, kind: 'context', text,
    ...(side === 'base' ? { baseLine: startLine + index } : { headLine: startLine + index }),
  }));
}

export function diffRows(diff: string, baseStart = 1, headStart = 1): CodeRow[] {
  let before = 0, after = 0, inHunk = false;
  const rows: CodeRow[] = [];
  for (const [index, line] of diff.replace(/\r?\n$/, '').split(/\r?\n/).entries()) {
    const id = `diff-${index}`;
    const hunk = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      const oldOffset = Number(hunk[1]), newOffset = Number(hunk[3]);
      before = oldOffset ? baseStart + oldOffset - 1 : 0;
      after = newOffset ? headStart + newOffset - 1 : 0;
      inHunk = true;
      rows.push({ id, kind: 'hunk', text: `@@ -${before}${hunk[2] || ''} +${after}${hunk[4] || ''} @@${hunk[5]}` });
    } else if (inHunk && line.startsWith('+')) {
      rows.push({ id, kind: 'addition', text: line.slice(1), headLine: after++ });
    } else if (inHunk && line.startsWith('-')) {
      rows.push({ id, kind: 'deletion', text: line.slice(1), baseLine: before++ });
    } else if (inHunk && line.startsWith(' ')) {
      rows.push({ id, kind: 'context', text: line.slice(1), baseLine: before++, headLine: after++ });
    } else if (inHunk && line.startsWith('\\')) {
      rows.push({ id, kind: 'notice', text: line.slice(1).trim() });
    }
  }
  return rows;
}

export function findTextMatches(rows: readonly CodeRow[], query: string): TextMatch[] {
  if (!query.trim()) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches: TextMatch[] = [];
  for (const row of rows) {
    if (row.kind === 'hunk' || row.kind === 'notice') continue;
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(row.text)) !== null) {
      matches.push({ id: `${row.id}:${match.index}`, rowId: row.id, start: match.index, end: match.index + match[0].length });
    }
  }
  return matches;
}
