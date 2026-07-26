import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cloudDeploymentManagementGate } from "@/hosted/cloud-deployment-management";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

describe("cloudDeploymentManagementGate", () => {
	test("keeps existing deployment management visible when new deploys are disabled", () => {
		expect(
			cloudDeploymentManagementGate({
				canCreateCloudAgents: false,
				deployments: [hostedDeploymentFixture({ id: "dep_existing" })],
			}),
		).toEqual({
			showExistingManagement: true,
			showNewDeploymentSurfaces: false,
		});
	});

	test("hides Cloud surfaces when the rollout is disabled and no deployments exist", () => {
		expect(
			cloudDeploymentManagementGate({
				canCreateCloudAgents: false,
				deployments: [],
			}),
		).toEqual({
			showExistingManagement: false,
			showNewDeploymentSurfaces: false,
		});
	});

	test("shows both creation and existing management when the rollout is enabled", () => {
		expect(
			cloudDeploymentManagementGate({
				canCreateCloudAgents: true,
				deployments: [hostedDeploymentFixture({ id: "dep_existing" })],
			}),
		).toEqual({
			showExistingManagement: true,
			showNewDeploymentSurfaces: true,
		});
	});
});

describe("existing Cloud agent settings access", () => {
	test("passes loaded Cloud membership into settings and keeps billing visible", () => {
		const sidebar = readFileSync(new URL("../components/app-sidebar.tsx", import.meta.url), "utf8");
		const settings = readFileSync(
			new URL("../components/settings-dialog.tsx", import.meta.url),
			"utf8",
		);

		expect(sidebar).toContain("hasExistingCloudAgents={");
		expect(sidebar).toContain('tile.source === "on-clawdi"');
		expect(settings).toContain(
			"hostedAccess.canCreateCloudAgents ||\n\t\t\thasExistingCloudAgents ||",
		);
		expect(settings).toContain("!hasExistingCloudAgents;");
	});
});
