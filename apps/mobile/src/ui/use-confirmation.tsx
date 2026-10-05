import { useRef, useState } from "react";
import { ConfirmAction } from "./confirm-action";

type ConfirmationButton = {
	text: string;
	style?: "cancel" | "destructive" | "default";
	className?: string;
	onPress?: () => unknown;
};

/** Presentation adapter for existing guarded native confirmation callbacks. */
export function useConfirmation() {
	const [request, setRequest] = useState<{
		title: string;
		description: string;
		buttons: ConfirmationButton[];
	} | null>(null);
	const confirmed = useRef(false);
	const cancel = request?.buttons.find((button) => button.style === "cancel");
	const action = request?.buttons.find((button) => button.style !== "cancel");
	return {
		show: (title: string, description: string, buttons: ConfirmationButton[]) => {
			confirmed.current = false;
			setRequest({ title, description, buttons });
		},
		dialog: (
			<ConfirmAction
				open={request !== null}
				onOpenChange={(open) => {
					if (!open) {
						if (!confirmed.current) cancel?.onPress?.();
						setRequest(null);
					}
				}}
				title={request?.title ?? ""}
				description={request?.description ?? ""}
				cancelLabel={cancel?.text}
				confirmLabel={action?.text}
				confirmClassName={action?.className}
				destructive={action?.style === "destructive"}
				onConfirm={async () => {
					await action?.onPress?.();
					confirmed.current = true;
				}}
			/>
		),
	};
}
