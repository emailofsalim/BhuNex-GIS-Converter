/**
 * One collapse mechanism for the whole workspace.
 *
 * Layers had a toggle. Nothing else did — so a long panel like Georeference
 * pushed Convert off the bottom of the dock, and the only way to reach past a
 * section you were not using was to scroll through it. Files and Output could
 * not be folded away at all.
 *
 * WHY THIS IS ONE MODULE AND NOT A TOGGLE PER PANEL
 *
 * Every panel in this workspace already builds its blocks the same way: a
 * `.section` wrapper with a `.section__title` heading. That shared shape is
 * worth more than three bespoke buttons — a delegated handler on the heading
 * makes EVERY section in the app collapsible, including ones written later,
 * with no call site to remember. A per-panel toggle would have to be added by
 * hand each time, and the one nobody added is the one that traps the user.
 *
 * WHY A MutationObserver
 *
 * Panels rebuild their DOM on every render, which throws away any class set on
 * the previous copy. Re-applying from the render cycle would need every panel
 * to call something, which is the coupling this module exists to avoid. The
 * observer re-applies the remembered state to whatever appears, so a section
 * the user folded stays folded across a re-render, a file change and a reload.
 */

/**
 * A NEW KEY, because the meaning of what is stored has been inverted.
 *
 * The old `bhunex.collapsed` listed the sections the user had FOLDED, on the
 * understanding that everything else was open. This now stores the opposite —
 * the sections they have OPENED — so reading the old list under the new rule
 * would make the few sections someone had deliberately folded the only ones
 * still showing, and hide everything they actually used. A different key lets
 * the old value sit there harmlessly.
 */
const STORAGE_KEY = 'bhunex.opened';

/**
 * Which sections the user has OPENED, by their heading text.
 *
 * FOLDED IS THE DEFAULT. Everything starts shut — layers, settings, every
 * `.section` in every panel — and opens only where the user has asked for it.
 * The workspace grew to fourteen panels and forty-odd sections, and defaulting
 * them all open meant the first thing a new file showed was a wall of controls
 * with the drawing squeezed between them. A section the user has never touched
 * is a section they have not asked to see.
 *
 * Keyed by the TITLE rather than by position, because a panel's sections are
 * rebuilt in whatever order the data needs and an index would open the wrong
 * one. Titles are short, stable and unique within a panel.
 */
/**
 * The two that start open, because without them the workspace looks broken.
 *
 * Everything else — every `.section` in every panel, the layer rail, the
 * settings groups — starts folded. These do not, and the distinction is not
 * arbitrary: they are not content, they are the frame. The file queue is how
 * you see what is loaded; the format list is the choice every conversion turns
 * on; and the dock's section box is what a ribbon tab fills, so folding it by
 * default would mean clicking "Data › CRS" and being shown a closed bar. Asking
 * for a section IS asking to see it. Its contents still start folded, which is
 * where the decluttering actually belongs.
 *
 * A user who folds either still gets their preference remembered — this decides
 * only what happens before anyone has expressed one.
 */
const DEFAULT_OPEN = ['files', 'output formats', 'section'];

/**
 * Seeded ONLY on a first run, never merged on every load.
 *
 * Merging the defaults in each time would mean folding Files sprang it open
 * again on the next reload: the saved list would lack it, the merge would put
 * it back, and the user's choice would be silently overruled by the default
 * that was meant to apply before they had one. So a MISSING stored value seeds
 * the defaults and writes them; a stored value, even an empty list, is taken
 * exactly as it is.
 */
const stored = load();
const opened = new Set<string>(stored ?? DEFAULT_OPEN);
if (stored === null) save();

/** The stored list, or null when nothing has ever been stored. */
function load(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    // A private window, or storage the browser has blocked. Folding is a
    // convenience: losing it must never stop the workspace booting. Treated as
    // a first run, so the defaults apply and nothing throws.
    return null;
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...opened]));
  } catch {
    /* As above: not worth a broken workspace. */
  }
}

/** The remembered key for a section: its heading, trimmed and case-folded. */
function keyOf(title: Element): string {
  return (title.textContent ?? '').trim().toLowerCase();
}

