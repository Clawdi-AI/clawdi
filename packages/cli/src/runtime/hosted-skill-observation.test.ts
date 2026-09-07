import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RuntimeAppliedState, runtimeAppliedStateSchema } from "./applied-state";
import type { HostedSkillEvidence } from "./hosted-skill-evidence";
import { readHostedSkillsObservation } from "./hosted-skill-observation";
import { releaseManagedSkill } from "./managed-skill-reservation";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import { reconcileHostedSkillProjection } from "./manifest-skills-apply";
import { hostedRuntimeBundleV2Schema } from "./manifest-source";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
let root = "";
afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function setup() {
	root = mkdtempSync(join(tmpdir(), "hosted-skill-observation-"));
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	delete process.env.CLAWDI_RUNTIME_USER;
	const paths = getRuntimePaths();
	mkdirSync(paths.serviceStateRoot, { recursive: true });
	const fixture = hostedRuntimeBundleV2Schema.parse(
		JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf8",
			),
		),
	);
	const manifest: RuntimeManifest = {
		...fixture.manifest,
		runtimes: { hermes: { enabled: true, services: {} } },
		projection: { skills: { entries: { clawdi: { enabled: true, version: 1 } } } },
	};
	const observation: RuntimeInstallObservation = {
		runtime: "hermes",
		enabled: true,
		status: "present",
		executionUser: null,
		commandPath: null,
		appRoot: null,
		install: null,
		installerUrl: null,
		executedInstallerUrl: null,
		exitCode: null,
		error: null,
	};
	let skillEvidence: HostedSkillEvidence[] = [];
	const input = {
		manifest,
		observations: new Map([["hermes", observation]]),
		home: join(root, "home"),
		managedResourceRoot: paths.managedResourceRoot,
		openClawWorkspaceRoot: null,
		preparedSourcedSkills: new Map(),
		onEvidence: (value: HostedSkillEvidence[]) => {
			skillEvidence = value;
		},
	};
	const state = (): RuntimeAppliedState => ({
		schemaVersion: "clawdi.runtimeAppliedState.v2",
		appliedAt: new Date().toISOString(),
		instanceId: manifest.instanceId,
		etag: `"sha256:${"a".repeat(64)}"`,
		sourceRevision: "a".repeat(64),
		generation: 2,
		applyGeneration: 7,
		contentIdentity: { sourcePath: "fixture", sha256: "b".repeat(64) },
		activated: {},
		providerIds: [],
		projectedProviderIds: {},
		skillEvidence,
	});
	return { input, state, target: join(root, "home", ".hermes", "skills", "clawdi") };
}

test("reports verified installation, detects edited bytes, and observes actual removal", () => {
	const { input, state, target } = setup();
	expect(reconcileHostedSkillProjection(input)).toEqual([]);
	let observed = readHostedSkillsObservation(state());
	expect(observed?.entries[0]).toMatchObject({
		status: "installed",
		desiredState: "present",
		generation: 7,
		sourceRevision: "a".repeat(64),
	});
	writeFileSync(join(target, "SKILL.md"), "changed by the runtime user");
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "unknown",
		errorCode: "evidence_mismatch",
	});
	input.manifest = { ...input.manifest, projection: { skills: { entries: {} } } };
	expect(reconcileHostedSkillProjection(input)).toEqual([]);
	observed = readHostedSkillsObservation(state());
	expect(observed?.entries[0]).toMatchObject({ status: "removed", desiredState: "absent" });
	expect(
		reconcileHostedSkillProjection({ ...input, previousEvidence: state().skillEvidence }),
	).toEqual([]);
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "removed",
		desiredState: "absent",
	});
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "SKILL.md"), "unmanaged replacement");
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("unknown");
});

test("failed removal retains ownership evidence for retry and reinstall replaces absent failure", () => {
	const { input, state } = setup();
	reconcileHostedSkillProjection(input);
	input.manifest = { ...input.manifest, projection: { skills: { entries: {} } } };
	const skillsRoot = join(input.home, ".hermes", "skills");
	chmodSync(skillsRoot, 0o555);
	try {
		expect(() => reconcileHostedSkillProjection(input)).toThrow("permission denied");
		expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
			status: "failed",
			desiredState: "absent",
			errorCode: "reconcile_failed",
		});
	} finally {
		chmodSync(skillsRoot, 0o755);
	}
	const targetDir = join(skillsRoot, "clawdi");
	releaseManagedSkill({
		targetDir,
		id: "clawdi",
		manager: "hosted-manifest",
		removeTarget: () => undefined,
	});
	expect(
		reconcileHostedSkillProjection({ ...input, previousEvidence: state().skillEvidence }),
	).toEqual([]);
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "failed",
		desiredState: "absent",
	});
	rmSync(targetDir, { recursive: true });
	expect(
		reconcileHostedSkillProjection({ ...input, previousEvidence: state().skillEvidence }),
	).toEqual([]);
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "removed",
		desiredState: "absent",
	});
	input.manifest = {
		...input.manifest,
		projection: { skills: { entries: { clawdi: { enabled: true, version: 1 } } } },
	};
	expect(reconcileHostedSkillProjection(input)).toEqual([]);
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "installed",
		desiredState: "present",
	});
});

test("preparation failure is per Skill and large evidence cannot block apply or heartbeat", () => {
	const { input, state } = setup();
	input.manifest = {
		...input.manifest,
		projection: {
			skills: {
				entries: {
					review: {
						enabled: true,
						source: {
							type: "github",
							url: "https://github.com/example/skills",
							path: "review",
							commit: "b".repeat(40),
						},
					},
				},
			},
		},
	};
	reconcileHostedSkillProjection({ ...input, preparationFailed: true });
	const applied = state();
	expect(readHostedSkillsObservation(applied)?.entries[0]).toMatchObject({
		status: "failed",
		desiredState: "present",
	});
	const first = applied.skillEvidence?.[0];
	if (!first) throw new Error("missing failure evidence");
	applied.skillEvidence = Array.from({ length: 2050 }, (_, index) => ({
		...first,
		skillKey: `skill-${String(index).padStart(4, "0")}`,
	}));
	expect(runtimeAppliedStateSchema.parse(applied).skillEvidence?.length).toBe(2050);
	const observed = readHostedSkillsObservation(applied);
	expect(observed?.entries).toHaveLength(2048);
	expect(observed?.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(1024 * 1024);
});
