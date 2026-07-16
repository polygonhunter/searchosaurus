/** Folder-boundary-aware exclusion check (pure, unit-tested). */

/**
 * Is `path` inside any of the excluded folders? Boundary-aware:
 * "templates" excludes "templates/a.md" but NOT "templates2.md".
 * Empty entries (a just-added, not-yet-picked row) never match.
 */
export function isPathExcluded(path: string, folders: readonly string[]): boolean {
	for (const raw of folders) {
		const folder = raw.replace(/\/+$/, "");
		if (folder.length === 0) continue;
		if (path === folder || path.startsWith(`${folder}/`)) return true;
	}
	return false;
}
