import { describe, expect, test } from "bun:test";
import { cloudDeploymentManagementGate } from "@/hosted/cloud-deployment-management";

describe("cloudDeploymentManagementGate", () => {
	test("keeps existing deployment management visible when new deploys are disabled", () => {
		expect(
			cloudDeploymentManagementGate({
				canCreateCloudAgents: false,
				deployments: [{ id: "dep_existing" }],
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
				deployments: [{ id: "dep_existing" }],
			}),
		).toEqual({
			showExistingManagement: true,
			showNewDeploymentSurfaces: true,
		});
	});
});
