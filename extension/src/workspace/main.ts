/**
 * BhuNex GIS Converter workspace.
 *
 * Framework-free: the workspace has one state tree and a handful of views, and a
 * render-on-change loop is the whole requirement. It also keeps the bundle small
 * and provably free of remote code, which the offline rule needs.
 *
 * The layout follows instruction §11.3 — queue on the left, inspector and
 * preview in the centre, target format and settings on the right, QA and log
 * along the bottom — with the three primary actions always visible and every
 * advanced control collapsed until asked for.
 */

import './styles.css';
import { checkNativeHealth, NATIVE_STATUS_LABEL } from '../adapters/native-messaging/client';
import { describeTree } from '../core/layout';
import { PROJECT_EXTENSION } from '../core/project';
import { FORMATS, getFormat } from '../core/registry';
import { type AppSettings, loadSettings, store } from '../state/store';
import { CommandPalette } from '../ui/command-palette';
import {
  addFiles,
  convertAll,
  convertItem,
  downloadBatchZip,
  downloadSelected,
  filesFromDataTransfer,
  retryFailed,
  toIngestFile,
  toggleBatchPause,
} from './conversion';
import { $, badge, element, formatValue, keyValues, messageBlock } from './dom';
import { host, installHost } from './host';
import { attributesTab } from './panels/attributes';
import { backdropTab } from './panels/backdrop-tab';
import { ensureBackdrop, renderCompare, renderPreview, updateLinkButton, watchConnectivity } from './panels/canvas';
import { buildCommands } from './panels/commands';
import { compareTab, fidelityTab, warningsTab } from './panels/compare';
import { geometryOpsTab } from './panels/geometry-ops';
import { editTab, renderEdit } from './panels/edit-tab';
import { renderFormats } from './panels/formats';
import { renderMeasure, setMeasureMode, stopMeasuring, updateMeasureBar, wireMeasureBar } from './panels/measure';
import { healthPanel } from './panels/health';
import { historyPanel } from './panels/history';
import { crsTab, geometryTab, overviewTab } from './panels/inspector';
import { layersTab } from './panels/layers';
import { renderQueue } from './panels/queue';
import { type CanvasToolId, engineOf, renderToolbar, setCanvasTool, toolForKey } from './panels/toolbar';
import { rebuildPreviewFrom } from './panels/edits';
import { renderSelect, selectTab } from './panels/select-tab';
import { openAboutDialog, openHelpDialog, openSettingsDialog } from './panels/settings';
import { openProject, workflowsPanel } from './panels/workflows';
import { ui } from './ui-state';

// --------------------------------------------------------------------- helpers

function render(): void {
  const state = store.get();
  renderQueue();
  renderFormats();
  renderInspector();
  renderBottom();

  $('queueCount').textContent = `${state.items.length} file${state.items.length === 1 ? '' : 's'}`;
  ($('progressBar') as HTMLElement).style.width = `${Math.round(state.progress * 100)}%`;
  $('perfBadge').textContent = state.perf;

  const selected = store.selected();
  const canConvert = Boolean(selected && (selected.status === 'ready' || selected.status === 'done') && (selected.targetFormatId ?? state.settings.globalTargetFormatId));
  ($('convertBtn') as HTMLButtonElement).disabled = !canConvert || state.busy;
  ($('convertQaBtn') as HTMLButtonElement).disabled = !canConvert || state.busy;
  ($('downloadBtn') as HTMLButtonElement).disabled = !selected?.outputs?.length;
  ($('batchZipBtn') as HTMLButtonElement).disabled = !state.items.some((item) => item.status === 'done');

  // Pause is only meaningful while a batch is running, and Retry only once
  // something has failed — a control that can never do anything is noise, and
  // a disabled one still asks the reader to work out why.
  const pause = $('pauseBtn');
  pause.classList.toggle('hidden', !state.busy);
  pause.textContent = state.batchPaused ? 'Resume' : 'Pause';
  pause.classList.toggle('btn--on', state.batchPaused);

  const failedCount = state.items.filter((item) => item.status === 'failed').length;
  const retry = $('retryBtn');
  retry.classList.toggle('hidden', failedCount === 0 || state.busy);
  retry.textContent = `Retry ${failedCount} failed`;

  const target = selected?.targetFormatId ?? state.settings.globalTargetFormatId;
  $('targetBadge').textContent = target ? (getFormat(target)?.name ?? target) : 'none selected';
  $('targetBadge').className = target ? 'badge badge--accent' : 'badge badge--muted';

  updateLocalBadge(state);

  const dropzone = $('dropzone');
  dropzone.classList.toggle('dropzone--compact', state.items.length > 0);
  $('inspectorTabs').classList.toggle('hidden', !selected);

  // ONE CANVAS, ALWAYS PRESENT.
  //
  // It used to be shown only on the five sections that named it, so switching
  // to Layers or Attributes made the drawing disappear and switching back
  // rebuilt it from scratch — losing the pan and zoom every time. The canvas is
  // the workspace now; the sections change which TOOL is live on it, never
  // whether it exists.
  $('previewWrap').classList.toggle('hidden', !selected);
  renderToolbar($('canvasToolbar'), Boolean(selected));
  applyCanvasTool(Boolean(selected));
  updateMeasureBar(selected ?? undefined);
  $('compareWrap').classList.toggle('hidden', state.inspectorTab !== 'compare' || !selected);
}

