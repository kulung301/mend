// mend: one patch tool for every AI edit format (SPEC.md is the contract).
//
// main.ts is the CLI of SPEC.md sections 1 to 10 and, in a trial, the agent the grader runs: with
// MAKEFUN_ENV_URL set it hands over to runner.ts (the last lines below; kept as the kit has them), and
// runner.ts runs this file once per check without that variable. Node 22, standard library alone.
//
// The CLI reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and writes every change or
// none, printing what it changed or why it failed.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move pairs [old, new] recorded by move edits that ran to completion. */
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

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

/** A file's text as its lines, its own line break and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** A file an edit creates: LF breaks, ending with a break when it holds any line the format ends so. */
function createdText(lines: string[], fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (fin ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const NORMS: ((s: string) => string)[] = [(s) => s, rstrip, strip];

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Every start position at or after `from` where O's lines match the file's lines at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, endAt?: number): number[] {
  const norm = NORMS[tier]!;
  const want = o.map(norm);
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    if (endAt !== undefined && i + o.length !== endAt) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (only tier 0 when strict) at which O occurs, with its occurrences. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  endAt?: number,
): { tier: number; occ: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, o, tier, from, endAt);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first tier at which a single anchor line occurs at or after `from`, and where. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const norm = NORMS[tier]!;
    const want = norm(anchor);
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (norm(lines[i]!) === want) return i;
    }
  }
  return -1;
}

/** A tier-2 line of N re-indented: its P (O's first line's lead) replaced by F (the file's). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/** One body line of a hunk or chunk: context (' '), old ('-') or new ('+'). */
interface BodyLine {
  tag: ' ' | '-' | '+';
  text: string;
  /** True when the patch line was a completely empty line (an empty context line). */
  empty: boolean;
  /** True when a `\` line follows this body line in the patch. */
  noNl: boolean;
}

/**
 * The lines a matched hunk or chunk writes: context lines are the file's own matched lines, `-`
 * lines drop out, `+` lines are the patch's (re-indented at tier 2).
 */
function replacement(lines: string[], pos: number, o: string[], body: BodyLine[], tier: number): string[] {
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  const f = tier === 2 ? leadWs(lines[pos] ?? '') : '';
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.tag === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (b.tag === '-') {
      oi += 1;
    } else {
      out.push(tier === 2 ? reindent(b.text, p, f) : b.text);
    }
  }
  return out;
}

const oldLines = (body: BodyLine[]): string[] => body.filter((b) => b.tag !== '+').map((b) => b.text);
const newLines = (body: BodyLine[]): string[] => body.filter((b) => b.tag !== '-').map((b) => b.text);

