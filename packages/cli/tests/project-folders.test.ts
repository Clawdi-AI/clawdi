import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	findProjectFolderLink,
	projectFoldersFile,
	readProjectFoldersConfig,
	removeProjectFolderLink,
	setProjectFolderLink,
} from "../src/lib/project-folders";

let tmpRoot: string;
let fakeHome: string;
let fakeClawdiHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origCwd: string;

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origCwd = process.cwd();

	tmpRoot = join(tmpdir(), `clawdi-project-folders-${Date.now()}-${Math.random().toString(36)}`);
	fakeHome = join(tmpRoot, "home");
	fakeClawdiHome = join(tmpRoot, "state");
	mkdirSync(fakeHome, { recursive: true });
	mkdirSync(fakeClawdiHome, { recursive: true });
	process.env.HOME = fakeHome;
	process.env.CLAWDI_HOME = fakeClawdiHome;
	process.chdir(tmpRoot);
});

afterEach(() => {
	process.chdir(origCwd);
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("project folder config", () => {
	it("links, reads, parent-matches, and unlinks inside isolated CLAWDI_HOME", () => {
		const projectRoot = join(tmpRoot, "repo");
		const childFolder = join(projectRoot, "packages", "cli");
		mkdirSync(childFolder, { recursive: true });
		const canonicalProjectRoot = realpathSync.native(projectRoot);

		const link = setProjectFolderLink(projectRoot, {
			project_id: "project-linked",
			project_label: "engineering",
			project_name: "Engineering",
			project_slug: "engineering",
			owner_handle: null,
			owner_display: null,
		});

		expect(projectFoldersFile()).toBe(join(fakeClawdiHome, "project-folders.json"));
		expect(existsSync(join(fakeHome, ".clawdi", "project-folders.json"))).toBe(false);
		expect(link.path).toBe(canonicalProjectRoot);

		const config = readProjectFoldersConfig();
		expect(config.links).toHaveLength(1);
		expect(config.links[0]).toMatchObject({
			path: canonicalProjectRoot,
			project_id: "project-linked",
			project_label: "engineering",
		});

		expect(findProjectFolderLink(projectRoot)).toMatchObject({
			source: "exact",
			link: { project_id: "project-linked" },
		});
		expect(findProjectFolderLink(childFolder)).toMatchObject({
			source: "parent",
			link: { path: canonicalProjectRoot, project_label: "engineering" },
		});

		const removed = removeProjectFolderLink(projectRoot);
		expect(removed?.project_id).toBe("project-linked");
		expect(readProjectFoldersConfig().links).toEqual([]);
		expect(existsSync(projectFoldersFile())).toBe(false);
	});
});
