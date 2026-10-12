import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface Step {
	name?: string;
	uses?: string;
	if?: string;
	with?: Record<string, unknown>;
	run?: string;
}

interface Workflow {
	on: Record<string, { paths?: string[] }>;
	jobs: Record<
		string,
		{
			needs?: string[];
			if?: string;
			env?: Record<string, string>;
			strategy?: { "max-parallel"?: number };
			steps?: Step[];
		}
	>;
}

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workflow = (name: string) => parse(read(`.github/workflows/${name}.yml`)) as Workflow;

describe("CI routing and coverage", () => {
	test("keeps PR packaging and release builds without duplicate main push packaging", () => {
		const platforms = workflow("desktop-platforms");
		expect(platforms.on.pull_request?.paths).toContain("apps/desktop/**");
		expect(platforms.on.pull_request?.paths).toContain("scripts/build-desktop-dmg.sh");
		expect(platforms.on.push).toBeUndefined();
		expect(platforms.jobs.package?.strategy?.["max-parallel"]).toBeUndefined();
		expect(platforms.on.workflow_dispatch).toBeDefined();
		const release = workflow("desktop-channel-build");
		expect(release.on.workflow_dispatch).toBeDefined();
		expect(release.jobs.macos?.if).toBe("github.ref == 'refs/heads/main'");
	});

	test("keeps live drift visible without making PR required checks wait on the deployment", () => {
		const client = workflow("client-ci");
		expect(
			client.jobs["deploy-contract-drift"]?.steps?.some(
				(step) => step.run === "scripts/check-deploy-generated-api.sh",
			),
		).toBe(true);
		expect(client.jobs["ci-ok"]?.needs).not.toContain("deploy-contract-drift");
		expect(client.jobs["ci-ok"]?.needs).toContain("deploy-contract-drift-daily");
		expect(client.jobs["ci-ok"]?.if).toBe("always()");
		expect(client.jobs["ci-ok"]?.steps?.[0]?.if).toBe(
			"contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')",
		);
	});

	test("checks out the exact native Hermes fixture pin and supplies it to the CLI tests", () => {
		const verify = workflow("client-ci").jobs.verify;
		const checkout = verify?.steps?.find(
			(step) => step.with?.repository === "NousResearch/hermes-agent",
		);
		const pin = read("packages/cli/scripts/prepare-hermes-native-fixture.sh").match(
			/^hermes_fixture_commit=([a-f0-9]{40})$/m,
		)?.[1];
		expect(pin).toHaveLength(40);
		expect(checkout?.uses).toBe("actions/checkout@v7");
		expect(checkout?.with?.ref).toBe(pin);
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		expect(verify?.env?.CLAWDI_TEST_HERMES_SOURCE).toBe(
			`\${{ github.workspace }}/${checkout?.with?.path}`,
		);
	});

	test("routes every systemd test and the frozen dependency inputs", () => {
		const paths = workflow("cli-systemd-e2e").on.pull_request?.paths ?? [];
		const commands =
			read("scripts/test-systemd-command.sh") +
			read("scripts/test-runtime-official-installer-systemd.sh");
		const tests = [...new Set(commands.match(/packages\/cli\/[\w/.-]+\.test\.ts/g))];
		expect(tests.length).toBeGreaterThan(0);
		for (const file of tests) {
			expect(
				paths.some((pattern) => new Bun.Glob(pattern).match(file)),
				file,
			).toBe(true);
		}
		for (const file of [
			"bun.lock",
			"package.json",
			"packages/shared/package.json",
			"patches/libsignal@6.0.0.patch",
		]) {
			expect(
				paths.some((pattern) => new Bun.Glob(pattern).match(file)),
				file,
			).toBe(true);
		}
	});
});
