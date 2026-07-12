import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/cli-publish.yml"),
	"utf8",
);
const managedRuntimeDoc = readFileSync(
	resolve(import.meta.dir, "../../../docs/managed-runtime.md"),
	"utf8",
);
const cliDevelopmentDoc = readFileSync(
	resolve(import.meta.dir, "../../../docs/cli-development.md"),
	"utf8",
);
const manifestContract = readFileSync(
	resolve(import.meta.dir, "../src/runtime/manifest-contract.ts"),
	"utf8",
);

describe("CLI publish workflow contract", () => {
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
		expect(workflow).toContain(
			'echo "cli_tarball_filename=clawdi-$version.tgz" >> "$GITHUB_OUTPUT"',
		);
		expect(workflow).toContain("needs: build-immutable-artifact");
		expect(workflow).toContain("environment: npm");
		expect(workflow).toContain("id-token: write");
		expect(publishJob).toContain('node-version: "24"');
		expect(publishJob).toContain("npm install --global npm@11.5.1");
		expect(publishJob).toContain('test "$(npm --version)" = "11.5.1"');
		expect(workflow).not.toContain("Clawdi-AI/clawdi-hosted");
		expect(workflow).not.toContain("uses: Clawdi-AI/");
		expect(workflow).not.toContain("repository_dispatch");
		expect(workflow).not.toContain("workflow_run");
		expect(workflow).not.toContain("repository: Clawdi-AI/");
	});

	test("builds and publishes the same verified tarball exactly once", () => {
		const publishCommands = workflow.match(/npm publish /g) ?? [];

		expect(publishCommands).toHaveLength(1);
		expect(workflow).toContain(
			'npm publish "release/$CLI_TARBALL_FILENAME" --access public --provenance --ignore-scripts --tag agent-v2-candidate',
		);
		expect(workflow).toContain("CLI_ARTIFACT_NAME: clawdi-cli-release");
		expect(workflow).toContain(
			`CLI_TARBALL_FILENAME: \${{ needs['build-immutable-artifact'].outputs.cli_tarball_filename }}`,
		);
		expect(workflow).toContain('tarball="$CLI_TARBALL_FILENAME"');
		expect(workflow).toContain(`name: \${{ env.CLI_ARTIFACT_NAME }}`);
		expect(workflow).toContain("run: bun run typecheck");
		expect(workflow).toContain("run: bun test --isolate --max-concurrency=1");
		expect(workflow).toContain('npm install "$tarball_path" --ignore-scripts --no-audit --no-fund');
		expect(workflow).toContain('sha256sum --check "$tarball.sha256"');
		expect(workflow).toContain("sha256sum --check clawdi-cli-linux-x64.tar.gz.sha256");
		expect(workflow.match(/npm pack /g) ?? []).toHaveLength(1);
		expect(workflow.indexOf("npm pack ")).toBeLessThan(workflow.indexOf("npm publish "));
		expect(workflow).not.toMatch(/npm dist-tag (?:add|rm)/);
		expect(workflow).not.toContain("npm stage publish");
		expect(workflow).not.toContain("NPM_TOKEN");
	});

	test("creates the CLI release only after publishing", () => {
		expect(workflow.indexOf("npm publish ")).toBeLessThan(
			workflow.indexOf('release create "$tag"'),
		);
		expect(workflow).not.toContain("pull_request:");
	});

	test("keeps Hosted production semantics exact-version only", () => {
		for (const surface of [workflow, managedRuntimeDoc, cliDevelopmentDoc, manifestContract]) {
			expect(surface).not.toMatch(/clawdi@agent-v2(?!-)/);
		}
		expect(workflow).toContain("npm install -g clawdi@$VERSION");
		expect(managedRuntimeDoc).toContain("exact `clawdi@<semver>` without build metadata");
		expect(managedRuntimeDoc).toContain("Remote fetches cannot use that fixture schema");
		expect(workflow).not.toContain("npm view clawdi@agent-v2");
	});
});
