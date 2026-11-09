/** Lightweight declaration facts for source navigation, rather than a dependency graph. */
type Fact = { label: string; line: number };
type Token = { value: string; kind: 'word' | 'string' | 'punct'; start: number; end: number; line: number; endLine: number };

function quotedEnd(code: string, start: number, delimiter: string): number {
  let cursor = start + delimiter.length;
  while (cursor < code.length) {
    if (code[cursor] === '\\') { cursor += 2; continue; }
    if (code.startsWith(delimiter, cursor)) return cursor + delimiter.length;
    if (delimiter === '`' && code.startsWith('${', cursor)) cursor = interpolationEnd(code, cursor + 2);
    else cursor++;
  }
  return code.length;
}

function interpolationEnd(code: string, start: number): number {
  let cursor = start, braces = 1;
  while (cursor < code.length) {
    const char = code[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = quotedEnd(code, cursor, char);
    else if (code.startsWith('//', cursor)) {
      const end = code.indexOf('\n', cursor + 2);
      cursor = end < 0 ? code.length : end;
    } else if (code.startsWith('/*', cursor)) {
      const end = code.indexOf('*/', cursor + 2);
      cursor = end < 0 ? code.length : end + 2;
    } else {
      if (char === '{') braces++;
      if (char === '}' && --braces === 0) return cursor + 1;
      cursor++;
    }
  }
  return code.length;
}

function tokenize(code: string, python: boolean) {
  const tokens: Token[] = [];
  const clean = code.split('');
  let cursor = 0, line = 1;
  function advance(end: number, comment = false) {
    while (cursor < end) {
      if (code[cursor] === '\n') line++;
      if (comment && code[cursor] !== '\n' && code[cursor] !== '\r') clean[cursor] = ' ';
      cursor++;
    }
  }
  while (cursor < code.length) {
    const start = cursor, first = code[cursor], startLine = line;
    if (/\s/.test(first)) { advance(cursor + 1); continue; }
    if ((python && first === '#') || (!python && code.startsWith('//', cursor))) {
      const end = code.indexOf('\n', cursor);
      advance(end < 0 ? code.length : end, true);
      continue;
    }
    if (!python && code.startsWith('/*', cursor)) {
      const end = code.indexOf('*/', cursor + 2);
      advance(end < 0 ? code.length : end + 2, true);
      continue;
    }
    let kind: Token['kind'] = 'punct', end = cursor + 1;
    if (first === '"' || first === "'" || (!python && first === '`')) {
      kind = 'string';
      const delimiter = python && code.startsWith(first.repeat(3), cursor) ? first.repeat(3) : first;
      end = quotedEnd(code, cursor, delimiter);
    } else if (!python && first === '/' && (!tokens.length || /^(?:[=(:,!\[\{;?]|return|throw|case|=>)$/.test(tokens.at(-1)!.value))) {
      // Regex bodies can contain comment-like slashes and declaration keywords.
      kind = 'string';
      let characterClass = false;
      while (end < code.length && code[end] !== '\n') {
        const char = code[end++];
        if (char === '\\') { end++; continue; }
        if (char === '[') characterClass = true;
        if (char === ']') characterClass = false;
        if (char === '/' && !characterClass) {
          while (/[a-z]/i.test(code[end] || '')) end++;
          break;
        }
      }
    } else if (/[A-Za-z_$]/.test(first)) {
      kind = 'word';
      while (/[\w$]/.test(code[end] || '')) end++;
    } else if (code.startsWith('=>', cursor)) end++;
    advance(Math.min(end, code.length));
    tokens.push({ value: code.slice(start, cursor), kind, start, end: cursor, line: startLine, endLine: line });
  }
  return { tokens, clean: clean.join('') };
}

function bodyHeader(tokens: Token[], start: number) {
  let index = start + 1;
  while (/^(?:default|async|declare|abstract)$/.test(tokens[index]?.value || '')) index++;
  return /^(?:function|class|interface|enum|namespace|module)$/.test(tokens[index]?.value || '');
}

function statementEnd(tokens: Token[], start: number, python: boolean, header: boolean) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index], value = token.value, next = tokens[index + 1];
    if (token.kind === 'punct') {
      if (depth === 0 && (value === ';' || (header && value === '{'))) return index;
      if ('([{'.includes(value)) depth++;
      else if (')]}'.includes(value)) depth = Math.max(0, depth - 1);
    }
    if (!next) return index;
    if (depth === 0 && next.line > token.endLine) {
      const continuation = python ? value === '\\' :
        /^(?:import|export|from|as|type|default|async|declare|abstract|const|let|var|with|assert|[=,.+*?:]|=>)$/.test(value)
        || /^(?:from|with|assert|[=,.+*?:])$/.test(next.value);
      if (!continuation) return index;
    }
  }
  return tokens.length - 1;
}

export function sourceFacts(code: string, path: string): { imports: Fact[]; exports: Fact[] } {
  const facts = { imports: [] as Fact[], exports: [] as Fact[] };
  const python = /\.py$/i.test(path);
  if (!python && !/\.[cm]?[jt]sx?$/i.test(path)) return facts;
  const { tokens, clean } = tokenize(code, python);
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
    const begins = !previous || previous.endLine < token.line || previous.value === ';'
      || (python ? previous.value === ':' : previous.value === '}');
    const imported = token.kind === 'word' && (token.value === 'import' || (python && token.value === 'from'));
    const exported = !python && token.kind === 'word' && token.value === 'export';
    const staticImport = python || (next && next.value !== '(' && next.value !== '.');
    if (begins && (python || depth === 0) && ((imported && staticImport) || exported)) {
      const end = statementEnd(tokens, index, python, exported && bodyHeader(tokens, index));
      const valid = !python || token.value !== 'from' || tokens.slice(index + 1, end + 1).some(t => t.value === 'import' && t.kind === 'word');
      if (valid) {
        const label = clean.slice(token.start, tokens[end].end).replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        (imported ? facts.imports : facts.exports).push({ label, line: token.line });
        // A function/class header leaves its body open; declarations there must
        // not masquerade as module-level JavaScript imports or exports.
        for (; index <= end; index++) {
          if (tokens[index].kind !== 'punct') continue;
          if ('([{'.includes(tokens[index].value)) depth++;
          else if (')]}'.includes(tokens[index].value)) depth = Math.max(0, depth - 1);
        }
        index--;
        continue;
      }
    }
    if (token.kind === 'punct') {
      if ('([{'.includes(token.value)) depth++;
      else if (')]}'.includes(token.value)) depth = Math.max(0, depth - 1);
    }
  }
  return facts;
}
