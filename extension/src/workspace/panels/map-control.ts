/**
 * The basemap control and the source credits, both ON THE CANVAS.
 *
 * WHY THEY MOVED HERE
 *
 * The basemap was reachable only through the Place ribbon family, then the
 * Backdrop panel, then a section three controls down — four actions to turn on
 * a layer whose entire purpose is to be switched on and off while you look at
 * the drawing. Every map application in existence puts this in the corner of
 * the map, and for the same reason: the decision is about what you are looking
 * at, so it belongs where you are looking.
 *
 *   "Give the base map button on the canvas only so that user can easily
 *    excess it and right bottom of canvas add all api which are required and
 *    open sources"
 *
 * So: the control bottom-LEFT, beside the readout and the badges that already
 * live there, and the credits bottom-RIGHT, which is where every map on the
 * web puts them and where this one already draws its one-line attribution.
 *
 * WHY THE SETTINGS PANEL IS NOT DELETED
 *
 * Two different jobs. This is the switch — on, off, which layer, how strong —
 * used constantly and needing no explanation. The settings section is where the
 * key-bearing presets are entered, where a custom URL is validated, and where
 * the privacy and connectivity consequences are written out at length. Pushing
 * a URL-template validator into a canvas popover would make the popover worse
 * without making the settings page unnecessary. Both read and write the same
 * settings, so neither can drift from the other.
 *
 * WHAT "ALL API WHICH ARE REQUIRED AND OPEN SOURCES" MEANS HERE
 *
 * Two obligations, one panel. The open tile services REQUIRE attribution as a
 * licence condition — OpenStreetMap under ODbL, Carto, Esri, OpenTopoMap under
 * CC-BY-SA — and meeting that is not optional. And a user choosing a layer
 * deserves to know, before they pick it, which sources need an account and
 * which do not. So the panel lists every source the tool can reach, what it is
 * licensed under, and whether it needs a key — not only the one currently on.
 */

import { store } from '../../state/store';
import { element } from '../dom';
import { host } from '../host';
import { ui } from '../ui-state';
import {
  RELIEF_PROVIDERS,
  TILE_PRESETS,
  TILE_PROVIDERS,
  isOnline,
  type TileProvider,
} from '../../ui/basemap';
import { TERRAIN_SOURCE } from '../../ui/terrain';

/** The popover, when one is up. Only ever one. */
let open: HTMLElement | null = null;

/**
 * How the open popover is taken down, INCLUDING its window listeners.
 *
 * THE DEFECT THIS EXISTS TO FIX. `closeMapMenu` used to remove the element and
 * null the handle, and nothing else. The `pointerdown` and `keydown` capture
 * listeners were removed only inside `dismiss` itself — which never runs when
 * the popover is closed any other way, and the commonest way is the button
 * toggling it shut.
 *
 * Measured over five open/close cycles: `pointerdown` on window went 0 → 5 and
 * `keydown` 3 → 8. Unbounded over a working session, and every stale closure
 * pins a detached DOM node.
 *
 * The leak was the smaller half. Each stale `dismiss` still closed over the OLD
 * menu element, so on the next open a click INSIDE the new popover was not
 * inside the old one — and the stale handler called `closeMapMenu()` and took
 * the new popover down. After one use the control shut itself the moment you
 * touched it: measured `openedOk: true, stillOpen: false` on a click on its own
 * title.
 *
 * So teardown belongs to the thing that owns the popover, and every close goes
 * through it.
 */
let teardown: (() => void) | null = null;

export function closeMapMenu(): void {
  teardown?.();
  teardown = null;
  open?.remove();
  open = null;
}

/** The provider currently drawing, for the button's own label. */
function activeProviderName(providerId: string, customUrl: string): string {
  if (providerId === 'custom') {
    const preset = TILE_PRESETS.find((entry) => customUrl.includes(entry.template.split('{z}')[0]));
    return preset ? preset.name : 'Custom tiles';
  }
  return TILE_PROVIDERS.find((entry) => entry.id === providerId)?.name ?? 'OpenStreetMap';
}

// ------------------------------------------------------------ the control

/**
 * Builds the bottom-left basemap button, and keeps its label current.
 *
 * Called from the canvas render path rather than once at boot, because the
 * label states what is on and that changes from the popover, from the settings
 * panel, and from a restored project.
 */
