export type GitDiffLineKind = 'context' | 'added' | 'removed';

export interface GitDiffLine {
  kind: GitDiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
  /** Current-file line before which a removed row should be displayed. */
  anchorNewLine?: number;
}

export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: GitDiffLine[];
}

export interface GitFileLineDiff {
  oldPath?: string;
  newPath?: string;
  hunks: GitDiffHunk[];
}

export type GitLineDiffMap = Record<string, GitFileLineDiff>;

function decodeGitPath(rawPath: string): string | undefined {
  if (rawPath === '/dev/null') return undefined;
  let value = rawPath.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value.replace(/^[ab]\//, '').replace(/\\/g, '/');
}

/** Parse the zero-context unified patch emitted by `git diff --unified=0`. */
export function parseGitUnifiedDiff(patch: string): GitLineDiffMap {
  const files: GitLineDiffMap = {};
  const lines = patch.split(/\r?\n/);
  let currentFile: GitFileLineDiff | undefined;
  let currentHunk: GitDiffHunk | undefined;
  let oldCursor = 0;
  let newCursor = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentFile = { hunks: [] };
      currentHunk = undefined;
      continue;
    }
    if (!currentFile) continue;

    if (line.startsWith('--- ')) {
      currentFile.oldPath = decodeGitPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      currentFile.newPath = decodeGitPath(line.slice(4));
      const key = currentFile.newPath || currentFile.oldPath;
      if (key) files[key] = currentFile;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      oldCursor = currentHunk.oldStart;
      newCursor = currentHunk.newStart;
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk || line.startsWith('\\ No newline at end of file')) continue;

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        kind: 'removed',
        content: line.slice(1),
        oldLine: oldCursor++,
        anchorNewLine: currentHunk.newCount === 0 ? currentHunk.newStart + 1 : newCursor,
      });
    } else if (line.startsWith('+')) {
      currentHunk.lines.push({ kind: 'added', content: line.slice(1), newLine: newCursor++ });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        oldLine: oldCursor++,
        newLine: newCursor++,
      });
    }
  }

  return files;
}
