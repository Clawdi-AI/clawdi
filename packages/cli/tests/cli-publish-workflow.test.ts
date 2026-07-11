import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/cli-publish.yml"),
	"utf8",
);

describe("CLI publish workflow contract", () => {
	test("gates the protected OIDC publish on the reusable Hosted paired smoke", () => {
		const build = workflow.indexOf("  build-immutable-artifact:");
		const smoke = workflow.indexOf("  hosted-paired-smoke:");
		const publish = workflow.indexOf("  publish-paired-artifact-with-oidc:");

		expect(build).toBeGreaterThan(-1);
		expect(smoke).toBeGreaterThan(build);
		expect(publish).toBeGreaterThan(smoke);
		expect(workflow).toContain(
			"uses: Clawdi-AI/clawdi-hosted/.github/workflows/hosted-runtime-paired-smoke.yml@main",
		);
		expect(workflow).toContain("cli_artifact_name: clawdi-cli-release");
		expect(workflow).toContain(
			'echo "cli_tarball_filename=clawdi-$version.tgz" >> "$GITHUB_OUTPUT"',
		);
		expect(workflow).toContain(
			`cli_tarball_filename: \${{ needs['build-immutable-artifact'].outputs.cli_tarball_filename }}`,
		);
		expect(workflow).toContain("needs: [build-immutable-artifact, hosted-paired-smoke]");
		expect(workflow).toContain("environment: npm");
		expect(workflow).toContain("id-token: write");
	});

	test("publishes the paired-smoked tarball exactly once to agent-v2", () => {
		const publishCommands = workflow.match(/npm publish /g) ?? [];

		expect(publishCommands).toHaveLength(1);
		expect(workflow).toContain(
			'npm publish "release/$CLI_TARBALL_FILENAME" --access public --provenance --ignore-scripts --tag agent-v2',
		);
		expect(workflow).toContain("CLI_ARTIFACT_NAME: clawdi-cli-release");
		expect(workflow).toContain(
			`CLI_TARBALL_FILENAME: \${{ needs['build-immutable-artifact'].outputs.cli_tarball_filename }}`,
		);
		expect(workflow).toContain('tarball="$CLI_TARBALL_FILENAME"');
		expect(workflow).toContain(`name: \${{ env.CLI_ARTIFACT_NAME }}`);
		expect(workflow.match(/npm pack /g) ?? []).toHaveLength(1);
		expect(workflow.indexOf("npm pack ")).toBeLessThan(workflow.indexOf("  hosted-paired-smoke:"));
		expect(workflow).not.toContain("agent-v2-candidate");
		expect(workflow).not.toContain("npm dist-tag");
		expect(workflow).not.toContain("NPM_TOKEN");
	});

	test("keeps ordinary pull request CI repo-local", () => {
		expect(workflow).not.toContain("pull_request:");
	});
});
