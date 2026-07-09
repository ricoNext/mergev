declare module "node-diff3" {
  export function diff3Merge(
    a: unknown[],
    o: unknown[],
    b: unknown[],
    options?: { excludeFalseConflicts?: boolean; stringSeparator?: string | RegExp }
  ): unknown[];
}
