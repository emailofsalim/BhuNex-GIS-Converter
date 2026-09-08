/** What will be lost, what was lost, and the warnings: the evidence tabs. */

import { AXIS_LABEL, FIDELITY_AXES, GRADE_LABEL, predictFromProfile } from '../../core/predict';
import { DIFF_AXIS_LABEL } from '../../qa/diff';
import { type GeometryOverlay, OVERLAY_ROLE_LABEL } from '../../qa/geometry-overlay';
import { type QueueItem, store } from '../../state/store';
import { badge, element, messageBlock } from '../dom';
import { gradeTone, predictOptions } from './formats';

/**
 * "Show exactly what will be lost" (spec §22.3).
 *
 * Deliberately not a modal that interrupts: it is a tab the user can sit in
 * while trying different targets, because choosing a format IS the comparison.
 * Every row is one counted, named statement with the remedy beside it — a list
 * of vague risks would be worse than nothing, since it teaches people to ignore
 * the panel.
 */
export function fidelityTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });
  const targetId = item.targetFormatId ?? store.get().settings.globalTargetFormatId;

  if (!item.profile) {
    wrap.append(element('p', { class: 'muted', text: 'Inspect the file first — the prediction is computed from the data, not from the format alone.' }));
    return [wrap];
  }
  if (!targetId) {
    wrap.append(element('p', { class: 'muted', text: 'Pick an output format to see what the conversion would cost.' }));
    return [wrap];
  }

  // The prediction the conversion itself would make, recomputed live so it
  // tracks the settings panel as the user changes precision or Z handling.
  const prediction = item.prediction?.targetFormatId === targetId ? item.prediction : predictFromProfile(item.profile, targetId, predictOptions());

  const head = element('div', { class: 'fidelity__head' });
  head.append(
    badge(prediction.blocked ? 'Not possible' : GRADE_LABEL[prediction.overall], prediction.blocked ? 'error' : gradeTone(prediction.overall))
  );
  head.append(element('span', { class: 'fidelity__target', text: `${item.dataset?.name ?? item.fileName} → ${prediction.targetFormatName}` }));
  wrap.append(head);

  if (item.prediction && item.prediction.targetFormatId === targetId) {
    wrap.append(element('p', { class: 'muted small', text: 'This is the prediction made before the conversion that has already run.' }));
  }

  // The axis grid: eleven verdicts at a glance, so an engineer can see that
  // geometry is fine and only attributes suffer, without reading every row.
  const grid = element('div', { class: 'fidelity__axes' });
  for (const axis of FIDELITY_AXES) {
    const grade = prediction.axes[axis];
    const cell = element('div', { class: `fidelity__axis fidelity__axis--${grade}` });
    cell.append(element('span', { class: 'fidelity__axis-name', text: AXIS_LABEL[axis] }));
    cell.append(element('span', { class: 'fidelity__axis-grade', text: GRADE_LABEL[grade] }));
    grid.append(cell);
  }
  wrap.append(grid);

  if (prediction.findings.length === 0) {
    wrap.append(element('p', { class: 'msg msg--info', text: 'Nothing is lost in this conversion. Every axis is faithful.' }));
    return [wrap];
  }

  // Losses first: a user scanning this list should meet the expensive news
  // before the merely-interesting news.
  const ordered = [...prediction.findings].sort((left, right) => (left.grade === right.grade ? 0 : left.grade === 'red' ? -1 : 1));
  for (const finding of ordered) {
    const node = element('div', { class: `msg msg--${finding.grade === 'red' ? 'error' : 'warn'}` });
    node.append(element('span', { class: 'msg__icon', text: finding.grade === 'red' ? '✕' : '!' }));
    const body = element('div', { class: 'msg__body' });
    body.append(element('div', { class: 'msg__what', text: finding.statement }));
    body.append(element('div', { class: 'msg__why', text: `${AXIS_LABEL[finding.axis]} · ${GRADE_LABEL[finding.grade]}` }));
    if (finding.remedy) body.append(element('div', { class: 'msg__action', text: finding.remedy }));
    node.append(body);
    wrap.append(node);
  }

  const foot = element('p', { class: 'muted small' });
  foot.textContent =
    'Predicted from what this data holds and what the format can store — no conversion has been run. ' +
    'Nothing here blocks the export: the trade-off is yours to make.';
  wrap.append(foot);
  return [wrap];
}

/**
 * Source versus output, measured (spec §30.2).
 *
 * The number is the deliverable here. "PASS" tells a surveyor signing off a
 * job nothing about whether the difference is rounding or a defect, so every
 * axis shows both values, the difference, and the tolerance it was judged
 * against — the format the master document asks for.
 */
