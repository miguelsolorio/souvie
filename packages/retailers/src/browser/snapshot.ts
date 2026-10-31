// The page as a tree (WS08). The injected bridge (apps/mobile/src/features/tier3/bridge.js)
// produces it; adapters (WS10) and the shared skills (skills.ts) read it. Pure data, JSON-safe, so
// a tree can be saved as a fixture (`*.snapshot.json`) and replayed in tests.
//
// Serializer contract. Any bridge (the WebView one today, a desktop webview later) must:
//   1. Walk the visible DOM from <body>. Hidden nodes (display:none, visibility:hidden, the
//      `hidden` attribute, aria-hidden="true", <script>, <style>, <template>) are left out.
//      Iframe content is not walked; the iframe itself is a node.
//   2. Give every node a `role` (the explicit role attribute, else the implicit ARIA role: link,
//      button, textbox, searchbox, checkbox, radio, combobox, option, spinbutton, img, heading,
//      list, listitem, navigation, main, form, dialog, iframe, table, row, cell; `text` for a run
//      of visible text; `generic` for a grouping element) and a `name` (the accessible name:
//      aria-labelledby, aria-label, <label>, alt, title, placeholder, or the text for roles that
//      take their name from content; the text itself for `text` nodes; "" when there is none).
//      Generic wrappers with a single child collapse into that child, so tiles, rows and forms
//      stay as groups and decoration does not.
//   3. Set `value` for form controls (never for a password field: rule 7), `href` for links (absolute),
//      `text` for a leaf element whose visible text differs from its name, and `disabled` or
//      `checked` when they apply.
//   4. Give every node `bbox` = [x, y, width, height] in CSS pixels relative to the viewport,
//      four finite numbers.
//   5. Assign stable ids: a hash of the parent's id, the node's role, its name, and its index
//      among siblings with the same role and name. Anonymous nodes (no name) use the name of their
//      first named descendant instead, and only when there is none the tag and its DOM index. So
//      two snapshots of an unchanged DOM have identical ids, typing into a field changes that
//      field's `value` and nothing else, and a banner inserted above a tile does not change the
//      ids inside the tile. Ids are unique within one tree.
//   6. Stop at `maxNodes` nodes in document order and set `truncated: true`.
//   7. Never read, serialize, or type a password. A field is a password when its type is password,
//      its autocomplete names a password (current-password, new-password), or its name, id, label,
//      aria-label, title or placeholder matches /pass(word|code)?|pwd/i, whatever its type attribute
//      says at the moment: a person may have toggled it visible. Such a field has no `value`, and
//      typing into it fails with `password_field`.

export interface SnapshotNode {
  /** Stable across snapshots of an unchanged DOM (contract rule 5). */
  id: string;
  role: string;
  /** Accessible name. "" when there is none. */
  name: string;
  /** Visible text of a leaf element, when it differs from `name`. */
  text?: string;
  /** Current value of a form control. Never present on a password field (contract rule 7). */
  value?: string;
  /** Absolute URL for links. */
  href?: string;
  /** [x, y, width, height] in CSS pixels, relative to the viewport. */
  bbox: [number, number, number, number];
  /** Present (true) only when the control is disabled. */
  disabled?: boolean;
  /** Checkbox, radio and option state. */
  checked?: boolean;
  children?: SnapshotNode[];
}

export type SnapshotTree = {
  url: string;
  title: string;
  root: SnapshotNode;
  /** ISO timestamp. */
  capturedAt: string;
  /** True when the walk stopped at `maxNodes`. */
  truncated?: boolean;
  /** Nodes in the tree, the root included. */
  nodeCount?: number;
};

/** Default cap when the caller does not pass one. */
export const DEFAULT_MAX_NODES = 1500;
/** Cap used for the snapshots streamed during `waitFor`, so predicates stay cheap. */
export const WAIT_MAX_NODES = 600;

export interface VisitedNode {
  node: SnapshotNode;
  parent: SnapshotNode | null;
  depth: number;
  /** Position in document (pre-)order, the root is 0. */
  order: number;
}

