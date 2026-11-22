// mend: applies an edit written by an AI model to a tree of text files.
// Implements SPEC.md v1: unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edit objects, with three-tier line matching and all-or-nothing writes.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.

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
function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

// ---------- file line model (SPEC section 3) ----------

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}
function toModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}
function createdText(lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

// ---------- three-tier line matching (SPEC section 5) ----------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function tierOf(tier: number, s: string): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}
interface Match {
  tier: number;
  starts: number[];
}
/** Occurrences of O in fileLines at the first tier that has any, honouring a start bound. */
function findOccurrences(fileLines: string[], O: string[], strict: boolean, from = 0): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const starts: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (tierOf(tier, fileLines[i + j]!) !== tierOf(tier, O[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) starts.push(i);
    }
    if (starts.length > 0) return { tier, starts };
  }
  return null;
}

interface NEnt {
  text: string;
  context: boolean;
  oIndex: number; // for context entries: index within O; -1 otherwise
  noNewline: boolean;
}
/** Lines to write for N at a match: context lines come from the file itself; tier 2 re-indents the rest. */
function renderN(fileLines: string[], O: string[], N: NEnt[], match: Match, start: number): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadWs(fileLines[start]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const e of N) {
    if (e.context) {
      out.push(fileLines[start + e.oIndex]!);
    } else if (match.tier === 2 && O.length > 0 && e.text.trim() !== '' && e.text.startsWith(P)) {
      out.push(F + e.text.slice(P.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---------- format detection (SPEC section 4) ----------

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

// ---------- JSON edits (SPEC section 9) ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
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
      const m = toModel(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, fromModel(m));
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

// ---------- unified diffs (SPEC section 6) ----------

interface Hunk {
  a: number;
  body: NEnt[]; // context and '+' entries, in order (the N side)
  old: NEnt[]; // context and '-' entries, in order (the O side)
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
  hasPair: boolean;
  inHeader: boolean;
}

function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = {
      diffOld: null, diffNew: null, pairOld: null, pairNew: null,
      renFrom: null, renTo: null, isNew: false, isDel: false,
      hunks: [], hasPair: false, inHeader: true,
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (!line.startsWith('diff --git ') || m === null || m[1] === '' || m[2] === '') {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && !cur.hasPair) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      const a = parseInt(m[1]!, 10);
      i += 1;
      const raw: Array<{ kind: string; text: string; noNewline: boolean; srcEmpty: boolean }> = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          raw.push({ kind: b === '' ? ' ' : b[0]!, text: b === '' ? '' : b.slice(1), noNewline: false, srcEmpty: b === '' });
          i += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (raw.length > 0 && raw[raw.length - 1]!.srcEmpty) raw.pop();
      const body: NEnt[] = [];
      const old: NEnt[] = [];
      let oIdx = 0;
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.kind === '\\') {
          const prev = body.length > 0 && (raw[k - 1]?.kind === ' ' || raw[k - 1]?.kind === '+') ? body[body.length - 1]! : old[old.length - 1];
          if (prev) prev.noNewline = true;
          // Mark on both views: rebuild below instead.
          continue;
        }
        if (r.kind === ' ') {
          const e: NEnt = { text: r.text, context: true, oIndex: oIdx, noNewline: false };
          body.push(e);
          old.push(e);
          oIdx += 1;
        } else if (r.kind === '-') {
          old.push({ text: r.text, context: false, oIndex: -1, noNewline: false });
          oIdx += 1;
        } else {
          body.push({ text: r.text, context: false, oIndex: -1, noNewline: false });
        }
      }
      // A `\` line refers to the body line before it; re-walk raw to set flags on the right entries.
      {
        let bi = 0;
        let oi = 0;
        for (let k = 0; k < raw.length; k++) {
          const r = raw[k]!;
          if (r.kind === '\\') {
            if (bi > 0) body[bi - 1]!.noNewline = true;
            if (oi > 0) old[oi - 1]!.noNewline = true;
          } else if (r.kind === ' ') {
            bi += 1;
            oi += 1;
          } else if (r.kind === '-') oi += 1;
          else bi += 1;
        }
      }
      cur.hunks.push({ a, body, old });
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1; // prose, fences and other lines outside bodies are ignored
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld ?? s.renFrom ?? s.diffOld;
    const newPath = s.pairNew ?? s.renTo ?? s.diffNew;
    const creation = s.isNew || s.pairOld === '/dev/null';
    const deletion = s.isDel || s.pairNew === '/dev/null';
    edits.push((tree) => applyUnifiedSection(tree, s, oldPath, newPath, creation, deletion, strict));
  }
  return edits;
}

function applyUnifiedSection(tree: Tree, s: Section, oldPath: string | null, newPath: string | null, creation: boolean, deletion: boolean, strict: boolean): void {
  if (creation) {
    const p = newPath!;
    needSafe(p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const outLines: string[] = [];
    let lastPlusNoNewline = false;
    for (const h of s.hunks) {
      for (const e of h.body) {
        if (!e.context) {
          outLines.push(e.text);
          lastPlusNoNewline = e.noNewline;
        }
      }
    }
    tree.now.set(p, createdText(outLines, outLines.length > 0 && !lastPlusNoNewline));
    return;
  }
  if (deletion) {
    const p = oldPath!;
    needSafe(p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const o = oldPath!;
  const n = newPath!;
  needSafe(o);
  const isMove = n !== o;
  if (isMove) needSafe(n);
  const before = tree.get(o);
  if (before === null) throw new Fail('missing', o);
  if (isMove && tree.get(n) !== null) throw new Fail('exists', n);
  const model = toModel(before);
  let d = 0;
  for (const h of s.hunks) {
    const O = h.old.map((e) => e.text);
    const N = h.body;
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = pos === model.lines.length;
      const written = renderN(model.lines, O, N, { tier: 0, starts: [] }, pos);
      model.lines.splice(pos, 0, ...written);
      if (atEnd && N.length > 0) model.final = !N[N.length - 1]!.noNewline;
      d += N.length - O.length;
      continue;
    }
    const match = findOccurrences(model.lines, O, strict);
    if (match === null) throw new Fail('no-match', o);
    const target = h.a - 1 + d;
    let start = match.starts[0]!;
    for (const cand of match.starts) {
      if (Math.abs(cand - target) < Math.abs(start - target)) start = cand;
    }
    const runsToEnd = start + O.length === model.lines.length;
    const written = renderN(model.lines, O, N, match, start);
    model.lines.splice(start, O.length, ...written);
    if (runsToEnd) {
      const lastN = N[N.length - 1];
      model.final = lastN ? !lastN.noNewline : model.final;
    }
    d += N.length - O.length;
  }
  if (isMove) {
    tree.now.set(o, null);
    tree.now.set(n, fromModel(model));
    tree.moves.push([o, n]);
  } else {
    tree.now.set(o, fromModel(model));
  }
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // index after previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // Path: nearest earlier non-blank, non-fence line after the previous block.
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= searchFrom; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, createdText(b.newLines, b.newLines.length > 0));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = toModel(before);
    const match = findOccurrences(model.lines, b.oldLines, strict);
    if (match === null) throw new Fail('no-match', b.path);
    if (match.starts.length > 1) throw new Fail('ambiguous', b.path);
    const start = match.starts[0]!;
    const nEnts: NEnt[] = b.newLines.map((t) => ({ text: t, context: false, oIndex: -1, noNewline: false }));
    const written = renderN(model.lines, b.oldLines, nEnts, match, start);
    model.lines.splice(start, b.oldLines.length, ...written);
    tree.now.set(b.path, fromModel(model));
  });
}

