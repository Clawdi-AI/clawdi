import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/release-recovery.mjs");
const sourceCommit = "1".repeat(40);
const otherCommit = "2".repeat(40);
const sha512 = "ab".repeat(64);
const integrity = `sha512-${Buffer.from(sha512, "hex").toString("base64")}`;
const requiredAssets = ["clawdi-cli-linux-x64.tar.gz", "clawdi-cli-linux-x64.tar.gz.sha256"];

function provenanceStatement(version = "0.13.10") {
	return {
		subject: [{ name: `pkg:npm/clawdi@${version}`, digest: { sha512 } }],
		predicate: {
			buildDefinition: {
				externalParameters: {
					workflow: {
						repository: "https://github.com/Clawdi-AI/clawdi",
						path: ".github/workflows/cli-publish.yml",
					},
				},
				resolvedDependencies: [
					{
						uri: "git+https://github.com/Clawdi-AI/clawdi@refs/heads/main",
						digest: { gitCommit: sourceCommit },
					},
				],
			},
		},
	};
}

function publishedNpm(version = "0.13.10") {
	return {
		exists: true,
		distIntegrity: integrity,
		attestations: {
			url: "https://registry.npmjs.org/-/npm/v1/attestations/clawdi@0.13.10",
			provenance: { predicateType: "https://slsa.dev/provenance/v1" },
		},
		attestationBundle: {
			attestations: [
				{
					predicateType: "https://slsa.dev/provenance/v1",
					bundle: {
						dsseEnvelope: {
							payload: Buffer.from(JSON.stringify(provenanceStatement(version))).toString("base64"),
						},
					},
				},
			],
		},
	};
}

function completeRelease() {
	return {
		isDraft: false,
		targetCommitish: sourceCommit,
		assets: requiredAssets.map((name) => ({ name, size: 128 })),
	};
}

function planFixture() {
	return {
		schemaVersion: "clawdi.cliReleaseRecoveryInput.v1",
		mode: "plan",
		package: { name: "clawdi", version: "0.13.10" },
		repository: {
			url: "https://github.com/Clawdi-AI/clawdi",
			workflowPath: ".github/workflows/cli-publish.yml",
		},
		currentCommit: otherCommit,
		requiredAssets: [...requiredAssets],
		npm: publishedNpm(),
		github: { release: null, tagCommit: null },
	};
}

function completeFixture() {
	return {
		...planFixture(),
		mode: "complete",
		expectedSourceCommit: sourceCommit,
		localArtifact: { integrity, sha512 },
	};
}

