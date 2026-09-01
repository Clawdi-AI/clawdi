import type { DesktopAgentType } from "@clawdi/shared/desktop";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Inner.js";
import HermesAgent from "@lobehub/icons/es/HermesAgent/components/Mono.js";
import OpenClaw from "@lobehub/icons/es/OpenClaw/components/Color.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";
import Pi from "@lobehub/icons/es/Pi/components/Mono.js";
import type { ComponentType, SVGProps } from "react";

type BrandIcon = ComponentType<Omit<SVGProps<SVGSVGElement>, "size"> & { size?: number | string }>;

const AGENT_ICONS: Readonly<
	Record<DesktopAgentType, { icon: BrandIcon; scale: number; tone?: "black" | "white" }>
> = {
	claude_code: { icon: ClaudeCode, scale: 0.7 },
	codex: { icon: Codex, scale: 0.7, tone: "white" },
	openclaw: { icon: OpenClaw, scale: 0.75 },
	hermes: { icon: HermesAgent, scale: 0.75, tone: "white" },
	pi: { icon: Pi, scale: 0.65, tone: "black" },
	opencode: { icon: OpenCode, scale: 0.75, tone: "black" },
};

export function AgentBrandIcon({ type }: { type: DesktopAgentType }) {
	const definition = AGENT_ICONS[type];
	const Icon = definition.icon;
	const size = `${definition.scale * 100}%`;
	return (
		<span
			className={`agent-icon${definition.tone ? ` agent-icon-${definition.tone}` : ""}`}
			aria-hidden="true"
		>
			<Icon size={size} style={{ width: size, height: size }} />
		</span>
	);
}
