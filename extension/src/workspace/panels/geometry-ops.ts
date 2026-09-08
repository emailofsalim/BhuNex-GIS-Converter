/**
 * Geometry operations (spec §26.2), made reachable.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLAN IS DRAWN BEFORE IT IS APPLIED
 *
 * Every operation here replaces geometry, and several of them — clip, erase,
 * dissolve, a negative buffer — DELETE things. A number ("1,240 features → 1")
 * is not enough to catch a dissolve that ran on the wrong field, because the
 * number for the right answer and the number for the wrong one look identical.
 * The shape does not.
 *
 * So the plan's output is drawn over the source on the preview canvas in a
 * contrasting colour, and nothing is committed until Apply. This is the same
 * preview-then-commit contract the vertex editor, the repair engine and the
 * attribute table use; §26.2 asks for it explicitly.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEW LAYER IS THE DEFAULT
 *
 * `applyGeometryOperation` replaces the source layer when no output layer is
 * named. That is the right engine default — an offset that could not overwrite
 * would be a strange tool — but it is the wrong UI default: a clip that
 * replaces its source discards every parcel outside the boundary, and the only
 * way back is the history. So this panel starts on "new layer" and the user has
 * to choose to overwrite.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PANEL DOES NOT DECIDE
 *
 * The CRS gate. `planGeometryOperation` refuses a buffer or an offset on a
 * geographic or undeclared CRS, and this panel shows that refusal rather than
 * working around it — a "10 metre" setback on degrees is 1,100 km, and the
 * result is a plausible-looking polygon wrong by five orders of magnitude.
 */

import type { CirFeature, CirGeometry, Position } from '../../core/cir';
import { signedArea } from '../../core/geometry';
import {
  describeGeometryPlan,
  GEOMETRY_LABEL,
  type GeometryOperation,
  type GeometryPlan,
  planGeometryOperation,
  toMultiPolygon,
} from '../../core/geometry-ops';
import type { StoredGeometryOptions } from '../../core/edits';
import { crsLabel } from '../../crs/transform';
import type { QueueItem } from '../../state/store';
import { element, ghostButton, messageBlock } from '../dom';
import { host } from '../host';
import { datasetForTools, protectedFor, truncationOf } from './dataset';
import { pendingEditsPanel, queueEdit } from './edits';

/** The operations, grouped the way an engineer looks for them. */
const GROUPS: { label: string; operations: GeometryOperation[] }[] = [
  { label: 'Distance', operations: ['buffer', 'offset'] },
  { label: 'Combine', operations: ['union', 'intersection', 'difference', 'symmetric-difference', 'dissolve'] },
  { label: 'Against another layer', operations: ['clip', 'erase'] },
  { label: 'Derive', operations: ['convex-hull', 'centroid', 'envelope'] },
  { label: 'Restructure', operations: ['explode', 'multipart', 'line-merge', 'split-by-line'] },
];

const NEEDS_DISTANCE = new Set<GeometryOperation>(['buffer', 'offset']);
const NEEDS_MASK = new Set<GeometryOperation>(['clip', 'erase']);
const NEEDS_CUT = new Set<GeometryOperation>(['split-by-line']);

/**
 * What each operation is for, in the terms the person choosing it is thinking in.
 *
 * Not a restatement of the name. "Buffer: buffers the geometry" tells a user
 * nothing they did not already know; what they need is the unit the number is
 * in and the fact that a negative one shrinks.
 */
const HINT: Record<GeometryOperation, string> = {
  buffer:
    'A zone at a fixed distance around each feature — a setback or a right of way. Negative shrinks a polygon inwards, and features narrower than twice the distance disappear.',
  offset:
    'A parallel copy of a line at a fixed distance. The sign chooses the side. Inside corners are trimmed to their intersection, as a CAD offset does.',
  union: 'One shape covering everything the selected features cover. Shared boundaries between them are dissolved.',
  intersection: 'Only the area every selected feature covers — the overlap.',
  difference: 'The first feature with every later one cut out of it.',
  'symmetric-difference': 'The area covered by exactly one of the features, not by both.',
  dissolve: 'Merges features that share a value in one field. Leave the field unset to merge them all.',
  clip: 'Keeps only the parts inside the masking layer. The parts outside are DISCARDED.',
  erase: 'Removes the parts inside the masking layer.',
  'convex-hull': 'The smallest convex outline containing every selected feature.',
  centroid: 'One point per feature, at its centre of area. For a C-shaped parcel this can fall outside the parcel.',
  envelope: 'The axis-aligned bounding rectangle of each feature.',
  explode: 'Splits each multipart feature into one feature per part. Attributes are copied to every part.',
  multipart: 'Combines the selected features into one multipart feature. Only the first feature’s attributes survive.',
  'line-merge': 'Joins lines that meet end to end into continuous runs.',
  'split-by-line': 'Cuts polygons along a line you supply, as a subdivision does.',
};

