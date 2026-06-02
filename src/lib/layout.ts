/**
 * Binary split-pane layout tree. A leaf is a single terminal (by id); a split
 * arranges two children either side-by-side (`row`) or stacked (`col`) with a
 * draggable `ratio` (fraction given to the first child).
 */
export type PaneNode = Leaf | Split;

export interface Leaf {
  type: "leaf";
  id: number;
}

export interface Split {
  type: "split";
  /** Stable id used to address this split when resizing. */
  sid: number;
  dir: "row" | "col";
  a: PaneNode;
  b: PaneNode;
  ratio: number;
}

export const leaf = (id: number): Leaf => ({ type: "leaf", id });

/** All terminal (leaf) ids in the tree, left-to-right. */
export function leafIds(n: PaneNode): number[] {
  return n.type === "leaf" ? [n.id] : [...leafIds(n.a), ...leafIds(n.b)];
}

/** The first leaf id (used to pick a fallback focus target). */
export function firstLeafId(n: PaneNode): number {
  return n.type === "leaf" ? n.id : firstLeafId(n.a);
}

/**
 * Replace the leaf `targetId` with a split holding the original leaf plus a
 * new leaf `newId`. `sid` must be a fresh unique id for the split node.
 */
export function splitLeaf(
  n: PaneNode,
  targetId: number,
  dir: "row" | "col",
  newId: number,
  sid: number,
): PaneNode {
  if (n.type === "leaf") {
    if (n.id !== targetId) return n;
    return { type: "split", sid, dir, a: leaf(targetId), b: leaf(newId), ratio: 0.5 };
  }
  return {
    ...n,
    a: splitLeaf(n.a, targetId, dir, newId, sid),
    b: splitLeaf(n.b, targetId, dir, newId, sid),
  };
}

/**
 * Remove leaf `targetId`. When a split loses a child, it collapses to its
 * surviving child. Returns the new tree, or null if the whole tree is gone.
 */
export function removeLeaf(n: PaneNode, targetId: number): PaneNode | null {
  if (n.type === "leaf") return n.id === targetId ? null : n;
  const a = removeLeaf(n.a, targetId);
  const b = removeLeaf(n.b, targetId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...n, a, b };
}

/** Update the ratio of the split identified by `sid`. */
export function setRatio(n: PaneNode, sid: number, ratio: number): PaneNode {
  if (n.type === "leaf") return n;
  if (n.sid === sid) return { ...n, ratio };
  return { ...n, a: setRatio(n.a, sid, ratio), b: setRatio(n.b, sid, ratio) };
}

/** A region in fractional coordinates (0..1) within the pane container. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LeafRect {
  id: number;
  rect: Rect;
}

export interface DividerRect {
  sid: number;
  dir: "row" | "col";
  /** Full region spanned by the split (used to map a drag to a ratio). */
  region: Rect;
  ratio: number;
}

/**
 * Flatten the tree into absolutely-positioned leaf rects + divider rects. This
 * lets every terminal render in a flat list with a stable key (so splitting
 * never remounts — and never respawns — an existing PTY).
 */
export function computeLayout(
  node: PaneNode,
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 },
): { leaves: LeafRect[]; dividers: DividerRect[] } {
  if (node.type === "leaf") {
    return { leaves: [{ id: node.id, rect }], dividers: [] };
  }
  const { dir, ratio } = node;
  let aRect: Rect;
  let bRect: Rect;
  if (dir === "row") {
    aRect = { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h };
    bRect = {
      x: rect.x + rect.w * ratio,
      y: rect.y,
      w: rect.w * (1 - ratio),
      h: rect.h,
    };
  } else {
    aRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio };
    bRect = {
      x: rect.x,
      y: rect.y + rect.h * ratio,
      w: rect.w,
      h: rect.h * (1 - ratio),
    };
  }
  const a = computeLayout(node.a, aRect);
  const b = computeLayout(node.b, bRect);
  return {
    leaves: [...a.leaves, ...b.leaves],
    dividers: [
      { sid: node.sid, dir, region: rect, ratio },
      ...a.dividers,
      ...b.dividers,
    ],
  };
}
