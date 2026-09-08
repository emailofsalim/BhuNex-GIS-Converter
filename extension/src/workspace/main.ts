/**
 * Universal BhuNex Converter workspace.
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
  toIngestFile,
} from './conversion';
import { $, badge, element, formatValue, keyValues, messageBlock } from './dom';
import { host, installHost } from './host';
import { attributesTab } from './panels/attributes';
import { renderCompare, renderPreview, updateLinkButton } from './panels/canvas';
import { buildCommands } from './panels/commands';
import { compareTab, fidelityTab, warningsTab } from './panels/compare';
import { editTab, renderEdit, updateEditBar } from './panels/edit-tab';
import { renderFormats } from './panels/formats';
import { healthPanel } from './panels/health';
import { historyPanel, stepHistory } from './panels/history';
import { crsTab, geometryTab, overviewTab } from './panels/inspector';
import { layersTab } from './panels/layers';
import { renderQueue } from './panels/queue';
import { openHelpDialog, openSettingsDialog, renderSettingsPanel } from './panels/settings';
import { openProject, workflowsPanel } from './panels/workflows';
import { ui } from './ui-state';

// --------------------------------------------------------------------- helpers

function render(): void {
  const state = store.get();
  renderQueue();
  renderFormats();
  renderInspector();
  renderSettingsPanel();
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

  const target = selected?.targetFormatId ?? state.settings.globalTargetFormatId;
  $('targetBadge').textContent = target ? (getFormat(target)?.name ?? target) : 'none selected';
  $('targetBadge').className = target ? 'badge badge--accent' : 'badge badge--muted';

  const dropzone = $('dropzone');
  dropzone.classList.toggle('dropzone--compact', state.items.length > 0);
  $('inspectorTabs').classList.toggle('hidden', !selected);
  const usesCanvas = state.inspectorTab === 'preview' || state.inspectorTab === 'edit';
  $('previewWrap').classList.toggle('hidden', !usesCanvas || !selected);
  $('editBar').classList.toggle('hidden', state.inspectorTab !== 'edit' || !selected);
  // Leaving the Edit tab turns editing off, so a stray Delete on another tab
  // cannot reach a vertex.
  if (state.inspectorTab !== 'edit') ui.editCanvas?.setEnabled(false);
  $('compareWrap').classList.toggle('hidden', state.inspectorTab !== 'compare' || !selected);
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
    case 'layers':
      body.append(...layersTab(item));
      break;
    case 'preview':
      renderPreview(item);
      break;
    case 'edit':
      body.append(...editTab(item));
      renderPreview(item);
      renderEdit(item);
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
  $('downloadBtn').addEventListener('click', downloadSelected);
  $('batchZipBtn').addEventListener('click', () => void downloadBatchZip());

  $('settingsBtn').addEventListener('click', openSettingsDialog);
  $('helpBtn').addEventListener('click', openHelpDialog);
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
  for (const tab of Array.from(document.querySelectorAll('[data-bottom]'))) {
    tab.addEventListener('click', () => {
      store.set({ bottomTab: (tab as HTMLElement).dataset.bottom! });
      for (const other of Array.from(document.querySelectorAll('[data-bottom]'))) other.classList.toggle('tab--on', other === tab);
      renderBottom();
    });
  }

  $('fitBtn').addEventListener('click', () => ui.previewCanvas?.fit());
  $('gridBtn').addEventListener('click', () => ui.previewCanvas?.toggleGrid());

  $('editToggle').addEventListener('click', () => {
    if (!ui.editCanvas) return;
    ui.editCanvas.setEnabled(!ui.editCanvas.isEnabled());
    updateEditBar();
  });
  ($('editSnap') as HTMLInputElement).addEventListener('change', (event) => {
    void store.patchSettings({ editSnapEnabled: (event.target as HTMLInputElement).checked });
  });

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
    if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
      event.preventDefault();
      browse();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void convertAll(store.get().settings.runQa);
    }
    // Undo and redo, on the keys every application uses. Scoped to the selected
    // file, because two queued surveys are two independent jobs.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      const item = store.selected();
      if (!item?.history) return;
      event.preventDefault();
      stepHistory(item.id, item.history.position + (event.shiftKey ? 1 : -1));
    }
    // Ctrl/Cmd+K, the shortcut every palette uses. Muscle memory is the whole
    // point of matching the convention rather than inventing one.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      ui.palette ??= new CommandPalette($('commandPalette') as HTMLDialogElement, {
        onRun: (command) => void command.run(),
      });
      ui.palette.open(buildCommands());
    }
  });

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
  store.log('info', 'Universal BhuNex Converter ready. All processing is local.');
  render();
  void refreshNative();
}

void boot();
