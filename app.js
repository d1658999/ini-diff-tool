/**
 * app.js — Main application logic for INI File Diff Tool
 * Handles file loading, parsing, diffing, virtual scrolling, and UI events.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ROW_HEIGHT = 22; // px — must match CSS
const BUFFER_ROWS = 50; // rows to render outside visible viewport

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  left:  { file: null, content: null, sections: null, parseTime: null, handle: null, watchId: null },
  right: { file: null, content: null, sections: null, parseTime: null, handle: null, watchId: null },
  sectionDiffs: null,
  stats: null,
  allSectionNames: [],
  selectedSections: new Set(),
  expandedSections: new Set(),
  checkedSections:  new Set(),
  searchQuery: '',
  rows: [],
};

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------
const parserWorker = new Worker('ini-parser.worker.js');
const diffWorker   = new Worker('diff.worker.js');

// ---------------------------------------------------------------------------
// Worker message handlers
// ---------------------------------------------------------------------------
parserWorker.onmessage = function (e) {
  const { type, id } = e.data;
  if (type === 'progress') {
    updateLoading(`Parsing ${id} file… ${e.data.percent}% (${e.data.sectionsFound} sections)`);
  } else if (type === 'result') {
    state[id].sections  = e.data.sections;
    state[id].parseTime = e.data.parseTimeMs;

    if (state.left.sections && state.right.sections) {
      runDiff();
    } else {
      hideLoading();
      const other = id === 'left' ? 'right' : 'left';
      setStatus(`${id} file parsed in ${e.data.parseTimeMs}ms. Load ${other} file to compare.`);
    }
  } else if (type === 'error') {
    hideLoading();
    setStatus('Parse error: ' + e.data.message);
  }
};

diffWorker.onmessage = function (e) {
  if (e.data.type === 'progress') {
    updateLoading(`Diffing… ${e.data.percent}%`);
  } else if (e.data.type === 'result') {
    hideLoading();
    state.sectionDiffs = e.data.sectionDiffs;
    state.stats = e.data.stats;

    state.allSectionNames = state.sectionDiffs
      .map(sd => sd.sectionName)
      .filter(n => n !== '__preamble__');

    // Default: all sections checked, none expanded
    state.checkedSections  = new Set(state.allSectionNames);
    state.expandedSections = new Set();

    document.getElementById('chk-select-all').checked = true;

    const { added, removed, modified, unchanged } = state.stats;
    document.getElementById('status-stats').textContent =
      `+${added} added  -${removed} removed  ~${modified} modified  =${unchanged} unchanged`;
    document.getElementById('status-sep2').removeAttribute('hidden');

    setStatus(`Diff complete in ${e.data.diffTimeMs}ms`);
    renderSectionList();
    buildDisplayRows();
  } else if (e.data.type === 'error') {
    hideLoading();
    setStatus('Diff error: ' + e.data.message);
  }
};

// ---------------------------------------------------------------------------
// Diff runner
// ---------------------------------------------------------------------------
function runDiff() {
  showLoading('Computing diff…');
  diffWorker.postMessage({
    type: 'diff',
    leftSections:  state.left.sections,
    rightSections: state.right.sections,
    selectedSections: null,
  });
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------
function handleFile(side, file) {
  state[side].file     = file;
  state[side].content  = null;
  state[side].sections = null;

  document.getElementById('filename-' + side).textContent =
    file.name || '(unknown)';
  document.getElementById('modified-' + side).textContent =
    file.lastModified ? new Date(file.lastModified).toLocaleString() : '';
  document.getElementById('pane-title-' + side).textContent = file.name || '(unknown)';
  document.getElementById('dz-' + side).classList.add('dz-loaded');

  setStatus('Reading file…');

  const reader = new FileReader();
  reader.onerror = () => { hideLoading(); setStatus('Error reading file.'); };
  reader.onload  = e => {
    state[side].content = e.target.result;
    parseFile(side);
  };
  reader.readAsText(file, 'utf-8');

  updateCompareButton();
}

function parseFile(side) {
  showLoading(`Parsing ${side} file…`);
  parserWorker.postMessage({ type: 'parse', id: side, content: state[side].content });
}

// ---------------------------------------------------------------------------
// File System Access API — auto-refresh / watching
// ---------------------------------------------------------------------------
async function startWatching(side) {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'INI / config files', accept: { 'text/plain': ['.ini', '.cfg', '.conf'] } }],
    });
    state[side].handle = handle;

    const file = await handle.getFile();
    handleFile(side, file);
    document.getElementById('watch-' + side).hidden = false;

    // Clear any previous watch interval for this side
    if (state[side].watchId) clearInterval(state[side].watchId);

    state[side].watchId = setInterval(async () => {
      try {
        const fresh = await handle.getFile();
        if (fresh.lastModified !== state[side].file?.lastModified) {
          handleFile(side, fresh);
        }
      } catch (_) { /* file may be locked; skip */ }
    }, 1000);
  } catch (_) {
    // User cancelled or File System Access API not supported — ignore
  }
}

