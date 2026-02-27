/**
 * diff.worker.js — High-performance INI diff engine (Web Worker)
 *
 * Protocol:
 *   IN:  { type: 'diff', leftSections, rightSections, selectedSections }
 *   OUT: { type: 'progress', percent, currentSection }
 *        { type: 'result',   sectionDiffs, stats, diffTimeMs }
 *        { type: 'error',    message }
 */

'use strict';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

self.onmessage = function (e) {
  const { type, leftSections, rightSections, selectedSections } = e.data;
  if (type === 'diff') {
    try {
      runDiff(leftSections, rightSections, selectedSections);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }
};

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

function runDiff(leftSections, rightSections, selectedSections) {
  const startTime = Date.now();

  // Build name -> section maps (first occurrence wins for duplicates at section level)
  const leftMap  = buildSectionMap(leftSections);
  const rightMap = buildSectionMap(rightSections);

  // Union of all section names, preserving left-then-right order
  const allNames = unionOrdered(
    leftSections.map(s => s.name),
    rightSections.map(s => s.name)
  );

  const sectionDiffs = [];
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };

  const filtered = selectedSections
    ? allNames.filter(n => selectedSections.includes(n))
    : allNames;

  for (let i = 0; i < filtered.length; i++) {
    const name = filtered[i];

    self.postMessage({
      type: 'progress',
      percent: Math.round((i / filtered.length) * 100),
      currentSection: name,
    });

    const left  = leftMap.get(name)  || null;
    const right = rightMap.get(name) || null;

    const diff = diffSection(name, left, right, stats);
    sectionDiffs.push(diff);
  }

  self.postMessage({
    type: 'result',
    sectionDiffs,
    stats,
    diffTimeMs: Date.now() - startTime,
  });
}

// ---------------------------------------------------------------------------
// Section-level diff
// ---------------------------------------------------------------------------

/**
 * Diffs one section (which may exist on one or both sides).
 * Mutates `stats` in place.
 */
function diffSection(sectionName, left, right, stats) {
  // ── Section only on one side ─────────────────────────────────────────────
  if (!left) {
    const rows = buildOnesSideRows(right, 'added');
    rows.forEach(() => stats.added++);
    return { sectionName, status: 'right-only', rows };
  }
  if (!right) {
    const rows = buildOnesSideRows(left, 'removed');
    rows.forEach(() => stats.removed++);
    return { sectionName, status: 'left-only', rows };
  }

  // ── Both sides exist — key-aware alignment ───────────────────────────────
  const leftEntries  = left.entries  || left.lines  || [];
  const rightEntries = right.entries || right.lines || [];

  const rows = alignByKey(leftEntries, rightEntries, stats);

  const hasChange = rows.some(r => r.type !== 'unchanged' && r.type !== 'spacer');
  const status    = hasChange ? 'changed' : 'same';

  return { sectionName, status, rows };
}

// ---------------------------------------------------------------------------
// Key-aware alignment (primary diff strategy)
// ---------------------------------------------------------------------------

const LARGE_SECTION_THRESHOLD = 5000;

function alignByKey(leftLines, rightLines, stats) {
  const leftEntries  = leftLines.filter(l => l.type === 'entry');
  const rightEntries = rightLines.filter(l => l.type === 'entry');

  // For very large sections use heuristic path
  if (leftEntries.length > LARGE_SECTION_THRESHOLD || rightEntries.length > LARGE_SECTION_THRESHOLD) {
    return alignLarge(leftLines, rightLines, stats);
  }

  return alignNormal(leftLines, rightLines, stats);
}

/**
 * Standard key-map alignment for sections of normal size.
 */
