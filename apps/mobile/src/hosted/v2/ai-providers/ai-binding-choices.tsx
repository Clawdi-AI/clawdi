import { isClawdiManagedProviderId } from "@clawdi/shared";
import type {
	HostedDeployManagedModel,
	HostedDeployRuntime,
	SavedAiProvider,
} from "@clawdi/shared/api";
import {
	ENTITY_CHOICE_GRID_CLASS,
	hostedAgentOverviewClasses,
	deployWizardClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	aiBindingCopy as copy,
	MANAGED_PROVIDER_ID,
	providerAuthLabel,
	providerAvailabilityIssue,
	providerPresentation,
} from "@clawdi/shared/view";
import Settings from "lucide-react-native/icons/settings";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import type { ReactNode } from "react";
import { EntityAddCard, EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebText, WebView } from "@/components/ui/web-layout";
import { ManagedModelPicker } from "@/hosted/v2/ai-providers/managed-model-picker";
import { ProviderIcon } from "@/hosted/v2/ai-providers/provider-icon";

export function AiBindingChoices({
	providers,
	models,
	choice,
	model,
	onChoice,
	onModel,
	disabled,
	runtime,
	agentId = null,
	currentIds,
	recommended = false,
	onAdd,
	addProvider,
	onRetry,
	error,
}: {
	providers: readonly SavedAiProvider[];
	models: readonly HostedDeployManagedModel[];
	choice: string;
	model: string;
	onChoice: (choice: string) => void;
	onModel: (model: string) => void;
	disabled?: boolean;
	runtime: HostedDeployRuntime;
	agentId?: string | null;
	currentIds?: readonly string[];
	recommended?: boolean;
	onAdd: () => void;
	addProvider?: ReactNode;
	onRetry: () => void;
	error?: unknown;
}) {
	return (
		<WebView recipe={styles.providerChoices}>
			<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
				<EntityChoiceCard
					selected={choice === "__managed__"}
					disabled={disabled}
					onClick={() => onChoice("__managed__")}
					title={copy.managed}
					description={copy.managedDescription}
					icon={<ProviderIcon provider={MANAGED_PROVIDER_ID} />}
					badge={
						recommended ? (
							<Badge variant="secondary">
								<Text>{agentSurfaceCopy.recommended}</Text>
							</Badge>
						) : undefined
					}
				/>
				<EntityChoiceCard
					selected={choice === "__unmanaged__"}
					disabled={disabled}
					onClick={() => onChoice("__unmanaged__")}
					title={copy.unmanaged}
					description={
						recommended
							? agentSurfaceCopy.deployFirstThenConfigureModelAccessInside
							: copy.unmanagedDescription
					}
					icon={
						<IconChip tint={hostedAgentOverviewClasses.mutedTint}>
							<Icon as={recommended ? SlidersHorizontal : Settings} />
						</IconChip>
					}
				/>
				{providers
					.filter((p) => !isClawdiManagedProviderId(p.provider_id))
					.map((p) => {
						const presentation = providerPresentation(p);
						const issue = providerAvailabilityIssue(p, {
							runtime,
							environmentId: agentId,
							currentProviderIds: currentIds,
						});
						return (
							<EntityChoiceCard
								key={p.provider_id}
								selected={choice === p.provider_id}
								disabled={disabled || Boolean(issue && choice !== p.provider_id)}
								onClick={() => onChoice(p.provider_id)}
								title={presentation.label}
								description={issue?.message ?? presentation.summary}
								icon={
									<EntityIcon kind="provider" id={presentation.iconId} label={presentation.label} />
								}
								badge={
									<Badge variant="secondary">
										<Text>{issue ? copy.unavailable : providerAuthLabel(p.auth.type)}</Text>
									</Badge>
								}
							/>
						);
					})}
				{addProvider ?? (
					<EntityAddCard
						title={copy.addProvider}
						description={copy.addProviderDescription}
						onClick={onAdd}
					/>
				)}
			</WebView>
			{choice === "__managed__" ? (
				<ManagedModelPicker
					models={models}
					value={model}
					onChange={onModel}
					disabled={disabled}
					error={error}
					onRetry={onRetry}
				/>
			) : null}
			{choice === "__unmanaged__" ? (
				<WebText recipe={styles.loadingPlans}>{copy.unmanagedNotice}</WebText>
			) : null}
		</WebView>
	);
}
