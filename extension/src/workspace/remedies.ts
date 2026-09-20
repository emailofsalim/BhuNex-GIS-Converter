/**
 * One-click ways out of a refusal.
 *
 * WHY THIS EXISTS
 *
 * Every `ConversionError` already carries an `action` — a sentence saying what
 * to do about it. That is the right shape when the remedy needs a decision the
 * tool cannot make: "choose the source CRS" has to be prose, because only the
 * surveyor knows which zone the traverse was run in.
 *
 * It is the wrong shape when the remedy is one unambiguous setting. In the
 * trial, a target CRS of EPSG:32645 was set while working on a mining DXF —
 * correctly, that is the site's grid — and then a cadastral KMZ was converted.
 * The target CRS is a GLOBAL setting, so it survived the file swap, and KML
 * stores nothing but WGS 84. The export was refused, rightly, with a sentence
 * beginning "Clear the target CRS to let Google Earth KML use WGS 84" — and the
 * operator, reading a red block in the inspector, pressed Retry. Twice. Retry
 * changes nothing, because nothing about the file was wrong.
 *
 * So where the tool knows exactly which setting is in the way, it offers to
 * change it and run the file again. The prose stays: the button is an
 * additional route, not a replacement for saying what happened.
 *
 * WHAT DOES NOT BELONG HERE
 *
 * A remedy that guesses. `CRS_REQUIRED` has no button, because the only honest
 * fix is a CRS the tool refuses to invent (rule R4). A button that picked one
 * would be the guess, wearing a click.
 */

import { crsLabel } from '../crs/transform';
import { crsFromEpsg } from '../crs/epsg';
import { store } from '../state/store';
import { convertItem } from './conversion';
import type { Remedy } from './dom';
import { host } from './host';

/**
 * The remedy for one failed file, if there is one that needs no judgement.
 *
 * Takes the item id rather than the item so the click re-reads the queue: the
 * button may be pressed a minute after it was built, and acting on a snapshot
 * of a file that has since been removed would convert a ghost.
 */
export function remedyFor(itemId: string, error: { code: string }): Remedy | null {
  switch (error.code) {
    case 'TARGET_CRS_NOT_STORABLE':
      return clearTargetCrsRemedy(itemId);
    default:
      return null;
  }
}

/**
 * Clears the global target CRS, and converts the named file again if there is
 * one.
 *
 * `itemId` is null where nothing has failed yet — the CRS panel's own warning,
 * which is the same problem caught before the conversion rather than after it.
 * There a re-run would convert a file the user has not asked to convert.
 *
 * Returns null when no target CRS is set. On the failure path that means the
 * refusal came from the error's other branch — the source CRS never resolved —
 * and clearing an unset setting would be a button that does nothing.
 */
export function clearTargetCrsRemedy(itemId: string | null): Remedy | null {
  const epsg = store.get().settings.targetCrsEpsg;
  if (!epsg) return null;

  return {
    label: itemId ? `Clear the target CRS (EPSG:${epsg}) and convert again` : `Clear the target CRS (EPSG:${epsg})`,
    hint: `Unsets ${crsLabel(crsFromEpsg(epsg))} as the target CRS for every file${
      itemId ? ', then re-runs this one so the format uses the CRS it stores' : ''
    }.`,
    run: () => {
      void (async () => {
        await store.patchSettings({ targetCrsEpsg: null });
        store.log(
          'info',
          `Target CRS cleared. It was ${crsLabel(crsFromEpsg(epsg))}, and it applied to the whole queue — set it again on the CRS panel if another file needs it.`
        );
        host.render();
        if (itemId) await convertItem(itemId, store.get().settings.runQa);
      })();
    },
  };
}