function alignNormal(leftLines, rightLines, stats) {
  // Separate entries from non-entries (comments, blanks)
  const leftEntries  = leftLines.filter(l => l.type === 'entry');
  const rightEntries = rightLines.filter(l => l.type === 'entry');

  // Build key -> [entries] maps (handles duplicate keys by order)
  const leftKeyMap  = buildKeyMap(leftEntries);
  const rightKeyMap = buildKeyMap(rightEntries);

  // Ordered key union
  const keyOrder = unionOrdered(
    leftEntries.map(e => e.key),
    rightEntries.map(e => e.key)
  );

  const rows = [];

  // Emit non-entry lines (comments/blanks) before first entry
  emitLeadingNonEntries(leftLines, rightLines, rows, stats);

  // Track pointers into duplicate-key queues
  const leftQueues  = Object.fromEntries([...leftKeyMap].map(([k, arr]) => [k, [...arr]]));
  const rightQueues = Object.fromEntries([...rightKeyMap].map(([k, arr]) => [k, [...arr]]));

  for (const key of keyOrder) {
    const leftQueue  = leftQueues[key]  || [];
    const rightQueue = rightQueues[key] || [];

    const maxLen = Math.max(leftQueue.length, rightQueue.length);

    for (let i = 0; i < maxLen; i++) {
      const le = leftQueue[i]  || null;
      const re = rightQueue[i] || null;

      rows.push(makeRow(le, re, stats));
    }
  }

  return rows;
}

/**
 * Heuristic for very large sections: key-map O(n) first, then Myers for
 * any keys that appear on only one side (possibly reordered/new lines).
 */
