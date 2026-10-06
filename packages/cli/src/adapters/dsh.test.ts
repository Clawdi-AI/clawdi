import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLocalAgents } from "../commands/agent-detect";
import { tarSingleFile } from "../lib/tar";
import { adapterModuleNames } from "./base";
import { DshAdapter } from "./dsh";
import { getDshHome } from "./paths";
import {
	AGENT_TYPES,
	adapterRegistry,
	agentSkillTargetDir,
	allAdapterEntries,
	builtinSkillTargetDir,
	SKILL_AGENT_TYPE_HELP_LABEL,
} from "./registry";

const envKeys = ["HOME", "DSH_HOME", "CLAWDI_HOME", "PATH"] as const;
const envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-dsh-adapter-"));
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, "clawdi");
	delete process.env.DSH_HOME;
	const bin = join(root, "bin");
	mkdirSync(bin);
	process.env.PATH = bin;
});

afterEach(() => {
	for (const key of envKeys) {
		const value = envSnapshot.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("DeepSeek Harness skills-only adapter", () => {
	test("exposes dsh through the Desktop detection contract with its canonical label", async () => {
		mkdirSync(join(root, ".dsh"));
		const agents = await detectLocalAgents(
			allAdapterEntries().filter((entry) => entry.agentType === "dsh"),
			{ registeredTypes: new Set(["dsh"]) },
		);
		expect(agents).toEqual([
			{
				type: "dsh",
				displayName: "DeepSeek Harness",
				detected: true,
				registered: true,
				version: null,
				inspection: "complete",
			},
		]);
	});

	test("detects the default home and honors DSH_HOME lazily", async () => {
		const adapter = new DshAdapter();
		expect(await adapter.detect()).toBe(false);
		mkdirSync(join(root, ".dsh"));
		expect(await adapter.detect()).toBe(true);
		process.env.DSH_HOME = join(root, "custom-dsh");
		expect(await adapter.detect()).toBe(false);
		mkdirSync(getDshHome());
		expect(await adapter.detect()).toBe(true);
		expect(adapter.skills.rootDir()).toBe(join(root, "custom-dsh", "skills"));
		process.env.DSH_HOME = "   ";
		expect(getDshHome()).toBe(join(root, ".dsh"));
		process.env.DSH_HOME = "~/custom-dsh";
		expect(getDshHome()).toBe(join(root, "custom-dsh"));
	});

	test("reads dsh --version and returns null for missing or failing commands", async () => {
		const adapter = new DshAdapter();
		expect(await adapter.getVersion()).toBeNull();
		const command = join(root, "bin", "dsh");
		writeFileSync(
			command,
			'#!/bin/sh\n[ "$*" = "--version" ] || exit 99\nprintf "0.2.0-rc.2\\nextra line\\n"\n',
			{ mode: 0o755 },
		);
		expect(await adapter.getVersion()).toBe("0.2.0-rc.2");
		writeFileSync(command, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		expect(await adapter.getVersion()).toBeNull();
	});

	test("satisfies AtLeastOne with Skills and exposes no sessions or MCP lifecycle", () => {
		const adapter = adapterRegistry.dsh.create();
		expect(adapterModuleNames(adapter)).toEqual(["skills"]);
		expect(adapter.sessions).toBeUndefined();
		expect(adapterRegistry.dsh.mcpLifecycle).toBeUndefined();
		expect(AGENT_TYPES).toContain("dsh");
		expect(SKILL_AGENT_TYPE_HELP_LABEL.split(", ")).toContain("dsh");
		expect(builtinSkillTargetDir("dsh")).toBe(join(root, ".dsh", "skills", "clawdi"));
		process.env.DSH_HOME = join(root, "custom-dsh");
		expect(agentSkillTargetDir("dsh", "demo")).toBe(join(root, "custom-dsh", "skills", "demo"));
	});

	test("manages only directory bundles at the overridden Skills root", async () => {
		process.env.PATH = `${join(root, "bin")}:${envSnapshot.get("PATH") ?? ""}`;
		process.env.DSH_HOME = join(root, "custom-dsh");
		const adapter = new DshAdapter();
		const skillRoot = adapter.skills.rootDir();
		mkdirSync(skillRoot, { recursive: true });
		writeFileSync(join(skillRoot, "single.md"), "# Single-file Skill\n");
		const archive = await tarSingleFile(
			"demo",
			"---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
		);
		await adapter.skills.writeArchive("demo", archive);
		await adapter.skills.writeSharedArchive("demo", "owner", archive);
		expect((await adapter.skills.collect()).map((skill) => skill.skillKey).sort()).toEqual([
			"demo",
			"demo__owner",
		]);
		expect(readFileSync(adapter.skills.path("demo"), "utf8")).toContain("# Demo");
		await adapter.skills.remove("demo");
		expect(await adapter.skills.listKeys()).toEqual(["demo__owner"]);
		expect(existsSync(join(skillRoot, "single.md"))).toBe(true);
	});
});
