import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/**
 * The same linter the community-plugin review runs. Kept in the repo so a
 * submission blocker shows up here rather than in the review queue.
 */
export default tseslint.config(
	{ ignores: ["main.js", "esbuild.config.mjs", "version-bump.mjs", "scripts/**", "tests/**"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
);
