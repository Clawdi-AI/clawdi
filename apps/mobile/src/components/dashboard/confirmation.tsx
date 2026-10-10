import { useState } from "react";
import { ConfirmAction } from "@/components/ui/confirm-action";

type Confirmation = {
	title: string;
	description: string;
	confirmLabel: string;
	/** Defaults to true; non-destructive confirmations use the default button style. */
	destructive?: boolean;
	onConfirm: () => unknown;
};
/** Present the existing account/foreground-guarded callback through the native confirmation helper. */
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
				destructive={pending.destructive ?? true}
				onConfirm={pending.onConfirm}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			/>
		) : null,
	};
}
