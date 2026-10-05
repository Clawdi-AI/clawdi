import {
	agentIconFallbackClasses,
	agentIconRadiusClasses,
	agentIconSizeClasses,
	agentLabelClasses,
	detailLayoutClasses as detail,
	sessionModelBadgeClasses as model,
	sessionStatClasses as stat,
} from "@clawdi/shared/ui";
import { type AgentIdentityInput, agentIdentity, formatModelLabel } from "@clawdi/shared/view";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { AgentFrameworkIcon } from "../agent-framework-icon";
import { Badge } from "../badge";
import { Icon } from "../icon";
import { Text } from "../text";
import { WebText, WebView, webBoth, webText } from "../web-layout";
export function DetailMeta({ children }: { children: ReactNode }) {
	return <WebView recipe={detail.meta}>{children}</WebView>;
}
export function DetailStats({ children }: { children: ReactNode }) {
	return <WebView recipe={detail.stats}>{children}</WebView>;
}
export function ModelBadge({ modelId }: { modelId?: string | null }) {
	const label = formatModelLabel(modelId);
	return label ? (
		<Badge variant="outline" className={webBoth(model.root)}>
			<Text className={webText(model.root)}>{label}</Text>
		</Badge>
	) : null;
}
export function Stat({ icon, label }: { icon: LucideIcon; label: string }) {
	return (
		<WebView recipe={stat.root}>
			<Icon as={icon} className={webBoth(stat.icon)} />
			<WebText recipe={stat.root}>{label}</WebText>
		</WebView>
	);
}
export function AgentInline({ identity }: { identity: AgentIdentityInput }) {
	return (
		<WebView recipe={agentLabelClasses.inline.root}>
			<AgentFrameworkIcon
				agent={identity.agent_type}
				pixelSize={16}
				boxClassName={webBoth(`${agentIconSizeClasses.xs} ${agentIconRadiusClasses.rounded}`)}
				fallbackIconClassName={webBoth(agentIconFallbackClasses.xs)}
			/>
			<WebText recipe={agentLabelClasses.inline.label}>
				{agentIdentity(identity).primaryLabel}
			</WebText>
		</WebView>
	);
}
