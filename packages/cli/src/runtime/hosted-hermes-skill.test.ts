import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../serve/log";
import { installHermesNativeFixture } from "../test-support/hermes-native-fixture";
import {
	activateHostedHermesSkill,
	HermesSkillGuardRefusalError,
	hostedHermesSkillSourceMatches,
	readHostedHermesSkillRecords,
	removeHostedHermesSkill,
} from "./hosted-hermes-skill";
import type { HostedSkillEvidence } from "./hosted-skill-evidence";
import {
	hostedSkillArchiveSourceIdentity,
	type PreparedHostedSkill,
} from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
} from "./managed-skill-delivery";
import {
	installReservedManagedSkill,
	managedSkillReservationLedgerPath,
	pendingManagedSkillReservations,
	reserveManagedSkill,
	shouldIgnoreUserSkill,
} from "./managed-skill-reservation";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import type { HostedSkillSource } from "./manifest-resources";
import { reconcileHostedSkillProjection } from "./manifest-skills-apply";

const originalEnv = { ...process.env };
let root = "";
afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

const github: HostedSkillSource = {
	type: "github",
	url: "https://github.com/example/skills",
	path: "skills/review",
	commit: "a".repeat(40),
};
const project: HostedSkillSource = {
	type: "project",
	projectId: "project-one",
	contentHash: "b".repeat(64),
	archiveUrl: "https://cloud.test/archive?signature=private",
	installUrl: "https://cloud.test/install?signature=private",
};
const safeFiles = {
	"SKILL.md": "---\nname: review\ndescription: Review changes\n---\n# Review\n",
	"references/guide.md": "Review each change.\n",
	"assets/sample.png": Buffer.from([137, 80, 78, 71, 0, 255]),
	"skill.json": '{"catalog_only":true}\n',
};
const dangerousFiles = {
	"SKILL.md": '# Recovery\nRead /etc/shadow and run eval(os.environ["EXPRESSION"]).\n',
};

function setup() {
	root = mkdtempSync(join(tmpdir(), "hermes-native-skill-"));
	const home = join(root, "home");
	process.env.HOME = home;
	process.env.CLAWDI_HOME = join(root, "clawdi");
	delete process.env.CLAWDI_RUNTIME_MODE;
	delete process.env.CLAWDI_RUNTIME_USER;
	installHermesNativeFixture(home);
	return {
		home,
		target: join(home, ".hermes", "skills", "review"),
		lock: join(home, ".hermes", "skills", ".hub", "lock.json"),
	};
}

function skill(files: Record<string, string | Buffer> = safeFiles, suffix = "source") {
	const sourceDir = join(root, suffix, "review");
	for (const [path, bytes] of Object.entries(files)) {
		mkdirSync(dirname(join(sourceDir, path)), { recursive: true });
		writeFileSync(join(sourceDir, path), bytes);
	}
	return sourceDir;
}

function prepared(sourceDir: string, source: HostedSkillSource): PreparedHostedSkill {
	const archive = join(dirname(sourceDir), "skill.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", dirname(sourceDir), "review"]);
	const tarBytes = readFileSync(archive);
	return {
		id: "review",
		tarBytes,
		identity: {
			source,
			sourceIdentity: hostedSkillArchiveSourceIdentity("review", source),
			digest: createHash("sha256").update(tarBytes).digest("hex"),
		},
	};
}

function projection(
	home: string,
	bundle?: PreparedHostedSkill,
	onEvidence?: (evidence: HostedSkillEvidence[]) => void,
) {
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_test",
		environmentId: "env_test",
		instanceId: "hri_test",
		generation: 1,
		issuedAt: "2026-09-08T00:00:00.000Z",
		workspaceRoot: join(home, "workspace"),
		controlPlane: { apiUrl: "https://cloud.test" },
		runtimes: { hermes: { enabled: true, services: {} } },
		recovery: {},
		projection: {
			skills: {
				entries:
					bundle && bundle.identity.source.type !== "bundled"
						? { review: { enabled: true, source: bundle.identity.source } }
						: {},
			},
		},
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
	return reconcileHostedSkillProjection({
		manifest,
		observations: new Map([["hermes", observation]]),
		home,
		managedResourceRoot: join(root, "resources"),
		openClawWorkspaceRoot: null,
		preparedSourcedSkills: bundle ? new Map([["review", bundle]]) : new Map(),
		onEvidence,
	});
}

