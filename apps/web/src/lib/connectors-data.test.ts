import { describe, expect, it } from "bun:test";
import { type ConnectorAvailableApp, resolveConnectedAppMetadataPlan } from "./connectors-data";

function catalogApp(name: string): ConnectorAvailableApp {
	return {
		name,
		display_name: name,
		logo: "",
		description: `${name} connector`,
		auth_type: "oauth",
		connect_disabled: false,
		connect_disabled_reason: null,
	};
}

describe("connected app metadata planning", () => {
	it("uses catalog metadata and only requests active apps missing from the catalog", () => {
		const github = catalogApp("github");
		const plan = resolveConnectedAppMetadataPlan(["github", "slack"], {
			apps: [github, catalogApp("gmail")],
			isLoading: false,
			error: null,
		});

		expect(plan.catalogApps).toEqual([github]);
		expect(plan.missingNames).toEqual(["slack"]);
	});

	it("does not start metadata requests while the first catalog page is loading", () => {
		expect(
			resolveConnectedAppMetadataPlan(["github", "slack"], {
				apps: undefined,
				isLoading: true,
				error: null,
			}),
		).toEqual({ catalogApps: [], missingNames: [] });
	});

	it("falls back to detail requests when catalog loading fails", () => {
		expect(
			resolveConnectedAppMetadataPlan(["github", "slack"], {
				apps: undefined,
				isLoading: false,
				error: new Error("catalog failed"),
			}),
		).toEqual({ catalogApps: [], missingNames: ["github", "slack"] });
	});

	it("keeps using stale catalog data when a background refresh fails", () => {
		const github = catalogApp("github");
		expect(
			resolveConnectedAppMetadataPlan(["github", "slack"], {
				apps: [github],
				isLoading: false,
				error: new Error("catalog refresh failed"),
			}),
		).toEqual({ catalogApps: [github], missingNames: ["slack"] });
	});

	it("preserves existing no-catalog behavior for other callers", () => {
		expect(resolveConnectedAppMetadataPlan(["slack", "github"])).toEqual({
			catalogApps: [],
			missingNames: ["slack", "github"],
		});
	});
});
