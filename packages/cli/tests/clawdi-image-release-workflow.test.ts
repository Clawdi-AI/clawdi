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
	with?: Record<string, unknown>;
}

interface WorkflowJob {
	concurrency?: unknown;
	if?: string;
	needs?: string;
	steps?: WorkflowStep[];
}

interface WorkflowDocument {
	concurrency?: Record<string, unknown>;
	jobs: Record<string, WorkflowJob>;
	on?: {
		push?: { branches?: string[]; paths?: string[] };
		workflow_run?: { branches?: string[]; types?: string[]; workflows?: string[] };
		workflow_dispatch?: {
			inputs?: Record<string, { description?: string }>;
		};
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
const backendDockerfile = readFileSync(
	resolve(import.meta.dir, "../../../backend/Dockerfile"),
	"utf8",
);
const backendMainSource = readFileSync(
	resolve(import.meta.dir, "../../../backend/app/main.py"),
	"utf8",
);
const channelWorkerSource = readFileSync(
	resolve(import.meta.dir, "../../../backend/app/workers/channels.py"),
	"utf8",
);
const deployConfigSource = readFileSync(
	resolve(import.meta.dir, "../../../config/deploy.yml"),
	"utf8",
);
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

	test("builds a started release from its exact successful Backend CI head SHA", () => {
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
		const buildCheckout = imageRelease.jobs.build?.steps?.find(
			(step) => step.uses === "actions/checkout@v7",
		);
		expect(buildCheckout?.with?.ref).toBe(`\${{ steps.source-ref.outputs.ref }}`);
		expect(imageRelease.jobs.build?.steps?.find((step) => step.id === "rev")?.run).toContain(
			"git rev-parse HEAD",
		);
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

		const deployCheckout = imageRelease.jobs["deploy-vps"]?.steps?.find(
			(step) => step.uses === "actions/checkout@v7",
		);
		expect(deployCheckout?.with?.ref).toBe(`\${{ needs.build.outputs.image_tag }}`);
		expect(imageReleaseSource).toContain(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);
	});

	test("uses one official non-canceling bounded production queue", () => {
		expect(imageRelease.on).toHaveProperty("workflow_dispatch");
		expect(imageRelease.jobs.build?.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(imageRelease.concurrency).toEqual({
			group: "clawdi-image-release-production",
			"cancel-in-progress": false,
			queue: "max",
		});
		expect(Object.keys(imageRelease.concurrency ?? {}).sort()).toEqual([
			"cancel-in-progress",
			"group",
			"queue",
		]);
		for (const job of Object.values(imageRelease.jobs)) {
			expect(job.concurrency).toBeUndefined();
		}
		expect(imageRelease.jobs["deploy-vps"]?.needs).toBe("build");
		expect(imageRelease.jobs["deploy-vps"]?.if).toBeUndefined();
		expect(imageRelease.on?.workflow_dispatch?.inputs?.ref?.description).toContain(
			"Do not use an older ref while an automatic release is running or pending.",
		);
		expect(releaseRunbook).toMatch(/up to 100 pending runs/);
		expect(releaseRunbook).toMatch(/time each\s+run starts waiting/);
		expect(releaseRunbook).toMatch(/workflow dispatch order is not guaranteed/);
		expect(releaseRunbook).toMatch(
			/Do not dispatch an older ref while an automatic release is running or\s+pending\./,
		);
		expect(releaseRunbook).not.toContain("FIFO");
	});

	test("pins the audited Kamal release and keeps the remote deploy lock fail-fast", () => {
		const kamalDeploy = imageRelease.jobs["deploy-vps"]?.steps?.find(
			(step) => step.name === "Kamal deploy",
		);
		expect(kamalDeploy?.run).toContain("gem install kamal -v '2.12.0' --no-document");
		expect(kamalDeploy?.run).toContain('test "$(kamal version)" = "2.12.0"');
		expect(kamalDeploy?.run).toContain(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);
		expect(imageReleaseSource).not.toContain("~> 2.12");
		expect(imageReleaseSource).not.toContain("--lock-wait");
		expect(deployConfigSource).toMatch(/^minimum_version: 2\.12\.0$/m);
	});

	test("wires Docker health to API and channels-worker readiness", () => {
		expect(backendDockerfile).toContain("ca-certificates curl");
		expect(backendDockerfile).toContain(
			"HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=8",
		);
		expect(backendDockerfile).toContain(
			'CMD ["curl", "--fail", "--silent", "--show-error", "--max-time", "4", "http://127.0.0.1:8000/health"]',
		);
		expect(deployConfigSource).toMatch(/servers:\n[\s\S]*?channels-worker:\n[\s\S]*?proxy: false/);
		expect(deployConfigSource).toMatch(/healthcheck:\n\s+path: \/health/);
		expect(deployConfigSource).toMatch(/^deploy_timeout: 120\b/m);
		expect(backendMainSource).toContain('@app.get("/health"');
		expect(backendMainSource).toContain('await db.execute(text("SELECT 1"))');
		expect(channelWorkerSource).toContain("return self.ready and not self.stopping");
		expect(channelWorkerSource).toMatch(
			/workers = build_channel_workers\(\)\n\s+if health is not None:\n\s+health\.ready = True/,
		);
		expect(releaseRunbook).toContain("every migration must use an");
		expect(releaseRunbook).toContain("expand/contract sequence");
	});
});