export function renderMapControl(): void {
  // Reachable from the canvas render path, which is exercised in a plain Node
  // runner with no DOM. Nothing here is meaningful without one.
  if (typeof document === 'undefined') return;
  const mount = document.getElementById('basemapControl');
  if (!mount) return;
  const settings = store.get().settings;

  mount.replaceChildren();

  const button = element('button', {
    class: `mapctl__btn${settings.basemapEnabled ? ' mapctl__btn--on' : ''}`,
    type: 'button',
    'aria-haspopup': 'dialog',
    title: settings.basemapEnabled
      ? `Basemap on — ${activeProviderName(settings.basemapProviderId, settings.basemapCustomUrl)}. Choose a layer, relief or opacity.`
      : 'Map tiles behind your data. Off by default: switching it on is the only thing here that uses a network.',
  }) as HTMLButtonElement;

  // An icon plus a word. The icon alone would be a guess at a narrow width, and
  // the word alone loses the button in a row of badges.
  button.append(element('span', { class: 'mapctl__icon', text: '▦', 'aria-hidden': 'true' }));
  button.append(
    element('span', {
      class: 'mapctl__label',
      text: settings.basemapEnabled ? activeProviderName(settings.basemapProviderId, settings.basemapCustomUrl) : 'Basemap',
    })
  );

  // ANCHORED TO THE MOUNT, NOT TO THE BUTTON. `renderMapControl` replaces the
  // button on every render, and a rebuilt popover re-measures its anchor — a
  // detached node reports a zero rectangle, which would fling the popover into
  // the top-left corner the moment any switch inside it was used. The mount
  // survives every render and has the same geometry.
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) {
      closeMapMenu();
      return;
    }
    openMapMenu(mount);
  });

  mount.append(button);
}

/** One labelled row of the popover. */
function row(label: string, control: HTMLElement, note?: string): HTMLElement {
  const wrap = element('label', { class: 'mapmenu__row' });
  wrap.append(control);
  const text = element('span', { class: 'mapmenu__rowtext' });
  text.append(element('span', { class: 'mapmenu__rowlabel', text: label }));
  if (note) text.append(element('span', { class: 'mapmenu__rownote', text: note }));
  wrap.append(text);
  return wrap;
}

/** A provider choice, as a radio so the exclusivity is the control's own. */
function providerRow(provider: TileProvider, group: string, chosen: boolean, pick: () => void): HTMLElement {
  const input = element('input', { type: 'radio', name: group, class: 'mapmenu__radio' }) as HTMLInputElement;
  input.checked = chosen;
  input.addEventListener('change', () => {
    if (input.checked) pick();
  });
  return row(provider.name, input, provider.note);
}

/**
 * Opens the popover above the button.
 *
 * `fixed` and positioned in script, exactly like the canvas context menu and
 * for the same reason: the stage clips its overflow, so a popover laid out
 * inside it would be cut off at the canvas edge.
 */
function openMapMenu(anchor: HTMLElement): void {
  closeMapMenu();
  const menu = element('div', { class: 'mapmenu', role: 'dialog', 'aria-label': 'Basemap' });
  document.body.append(menu);
  open = menu;
  fillMapMenu(menu, anchor);
  watchForDismissal(menu, anchor);
}

/**
 * Fills the popover with what the current settings say, and places it.
 *
 * Separate from opening it because several of these switches CHANGE WHAT THE
 * POPOVER SHOWS: turning tiles on reveals the layer list, turning relief on
 * reveals which relief layer. Built once at open, those choices appeared only
 * after closing and reopening — a control that looks like it did nothing. So
 * every handler that alters the menu's own shape rebuilds it in place.
 */
function fillMapMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const settings = store.get().settings;
  /** Re-render this popover, for a switch that changes what is below it. */
  const rebuild = (): void => {
    host.render();
    // `open` is checked rather than assumed: `host.render()` can close this.
    if (open === menu) fillMapMenu(menu, anchor);
  };

  menu.replaceChildren();
  menu.append(element('div', { class: 'mapmenu__title', text: 'Basemap' }));

  // ---- the switch itself
  const toggle = element('input', { type: 'checkbox', class: 'mapmenu__check' }) as HTMLInputElement;
  toggle.checked = settings.basemapEnabled;
  // Rebuilds rather than closes: switching tiles on reveals the layer list, and
  // a popover that shut itself the moment you used it would send you straight
  // back to the button to choose one.
  toggle.addEventListener('change', () => {
    void store.patchSettings({ basemapEnabled: toggle.checked });
    rebuild();
  });
  menu.append(
    row(
      'Show map tiles',
      toggle,
      'Drawn under your data for context. Nothing about it affects a conversion, a measurement or an exported file.'
    )
  );

  if (settings.basemapEnabled) {
    menu.append(element('div', { class: 'mapmenu__sep' }));
    menu.append(element('div', { class: 'mapmenu__head', text: 'Layer' }));
    for (const provider of TILE_PROVIDERS) {
      menu.append(
        providerRow(provider, 'mapmenu-provider', settings.basemapProviderId === provider.id, () => {
          void store.patchSettings({ basemapProviderId: provider.id });
          host.render();
        })
      );
    }
    // The custom entry is a choice here and an editor in Settings: offering the
    // URL field in a popover over the drawing would be a worse place to paste a
    // key into than the panel that explains what happens to it.
    if (settings.basemapCustomUrl.trim()) {
      const input = element('input', { type: 'radio', name: 'mapmenu-provider', class: 'mapmenu__radio' }) as HTMLInputElement;
      input.checked = settings.basemapProviderId === 'custom';
      input.addEventListener('change', () => {
        if (!input.checked) return;
        void store.patchSettings({ basemapProviderId: 'custom' });
        host.render();
      });
      menu.append(row('Your own tile service', input, 'Edited under Settings › Map basemap.'));
    }

    // ---- relief
    menu.append(element('div', { class: 'mapmenu__sep' }));
    menu.append(element('div', { class: 'mapmenu__head', text: 'Terrain' }));

    const relief = element('input', { type: 'checkbox', class: 'mapmenu__check' }) as HTMLInputElement;
    relief.checked = settings.basemapReliefEnabled;
    // Rebuilds: switching relief on is what reveals WHICH relief layer.
    relief.addEventListener('change', () => {
      void store.patchSettings({ basemapReliefEnabled: relief.checked });
      rebuild();
    });
    menu.append(row('Shaded relief over the map', relief, 'Hillshade from a global elevation model, composited on top.'));

    if (settings.basemapReliefEnabled) {
      for (const provider of RELIEF_PROVIDERS) {
        menu.append(
          providerRow(provider, 'mapmenu-relief', settings.basemapReliefId === provider.id, () => {
            void store.patchSettings({ basemapReliefId: provider.id });
            host.render();
          })
        );
      }
    }

    const readout = element('input', { type: 'checkbox', class: 'mapmenu__check' }) as HTMLInputElement;
    readout.checked = settings.terrainReadout;
    readout.addEventListener('change', () => {
      void store.patchSettings({ terrainReadout: readout.checked });
      host.render();
    });
    menu.append(
      row(
        'Ground elevation under the cursor',
        readout,
        'From open terrain tiles, to about a metre. Orientation only — never a levelled height.'
      )
    );

    // ---- opacity
    menu.append(element('div', { class: 'mapmenu__sep' }));
    const slider = element('input', {
      type: 'range',
      min: '0.1',
      max: '1',
      step: '0.05',
      class: 'mapmenu__range',
    }) as HTMLInputElement;
    slider.value = String(settings.basemapOpacity);
    // `input`, not `change`: dragging a strength slider that only takes effect
    // on release is a slider you cannot judge.
    slider.addEventListener('input', () => {
      void store.patchSettings({ basemapOpacity: Math.min(1, Math.max(0.1, Number(slider.value))) });
      host.render();
    });
    menu.append(row('Strength', slider, 'How loud the map is under your linework.'));
  }

  menu.append(element('div', { class: 'mapmenu__sep' }));
  if (!isOnline()) {
    menu.append(
      element('div', {
        class: 'mapmenu__foot',
        text: 'The browser reports no connection. That report is not always right — the badge on the canvas requests the tiles anyway.',
      })
    );
  }
  menu.append(
    element('div', {
      class: 'mapmenu__foot',
      text: 'Tile requests say which map squares are on screen, and nothing else. No file byte, name or attribute leaves this machine on any path.',
    })
  );

  place(menu, anchor);
}

/**
 * Puts the popover above its button, inside the window.
 *
 * Measured after the content is in the DOM, and RE-measured on every rebuild:
 * revealing the layer list makes the popover twice as tall, and a position
 * computed against the old height would hang it off the bottom of the screen.
 */
function place(menu: HTMLElement, anchor: HTMLElement): void {
  const box = menu.getBoundingClientRect();
  const anchorBox = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchorBox.left, window.innerWidth - box.width - 8));
  // Upward: the button is on the bottom edge of the canvas, so downward is off
  // the window. Clamped to 8 so a tall popover on a short screen is still
  // reachable — `max-height` on the class makes it scroll rather than overflow.
  const top = Math.max(8, anchorBox.top - box.height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

/**
 * Dismissal: Escape, or a pointer down anywhere outside.
 *
 * Registers its own removal as `teardown` rather than unhooking inside the
 * handler, so a close by ANY route — the button, Escape, a click outside, a
 * re-render — takes the listeners with it. See `teardown` above for what the
 * old arrangement cost.
 */
function watchForDismissal(menu: HTMLElement, anchor: HTMLElement): void {
  const dismiss = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
    if (event.type === 'pointerdown' && menu.contains(event.target as Node)) return;
    if (event.type === 'pointerdown' && anchor.contains(event.target as Node)) return;
    closeMapMenu();
  };
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('keydown', dismiss, true);
  teardown = () => {
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', dismiss, true);
  };
}

