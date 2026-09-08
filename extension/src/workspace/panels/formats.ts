/**
 * The target-format picker, ordered by PREDICTED FIDELITY rather than by name.
 *
 * A format list sorted alphabetically makes the engineer do the ranking; the
 * prediction already knows which targets keep the data intact, so it leads with
 * them and puts the cost on the card of the ones that do not.
 */

import {
  type FidelityGrade,
  type FidelityPrediction,
  GRADE_LABEL,
  predictFromProfile,
  summarisePrediction,
} from '../../core/predict';
import {
  CATEGORY_LABEL,
  exportTargetsFor,
  type FormatCategory,
  type FormatDef,
  FORMATS,
  isAvailable,
  SUPPORT_LABEL,
} from '../../core/registry';
import { store } from '../../state/store';
import { $, badge, element } from '../dom';
import { host } from '../host';

/**
 * Options the predictor needs, taken from the settings the user has actually set.
 *
 * Kept in one place so the format cards, the "what will be lost" dialog and the
 * conversion itself all predict against identical inputs — a card promising
 * GREEN while the conversion reports loss would destroy the feature's whole
 * point.
 */
export function predictOptions(): Parameters<typeof predictFromProfile>[2] {
  const settings = store.get().settings;
  return {
    sourceCrsEpsg: settings.sourceCrsEpsg,
    targetCrsEpsg: settings.targetCrsEpsg,
    preserveZ: settings.preserveZ,
    precisionDecimals: settings.precisionMode === 'fixed' ? settings.precisionDecimals : undefined,
  };
}

/** The prediction for one candidate target, or null when nothing is inspected yet. */
export function predictionFor(targetFormatId: string): FidelityPrediction | null {
  const item = store.selected();
  if (!item?.profile) return null;
  return predictFromProfile(item.profile, targetFormatId, predictOptions());
}

export function gradeTone(grade: FidelityGrade): 'ok' | 'warn' | 'error' {
  return grade === 'green' ? 'ok' : grade === 'yellow' ? 'warn' : 'error';
}

export function renderFormats(): void {
  const state = store.get();
  const selected = store.selected();
  const kind = selected?.dataset?.kind ?? 'vector';
  const nativeReady = state.native.status === 'READY';

  const chips = $('categoryChips');
  chips.replaceChildren();
  const categories: (FormatCategory | null)[] = [null, 'gis', 'cad', 'raster', 'lidar', 'survey', 'gps', 'mining', 'spreadsheet'];
  for (const category of categories) {
    const label = category ? CATEGORY_LABEL[category] : 'All';
    const chip = element('button', { class: `chip${state.formatCategory === category ? ' chip--on' : ''}`, text: label });
    chip.addEventListener('click', () => {
      store.set({ formatCategory: category });
      host.render();
    });
    chips.append(chip);
  }

  const search = state.formatSearch.trim().toLowerCase();
  const candidates = selected ? exportTargetsFor(kind) : FORMATS.filter((format) => format.support.export !== 'none');
  const visible = candidates
    .filter((format) => !state.formatCategory || format.category === state.formatCategory)
    .filter(
      (format) =>
        !search ||
        format.name.toLowerCase().includes(search) ||
        format.extensions.some((extension) => extension.includes(search)) ||
        format.id.includes(search)
    )
    // Recent formats first — a user converting a hundred files to the same
    // target should not have to hunt for it. After that, and only once a file
    // has been inspected, the ranking is by what this particular data would
    // actually cost in each format (spec §25.3): a faithful target above a
    // lossy one above an impossible one. Before inspection there is nothing to
    // predict from, so it falls back to declared support.
    .sort((a, b) => {
      const recentA = state.settings.recentFormats.indexOf(a.id);
      const recentB = state.settings.recentFormats.indexOf(b.id);
      if (recentA !== recentB) return (recentA < 0 ? 99 : recentA) - (recentB < 0 ? 99 : recentB);

      const profile = selected?.profile;
      if (profile) {
        const score = (format: FormatDef) => {
          const prediction = predictFromProfile(profile, format.id, predictOptions());
          if (prediction.blocked) return 4;
          return prediction.overall === 'green' ? 0 : prediction.overall === 'yellow' ? 1 : 2;
        };
        const byFidelity = score(a) - score(b);
        if (byFidelity !== 0) return byFidelity;
      }

      const rank = (format: FormatDef) => (format.support.export === 'full' ? 0 : format.support.export === 'partial' ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

  const container = $('formatCards');
  container.replaceChildren();
  if (visible.length === 0) {
    container.append(element('p', { class: 'muted small', text: 'No output format matches this search for the selected data.' }));
    return;
  }

  const current = selected?.targetFormatId ?? state.settings.globalTargetFormatId;
  for (const format of visible) {
    const available = isAvailable(format, 'export', nativeReady);
    const card = element('button', {
      class: `fcard${current === format.id ? ' fcard--on' : ''}`,
      type: 'button',
      title: [format.notes, ...(format.warnings ?? [])].filter(Boolean).join('\n\n'),
    }) as HTMLButtonElement;
    card.disabled = !available;

    card.append(element('span', { class: 'fcard__name', text: format.name }));
    card.append(element('span', { class: 'fcard__ext', text: format.extensions.map((extension) => `.${extension}`).join(' ') }));

    const badges = element('div', { class: 'fcard__badges' });
    badges.append(badge(SUPPORT_LABEL[format.support.export], format.support.export === 'full' ? 'ok' : format.support.export === 'partial' ? 'warn' : 'muted'));
    if (format.supports3D) badges.append(badge('3D', 'info'));
    if (format.supportsAttributes) badges.append(badge('attrs', 'muted'));
    if (format.supportsCRS) badges.append(badge('CRS', 'muted'));
    if (format.requiresNative) badges.append(badge(nativeReady ? 'native ready' : 'native required', nativeReady ? 'ok' : 'error'));
    if (format.requiresWasm) badges.append(badge('engine required', 'error'));
    if (format.packaging === 'zip') badges.append(badge('ZIP package', 'muted', 'Multiple files are packaged automatically.'));

    // The fidelity verdict for THIS data, not a generic capability claim. It is
    // the first badge because it is the one that decides whether this format is
    // the right choice.
    const prediction = available ? predictionFor(format.id) : null;
    if (prediction) {
      const tone = prediction.blocked ? 'error' : gradeTone(prediction.overall);
      badges.prepend(
        badge(prediction.blocked ? 'Not possible' : GRADE_LABEL[prediction.overall], tone, summarisePrediction(prediction))
      );
      if (prediction.blocked) card.disabled = true;
    }
    card.append(badges);

    if (prediction && !prediction.blocked && prediction.findings.length > 0) {
      const detail = element('span', { class: 'fcard__detail', text: summarisePrediction(prediction) });
      card.append(detail);
    }

    card.addEventListener('click', () => {
      if (selected) store.updateItem(selected.id, { targetFormatId: format.id });
      else void store.patchSettings({ globalTargetFormatId: format.id });
      host.render();
    });
    container.append(card);
  }
}

// ---------------------------------------------------------------- inspector
