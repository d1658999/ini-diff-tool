/**
 * ini-parser.worker.js
 * High-performance INI parser running as a Web Worker.
 *
 * Protocol:
 *   Incoming: { type: 'parse', id: 'left'|'right', content: string }
 *   Outgoing: { type: 'progress', id, percent, sectionsFound }
 *           | { type: 'result',   id, sections, totalLines, parseTimeMs }
 *           | { type: 'error',    id, message }
 */

'use strict';

self.onmessage = function (e) {
  const { type, id, content } = e.data;
  if (type === 'parse') {
    try {
      parseINI(id, content);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message || String(err) });
    }
  }
};

function parseINI(id, content) {
  const startTime = Date.now();

  // Guard against non-string input
  if (typeof content !== 'string') {
    self.postMessage({ type: 'error', id, message: 'content must be a string' });
    return;
  }

  // Fastest split — avoids regex overhead for the hot path
  const lines = content.split('\n');
  const totalLines = lines.length;

  /** @type {Array<{name:string, startLine:number, entries:Array}>} */
  const sections = [];

  // Preamble: lines before the first section header
  let currentSection = { name: '__preamble__', startLine: 0, entries: [] };
  sections.push(currentSection);

  // Track section-name occurrences to de-duplicate
  // e.g. sectionCount['Foo'] = 1 → first occurrence keeps name 'Foo'
  //                             → second occurrence becomes 'Foo_2'
  const sectionCount = Object.create(null);

  const BATCH = 10000;
  let i = 0;

  function processBatch() {
    const end = Math.min(i + BATCH, totalLines);

    for (; i < end; i++) {
      const lineNum = i + 1;          // 1-based
      const raw = lines[i];

      // Trim once; reuse trimmed for all checks
      const trimmed = raw.trim();

      // ── Section header ──────────────────────────────────────────────────
      if (trimmed.charCodeAt(0) === 91 /* '[' */ && trimmed.includes(']')) {
        const closeBracket = trimmed.indexOf(']');
        const name = trimmed.slice(1, closeBracket).trim();

        // Resolve unique name for duplicates
        let uniqueName;
        if (sectionCount[name] === undefined) {
          sectionCount[name] = 1;
          uniqueName = name;
        } else {
          sectionCount[name] += 1;
          uniqueName = name + '_' + sectionCount[name];
        }

        currentSection = { name: uniqueName, startLine: lineNum, entries: [] };
        sections.push(currentSection);
        continue;
      }

      // ── Blank line ───────────────────────────────────────────────────────
      if (trimmed.length === 0) {
        currentSection.entries.push({ type: 'blank', lineNum, raw, key: null, value: null });
        continue;
      }

      // ── Comment line ─────────────────────────────────────────────────────
      const firstChar = trimmed.charCodeAt(0);
      if (firstChar === 35 /* '#' */ || firstChar === 59 /* ';' */) {
        currentSection.entries.push({ type: 'comment', lineNum, raw, key: null, value: null });
        continue;
      }

      // ── Key-value or bare line ───────────────────────────────────────────
      const eqIdx = trimmed.indexOf('=');
      const colonIdx = trimmed.indexOf(':');

      let sepIdx = -1;
      if (eqIdx >= 0 && colonIdx >= 0) {
        sepIdx = eqIdx < colonIdx ? eqIdx : colonIdx;
      } else if (eqIdx >= 0) {
        sepIdx = eqIdx;
      } else if (colonIdx >= 0) {
        sepIdx = colonIdx;
      }

      if (sepIdx > 0) {
        // sepIdx > 0 ensures key is non-empty
        const key = trimmed.slice(0, sepIdx).trim();
        const value = trimmed.slice(sepIdx + 1).trim();
        currentSection.entries.push({ type: 'entry', lineNum, raw, key, value });
      } else {
        // No separator or separator is the very first char → treat as comment/raw
        currentSection.entries.push({ type: 'comment', lineNum, raw, key: null, value: null });
      }
    }

    // ── Progress report ───────────────────────────────────────────────────
    const percent = totalLines > 0 ? Math.round((i / totalLines) * 100) : 100;
    // sectionsFound excludes the synthetic __preamble__
    const sectionsFound = sections.length - 1;
    self.postMessage({ type: 'progress', id, percent, sectionsFound });

    // ── Schedule next batch or emit final result ───────────────────────────
    if (i < totalLines) {
      // Yield to the event loop so progress messages can be flushed
      setTimeout(processBatch, 0);
    } else {
      self.postMessage({
        type: 'result',
        id,
        sections,
        totalLines,
        parseTimeMs: Date.now() - startTime,
      });
    }
  }

  processBatch();
}
