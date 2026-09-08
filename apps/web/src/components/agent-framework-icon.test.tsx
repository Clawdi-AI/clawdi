import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { FRAMEWORK_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";

const FRAMEWORKS = {
	openclaw: { label: "OpenClaw" },
	hermes: { label: "Hermes Agent" },
	"claude-code": { label: "Claude Code" },
	codex: { label: "Codex" },
	pi: { label: "Pi" },
	opencode: { label: "OpenCode" },
} as const;

describe("AgentFrameworkIcon", () => {
	test("renders all supported framework IDs as accessible official LobeHub SVG components", () => {
		expect(Object.keys(FRAMEWORKS)).toEqual([...FRAMEWORK_BRAND_ICON_IDS]);
		for (const id of FRAMEWORK_BRAND_ICON_IDS) {
			const { label } = FRAMEWORKS[id];
			expect(frameworkBrandIcon(id)?.label).toBe(label);
			const markup = renderToStaticMarkup(
				<AgentFrameworkIcon agent={id} pixelSize={40} boxClassName="size-10" />,
			);
			expect(markup).toContain("<svg");
			expect(markup).toContain('role="img"');
			expect(markup).toContain(`aria-label="${label}"`);
			expect(markup).toContain(`<title>${id === "opencode" ? "opencode" : label}</title>`);
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).not.toContain("<img");
		}
	});

	test("preserves the claude_code wire alias", () => {
		expect(frameworkBrandIcon("claude_code")?.icon).toBe(frameworkBrandIcon("claude-code")?.icon);
	});

	test("renders custom avatars with their accessible label", () => {
		const markup = renderToStaticMarkup(
			<AgentFrameworkIcon
				agent="codex"
				pixelSize={32}
				boxClassName="size-8 rounded-md"
				avatarUrl="https://example.test/avatar.png"
				alt="Custom avatar"
			/>,
		);
		expect(markup).toContain('<img src="https://example.test/avatar.png"');
		expect(markup).toContain('alt="Custom avatar"');
		expect(markup).not.toContain("<svg");
		expect(markup).not.toContain('data-icon-source="lobehub"');
	});
});
