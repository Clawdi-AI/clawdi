import type { Vault as VaultSummary } from "@clawdi/shared/api";
import { vaultsSurfaceClasses } from "@clawdi/shared/ui";
import { formatResourceCount, identityFor, vaultSearchSupportingText } from "@clawdi/shared/view";
import { router } from "expo-router";
import { Lock } from "lucide-react-native";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../button";
import { HeroCard } from "../entity-card";
import { Icon } from "../icon";
import { IconChip } from "../icon-chip";
import { Text } from "../text";
import { WebView, webBoth } from "../web-layout";
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
	const identity = identityFor(vault.name);
	const usedBy = vault.project_ids.map((id) => names.get(id)).filter(Boolean);
	const open = () =>
		router.push({
			pathname: "/vault/detail",
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
			title={vault.name}
			description={searchQuery ? vaultSearchSupportingText(vault, searchQuery) : undefined}
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
				to: "/vault/detail",
				search: { vaultId: vault.id, slug: vault.slug, ...(projectId ? { projectId } : {}) },
			}}
			ariaLabel={`Open vault ${vault.name}`}
		/>
	);
}
