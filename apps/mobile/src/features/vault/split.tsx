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
	splitVaultRemoveLabel,
	splitVaultSubmit,
	splitVaultTitle,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { AppText } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { WebText, WebView, webView } from "../../ui/web-layout";

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
			<DialogHeader>
				<DialogTitle>{splitVaultTitle(sourceName)}</DialogTitle>
				<DialogDescription>
					<Text>
						{copy.descriptionBefore}
						<WebText recipe={styles.mono}>{copy.prefixExample}</WebText>
						{copy.descriptionBetween}
						<WebText recipe={styles.mono}>{copy.keyExample}</WebText>
						{copy.descriptionAfter}
					</Text>
				</DialogDescription>
			</DialogHeader>
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
												pathname: "/vault/detail",
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
					{groups.map((g) => (
						<WebView key={g.prefix} recipe={styles.group} className="flex-row">
							<WebView recipe={styles.checkRow} className="flex-row flex-1">
								<Checkbox
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
								<WebText recipe={styles.prefix}>{g.prefix}</WebText>
								<WebText recipe={styles.count}>{`${g.keys.length} keys →`}</WebText>
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
					))}
					<WebView recipe={styles.checkRow} className="flex-row">
						<Checkbox
							checked={removeOriginals}
							onCheckedChange={setRemoveOriginals}
							disabled={disabled}
						/>
						<Text>{splitVaultRemoveLabel(sourceName)}</Text>
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
