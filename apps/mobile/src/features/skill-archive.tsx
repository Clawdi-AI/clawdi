import {
	isWritableSkillProject,
	skillArchiveFilename,
	skillCapabilities,
	skillTransferTargets,
	transferSkill,
} from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { useLocalSearchParams } from "expo-router";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativePicker } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";
import { useCloudProjects } from "./projects";
import { routeParam } from "./read-helpers";
import { ResourceError } from "./resource-error";

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
	const confirm = (title: string, message: string, run: () => void) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(title, message, [
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
					run();
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
		void action.run(async (current) => {
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
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-5">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("skillArchive.title")}
				</AppText>
				<NativeButton
					label={t("inventory.refresh")}
					disabled={action.busy}
					onPress={() => {
						void projects.refetch();
						if (existing) void detail.refetch();
					}}
				/>
				{projects.isError || (existing && detail.isError) ? (
					<ResourceError missing={false} />
				) : null}
				{!existing ? (
					<>
						<NativePicker
							disabled={action.busy}
							value={sourceId}
							onValueChange={setSourceId}
							options={[
								{ value: "", label: t("projects.choose") },
								...(projects.data ?? [])
									.filter((p) => isWritableSkillProject(p) && !p.archived_at)
									.map((p) => ({ value: p.id, label: p.name })),
							]}
						/>
						<AppTextInput
							value={key}
							onChangeText={setKey}
							editable={!action.busy}
							accessibilityLabel={t("skillArchive.key")}
							placeholder={t("skillArchive.key")}
							maxLength={200}
							className="rounded-xl bg-surface p-3 text-foreground"
						/>
					</>
				) : (
					<AppText>{skillKey}</AppText>
				)}
				<AppText>{t("skillArchive.hint")}</AppText>
				<NativeButton
					label={t(existing ? "skillArchive.replace" : "skillArchive.upload")}
					disabled={!ready || !writable || !key.trim()}
					onPress={() =>
						existing
							? confirm(t("skillArchive.replace"), t("skillArchive.replaceWarning"), upload)
							: upload()
					}
				/>
				{existing ? (
					<AppView className="gap-3">
						<NativeButton label={t("skillArchive.download")} disabled={!ready} onPress={download} />
						<AppText>{t("skillArchive.target")}</AppText>
						<NativePicker
							value={targetId}
							onValueChange={setTargetId}
							disabled={action.busy}
							options={[
								{ value: "", label: t("projects.choose") },
								...targets.map((p) => ({ value: p.id, label: p.name })),
							]}
						/>
						<NativeButton
							label={t("skillArchive.copy")}
							disabled={!ready || !writable || !targets.some((p) => p.id === targetId)}
							onPress={() => transfer(false)}
						/>
						<NativeButton
							label={t("skillArchive.move")}
							disabled={!ready || !writable || !targets.some((p) => p.id === targetId)}
							onPress={() =>
								confirm(t("skillArchive.move"), t("skillArchive.moveWarning"), () => transfer(true))
							}
						/>
					</AppView>
				) : null}
				<AppText>{t("skillArchive.cacheHint")}</AppText>
				<NativeButton
					label={t("skillArchive.clear")}
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
				/>
				{result ? <AppText accessibilityRole="alert">{t(`skillArchive.${result}`)}</AppText> : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("skillArchive.failed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
