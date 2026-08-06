import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type PublicEndpointListComponent = typeof import("./public-ports-settings").PublicEndpointList;

let publicEndpointList: PublicEndpointListComponent | null = null;

beforeAll(async () => {
	process.env.VITE_CLAWDI_API_URL = "http://localhost:8000";
	process.env.VITE_CLAWDI_DEPLOY_API_URL = "http://localhost:50021";
	process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
	publicEndpointList = (await import("./public-ports-settings")).PublicEndpointList;
});

function renderPublicEndpointList(props: Parameters<PublicEndpointListComponent>[0]): string {
	if (!publicEndpointList) throw new Error("PublicEndpointList was not loaded");
	return renderToStaticMarkup(createElement(publicEndpointList, props));
}

const surfaceSource = readFileSync(new URL("./public-ports-settings.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
const contractsSource = readFileSync(new URL("../billing/contracts.ts", import.meta.url), "utf8");

describe("public HTTP port settings surface", () => {
	test("renders only exact authoritative URLs matched by explicit port", () => {
		const markup = renderPublicEndpointList({
			ports: [3000, 9120],
			endpoints: [
				{ port: 9120, url: "https://server-assigned-two.example" },
				{ port: 9999, url: "https://unrelated.example" },
				{ port: 3000, url: "https://server-assigned-one.example" },
			],
			pending: false,
		});

		expect(markup).toContain("Available URLs");
		expect(markup).toContain('data-public-port="3000" data-public-port-state="available"');
		expect(markup).toContain('href="https://server-assigned-one.example"');
		expect(markup).toContain('data-public-port="9120" data-public-port-state="available"');
		expect(markup).toContain('href="https://server-assigned-two.example"');
		expect(markup).toContain('target="_blank"');
		expect(markup).not.toContain("unrelated.example");
	});

	test("renders pending and unavailable states without synthesizing a hostname", () => {
		const pending = renderPublicEndpointList({ ports: [5173], endpoints: [], pending: true });
		expect(pending).toContain('data-public-port-state="pending"');
		expect(pending).toContain("Configuring…");
		expect(pending).not.toContain("href=");

		const unavailable = renderPublicEndpointList({
			ports: [5173],
			endpoints: [],
			pending: false,
		});
		expect(unavailable).toContain('data-public-port-state="unavailable"');
		expect(unavailable).toContain("Not available yet");
		expect(unavailable).not.toContain("href=");
		expect(`${pending}${unavailable}`).not.toContain("clawdi.dev");
	});

	test("renders a clear authoritative empty state", () => {
		const markup = renderPublicEndpointList({ ports: [], endpoints: [], pending: false });
		expect(markup).toContain("No public HTTP ports configured.");
		expect(markup).not.toContain("data-public-port=");
	});

	test("uses the existing mutation and unsaved-navigation conventions", () => {
		expect(surfaceSource).toContain("useUpdateDeployment()");
		expect(surfaceSource).toContain("update: publicPortsUpdate(validation.ports)");
		expect(surfaceSource).toContain("useUnsavedNavigationState");
		expect(surfaceSource).not.toContain("useBillingClient");
		expect(surfaceSource).not.toContain("fetch(");
	});

	test("uses the generated update request directly", () => {
		expect(contractsSource).toContain(
			'export type DeploymentUpdateRequest = Schemas["V2UpdateDeploymentRequest"];',
		);
		expect(contractsSource).not.toContain('Pick<Schemas["V2HostedConfigRequest"], "public_ports">');
	});

	test("nests public ports inside the existing Compute section and keeps product copy separate", () => {
		const settingsTabSource = detailSource.slice(
			detailSource.indexOf("function HostedAgentSettingsTab"),
			detailSource.indexOf("function LanguageTimezoneSettingsSection"),
		);
		const computeSource = detailSource.slice(
			detailSource.indexOf("function ComputeSettingsSections"),
			detailSource.indexOf("function HostedAgentSettingsTab") >
				detailSource.indexOf("function ComputeSettingsSections")
				? detailSource.indexOf("function HostedAgentSettingsTab")
				: detailSource.length,
		);

		expect(settingsTabSource).not.toContain("PublicPortsSettingsSection");
		expect(computeSource).toContain('title="Compute"');
		expect(computeSource).toContain("<PublicPortsSettingsSection deployment={deployment} />");
		expect(surfaceSource).not.toContain('from "@/components/settings-section"');
		expect(surfaceSource).not.toContain("<SettingsSection");
		expect(surfaceSource).not.toContain("Files");
		expect(surfaceSource).not.toContain("files_endpoint");
		expect(surfaceSource).not.toContain("credentials");
		expect(surfaceSource).not.toContain("clawdi.dev");
	});
});