// ---------------------------------------------------------------------------
// Section list rendering
// ---------------------------------------------------------------------------
function renderSectionList() {
  const list  = document.getElementById('section-list');
  const empty = document.getElementById('section-list-empty');

  if (!state.sectionDiffs) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  // Remove all existing items except the empty placeholder
  [...list.children].forEach(c => { if (c !== empty) c.remove(); });

  const query = state.searchQuery.toLowerCase();

  const badgeMap = {
    same:        'badge-same',
    changed:     'badge-changed',
    'left-only': 'badge-left-only',
    'right-only':'badge-right-only',
  };

  for (const sd of state.sectionDiffs) {
    if (sd.sectionName === '__preamble__') continue;
    if (query && !sd.sectionName.toLowerCase().includes(query)) continue;

    const isChecked  = state.checkedSections.has(sd.sectionName);
    const isExpanded = state.expandedSections.has(sd.sectionName);
    const badgeClass = badgeMap[sd.status] || 'badge-same';

    const item = document.createElement('div');
    item.className      = 'section-item';
    item.dataset.section = sd.sectionName;

    item.innerHTML = `
      <input type="checkbox" class="section-chk" ${isChecked ? 'checked' : ''} data-section="${escHtml(sd.sectionName)}" />
      <span class="section-triangle ${isExpanded ? 'expanded' : ''}" data-section="${escHtml(sd.sectionName)}">▶</span>
      <span class="section-name" title="${escHtml(sd.sectionName)}">${escHtml(sd.sectionName)}</span>
      <span class="section-badge ${badgeClass}"></span>
    `;

    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Expand / collapse a section
// ---------------------------------------------------------------------------
function toggleExpand(sectionName) {
  if (state.expandedSections.has(sectionName)) {
    state.expandedSections.delete(sectionName);
  } else {
    state.expandedSections.add(sectionName);
  }
  // Update triangle in DOM without full re-render
  document.querySelectorAll(`.section-triangle[data-section="${CSS.escape(sectionName)}"]`)
    .forEach(el => el.classList.toggle('expanded', state.expandedSections.has(sectionName)));

  buildDisplayRows();
}

// ---------------------------------------------------------------------------
// Build the unified rows array from expanded + checked sections
// ---------------------------------------------------------------------------
function buildDisplayRows() {
  state.rows = [];
  if (!state.sectionDiffs) return;

  for (const sd of state.sectionDiffs) {
    if (sd.sectionName === '__preamble__') continue;
    if (!state.checkedSections.has(sd.sectionName)) continue;

    // Section header row
    state.rows.push({
      type:         'section-header',
      sectionName:  sd.sectionName,
      status:       sd.status,
      leftLineNum:  null,
      rightLineNum: null,
      leftContent:  null,
      rightContent: null,
    });

    // Content rows — only when expanded
    if (state.expandedSections.has(sd.sectionName) && sd.rows) {
      for (const r of sd.rows) {
        state.rows.push(r);
      }
    }
  }

  updateLineCounts();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Virtual scrolling
// ---------------------------------------------------------------------------
let renderPending = false;

function scheduleRender() {
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(doRender);
  }
}

function doRender() {
  renderPending = false;
  const paneLeft    = document.getElementById('pane-left');
  const paneRight   = document.getElementById('pane-right');
  const contentLeft = document.getElementById('content-left');
  const contentRight= document.getElementById('content-right');

  renderVirtualRows(paneLeft,  contentLeft,  state.rows, true);
  renderVirtualRows(paneRight, contentRight, state.rows, false);
}

function renderVirtualRows(paneEl, contentEl, rows, isLeft) {
  const totalHeight = rows.length * ROW_HEIGHT;
  contentEl.style.height   = totalHeight + 'px';
  contentEl.style.position = 'relative';
  contentEl.innerHTML = '';

  if (!rows.length) return;

  const scrollTop  = paneEl.scrollTop;
  const viewHeight = paneEl.clientHeight;

  const firstIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const lastIdx  = Math.min(rows.length - 1, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + BUFFER_ROWS);

  const fragment = document.createDocumentFragment();
  for (let i = firstIdx; i <= lastIdx; i++) {
    const rowEl = createRowElement(rows[i], isLeft);
    rowEl.style.position = 'absolute';
    rowEl.style.top      = i * ROW_HEIGHT + 'px';
    rowEl.style.width    = '100%';
    fragment.appendChild(rowEl);
  }
  contentEl.appendChild(fragment);
}

// ---------------------------------------------------------------------------
// Row element factory
// ---------------------------------------------------------------------------
function createRowElement(rowData, isLeft) {
  const div = document.createElement('div');

  if (rowData.type === 'section-header') {
    div.className = 'diff-row section-header-row';
    const statusClass = {
      same:        'sh-same',
      changed:     'sh-changed',
      'left-only': 'sh-left-only',
      'right-only':'sh-right-only',
    }[rowData.status] || '';
    if (statusClass) div.classList.add(statusClass);

    const icon = state.expandedSections.has(rowData.sectionName) ? '▼' : '▶';
    div.innerHTML = `<span class="sh-icon">${icon}</span><span class="section-header-name">[${escHtml(rowData.sectionName)}]</span>`;
    div.addEventListener('click', () => toggleExpand(rowData.sectionName));
    return div;
  }

  const typeClass = {
    added:     'diff-added',
    removed:   'diff-removed',
    modified:  'diff-modified',
    unchanged: 'diff-unchanged',
    spacer:    'diff-empty',
  }[rowData.type] || '';

  div.className = 'diff-row ' + typeClass;

  const lineNum  = isLeft ? rowData.leftLineNum  : rowData.rightLineNum;
  const content  = isLeft ? rowData.leftContent  : rowData.rightContent;

  const lineNumEl = document.createElement('span');
  lineNumEl.className   = 'line-num';
  lineNumEl.textContent = lineNum != null ? lineNum : '';

  const contentEl = document.createElement('span');
  contentEl.className   = 'line-content';
  contentEl.textContent = content != null ? content : '';

  div.appendChild(lineNumEl);
  div.appendChild(contentEl);
  return div;
}

// ---------------------------------------------------------------------------
// Synchronized scrolling
// ---------------------------------------------------------------------------
let scrollSyncing = false;

function setupSyncScroll() {
  const paneLeft  = document.getElementById('pane-left');
  const paneRight = document.getElementById('pane-right');

  function syncScroll(source, target) {
    if (scrollSyncing) return;
    scrollSyncing = true;
    target.scrollTop  = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    scrollSyncing = false;
  }

  paneLeft.addEventListener('scroll', () => {
    syncScroll(paneLeft, paneRight);
    scheduleRender();
  });
  paneRight.addEventListener('scroll', () => {
    syncScroll(paneRight, paneLeft);
    scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Swap left ↔ right files
// ---------------------------------------------------------------------------
function swapFiles() {
  const tmp = { ...state.left };
  Object.assign(state.left,  state.right);
  Object.assign(state.right, tmp);

  // Update displayed filenames / dates
  for (const side of ['left', 'right']) {
    const f = state[side].file;
    document.getElementById('filename-' + side).textContent =
      f ? f.name : '—';
    document.getElementById('modified-' + side).textContent =
      f && f.lastModified ? new Date(f.lastModified).toLocaleString() : '';
  }

  if (state.left.sections && state.right.sections) {
    runDiff();
  }
}

// ---------------------------------------------------------------------------
// Clear / reset
// ---------------------------------------------------------------------------
function clearAll() {
  for (const side of ['left', 'right']) {
    if (state[side].watchId) { clearInterval(state[side].watchId); }
  }

  state.left  = { file: null, content: null, sections: null, parseTime: null, handle: null, watchId: null };
  state.right = { file: null, content: null, sections: null, parseTime: null, handle: null, watchId: null };
  state.sectionDiffs    = null;
  state.stats           = null;
  state.allSectionNames = [];
  state.selectedSections= new Set();
  state.expandedSections= new Set();
  state.checkedSections = new Set();
  state.rows            = [];
  state.searchQuery     = '';

  for (const side of ['left', 'right']) {
    document.getElementById('filename-' + side).textContent = '';
    document.getElementById('modified-' + side).textContent = '';
    document.getElementById('watch-' + side).hidden = true;
  }

  document.getElementById('section-search').value = '';
  document.getElementById('chk-select-all').checked = false;
  document.getElementById('status-stats').textContent = '';
  document.getElementById('status-sep2').setAttribute('hidden', '');
  document.getElementById('pane-title-left').textContent  = 'Left file';
  document.getElementById('pane-title-right').textContent = 'Right file';
  document.getElementById('counts-left').textContent  = '';
  document.getElementById('counts-right').textContent = '';

  setStatus('Load two INI files to compare.');
  updateCompareButton();
  renderSectionList();
  buildDisplayRows();
}

// ---------------------------------------------------------------------------
// Helper UI functions
// ---------------------------------------------------------------------------
function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
}

function showLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
  document.getElementById('loading-overlay').hidden = false;
}

function updateLoading(msg) {
  document.getElementById('loading-msg').textContent = msg;
}

function hideLoading() {
  document.getElementById('loading-overlay').hidden = true;
}

function updateCompareButton() {
  document.getElementById('btn-compare').disabled =
    !(state.left.sections && state.right.sections);
}

function updateLineCounts() {
  const leftRows  = state.rows.filter(r => r.leftLineNum  != null).length;
  const rightRows = state.rows.filter(r => r.rightLineNum != null).length;
  document.getElementById('counts-left').textContent  = leftRows  ? `${leftRows} lines`  : '';
  document.getElementById('counts-right').textContent = rightRows ? `${rightRows} lines` : '';

  // Update status-bar line counts
  document.getElementById('status-lines-left').textContent  = leftRows  ? leftRows  : '';
  document.getElementById('status-lines-right').textContent = rightRows ? rightRows : '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Drag-drop helpers
// ---------------------------------------------------------------------------
function setupDropZone(side) {
  const dz    = document.getElementById('dz-' + side);
  const input = document.getElementById('file-' + side);

  dz.addEventListener('dragover', e => {
    e.preventDefault();
    dz.classList.add('dz-over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dz-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dz-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(side, file);
  });

  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(side, input.files[0]);
    input.value = ''; // allow re-selection of same file
  });
}

// ---------------------------------------------------------------------------
// Section list event delegation
// ---------------------------------------------------------------------------
function setupSectionListDelegation() {
  const list = document.getElementById('section-list');

  list.addEventListener('change', e => {
    const chk = e.target.closest('.section-chk');
    if (!chk) return;
    const name = chk.dataset.section;
    if (chk.checked) {
      state.checkedSections.add(name);
    } else {
      state.checkedSections.delete(name);
    }
    updateSelectAllCheckbox();
    buildDisplayRows();
  });

  list.addEventListener('click', e => {
    const tri = e.target.closest('.section-triangle');
    if (tri) {
      e.stopPropagation();
      toggleExpand(tri.dataset.section);
    }
  });
}

function updateSelectAllCheckbox() {
  const chk = document.getElementById('chk-select-all');
  const total = state.allSectionNames.length;
  if (total === 0) { chk.indeterminate = false; chk.checked = false; return; }
  const checked = state.allSectionNames.filter(n => state.checkedSections.has(n)).length;
  if (checked === 0) { chk.indeterminate = false; chk.checked = false; }
  else if (checked === total) { chk.indeterminate = false; chk.checked = true; }
  else { chk.indeterminate = true; }
}

// ---------------------------------------------------------------------------
// Main DOMContentLoaded bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {

  // Drop zones + file inputs
  setupDropZone('left');
  setupDropZone('right');

  // Swap button
  document.getElementById('btn-swap').addEventListener('click', swapFiles);

  // Compare button (re-run diff)
  document.getElementById('btn-compare').addEventListener('click', () => {
    if (state.left.sections && state.right.sections) runDiff();
  });

  // Clear button
  document.getElementById('btn-clear').addEventListener('click', clearAll);

  // Select-all checkbox
  document.getElementById('chk-select-all').addEventListener('change', e => {
    if (e.target.checked) {
      state.checkedSections = new Set(state.allSectionNames);
    } else {
      state.checkedSections.clear();
    }
    renderSectionList();
    buildDisplayRows();
  });

  // Section search
  document.getElementById('section-search').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderSectionList();
  });

  // Section list (checkbox + triangle)
  setupSectionListDelegation();

  // Synchronized scrolling
  setupSyncScroll();

  // Window resize
  window.addEventListener('resize', scheduleRender);

  // Initial UI state
  setStatus('Load two INI files to compare.');
  updateCompareButton();
  renderSectionList(); // shows empty state

  // Pane titles
  document.getElementById('pane-title-left').textContent  = 'Left file';
  document.getElementById('pane-title-right').textContent = 'Right file';

  // Watch buttons (if present in HTML as clickable areas)
  for (const side of ['left', 'right']) {
    const watchEl = document.getElementById('watch-' + side);
    if (watchEl) {
      watchEl.addEventListener('click', () => startWatching(side));
    }
    // Also wire drop-zone label clicks to show file picker (watch mode)
    // and standard file input is already handled via setupDropZone
  }
});