interface PanelState {
  itemId: string | null;
  layer: string;
  operation: GeometryOperation;
  distance: string;
  field: string;
  maskLayer: string;
  cut: string;
  toNewLayer: boolean;
  outputLayer: string;
}

/**
 * Panel state, not application state.
 *
 * A half-configured buffer is not worth a store round trip per keystroke, and
 * it must not survive into a project file — reopening a project with a pending
 * "erase" already selected would be an invitation to click Apply on the wrong
 * dataset. It resets when the selected file changes.
 */
const panel: PanelState = {
  itemId: null,
  layer: '',
  operation: 'buffer',
  distance: '',
  field: '',
  maskLayer: '',
  cut: '',
  toNewLayer: true,
  outputLayer: '',
};

function reset(item: QueueItem, layers: string[]): void {
  panel.itemId = item.id;
  panel.layer = layers[0] ?? '';
  panel.operation = 'buffer';
  panel.distance = '';
  panel.field = '';
  panel.maskLayer = layers.find((name) => name !== panel.layer) ?? '';
  panel.cut = '';
  panel.toNewLayer = true;
  panel.outputLayer = '';
}

/** The default name for a derived layer: readable, and unlikely to collide. */
function defaultOutputName(): string {
  return `${panel.layer} ${GEOMETRY_LABEL[panel.operation].toLowerCase()}`;
}

/** "12,4 40,4 40,60" → positions. Refused rather than guessed at if it does not parse. */
function parseCut(text: string): { positions: Position[]; problem?: string } {
  const tokens = text.trim().split(/[\s;]+/).filter(Boolean);
  if (tokens.length === 0) return { positions: [], problem: 'Enter at least two points.' };

  const positions: Position[] = [];
  for (const token of tokens) {
    const parts = token.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { positions: [], problem: `"${token}" is not an x,y pair.` };
    }
    positions.push([x, y]);
  }
  if (positions.length < 2) return { positions: [], problem: 'A cut needs at least two points.' };
  return { positions };
}

/** The options the current panel state describes, ready for the planner. */
function optionsFrom(): { options: StoredGeometryOptions; problem?: string } {
  const options: StoredGeometryOptions = {};

  if (NEEDS_DISTANCE.has(panel.operation)) {
    const distance = Number(panel.distance);
    if (panel.distance.trim() === '' || !Number.isFinite(distance)) {
      return { options, problem: 'Enter a distance in the dataset’s units.' };
    }
    options.distance = distance;
  }
  if (panel.operation === 'dissolve' && panel.field) options.field = panel.field;
  if (NEEDS_MASK.has(panel.operation)) {
    if (!panel.maskLayer) return { options, problem: 'Choose the layer to use as the mask.' };
    options.maskLayer = panel.maskLayer;
  }
  if (NEEDS_CUT.has(panel.operation)) {
    const cut = parseCut(panel.cut);
    if (cut.problem) return { options, problem: cut.problem };
    options.cut = cut.positions;
  }
  if (panel.toNewLayer) options.outputLayer = panel.outputLayer.trim() || defaultOutputName();

  return { options };
}

/** Total polygonal area of a feature list, for the before-and-after readout. */
function areaOf(features: CirFeature[]): number {
  let total = 0;
  for (const feature of features) {
    for (const rings of toMultiPolygon(feature.geometry)) {
      total += Math.abs(signedArea(rings[0]));
      for (let index = 1; index < rings.length; index++) total -= Math.abs(signedArea(rings[index]));
    }
  }
  return total;
}

/** The plan for the current panel state, or the reason there is not one yet. */
function currentPlan(item: QueueItem): { plan?: GeometryPlan; options?: StoredGeometryOptions; problem?: string } {
  const data = datasetForTools(item);
  if (!panel.layer) return { problem: 'Choose a layer.' };

  const { options, problem } = optionsFrom();
  if (problem) return { problem };

  const plan = planGeometryOperation(data, panel.layer, panel.operation, {
    ...options,
    protectedLayers: protectedFor(item),
    crs: item.dataset?.crs ?? null,
  });
  return { plan, options };
}

