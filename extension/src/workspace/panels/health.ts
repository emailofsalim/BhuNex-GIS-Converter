/** Project health (spec §29.2) and the conversion report. */

import { describeEntry } from '../../core/history';
import { getFormat } from '../../core/registry';
import { buildReport, reportFiles } from '../../core/report';
import { type QueueItem, store } from '../../state/store';
import { downloadBytes } from '../conversion';
import { badge, element, messageBlock } from '../dom';
import { host } from '../host';

/**
 * The project health panel (spec §29.2).
 *
 * Every component is expandable into the findings that produced its number,
 * because the spec's requirement is exactly that: "A score with no drill-down
 * is decoration." A component that could not be evaluated says so in the place
 * where its score would be, rather than being quietly omitted or shown as a
 * hundred — the latter would make an unassessable dataset look like a clean one.
 */
export function healthPanel(item: QueueItem | undefined): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });

  if (!item) {
    wrap.append(element('p', { class: 'muted', text: 'Select a file to assess its health.' }));
    return [wrap];
  }

  if (!item.health) {
    wrap.append(
      element('p', {
        class: 'muted',
        text: store.get().settings.assessHealth
          ? 'Convert this file to assess its health — the score is computed from the same scans the conversion runs.'
          : 'Health assessment is switched off in the settings.',
      })
    );
    return [wrap];
  }

  const health = item.health;
  const head = element('div', { class: 'qa__verdict' });
  const tone = health.grade === 'good' ? 'ok' : health.grade === 'fair' ? 'warn' : health.grade === 'poor' ? 'error' : 'muted';
  head.append(badge(health.score === null ? 'Not assessed' : `Health ${health.score}/100`, tone));
  head.append(element('span', { class: 'muted', text: health.summary }));
  wrap.append(head);

  for (const component of health.components) {
    const card = element('details', { class: 'health__component' });
    const summary = element('summary', { class: 'health__summary' });
    summary.append(element('span', { class: 'health__label', text: component.label }));

    const scoreTone =
      component.score === null ? 'muted' : component.score >= 85 ? 'ok' : component.score >= 60 ? 'warn' : 'fail';
    summary.append(
      element('span', {
        class: `health__score health__score--${scoreTone}`,
        text: component.score === null ? 'not evaluated' : `${component.score}/100`,
      })
    );
    summary.append(element('span', { class: 'health__weight', text: `weight ${component.weight}` }));
    if (component.findings.length > 0) {
      summary.append(element('span', { class: 'badge badge--muted', text: `${component.findings.length}` }));
    }
    card.append(summary);

    card.append(
      element('p', { class: 'small faint', text: component.score === null ? (component.notEvaluatedReason ?? '') : component.method })
    );

    if (component.findings.length === 0 && component.score !== null) {
      card.append(element('p', { class: 'small', text: 'Nothing found against this component.' }));
    }

    for (const finding of component.findings) {
      const row = element('div', { class: `msg msg--${finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warn' : 'info'}` });
      row.append(element('span', { class: 'msg__icon', text: finding.severity === 'error' ? '✕' : finding.severity === 'warning' ? '!' : 'i' }));
      const bodyNode = element('div', { class: 'msg__body' });
      bodyNode.append(element('div', { class: 'msg__what', text: finding.message }));
      const where = [finding.layer ? `layer ${finding.layer}` : '', finding.featureId !== undefined ? `feature ${finding.featureId}` : '']
        .filter(Boolean)
        .join(', ');
      if (where) bodyNode.append(element('div', { class: 'msg__why', text: where }));
      if (finding.location) {
        bodyNode.append(
          element('div', { class: 'msg__action', text: `at ${finding.location[0].toFixed(3)}, ${finding.location[1].toFixed(3)}` })
        );
      }
      row.append(bodyNode);
      card.append(row);
    }

    wrap.append(card);
  }

  if (health.notEvaluated.length > 0) {
    wrap.append(
      messageBlock(
        'info',
        `${health.notEvaluated.join(' and ')} could not be evaluated.`,
        `The score is a weighted mean of the components that ran, covering ${Math.round(health.coverage * 100)}% of the usual weight. An unevaluated component is excluded rather than scored full marks, so a dataset that cannot be checked never outranks one that can.`
      )
    );
  }

  return [wrap];
}

/**
 * Downloads the conversion report (spec §22.4).
 *
 * Built here from what the item already holds rather than re-run through the
 * pipeline, so the report describes the conversion that actually happened and
 * not a fresh one with today's settings.
 */
export function downloadReport(item: QueueItem): void {
  const report = buildReport({
    dataset: item.dataset,
    sourceFileName: item.fileName,
    sourceFormatName: item.detection?.formatName ?? 'unknown',
    sourceSizeBytes: item.size,
    sha256: item.provenance?.sha256,
    detectionConfidence: item.detection?.confidence,
    targetFormatName: item.targetFormatId ? (getFormat(item.targetFormatId)?.name ?? item.targetFormatId) : undefined,
    outputPaths: item.tree,
    outputSizeBytes: item.outputs?.reduce((sum, output) => sum + output.bytes.length, 0),
    outputDataset: item.outputDataset,
    prediction: item.prediction,
    diff: item.diff,
    qaVerdict: item.qa?.verdict,
    qaSummary: item.qa?.summary,
    health: item.health,
    processing: (item.history?.entries ?? []).map((entry) => ({ label: entry.label, detail: describeEntry(entry) })),
    warnings: item.warnings,
    settings: store.get().settings as unknown as Record<string, unknown>,
    durationMs: item.durationMs,
  });

  const base = item.fileName.replace(/\.[^.]+$/, '');
  for (const file of reportFiles(report, base)) downloadBytes(file.bytes, file.name, file.mimeType);
  store.log('ok', `Report written for ${item.fileName}.`);
  if (report.droppedSecretFields.length > 0) {
    store.log('warn', `${report.droppedSecretFields.length} credential-shaped field(s) were kept out of the report: ${report.droppedSecretFields.join(', ')}.`);
  }
  host.render();
}

// ------------------------------------------------- history, workflows, project
