import { settingsPanelHeaderClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { HeaderActionGroup } from "@/components/header-action-group";

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
		<div data-slot="settings-panel-header" className={settingsPanelHeaderClasses.header}>
			<div className={settingsPanelHeaderClasses.copy}>
				<h2 className={settingsPanelHeaderClasses.title}>{title}</h2>
				{description ? (
					<p className={settingsPanelHeaderClasses.description}>{description}</p>
				) : null}
			</div>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
		</div>
	);
}
