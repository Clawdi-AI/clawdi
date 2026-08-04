#!/usr/bin/env node

const INPUT_SCHEMA = "clawdi.cliReleaseRecoveryInput.v2";
const OUTPUT_SCHEMA = "clawdi.cliReleaseRecoveryOutput.v2";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GITHUB_REPOSITORY_PATTERN =
	/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;

class ReleaseRecoveryError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function fail(code, message) {
	throw new ReleaseRecoveryError(code, message);
}

function object(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("INVALID_INPUT", `${label} must be an object`);
	}
	return value;
}

function string(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		fail("INVALID_INPUT", `${label} must be a non-empty string`);
	}
	return value;
}

function commit(value, label) {
	const parsed = string(value, label);
	if (!COMMIT_PATTERN.test(parsed)) {
		fail("INVALID_COMMIT", `${label} must be a lowercase 40-character Git commit`);
	}
	return parsed;
}

function packageInput(value) {
	const parsed = object(value, "package");
	const name = string(parsed.name, "package.name");
	const version = string(parsed.version, "package.version");
	if (name !== "clawdi") fail("INVALID_PACKAGE", "package.name must be clawdi");
	if (!SEMVER_PATTERN.test(version)) {
		fail("INVALID_VERSION", "package.version must be an exact semantic version");
	}
	return { name, version };
}

function repositoryInput(value) {
	const parsed = object(value, "repository");
	const url = string(parsed.url, "repository.url");
	const workflowPath = string(parsed.workflowPath, "repository.workflowPath");
	if (!GITHUB_REPOSITORY_PATTERN.test(url)) {
		fail("INVALID_REPOSITORY", "repository.url must be a canonical GitHub HTTPS URL");
	}
	if (!workflowPath.startsWith(".github/workflows/") || !workflowPath.endsWith(".yml")) {
		fail("INVALID_WORKFLOW", "repository.workflowPath must name a YAML workflow");
	}
	return { url, workflowPath };
}

function requiredAssetsInput(value) {
	if (!Array.isArray(value) || value.length === 0) {
		fail("INVALID_ASSETS", "requiredAssets must be a non-empty array");
	}
	const assets = value.map((entry, index) => string(entry, `requiredAssets[${index}]`));
	if (new Set(assets).size !== assets.length) {
		fail("DUPLICATE_ASSET", "requiredAssets contains duplicate names");
	}
	return assets;
}

function integrityDigest(integrity, label) {
	const parsed = string(integrity, label);
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(parsed);
	if (!match) fail("INVALID_INTEGRITY", `${label} must be a sha512 SRI value`);
	const digest = Buffer.from(match[1], "base64");
	if (digest.length !== 64 || digest.toString("base64") !== match[1]) {
		fail("INVALID_INTEGRITY", `${label} must contain one canonical SHA-512 digest`);
	}
	return { integrity: parsed, hex: digest.toString("hex") };
}

function npmInput(value) {
	const parsed = object(value, "npm");
	if (typeof parsed.exists !== "boolean") {
		fail("INVALID_INPUT", "npm.exists must be a boolean");
	}
	if (!parsed.exists) {
		const extra = Object.keys(parsed).filter((key) => key !== "exists");
		if (extra.length > 0) {
			fail("INVALID_NPM_STATE", "npm metadata is forbidden when npm.exists is false");
		}
		return { exists: false };
	}
	return {
		exists: true,
		distIntegrity: string(parsed.distIntegrity, "npm.distIntegrity"),
		attestations: object(parsed.attestations, "npm.attestations"),
		attestationBundle: object(parsed.attestationBundle, "npm.attestationBundle"),
	};
}

function publicationEvidenceInput(value, packageInfo) {
	const parsed = object(value, "publicationEvidence");
	const mode = string(parsed.mode, "publicationEvidence.mode");
	if (mode !== "fresh-publish" && mode !== "existing-version") {
		fail(
			"INVALID_EVIDENCE_MODE",
			"publicationEvidence.mode must be fresh-publish or existing-version",
		);
	}
	const registryVersion = string(parsed.registryVersion, "publicationEvidence.registryVersion");
	if (registryVersion !== packageInfo.version) {
		fail("VERSION_MISMATCH", "registry version does not match the expected package version");
	}
	const allowedKeys =
		mode === "fresh-publish"
			? new Set(["mode", "registryVersion", "distIntegrity"])
			: new Set(["mode", "registryVersion", "distIntegrity", "attestations", "attestationBundle"]);
	const extraKeys = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
	if (extraKeys.length > 0) {
		fail(
			"INVALID_PUBLICATION_EVIDENCE",
			`publicationEvidence contains fields forbidden in ${mode} mode: ${extraKeys.join(", ")}`,
		);
	}
	const evidence = {
		mode,
		registryVersion,
		distIntegrity: string(parsed.distIntegrity, "publicationEvidence.distIntegrity"),
	};
	if (mode === "fresh-publish") return evidence;
	return {
		...evidence,
		attestations: object(parsed.attestations, "publicationEvidence.attestations"),
		attestationBundle: object(parsed.attestationBundle, "publicationEvidence.attestationBundle"),
	};
}

