import { describe, expect, test } from "bun:test";
import { resolveAgentProjectResourceContext } from "./agent-project-resource-context";

describe("legacy Agent Project-resource collections", () => {
	const bindings = [
		{ project_id: "primary", binding_type: "primary" as const },
		{ project_id: "context", binding_type: "context" as const },
	];

	test("uses only the unique primary Workspace when legacy context is omitted", () => {
		expect(resolveAgentProjectResourceContext(bindings, null)).toBe("primary");
		expect(resolveAgentProjectResourceContext(bindings, "")).toBe("primary");
		expect(
			resolveAgentProjectResourceContext(
				bindings.filter((binding) => binding.binding_type === "context"),
				null,
			),
		).toBeNull();
		expect(
			resolveAgentProjectResourceContext(
				[...bindings, { project_id: "duplicate-primary", binding_type: "primary" as const }],
				null,
			),
		).toBeNull();
	});

	test("keeps an explicit Project strict to an actual binding", () => {
		expect(resolveAgentProjectResourceContext(bindings, "unbound")).toBeNull();
		expect(resolveAgentProjectResourceContext(bindings, " context ")).toBe("context");
		expect(resolveAgentProjectResourceContext(bindings, " primary ")).toBe("primary");
	});
});
