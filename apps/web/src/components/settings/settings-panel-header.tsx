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
		<div
			data-slot="settings-panel-header"
			className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
				{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <HeaderActionGroup>{actions}</HeaderActionGroup> : null}
		</div>
	);
}
