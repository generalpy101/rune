const MAC_PROTECTED_HOME_DIRS = new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "movies",
  "music",
]);

function normalizePath(path: string): string {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
}

/** macOS prompts when an app accesses these home folders. Use this only for
 * automatic restore, workspace scans, and background polling; explicit user
 * navigation may still go there and let macOS ask as designed. */
export function isMacProtectedHomePath(path: string, home: string): boolean {
  if (!home || !path.startsWith("/")) return false;
  if (!navigator.platform.toLowerCase().includes("mac")) return false;

  const normalizedHome = normalizePath(home).toLowerCase();
  const normalizedPath = normalizePath(path).toLowerCase();
  if (!normalizedPath.startsWith(`${normalizedHome}/`)) return false;

  const relative = normalizedPath.slice(normalizedHome.length + 1);
  const [first] = relative.split("/");
  return MAC_PROTECTED_HOME_DIRS.has(first);
}

export function safeAutomaticPath(path: string, home: string): string {
  return isMacProtectedHomePath(path, home) ? home : path;
}
