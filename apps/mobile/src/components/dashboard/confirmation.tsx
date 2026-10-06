import { useState } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";

type Confirmation = {
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => unknown;
};
/** Present the existing account/foreground-guarded callback through the Web dialog. */
export function useAgentConfirmation() {
	const [pending, setPending] = useState<Confirmation | null>(null);
	return {
		request: setPending,
		dialog: pending ? (
			<ConfirmAction
				open
				title={pending.title}
				description={pending.description}
				confirmLabel={pending.confirmLabel}
				destructive
				onConfirm={pending.onConfirm}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			/>
		) : null,
	};
}