/** Whether the hunk's last context or `+` line is followed by a `\` line. */
function noNlAfterLastWrite(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.tag !== '-') return body[i]!.noNl;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
  pairSeen: boolean;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const headPath = (raw: string): string => raw.split('\t')[0]!.trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, isNew: false, isDel: false, hunks: [], pairSeen: false };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    const pairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (pairStart && !(cur !== null && inHeader && !cur.pairSeen)) {
      cur = { oldPath: null, newPath: null, isNew: false, isDel: false, hunks: [], pairSeen: false };
      sections.push(cur);
      inHeader = true;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headPath(line.slice(4));
        cur.newPath = headPath(lines[i + 1]!.slice(4));
        cur.pairSeen = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
        i += 1;
        continue;
      }
      if (!line.startsWith('@@')) {
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur.isDel || cur.newPath === '/dev/null') {
        // A deletion's hunks are not read; the line is skipped like prose.
        i += 1;
        continue;
      }
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ tag: ' ', text: '', empty: true, noNl: false });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          body.push({ tag: c, text: bl.slice(1), empty: false, noNl: false });
          j += 1;
          continue;
        }
        if (c === '\\') {
          const prev = body[body.length - 1];
          if (prev) prev.noNl = true;
          j += 1;
          continue;
        }
        break;
      }
      // Trailing context lines with empty text (a bare line or a single space) are not part of the body.
      while (body.length > 0 && body[body.length - 1]!.tag === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply one section's hunks in order to a file's lines; returns the new state. */
function applyHunks(state: FileLines, hunks: UHunk[], strict: boolean, srcPath: string): FileLines {
  const lines = [...state.lines];
  let fin = state.fin;
  let d = 0;
  for (const hunk of hunks) {
    const o = oldLines(hunk.body);
    if (o.length === 0) {
      const add = newLines(hunk.body);
      const at = Math.min(hunk.a + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...add);
      if (atEnd) fin = !noNlAfterLastWrite(hunk.body);
      d += add.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', srcPath);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const rep = replacement(lines, pos, o, hunk.body, found.tier);
    const atEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...rep);
    if (atEnd) fin = !noNlAfterLastWrite(hunk.body);
    d += rep.length - o.length;
  }
  return { lines, br: state.br, fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  return parseUnified(lines).map((sec) => (tree: Tree) => {
    const oldP = sec.oldPath === null ? null : stripPrefix(sec.oldPath);
    const newP = sec.newPath === null ? null : stripPrefix(sec.newPath);
    const creation = sec.isNew || oldP === '/dev/null';
    const deletion = sec.isDel || newP === '/dev/null';
    if (creation) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let lastPlus: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.tag === '+') {
            content.push(b.text);
            lastPlus = b;
          }
        }
      }
      tree.now.set(p, createdText(content, lastPlus === null ? true : !lastPlus.noNl));
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (!safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(from);
    if (text === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const out = applyHunks(splitFile(text), sec.hunks, strict, from);
    tree.now.set(to, joinFile(out));
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  old: string[];
  neu: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const cand = lines[k]!;
      if (!blank(cand) && !cand.trim().startsWith('```')) {
        path = cand.trim();
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let j = i + 1;
    const old: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      old.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine + 1}`);
    j += 1;
    const neu: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      neu.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, old, neu });
    lastPath = path;
    prevEnd = j + 1;
    i = j + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, createdText(b.neu, true));
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const state = splitFile(text);
    const found = findTier(state.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    let add = b.neu;
    if (found.tier === 2) {
      const p = leadWs(b.old[0]!);
      const f = leadWs(state.lines[pos]!);
      add = b.neu.map((l) => reindent(l, p, f));
    }
    state.lines.splice(pos, b.old.length, ...add);
    tree.now.set(b.path, joinFile(state));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function parseV4a(lines: string[]): VSection[] {
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
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  // Trailing context lines with empty text (a bare line or a single space) are not part of a chunk.
  const closeChunk = (): void => {
    if (chunk !== null) {
      while (chunk.body.length > 0 && chunk.body[chunk.body.length - 1]!.tag === ' ' && chunk.body[chunk.body.length - 1]!.text === '') chunk.body.pop();
    }
  };
  const closeSection = (): void => {
    if (cur !== null && cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
    if (cur !== null && cur.kind === 'upd') closeChunk();
    if (cur !== null && cur.kind === 'upd' && cur.chunks.length === 0 && cur.moveTo === null) {
      throw new Exit2(`error: parse ${cur.atLine + 1}`);
    }
    cur = null;
    chunk = null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    if (line.startsWith(V_ADD) || line.startsWith(V_DEL) || line.startsWith(V_UPD)) {
      closeSection();
      const kind = line.startsWith(V_ADD) ? 'add' : line.startsWith(V_DEL) ? 'del' : 'upd';
      const prefix = kind === 'add' ? V_ADD : kind === 'del' ? V_DEL : V_UPD;
      cur = { kind, path: line.slice(prefix.length).trim(), atLine: i, addLines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line === '') {
        cur.addLines.push('');
        continue;
      }
      if (line.startsWith('+')) {
        cur.addLines.push(line.slice(1));
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Update File section.
    if (line.startsWith(V_MOVE) && cur.moveTo === null && cur.chunks.length === 0 && chunk === null) {
      cur.moveTo = line.slice(V_MOVE.length).trim();
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk !== null) {
        closeChunk();
        chunk.eof = true;
        chunk = null;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: line.slice(2).trim() || null, eof: false, body: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) {
        if (cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
        chunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.body.push({ tag: ' ', text: '', empty: true, noNl: false });
      else chunk.body.push({ tag: line[0] as ' ' | '-' | '+', text: line.slice(1), empty: false, noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, createdText(sec.addLines, true));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const to = sec.moveTo;
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const state = splitFile(text);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(state.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = oldLines(ch.body);
      if (o.length === 0) {
        const add = newLines(ch.body);
        const at = ch.eof ? state.lines.length : Math.min(cursor, state.lines.length);
        state.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTier(state.lines, o, strict, cursor, ch.eof ? state.lines.length : undefined);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.occ[0]!;
      const rep = replacement(state.lines, pos, o, ch.body, found.tier);
      state.lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const dest = to ?? sec.path;
    tree.now.set(dest, joinFile(state));
    if (to !== null) {
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, to]);
    }
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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
      const state = splitFile(before);
      if (line < 0 || line > state.lines.length) throw new Fail('no-match', p);
      state.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(state));
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

// ---------------------------------------------------------------------------
// The run (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that stands at the end (old gone, new present, both as the patch found them) is
  // reported as one R line, sorted by its new path, in place of the pair's D and A lines.
  const pairs = tree.moves.filter(
    ([o, n]) => tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null,
  );
  const movedFrom = new Set(pairs.map(([o]) => o));
  const movedTo = new Set(pairs.map(([, n]) => n));
  interface Row {
    key: string;
    text: string;
    path: string;
    now: string | null;
    old?: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  for (const [o, n] of pairs) rows.push({ key: n, text: `R ${o} -> ${n}`, path: n, now: tree.get(n), old: o });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const row of rows) {
      if (row.old !== undefined) rmSync(row.old, { force: true });
      if (row.now === null) rmSync(row.path, { force: true });
      else {
        mkdirSync(dirname(row.path), { recursive: true });
        writeFileSync(row.path, row.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