// ------------------------------------------------------------ the credits

/** One source, as the panel lists it. */
interface SourceLine {
  name: string;
  terms: string;
  key: 'none' | 'account';
}

/**
 * Every source this tool can reach, whether or not it is switched on.
 *
 * Built from the same lists the switcher is built from, so a provider added to
 * `basemap.ts` appears here without anyone remembering to add it — which is the
 * failure mode for an attribution list, and an attribution list that silently
 * omits a source is a licence problem rather than a cosmetic one.
 */
export function allSources(): SourceLine[] {
  const lines: SourceLine[] = [];
  for (const provider of [...TILE_PROVIDERS, ...RELIEF_PROVIDERS]) {
    lines.push({ name: provider.name, terms: provider.attribution, key: 'none' });
  }
  lines.push({ name: TERRAIN_SOURCE.name, terms: TERRAIN_SOURCE.attribution, key: 'none' });
  for (const preset of TILE_PRESETS) {
    lines.push({ name: preset.name, terms: preset.attribution, key: 'account' });
  }
  return lines;
}

/**
 * The credit line and the expandable source list, bottom-right of the canvas.
 *
 * The one-line credit for what is ON is also drawn INTO the canvas by
 * `Basemap.drawAttribution`, and that is not a duplicate to be tidied away:
 * the drawn one survives a screenshot of the workspace, which is exactly where
 * the credit is owed and where page chrome does not reach. This one is the
 * interactive half — the full list, with what each is licensed under.
 */
export function renderMapSources(): void {
  if (typeof document === 'undefined') return;
  const mount = document.getElementById('mapSources');
  if (!mount) return;
  const settings = store.get().settings;
  const drawing = settings.basemapEnabled && (ui.basemap?.usable ?? false);

  mount.replaceChildren();
  // Clears the one-line credit the canvas draws in the same corner. Without
  // this the two boxes sit on top of each other whenever tiles are up.
  mount.classList.toggle('mapsources--credited', drawing);

  // AND THE BOTTOM-LEFT CLUSTER CLEARS IT TOO.
  //
  // The credit is right-aligned but a long one — "Imagery © Esri, Maxar,
  // Earthstar Geographics and the GIS User Community" — reaches most of the way
  // across a narrow canvas and passes BEHIND the basemap button, the coordinate
  // readout and the terrain box. Measured at 1600px with both docks open: the
  // overlay occupied y 913–940 against a credit band of 912–928, a 15px
  // overlap. Stacking only the right-hand corner, which is what v1.11.12 did,
  // fixed the half of the problem that was visible in the screenshot I was
  // looking at. A clipped attribution is a licence problem, not a cosmetic one.
  document.querySelector('.preview__overlay')?.classList.toggle('preview__overlay--credited', drawing);

  const toggle = element('button', {
    class: 'mapsources__btn',
    type: 'button',
    'aria-expanded': 'false',
    title: 'Every map and elevation source this tool can use, what it is licensed under, and which need an account.',
    text: 'Sources & APIs',
  }) as HTMLButtonElement;

  const list = element('div', { class: 'mapsources__list hidden' });
  const sources = allSources();

  const open = element('div', { class: 'mapsources__head', text: 'Open, no account needed' });
  list.append(open);
  for (const line of sources.filter((entry) => entry.key === 'none')) {
    const item = element('div', { class: 'mapsources__item' });
    item.append(element('span', { class: 'mapsources__name', text: line.name }));
    item.append(element('span', { class: 'mapsources__terms', text: line.terms }));
    list.append(item);
  }

  list.append(element('div', { class: 'mapsources__head', text: 'Your own API key required' }));
  for (const line of sources.filter((entry) => entry.key === 'account')) {
    const item = element('div', { class: 'mapsources__item' });
    item.append(element('span', { class: 'mapsources__name', text: line.name }));
    item.append(element('span', { class: 'mapsources__terms', text: line.terms }));
    list.append(item);
  }
  list.append(
    element('div', {
      class: 'mapsources__foot',
      // Said here because this is where somebody goes looking for Google, and
      // the answer has to be in the place the question is asked.
      text: 'Key-bearing services are entered under Settings › Map basemap. No key is bundled: shipping one would spend somebody else’s quota on every install, and an extension’s code is readable by everyone who installs it.',
    })
  );
  list.append(
    element('div', {
      class: 'mapsources__foot',
      text: 'A tilted 3D terrain view is not available: this canvas draws your survey in its own CRS, and a 3D renderer would have to reproject it. Shaded relief and the elevation readout give the same information without moving your coordinates.',
    })
  );

  toggle.addEventListener('click', () => {
    const hidden = list.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });

  mount.append(list);
  mount.append(toggle);
}
