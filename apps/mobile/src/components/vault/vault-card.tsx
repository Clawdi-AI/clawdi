import type { Vault as VaultSummary } from "@clawdi/shared/api";
import { vaultsSurfaceClasses } from "@clawdi/shared/ui";
import { formatResourceCount, identityFor, vaultSearchSupportingText } from "@clawdi/shared/view";
import { router } from "expo-router";
import { Lock } from "lucide-react-native";
import type { ReactNode } from "react";
import { HeroCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { SearchHighlightedText } from "@/components/search-highlighted-text";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { WebView, webBoth } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAgentRouteId } from "@/platform/navigation/use-agent-route";
export function VaultCard({
	vault,
	names,
	actions,
	projectId,
	searchQuery,
}: {
	vault: VaultSummary;
	names: ReadonlyMap<string, string>;
	actions?: ReactNode;
	projectId?: string;
	searchQuery?: string;
}) {
	const t = useI18n();
	const agentId = useAgentRouteId();
	const identity = identityFor(vault.name);
	const supportingText = searchQuery ? vaultSearchSupportingText(vault, searchQuery) : null;
	const usedBy = vault.project_ids.map((id) => names.get(id)).filter(Boolean);
	const open = () =>
		router.push({
			pathname: "/vault/[slug]",
			params: { vaultId: vault.id, slug: vault.slug, add: "1" },
		});
	return (
		<HeroCard
			icon={
				<IconChip tint={identity.colorClasses} className={webBoth(vaultsSurfaceClasses.identity)}>
					<Text>{identity.emoji}</Text>
					{vault.is_owner === false ? (
						<WebView recipe={vaultsSurfaceClasses.sharedLock}>
							<Icon as={Lock} className={webBoth(vaultsSurfaceClasses.lockIcon)} />
						</WebView>
					) : null}
				</IconChip>
			}
			title={
				searchQuery ? (
					<Text numberOfLines={1}>
						<SearchHighlightedText text={vault.name} query={searchQuery} />
					</Text>
				) : (
					vault.name
				)
			}
			description={
				supportingText ? (
					<SearchHighlightedText text={supportingText} query={searchQuery ?? ""} />
				) : undefined
			}
			footer={[
				formatResourceCount(vault.item_count, "key"),
				usedBy.length
					? `used by ${usedBy.slice(0, 2).join(", ")}${usedBy.length > 2 ? ` +${usedBy.length - 2}` : ""}`
					: vault.project_ids.length
						? "Linked to Projects"
						: "not in any Project yet",
			]}
			footerWrap
			actionsVisibility="always"
			actions={
				actions !== undefined ? (
					actions
				) : vault.is_owner !== false ? (
					<Button variant="ghost" size="sm" onPress={open}>
						<Text>{t("libraryPort.addKeys")}</Text>
					</Button>
				) : undefined
			}
			link={{
				to: agentId
					? {
							pathname: "/agents/[id]/vaults/[slug]",
							params: {
								id: agentId,
								slug: vault.slug,
								...(projectId ? { project: projectId } : {}),
							},
						}
					: {
							pathname: "/vault/[slug]",
							params: {
								vaultId: vault.id,
								slug: vault.slug,
								...(projectId ? { project: projectId } : {}),
							},
						},
			}}
			ariaLabel={`Open vault ${vault.name}`}
		/>
	);
}
