/**
 * Minimal XML reader.
 *
 * DOMParser exists on extension pages but not in Web Workers, and parsing has to
 * happen in a worker so a 200 MB GML file does not freeze the UI. A small
 * in-repo parser also keeps the engines testable in Node without a DOM shim.
 *
 * Scope: elements, attributes, text, CDATA, comments, processing instructions
 * and the five predefined entities plus numeric character references. Not
 * supported: DTDs, external entities and namespace resolution beyond keeping the
 * prefix — which is exactly right for a converter, since an external entity in a
 * user-supplied file is an attack surface, not a feature.
 */

export interface XmlNode {
  /** Tag name including any prefix, e.g. 'gml:Point'. */
  name: string;
  /** Tag name with the prefix stripped, lower-cased — what matching uses. */
  local: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Direct text content, concatenated across text and CDATA runs. */
  text: string;
  parent?: XmlNode;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', local: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let index = 0;
  // Strip the BOM and any leading whitespace so the first '<' is found.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) {
      appendText(stack[stack.length - 1], text.slice(index));
      break;
    }
    if (open > index) appendText(stack[stack.length - 1], text.slice(index, open));

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      const body = text.slice(open + 9, end < 0 ? text.length : end);
      // CDATA is literal: entities inside it are not expanded.
      stack[stack.length - 1].text += body;
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!', open)) {
      // DOCTYPE and friends are skipped wholesale; external entities are never
      // resolved, which is deliberate for untrusted input.
      const end = text.indexOf('>', open + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }

    const close = findTagEnd(text, open);
    if (close < 0) break;
    const raw = text.slice(open + 1, close);
    index = close + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      // Pop to the matching element; a stray close tag is ignored rather than
      // discarding the whole document.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^([^\s/>]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const node: XmlNode = {
      name,
      local: stripPrefix(name),
      attributes: parseAttributes(body.slice(name.length)),
      children: [],
      text: '',
      parent: stack[stack.length - 1],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

/** Finds the '>' that ends a tag, skipping any inside quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let index = from + 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1]] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attributes;
}

function appendText(node: XmlNode, chunk: string): void {
  if (!chunk) return;
  node.text += decodeEntities(chunk);
}

export function stripPrefix(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

/** First child element whose local name matches, case-insensitively. */
export function child(node: XmlNode, local: string): XmlNode | undefined {
  const key = local.toLowerCase();
  return node.children.find((candidate) => candidate.local === key);
}

export function children(node: XmlNode, local: string): XmlNode[] {
  const key = local.toLowerCase();
  return node.children.filter((candidate) => candidate.local === key);
}

/** All descendants with the given local name, in document order. */
export function descendants(node: XmlNode, local: string, into: XmlNode[] = []): XmlNode[] {
  const key = local.toLowerCase();
  for (const candidate of node.children) {
    if (candidate.local === key) into.push(candidate);
    descendants(candidate, key, into);
  }
  return into;
}

export function firstDescendant(node: XmlNode, local: string): XmlNode | undefined {
  const key = local.toLowerCase();
  for (const candidate of node.children) {
    if (candidate.local === key) return candidate;
    const nested = firstDescendant(candidate, key);
    if (nested) return nested;
  }
  return undefined;
}

/** Text of a named child, trimmed; empty string when absent. */
export function childText(node: XmlNode, local: string): string {
  return child(node, local)?.text.trim() ?? '';
}

/** Attribute lookup that ignores any namespace prefix on the attribute name. */
export function attribute(node: XmlNode, name: string): string | undefined {
  const direct = node.attributes[name];
  if (direct !== undefined) return direct;
  const key = name.toLowerCase();
  for (const [attributeName, value] of Object.entries(node.attributes)) {
    if (stripPrefix(attributeName) === key) return value;
  }
  return undefined;
}

/** Root element of a parsed document, skipping the synthetic #document node. */
export function documentElement(document: XmlNode): XmlNode | undefined {
  return document.children[0];
}