// ---------- V4A patches (SPEC section 8) ----------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: NEnt[];
  old: NEnt[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  const sectionStart = (l: string): { kind: V4aSection['kind']; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const st = sectionStart(lines[i]!);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: V4aSection = { kind: st.kind, path: st.path, lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    // Collect this section's raw lines up to the next section or End Patch, dropping trailing blanks.
    const rawStart = i;
    let rawEnd = i;
    let j = i;
    while (j < last && sectionStart(lines[j]!) === null) j += 1;
    rawEnd = j;
    let end = rawEnd;
    while (end > rawStart && blank(lines[end - 1]!)) end -= 1;
    const raw = lines.slice(rawStart, end);
    if (sec.kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${rawStart + 1}`);
    } else {
      let chunk: V4aChunk | null = null;
      let firstLine = true;
      const startChunk = (anchor: string | null): V4aChunk => {
        const c: V4aChunk = { anchor, eof: false, body: [], old: [] };
        sec.chunks.push(c);
        return c;
      };
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        const lineNo = rawStart + k + 1;
        if (firstLine && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          chunk = startChunk(anchorText === '' ? null : anchorText);
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) chunk = startChunk(null);
          chunk.eof = true;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) chunk = startChunk(null);
          const kind = l === '' ? ' ' : l[0]!;
          const text = l === '' ? '' : l.slice(1);
          if (kind === ' ') {
            const e: NEnt = { text, context: true, oIndex: chunk.old.length, noNewline: false };
            chunk.body.push(e);
            chunk.old.push(e);
          } else if (kind === '-') {
            chunk.old.push({ text, context: false, oIndex: -1, noNewline: false });
          } else {
            chunk.body.push({ text, context: false, oIndex: -1, noNewline: false });
          }
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    i = rawEnd;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((sec) => (tree: Tree) => {
    needSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, createdText(sec.addLines, sec.addLines.length > 0));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) needSafe(sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (tierOf(tier, model.lines[k]!) === tierOf(tier, chunk.anchor)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const O = chunk.old.map((e) => e.text);
      if (O.length === 0) {
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const written = renderN(model.lines, O, chunk.body, { tier: 0, starts: [] }, pos);
        model.lines.splice(pos, 0, ...written);
        cursor = pos + written.length;
        continue;
      }
      const match = findOccurrences(model.lines, O, strict, cursor);
      let starts = match?.starts ?? [];
      if (chunk.eof) starts = starts.filter((sIdx) => sIdx + O.length === model.lines.length);
      if (match === null || starts.length === 0) throw new Fail('no-match', sec.path);
      const start = starts[0]!;
      const written = renderN(model.lines, O, chunk.body, match, start);
      model.lines.splice(start, O.length, ...written);
      cursor = start + written.length;
    }
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, fromModel(model));
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, fromModel(model));
    }
  });
}

// ---------- invocation, output, atomic write (SPEC sections 1, 2, 10) ----------

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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

  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.push(p);
  }
  // Move pairs replace their D and A lines, and sort by the new path.
  const moveByNew = new Map<string, string>();
  const movedOld = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      moveByNew.set(n, o);
      movedOld.add(o);
    }
  }
  interface Row {
    sortKey: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of changed) {
    if (movedOld.has(p)) continue;
    if (moveByNew.has(p)) {
      rows.push({ sortKey: p, line: `R ${moveByNew.get(p)!} -> ${p}` });
      continue;
    }
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey), Buffer.from(y.sortKey)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
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
