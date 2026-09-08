/**
 * What a panel is allowed to ask the shell to do.
 *
 * ---------------------------------------------------------------------------
 * THE CYCLE THIS BREAKS
 *
 * `main.ts` builds the page, so it imports every panel. Every panel changes
 * something and then needs the page redrawn, so it would import `render` back
 * out of `main.ts`. That is a cycle in every direction at once, and while
 * bundlers do resolve cycles of hoisted function declarations, "it happens to
 * work" is not an architecture — the failure mode is a module that initialises
 * half-way and a `undefined is not a function` at the first click.
 *
 * So the direction is inverted. Panels depend on this file, which depends on
 * nothing. `main.ts` fills it in at boot with its own functions. The dependency
 * graph is a DAG and RULE 41 holds: the panels never reach up into the shell.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULTS THROW RATHER THAN DO NOTHING
 *
 * A no-op default turns "the shell was never wired" into a button that silently
 * does nothing — the single hardest class of UI bug to find, because there is
 * no error and the code that failed is not the code that looks wrong. Throwing
 * names the missing wiring at the moment it is needed.
 *
 * Nothing here runs before `main.ts` calls `installHost`, which it does in
 * `boot()` before the first render.
 */

import type { AppSettings } from '../state/store';

export interface WorkspaceHost {
  /** Redraw everything the state affects. The blunt instrument, used most. */
  render(): void;
  /** Redraw the file queue only. */
  renderQueue(): void;
  /** Rebuild the inspector for the selected file. */
  renderInspector(): void;
  /** Switch the inspector to a named tab, e.g. after an action that changes it. */
  showInspectorTab(name: string): void;
  /** Switch the bottom dock to a named tab. */
  showBottomTab(name: string): void;
  /** Re-check whether the native host is reachable, and redraw. */
  refreshNative(): Promise<void>;
  applyTheme(theme: AppSettings['theme']): void;
  /** Opens the project file picker. The input element lives in the shell. */
  openProjectPicker(): void;
}

function notWired(what: string): never {
  throw new Error(
    `The workspace shell has not been wired yet, so ${what}() cannot run. ` +
      'main.ts calls installHost() in boot(); a panel reached the host before that happened.'
  );
}

export const host: WorkspaceHost = {
  render: () => notWired('render'),
  renderQueue: () => notWired('renderQueue'),
  renderInspector: () => notWired('renderInspector'),
  showInspectorTab: () => notWired('showInspectorTab'),
  showBottomTab: () => notWired('showBottomTab'),
  refreshNative: () => notWired('refreshNative'),
  applyTheme: () => notWired('applyTheme'),
  openProjectPicker: () => notWired('openProjectPicker'),
};

/** Called once by `main.ts`, before the first render. */
export function installHost(implementation: Partial<WorkspaceHost>): void {
  Object.assign(host, implementation);
}
