import type { AssetTreeGroupRow } from "../types";

export function listLeafAssetBuckets(
  roots: AssetTreeGroupRow[]
): { slug: string; label: string }[] {
  const out: { slug: string; label: string }[] = [];
  const walk = (nodes: AssetTreeGroupRow[]) => {
    for (const n of nodes) {
      if (n.is_leaf) {
        out.push({ slug: n.slug, label: n.label });
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export function countAccountsInBucketTree(node: AssetTreeGroupRow): number {
  let n = node.accounts?.length ?? 0;
  for (const c of node.children ?? []) {
    n += countAccountsInBucketTree(c);
  }
  return n;
}
