import { describe, expect, it } from "bun:test";
import { canvasSubtreeIds } from "../src/index";

describe("canvasSubtreeIds", () => {
  it("returns only the root when nothing is nested inside it", () => {
    expect(canvasSubtreeIds([{ entityId: "other", parentEntityId: null }], "root")).toEqual(["root"]);
  });

  it("collects nested descendants regardless of placement order", () => {
    const placements = [
      { entityId: "grandchild", parentEntityId: "child" },
      { entityId: "sibling", parentEntityId: null },
      { entityId: "child", parentEntityId: "root" },
      { entityId: "great-grandchild", parentEntityId: "grandchild" },
      { entityId: "second-child", parentEntityId: "root" },
    ];
    expect(canvasSubtreeIds(placements, "root").sort()).toEqual(
      ["child", "grandchild", "great-grandchild", "root", "second-child"].sort(),
    );
  });

  it("leaves out the root's ancestors and unrelated systems", () => {
    const placements = [
      { entityId: "root", parentEntityId: "outer" },
      { entityId: "outer", parentEntityId: null },
      { entityId: "neighbor-child", parentEntityId: "neighbor" },
    ];
    expect(canvasSubtreeIds(placements, "root")).toEqual(["root"]);
  });

  it("terminates on corrupt cyclic parent links", () => {
    const placements = [
      { entityId: "a", parentEntityId: "b" },
      { entityId: "b", parentEntityId: "a" },
    ];
    expect(canvasSubtreeIds(placements, "a").sort()).toEqual(["a", "b"]);
  });
});