function runRecovery(input: unknown) {
	const result = spawnSync(process.execPath, [script], {
		input: JSON.stringify(input),
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		exitCode: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function expectDecision(input: unknown) {
	const result = runRecovery(input);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("CLI release recovery decision", () => {
	test("plans a first publish from the current commit", () => {
		const fixture = { ...planFixture(), npm: { exists: false } };
		const decision = expectDecision(fixture);

		expect(decision).toMatchObject({
			mode: "plan",
			shouldRelease: true,
			npmAction: "publish",
			releaseState: "absent",
			sourceCommit: otherCommit,
			npmTag: "latest",
		});
	});

	test("derives beta for a prerelease without changing recovery semantics", () => {
		const fixture = planFixture();
		fixture.package.version = "0.13.11-beta.1";
		fixture.npm = publishedNpm("0.13.11-beta.1");
		const decision = expectDecision(fixture);

		expect(decision.npmTag).toBe("beta");
		expect(decision.npmAction).toBe("verify");
		expect(decision.sourceCommit).toBe(sourceCommit);
	});

	test("rejects non-SemVer prerelease identifiers with leading zeroes", () => {
		const fixture = { ...planFixture(), npm: { exists: false } };
		fixture.package.version = "1.2.3-beta.01";

		const result = runRecovery(fixture);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("INVALID_VERSION");
	});

	test("rejects non-canonical GitHub repository URLs", () => {
		for (const url of [
			"https://github.com/Clawdi-AI/clawdi/extra",
			"https://github.com/Clawdi-AI/clawdi?ref=main",
			"https://github.com/Clawdi-AI/clawdi#readme",
		]) {
			const fixture = { ...planFixture(), npm: { exists: false } };
			fixture.repository.url = url;

			const result = runRecovery(fixture);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("INVALID_REPOSITORY");
		}
	});

	test("skips an npm version whose published release is complete", () => {
		const fixture = planFixture();
		fixture.github = { release: completeRelease(), tagCommit: sourceCommit };
		const decision = expectDecision(fixture);

		expect(decision).toMatchObject({
			shouldRelease: false,
			npmAction: "none",
			releaseState: "published-complete",
		});
	});

	test("recovers a published npm version whose GitHub release is absent", () => {
		const decision = expectDecision(planFixture());

		expect(decision).toMatchObject({
			shouldRelease: true,
			npmAction: "verify",
			releaseState: "absent",
			sourceCommit,
		});
	});

	test("resumes a draft for the verified source commit", () => {
		const fixture = completeFixture();
		fixture.github = {
			release: { ...completeRelease(), isDraft: true, assets: [] },
			tagCommit: sourceCommit,
		};
		const decision = expectDecision(fixture);

		expect(decision).toMatchObject({
			releaseAction: "resume-draft",
			releaseTarget: sourceCommit,
			finalize: true,
		});
	});

	test("creates a draft only after validating the published artifact", () => {
		const decision = expectDecision(completeFixture());

		expect(decision).toMatchObject({
			releaseAction: "create-draft",
			releaseTarget: sourceCommit,
			finalize: true,
		});
	});

	test("fails closed on local, published, or provenance integrity drift", () => {
		const fixtures = [completeFixture(), completeFixture(), completeFixture()];
		fixtures[0].localArtifact.sha512 = "cd".repeat(64);
		fixtures[1].npm.distIntegrity = `sha512-${Buffer.from("cd".repeat(64), "hex").toString("base64")}`;
		fixtures[2].npm.attestationBundle.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
			JSON.stringify({ ...provenanceStatement(), subject: [] }),
		).toString("base64");

		for (const fixture of fixtures) {
			const result = runRecovery(fixture);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/INTEGRITY|SUBJECT/);
		}
	});

	test("fails closed when provenance repository, workflow, or source identity drifts", () => {
		const mutations = [
			(statement: ReturnType<typeof provenanceStatement>) => {
				statement.predicate.buildDefinition.externalParameters.workflow.repository =
					"https://github.com/example/fork";
			},
			(statement: ReturnType<typeof provenanceStatement>) => {
				statement.predicate.buildDefinition.externalParameters.workflow.path =
					".github/workflows/other.yml";
			},
			(statement: ReturnType<typeof provenanceStatement>) => {
				statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = otherCommit;
			},
		];

		for (const mutate of mutations) {
			const fixture = completeFixture();
			const statement = provenanceStatement();
			mutate(statement);
			fixture.npm.attestationBundle.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
				JSON.stringify(statement),
			).toString("base64");
			const result = runRecovery(fixture);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/WORKFLOW_MISMATCH|SOURCE_COMMIT_MISMATCH/);
		}
	});

	test("fails closed on mismatched release or tag targets", () => {
		for (const target of ["release", "tag"] as const) {
			const fixture = completeFixture();
			fixture.github = {
				release: { ...completeRelease(), isDraft: true },
				tagCommit: sourceCommit,
			};
			if (target === "release") fixture.github.release.targetCommitish = otherCommit;
			else fixture.github.tagCommit = otherCommit;
			const result = runRecovery(fixture);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/TARGET_MISMATCH/);
		}
	});

	test("fails closed on incomplete or ambiguous published assets", () => {
		const fixtures = [planFixture(), planFixture(), planFixture()];
		fixtures[0].github = {
			release: { ...completeRelease(), assets: completeRelease().assets.slice(0, 1) },
			tagCommit: sourceCommit,
		};
		fixtures[1].github = {
			release: {
				...completeRelease(),
				assets: completeRelease().assets.map((asset, index) =>
					index === 0 ? { ...asset, size: 0 } : asset,
				),
			},
			tagCommit: sourceCommit,
		};
		fixtures[2].github = {
			release: {
				...completeRelease(),
				assets: [...completeRelease().assets, completeRelease().assets[0]],
			},
			tagCommit: sourceCommit,
		};

		for (const fixture of fixtures) {
			const result = runRecovery(fixture);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/PUBLISHED_RELEASE_INCOMPLETE|DUPLICATE_ASSET/);
		}
	});
});
