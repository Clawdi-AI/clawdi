import {
	isWritableSkillProject,
	skillArchiveFilename,
	skillCapabilities,
	skillTransferTargets,
	transferSkill,
} from "@clawdi/shared/api";
import { detailLayoutClasses, sendSkillDialogClasses } from "@clawdi/shared/ui";
import { skillFormCopy as copy, sendSkillTitle } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { router, useLocalSearchParams } from "expo-router";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { ArrowRight, Copy } from "lucide-react-native";
import { useRef, useState } from "react";
import { BackButton } from "@/components/detail/back-link";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { PageHeader } from "@/components/page-header";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { ResourceError } from "@/components/resource-error";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Text as AppText, Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function SkillArchiveScreen() {
	const params = useLocalSearchParams<{
		projectId?: string | string[];
		skillKey?: string | string[];
	}>();
	const scope = useAccountScope();
	const projectId = routeParam(params.projectId);
	const skillKey = routeParam(params.skillKey);
	return (
		<Archive
			key={`${scope.accountKey}:${scope.generation}:${projectId}:${skillKey}`}
			projectId={projectId}
			skillKey={skillKey}
		/>
	);
}

function Archive({ projectId, skillKey }: { projectId?: string; skillKey?: string }) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { skills, cloud } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const cache = useQueryClient();
	const projects = useCloudProjects();
	const [sourceId, setSourceId] = useState(projectId ?? "");
	const [key, setKey] = useState(skillKey ?? "");
	const [targetId, setTargetId] = useState("");
	const [result, setResult] = useState<
		"uploaded" | "copied" | "moved" | "partial" | "cleared" | null
	>(null);
	const confirmation = useRef(0);
	const [archiveTools, setArchiveTools] = useState(false);
	const detail = useQuery({
		queryKey: accountQueryKey(scope, "skill-detail", sourceId, skillKey),
		enabled: scope.isReady && Boolean(sourceId && skillKey),
		retry: false,
		queryFn: ({ signal }) => read((lease) => skills.get(sourceId, skillKey ?? "", lease), signal),
	});
	const source = projects.data?.find((p) => p.id === sourceId);
	const existing = Boolean(skillKey);
	const matches = detail.data?.project_id === sourceId && detail.data?.skill_key === skillKey;
	const ready =
		scope.isReady &&
		!action.busy &&
		!projects.isError &&
		!projects.isPending &&
		(!existing || (matches && !detail.isError && !detail.isFetching));
	const writable =
		source &&
		!source.archived_at &&
		isWritableSkillProject(source) &&
		(!existing || (detail.data && skillCapabilities(detail.data, source).canUpdate));
	const targets = skillTransferTargets(projects.data ?? [], sourceId);
	const invalidate = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	const exportDirectory = async () => {
		if (!scope.accountKey) throw new Error("Account unavailable");
		return new Directory(
			Paths.cache,
			`skill-exports-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, scope.accountKey)}`,
		);
	};
	const confirm = (title: string, message: string, run: () => unknown) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		confirmationDialog.show(title, message, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: title,
				style: "destructive",
				onPress: () => {
					if (
						ticket !== confirmation.current ||
						!scope.isCurrent() ||
						scope.signal.aborted ||
						!visible()
					)
						return;
					confirmation.current++;
					return run();
				},
			},
		]);
	};
	const upload = () =>
		void action.run(async (current) => {
			if (!ready || !writable || !key.trim()) return;
			setResult(null);
			const picked = await File.pickFileAsync({
				mimeTypes: ["application/gzip", "application/x-gzip", "application/octet-stream"],
			});
			const visible = capture();
			if (picked.canceled || !current() || !visible()) return;
			const freshProjects = await read((signal) => cloud.listProjects(signal));
			const freshSource = freshProjects.find((p) => p.id === sourceId);
			if (!freshSource || freshSource.archived_at || !isWritableSkillProject(freshSource))
				throw new Error("Project unavailable");
			if (!current() || !visible()) return;
			await read((signal) => skills.upload(sourceId, key.trim(), picked.result, !existing, signal));
			if (!current()) return;
			setResult("uploaded");
			await invalidate();
		});
	const transfer = (move: boolean) =>
		action.run(async (current) => {
			if (!ready || !writable || !skillKey || !targetId) return;
			setResult(null);
			const visible = capture();
			const [freshProjects, freshSkill] = await Promise.all([
				read((signal) => cloud.listProjects(signal)),
				read((signal) => skills.get(sourceId, skillKey, signal)),
			]);
			const freshSource = freshProjects.find((p) => p.id === sourceId);
			const target = freshProjects.find((p) => p.id === targetId);
			if (
				!freshSource ||
				!target ||
				freshSkill.project_id !== sourceId ||
				freshSkill.skill_key !== skillKey
			)
				throw new Error("Skill unavailable");
			if (!current() || !visible()) return;
			const transferred = await read((signal) =>
				transferSkill({
					skill: freshSkill,
					source: freshSource,
					target,
					move,
					download: () => skills.download(sourceId, skillKey, signal),
					upload: (archive) => skills.upload(targetId, skillKey, archive, true, signal),
					remove: (revision) => skills.remove(sourceId, skillKey, revision, signal),
				}),
			);
			if (!current()) return;
			setResult(
				transferred.sourceRemoved === true
					? "moved"
					: transferred.sourceRemoved === false
						? "partial"
						: "copied",
			);
			await invalidate();
		});
	const download = () =>
		void action.run(async (current) => {
			if (!ready || !skillKey) return;
			setResult(null);
			const visible = capture();
			if (!(await isAvailableAsync())) throw new Error("Sharing unavailable");
			const archive = await read((signal) => skills.download(sourceId, skillKey, signal));
			const bytes = new Uint8Array(await archive.arrayBuffer());
			const directory = await exportDirectory();
			if (!current() || !visible()) return;
			directory.create({ idempotent: true, intermediates: true });
			const file = new File(directory, `${randomUUID()}-${skillArchiveFilename(skillKey)}`);
			file.write(bytes);
			// Android resolves on chooser return, not receiver consumption. Retain the
			// cache file until explicit cleanup rather than breaking the receiving app.
			await shareAsync(file.uri, {
				mimeType: "application/gzip",
				UTI: "org.gnu.gnu-zip-archive",
				dialogTitle: t("skillArchive.download"),
			});
		});
	return (
		<SafeAreaScreen>
			{existing ? (
				<Dialog
					open
					onOpenChange={(next) => {
						if (!next && !action.busy) router.back();
					}}
				>
					<DialogContent
						className={webView(sendSkillDialogClasses.dialog)}
						showCloseButton={!action.busy}
					>
						<DialogHeader>
							<DialogTitle>{sendSkillTitle(detail.data?.name ?? skillKey ?? "")}</DialogTitle>
							<DialogDescription>
								<Text>
									{copy.transferDescription} {copy.transferAlternativeBefore}
									<WebText recipe={sendSkillDialogClasses.emphasis}>
										{copy.transferAlternativeEmphasis}
									</WebText>
									{copy.transferAlternativeAfter}
								</Text>
							</DialogDescription>
						</DialogHeader>
						<WebView recipe={sendSkillDialogClasses.body}>
							<WebView recipe={sendSkillDialogClasses.field}>
								<Label>{copy.destination}</Label>
								<ChoiceSelect
									triggerClassName={webView(sendSkillDialogClasses.trigger)}
									value={targetId}
									onValueChange={setTargetId}
									disabled={action.busy}
									options={[
										{ value: "", label: copy.chooseProject },
										...targets.map((p) => ({ value: p.id, label: p.name })),
									]}
								/>
							</WebView>
							{projects.isError || detail.isError ? <ResourceError missing={false} /> : null}
							<DialogFooter>
								<Button
									variant="outline"
									disabled={!ready || !writable || !targets.some((p) => p.id === targetId)}
									onPress={() => transfer(false)}
								>
									<Icon as={Copy} />
									<Text>{copy.copy}</Text>
								</Button>
								<Button
									disabled={!ready || !writable || !targets.some((p) => p.id === targetId)}
									onPress={() =>
										confirm(copy.move, t("skillArchive.moveWarning"), () => transfer(true))
									}
								>
									<Icon as={ArrowRight} />
									<Text>{copy.move}</Text>
								</Button>
							</DialogFooter>
						</WebView>
						<Button variant="ghost" onPress={() => setArchiveTools(!archiveTools)}>
							<Text>{t("skillArchive.title")}</Text>
						</Button>
						{archiveTools ? (
							<WebView recipe={sendSkillDialogClasses.body}>
								<Button variant="outline" disabled={!ready} onPress={download}>
									<Text>{t("skillArchive.download")}</Text>
								</Button>

								<AppText>{t("skillArchive.hint")}</AppText>
								<Button
									variant="outline"
									size="sm"
									disabled={!ready || !writable || !key.trim()}
									onPress={() =>
										existing
											? confirm(t("skillArchive.replace"), t("skillArchive.replaceWarning"), upload)
											: upload()
									}
								>
									<Text>{t(existing ? "skillArchive.replace" : "skillArchive.upload")}</Text>
								</Button>
								<AppText>{t("skillArchive.cacheHint")}</AppText>
								<Button
									variant="outline"
									size="sm"
									disabled={action.busy || !scope.isReady}
									onPress={() =>
										confirm(
											t("skillArchive.clear"),
											t("skillArchive.clearWarning"),
											() =>
												void action.run(async (current) => {
													const visible = capture();
													const directory = await exportDirectory();
													if (!current() || !visible()) return;
													if (directory.exists) directory.delete();
													setResult("cleared");
												}),
										)
									}
								>
									<Text>{t("skillArchive.clear")}</Text>
								</Button>
							</WebView>
						) : null}
						{result ? (
							<AppText accessibilityRole="alert">{t(`skillArchive.${result}`)}</AppText>
						) : null}
						{action.error ? (
							<AppText accessibilityRole="alert">{t("skillArchive.failed")}</AppText>
						) : null}
					</DialogContent>
				</Dialog>
			) : (
				<AppScrollView contentContainerClassName={webView(detailLayoutClasses.detailPage)}>
					<BackButton />
					<PageHeader title={t("skillArchive.title")} />
					<ChoiceSelect
						disabled={action.busy}
						value={sourceId}
						onValueChange={setSourceId}
						options={[
							{ value: "", label: copy.chooseProject },
							...(projects.data ?? [])
								.filter((p) => isWritableSkillProject(p) && !p.archived_at)
								.map((p) => ({ value: p.id, label: p.name })),
						]}
					/>
					<Input
						value={key}
						onChangeText={setKey}
						editable={!action.busy}
						accessibilityLabel={t("skillArchive.key")}
						placeholder={t("skillArchive.key")}
						maxLength={200}
					/>

					<AppText>{t("skillArchive.hint")}</AppText>
					<Button
						variant="outline"
						size="sm"
						disabled={!ready || !writable || !key.trim()}
						onPress={() =>
							existing
								? confirm(t("skillArchive.replace"), t("skillArchive.replaceWarning"), upload)
								: upload()
						}
					>
						<Text>{t(existing ? "skillArchive.replace" : "skillArchive.upload")}</Text>
					</Button>
					<AppText>{t("skillArchive.cacheHint")}</AppText>
					<Button
						variant="outline"
						size="sm"
						disabled={action.busy || !scope.isReady}
						onPress={() =>
							confirm(
								t("skillArchive.clear"),
								t("skillArchive.clearWarning"),
								() =>
									void action.run(async (current) => {
										const visible = capture();
										const directory = await exportDirectory();
										if (!current() || !visible()) return;
										if (directory.exists) directory.delete();
										setResult("cleared");
									}),
							)
						}
					>
						<Text>{t("skillArchive.clear")}</Text>
					</Button>
					{result ? (
						<AppText accessibilityRole="alert">{t(`skillArchive.${result}`)}</AppText>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("skillArchive.failed")}</AppText>
					) : null}
				</AppScrollView>
			)}
			{confirmationDialog.dialog}
		</SafeAreaScreen>
	);
}