function alignLarge(leftLines, rightLines, stats) {
  const leftEntries  = leftLines.filter(l => l.type === 'entry');
  const rightEntries = rightLines.filter(l => l.type === 'entry');

  const leftKeyMap  = buildKeyMap(leftEntries);
  const rightKeyMap = buildKeyMap(rightEntries);

  const rows = [];

  // Matched by key
  const matchedLeftKeys  = new Set();
  const matchedRightKeys = new Set();

  const keyOrder = unionOrdered(
    leftEntries.map(e => e.key),
    rightEntries.map(e => e.key)
  );

  for (const key of keyOrder) {
    if (leftKeyMap.has(key) && rightKeyMap.has(key)) {
      matchedLeftKeys.add(key);
      matchedRightKeys.add(key);
    }
  }

  // Unmatched entries → fall back to Myers on raw text sequences
  const unmatchedLeft  = leftEntries.filter(e => !matchedLeftKeys.has(e.key));
  const unmatchedRight = rightEntries.filter(e => !matchedRightKeys.has(e.key));

  const myersRows = myersDiff(unmatchedLeft, unmatchedRight, stats);

  // Interleave matched rows in key order, then append Myers rows
  for (const key of keyOrder) {
    const le = leftKeyMap.get(key)?.[0]  || null;
    const re = rightKeyMap.get(key)?.[0] || null;
    if (le || re) rows.push(makeRow(le, re, stats));
  }

  rows.push(...myersRows);
  return rows;
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeRow(le, re, stats) {
  if (le && re) {
    if (le.value === re.value) {
      stats.unchanged++;
      return row('unchanged', le, re);
    } else {
      stats.modified++;
      return row('modified', le, re);
    }
  }
  if (le) {
    stats.removed++;
    return row('removed', le, null);
  }
  // re only
  stats.added++;
  return row('added', null, re);
}

function row(type, le, re) {
  return {
    type,
    leftLineNum:   le ? (le.lineNum  ?? le.line ?? null) : null,
    rightLineNum:  re ? (re.lineNum  ?? re.line ?? null) : null,
    leftContent:   le ? (le.raw      ?? le.content ?? formatEntry(le)) : null,
    rightContent:  re ? (re.raw      ?? re.content ?? formatEntry(re)) : null,
    leftKey:       le ? (le.key      ?? null)  : null,
    rightKey:      re ? (re.key      ?? null)  : null,
  };
}

function spacerRow() {
  return {
    type: 'spacer',
    leftLineNum: null, rightLineNum: null,
    leftContent: null, rightContent: null,
    leftKey: null, rightKey: null,
  };
}

function formatEntry(e) {
  if (!e) return null;
  if (e.raw) return e.raw;
  return `${e.key}=${e.value}`;
}

// ---------------------------------------------------------------------------
// One-sided section helper
// ---------------------------------------------------------------------------

function buildOnesSideRows(section, type) {
  const lines = section.entries || section.lines || [];
  return lines.map(l => {
    if (type === 'added') {
      return {
        type,
        leftLineNum: null,
        rightLineNum: l.lineNum ?? l.line ?? null,
        leftContent: null,
        rightContent: l.raw ?? l.content ?? formatEntry(l),
        leftKey: null,
        rightKey: l.key ?? null,
      };
    } else {
      return {
        type,
        leftLineNum: l.lineNum ?? l.line ?? null,
        rightLineNum: null,
        leftContent: l.raw ?? l.content ?? formatEntry(l),
        rightContent: null,
        leftKey: l.key ?? null,
        rightKey: null,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Leading non-entry lines (comments / blanks)
// ---------------------------------------------------------------------------

function emitLeadingNonEntries(leftLines, rightLines, rows, stats) {
  const leftNonEntries  = leftLines.filter(l => l.type !== 'entry');
  const rightNonEntries = rightLines.filter(l => l.type !== 'entry');
  const maxLen = Math.max(leftNonEntries.length, rightNonEntries.length);

  for (let i = 0; i < maxLen; i++) {
    const le = leftNonEntries[i]  || null;
    const re = rightNonEntries[i] || null;

    if (le && re) {
      const sameText = (le.raw ?? le.content) === (re.raw ?? re.content);
      stats.unchanged++;
      rows.push({
        type: 'unchanged',
        leftLineNum:  le.lineNum ?? le.line ?? null,
        rightLineNum: re.lineNum ?? re.line ?? null,
        leftContent:  le.raw ?? le.content ?? null,
        rightContent: re.raw ?? re.content ?? null,
        leftKey: null, rightKey: null,
      });
    } else if (le) {
      stats.removed++;
      rows.push({
        type: 'removed',
        leftLineNum: le.lineNum ?? le.line ?? null, rightLineNum: null,
        leftContent: le.raw ?? le.content ?? null,  rightContent: null,
        leftKey: null, rightKey: null,
      });
    } else {
      stats.added++;
      rows.push({
        type: 'added',
        leftLineNum: null, rightLineNum: re.lineNum ?? re.line ?? null,
        leftContent: null, rightContent: re.raw ?? re.content ?? null,
        leftKey: null, rightKey: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Myers diff (for unmatched / fallback sequences)
// ---------------------------------------------------------------------------

/**
 * Classic Myers diff O(ND) algorithm.
 * Works on arrays of entry objects; equality is by raw text or key=value string.
 *
 * Returns rows[] with stats updated.
 */
function myersDiff(leftArr, rightArr, stats) {
  const N = leftArr.length;
  const M = rightArr.length;

  if (N === 0 && M === 0) return [];

  if (N === 0) {
    return rightArr.map(re => {
      stats.added++;
      return row('added', null, re);
    });
  }
  if (M === 0) {
    return leftArr.map(le => {
      stats.removed++;
      return row('removed', le, null);
    });
  }

  const MAX = N + M;
  // V[k] stores the furthest-reaching x on diagonal k
  const V = new Int32Array(2 * MAX + 1);
  const Vs = []; // snapshot of V after each d

  const eq = (li, ri) => entryEqual(leftArr[li], rightArr[ri]);

  let found = false;
  let foundD = 0;

  outer: for (let d = 0; d <= MAX; d++) {
    // Save a copy of V for backtracking
    Vs.push(new Int32Array(V));

    for (let k = -d; k <= d; k += 2) {
      const idx = k + MAX; // offset into V array

      let x;
      if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
        x = V[idx + 1]; // move down
      } else {
        x = V[idx - 1] + 1; // move right
      }

      let y = x - k;

      // Extend along diagonal
      while (x < N && y < M && eq(x, y)) {
        x++;
        y++;
      }

      V[idx] = x;

      if (x >= N && y >= M) {
        foundD = d;
        found = true;
        break outer;
      }
    }
  }

  if (!found) {
    // Shouldn't happen, but fall back to naïve
    return naiveDiff(leftArr, rightArr, stats);
  }

  // Backtrack to build edit script
  const edits = []; // {type: 'eq'|'ins'|'del', li, ri}

  let x = N;
  let y = M;

  for (let d = foundD; d > 0; d--) {
    const Vprev = Vs[d - 1];
    const k = x - y;
    const idx = k + MAX;

    let prevK;
    if (k === -d || (k !== d && Vprev[idx - 1] < Vprev[idx + 1])) {
      prevK = k + 1; // came from down (insert)
    } else {
      prevK = k - 1; // came from right (delete)
    }

    const prevX = Vprev[prevK + MAX];
    const prevY = prevX - prevK;

    // Diagonal snake
    while (x > prevX + (k !== prevK ? 0 : 1) && y > prevY + (k !== prevK ? 0 : 1)) {
      x--;
      y--;
      edits.push({ type: 'eq', li: x, ri: y });
    }

    if (prevK === k - 1) {
      // delete (left side)
      x--;
      edits.push({ type: 'del', li: x, ri: -1 });
    } else {
      // insert (right side)
      y--;
      edits.push({ type: 'ins', li: -1, ri: y });
    }

    x = prevX;
    y = prevY;
  }

  // Handle remaining snake at d=0
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.push({ type: 'eq', li: x, ri: y });
  }

  edits.reverse();

  // Convert edits to rows
  const rows = [];
  for (const e of edits) {
    if (e.type === 'eq') {
      stats.unchanged++;
      rows.push(row('unchanged', leftArr[e.li], rightArr[e.ri]));
    } else if (e.type === 'del') {
      stats.removed++;
      rows.push(row('removed', leftArr[e.li], null));
    } else {
      stats.added++;
      rows.push(row('added', null, rightArr[e.ri]));
    }
  }

  return rows;
}

/** Equality check for two entry objects */
function entryEqual(a, b) {
  if (!a || !b) return false;
  const aStr = a.raw ?? formatEntry(a);
  const bStr = b.raw ?? formatEntry(b);
  return aStr === bStr;
}

/** Naïve O(N*M) LCS diff — last-resort fallback */
function naiveDiff(leftArr, rightArr, stats) {
  const rows = [];
  let li = 0, ri = 0;
  while (li < leftArr.length && ri < rightArr.length) {
    if (entryEqual(leftArr[li], rightArr[ri])) {
      stats.unchanged++;
      rows.push(row('unchanged', leftArr[li++], rightArr[ri++]));
    } else {
      stats.removed++;
      rows.push(row('removed', leftArr[li++], null));
      stats.added++;
      rows.push(row('added', null, rightArr[ri++]));
    }
  }
  while (li < leftArr.length) {
    stats.removed++;
    rows.push(row('removed', leftArr[li++], null));
  }
  while (ri < rightArr.length) {
    stats.added++;
    rows.push(row('added', null, rightArr[ri++]));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Build Map<name, section> from an array of sections (first wins on dup) */
function buildSectionMap(sections) {
  const map = new Map();
  for (const s of sections) {
    if (!map.has(s.name)) map.set(s.name, s);
  }
  return map;
}

/** Build Map<key, entry[]> preserving order for duplicate keys */
function buildKeyMap(entries) {
  const map = new Map();
  for (const e of entries) {
    const k = e.key ?? '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

/**
 * Returns an array that is the ordered union of two arrays of strings.
 * Items appear in left-first order, with right-only items appended
 * in their original relative order.
 */
function unionOrdered(leftArr, rightArr) {
  const seen = new Set();
  const result = [];
  for (const v of leftArr) {
    if (!seen.has(v)) { seen.add(v); result.push(v); }
  }
  for (const v of rightArr) {
    if (!seen.has(v)) { seen.add(v); result.push(v); }
  }
  return result;
}
