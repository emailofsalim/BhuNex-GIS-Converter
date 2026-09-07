/**
 * Command palette (spec §31.5, rule R24).
 *
 * The palette is what makes rule R24 workable. The main screen has to stay
 * minimal, and this tool now has a great deal in it — polygonisation, burn-in,
 * defect scanning, presets, CRS selection, twelve output formats. Putting all of
 * that on the surface would produce the crowded toolbar the master document
 * explicitly forbids; hiding it in menus would make it undiscoverable. A
 * searchable palette is how both constraints are satisfied at once.
 *
 * The matching is the part worth getting right. A palette that only does
 * substring matching fails the moment someone types what they *mean* rather
 * than what the command is called — "kmz" should find "Convert to KMZ", "burn"
 * should find "Attach text to polygons", "epsg" should find the CRS picker. So
 * every command carries keywords, and the score favours a prefix over a
 * substring and a title match over a keyword match, which is what makes the
 * first result usually the right one.
 */

export interface Command {
  id: string;
  title: string;
  /** Where it belongs, shown as a dim prefix in the list. */
  group: string;
  /**
   * Words someone might type instead of the title.
   *
   * These are what turn a palette from a list you scroll into one you type at.
   */
  keywords: string[];
  /** One line explaining what running it does. */
  detail?: string;
  /** Keyboard shortcut, when there is one. */
  shortcut?: string;
  /** False when the command cannot run right now, with `disabledReason` set. */
  enabled?: boolean;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

export interface CommandMatch {
  command: Command;
  score: number;
  /** Character indices in the title that matched, for highlighting. */
  highlights: number[];
}

/**
 * Scores one command against a query.
 *
 * Returns null when it does not match at all. The score is ordered so that:
 *   title prefix  >  title word start  >  title substring  >  keyword  >  fuzzy
 * which matches how people expect a palette to behave — typing "sha" should put
 * "Shapefile" first, not "Attach text" because it happens to contain s-h-a.
 */
export function scoreCommand(command: Command, query: string): CommandMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { command, score: 0, highlights: [] };

  const title = command.title.toLowerCase();

  if (title.startsWith(needle)) {
    return { command, score: 1000, highlights: range(0, needle.length) };
  }

  // A match at the start of any word: "struct" finding "Output structure".
  const wordStart = findWordStart(title, needle);
  if (wordStart >= 0) {
    return { command, score: 800 - wordStart, highlights: range(wordStart, wordStart + needle.length) };
  }

  const substring = title.indexOf(needle);
  if (substring >= 0) {
    return { command, score: 600 - substring, highlights: range(substring, substring + needle.length) };
  }

  for (const keyword of command.keywords) {
    const lower = keyword.toLowerCase();
    if (lower.startsWith(needle)) return { command, score: 400, highlights: [] };
    if (lower.includes(needle)) return { command, score: 300, highlights: [] };
  }

  if (command.group.toLowerCase().includes(needle)) return { command, score: 200, highlights: [] };

  // Fuzzy, last: every character of the query in order somewhere in the title.
  // Useful for "cdxf" → "Cadastral DXF", useless if it outranks anything real.
  const fuzzy = fuzzyMatch(title, needle);
  if (fuzzy) return { command, score: 100 - fuzzy.gaps, highlights: fuzzy.indices };

  return null;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let index = from; index < to; index++) out.push(index);
  return out;
}

function findWordStart(haystack: string, needle: string): number {
  let at = haystack.indexOf(needle);
  while (at > 0) {
    const before = haystack[at - 1];
    if (before === ' ' || before === '-' || before === '/' || before === '(') return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return at === 0 ? 0 : -1;
}

function fuzzyMatch(haystack: string, needle: string): { indices: number[]; gaps: number } | null {
  const indices: number[] = [];
  let at = 0;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return null;
    if (indices.length > 0 && found > at) gaps++;
    indices.push(found);
    at = found + 1;
  }
  return { indices, gaps };
}

/**
 * Ranks every command for a query.
 *
 * Disabled commands are kept rather than filtered out, ranked below the enabled
 * ones. Someone searching for a command that exists but cannot run right now
 * needs to be told *why* — a palette that simply omits it looks broken, and the
 * user retypes the same query expecting a different result.
 */
export function searchCommands(commands: Command[], query: string, limit = 20): CommandMatch[] {
  const matches: CommandMatch[] = [];
  for (const command of commands) {
    const match = scoreCommand(command, query);
    if (!match) continue;
    matches.push(command.enabled === false ? { ...match, score: match.score - 10000 } : match);
  }
  return matches
    .sort((left, right) => right.score - left.score || left.command.title.localeCompare(right.command.title))
    .slice(0, limit);
}

