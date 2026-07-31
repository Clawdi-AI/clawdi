import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";

const FRAMEWORKS = {
	openclaw: "OpenClaw",
	hermes: "Hermes Agent",
	"claude-code": "Claude Code",
	codex: "Codex",
} as const;

describe("AgentFrameworkIcon", () => {
	test("renders all supported framework IDs as accessible official LobeHub SVG components", () => {
		for (const [id, label] of Object.entries(FRAMEWORKS)) {
			expect(frameworkBrandIcon(id)?.label).toBe(label);
			const markup = renderToStaticMarkup(
				<AgentFrameworkIcon agent={id} pixelSize={40} boxClassName="size-10" />,
			);
			expect(markup).toContain("<svg");
			expect(markup).toContain('role="img"');
			expect(markup).toContain(`aria-label="${label}"`);
			expect(markup).toContain(`<title>${label}</title>`);
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain('width="72%"');
			expect(markup).toContain('height="72%"');
			expect(markup).not.toContain("<img");
		}
	});

	test("preserves the claude_code wire alias", () => {
		expect(frameworkBrandIcon("claude_code")?.icon).toBe(frameworkBrandIcon("claude-code")?.icon);
	});
});
