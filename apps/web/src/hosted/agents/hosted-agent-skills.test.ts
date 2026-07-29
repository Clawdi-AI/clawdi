import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { components } from "@clawdi/shared/api";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	buildManifestSkillUpdate,
	canonicalManifestSkills,
	manifestSkillConvergence,
} from "./hosted-agent-skills";

type RuntimeObserved = components["schemas"]["AgentRuntimeObservedResponse"];

function runtime(
	status: RuntimeObserved["health"]["status"],
	managedSkills: NonNullable<RuntimeObserved["desired"]>["managed_skills"],
): RuntimeObserved {
	return {
		environment: {
			id: "agent-1",
			name: "agent-1",
			machine_name: "agent-1",
			sort_order: 0,
			agent_type: "openclaw",
			agent_version: null,
			os: "linux",
			last_seen_at: null,
			queue_depth_high_water: 0,
			dropped_count: 0,
			sync_enabled: false,
			explicit_identity: true,
			hosted_managed: true,
			default_project_id: "project-1",
		},
		desired: {
			deployment_id: "deployment-1",
			instance_id: "instance-1",
			desired_config_generation: 4,
			enabled_runtimes: ["openclaw"],
			has_mcp: false,
			has_tools: false,
			managed_skills: managedSkills,
		},
		observed: { observed_config_generation: 4 },
		health: { status, reasons: [] },
		provider_health: [],
	};
}

describe("Hosted manifest Skill configuration", () => {
	test("uses the Hosted-normalized legacy default projection", () => {
		expect(canonicalManifestSkills(hostedDeploymentFixture())).toEqual([
			{ id: "clawdi", enabled: true, version: 1 },
		]);
	});

	test("reads canonical desired state only from deployment.resource.spec.skills", () => {
		const deployment = hostedDeploymentFixture({
			skills: [{ id: "clawdi", enabled: false, version: 1 }],
		});
		expect(canonicalManifestSkills(deployment)).toEqual([
			{ id: "clawdi", enabled: false, version: 1 },
		]);
	});

	test("constructs the complete array and skips same-value requests", () => {
		const current = [{ id: "clawdi", enabled: true, version: 1 }] as const;
		expect(buildManifestSkillUpdate(current, true)).toBeNull();
		expect(buildManifestSkillUpdate(current, false)).toEqual({
			skills: [{ id: "clawdi", enabled: false, version: 1 }],
		});
	});

	test("fails closed instead of constructing malformed public requests", () => {
		expect(() => buildManifestSkillUpdate([], false)).toThrow(
			"Unsupported manifest Skill configuration",
		);

		const duplicate = [
			{ id: "clawdi", enabled: true, version: 1 },
			{ id: "clawdi", enabled: false, version: 1 },
		] as const;
		expect(() => buildManifestSkillUpdate(duplicate, false)).toThrow(
			"Unsupported manifest Skill configuration",
		);

		const unknownId = [{ id: "clawdi", enabled: true, version: 1 }] as const;
		Reflect.set(unknownId[0], "id", "unknown");
		expect(() => buildManifestSkillUpdate(unknownId, false)).toThrow(
			"Unsupported manifest Skill configuration",
		);

		for (const invalidVersion of [0, -1, 1.5, 2]) {
			const unknownVersion = [{ id: "clawdi", enabled: true, version: 1 }] as const;
			Reflect.set(unknownVersion[0], "version", invalidVersion);
			expect(() => buildManifestSkillUpdate(unknownVersion, false)).toThrow(
				"Unsupported manifest Skill configuration",
			);
		}

		const explicitNull = hostedDeploymentFixture();
		Reflect.set(explicitNull.resource.spec, "skills", null);
		expect(() => canonicalManifestSkills(explicitNull)).toThrow(
			"Unsupported manifest Skill configuration",
		);
	});

	test("canonical disable stays pending while runtime desired is stale", () => {
		const canonical = { id: "clawdi", enabled: false, version: 1 } as const;
		const staleRuntime = runtime("ok", [{ id: "clawdi", enabled: true, version: 1 }]);
		expect(manifestSkillConvergence(canonical, staleRuntime, "deployment-1")).toBe("pending");
		expect(buildManifestSkillUpdate([canonical], true)).toEqual({
			skills: [{ id: "clawdi", enabled: true, version: 1 }],
		});
	});

	test("never false-greens stale instance/source/freshness health", () => {
		const canonical = { id: "clawdi", enabled: true, version: 1 } as const;
		for (const status of ["stale", "error", "unknown"] as const) {
			expect(
				manifestSkillConvergence(
					canonical,
					runtime(status, [{ id: "clawdi", enabled: true, version: 1 }]),
					"deployment-1",
				),
			).toBe("pending");
		}
	});

	test("retains disabled entries and treats missing or legacy evidence as ambiguous", () => {
		const disabled = { id: "clawdi", enabled: false, version: 1 } as const;
		expect(manifestSkillConvergence(disabled, runtime("ok", [disabled]), "deployment-1")).toBe(
			"converged",
		);
		expect(manifestSkillConvergence(disabled, runtime("ok", []), "deployment-1")).toBe("pending");
		expect(manifestSkillConvergence(disabled, undefined, "deployment-1")).toBe("unavailable");
	});

	test("keeps matching runtime bytes pending when deployment identity was replaced", () => {
		const canonical = { id: "clawdi", enabled: true, version: 1 } as const;
		expect(
			manifestSkillConvergence(
				canonical,
				runtime("ok", [{ id: "clawdi", enabled: true, version: 1 }]),
				"deployment-2",
			),
		).toBe("pending");
	});

	test("keeps canonical configuration visible when runtime projection is stopped or missing", () => {
		const detail = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
		const tab = readFileSync(new URL("./hosted-agent-skills-tab.tsx", import.meta.url), "utf8");
		expect(detail).toContain('{activeTab === "skills" ? (');
		expect(detail).not.toMatch(
			/activeTab === "skills"[\s\S]{0,200}!deploymentProjectionQueryable[\s\S]{0,100}StoppedAgentState/,
		);
		expect(tab).toContain("canonicalManifestSkills(deployment)");
		expect(tab).toContain("useUpdateDeployment()");
		expect(tab).toContain("deployment.resource.metadata.resourceVersion");
		expect(tab).toContain("projectionAvailable ? (");
		expect(tab).toContain("The manifest Skill remains configurable");
		expect(tab).not.toMatch(/api\.(PUT|PATCH|POST)|HostedRuntimeState/);
		const sidebar = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);
		expect(sidebar).toContain(
			'section.id === "overview" || section.id === "skills" || section.id === "mcp"',
		);
	});
});