export function geometryOpsTab(item: QueueItem): HTMLElement[] {
  const data = datasetForTools(item);
  const layerNames: string[] = data.layers.map((layer: any) => layer.name);

  if (layerNames.length === 0) {
    return [element('p', { class: 'muted', style: 'padding:16px', text: 'This file has no layers to operate on.' })];
  }
  if (panel.itemId !== item.id || !layerNames.includes(panel.layer)) reset(item, layerNames);

  const nodes: HTMLElement[] = [];
  const form = element('div', { class: 'stack', style: 'padding:12px' });

  // --- what to operate on ------------------------------------------------
  form.append(
    labelled(
      'Layer',
      select(layerNames.map((name) => ({ value: name, label: name })), panel.layer, (value) => {
        panel.layer = value;
        panel.outputLayer = '';
        host.renderInspector();
      })
    )
  );

  const operationSelect = element('select', { class: 'select', 'aria-label': 'Operation' }) as HTMLSelectElement;
  for (const group of GROUPS) {
    const optgroup = element('optgroup') as HTMLOptGroupElement;
    optgroup.label = group.label;
    for (const operation of group.operations) {
      const option = element('option', { value: operation, text: GEOMETRY_LABEL[operation] });
      if (operation === panel.operation) option.setAttribute('selected', 'selected');
      optgroup.append(option);
    }
    operationSelect.append(optgroup);
  }
  operationSelect.addEventListener('change', () => {
    panel.operation = operationSelect.value as GeometryOperation;
    panel.outputLayer = '';
    host.renderInspector();
  });
  form.append(labelled('Operation', operationSelect));
  form.append(element('p', { class: 'small muted', text: HINT[panel.operation] }));

  // --- parameters --------------------------------------------------------
  if (NEEDS_DISTANCE.has(panel.operation)) {
    const crs = item.dataset?.crs ?? null;
    form.append(
      labelled(
        'Distance',
        input('text', panel.distance, (value) => {
          panel.distance = value;
          host.renderInspector();
        }),
        crs
          ? `In the units of ${crsLabel(crs)}.`
          : 'This dataset declares no CRS, so the operation will be refused until one is set in the CRS tab.'
      )
    );
  }

  if (panel.operation === 'dissolve') {
    const layer = data.layers.find((candidate: any) => candidate.name === panel.layer);
    const fields: string[] = (layer?.fields ?? []).map((field: any) => field.name);
    form.append(
      labelled(
        'Merge features sharing',
        select(
          [{ value: '', label: 'everything into one' }, ...fields.map((name) => ({ value: name, label: name }))],
          panel.field,
          (value) => {
            panel.field = value;
            host.renderInspector();
          }
        )
      )
    );
  }

  if (NEEDS_MASK.has(panel.operation)) {
    const others = layerNames.filter((name) => name !== panel.layer);
    if (others.length === 0) {
      form.append(
        messageBlock(
          'warn',
          `${GEOMETRY_LABEL[panel.operation]} needs a second layer.`,
          'This file has only one layer, and a layer cannot mask itself.',
          'Convert the boundary into this file first, or use a different operation.'
        )
      );
    } else {
      form.append(
        labelled(
          'Masking layer',
          select(others.map((name) => ({ value: name, label: name })), panel.maskLayer, (value) => {
            panel.maskLayer = value;
            host.renderInspector();
          })
        )
      );
    }
  }

  if (NEEDS_CUT.has(panel.operation)) {
    form.append(
      labelled(
        'Cut line',
        input('text', panel.cut, (value) => {
          panel.cut = value;
          host.renderInspector();
        }),
        'Points as x,y separated by spaces — for example "0,50 100,50". In the dataset’s own coordinates.'
      )
    );
  }

  // --- where the result goes --------------------------------------------
  const destination = element('div', { class: 'stack' });
  const toNew = element('label', { class: 'check' });
  const toNewBox = element('input', { type: 'checkbox' }) as HTMLInputElement;
  toNewBox.checked = panel.toNewLayer;
  toNewBox.addEventListener('change', () => {
    panel.toNewLayer = toNewBox.checked;
    host.renderInspector();
  });
  toNew.append(toNewBox, element('span', { text: 'Write the result to a new layer' }));
  destination.append(toNew);

  if (panel.toNewLayer) {
    destination.append(
      labelled(
        'New layer name',
        input('text', panel.outputLayer || defaultOutputName(), (value) => {
          panel.outputLayer = value;
        })
      )
    );
  } else {
    destination.append(
      messageBlock(
        'warn',
        `The result will REPLACE the geometry of "${panel.layer}".`,
        'The original geometry is kept only in the operation history for this session.',
        'Leave "write to a new layer" ticked unless you mean to overwrite.'
      )
    );
  }
  form.append(destination);
  nodes.push(form);

  // --- the plan ----------------------------------------------------------
  const { plan, options, problem } = currentPlan(item);

  if (problem) {
    nodes.push(element('p', { class: 'small muted', style: 'padding:0 12px 12px', text: problem }));
  } else if (plan?.refusal) {
    nodes.push(messageBlock('warn', plan.refusal.what, plan.refusal.why, plan.refusal.action));
  } else if (plan) {
    const layer = data.layers.find((candidate: any) => candidate.name === panel.layer);
    const before = areaOf(layer?.features ?? []);
    const after = areaOf(plan.features);

    const summary = element('div', { class: 'msg msg--info', style: 'margin:0 12px' });
    const bodyText = element('div', { class: 'msg__body' });
    bodyText.append(element('div', { text: describeGeometryPlan(plan) }));
    if (before > 0 || after > 0) {
      const change = before > 0 ? ((after - before) / before) * 100 : 0;
      bodyText.append(
        element('div', {
          class: 'small',
          text: `Area ${before.toLocaleString(undefined, { maximumFractionDigits: 2 })} → ${after.toLocaleString(undefined, { maximumFractionDigits: 2 })}${
            before > 0 ? ` (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)` : ''
          }`,
        })
      );
    }
    const truncated = truncationOf(item, panel.layer);
    if (truncated) {
      bodyText.append(
        element('p', {
          class: 'small',
          text: `Planned against the ${truncated.shown.toLocaleString()} features loaded here. On conversion it is re-planned against all ${truncated.total.toLocaleString()}, so the result you see is a sample of the shape, not the final feature count.`,
        })
      );
    }
    summary.append(element('span', { class: 'msg__icon', text: 'i' }), bodyText);
    nodes.push(summary);

    const actions = element('div', { class: 'row', style: 'padding:12px' });
    const apply = element('button', {
      class: 'btn btn--primary',
      text: `Apply ${GEOMETRY_LABEL[plan.operation].toLowerCase()}`,
    }) as HTMLButtonElement;
    apply.addEventListener('click', () => {
      queueEdit(
        item,
        { kind: 'geometry', layer: panel.layer, operation: panel.operation, options: options ?? {} },
        plan,
        `${GEOMETRY_LABEL[panel.operation]} on ${panel.layer}`
      );
    });
    actions.append(apply);
    actions.append(
      ghostButton('Clear', () => {
        reset(item, layerNames);
        host.renderInspector();
      })
    );
    nodes.push(actions);
  }

  if ((item.edits ?? []).length > 0) nodes.push(pendingEditsPanel(item, item.edits ?? []));
  return nodes;
}

