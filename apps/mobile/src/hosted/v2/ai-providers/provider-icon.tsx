import type { SavedAiProvider } from "@clawdi/shared/api";
import { aiProvidersUiClasses } from "@clawdi/shared/ui";
import { providerPresentation } from "@clawdi/shared/view";
import { BrainCircuit } from "lucide-react-native";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { Icon } from "@/components/ui/icon";

/** Web hosted/v2/ai-providers/ai-providers-ui.tsx. */
export function ProviderIcon({
	provider,
	size = "md",
}: {
	provider: SavedAiProvider | string;
	size?: "sm" | "md" | "lg";
}) {
	const presentation = providerPresentation(provider);
	return presentation.managed ? (
		<IconChip size={size} tint={aiProvidersUiClasses.managedTint}>
			<Icon as={BrainCircuit} />
		</IconChip>
	) : (
		<EntityIcon
			kind="provider"
			id={presentation.iconId}
			label={presentation.brandLabel}
			size={size}
		/>
	);
}
