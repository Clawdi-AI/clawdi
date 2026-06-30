import { spawnSync } from "node:child_process";

const gitCheck = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
	stdio: "ignore",
});

if (gitCheck.status !== 0) {
	console.log("Skipping git hook install outside a git worktree.");
	process.exit(0);
}

const lefthook = spawnSync("lefthook", ["install"], { stdio: "inherit" });

if (lefthook.error) {
	console.error(lefthook.error.message);
	process.exit(1);
}

process.exit(lefthook.status ?? 1);