/**
 * Draws the planned result over the source on the preview canvas.
 *
 * Called by the shell after `renderPreview`, so the plan sits on top of the
 * data it was computed from. A number cannot tell a dissolve on the right field
 * from one on the wrong field; the outline can.
 */
export function geometryPlanOverlay(item: QueueItem): ((context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }) => void) | undefined {
  if (panel.itemId !== item.id) return undefined;
  const { plan } = currentPlan(item);
  if (!plan || plan.refusal || plan.features.length === 0) return undefined;

  return (context, project) => {
    context.save();
    context.strokeStyle = '#f5b041';
    context.fillStyle = 'rgba(245, 176, 65, 0.18)';
    context.lineWidth = 2;
    for (const feature of plan.features) drawGeometry(context, project, feature.geometry);
    context.restore();
  };
}

function drawGeometry(
  context: CanvasRenderingContext2D,
  project: (x: number, y: number) => { x: number; y: number },
  geometry: CirGeometry | null
): void {
  if (!geometry) return;

  const ring = (positions: Position[], close: boolean): void => {
    if (positions.length === 0) return;
    context.beginPath();
    positions.forEach((position, index) => {
      const point = project(position[0], position[1]);
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    if (close) {
      context.closePath();
      context.fill();
    }
    context.stroke();
  };

  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint': {
      const points = geometry.type === 'Point' ? [geometry.coordinates as Position] : (geometry.coordinates as Position[]);
      for (const position of points) {
        const point = project(position[0], position[1]);
        context.beginPath();
        context.arc(point.x, point.y, 4, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      return;
    }
    case 'LineString':
      ring(geometry.coordinates as Position[], false);
      return;
    case 'MultiLineString':
      for (const line of geometry.coordinates as Position[][]) ring(line, false);
      return;
    case 'Polygon':
      for (const part of geometry.coordinates as Position[][]) ring(part, true);
      return;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates as Position[][][]) for (const part of polygon) ring(part, true);
      return;
    case 'GeometryCollection':
      for (const child of geometry.geometries ?? []) drawGeometry(context, project, child);
      return;
    default:
      return;
  }
}

// ------------------------------------------------------------------ controls

function labelled(text: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = element('label', { class: 'field' });
  row.append(element('span', { class: 'field__label', text }));
  row.append(control);
  if (hint) row.append(element('span', { class: 'field__hint', text: hint }));
  return row;
}

function select(
  options: { value: string; label: string }[],
  current: string,
  onChange: (value: string) => void
): HTMLSelectElement {
  const node = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const option of options) {
    const child = element('option', { value: option.value, text: option.label });
    if (option.value === current) child.setAttribute('selected', 'selected');
    node.append(child);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function input(type: string, value: string, onChange: (value: string) => void): HTMLInputElement {
  const node = element('input', { class: 'input', type, value }) as HTMLInputElement;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}
