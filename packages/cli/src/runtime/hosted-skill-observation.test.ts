import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHermesNativeFixture } from "../test-support/hermes-native-fixture";
import { type RuntimeAppliedState, runtimeAppliedStateSchema } from "./applied-state";
import { activateHostedHermesSkill } from "./hosted-hermes-skill";
import type { HostedSkillEvidence } from "./hosted-skill-evidence";
import { readHostedSkillsObservation } from "./hosted-skill-observation";
import { hostedSkillArchiveSourceIdentity } from "./hosted-sourced-skill-archive";
import {
	managedSkillReservationLedgerPath,
	releaseManagedSkill,
	reserveManagedSkill,
} from "./managed-skill-reservation";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import type { HostedSkillSource } from "./manifest-resources";
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
	installHermesNativeFixture(join(root, "home"));
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

test("reconciles root Git provenance through native install without local fallback", () => {
	const { input, state } = setup();
	const source: HostedSkillSource = {
		type: "github",
		url: "https://github.com/example/review",
		path: "",
		commit: "a".repeat(40),
	};
	const workspace = join(input.home, "workspace");
	const target = join(workspace, "skills", "review");
	const fixture = join(root, "review");
	const skillMd = "---\nname: review\ndescription: Review changes\n---\nRead the diff.\n";
	mkdirSync(join(fixture, "references"), { recursive: true });
	writeFileSync(join(fixture, "SKILL.md"), skillMd);
	writeFileSync(join(fixture, "references", "guide.md"), "Pinned support file\n");
	const archivePath = join(root, "review.tar.gz");
	execFileSync("tar", ["-czf", archivePath, "-C", root, "review"]);
	const tarBytes = readFileSync(archivePath);
	const identity = {
		source,
		sourceIdentity: hostedSkillArchiveSourceIdentity("review", source),
		digest: createHash("sha256").update(tarBytes).digest("hex"),
	};
	const observation = input.observations.get("hermes");
	if (!observation) throw new Error("missing runtime observation fixture");
	const projection = {
		...input,
		manifest: {
			...input.manifest,
			runtimes: { openclaw: { enabled: true, services: {} } },
			projection: { skills: { entries: { review: { enabled: true, source } } } },
		},
		observations: new Map([["openclaw", { ...observation, runtime: "openclaw" }]]),
		openClawWorkspaceRoot: workspace,
		preparedSourcedSkills: new Map([["review", { id: "review", identity, tarBytes }]]),
	};
	const command = join(input.home, ".local", "bin", "openclaw");
	const commandLog = join(root, "argv.log");
	const originFixture = join(root, "origin.json");
	const originPath = join(target, ".openclaw", "source-origin.json");
	const origin = () =>
		JSON.stringify({
			version: 1,
			source: "git",
			spec: `git:${source.url}@${source.commit}`,
			slug: "review",
			git: { url: source.url, ref: source.commit, commit: source.commit },
		});
	writeFileSync(originFixture, origin());
	mkdirSync(join(input.home, ".local", "bin"), { recursive: true });
	// This command double checks the transport boundary, not native scan policy.
	writeFileSync(
		command,
		`#!/bin/sh
set -eu
printf '%s\\n' "$@" >> '${commandLog}'
if test -f '${root}/refuse'; then
  printf '%s\\n' 'native install refused' >&2
  exit 44
fi
mkdir -p '${target}/.openclaw'
cp -R '${fixture}/.' '${target}/'
cp '${originFixture}' '${originPath}'
`,
		{ mode: 0o755 },
	);
	const argv = () =>
		`${[
			"skills",
			"install",
			`git:${source.url}#${source.commit}`,
			"--agent",
			"main",
			"--as",
			"review",
			"--force",
		].join("\n")}\n`;

	mkdirSync(join(target, ".openclaw"), { recursive: true });
	writeFileSync(join(target, "SKILL.md"), skillMd);
	mkdirSync(join(target, "references"));
	writeFileSync(join(target, "references", "guide.md"), "Pinned support file\n");
	writeFileSync(originPath, '{"version":1,"source":"path"}');
	expect(() => reconcileHostedSkillProjection(projection)).toThrow(
		"refusing to replace unmanaged review",
	);
	expect(existsSync(commandLog)).toBe(false);
	reserveManagedSkill({
		targetDir: target,
		id: "review",
		manager: "hosted-manifest",
		digest: identity.digest,
		sourceIdentity: identity.sourceIdentity,
	});
	expect(reconcileHostedSkillProjection(projection)).toEqual([]);
	expect(readFileSync(commandLog, "utf8")).toBe(argv());
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("installed");
	expect(reconcileHostedSkillProjection(projection)).toEqual([]);
	expect(readFileSync(commandLog, "utf8")).toBe(argv());

	const ledgerBefore = readFileSync(managedSkillReservationLedgerPath());
	writeFileSync(originPath, "{}");
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("unknown");
	writeFileSync(join(root, "refuse"), "");
	expect(reconcileHostedSkillProjection(projection).join("\n")).toContain("native install refused");
	expect(readFileSync(commandLog, "utf8")).toBe(argv().repeat(2));
	expect(readFileSync(originPath, "utf8")).toBe("{}");
	expect(readFileSync(managedSkillReservationLedgerPath())).toEqual(ledgerBefore);
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("failed");
	rmSync(join(root, "refuse"));

	writeFileSync(join(fixture, "references", "guide.md"), "Wrong support bytes\n");
	expect(reconcileHostedSkillProjection(projection).join("\n")).toContain(
		"changed exact source bytes",
	);
	expect(readFileSync(join(target, "references", "guide.md"), "utf8")).toBe(
		"Pinned support file\n",
	);
	expect(readFileSync(managedSkillReservationLedgerPath())).toEqual(ledgerBefore);
	writeFileSync(join(fixture, "references", "guide.md"), "Pinned support file\n");
	writeFileSync(originFixture, "{}");
	expect(reconcileHostedSkillProjection(projection).join("\n")).toContain(
		"native source provenance mismatch",
	);
	expect(readFileSync(commandLog, "utf8")).toBe(argv().repeat(4));
	writeFileSync(originFixture, origin());
	expect(reconcileHostedSkillProjection(projection)).toEqual([]);
	const oldCalls = argv().repeat(5);

	// A new immutable source must update native provenance even with identical bytes.
	source.commit = "b".repeat(40);
	identity.sourceIdentity = hostedSkillArchiveSourceIdentity("review", source);
	writeFileSync(originFixture, origin());
	expect(reconcileHostedSkillProjection(projection)).toEqual([]);
	expect(readFileSync(commandLog, "utf8")).toBe(oldCalls + argv());
	expect(JSON.parse(readFileSync(originPath, "utf8")).git.commit).toBe(source.commit);
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("installed");
});

test("Hermes heartbeat detects native provenance drift without invalidating sibling changes", () => {
	const { input, state } = setup();
	const source: HostedSkillSource = {
		type: "github",
		url: "https://github.com/example/skills",
		path: "skills/review",
		commit: "a".repeat(40),
	};
	const fixture = join(root, "source", "review");
	mkdirSync(fixture, { recursive: true });
	writeFileSync(join(fixture, "SKILL.md"), "# Review\n");
	const archive = join(root, "skill.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "review"]);
	const tarBytes = readFileSync(archive);
	const identity = {
		source,
		sourceIdentity: hostedSkillArchiveSourceIdentity("review", source),
		digest: createHash("sha256").update(tarBytes).digest("hex"),
	};
	input.manifest.projection = { skills: { entries: { review: { enabled: true, source } } } };
	input.preparedSourcedSkills.set("review", { id: "review", identity, tarBytes });
	expect(reconcileHostedSkillProjection(input)).toEqual([]);
	activateHostedHermesSkill({
		home: input.home,
		sourceDir: fixture,
		targetDir: join(input.home, ".hermes", "skills", "sibling"),
		source,
	});
	const lockPath = join(input.home, ".hermes", "skills", ".hub", "lock.json");
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	lock.installed.sibling.updated_at = "2026-09-08T01:00:00Z";
	writeFileSync(lockPath, JSON.stringify(lock));
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("installed");
	lock.installed.review.metadata.clawdi_source_identity = hostedSkillArchiveSourceIdentity(
		"review",
		{ ...source, commit: "b".repeat(40) },
	);
	writeFileSync(lockPath, JSON.stringify(lock));
	expect(readHostedSkillsObservation(state())?.entries[0]).toMatchObject({
		status: "unknown",
		errorCode: "evidence_mismatch",
	});
	delete lock.installed.review;
	writeFileSync(lockPath, JSON.stringify(lock));
	expect(readHostedSkillsObservation(state())?.entries[0]?.status).toBe("unknown");
});