/**
 * Takes the last edit back, keeping it for Redo.
 *
 * The rebuild replays the commands that REMAIN rather than inverting the one
 * removed: an inverse that drifts from its forward operation is the classic way
 * an undo leaves the data subtly different from where it started.
 */
function undoEdit(): void {
  const item = store.selected();
  const all = item?.edits ?? [];
  if (!item || all.length === 0) return;
  const undone = all[all.length - 1];
  store.set({ redoStack: [...(store.get().redoStack ?? []), undone] });
  rebuildPreviewFrom(item, all.slice(0, -1));
}

/** Puts back the edit Undo took, if no new edit has been made since. */
function redoEdit(): void {
  const item = store.selected();
  const stack = store.get().redoStack ?? [];
  if (!item || stack.length === 0) return;
  const command = stack[stack.length - 1];
  store.set({ redoStack: stack.slice(0, -1) });
  rebuildPreviewFrom(item, [...(item.edits ?? []), command]);
}

/**
 * Undo and redo, on the canvas where the edits are made.
 *
 * The queue of edits already supported taking the last one back; what was
 * missing was a forward stack, so an accidental undo could not be walked back.
 * `store.redoStack` holds the commands popped off the end, and any NEW edit
 * clears it — the standard rule, and the only one that cannot produce a redo
 * that reapplies a command to geometry it was never planned against.
 */
// Undo and redo are built by `renderToolbar`, which sets their disabled state
// from the same `edits` and `redoStack` this used to read. Two places deciding
// whether Undo is available is one place too many.

/**
 * Keeps the "Local only" badge honest.
 *
 * The badge is the strongest promise this tool makes, and it was static text:
 * "Local only — no file leaves this machine. There is no network path in any
 * conversion." Both sentences are still literally true with the basemap on —
 * tiles are a view-time layer and touch no conversion path — but a badge
 * reading "Local only" while the tool is fetching map tiles overclaims, and a
 * user weighing whether to open a survey under NDA deserves to see the
 * difference rather than read the title attribute for it.
 *
 * So it says which it is. What never changes is the part that matters: no file
 * bytes, no attribute values and no file names are ever sent anywhere. Tiles
 * carry COORDINATES, which discloses the area being looked at and nothing else.
 */
function updateLocalBadge(state: { settings: AppSettings }): void {
  const badge = $('localBadge');
  const tiles = state.settings.basemapEnabled && navigator.onLine !== false;

  badge.textContent = tiles ? 'Local + map tiles' : 'Local only';
  badge.className = tiles ? 'badge badge--warn' : 'badge badge--ok';
  badge.title = tiles
    ? 'Conversions are local — no file, attribute or file name is ever sent anywhere. The map basemap is the one exception and it is on: it requests TILE COORDINATES from the provider you chose, which discloses the area you are looking at. Turn it off in Settings to make no network request at all.'
    : 'No file leaves this machine. There is no network path in any conversion, and no request of any kind is being made.';
}

