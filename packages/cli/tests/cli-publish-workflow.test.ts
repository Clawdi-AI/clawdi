import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowJob {
	needs?: unknown;
	permissions?: Record<string, string>;
	steps?: Array<Record<string, unknown>>;
}

interface WorkflowDocument {
	jobs: Record<string, WorkflowJob>;
}

const workflow = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/cli-publish.yml"),
	"utf8",
);
const workflowDocument = parse(workflow) as WorkflowDocument;
const releaseRunbookDoc = readFileSync(
	resolve(import.meta.dir, "../../../docs/runbooks/release.md"),
	"utf8",
);
const cliDevelopmentDoc = readFileSync(
	resolve(import.meta.dir, "../../../docs/cli-development.md"),
	"utf8",
);
const publishManifestChecker = readFileSync(
	resolve(import.meta.dir, "../scripts/check-publish-manifest.mjs"),
	"utf8",
);
const manifestContract = readFileSync(
	resolve(import.meta.dir, "../src/runtime/manifest-contract.ts"),
	"utf8",
);
const cliPackage = JSON.parse(
	readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
) as {
	publishConfig?: { access?: string; tag?: unknown };
	scripts?: Record<string, string>;
};

describe("CLI publish workflow contract", () => {
	test("keeps current-run release decisions inside the protected publish topology", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];

		expect(Object.keys(workflowDocument.jobs)).toEqual([
			"build-immutable-artifact",
			"publish-immutable-artifact-with-oidc",
		]);
		expect(build.permissions).toEqual({ contents: "read" });
		expect(publish.needs).toBe("build-immutable-artifact");
		expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
		expect(build.steps?.find((step) => step.id === "check")?.["working-directory"]).toBe(
			"packages/cli",
		);
		expect(build.steps?.map((step) => step.id).filter(Boolean)).toEqual([
			"check",
			"build_native_release",
			"pack_release",
		]);
		for (const stepId of ["build_native_release", "pack_release"]) {
			expect(build.steps?.find((step) => step.id === stepId)?.["working-directory"]).toBe(
				"packages/cli",
			);
		}
		expect(publish.steps?.map((step) => step.id).filter(Boolean)).toEqual([
			"verify_release",
			"publish",
			"release",
		]);
	});

	test("keeps the protected OIDC publish fully repository-local", () => {
		const build = workflow.indexOf("  build-immutable-artifact:");
		const publish = workflow.indexOf("  publish-immutable-artifact-with-oidc:");
		const buildJob = workflow.slice(build, publish);
		const publishJob = workflow.slice(publish);

		expect(build).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(build);
		expect(buildJob).toContain(
			`runs-on: \${{ vars.CI_RUNNER || 'blacksmith-16vcpu-ubuntu-2404' }}`,
		);
		expect(publishJob).toContain("runs-on: ubuntu-latest");
		expect(publishJob).not.toContain("vars.CI_RUNNER");
		expect(workflow).toContain("needs: build-immutable-artifact");
		expect(workflow).toContain("environment: npm");
		expect(workflow).toContain("id-token: write");
		expect(publishJob).toContain('node-version: "24"');
		expect(publishJob).toContain("npm install --global npm@12.0.2");
		expect(publishJob).toContain('test "$(npm --version)" = "12.0.2"');
		expect(workflow.match(/test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/g)).toHaveLength(2);
		expect(workflow).not.toContain("git checkout --detach");
		expect(workflow).not.toContain("source_commit");
		expect(workflow).not.toContain("Clawdi-AI/clawdi-hosted");
		expect(workflow).not.toContain("uses: Clawdi-AI/");
		expect(workflow).not.toContain("repository_dispatch");
		expect(workflow).not.toContain("workflow_run");
		expect(workflow).not.toContain("repository: Clawdi-AI/");
	});

	test("builds and publishes the same verified tarball exactly once", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		const uploadArtifact = build.steps?.find((step) => step.uses === "actions/upload-artifact@v7");
		const downloadArtifact = publish.steps?.find(
			(step) => step.uses === "actions/download-artifact@v8",
		);
		const publishCommands = workflow.match(/npm publish /g) ?? [];

		expect(uploadArtifact?.with).toEqual({
			name: `\${{ env.CLI_ARTIFACT_NAME }}`,
			path: `\${{ runner.temp }}/clawdi-cli-release/`,
			"if-no-files-found": "error",
			"retention-days": 1,
		});
		expect(downloadArtifact?.with).toEqual({
			name: `\${{ env.CLI_ARTIFACT_NAME }}`,
			path: "release",
		});
		expect(publishCommands).toHaveLength(1);
		expect(workflow).not.toContain("publishConfig");
		expect(workflow).toContain(
			`NPM_TAG: \${{ needs['build-immutable-artifact'].outputs.npm_tag }}`,
		);
		expect(workflow).toContain(
			'npm publish "./release/$CLI_TARBALL_FILENAME" --access public --provenance --ignore-scripts --tag "$NPM_TAG"',
		);
		expect(workflow).toContain("*-*) npm_tag=beta ;;");
		expect(workflow).toContain("*) npm_tag=latest ;;");
		expect(cliPackage.publishConfig).toEqual({ access: "public" });
		expect(publishManifestChecker).toContain(
			'Object.hasOwn(packageJson.publishConfig ?? {}, "tag")',
		);
		expect(publishManifestChecker).toContain(
			"published CLI package must not declare publishConfig.tag",
		);
		expect(workflow).toContain("node scripts/check-publish-manifest.mjs");
		expect(workflow).toContain("CLI_ARTIFACT_NAME: clawdi-cli-release");
		expect(workflow).toContain(
			`CLI_TARBALL_FILENAME: \${{ needs['build-immutable-artifact'].outputs.cli_tarball_filename }}`,
		);
		expect(workflow).toContain('tarball="$CLI_TARBALL_FILENAME"');
		expect(workflow).toContain(`name: \${{ env.CLI_ARTIFACT_NAME }}`);
		expect(workflow).toContain("run: bun run typecheck");
		const testStep = build.steps?.find((step) => step.name === "Test (ephemeral internal suite)");
		expect(testStep).toMatchObject({
			"timeout-minutes": 20,
			run: "bun run --cwd packages/cli test:internal",
		});
		expect(cliPackage.scripts?.["test:internal"]).toContain("--timeout=30000");
		expect(workflow).toContain("- name: Native lifecycle (ephemeral internal suite)");
		expect(workflow.indexOf("- name: Test")).toBeLessThan(
			workflow.indexOf("- name: Build package and native release matrix"),
		);
		expect(workflow).toContain('npm install "$tarball_path" --ignore-scripts --no-audit --no-fund');
		expect(workflow).toContain('sha256sum --check "$tarball.sha256"');
		expect(workflow.match(/npm pack /g) ?? []).toHaveLength(1);
		expect(workflow.indexOf("npm pack ")).toBeLessThan(workflow.indexOf("npm publish "));
		expect(workflow).not.toMatch(/npm dist-tag (?:add|rm)/);
		expect(workflow).not.toContain("npm stage publish");
		expect(workflow).not.toContain("NPM_TOKEN");
	});

	test("publishes only an absent exact version and verifies artifact integrity", () => {
		const publishJob = workflow.slice(workflow.indexOf("  publish-immutable-artifact-with-oidc:"));
		const absenceCheck = publishJob.indexOf("if ! npm_release_visible; then");
		const publishCommand = publishJob.indexOf("npm publish ");
		const visibilityWait = publishJob.indexOf("for attempt in $(seq 1 12); do", publishCommand);
		const versionRead = publishJob.indexOf(
			'registry_version=$(npm view "clawdi@$VERSION" version)',
		);
		const integrityRead = publishJob.indexOf(
			'published_integrity=$(npm view "clawdi@$VERSION" dist.integrity)',
		);

		expect(workflow).toContain('- "packages/cli/package.json"');
		expect(absenceCheck).toBeGreaterThan(-1);
		expect(absenceCheck).toBeLessThan(publishCommand);
		expect(visibilityWait).toBeGreaterThan(publishCommand);
		expect(visibilityWait).toBeLessThan(versionRead);
		expect(versionRead).toBeLessThan(integrityRead);
		expect(publishJob).toContain('test "$registry_version" = "$VERSION"');
		expect(publishJob).toContain('if [ "$published_integrity" != "$local_integrity" ]; then');
		expect(publishJob).toContain(
			'echo "clawdi@$VERSION registry integrity does not match this workflow artifact" >&2',
		);
		expect(workflow).toContain('if [ "$attempt" -lt 12 ]; then sleep 5; fi');
		expect(workflow).toContain(
			'echo "clawdi@$VERSION was not visible in the npm registry after 60 seconds" >&2',
		);
	});

	test("creates or completes only the current commit GitHub release", () => {
		expect(workflow.indexOf("npm publish ")).toBeLessThan(
			workflow.indexOf('release create "$tag"'),
		);
		expect(workflow).toContain('if [ "$tag_commit" != "$GITHUB_SHA" ]; then');
		expect(workflow).toContain("release.targetCommitish !== process.env.EXPECTED_COMMIT");
		expect(workflow).toContain('console.log(release.isDraft ? "resume-draft" : "none")');
		expect(workflow).toContain('gh release upload "$tag"');
		expect(workflow).toContain('--target "$GITHUB_SHA"');
		expect(workflow).toContain("--draft");
		expect(workflow).toContain('gh release edit "$tag" --draft=false');
		expect(workflow.match(/gh release upload /g)).toHaveLength(1);
		expect(workflow.match(/gh release edit "\$tag" --draft=false/g)).toHaveLength(2);
		expect(workflow.match(/release create "\$tag"/g)).toHaveLength(1);
		expect(workflow).toContain('case "$NPM_TAG" in');
		expect(workflow).toContain("args+=(--prerelease)");
		expect(workflow).toContain("latest) ;;");
		expect(workflow).toContain('echo "unsupported npm release tag: $NPM_TAG" >&2');
		expect(workflow).not.toContain("pull_request:");
	});

	test("keeps Hosted production semantics exact-version only", () => {
		for (const surface of [workflow, cliDevelopmentDoc, releaseRunbookDoc, manifestContract]) {
			expect(surface).not.toMatch(/clawdi@agent-v2(?!-)/);
		}
		expect(workflow).toContain("npm install -g clawdi@$VERSION");
		expect(cliDevelopmentDoc).toMatch(
			/explicitly supplies the exact\s+`clawdi@<semver>` package spec/,
		);
		expect(cliDevelopmentDoc).toContain("fails closed when the exact input is missing");
		expect(releaseRunbookDoc).toMatch(/supplies the exact\s+`clawdi@<semver>`\s+package\s+spec/);
		expect(releaseRunbookDoc).toMatch(/fails when the exact spec is\s+missing/);
		for (const surface of [cliDevelopmentDoc, releaseRunbookDoc]) {
			expect(surface).toMatch(/never\s+resolves\s+an\s+npm\s+dist-tag/);
			expect(surface).not.toContain("resolves that candidate");
		}
		expect(manifestContract).toContain("must be clawdi@<exact-semver>");
		expect(workflow).not.toContain("npm view clawdi@agent-v2");
	});
});
