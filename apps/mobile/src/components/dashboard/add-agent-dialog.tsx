import { addAgentDialogCopy as copy } from "@clawdi/shared/view";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { SheetPage } from "@/components/ui/sheet-page";
import { useAccountScope } from "@/platform/account-lifecycle";

/** Web's "Add an agent" dialog as a native sheet. */
export function AddAgentScreen() {
	const scope = useAccountScope();
	return (
		<SheetPage title={copy.title} description={copy.description} fallback="/agents">
			<AddAgentSetup key={`${scope.accountKey}:${scope.generation}`} />
		</SheetPage>
	);
}