/**
 * Makes exactly one engine live, and stops the rest.
 *
 * THE RULE: one tool owns the pointer. The three interaction layers each claim
 * the canvas's single overlay hook, so two enabled at once means the last one
 * to attach draws and the other quietly takes clicks — a vertex landing in the
 * middle of a measurement, or a rubber band committing a translate over a
 * drawing. Every engine is therefore stopped first and one is started after.
 *
 * This used to be driven by `inspectorTab`, which made a tool a side effect of
 * which panel the dock was showing: opening Attributes to check a field turned
 * off the drawing tool you were mid-polygon with. The tool is now its own
 * state, so the dock is free to show anything.
 */
function applyCanvasTool(selected: boolean): void {
  const item = store.selected();
  const tool = (store.get().canvasTool ?? 'pan') as CanvasToolId;
  const engine = selected ? engineOf(tool) : 'none';

  // --- stop everything ---------------------------------------------------
  ui.editCanvas?.setEnabled(false);
  ui.toolCanvas?.setEnabled(false);
  if (engine !== 'measure') stopMeasuring();

  if (!item || engine === 'none') {
    $('toolStatus').classList.add('hidden');
    return;
  }
  $('toolStatus').classList.remove('hidden');

  // --- start the one ----------------------------------------------------
  if (engine === 'tool') {
    renderSelect(item);
    // `select`, `lasso` and `move` are ToolCanvas's own names; the drawing
    // tools already share theirs, so the id passes straight through.
    ui.toolCanvas?.setTool(tool as Parameters<NonNullable<typeof ui.toolCanvas>['setTool']>[0]);
    ui.toolCanvas?.setOrtho(ui.orthoOn === true);
  } else if (engine === 'edit') {
    renderEdit(item);
    ui.editCanvas?.setEnabled(true);
  } else if (engine === 'measure') {
    renderMeasure(item);
    setMeasureMode(tool === 'measure-area' ? 'area' : 'distance');
  } else if (engine === 'info') {
    // Feature info is a read-only click, so it rides the select engine rather
    // than having a fourth interaction layer of its own: the click that
    // reports a parcel's area is the same click that selects it.
    renderSelect(item);
    ui.toolCanvas?.setTool('select');
  }
}

function renderInspector(): void {
  const state = store.get();
  const body = $('inspectorBody');
  const item = store.selected();
  body.replaceChildren();
  $('warnCount').textContent = String(item?.warnings.length ?? 0);

  if (!item) {
    body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Select a queued file to inspect it.' }));
    return;
  }

  if (item.error) {
    body.append(messageBlock('error', item.error.what, item.error.why, item.error.action));
  }

  // Layers live in the left panel now, beside the drawing they control, so
  // they are rendered every time rather than only when a tab is open.
  const rail = $('layerRail');
  rail.replaceChildren();
  // Only once there is a dataset to describe. Rendering during inspection is
  // what surfaced the crash above, and a half-built layer list is not
  // information anyone can use anyway.
  if (item.dataset) rail.append(...layersTab(item));

  // The canvas is drawn ONCE, for every section, before the switch decides
  // which tool is live on it. Previously six of the fourteen cases each called
  // `renderPreview` and the rest did not, so the drawing blinked in and out as
  // the user moved between sections and every return rebuilt it from scratch.
  renderPreview(item);

  switch (state.inspectorTab) {
    case 'overview':
      body.append(...overviewTab(item));
      break;
    case 'geometry':
      body.append(...geometryTab(item));
      break;
    case 'crs':
      body.append(...crsTab(item));
      break;
    case 'attributes':
      body.append(...attributesTab(item));
      break;
    case 'geometry-ops':
      body.append(...geometryOpsTab(item));
      break;
    case 'backdrop':
      // The canvas already exists (hoisted above the switch), so the backdrop
      // attaches to a layer that is guaranteed to be there.
      ensureBackdrop();
      body.append(...backdropTab(item));
      break;
    case 'select':
      body.append(...selectTab(item));
      renderSelect(item);
      break;
    case 'edit':
      body.append(...editTab(item));
      renderEdit(item);
      break;
    case 'measure':
      // Measuring used to live on the Preview tab "because that is where the
      // map is". The map is everywhere now, so the tool gets its own section
      // rather than being hidden inside one that no longer exists.
      renderMeasure(item);
      break;
    case 'metadata':
      body.append(keyValues(Object.entries(item.dataset?.metadata ?? {}).map(([key, value]) => [key, formatValue(value)])));
      break;
    case 'fidelity':
      body.append(...fidelityTab(item));
      break;
    case 'compare':
      body.append(...compareTab(item));
      renderCompare(item);
      break;
    case 'warnings':
      body.append(...warningsTab(item));
      break;
    default:
      break;
  }
}

