import type { components } from "@clawdi/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";
import { shareTokenFromUrl } from "./project-sharing-state";

export function ProjectJoinScreen() {
	const scope = useAccountScope();
	return <JoinView key={`${scope.identity}:${scope.generation}`} />;
}

function JoinView() {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [input, setInput] = useState("");
	const [preview, setPreview] = useState<{
		token: string;
		data: components["schemas"]["ShareRedeemResponse"];
	} | null>(null);
	const [joined, setJoined] = useState(false);
	const presentation = useRef(0);
	const focused = useRef(false);
	const clear = useCallback(() => {
		presentation.current += 1;
		setInput("");
		setPreview(null);
		setJoined(false);
	}, []);
	useFocusEffect(
		useCallback(() => {
			focused.current = true;
			return () => {
				focused.current = false;
				clear();
			};
		}, [clear]),
	);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => listener.remove();
	}, [clear]);
	const token = shareTokenFromUrl(input);
	const load = () =>
		action.run(async (isCurrent) => {
			if (!token) return;
			setPreview(null);
			setJoined(false);
			const epoch = presentation.current;
			const data = await read((signal) => sharing.previewLink(token, signal));
			if (
				isCurrent() &&
				epoch === presentation.current &&
				focused.current &&
				AppState.currentState === "active"
			)
				setPreview({ token, data });
		});
	const join = () =>
		action.run(async (isCurrent) => {
			if (!preview) return;
			const epoch = presentation.current;
			await read((signal) => sharing.joinLink(preview.token, signal));
			if (!isCurrent()) return;
			setInput("");
			setPreview(null);
			if (epoch === presentation.current && focused.current && AppState.currentState === "active")
				setJoined(true);
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
		});
	return (
		<ReadScreen>
			<AppScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
				<BackButton />
				<AppText accessibilityRole="header" className="text-3xl text-foreground">
					{t("sharing.joinLink")}
				</AppText>
				<AppText>{t("sharing.joinDescription")}</AppText>
				<AppTextInput
					accessibilityLabel={t("sharing.pasteLink")}
					placeholder={t("sharing.pasteLink")}
					secureTextEntry
					autoCapitalize="none"
					autoCorrect={false}
					value={input}
					editable={!action.busy}
					maxLength={4096}
					onChangeText={(value) => {
						presentation.current += 1;
						setInput(value);
						setPreview(null);
						setJoined(false);
						action.clearError();
					}}
					className="rounded-xl bg-card p-3 text-foreground"
				/>
				{input.trim() && !token ? (
					<AppText accessibilityRole="alert">{t("sharing.invalidLink")}</AppText>
				) : null}
				<NativeButton
					label={t("sharing.preview")}
					disabled={action.busy || !token}
					onPress={() => void load()}
				/>
				{preview ? (
					<AppView className="gap-3 rounded-2xl bg-card p-4">
						<AppText className="text-xl text-foreground">{preview.data.project_name}</AppText>
						<AppText>
							{preview.data.owner_display} · {preview.data.owner_handle}
						</AppText>
						<AppText>
							{t("skills.title")}: {preview.data.skill_count}
						</AppText>
						<AppText>
							{t("sharing.vaults")}: {preview.data.vault_count}
						</AppText>
						<NativeButton
							label={t("sharing.join")}
							disabled={action.busy}
							onPress={() => void join()}
						/>
					</AppView>
				) : null}
				{joined ? <AppText accessibilityLiveRegion="polite">{t("sharing.joined")}</AppText> : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("sharing.joinFailed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
