import {
	settingsPanelHeaderClasses as header,
	settingsSectionClasses as section,
} from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { HeaderActionGroup } from "@/components/header-action-group";
import { Separator } from "@/components/ui/separator";
import { WebText, WebView } from "@/components/ui/web-layout";
import { NativeHeader } from "@/platform/navigation/native-header";
import type { HeaderAction, HeaderMenu } from "@/platform/navigation/native-header-types";

export function SettingsPanelHeader({
	title,
	description,
	actions,
	headerActions,
	headerMenu,
}: {
	title: string;
	description?: ReactNode;
	/** Web's in-panel action group (filters); `headerActions` go to the native header. */
	actions?: ReactNode;
	headerActions?: HeaderAction[];
	headerMenu?: HeaderMenu;
}) {
	return (
		<WebView recipe={header.header}>
			<WebView recipe={header.copy}>
				{description ? <WebText recipe={header.description}>{description}</WebText> : null}
			</WebView>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
			<NativeHeader title={title} actions={headerActions} menu={headerMenu} />
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
