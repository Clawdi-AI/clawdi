import {
	settingsPanelHeaderClasses as header,
	settingsSectionClasses as section,
} from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { HeaderActionGroup } from "../header-action-group";
import { Separator } from "../separator";
import { WebText, WebView } from "../web-layout";

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
				<WebText accessibilityRole="header" recipe={header.title}>
					{title}
				</WebText>
				{description ? <WebText recipe={header.description}>{description}</WebText> : null}
			</WebView>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
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
		<WebView recipe={section.section}>
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
