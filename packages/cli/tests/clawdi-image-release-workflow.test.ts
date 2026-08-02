import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
	id?: string;
	if?: string;
	name?: string;
	run?: string;
	uses?: string;
}

interface WorkflowJob {
	if?: string;
	needs?: string;
	steps?: WorkflowStep[];
}

interface WorkflowDocument {
	concurrency?: {
		"cancel-in-progress"?: boolean;
		group?: string;
		queue?: string;
	};
	jobs: Record<string, WorkflowJob>;
	on?: {
		push?: { branches?: string[]; paths?: string[] };
		workflow_run?: { branches?: string[]; types?: string[]; workflows?: string[] };
		workflow_dispatch?: unknown;
	};
}

const backendCiSource = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/backend-ci.yml"),
	"utf8",
);
const backendCi = parse(backendCiSource) as WorkflowDocument;
const imageReleaseSource = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const imageRelease = parse(imageReleaseSource) as WorkflowDocument;
const releaseRunbook = readFileSync(
	resolve(import.meta.dir, "../../../docs/runbooks/release.md"),
	"utf8",
);

describe("backend image release workflow contract", () => {
	test("coalesces main Backend CI only inside its image-input path gate", () => {
		expect(backendCi.on?.push?.branches).toEqual(["main"]);
		expect(backendCi.on?.push?.paths).toEqual(
			expect.arrayContaining([
				"backend/**",
				".dockerignore",
				"packages/shared/src/api/api.generated.ts",
				"package.json",
				"bun.lock",
				".github/workflows/backend-ci.yml",
				".github/workflows/clawdi-image-release.yml",
			]),
		);
		expect(backendCi.on?.push?.paths).not.toContain("**");
		expect(backendCi.on?.push?.paths).not.toContain("apps/web/src/**");
		expect(backendCi.concurrency?.["cancel-in-progress"]).toBe(true);
	});

	test("builds every successful main Backend CI head SHA without a second diff gate", () => {
		expect(imageRelease.on?.workflow_run).toEqual({
			workflows: ["Backend CI"],
			types: ["completed"],
			branches: ["main"],
		});
		expect(imageRelease.jobs.build?.if).toContain(
			"github.event.workflow_run.conclusion == 'success'",
		);
		expect(imageRelease.jobs.build?.if).toContain(
			"github.event.workflow_run.head_branch == 'main'",
		);

		const resolveSourceRef = imageRelease.jobs.build?.steps?.find(
			(step) => step.name === "Resolve source ref",
		);
		expect(resolveSourceRef?.run).toContain(`ref="\${{ github.event.workflow_run.head_sha }}"`);
		expect(imageReleaseSource).not.toContain("git diff-tree");
		expect(imageReleaseSource).not.toContain("runtime-changes");
		expect(imageReleaseSource).not.toContain("build_required");

		const backendBuild = imageRelease.jobs.build?.steps?.find(
			(step) => step.name === "Build and push backend image",
		);
		expect(backendBuild?.if).toBeUndefined();
		expect(imageReleaseSource).toContain(
			`tags: \${{ env.BACKEND_IMAGE_NAME }}:\${{ steps.rev.outputs.sha }}`,
		);
	});

	test("always builds manual dispatches and serializes deploys without stale rollback", () => {
		expect(imageRelease.on).toHaveProperty("workflow_dispatch");
		expect(imageRelease.jobs.build?.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(imageRelease.concurrency).toEqual({
			group: "clawdi-image-release-production",
			"cancel-in-progress": false,
			queue: "max",
		});
		expect(imageRelease.jobs["deploy-vps"]?.needs).toBe("build");
		expect(imageRelease.jobs["deploy-vps"]?.if).toBeUndefined();
		expect(imageReleaseSource).toContain(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);
		expect(releaseRunbook).toMatch(
			/Every successful main `Backend CI` run builds and deploys its exact\s+`workflow_run\.head_sha`\./,
		);
	});
});
