import { FunctionNode } from '@codeflow-map/core';

export interface FunctionComment {
  text: string;
  raw: string;
  style: 'line' | 'block' | 'docstring';
}

function indentation(line: string): string {
  return line.match(/^\s*/)?.[0] || '';
}

function cleanLineComment(lines: string[], marker: '#' | '//'): string {
  return lines
    .map(line => line.trim().replace(marker === '#' ? /^#\s?/ : /^\/{2,3}[!]?\s?/, ''))
    .join('\n')
    .trim();
}

function cleanBlockComment(lines: string[]): string {
  return lines
    .map((line, index) => {
      let value = line.trim();
      if (index === 0) value = value.replace(/^\/\*+\s?/, '');
      if (index === lines.length - 1) value = value.replace(/\s*\*\/$/, '');
      return value.replace(/^\*\s?/, '');
    })
    .join('\n')
    .trim();
}

function startsTripleQuotedString(value: string, delimiter: `"""` | `'''`): boolean {
  return new RegExp(`^[rRuUbBfF]{0,2}${delimiter}`).test(value.trim());
}

function cleanTripleQuotedString(
  lines: string[],
  delimiter: `"""` | `'''`,
  declarationIndent: string,
): string {
  const values = lines.map(line => line.startsWith(declarationIndent)
    ? line.slice(declarationIndent.length)
    : line.trimStart());
  values[0] = values[0].replace(new RegExp(`^[rRuUbBfF]{0,2}${delimiter}`), '');
  values[values.length - 1] = values[values.length - 1].replace(new RegExp(`${delimiter}\\s*$`), '');

  while (values.length > 0 && values[0].trim() === '') values.shift();
  while (values.length > 0 && values[values.length - 1].trim() === '') values.pop();

  const contentIndents = values
    .filter(line => line.trim() !== '')
    .map(line => line.match(/^\s*/)?.[0].length || 0);
  const commonIndent = contentIndents.length > 0 ? Math.min(...contentIndents) : 0;
  return values.map(line => line.slice(Math.min(commonIndent, line.length))).join('\n').trim();
}

/** Extract a contiguous documentation comment immediately above a declaration. */
export function extractLeadingFunctionComment(content: string, node: FunctionNode): FunctionComment | undefined {
  const lines = content.split(/\r?\n/);
  if (node.startLine <= 0 || node.startLine >= lines.length) return undefined;

  const declarationIndent = indentation(lines[node.startLine]);
  let cursor = node.startLine - 1;

  // Decorators and common language attributes remain part of the declaration
  // boundary, so a comment immediately above them still documents the function.
  while (cursor >= 0) {
    const trimmed = lines[cursor].trim();
    if ((trimmed.startsWith('@') || /^#\[.*\]$/.test(trimmed))
      && indentation(lines[cursor]) === declarationIndent) {
      cursor--;
      continue;
    }
    break;
  }

  if (cursor < 0 || lines[cursor].trim() === '') return undefined;
  const lastLine = lines[cursor];
  const lastTrimmed = lastLine.trim();

  const isPythonLineComment = node.language === 'python'
    && lastTrimmed.startsWith('#')
    && !lastTrimmed.startsWith('#!');
  const isSlashLineComment = lastTrimmed.startsWith('//');
  if (isPythonLineComment || isSlashLineComment) {
    const marker = isPythonLineComment ? '#' : '//';
    const commentLines: string[] = [];
    while (cursor >= 0) {
      const line = lines[cursor];
      const trimmed = line.trim();
      const matches = marker === '#'
        ? trimmed.startsWith('#') && !trimmed.startsWith('#!')
        : trimmed.startsWith('//');
      if (!matches || indentation(line) !== declarationIndent) break;
      commentLines.unshift(line);
      cursor--;
    }
    const text = cleanLineComment(commentLines, marker);
    return text ? { text, raw: commentLines.join('\n'), style: 'line' } : undefined;
  }

  if (lastTrimmed.endsWith('*/')) {
    const commentLines: string[] = [];
    let foundStart = false;
    while (cursor >= 0) {
      const line = lines[cursor];
      commentLines.unshift(line);
      if (line.includes('/*')) {
        foundStart = true;
        break;
      }
      cursor--;
    }
    if (!foundStart || indentation(commentLines[0]) !== declarationIndent) return undefined;
    const text = cleanBlockComment(commentLines);
    return text ? { text, raw: commentLines.join('\n'), style: 'block' } : undefined;
  }

  if (node.language === 'python') {
    const closingMatch = /("""|''')\s*$/.exec(lastTrimmed);
    if (closingMatch) {
      const delimiter = closingMatch[1] as `"""` | `'''`;
      const commentLines: string[] = [lastLine];
      const occurrencesOnLastLine = lastTrimmed.split(delimiter).length - 1;
      let foundStart = occurrencesOnLastLine >= 2 && startsTripleQuotedString(lastTrimmed, delimiter);

      while (!foundStart && --cursor >= 0) {
        const line = lines[cursor];
        commentLines.unshift(line);
        if (startsTripleQuotedString(line, delimiter)) foundStart = true;
      }

      if (foundStart && indentation(commentLines[0]) === declarationIndent) {
        const text = cleanTripleQuotedString(commentLines, delimiter, declarationIndent);
        return text ? { text, raw: commentLines.join('\n'), style: 'docstring' } : undefined;
      }
    }
  }

  return undefined;
}
