import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { matchesProjectFilter } from "./paths";

test.each([
	["/repo", "/repo", true],
	["/repo/subdirectory", "/repo", true],
	["/repo2", "/repo", false],
	["/repo-other/child", "/repo", false],
	["/repo/..inside", "/repo/", true],
	["/repo/sub/../child", "/repo/", true],
	["/repo", "/", true],
	[null, "/repo", false],
	[null, null, true],
] as const)("matches project cwd %s under %s: %s", (cwd, filter, expected) => {
	expect(matchesProjectFilter(cwd, filter === null ? null : resolve(filter))).toBe(expected);
});
