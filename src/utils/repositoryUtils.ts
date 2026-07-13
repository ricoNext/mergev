import { hashString } from "./stringUtils";

export const REPO_AVATAR_COLORS = [
  "#4e9a51",
  "#2aa198",
  "#d33682",
  "#6c71c4",
  "#268bd2",
  "#c678dd",
  "#e5a03c",
];

export function getRepoInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }
  const word = parts[0] || name;
  return word.length <= 3 ? word[0].toUpperCase() : word.slice(0, 2).toUpperCase();
}

export function getRepoAvatarColor(name: string): string {
  return REPO_AVATAR_COLORS[hashString(name) % REPO_AVATAR_COLORS.length];
}