/**
 * The Element an event happened on, or null when it was not an Element at all.
 *
 * Exported because this one line is the whole bug, and it is worth a test that
 * does not need a DOM to run.
 *
 * `event.target` is typed `EventTarget`. A keydown dispatched at the document,
 * or arriving with nothing focused, has a DOCUMENT as its target, and a
 * Document has no `closest`. Written the obvious way —
 *
 *     (event.target as HTMLElement | null)?.closest(...)
 *
 * — the `?.` guards a null target and does nothing whatever about a target of
 * the wrong kind, so the call throws. A listener bound to the document that
 * throws takes every branch below it with it: the same mistake in the keyboard
 * handler meant one such keystroke silently ran no shortcut at all.
 */
export function elementFrom(target: unknown): Element | null {
  // `instanceof Element` rather than a duck-type check on `closest`, so a plain
  // object that happens to carry the method cannot slip through.
  if (typeof Element !== 'undefined' && target instanceof Element) return target;
  return null;
}

/**
 * True when this section is folded — which, never having been opened, it is.
 *
 * Exported so a test can read the state without a DOM.
 */
export function isCollapsed(title: string): boolean {
  return !opened.has(title.trim().toLowerCase());
}

/** Folds or unfolds one section, and remembers which. */
export function setCollapsed(title: string, collapse: boolean): void {
  const key = title.trim().toLowerCase();
  if (collapse) opened.delete(key);
  else opened.add(key);
  save();
}

/** Applies the remembered state to one section element. */
function apply(section: Element): void {
  const title = section.querySelector(':scope > .section__title');
  if (!title) return;
  const folded = !opened.has(keyOf(title));
  section.classList.toggle('section--closed', folded);
  title.setAttribute('aria-expanded', String(!folded));
  // The heading IS the control, so it has to say so to a keyboard and to a
  // screen reader — a div that only responds to a mouse is not a button.
  if (!title.hasAttribute('role')) {
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
  }
}

/** Applies the remembered state everywhere it is relevant, now. */
export function applyAll(root: ParentNode = document): void {
  for (const section of Array.from(root.querySelectorAll('.section'))) apply(section);
}

/**
 * Starts the one mechanism. Called once, from boot.
 *
 * `root` is the element to watch; everything inside it becomes collapsible as
 * it appears.
 */
export function installCollapse(root: ParentNode = document): void {
  // THE HEADINGS. Delegated, so a section built after this runs still works.
  const toggle = (event: Event): void => {
    // `event.target` is not always an Element. A keydown dispatched at the
    // document, or one landing on a text node, has no `closest` at all — which
    // threw "target?.closest is not a function" on every such event, from a
    // listener bound to the whole document. `?.closest?.()` swallowed the
    // missing METHOD but nothing swallowed calling it on a Document.
    const title = elementFrom(event.target)?.closest('.section__title');
    if (!title) return;
    const section = title.closest('.section');
    if (!section) return;
    setCollapsed(keyOf(title), !section.classList.contains('section--closed'));
    apply(section);
  };
  (root as unknown as HTMLElement).addEventListener?.('click', toggle);
  (root as unknown as HTMLElement).addEventListener?.('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    // Same guard as above, and for the same reason.
    const title = elementFrom(event.target)?.closest('.section__title');
    if (!title) return;
    event.preventDefault();
    toggle(event);
  });

  applyAll(root);

  // Panels rebuild on every render; re-apply to whatever turns up.
  if (typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('section')) apply(node);
        else applyAll(node);
      }
    }
  });
  observer.observe(root as Node, { childList: true, subtree: true });
}

/**
 * Makes a pane fold: a head, the body it owns, and a key to remember it by.
 *
 * Used for the three that are not `.section` blocks — Files, Layers and Output
 * — so those fold with the same click, the same arrow and the same memory as
 * everything else rather than by three different means.
 */
export function makeCollapsible(head: HTMLElement | null, body: HTMLElement | null, key: string): void {
  if (!head || !body) return;
  if (head.querySelector(':scope > .pane__fold')) return; // already wired

  const arrow = document.createElement('button');
  arrow.className = 'iconbtn pane__fold';
  arrow.type = 'button';
  arrow.setAttribute('aria-label', `Show or hide ${key}`);

  const paint = (): void => {
    const folded = isCollapsed(key);
    body.classList.toggle('pane--closed', folded);
    arrow.textContent = folded ? '▸' : '▾';
    arrow.title = folded ? `Show ${key}` : `Hide ${key}`;
    arrow.setAttribute('aria-expanded', String(!folded));
  };

  arrow.addEventListener('click', () => {
    setCollapsed(key, !isCollapsed(key));
    paint();
  });

  head.append(arrow);
  paint();
}