/** Every node in document order, with its parent. */
export function walk(tree: SnapshotTree | SnapshotNode): VisitedNode[] {
  const root = "root" in tree ? tree.root : tree;
  const out: VisitedNode[] = [];
  const stack: { node: SnapshotNode; parent: SnapshotNode | null; depth: number }[] = [
    { node: root, parent: null, depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop() as (typeof stack)[number];
    out.push({ ...item, order: out.length });
    const children = item.node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i] as SnapshotNode, parent: item.node, depth: item.depth + 1 });
    }
  }
  return out;
}

export function countNodes(tree: SnapshotTree | SnapshotNode): number {
  return walk(tree).length;
}

export function findNode(tree: SnapshotTree, id: string): SnapshotNode | null {
  return walk(tree).find((v) => v.node.id === id)?.node ?? null;
}

/** The chain from the root to the node, both included. Empty when the id is not in the tree. */
export function pathTo(tree: SnapshotTree, id: string): SnapshotNode[] {
  const parents = new Map<string, SnapshotNode | null>();
  let target: SnapshotNode | null = null;
  for (const v of walk(tree)) {
    parents.set(v.node.id, v.parent);
    if (v.node.id === id) target = v.node;
  }
  if (!target) return [];
  const chain: SnapshotNode[] = [];
  let current: SnapshotNode | null = target;
  while (current) {
    chain.unshift(current);
    current = parents.get(current.id) ?? null;
  }
  return chain;
}

function isFiniteBox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/**
 * Checks a tree against the contract's shape: every node has a non-empty id, a role, a name, and
 * a bbox of four finite numbers; ids are unique. Returns the problems found, empty when valid.
 * Use it on fixtures and on anything a bridge sends before trusting it.
 */
export function validateSnapshotTree(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object") return ["tree is not an object"];
  const tree = value as Partial<SnapshotTree>;
  if (typeof tree.url !== "string") problems.push("url is not a string");
  if (typeof tree.title !== "string") problems.push("title is not a string");
  if (typeof tree.capturedAt !== "string" || Number.isNaN(Date.parse(tree.capturedAt))) {
    problems.push("capturedAt is not an ISO timestamp");
  }
  if (!tree.root || typeof tree.root !== "object") return [...problems, "root is missing"];
  const seen = new Set<string>();
  for (const { node } of walk(tree.root as SnapshotNode)) {
    const where = `node ${typeof node.id === "string" ? node.id : "?"}`;
    if (typeof node.id !== "string" || node.id.length === 0) problems.push(`${where}: no id`);
    else if (seen.has(node.id)) problems.push(`${where}: duplicate id`);
    else seen.add(node.id);
    if (typeof node.role !== "string" || node.role.length === 0) problems.push(`${where}: no role`);
    if (typeof node.name !== "string") problems.push(`${where}: name is not a string`);
    if (!isFiniteBox(node.bbox)) problems.push(`${where}: bbox is not four finite numbers`);
    if (node.children !== undefined && !Array.isArray(node.children)) {
      problems.push(`${where}: children is not an array`);
    }
  }
  if (tree.nodeCount !== undefined && tree.nodeCount !== seen.size) {
    problems.push(`nodeCount ${tree.nodeCount} does not match ${seen.size} nodes`);
  }
  return problems;
}

export interface NodeChange {
  id: string;
  /** The fields that differ (`added` or `removed` when the id is only on one side). */
  fields: string[];
}

const COMPARED_FIELDS = ["role", "name", "text", "value", "href", "disabled", "checked"] as const;

/**
 * What changed between two snapshots, by node id. Ignores bbox (layout moves on scroll) and the
 * order of children. Used by tests ("typing changes only that field's value") and by adapters
 * that want to know whether a click did anything.
 */
export function diffSnapshots(before: SnapshotTree, after: SnapshotTree): NodeChange[] {
  const left = new Map(walk(before).map((v) => [v.node.id, v.node]));
  const right = new Map(walk(after).map((v) => [v.node.id, v.node]));
  const changes: NodeChange[] = [];
  for (const [id, a] of left) {
    const b = right.get(id);
    if (!b) {
      changes.push({ id, fields: ["removed"] });
      continue;
    }
    const fields = COMPARED_FIELDS.filter((f) => a[f] !== b[f]);
    if (fields.length > 0) changes.push({ id, fields: [...fields] });
  }
  for (const id of right.keys()) {
    if (!left.has(id)) changes.push({ id, fields: ["added"] });
  }
  return changes;
}