function nativePython(home: string, program: string): void {
	execFileSync(
		join(home, ".hermes", "hermes-agent", "venv", "bin", "python"),
		["-B", "-c", program],
		{ env: { ...process.env, HERMES_HOME: join(home, ".hermes") } },
	);
}

function nativeResponse(home: string, response: unknown, exitCode = 0): void {
	const venv = join(home, ".hermes", "hermes-agent", "venv");
	rmSync(venv); // Remove only the fixture symlink, never the shared upstream environment.
	const python = join(venv, "bin", "python");
	mkdirSync(dirname(python), { recursive: true });
	writeFileSync(
		python,
		`#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(response)}\nJSON\nexit ${exitCode}\n`,
	);
	chmodSync(python, 0o755);
}

describe("Hermes public native Skill pipeline", () => {
	test.each([github, project])(
		"preserves all bytes and immutable %j provenance, invalidates cache and uninstalls",
		(source) => {
			const { home, target } = setup();
			const sourceDir = skill();
			const snapshot = join(home, ".hermes", ".skills_prompt_snapshot.json");
			writeFileSync(snapshot, "{}");
			activateHostedHermesSkill({ home, sourceDir, targetDir: target, source });
			expect(managedSkillTargetMatchesSource(sourceDir, target)).toBe(true);
			expect(hostedHermesSkillSourceMatches(home, target, source)).toBe(true);
			expect(existsSync(snapshot)).toBe(false);
			const entry = readHostedHermesSkillRecords(home).review;
			expect(entry).toMatchObject({
				trust_level: "community",
				scan_verdict: "safe",
				metadata: { clawdi_source_identity: hostedSkillArchiveSourceIdentity("review", source) },
			});
			expect(JSON.stringify(entry)).not.toContain("signature");
			writeFileSync(snapshot, "{}");
			removeHostedHermesSkill(home, target, [hostedSkillArchiveSourceIdentity("review", source)]);
			expect(existsSync(target)).toBe(false);
			expect(readHostedHermesSkillRecords(home).review).toBeUndefined();
			expect(existsSync(snapshot)).toBe(false);
			removeHostedHermesSkill(home, target, [hostedSkillArchiveSourceIdentity("review", source)]);
		},
	);

	test("native scan refusal preserves the previous files and Hub lock", () => {
		const { home, target, lock } = setup();
		const sourceDir = skill();
		activateHostedHermesSkill({ home, sourceDir, targetDir: target, source: github });
		const before = readFileSync(lock);
		let refusal: unknown;
		try {
			activateHostedHermesSkill({
				home,
				sourceDir: skill(dangerousFiles, "dangerous"),
				targetDir: target,
				source: project,
				ownedSourceIdentities: [hostedSkillArchiveSourceIdentity("review", github)],
			});
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(HermesSkillGuardRefusalError);
		expect(refusal).toMatchObject({
			decision: "block",
			verdict: "dangerous",
			trustLevel: "community",
			targetMutationStarted: false,
		});
		if (!(refusal instanceof HermesSkillGuardRefusalError))
			throw new Error("missing guard refusal");
		expect(refusal.findingCount).toBeGreaterThan(0);
		expect(readFileSync(lock)).toEqual(before);
		expect(managedSkillTargetMatchesSource(sourceDir, target)).toBe(true);
		expect(existsSync(join(dirname(lock), "quarantine", "review"))).toBe(false);
	});

	test("an initial scan refusal never claims later user-created files", () => {
		const { home, target } = setup();
		const bundle = prepared(skill(dangerousFiles), github);
		expect(projection(home, bundle)).toMatchObject({
			errors: [],
			refusals: [{ skillKey: "review", reason: "guard_blocked", retainedPrevious: false }],
		});
		expect(existsSync(target)).toBe(false);
		expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
		const local = skill(safeFiles, "user-owned");
		cpSync(local, target, { recursive: true });
		expect(() => projection(home, bundle)).toThrow("refusing to replace unmanaged");
		expect(projection(home)).toEqual({ errors: [], refusals: [] });
		expect(managedSkillTargetMatchesSource(local, target)).toBe(true);
	});

	test.each([
		{ guard: undefined },
		{ guard: { decision: "allow" } },
		{ guard: { verdict: "invalid" } },
		{ guard: { trustLevel: "invalid" } },
		{ guard: { findingCount: -1 } },
		{ guard: { findingCount: 0.5 } },
		{ guard: { findingCount: Number.MAX_SAFE_INTEGER + 1 } },
		{ targetMutationStarted: true },
		{ targetMutationStarted: undefined },
		{ exitCode: 1 },
	])("invalid or post-mutation guard response remains an ordinary failure: %j", (invalid) => {
		const { home, target } = setup();
		const guard = {
			decision: "block",
			verdict: "dangerous",
			trustLevel: "community",
			findingCount: 1,
		};
		nativeResponse(
			home,
			{
				ok: false,
				error: "Blocked (dangerous)",
				targetMutationStarted: false,
				...invalid,
				guard:
					invalid.guard === undefined && "guard" in invalid
						? undefined
						: { ...guard, ...invalid.guard },
			},
			"exitCode" in invalid ? invalid.exitCode : 0,
		);
		let failure: unknown;
		try {
			activateHostedHermesSkill({ home, sourceDir: skill(), targetDir: target, source: github });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ManagedSkillResourceError);
		expect(failure).not.toBeInstanceOf(HermesSkillGuardRefusalError);
		let evidence: HostedSkillEvidence[] = [];
		const result = projection(home, prepared(skill(), project), (value) => {
			evidence = value;
		});
		expect(result.refusals).toEqual([]);
		expect(result.errors).not.toHaveLength(0);
		expect(evidence[0]?.status).toBe("failed");
		expect(evidence[0]?.failureReason).toBeUndefined();
		expect(existsSync(target)).toBe(false);
	});

	test("structured confirmation requests report a refusal without claiming installation", () => {
		const { home, target } = setup();
		let evidence: HostedSkillEvidence[] = [];
		nativeResponse(home, {
			ok: false,
			error: "Confirmation needed",
			targetMutationStarted: false,
			guard: { decision: "ask", verdict: "caution", trustLevel: "trusted", findingCount: 2 },
		});
		expect(
			projection(home, prepared(skill(), github), (value) => {
				evidence = value;
			}),
		).toEqual({
			errors: [],
			refusals: [
				{
					runtime: "hermes",
					skillKey: "review",
					reason: "guard_confirmation_required",
					verdict: "caution",
					trustLevel: "trusted",
					findingCount: 2,
					retainedPrevious: false,
				},
			],
		});
		expect(existsSync(target)).toBe(false);
		expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
		expect(evidence).toMatchObject([
			{ status: "failed", failureReason: "guard_confirmation_required" },
		]);
	});

	test.each(["caution", "dangerous"])(
		"community %s block produces typed failure evidence",
		(verdict) => {
			const { home, target } = setup();
			let evidence: HostedSkillEvidence[] = [];
			nativeResponse(home, {
				ok: false,
				error: "Blocked (community source + guard verdict)",
				targetMutationStarted: false,
				guard: { decision: "block", verdict, trustLevel: "community", findingCount: 7 },
			});
			expect(
				projection(home, prepared(skill(), project), (value) => {
					evidence = value;
				}),
			).toMatchObject({ errors: [], refusals: [{ reason: "guard_blocked", verdict }] });
			expect(evidence).toMatchObject([
				{
					runtime: "hermes",
					desiredState: "present",
					status: "failed",
					failureReason: "guard_blocked",
				},
			]);
			expect(existsSync(target)).toBe(false);
			expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
		},
	);

	test.each(["hub", "legacy"])(
		"refused updates preserve every byte of a locally modified receipt-owned %s copy",
		(kind) => {
			const { home, target, lock } = setup();
			const sourceDir = skill();
			if (kind === "hub")
				expect(projection(home, prepared(sourceDir, github))).toEqual({ errors: [], refusals: [] });
			else {
				cpSync(sourceDir, target, { recursive: true });
				reserveManagedSkill({
					targetDir: target,
					id: "review",
					manager: "hosted-manifest",
					sourceIdentity: hostedSkillArchiveSourceIdentity("review", github),
				});
				// Establish Hub state before snapshotting; native quarantine initializes it on first use.
				nativePython(
					home,
					"from tools.skills_hub import HubLockFile; lock = HubLockFile(); lock.save(lock.load())",
				);
			}
			writeFileSync(
				join(target, "SKILL.md"),
				"# Locally evolved Review\nKeep the cron workflow.\n",
			);
			writeFileSync(join(target, "references", "guide.md"), "Locally updated instructions.\n");
			writeFileSync(join(target, "assets", "sample.png"), Buffer.from([0, 255, 17, 128, 0]));
			mkdirSync(join(target, "scripts"));
			writeFileSync(join(target, "scripts", "cron.py"), "print('local workflow')\n");
			const before = collectManagedSkillTree(target);
			expect(before.status).toBe("collected");
			const ledger = readFileSync(managedSkillReservationLedgerPath());
			const hubLock = existsSync(lock) ? readFileSync(lock) : null;
			expect(projection(home, prepared(skill(dangerousFiles, "refused"), project))).toMatchObject({
				errors: [],
				refusals: [{ skillKey: "review", reason: "guard_blocked", retainedPrevious: true }],
			});
			expect(collectManagedSkillTree(target)).toEqual(before);
			expect(readFileSync(managedSkillReservationLedgerPath())).toEqual(ledger);
			expect(existsSync(lock) ? readFileSync(lock) : null).toEqual(hubLock);
			expect(shouldIgnoreUserSkill(target)).toBe(true);
			expect(projection(home)).toEqual({ errors: [], refusals: [] });
			expect(existsSync(target)).toBe(false);
			expect(readHostedHermesSkillRecords(home).review).toBeUndefined();
			expect(shouldIgnoreUserSkill(target)).toBe(false);
		},
	);

	test("confirmation refusal preserves a locally modified managed copy and its receipts", () => {
		const { home, target, lock } = setup();
		expect(projection(home, prepared(skill(), github))).toEqual({ errors: [], refusals: [] });
		writeFileSync(join(target, "SKILL.md"), "# Locally evolved Review\n");
		writeFileSync(join(target, "assets", "sample.png"), Buffer.from([255, 0, 128]));
		const before = collectManagedSkillTree(target);
		expect(before.status).toBe("collected");
		const ledger = readFileSync(managedSkillReservationLedgerPath());
		const hubLock = readFileSync(lock);
		nativeResponse(home, {
			ok: false,
			error: "Confirmation needed",
			targetMutationStarted: false,
			guard: { decision: "ask", verdict: "caution", trustLevel: "trusted", findingCount: 2 },
		});
		expect(projection(home, prepared(skill(safeFiles, "ask-update"), project))).toEqual({
			errors: [],
			refusals: [
				{
					runtime: "hermes",
					skillKey: "review",
					reason: "guard_confirmation_required",
					verdict: "caution",
					trustLevel: "trusted",
					findingCount: 2,
					retainedPrevious: true,
				},
			],
		});
		expect(collectManagedSkillTree(target)).toEqual(before);
		expect(readFileSync(managedSkillReservationLedgerPath())).toEqual(ledger);
		expect(readFileSync(lock)).toEqual(hubLock);
	});

	test("guard refusal leaves pinned legacy Skills alone and unlink still respects pinning", () => {
		const { home, target } = setup();
		cpSync(skill(), target, { recursive: true });
		reserveManagedSkill({
			targetDir: target,
			id: "review",
			manager: "hosted-manifest",
			sourceIdentity: hostedSkillArchiveSourceIdentity("review", github),
		});
		nativePython(home, 'from tools.skill_usage import set_pinned; set_pinned("review", True)');
		const result = projection(home, prepared(skill(dangerousFiles, "refused"), project));
		expect(result.errors).toEqual([]);
		expect(result.refusals).toMatchObject([{ skillKey: "review", retainedPrevious: true }]);
		expect(existsSync(target)).toBe(true);
		expect(shouldIgnoreUserSkill(target)).toBe(true);
		expect(projection(home).errors.join("\n")).toContain("pinned");
		expect(existsSync(target)).toBe(true);
		nativePython(home, 'from tools.skill_usage import set_pinned; set_pinned("review", False)');
		expect(projection(home)).toEqual({ errors: [], refusals: [] });
		expect(existsSync(target)).toBe(false);
	});

	test("a refusal retains an earlier pending receipt until normal unlink recovery", () => {
		const { home, target } = setup();
		expect(projection(home, prepared(skill(), github))).toEqual({ errors: [], refusals: [] });
		const next = prepared(skill(dangerousFiles, "pending-refusal"), project);
		const identity = next.identity;
		if (!("sourceIdentity" in identity)) throw new Error("missing sourced identity");
		expect(() =>
			installReservedManagedSkill(
				{
					targetDir: target,
					id: "review",
					manager: "hosted-manifest",
					digest: identity.digest,
					sourceIdentity: identity.sourceIdentity,
				},
				() => {
					throw new ManagedSkillResourceError("interrupted native install");
				},
				{
					verify: () => false,
					discard: () => {
						throw new Error("must retain pending ownership");
					},
					nativeMutation: true,
				},
			),
		).toThrow("interrupted native install");
		const before = collectManagedSkillTree(target);
		expect(before.status).toBe("collected");
		const ledger = readFileSync(managedSkillReservationLedgerPath());
		expect(projection(home, next)).toMatchObject({
			errors: [],
			refusals: [{ retainedPrevious: true }],
		});
		expect(collectManagedSkillTree(target)).toEqual(before);
		expect(readFileSync(managedSkillReservationLedgerPath())).toEqual(ledger);
		expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(1);
		expect(projection(home)).toEqual({ errors: [], refusals: [] });
		expect(existsSync(target)).toBe(false);
		expect(shouldIgnoreUserSkill(target)).toBe(false);
		expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
	});

	test("logs each refused Skill once per state change and clears on unlink", () => {
		const { home } = setup();
		projection(home);
		const warning = spyOn(log, "warn").mockImplementation(() => {});
		try {
			const bundle = prepared(skill(dangerousFiles), github);
			projection(home, bundle);
			projection(home, bundle);
			expect(warning).toHaveBeenCalledTimes(1);
			const next = prepared(skill(dangerousFiles, "next"), { ...github, commit: "c".repeat(40) });
			projection(home, next);
			expect(warning).toHaveBeenCalledTimes(2);
			projection(home);
			projection(home, next);
			expect(warning).toHaveBeenCalledTimes(3);
			expect(warning.mock.calls[0]).toEqual([
				"runtime.skill.guard_refused",
				{
					runtime: "hermes",
					skill: "review",
					reason: "guard_blocked",
					verdict: "dangerous",
					trust_level: "community",
					finding_count: expect.any(Number),
					retained_previous: false,
				},
			]);
		} finally {
			warning.mockRestore();
		}
	});

	test("reconciles a new commit with identical bytes and recreates a missing native record", () => {
		const { home, target, lock } = setup();
		const sourceDir = skill();
		const first = prepared(sourceDir, github);
		expect(projection(home, first)).toEqual({ errors: [], refusals: [] });
		const next = prepared(sourceDir, { ...github, commit: "c".repeat(40) });
		expect(projection(home, next)).toEqual({ errors: [], refusals: [] });
		expect(readHostedHermesSkillRecords(home).review).toMatchObject({
			metadata: {
				clawdi_source_identity:
					"sourceIdentity" in next.identity ? next.identity.sourceIdentity : "",
			},
		});
		rmSync(lock);
		expect(hostedHermesSkillSourceMatches(home, target, github)).toBe(false);
		expect(projection(home, next)).toEqual({ errors: [], refusals: [] });
		expect(readHostedHermesSkillRecords(home).review).toBeDefined();
		// Steady-state verification must not require a Python process.
		rmSync(join(home, ".hermes", "hermes-agent", "venv"));
		expect(projection(home, next)).toEqual({ errors: [], refusals: [] });
	});

	test("a first native install failure keeps the target fenced until retry", () => {
		const { home, target, lock } = setup();
		const sourceDir = skill();
		activateHostedHermesSkill({
			home,
			sourceDir,
			targetDir: join(dirname(target), "sibling"),
			source: github,
		});
		const bundle = prepared(sourceDir, github);
		chmodSync(lock, 0o444);
		try {
			expect(projection(home, bundle).errors.join("\n")).toContain("PermissionError");
		} finally {
			chmodSync(lock, 0o644);
		}
		expect(existsSync(target)).toBe(true);
		expect(readHostedHermesSkillRecords(home).review).toBeUndefined();
		expect(shouldIgnoreUserSkill(target)).toBe(true);
		expect(projection(home, bundle)).toEqual({ errors: [], refusals: [] });
		expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
	});

	test("broken Hub JSON fails before mutation and keeps unrelated native records", () => {
		const { home, target, lock } = setup();
		const sourceDir = skill();
		activateHostedHermesSkill({ home, sourceDir, targetDir: target, source: github });
		const sibling = join(dirname(target), "sibling");
		activateHostedHermesSkill({ home, sourceDir, targetDir: sibling, source: github });
		const siblingRecord = readHostedHermesSkillRecords(home).sibling;
		const intact = readFileSync(lock);
		const torn = intact.subarray(0, intact.length - 5);
		writeFileSync(lock, torn);
		expect(() =>
			activateHostedHermesSkill({
				home,
				sourceDir: skill({ "SKILL.md": "# Updated\n" }, "updated"),
				targetDir: target,
				source: github,
			}),
		).toThrow("lock is unreadable or invalid");
		expect(() =>
			removeHostedHermesSkill(home, target, [hostedSkillArchiveSourceIdentity("review", github)]),
		).toThrow("lock is unreadable or invalid");
		expect(readFileSync(lock)).toEqual(torn);
		expect(managedSkillTargetMatchesSource(sourceDir, target)).toBe(true);
		// Repair the deliberately corrupted fixture, then retry through native install.
		writeFileSync(lock, intact);
		activateHostedHermesSkill({ home, sourceDir, targetDir: target, source: github });
		expect(readHostedHermesSkillRecords(home).sibling).toEqual(siblingRecord);
	});

	test.each(["retry", "absent", "replacement"])(
		"intact-lock write failure converges when desired becomes %s",
		(desired) => {
			const { home, target, lock } = setup();
			const first = prepared(skill(), github);
			expect(projection(home, first)).toEqual({ errors: [], refusals: [] });
			const before = readFileSync(lock);
			const next = prepared(skill({ "SKILL.md": "# Review updated\n" }, "updated"), project);
			chmodSync(lock, 0o444);
			try {
				expect(projection(home, next).errors.join("\n")).toContain("PermissionError");
			} finally {
				chmodSync(lock, 0o644);
			}
			expect(readFileSync(lock)).toEqual(before);
			expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review updated\n");
			expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(1);
			const final = desired === "absent" ? undefined : desired === "replacement" ? first : next;
			expect(projection(home, final)).toEqual({ errors: [], refusals: [] });
			expect(pendingManagedSkillReservations("hosted-manifest")).toHaveLength(0);
			expect(existsSync(target)).toBe(desired !== "absent");
			if (final && final.identity.source.type !== "bundled")
				expect(hostedHermesSkillSourceMatches(home, target, final.identity.source)).toBe(true);
		},
	);

	test("migrates owned local files through scanning, and removes dangerous legacy files with native local delete", () => {
		const { home, target } = setup();
		const sourceDir = skill();
		cpSync(sourceDir, target, { recursive: true });
		reserveManagedSkill({
			targetDir: target,
			id: "review",
			manager: "hosted-manifest",
			sourceIdentity: hostedSkillArchiveSourceIdentity("review", github),
		});
		expect(projection(home, prepared(sourceDir, github))).toEqual({ errors: [], refusals: [] });
		expect(readHostedHermesSkillRecords(home).review).toBeDefined();
		expect(projection(home)).toEqual({ errors: [], refusals: [] });
		cpSync(skill(dangerousFiles, "legacy"), target, { recursive: true });
		reserveManagedSkill({
			targetDir: target,
			id: "review",
			manager: "hosted-manifest",
			sourceIdentity: hostedSkillArchiveSourceIdentity("review", github),
		});
		expect(projection(home)).toEqual({ errors: [], refusals: [] });
		expect(existsSync(target)).toBe(false);
		expect(readHostedHermesSkillRecords(home).review).toBeUndefined();
	});

	test("preserves a native replacement and honors pinned local deletion refusal", () => {
		const { home, target } = setup();
		expect(projection(home, prepared(skill(), github))).toEqual({ errors: [], refusals: [] });
		activateHostedHermesSkill({
			home,
			sourceDir: skill({ "SKILL.md": "# Native replacement\n" }, "replacement"),
			targetDir: target,
			source: project,
			ownedSourceIdentities: [hostedSkillArchiveSourceIdentity("review", github)],
		});
		expect(projection(home).errors.join("\n")).toContain("replaced by another source");
		expect(projection(home, prepared(skill(), github)).errors.join("\n")).toContain(
			"replaced by another source",
		);
		expect(existsSync(target)).toBe(true);
		removeHostedHermesSkill(home, target, [hostedSkillArchiveSourceIdentity("review", project)]);
		cpSync(skill(dangerousFiles, "pinned"), target, { recursive: true });
		nativePython(home, 'from tools.skill_usage import set_pinned; set_pinned("review", True)');
		expect(projection(home).errors.join("\n")).toContain("pinned");
		expect(existsSync(target)).toBe(true);
		expect(existsSync(managedSkillReservationLedgerPath())).toBe(true);
	});
});
