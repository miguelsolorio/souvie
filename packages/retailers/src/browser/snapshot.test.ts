// WS08 criterion 3, package side: the captured test page fixture holds to the snapshot contract,
// and the tree helpers adapters rely on behave. The live checks (two snapshots, a reload, typing,
// maxNodes) run against the real bridge in apps/mobile/src/features/tier3/__tests__/bridge.test.ts,
// which also proves the fixture is what a fresh capture of the page produces.
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/static-test-page.snapshot.json" with { type: "json" };
import {
  countNodes,
  diffSnapshots,
  findNode,
  pathTo,
  type SnapshotNode,
  type SnapshotTree,
  validateSnapshotTree,
  walk,
} from "./snapshot.ts";

const tree = fixture as SnapshotTree;

function clone(t: SnapshotTree): SnapshotTree {
  return JSON.parse(JSON.stringify(t)) as SnapshotTree;
}

describe("the static test page fixture", () => {
  it("meets the contract: id, role, name and a finite bbox on every node, unique ids", () => {
    expect(validateSnapshotTree(tree)).toEqual([]);
    for (const { node } of walk(tree)) {
      expect(node.id).toMatch(/^n[0-9a-z_]+$/);
      expect(node.role.length).toBeGreaterThan(0);
      expect(typeof node.name).toBe("string");
      expect(node.bbox.every((n) => Number.isFinite(n))).toBe(true);
    }
    expect(tree.nodeCount).toBe(countNodes(tree));
    expect(tree.truncated).toBe(false);
  });

  it("covers what WS10's skills need: tiles, prices, a stepper, a select, a search box", () => {
    const roles = new Set(walk(tree).map((v) => v.node.role));
    for (const role of [
      "searchbox",
      "combobox",
      "option",
      "article",
      "button",
      "heading",
      "group",
    ]) {
      expect(roles.has(role)).toBe(true);
    }
    const names = walk(tree).map((v) => v.node.name);
    expect(names.filter((n) => n === "Add")).toHaveLength(10);
    expect(names).toContain("Was $6.49 Now $4.99");
  });

  it("never holds a password value", () => {
    expect(JSON.stringify(tree)).not.toMatch(/password/i);
  });
});

describe("validateSnapshotTree", () => {
  it("reports duplicate ids, missing roles and bad boxes", () => {
    const bad = clone(tree);
    const [first, second] = walk(bad)
      .slice(1, 3)
      .map((v) => v.node) as [SnapshotNode, SnapshotNode];
    second.id = first.id;
    first.role = "";
    (first as { bbox: unknown }).bbox = [0, 0, Number.NaN, 1];
    const problems = validateSnapshotTree(bad);
    expect(problems.some((p) => p.includes("duplicate id"))).toBe(true);
    expect(problems.some((p) => p.includes("no role"))).toBe(true);
    expect(problems.some((p) => p.includes("bbox"))).toBe(true);
    expect(validateSnapshotTree(null)).toEqual(["tree is not an object"]);
  });
});

describe("tree helpers", () => {
  it("walks in document order and finds paths", () => {
    const visited = walk(tree);
    expect(visited[0]?.node).toBe(tree.root);
    expect(visited.map((v) => v.order)).toEqual(visited.map((_, i) => i));
    const add = visited.find((v) => v.node.role === "button" && v.node.name === "Add");
    if (!add) throw new Error("no Add button");
    expect(findNode(tree, add.node.id)).toBe(add.node);
    const path = pathTo(tree, add.node.id);
    expect(path[0]).toBe(tree.root);
    expect(path.at(-1)).toBe(add.node);
    expect(path.at(-2)?.role).toBe("article");
    expect(pathTo(tree, "nope")).toEqual([]);
  });

  it("diffs by id and ignores layout", () => {
    const after = clone(tree);
    const box = walk(after).find((v) => v.node.role === "searchbox")?.node;
    if (!box) throw new Error("no search box");
    box.value = "oat milk";
    for (const { node } of walk(after)) node.bbox = [1, 2, 3, 4];
    expect(diffSnapshots(tree, after)).toEqual([{ id: box.id, fields: ["value"] }]);

    const removed = clone(tree);
    removed.root.children = removed.root.children?.slice(1);
    const changes = diffSnapshots(tree, removed);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.fields.includes("removed"))).toBe(true);
  });
});