export function compareTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });

  if (!item.diff) {
    wrap.append(
      element('p', {
        class: 'muted',
        text: item.qa
          ? 'No measured comparison for this conversion — the target has no reader, so there is nothing to read back and compare against.'
          : 'Convert the file to compare its output with the source.',
      })
    );
    return [wrap];
  }

  const head = element('div', { class: 'fidelity__head' });
  head.append(badge(item.diff.passed ? 'Matches the source' : 'Differs from the source', item.diff.passed ? 'ok' : 'warn'));
  head.append(element('span', { class: 'fidelity__target', text: item.diff.summary }));
  wrap.append(head);

  const header = element('div', { class: 'diff__row diff__row--head' });
  for (const label of ['Axis', 'Source', 'Output', 'Difference', '']) header.append(element('span', { text: label }));
  wrap.append(header);

  for (const entry of item.diff.entries) {
    const row = element('div', { class: 'diff__row' });
    row.append(element('span', { class: 'diff__axis', text: DIFF_AXIS_LABEL[entry.axis] }));
    row.append(element('span', { class: 'diff__value', text: entry.source }));
    row.append(element('span', { class: 'diff__value', text: entry.output }));
    row.append(element('span', { class: 'diff__value', text: entry.difference }));

    const verdict =
      entry.verdict === 'differs' ? 'FAIL' : entry.verdict === 'not-comparable' ? 'N/A' : entry.verdict === 'identical' ? 'EXACT' : 'PASS';
    const tone = entry.verdict === 'differs' ? 'fail' : entry.verdict === 'not-comparable' ? 'na' : 'pass';
    const verdictNode = element('span', { class: `diff__verdict diff__verdict--${tone}`, text: verdict });
    if (entry.tolerance) verdictNode.title = `Tolerance ${entry.tolerance}`;
    row.append(verdictNode);

    if (entry.note) row.append(element('span', { class: 'diff__note', text: entry.note }));
    wrap.append(row);
  }

  wrap.append(
    element('p', {
      class: 'small faint',
      style: 'margin-top:10px',
      text: 'Measured against the output re-imported during QA, so these numbers describe the bytes that were actually written.',
    })
  );

  if (item.overlay) wrap.append(overlaySummary(item.overlay));
  return [wrap];
}

/**
 * The overlay's findings as text beside the canvases.
 *
 * The picture shows where; this says how many and how far, which is what gets
 * written into a handover note. An unpaired layer is stated rather than left as
 * an absence — a user who sees nothing marked "moved" must be able to tell the
 * difference between "nothing moved" and "we could not tell".
 */
export function overlaySummary(overlay: GeometryOverlay): HTMLElement {
  const wrap = element('div', { class: 'section', style: 'margin-top:12px' });
  wrap.append(element('h3', { class: 'section__title', text: 'Where the differences are' }));
  wrap.append(element('p', { class: 'small', text: overlay.summary }));

  const roles = ['added', 'removed', 'moved', 'retyped'] as const;
  const chips = element('div', { class: 'chips' });
  for (const role of roles) {
    if (overlay.counts[role] === 0) continue;
    chips.append(element('span', { class: `chip chip--overlay chip--overlay-${role}`, text: `${OVERLAY_ROLE_LABEL[role]}: ${overlay.counts[role].toLocaleString()}` }));
  }
  if (chips.childElementCount > 0) wrap.append(chips);

  for (const unpaired of overlay.unpaired) {
    wrap.append(
      messageBlock(
        'warn',
        `Layer “${unpaired.layer}” could not be paired feature for feature.`,
        `${unpaired.sourceFeatures.toLocaleString()} features in the source, ${unpaired.outputFeatures.toLocaleString()} in the output. ${unpaired.reason}`
      )
    );
  }

  if (overlay.omitted > 0) {
    wrap.append(
      element('p', {
        class: 'small faint',
        text: `${overlay.omitted.toLocaleString()} more differences are counted above but not drawn — the canvas caps what it renders. The counts are exact.`,
      })
    );
  }

  return wrap;
}

export function warningsTab(item: QueueItem): HTMLElement[] {
  if (item.warnings.length === 0) return [element('p', { class: 'muted', style: 'padding:16px', text: 'No warnings for this dataset.' })];
  const wrap = element('div', { style: 'padding:12px' });
  for (const warning of item.warnings) {
    const node = element('div', { class: `msg msg--${warning.severity === 'error' ? 'error' : warning.severity === 'warning' ? 'warn' : 'info'}` });
    node.append(element('span', { class: 'msg__icon', text: warning.severity === 'error' ? '✕' : warning.severity === 'warning' ? '!' : 'i' }));
    const body = element('div', { class: 'msg__body' });
    body.append(element('div', { class: 'msg__what', text: warning.count && warning.count > 1 ? `${warning.message} (×${warning.count})` : warning.message }));
    if (warning.reason) body.append(element('div', { class: 'msg__why', text: warning.reason }));
    if (warning.action) body.append(element('div', { class: 'msg__action', text: warning.action }));
    node.append(body);
    wrap.append(node);
  }
  return [wrap];
}
