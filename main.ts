// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1-4 (command line, output and exit codes, safe paths, format detection),
// 9 (JSON edits) and 10 (order and atomicity) follow the kit starter; sections 5
// (matching tiers), 6 (unified diffs), 7 (SEARCH/REPLACE blocks) and 8 (V4A patches)
// are implemented here, plus the `R <old> -> <new>` output line for moves.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a line break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** Leading spaces and tabs of a line. */
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripT = (s: string): string => s.replace(/[ \t]+$/, '');
const stripLT = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripT(a) === stripT(b);
  return stripLT(a) === stripLT(b);
}

/** 0-based positions where O occurs in lines at the tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(from, 0); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!tierEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs. */
function findTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/**
 * Tier-2 re-indentation (SPEC.md section 5): a non-context line of N that is not
 * empty and not only whitespace, and starts with P (the leading spaces/tabs of
 * O's first line), has that P replaced by F (those of the file's first matched line).
 * At tiers 0 and 1 lines are written as they are.
 */
function reindent(line: string, firstFileLine: string, oFirstLine: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  const p = lead(oFirstLine);
  if (!line.startsWith(p)) return line;
  return lead(firstFileLine) + line.slice(p.length);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in patch order. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Shared body model for unified hunks and V4A chunks (sections 5-8)  */
/* ------------------------------------------------------------------ */

/** One body line of a hunk or chunk. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  /** The line's text, without its leading marker character. */
  text: string;
  /** A `\` line follows this body line. */
  noEol: boolean;
  /** The patch line this came from was empty (a context line with empty text). */
  fromEmpty: boolean;
}

/** A new line of N: its text, and the index into O when it is a context line. */
interface NewLine {
  text: string;
  oIdx: number | null;
}

interface SplitBody {
  /** O: the context and `-` lines, in body order. */
  o: string[];
  /** N: the context and `+` lines, in body order. */
  n: NewLine[];
  /** Whether a `\` line follows the body's last context or `+` line. */
  noEol: boolean;
}

function splitBody(body: BodyLine[]): SplitBody {
  const o: string[] = [];
  const n: NewLine[] = [];
  let noEol = false;
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, oIdx: o.length - 1 });
      noEol = b.noEol;
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, oIdx: null });
      noEol = b.noEol;
    }
  }
  return { o, n, noEol };
}

/** Build the replacement lines for a match at `pos` (context lines from the file). */
function replacementLines(st: FileState, pos: number, s: SplitBody, tier: number): string[] {
  return s.n.map((nl) => (nl.oIdx !== null ? st.lines[pos + nl.oIdx]! : reindent(nl.text, st.lines[pos]!, s.o[0]!, tier)));
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                          */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** The hunk header's old start line A (1-based). */
  a: number;
  body: BodyLine[];
}

/**
 * A section's old/new path: a string, null when the header names /dev/null,
 * undefined when nothing names one.
 */
interface UniSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'between' | 'body' = 'outside';
  let hunk: Hunk | null = null;

  const newSection = (oldP: string | null | undefined, newP: string | null | undefined): void => {
    cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    state = 'header';
    hunk = null;
  };
  /** Start a section from a `--- ` line followed by a `+++ ` line. */
  const sectionFromPair = (i: number): void => {
    newSection(headerPath(lines[i]!), headerPath(lines[i + 1]!));
  };
  const startHunk = (i: number): void => {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    hunk = { a: parseInt(m[1]!, 10), body: [] };
    cur!.hunks.push(hunk);
    state = 'body';
  };
  /** End the current hunk body: trailing empty lines are not part of it. */
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.fromEmpty && !last.noEol) hunk.body.pop();
        else break;
      }
    }
    hunk = null;
    state = 'between';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      // A `--- ` line followed by a `+++ ` line ends the body and starts a section.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        sectionFromPair(i);
        i += 2;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        endBody();
        const m = DIFF_GIT_RE.exec(line.trimEnd());
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        const fromEmpty = line === '';
        hunk!.body.push({ kind: fromEmpty ? ' ' : (line[0] as ' ' | '-' | '+'), text: fromEmpty ? '' : line.slice(1), noEol: false, fromEmpty });
        i += 1;
        continue;
      }
      if (line.startsWith('\\')) {
        const body = hunk!.body;
        if (body.length > 0) body[body.length - 1]!.noEol = true;
        i += 1;
        continue;
      }
      // Any other line ends the body; re-process it outside the body.
      endBody();
      continue;
    }
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line.trimEnd());
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sectionFromPair(i);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line.trimEnd());
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(m[1]!, m[2]!);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.oldPath = headerPath(line);
          cur!.newPath = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur!.newPath = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(i);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) cur!.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur!.isDelete = true;
      else if (line.startsWith('rename from ')) {
        if (cur!.oldPath === undefined) cur!.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur!.newPath === undefined) cur!.newPath = line.slice('rename to '.length).trim();
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: lines, and any other line, are ignored.
      i += 1;
      continue;
    }
    // state === 'between'
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sectionFromPair(i);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      startHunk(i);
      i += 1;
      continue;
    }
    // Prose and any other line outside bodies are ignored.
    i += 1;
  }
  if (state === 'body') endBody();
  return sections;
}

