import {
	settingsPanelHeaderClasses as header,
	settingsSectionClasses as section,
} from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { WebText, WebView } from "@/components/ui/web-layout";
import { NativeHeader } from "@/platform/navigation/native-header";

export function SettingsPanelHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<WebView recipe={header.header}>
			<WebView recipe={header.copy}>
				{description ? <WebText recipe={header.description}>{description}</WebText> : null}
			</WebView>
			<NativeHeader title={title} contentActions={actions} />
		</WebView>
	);
}
export function SettingsSection({
	title,
	description,
	children,
	actions,
	destructive = false,
}: {
	title: ReactNode;
	description?: string;
	children?: ReactNode;
	actions?: ReactNode;
	destructive?: boolean;
}) {
	return (
		<WebView recipe={section.root}>
			<Separator />
			<WebView recipe={section.header}>
				<WebView recipe={section.copy}>
					{typeof title === "string" ? (
						<WebText
							recipe={section.title}
							className={destructive ? "text-destructive" : undefined}
						>
							{title}
						</WebText>
					) : (
						<WebView recipe={section.title}>{title}</WebView>
					)}
					{description ? <WebText recipe={section.description}>{description}</WebText> : null}
				</WebView>
				{actions ? (
					<WebView recipe={section.actions} className="flex-row">
						{actions}
					</WebView>
				) : null}
			</WebView>
			{children ? <WebView recipe={section.content}>{children}</WebView> : null}
		</WebView>
	);
}
