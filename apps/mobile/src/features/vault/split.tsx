import {
	prefixGroupsFor,
	type VaultIdentity,
	type VaultKeySelection,
	type VaultPrefixGroup,
	type VaultSplitResult,
	validVaultSplit,
} from "@clawdi/shared/api";
import { router } from "expo-router";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AppText, AppView } from "../../ui/primitives";
import { Switch } from "../../ui/switch";
import { Text } from "../../ui/text";

export function VaultSplit({
	source,
	keys,
	disabled,
	result,
	onSubmit,
	onReset,
}: {
	source: VaultIdentity;
	keys: VaultKeySelection[];
	disabled: boolean;
	result?: VaultSplitResult;
	onSubmit: (groups: VaultPrefixGroup[], removeOriginals: boolean) => void;
	onReset: () => void;
}) {
	const t = useI18n();
	const [excluded, setExcluded] = useState<Set<string>>(new Set());
	const [slugs, setSlugs] = useState<Record<string, string>>({});
	const [removeOriginals, setRemoveOriginals] = useState(true);
	const groups = prefixGroupsFor(keys);
	const selected = groups
		.filter((g) => !excluded.has(g.prefix))
		.map((g) => ({ ...g, slug: slugs[g.prefix] ?? g.slug }));
	const valid = validVaultSplit(source, selected);
	if (!groups.length && !result) return null;
	return (
		<AppView className="gap-3 rounded-xl bg-card p-4">
			<AppText className="text-lg font-semibold text-foreground">{t("vault.splitTitle")}</AppText>
			<AppText>{t("vault.splitDescription")}</AppText>
			{result ? (
				<AppView accessibilityRole="alert" className="gap-3">
					{result.groups.map((g) => (
						<AppView key={g.prefix} className="gap-2">
							<AppText>
								{g.prefix} → {g.slug} ·{" "}
								{t(g.status === "complete" ? "vault.splitComplete" : "vault.splitIncomplete")}
							</AppText>
							<AppText>
								{t("vault.copiedCount")}: {g.transfer?.copied ?? 0}
							</AppText>
							{g.transfer?.failed.length ? (
								<AppText>
									{t("vault.copyUnconfirmed")}: {g.transfer.failed.join(", ")}
								</AppText>
							) : null}
							{g.transfer?.sourceRemoveFailed.length ? (
								<AppText>
									{t("vault.cleanupUnconfirmed")}: {g.transfer.sourceRemoveFailed.join(", ")}
								</AppText>
							) : null}
							{g.target ? (
								<Button
									variant="outline"
									size="sm"
									disabled={disabled}
									onPress={() => {
										if (g.target)
											router.push({
												pathname: "/vault/detail",
												params: { vaultId: g.target.id, slug: g.target.slug },
											});
									}}
								>
									<Text>{`${t("vault.open")}: ${g.slug}`}</Text>
								</Button>
							) : null}
						</AppView>
					))}
					<AppText>{t("vault.splitInspect")}</AppText>
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
						onPress={() => {
							setSlugs({});
							setExcluded(new Set());
							onReset();
						}}
					>
						<Text>{t("vault.splitReset")}</Text>
					</Button>
				</AppView>
			) : (
				<>
					{groups.map((g) => (
						<AppView key={g.prefix} className="gap-2">
							<AppView className="flex-row items-center gap-2">
								<Switch
									checked={!excluded.has(g.prefix)}
									disabled={disabled}
									onCheckedChange={(value) =>
										setExcluded((current) => {
											const next = new Set(current);
											if (value) next.delete(g.prefix);
											else next.add(g.prefix);
											return next;
										})
									}
								/>
								<Text>{`${g.prefix} · ${g.keys.length}`}</Text>
							</AppView>
							<Input
								accessibilityLabel={`${t("vault.splitSlug")}: ${g.prefix}`}
								value={slugs[g.prefix] ?? g.slug}
								onChangeText={(slug) => setSlugs({ ...slugs, [g.prefix]: slug })}
								editable={!disabled && !excluded.has(g.prefix)}
								maxLength={200}
								autoCapitalize="none"
								autoCorrect={false}
							/>
						</AppView>
					))}
					<AppView className="flex-row items-center gap-2">
						<Switch
							checked={removeOriginals}
							onCheckedChange={setRemoveOriginals}
							disabled={disabled}
						/>
						<Text>{t("vault.splitRemove")}</Text>
					</AppView>
					{!valid ? <AppText accessibilityRole="alert">{t("vault.splitInvalid")}</AppText> : null}
					<Button
						variant="outline"
						size="sm"
						disabled={disabled || !valid}
						onPress={() => onSubmit(selected, removeOriginals)}
					>
						<Text>{t("vault.splitTitle")}</Text>
					</Button>
				</>
			)}
		</AppView>
	);
}
