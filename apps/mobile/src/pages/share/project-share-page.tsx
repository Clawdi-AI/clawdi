import type { components } from "@clawdi/shared/api";
import { detailLayoutClasses, projectSharePageClasses as styles } from "@clawdi/shared/ui";
import {
	projectInvitationCopy as copy,
	projectInvitationAccess,
	projectInvitationCounts,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { BackButton } from "@/components/detail/back-link";
import { PageHeader } from "@/components/page-header";
import { shareTokenFromUrl } from "@/components/sharing/project-sharing-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text as AppText, Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebText, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export function ProjectJoinScreen() {
	const scope = useAccountScope();
	const { token } = useLocalSearchParams<{ token?: string }>();
	const initialLink =
		token && /^[A-Za-z0-9_-]{43}$/.test(token) ? `https://local.invalid/share/${token}` : "";
	return (
		<JoinView key={`${scope.identity}:${scope.generation}:${token}`} initialLink={initialLink} />
	);
}

function JoinView({ initialLink }: { initialLink: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [input, setInput] = useState(initialLink);
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
		<SafeAreaScreen>
			<AppScrollView contentContainerClassName={webView(detailLayoutClasses.detailPage)}>
				<BackButton />
				<PageHeader title={t("sharing.joinLink")} />
				<AppText>{t("sharing.joinDescription")}</AppText>
				<Input
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
				/>
				{input.trim() && !token ? (
					<AppText accessibilityRole="alert">{t("sharing.invalidLink")}</AppText>
				) : null}
				<Button
					variant="outline"
					size="sm"
					disabled={action.busy || !token}
					onPress={() => void load()}
				>
					<Text>{t("sharing.preview")}</Text>
				</Button>
				{preview ? (
					<Card>
						<CardHeader>
							<WebText recipe={styles.invitation}>{copy.title}</WebText>
							<CardTitle className={webView(styles.title)}>{preview.data.project_name}</CardTitle>
							<WebText recipe={styles.description}>
								{copy.sharedBy}
								<WebText recipe={styles.owner}>{preview.data.owner_display}</WebText>{" "}
								<WebText recipe={styles.handle}>@{preview.data.owner_handle}</WebText>
							</WebText>
						</CardHeader>
						<CardContent className={webView(styles.body)}>
							<WebText recipe={styles.description}>
								{projectInvitationCounts(preview.data.skill_count, preview.data.vault_count)}
							</WebText>
							<WebText recipe={styles.description}>
								{projectInvitationAccess(preview.data.vault_count > 0)}
							</WebText>
							<Separator />
							<Button
								className={webView(styles.action)}
								size="lg"
								disabled={action.busy}
								onPress={() => void join()}
							>
								<Text>{action.busy ? copy.joining : copy.accept}</Text>
							</Button>
						</CardContent>
					</Card>
				) : null}
				{joined ? <AppText accessibilityLiveRegion="polite">{t("sharing.joined")}</AppText> : null}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("sharing.joinFailed")}</AppText>
				) : null}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
