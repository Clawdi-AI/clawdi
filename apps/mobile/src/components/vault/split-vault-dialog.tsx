import {
	prefixGroupsFor,
	type VaultIdentity,
	type VaultKeySelection,
	type VaultPrefixGroup,
	type VaultSplitResult,
	validVaultSplit,
} from "@clawdi/shared/api";
import { splitVaultDialogClasses as styles } from "@clawdi/shared/ui";
import {
	splitVaultCopy as copy,
	formatCount,
	splitVaultRemoveLabel,
	splitVaultSubmit,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Text as AppText, Text } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";

export function VaultSplit({
	source,
	sourceName = source.slug,
	keys,
	disabled,
	result,
	onSubmit,
	onReset,
}: {
	source: VaultIdentity;
	sourceName?: string;
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
		<WebView recipe={styles.body}>
			<WebView recipe={styles.body}>
				<WebText recipe="text-sm text-muted-foreground">
					<Text>
						{copy.descriptionBefore}
						<WebText recipe={styles.mono}>{copy.prefixExample}</WebText>
						{copy.descriptionBetween}
						<WebText recipe={styles.mono}>{copy.keyExample}</WebText>
						{copy.descriptionAfter}
					</Text>
				</WebText>
			</WebView>
			{result ? (
				<WebView recipe={styles.result} accessibilityRole="alert">
					{result.groups.map((g) => (
						<WebView key={g.prefix} recipe={styles.group}>
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
												pathname: "/vault/[slug]",
												params: { vaultId: g.target.id, slug: g.target.slug },
											});
									}}
								>
									<Text>{`${t("vault.open")}: ${g.slug}`}</Text>
								</Button>
							) : null}
						</WebView>
					))}
					<AppText>{copy.inspect}</AppText>
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
				</WebView>
			) : (
				<>
					{groups.map((g) => {
						const included = !excluded.has(g.prefix);
						const toggle = (value: boolean) =>
							setExcluded((current) => {
								const next = new Set(current);
								if (value) next.delete(g.prefix);
								else next.add(g.prefix);
								return next;
							});
						return (
							<WebView key={g.prefix} recipe={styles.group} className="flex-row">
								<WebView recipe={styles.checkRow} className="flex-row flex-1">
									<Checkbox
										checked={included}
										disabled={disabled}
										accessibilityLabel={`${g.prefix}, ${formatCount(g.keys.length, "key")}`}
										onCheckedChange={toggle}
									/>
									{/* Web's <label>: the caption toggles the named checkbox. */}
									<AppPressable
										accessibilityElementsHidden
										importantForAccessibility="no-hide-descendants"
										disabled={disabled}
										onPress={() => toggle(!included)}
										className="flex-1 flex-row items-center gap-2"
									>
										<WebText recipe={styles.prefix}>{g.prefix}</WebText>
										<WebText
											recipe={styles.count}
										>{`${formatCount(g.keys.length, "key")} →`}</WebText>
									</AppPressable>
								</WebView>
								<Input
									className="flex-1"
									accessibilityLabel={`${t("vault.splitSlug")}: ${g.prefix}`}
									value={slugs[g.prefix] ?? g.slug}
									onChangeText={(slug) => setSlugs({ ...slugs, [g.prefix]: slug })}
									editable={!disabled && !excluded.has(g.prefix)}
									maxLength={200}
									autoCapitalize="none"
									autoCorrect={false}
								/>
							</WebView>
						);
					})}
					<WebView recipe={styles.checkRow} className="flex-row">
						<Checkbox
							checked={removeOriginals}
							onCheckedChange={setRemoveOriginals}
							disabled={disabled}
							accessibilityLabel={splitVaultRemoveLabel(sourceName)}
						/>
						<Text
							className="flex-1"
							accessibilityElementsHidden
							importantForAccessibility="no"
							onPress={disabled ? undefined : () => setRemoveOriginals(!removeOriginals)}
						>
							{splitVaultRemoveLabel(sourceName)}
						</Text>
					</WebView>
					{!valid ? <AppText accessibilityRole="alert">{copy.invalid}</AppText> : null}
					<Button
						className={webView(styles.submit)}
						disabled={disabled || !valid}
						onPress={() => onSubmit(selected, removeOriginals)}
					>
						<Text>
							{splitVaultSubmit(
								selected.reduce((sum, group) => sum + group.keys.length, 0),
								selected.length,
							)}
						</Text>
					</Button>
				</>
			)}
		</WebView>
	);
}