/** Apply one section's hunks to a file state, in order (section 6). */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const s = splitBody(h.body);
    if (s.o.length === 0) {
      const oldLen = st.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const ins = s.n.map((nl) => nl.text);
      st.lines.splice(at, 0, ...ins);
      if (at === oldLen) st.final = !s.noEol;
      d += s.n.length;
      continue;
    }
    const found = findTier(s.o, st.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const oldLen = st.lines.length;
    const repl = replacementLines(st, pos, s, found.tier);
    st.lines.splice(pos, s.o.length, ...repl);
    if (pos + s.o.length === oldLen) st.final = !s.noEol;
    d += s.n.length - s.o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    return (tree: Tree): void => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        if (newP === null || newP === undefined) return; // degenerate: no new path to create
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b.kind === '+') {
              plus.push(b.text);
              noEol = b.noEol;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (oldP === null || oldP === undefined) return; // degenerate: no old path to delete
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      const isMove =
        oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP;
      const path = isMove ? oldP! : (oldP ?? newP);
      if (path === null || path === undefined) return; // degenerate: no path at all
      const text = tree.get(path);
      if (text === null) throw new Fail('missing', path);
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const st = readState(text);
      applyHunks(st, sec.hunks, strict, path);
      const out = writeState(st);
      if (isMove) {
        tree.now.set(newP!, out);
        tree.now.set(oldP!, null);
        tree.moves.push([oldP!, newP!]);
      } else {
        tree.now.set(path, out);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                  */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const st = readState(text);
      const found = findTier(oldLines, st.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = newLines.map((nl) => reindent(nl, st.lines[pos]!, oldLines[0]!, found.tier));
      st.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, writeState(st));
    });
    prevPath = p;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                            */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The anchor text, or null when the `@@` line carried none. */
  anchor: string | null;
  body: BodyLine[];
  /** A `*** End of File` line closed this chunk. */
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Add: the section's lines. Update: the `*** Move to:` path, or null. */
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  /** The 1-based line number of the section's start line (for parse errors). */
  line: number;
}

const V4A_SECTION_RE = /^\*\*\* (Add File|Delete File|Update File): /;

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = V4A_SECTION_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = line.slice(m[0].length).trim();
    const sec: V4aSection = { kind, path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
    sections.push(sec);
    i += 1;
    if (kind === 'add') {
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION_RE.test(l)) break;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (blank(l)) content.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      // Blank lines at the end of a section are not part of it.
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      sec.addLines = content;
      continue;
    }
    if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION_RE.test(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      continue;
    }
    // Update File.
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    let curChunk: V4aChunk | null = null;
    while (i < last) {
      const l = lines[i]!;
      if (V4A_SECTION_RE.test(l)) break;
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
        sec.chunks.push(curChunk);
        i += 1;
        continue;
      }
      if (l.trimEnd() === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
        curChunk.eof = true;
        curChunk = null;
        i += 1;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l)) {
        if (curChunk === null) {
          // A blank line after a chunk closed by `*** End of File` is a blank
          // line at the end of the section: not part of it, ignored.
          if (blank(l)) {
            i += 1;
            continue;
          }
          if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          curChunk = { anchor: null, body: [], eof: false };
          sec.chunks.push(curChunk);
        }
        // A blank patch line (empty or only whitespace) is an empty context line.
        const fromEmpty = blank(l);
        curChunk.body.push({
          kind: l.startsWith(' ') || blank(l) ? ' ' : (l[0] as '-' | '+'),
          text: blank(l) ? '' : l.slice(1),
          noEol: false,
          fromEmpty,
        });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Blank lines at the end of a section are not part of it.
    const lastChunk = sec.chunks[sec.chunks.length - 1];
    if (lastChunk !== undefined && curChunk === lastChunk) {
      while (lastChunk.body.length > 0) {
        const b = lastChunk.body[lastChunk.body.length - 1]!;
        if (b.fromEmpty && !b.noEol) lastChunk.body.pop();
        else break;
      }
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
  }

  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const content = sec.addLines;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const st = readState(text);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const found = findTier([ch.anchor], st.lines, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          cursor = found.positions[0]! + 1;
        }
        const s = splitBody(ch.body);
        if (s.o.length === 0) {
          const at = ch.eof ? st.lines.length : cursor;
          const ins = s.n.map((nl) => nl.text);
          st.lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        let found: { tier: number; positions: number[] } | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          let pos = occurrences(s.o, st.lines, t, cursor);
          if (ch.eof) pos = pos.filter((q) => q + s.o.length === st.lines.length);
          if (pos.length > 0) {
            found = { tier: t, positions: pos };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const repl = replacementLines(st, pos, s, found.tier);
        st.lines.splice(pos, s.o.length, ...repl);
        cursor = pos + repl.length;
      }
      const out = writeState(st);
      if (moveTo !== null) {
        tree.now.set(moveTo, out);
        tree.now.set(p, null);
        tree.moves.push([p, moveTo]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Command line (section 1) and output (section 2)                    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && finalState(oldP) === null && tree.original(newP) === null && finalState(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
