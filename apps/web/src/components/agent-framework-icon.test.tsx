import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { FRAMEWORK_BRAND_ICON_IDS } from "@/components/entity-brand-icon-ids";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";

const FRAMEWORKS = {
	openclaw: { label: "OpenClaw", size: "75%" },
	hermes: { label: "Hermes Agent", size: "75%" },
	"claude-code": { label: "Claude Code", size: "70%" },
	codex: { label: "Codex", size: "70%" },
} as const;

describe("AgentFrameworkIcon", () => {
	test("renders all supported framework IDs as accessible official LobeHub SVG components", () => {
		expect(Object.keys(FRAMEWORKS)).toEqual([...FRAMEWORK_BRAND_ICON_IDS]);
		for (const id of FRAMEWORK_BRAND_ICON_IDS) {
			const { label, size } = FRAMEWORKS[id];
			expect(frameworkBrandIcon(id)?.label).toBe(label);
			const markup = renderToStaticMarkup(
				<AgentFrameworkIcon agent={id} pixelSize={40} boxClassName="size-10" />,
			);
			expect(markup).toContain("<svg");
			expect(markup).toContain('role="img"');
			expect(markup).toContain(`aria-label="${label}"`);
			expect(markup).toContain(`<title>${label}</title>`);
			expect(markup).toContain('data-icon-source="lobehub"');
			expect(markup).toContain(`width="${size}"`);
			expect(markup).toContain(`height="${size}"`);
			expect(markup).toContain(`width:${size};height:${size}`);
			expect(markup).not.toContain("<img");
		}
	});

	test("preserves the claude_code wire alias", () => {
		expect(frameworkBrandIcon("claude_code")?.icon).toBe(frameworkBrandIcon("claude-code")?.icon);
	});

	test("keeps the official Hermes black mark on white instead of theme-inverting it", () => {
		const markup = renderToStaticMarkup(
			<AgentFrameworkIcon agent="hermes" pixelSize={40} boxClassName="size-10" />,
		);
		expect(markup).toContain("bg-white");
		expect(markup).toContain("text-black");
	});

	test("keeps colored framework marks on the shared neutral tile without forced dark backplates", () => {
		const openClaw = renderToStaticMarkup(
			<AgentFrameworkIcon agent="openclaw" pixelSize={40} boxClassName="size-10" />,
		);
		const claudeCode = renderToStaticMarkup(
			<AgentFrameworkIcon agent="claude-code" pixelSize={40} boxClassName="size-10" />,
		);
		const codex = renderToStaticMarkup(
			<AgentFrameworkIcon agent="codex" pixelSize={40} boxClassName="size-10" />,
		);
		expect(openClaw).not.toContain("bg-black");
		expect(claudeCode).not.toContain("bg-[#09090B]");
		expect(codex).toContain("bg-white");
	});

	test("keeps custom avatars as object-cover images instead of scaling them like brand marks", () => {
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
		expect(markup).toContain('width="32"');
		expect(markup).toContain('height="32"');
		expect(markup).toContain("object-cover");
		expect(markup).not.toContain("<svg");
		expect(markup).not.toContain('data-icon-source="lobehub"');
	});
});