export interface PaletteHost {
  /** Called when a command is chosen. */
  onRun: (command: Command) => void;
  /** Called when the palette closes without running anything. */
  onClose?: () => void;
}

/**
 * A minimal, framework-free palette over a `<dialog>`.
 *
 * Keyboard behaviour follows what every palette does, because muscle memory is
 * the whole point: type to filter, arrow keys to move, Enter to run, Escape to
 * close. Nothing here is novel and that is deliberate.
 */
export class CommandPalette {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private commands: Command[] = [];
  private matches: CommandMatch[] = [];
  private active = 0;

  constructor(
    dialog: HTMLDialogElement,
    private readonly host: PaletteHost
  ) {
    this.dialog = dialog;
    this.dialog.replaceChildren();
    this.dialog.className = 'dialog palette';

    const wrap = document.createElement('div');
    wrap.className = 'palette__wrap';

    this.input = document.createElement('input');
    this.input.className = 'palette__input';
    this.input.type = 'search';
    this.input.placeholder = 'Type a command…';
    this.input.setAttribute('aria-label', 'Search commands');
    wrap.append(this.input);

    this.list = document.createElement('div');
    this.list.className = 'palette__list';
    this.list.setAttribute('role', 'listbox');
    wrap.append(this.list);

    const hint = document.createElement('p');
    hint.className = 'palette__hint';
    hint.textContent = '↑↓ to move · Enter to run · Esc to close';
    wrap.append(hint);

    this.dialog.append(wrap);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.dialog.addEventListener('close', () => this.host.onClose?.());
    // Clicking the backdrop closes it, which is what the rest of the app's
    // dialogs do.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
  }

  open(commands: Command[]): void {
    this.commands = commands;
    this.input.value = '';
    this.active = 0;
    this.refresh();
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  private onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.active = Math.min(this.active + 1, this.matches.length - 1);
        this.render();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.active = Math.max(this.active - 1, 0);
        this.render();
        break;
      case 'Enter': {
        event.preventDefault();
        const match = this.matches[this.active];
        // A disabled command must not run silently on Enter; the reason is
        // already visible beside it.
        if (match && match.command.enabled !== false) {
          this.dialog.close();
          this.host.onRun(match.command);
        }
        break;
      }
      case 'Escape':
        // The dialog closes itself; nothing else to do.
        break;
      default:
        break;
    }
  }

  private refresh(): void {
    this.matches = searchCommands(this.commands, this.input.value);
    this.active = 0;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    if (this.matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'palette__empty';
      empty.textContent = `No command matches “${this.input.value}”.`;
      this.list.append(empty);
      return;
    }

    this.matches.forEach((match, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `palette__row${index === this.active ? ' palette__row--on' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === this.active));
      row.disabled = match.command.enabled === false;

      const group = document.createElement('span');
      group.className = 'palette__group';
      group.textContent = match.command.group;
      row.append(group);

      const title = document.createElement('span');
      title.className = 'palette__title';
      title.append(...highlight(match.command.title, match.highlights));
      row.append(title);

      // A disabled command shows why instead of its description: that is the
      // one thing the user needs at that moment.
      const detail = match.command.enabled === false ? match.command.disabledReason : match.command.detail;
      if (detail) {
        const note = document.createElement('span');
        note.className = match.command.enabled === false ? 'palette__blocked' : 'palette__detail';
        note.textContent = detail;
        row.append(note);
      }

      if (match.command.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.className = 'palette__shortcut';
        shortcut.textContent = match.command.shortcut;
        row.append(shortcut);
      }

      row.addEventListener('click', () => {
        if (match.command.enabled === false) return;
        this.dialog.close();
        this.host.onRun(match.command);
      });
      row.addEventListener('mouseenter', () => {
        this.active = index;
        this.render();
      });

      this.list.append(row);
    });

    this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
  }
}

/** Splits a title into plain and highlighted spans. */
function highlight(title: string, indices: number[]): Node[] {
  if (indices.length === 0) return [document.createTextNode(title)];
  const marked = new Set(indices);
  const nodes: Node[] = [];
  let buffer = '';
  let bufferMarked = false;

  const flush = () => {
    if (buffer === '') return;
    if (bufferMarked) {
      const mark = document.createElement('mark');
      mark.textContent = buffer;
      nodes.push(mark);
    } else {
      nodes.push(document.createTextNode(buffer));
    }
    buffer = '';
  };

  for (let index = 0; index < title.length; index++) {
    const isMarked = marked.has(index);
    if (isMarked !== bufferMarked) {
      flush();
      bufferMarked = isMarked;
    }
    buffer += title[index];
  }
  flush();
  return nodes;
}