/**
 * Selects a tab from code, moving the button state with it.
 *
 * Setting `inspectorTab` alone renders the right panel under the wrong
 * highlighted tab — a small inconsistency that makes a palette command look
 * like it half worked.
 */
function showInspectorTab(name: string): void {
  store.set({ inspectorTab: name });
  for (const tab of Array.from(document.querySelectorAll('[data-tab]'))) {
    const on = (tab as HTMLElement).dataset.tab === name;
    tab.classList.toggle('tab--on', on);
    tab.setAttribute('aria-selected', String(on));
  }
  render();
}

function showBottomTab(name: string): void {
  store.set({ bottomTab: name });
  for (const tab of Array.from(document.querySelectorAll('[data-bottom]'))) {
    tab.classList.toggle('tab--on', (tab as HTMLElement).dataset.bottom === name);
  }
  renderBottom();
}

function renderBottom(): void {
  const state = store.get();
  const body = $('bottomBody');
  body.replaceChildren();

  if (state.bottomTab === 'log') {
    const log = element('div', { class: 'log' });
    for (const entry of state.log) {
      const line = element('div', { class: `log__line log__line--${entry.level}` });
      line.append(element('span', { class: 'log__time', text: new Date(entry.at).toLocaleTimeString() }));
      line.append(element('span', { class: 'log__msg', text: entry.message }));
      log.append(line);
    }
    body.append(log);
    log.scrollTop = log.scrollHeight;
    return;
  }

  if (state.bottomTab === 'manifest') {
    if (!state.manifestCsv) {
      body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Convert a batch and choose Batch ZIP to produce a manifest.' }));
      return;
    }
    body.append(element('pre', { class: 'log', text: state.manifestCsv }));
    return;
  }

  if (state.bottomTab === 'workflows') {
    body.append(...workflowsPanel());
    return;
  }

  const item = store.selected();

  if (state.bottomTab === 'health') {
    body.append(...healthPanel(item));
    return;
  }

  if (state.bottomTab === 'history') {
    body.append(...historyPanel(item));
    return;
  }

  if (state.bottomTab === 'delivery') {
    if (!item?.tree?.length) {
      body.append(
        element('p', {
          class: 'muted',
          style: 'padding:16px',
          text: 'Convert a file to see the structure of its delivery — the folders and files it produced.',
        })
      );
      return;
    }
    const header = element('div', { class: 'qa__verdict' });
    header.append(badge(`${item.tree.length} file${item.tree.length === 1 ? '' : 's'}`, 'accent'));
    header.append(
      element('span', {
        class: 'muted',
        text:
          item.outputs && item.outputs.length === 1 && item.outputs[0].name.endsWith('.zip')
            ? `Packaged as ${item.outputs[0].name} — the ZIP's folders are this tree.`
            : 'Delivered as loose file(s).',
      })
    );
    body.append(header);
    body.append(element('pre', { class: 'log', text: describeTree(item.tree).join('\n') }));
    return;
  }

  if (!item?.qa) {
    body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Convert a file to see its fidelity report.' }));
    return;
  }

  const verdict = element('div', { class: 'qa__verdict' });
  const kind = item.qa.verdict === 'PASS' ? 'ok' : item.qa.verdict === 'FAILED' ? 'error' : item.qa.verdict === 'NOT_VALIDATED' ? 'muted' : 'warn';
  verdict.append(badge(`Fidelity: ${item.qa.verdict.replace(/_/g, ' ')}`, kind));
  verdict.append(element('span', { class: 'muted', text: item.qa.summary }));
  body.append(verdict);

  if (item.qa.checks.length > 0) {
    const table = element('table', { class: 'table' });
    table.append(
      element('thead', {}, [
        element('tr', {}, [element('th', { text: 'Check' }), element('th', { text: 'Source' }), element('th', { text: 'Re-imported output' }), element('th', { text: 'Result' })]),
      ])
    );
    const tbody = element('tbody');
    for (const check of item.qa.checks) {
      const row = element('tr');
      row.append(element('td', { text: check.name }));
      row.append(element('td', { class: 'mono', text: check.source }));
      row.append(element('td', { class: 'mono', text: check.target }));
      const statusCell = element('td');
      statusCell.append(badge(check.status, check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warn' : 'muted'));
      if (check.note) statusCell.append(element('div', { class: 'small muted', text: check.note }));
      row.append(statusCell);
      tbody.append(row);
    }
    table.append(tbody);
    body.append(element('div', { class: 'scroll-x' }, [table]));
  }
}

// --------------------------------------------------------------------- setup

async function refreshNative(): Promise<void> {
  const health = await checkNativeHealth();
  store.set({ native: health });
  const nativeBadge = $('nativeBadge');
  nativeBadge.textContent = NATIVE_STATUS_LABEL[health.status];
  nativeBadge.className = `badge badge--${health.status === 'READY' ? 'ok' : health.status === 'NOT_INSTALLED' ? 'muted' : 'warn'}`;
  nativeBadge.title = health.message;
  render();
}

function applyTheme(theme: AppSettings['theme']): void {
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
}

function wire(): void {
  const dropzone = $('dropzone');
  const filePicker = $('filePicker') as HTMLInputElement;

  for (const eventName of ['dragenter', 'dragover'] as const) {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('dropzone--active');
    });
  }
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) dropzone.classList.remove('dropzone--active');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dropzone--active');
    if (event.dataTransfer) void filesFromDataTransfer(event.dataTransfer).then(addFiles);
  });

  const browse = () => filePicker.click();
  dropzone.addEventListener('click', browse);
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      browse();
    }
  });
  $('dropBrowseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    browse();
  });
  $('addFilesBtn').addEventListener('click', browse);
  filePicker.addEventListener('change', async () => {
    const files = await Promise.all(Array.from(filePicker.files ?? []).map((file) => toIngestFile(file)));
    filePicker.value = '';
    await addFiles(files);
  });

  // Picking a folder. `toIngestFile` already reads `webkitRelativePath`, so the
  // tree arrives with its paths intact and the companion grouper pairs each
  // .shp with the .dbf beside it rather than with one from a sibling folder.
  const folderPicker = $('folderPicker') as HTMLInputElement;
  const browseFolder = () => folderPicker.click();
  $('dropFolderBtn').addEventListener('click', (event) => {
    // The dropzone itself is a click target, so a button inside it has to stop
    // the event or choosing a folder opens the file picker straight after.
    event.stopPropagation();
    browseFolder();
  });
  folderPicker.addEventListener('change', async () => {
    const files = await Promise.all(Array.from(folderPicker.files ?? []).map((file) => toIngestFile(file)));
    folderPicker.value = '';
    await addFiles(files);
  });

  $('clearQueueBtn').addEventListener('click', () => {
    store.set({ items: [], selectedId: null, manifestCsv: undefined });
    store.log('info', 'Queue cleared.');
    render();
  });

  $('convertBtn').addEventListener('click', () => {
    const item = store.selected();
    if (item) void convertItem(item.id, store.get().settings.runQa);
  });
  $('convertQaBtn').addEventListener('click', () => {
    const item = store.selected();
    if (item) void convertItem(item.id, true);
  });
  $('pauseBtn').addEventListener('click', toggleBatchPause);
  $('retryBtn').addEventListener('click', () => void retryFailed(store.get().settings.runQa));
  $('downloadBtn').addEventListener('click', downloadSelected);
  $('batchZipBtn').addEventListener('click', () => void downloadBatchZip());

  $('settingsBtn').addEventListener('click', openSettingsDialog);
  $('helpBtn').addEventListener('click', openHelpDialog);
  // The credit in the top bar is also the way to the licence text and the
  // feedback address, so it opens the same dialog rather than being inert.
  $('aboutBtn').addEventListener('click', openAboutDialog);
  $('themeBtn').addEventListener('click', () => {
    const order: AppSettings['theme'][] = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(store.get().settings.theme) + 1) % order.length];
    void store.patchSettings({ theme: next });
    applyTheme(next);
  });

  $('formatSearch').addEventListener('input', (event) => {
    store.set({ formatSearch: (event.target as HTMLInputElement).value });
    renderFormats();
  });

  for (const tab of Array.from(document.querySelectorAll('[data-tab]'))) {
    tab.addEventListener('click', () => {
      const name = (tab as HTMLElement).dataset.tab!;
      store.set({ inspectorTab: name });
      for (const other of Array.from(document.querySelectorAll('[data-tab]'))) {
        other.classList.toggle('tab--on', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      }
      render();
    });
  }
  // The group row above the section strip. Only one sub-strip is in the DOM's
  // flow at a time, which is what keeps fourteen sections inside a 340px dock
  // without a five-row wrap or a scrollbar nobody can hit.
  for (const gtab of Array.from(document.querySelectorAll('[data-group]'))) {
    gtab.addEventListener('click', () => {
      const group = (gtab as HTMLElement).dataset.group!;
      store.set({ inspectorGroup: group });
      for (const other of Array.from(document.querySelectorAll('[data-group]'))) {
        const on = other === gtab;
        other.classList.toggle('gtab--on', on);
        other.setAttribute('aria-selected', String(on));
      }
      let first: HTMLElement | null = null;
      for (const strip of Array.from(document.querySelectorAll('[data-groupfor]'))) {
        const on = (strip as HTMLElement).dataset.groupfor === group;
        strip.classList.toggle('hidden', !on);
        if (on) first = strip.querySelector('[data-tab]');
      }
      // Results is the old bottom dock, so it shows the other body. Swapping
      // which one is visible is all that moving it here took.
      const results = group === 'results';
      $('inspectorBody').classList.toggle('hidden', results);
      $('bottomBody').classList.toggle('hidden', !results);
      if (results) renderBottom();
      // Switching group moves to its first section rather than leaving the
      // body showing a panel whose tab is no longer on screen.
      else if (first?.dataset.tab) showInspectorTab(first.dataset.tab);
    });
  }

  // The toolbar builds Undo and Redo, so it needs to be able to call them.
  // Passing the functions through `ui` rather than importing `main.ts` from the
  // toolbar keeps the dependency one-way.
  ui.undo = () => undoEdit();
  ui.redo = () => redoEdit();

  // Collapse toggles. The class does the work; the arrow is only a label.
  $('layersToggle').addEventListener('click', () => {
    const closed = $('queueRail').classList.toggle('rail--nolayers');
    $('layersToggle').textContent = closed ? '▸' : '▾';
  });
  $('railToggle').addEventListener('click', () => {
    const rail = $('queueRail');
    rail.classList.toggle('rail--closed');
  });
  $('dockToggle').addEventListener('click', () => {
    const dock = $('rightDock');
    dock.classList.toggle('dock--closed');
  });
  for (const tab of Array.from(document.querySelectorAll('[data-bottom]'))) {
    tab.addEventListener('click', () => {
      store.set({ bottomTab: (tab as HTMLElement).dataset.bottom! });
      for (const other of Array.from(document.querySelectorAll('[data-bottom]'))) other.classList.toggle('tab--on', other === tab);
      renderBottom();
    });
  }

  // The basemap is the only feature here that needs a network, so this is the
  // only thing a connection change affects. Losing it turns the tiles off and
  // says so; regaining it turns them back on without the user doing anything.
  watchConnectivity(() => {
    store.log(
      navigator.onLine ? 'ok' : 'warn',
      navigator.onLine
        ? 'Back online — map tiles are available again.'
        : 'Offline. Map tiles are off until the connection returns; everything else runs on this machine and is unaffected.'
    );
    render();
  });

  // Fit, Grid, the tool buttons, Snap and Ortho are all built and wired by
  // `renderToolbar`. Nothing here reaches into the canvas bar by element id any
  // more, which is what let a button and its tool drift apart in the first
  // place.

  $('compareFitBtn').addEventListener('click', () => ui.dualCanvas?.fit());
  $('compareGridBtn').addEventListener('click', () => ui.dualCanvas?.toggleGrid());
  $('compareLinkBtn').addEventListener('click', () => {
    const linked = !store.get().compareLinked;
    store.set({ compareLinked: linked });
    ui.dualCanvas?.setLinked(linked);
    // The auto-unlink note is about a state the user has now overridden, so it
    // stops being true the moment they choose for themselves.
    $('compareNote').classList.add('hidden');
    updateLinkButton();
  });

  // The project picker is separate from the file picker: a .ubnx is not a
  // dataset, and routing it through the converter's ingest would have the
  // detector trying to work out what kind of survey a project file is.
  const projectPicker = document.createElement('input');
  projectPicker.type = 'file';
  projectPicker.accept = `.${PROJECT_EXTENSION},application/json`;
  projectPicker.className = 'hidden';
  projectPicker.addEventListener('change', async () => {
    const file = projectPicker.files?.[0];
    projectPicker.value = '';
    if (file) await openProject(file);
  });
  document.body.append(projectPicker);
  host.openProjectPicker = () => projectPicker.click();

  document.addEventListener('keydown', (event) => {
    // TYPING WINS, ALWAYS.
    //
    // Single-letter tool keys make this rule load-bearing rather than polite:
    // without it, typing a layer name containing "v" would drop the user into
    // the Select tool mid-word. Checked once, at the top, for every branch.
    const typing = Boolean((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]'));
    const accel = event.ctrlKey || event.metaKey;

    if (accel && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      browse();
      return;
    }
    if (accel && event.key === 'Enter') {
      event.preventDefault();
      void convertAll(store.get().settings.runQa);
      return;
    }

    // Undo and redo, on the keys every application uses.
    //
    // This used to run TWICE on one keypress: a first branch called `undoEdit`
    // and a second, further down, matched the same key and also stepped the
    // history back — so one Ctrl+Z reversed an edit and moved the history
    // pointer, and the user lost two operations for one keystroke. There is now
    // exactly one handler for the combination, and it returns.
    if (accel && !typing && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault();
      if (event.key.toLowerCase() === 'y' || event.shiftKey) redoEdit();
      else undoEdit();
      return;
    }

    // Ctrl/Cmd+K, the shortcut every palette uses. Muscle memory is the whole
    // point of matching the convention rather than inventing one.
    if (accel && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      ui.palette ??= new CommandPalette($('commandPalette') as HTMLDialogElement, {
        onRun: (command) => void command.run(),
      });
      ui.palette.open(buildCommands());
      return;
    }

    // Collapse either side panel, so the canvas can take the whole window
    // without reaching for the mouse.
    if (accel && (event.key === '1' || event.key === '2')) {
      event.preventDefault();
      const panel = event.key === '1' ? $('queueRail') : $('rightDock');
      panel.classList.toggle(event.key === '1' ? 'rail--closed' : 'dock--closed');
      return;
    }

    if (accel || event.altKey || typing) return;

    // --- single-key tools ------------------------------------------------
    // Only with a file open: a tool key with nothing loaded would light a
    // button for a canvas that is not there.
    if (store.selected()) {
      const tool = toolForKey(event.key);
      if (tool) {
        event.preventDefault();
        setCanvasTool(tool.id);
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        ui.previewCanvas?.fit();
        return;
      }
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        ui.previewCanvas?.toggleGrid();
        ui.gridOn = ui.gridOn === false;
        render();
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        ui.snapOn = ui.snapOn !== true;
        render();
        return;
      }
      // Escape falls THROUGH to ToolCanvas, which cancels a drawing in
      // progress first and clears the selection second. Returning to Pan is
      // the last step, and only once it has nothing left of its own to undo.
      if (event.key === 'Escape' && !ui.toolCanvas?.isDrawing()) {
        setCanvasTool('pan');
      }
    }
  });

  wireMeasureBar();

  // The format registry drives even the drop-zone hint, so it can never drift
  // from what the engines actually support.
  const importable = FORMATS.filter((format) => format.support.import === 'full').length;
  $('dropFormats').textContent = `${importable} formats read directly · Shapefile, DXF, KML/KMZ, GeoJSON, LAS, CSV/PNEZD, LandXML, Surpac STR, ASCII grid and more`;
}

async function boot(): Promise<void> {
  // Before anything else: the panels reach the shell only through this, and the
  // defaults in `host.ts` throw rather than no-op, so a missing entry here is a
  // named error at the first click instead of a button that quietly does nothing.
  installHost({
    render,
    renderQueue,
    renderInspector,
    showInspectorTab,
    showBottomTab,
    refreshNative,
    applyTheme,
  });

  const settings = await loadSettings();
  store.set({ settings });
  applyTheme(settings.theme);
  wire();
  store.subscribe(() => {
    /* views re-render explicitly; the subscription keeps the store honest */
  });
  store.log('info', 'BhuNex GIS Converter ready. All processing is local.');
  render();
  void refreshNative();
}

void boot();