function verifyProvenance(npm, packageInfo, repository, expectedSha512) {
	if (!npm.exists) fail("MISSING_PROVENANCE", "published npm metadata is required");
	const published = integrityDigest(npm.distIntegrity, "npm.distIntegrity");
	if (expectedSha512 && published.hex !== expectedSha512) {
		fail("INTEGRITY_MISMATCH", "npm integrity does not match the local artifact");
	}

	const attestationUrl = string(npm.attestations.url, "npm.attestations.url");
	let parsedUrl;
	try {
		parsedUrl = new URL(attestationUrl);
	} catch {
		fail("INVALID_ATTESTATION_URL", "npm attestation URL is invalid");
	}
	if (parsedUrl.origin !== "https://registry.npmjs.org") {
		fail("INVALID_ATTESTATION_URL", "npm attestation URL must use the npm registry origin");
	}
	if (npm.attestations.provenance?.predicateType !== PROVENANCE_PREDICATE) {
		fail("INVALID_PROVENANCE", "npm metadata does not declare SLSA provenance v1");
	}

	const entries = npm.attestationBundle.attestations;
	if (!Array.isArray(entries)) {
		fail("INVALID_PROVENANCE", "attestation bundle is missing attestations");
	}
	const matchingEntries = entries.filter((entry) => entry?.predicateType === PROVENANCE_PREDICATE);
	if (matchingEntries.length !== 1) {
		fail("INVALID_PROVENANCE", "attestation bundle must contain exactly one SLSA provenance entry");
	}
	const payload = matchingEntries[0]?.bundle?.dsseEnvelope?.payload;
	if (typeof payload !== "string") {
		fail("INVALID_PROVENANCE", "provenance entry is missing its DSSE payload");
	}
	let statement;
	try {
		statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		fail("INVALID_PROVENANCE", "provenance DSSE payload is not valid JSON");
	}

	const expectedSubject = `pkg:npm/${packageInfo.name}@${packageInfo.version}`;
	const subjects = Array.isArray(statement.subject) ? statement.subject : [];
	const subjectMatches = subjects.filter(
		(subject) => subject?.name === expectedSubject && subject?.digest?.sha512 === published.hex,
	);
	if (subjectMatches.length !== 1) {
		fail("SUBJECT_MISMATCH", "provenance subject does not match the published package");
	}

	const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
	if (workflow?.repository !== repository.url || workflow?.path !== repository.workflowPath) {
		fail("WORKFLOW_MISMATCH", "provenance workflow identity does not match this repository");
	}
	const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
	if (!Array.isArray(dependencies)) {
		fail("SOURCE_COMMIT_MISSING", "provenance does not resolve repository source");
	}
	const prefix = `git+${repository.url}@`;
	const sourceCommits = dependencies
		.filter((dependency) => dependency?.uri?.startsWith(prefix))
		.map((dependency) => dependency?.digest?.gitCommit)
		.filter((value) => typeof value === "string");
	const uniqueCommits = [...new Set(sourceCommits)];
	if (uniqueCommits.length !== 1 || !COMMIT_PATTERN.test(uniqueCommits[0])) {
		fail("SOURCE_COMMIT_INVALID", "provenance must resolve exactly one valid source commit");
	}
	return { sourceCommit: uniqueCommits[0], published };
}

function githubInput(value) {
	const parsed = object(value, "github");
	const tagCommit = parsed.tagCommit === null ? null : commit(parsed.tagCommit, "github.tagCommit");
	if (parsed.release === null) return { release: null, tagCommit };
	const release = object(parsed.release, "github.release");
	if (typeof release.isDraft !== "boolean") {
		fail("INVALID_INPUT", "github.release.isDraft must be a boolean");
	}
	if (!Array.isArray(release.assets)) {
		fail("INVALID_INPUT", "github.release.assets must be an array");
	}
	return {
		release: {
			isDraft: release.isDraft,
			targetCommitish: commit(release.targetCommitish, "github.release.targetCommitish"),
			assets: release.assets.map((value, index) => {
				const asset = object(value, `github.release.assets[${index}]`);
				if (!Number.isInteger(asset.size) || asset.size < 0) {
					fail(
						"INVALID_ASSET",
						`github.release.assets[${index}].size must be a non-negative integer`,
					);
				}
				return {
					name: string(asset.name, `github.release.assets[${index}].name`),
					size: asset.size,
				};
			}),
		},
		tagCommit,
	};
}

