export const UNRESOLVED_PLACEHOLDER_PREFIX = "⟪mergev:unresolved:";

export function unresolvedPlaceholder(id: number): string {
  return `${UNRESOLVED_PLACEHOLDER_PREFIX}${id}⟫`;
}

export function containsUnresolvedPlaceholder(text: string): boolean {
  return text.includes(UNRESOLVED_PLACEHOLDER_PREFIX);
}
