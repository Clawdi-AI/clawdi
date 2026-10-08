import type { DesktopAgentType } from "@clawdi/shared/desktop";
import { brandIconTileClasses, entityBrandIconClasses } from "@clawdi/shared/ui";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Inner.js";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Color.js";
import HermesAgent from "@lobehub/icons/es/HermesAgent/components/Mono.js";
import OpenClaw from "@lobehub/icons/es/OpenClaw/components/Color.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";
import Pi from "@lobehub/icons/es/Pi/components/Mono.js";
import { cn } from "cn";
import type { ComponentType, SVGProps } from "react";

type BrandIcon = ComponentType<Omit<SVGProps<SVGSVGElement>, "size"> & { size?: number | string }>;

/** Same treatments as the Web framework icons (apps/web/src/components/entity-brand-icons.ts). */
const AGENT_ICONS: Readonly<
	Record<DesktopAgentType, { icon: BrandIcon; scale: number; glyph?: string; tile?: string }>
> = {
	claude_code: { icon: ClaudeCode, scale: 0.7 },
	codex: { icon: Codex, scale: 0.7, tile: entityBrandIconClasses.whiteTile },
	openclaw: { icon: OpenClaw, scale: 0.75 },
	hermes: {
		icon: HermesAgent,
		scale: 0.75,
		glyph: entityBrandIconClasses.blackGlyph,
		tile: entityBrandIconClasses.whiteTile,
	},
	pi: {
		icon: Pi,
		scale: 0.65,
		glyph: entityBrandIconClasses.whiteGlyph,
		tile: entityBrandIconClasses.blackTile,
	},
	opencode: {
		icon: OpenCode,
		scale: 0.75,
		glyph: entityBrandIconClasses.whiteGlyph,
		tile: entityBrandIconClasses.blackTile,
	},
	dsh: { icon: DeepSeek, scale: 0.75 },
};

export function AgentBrandIcon({ type }: { type: DesktopAgentType }) {
	const definition = AGENT_ICONS[type];
	const Icon = definition.icon;
	const size = `${definition.scale * 100}%`;
	return (
		<span
			aria-hidden="true"
			className={cn("size-8 rounded-md", brandIconTileClasses.root, definition.tile)}
		>
			<Icon
				size={size}
				style={{ width: size, height: size }}
				className={cn(brandIconTileClasses.mark, definition.glyph)}
			/>
		</span>
	);
}