function releaseState(github, requiredAssets, sourceCommit) {
	if (github.tagCommit && github.tagCommit !== sourceCommit) {
		fail("TAG_TARGET_MISMATCH", "release tag does not match the provenance source commit");
	}
	if (!github.release) return "absent";
	if (github.release.targetCommitish !== sourceCommit) {
		fail("RELEASE_TARGET_MISMATCH", "GitHub release does not match the provenance source commit");
	}

	const assets = new Map();
	for (const asset of github.release.assets) {
		if (assets.has(asset.name)) {
			fail("DUPLICATE_ASSET", `GitHub release contains duplicate asset ${asset.name}`);
		}
		assets.set(asset.name, asset.size);
	}
	const incomplete = requiredAssets.filter((name) => !assets.has(name) || assets.get(name) === 0);
	if (github.release.isDraft) return "draft";
	if (incomplete.length > 0) {
		fail(
			"PUBLISHED_RELEASE_INCOMPLETE",
			`published release is missing complete assets: ${incomplete.join(", ")}`,
		);
	}
	return "published-complete";
}

function commonInput(input) {
	if (input.schemaVersion !== INPUT_SCHEMA) {
		fail("INVALID_SCHEMA", `schemaVersion must be ${INPUT_SCHEMA}`);
	}
	if (input.mode !== "plan" && input.mode !== "complete") {
		fail("INVALID_MODE", "mode must be plan or complete");
	}
	return {
		mode: input.mode,
		packageInfo: packageInput(input.package),
		repository: repositoryInput(input.repository),
		requiredAssets: requiredAssetsInput(input.requiredAssets),
		github: githubInput(input.github),
	};
}

function plan(input, common) {
	const currentCommit = commit(input.currentCommit, "currentCommit");
	const npm = npmInput(input.npm);
	const provenance = npm.exists
		? verifyProvenance(npm, common.packageInfo, common.repository)
		: null;
	const sourceCommit = provenance?.sourceCommit ?? currentCommit;
	const state = releaseState(common.github, common.requiredAssets, sourceCommit);
	if (!npm.exists && state === "published-complete") {
		fail("RELEASE_WITHOUT_PACKAGE", "published GitHub release exists without the npm package");
	}
	const shouldRelease = !(npm.exists && state === "published-complete");
	return {
		schemaVersion: OUTPUT_SCHEMA,
		mode: "plan",
		version: common.packageInfo.version,
		npmTag: common.packageInfo.version.includes("-") ? "beta" : "latest",
		releaseTag: `clawdi-cli-v${common.packageInfo.version}`,
		tarballFilename: `clawdi-${common.packageInfo.version}.tgz`,
		shouldRelease,
		sourceCommit,
		npmAction: shouldRelease ? (npm.exists ? "verify" : "publish") : "none",
		releaseState: state,
	};
}

function complete(input, common) {
	const expectedSourceCommit = commit(input.expectedSourceCommit, "expectedSourceCommit");
	const localArtifact = object(input.localArtifact, "localArtifact");
	const localIntegrity = integrityDigest(localArtifact.integrity, "localArtifact.integrity");
	const localSha512 = string(localArtifact.sha512, "localArtifact.sha512");
	if (!/^[0-9a-f]{128}$/.test(localSha512) || localSha512 !== localIntegrity.hex) {
		fail("LOCAL_INTEGRITY_MISMATCH", "local artifact integrity and SHA-512 digest disagree");
	}
	const publicationEvidence = publicationEvidenceInput(
		input.publicationEvidence,
		common.packageInfo,
	);
	const published = integrityDigest(
		publicationEvidence.distIntegrity,
		"publicationEvidence.distIntegrity",
	);
	if (published.hex !== localSha512) {
		fail("INTEGRITY_MISMATCH", "npm integrity does not match the local artifact");
	}
	const provenance =
		publicationEvidence.mode === "existing-version"
			? verifyProvenance(
					{ exists: true, ...publicationEvidence },
					common.packageInfo,
					common.repository,
					localSha512,
				)
			: null;
	const sourceCommit = provenance?.sourceCommit ?? expectedSourceCommit;
	if (sourceCommit !== expectedSourceCommit) {
		fail(
			"SOURCE_COMMIT_MISMATCH",
			"published provenance does not match the expected source commit",
		);
	}
	const state = releaseState(common.github, common.requiredAssets, sourceCommit);
	return {
		schemaVersion: OUTPUT_SCHEMA,
		mode: "complete",
		evidenceMode: publicationEvidence.mode,
		version: common.packageInfo.version,
		releaseTag: `clawdi-cli-v${common.packageInfo.version}`,
		releaseTarget: sourceCommit,
		releaseState: state,
		releaseAction:
			state === "absent" ? "create-draft" : state === "draft" ? "resume-draft" : "none",
		finalize: state !== "published-complete",
	};
}

async function main() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	let input;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		fail("INVALID_JSON", "stdin must contain one JSON object");
	}
	const parsedInput = object(input, "input");
	const common = commonInput(parsedInput);
	const output = common.mode === "plan" ? plan(parsedInput, common) : complete(parsedInput, common);
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

try {
	await main();
} catch (error) {
	if (error instanceof ReleaseRecoveryError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
