import type { SavedAiProvider } from "@clawdi/shared/api";
import { aiProvidersUiClasses } from "@clawdi/shared/ui";
import { providerPresentation } from "@clawdi/shared/view";
import BrainCircuit from "lucide-react-native/icons/brain-circuit";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { Icon } from "@/components/ui/icon";

/** Web hosted/v2/ai-providers/ai-providers-ui.tsx. */
export function ProviderIcon({
	provider,
	providers,
	size = "md",
}: {
	provider: SavedAiProvider | string;
	/** Resolves a provider id to its saved connection, as on Web. */
	providers?: readonly SavedAiProvider[];
	size?: "sm" | "md" | "lg";
}) {
	const presentation = providerPresentation(provider, providers);
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
