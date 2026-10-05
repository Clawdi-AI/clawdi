import { useUser } from "@clerk/expo";
import type { UserResource } from "@clerk/expo/types";
import { File } from "expo-file-system";
import { Redirect, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useRef, useState } from "react";
import { Alert, Image } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useNativeReverification } from "../auth/use-native-reverification";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { LoadingScreen } from "../ui/feedback";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton } from "./cloud-inventory";

export function ProfileScreen() {
	const { isLoaded, user } = useUser();
	const scope = useAccountScope();
	if (!isLoaded) return <LoadingScreen />;
	if (!user || !scope.isReady) return <Redirect href="/(auth)/sign-in" />;
	return <ProfileForm key={`${scope.identity}:${scope.generation}`} user={user} />;
}

function ProfileForm({ user }: { user: UserResource }) {
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const reverification = useNativeReverification();
	const capture = useForegroundLease();
	const navigation = useNavigation();
	const confirmation = useRef(0);
	const [saved, setSaved] = useState({
		firstName: user.firstName ?? "",
		lastName: user.lastName ?? "",
		username: user.username ?? "",
	});
	const [firstName, setFirstName] = useState(saved.firstName);
	const [lastName, setLastName] = useState(saved.lastName);
	const [username, setUsername] = useState(saved.username);
	const [success, setSuccess] = useState<false | "name" | "avatar">(false);
	const [avatar, setAvatar] = useState({ url: user.imageUrl, custom: user.hasImage });
	const updateAvatar = (remove: boolean) =>
		void action.run(async (current) => {
			if (user.id !== scope.accountKey || !scope.isCurrent() || !capture()()) return;
			setSuccess(false);
			let file: string | null = null;
			if (!remove) {
				const picked = await File.pickFileAsync({
					mimeTypes: ["image/png", "image/jpeg", "image/webp"],
				});
				// Capture foreground permission after the system picker returns.
				const visible = capture();
				if (picked.canceled || !current() || !scope.isCurrent() || !visible()) return;
				const image = picked.result;
				if (
					!Number.isSafeInteger(image.size) ||
					image.size <= 0 ||
					image.size > 2 * 1024 * 1024 ||
					!["image/png", "image/jpeg", "image/webp"].includes(image.type)
				)
					throw new Error("Unsupported profile image");
				const base64 = await image.base64();
				if (!current() || !scope.isCurrent() || !visible()) return;
				if (base64.length > 4 * Math.ceil((2 * 1024 * 1024) / 3))
					throw new Error("Profile image exceeds upload limit");
				file = `data:${image.type};base64,${base64}`;
			}
			const visible = capture();
			await reverification.execute(async () => {
				if (!current() || !scope.isCurrent() || !visible())
					throw new Error("Account action retired");
				const result = await user.setProfileImage({ file });
				if (!current() || !scope.isCurrent() || !visible()) return;
				setAvatar({ url: result.publicUrl ?? "", custom: !remove });
				setSuccess("avatar");
			});
		});
	const removeAvatar = () => {
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("profile.removeAvatar"), t("profile.removeAvatarWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("profile.removeAvatar"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					updateAvatar(true);
				},
			},
		]);
	};
	const dirty =
		firstName !== saved.firstName || lastName !== saved.lastName || username !== saved.username;
	usePreventRemove(scope.isReady && dirty, ({ data }) => {
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("profile.unsavedTitle"), t("profile.unsavedMessage"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("profile.discard"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || !visible() || !scope.isCurrent()) return;
					confirmation.current++;
					navigation.dispatch(data.action);
				},
			},
		]);
	});
	const save = () =>
		void action.run(async (current) => {
			if (!dirty || user.id !== scope.accountKey || !scope.isCurrent()) return;
			const visible = capture();
			const signal = scope.signal;
			if (!visible()) return;
			setSuccess(false);
			// Patch only edited fields so disabled or externally updated attributes are not overwritten.
			const changes: Parameters<UserResource["update"]>[0] = {
				...(firstName !== saved.firstName ? { firstName: firstName.trim() } : {}),
				...(lastName !== saved.lastName ? { lastName: lastName.trim() } : {}),
				...(username !== saved.username ? { username: username.trim() || null } : {}),
			};
			await reverification.execute(async () => {
				if (!current() || signal.aborted || !scope.isCurrent() || !visible())
					throw new Error("Account action retired");
				const updated = await user.update(changes);
				if (
					!current() ||
					signal.aborted ||
					!scope.isCurrent() ||
					!visible() ||
					updated.id !== user.id
				)
					return;
				const next = {
					firstName: updated.firstName ?? "",
					lastName: updated.lastName ?? "",
					username: updated.username ?? "",
				};
				setSaved(next);
				setFirstName(next.firstName);
				setLastName(next.lastName);
				setUsername(next.username);
				setSuccess("name");
			});
		});
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-5 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("profile.title")}
				</AppText>
				<AppText>{t("profile.description")}</AppText>
				{reverification.prompt}
				<AppText>
					{user.primaryEmailAddress?.emailAddress ?? t("account.accountUnavailable")}
				</AppText>
				{avatar.url.startsWith("https://") ? (
					<Image
						source={{ uri: avatar.url }}
						style={{ width: 88, height: 88, borderRadius: 44 }}
						accessibilityLabel={t("profile.avatar")}
					/>
				) : null}
				<AppText>{t("profile.avatarHint")}</AppText>
				<NativeButton
					label={t("profile.uploadAvatar")}
					disabled={action.busy}
					onPress={() => updateAvatar(false)}
				/>
				<NativeButton
					label={t("profile.removeAvatar")}
					disabled={action.busy || !avatar.custom}
					onPress={removeAvatar}
				/>
				<AppView className="gap-2">
					<AppText>{t("profile.firstName")}</AppText>
					<AppTextInput
						accessibilityLabel={t("profile.firstName")}
						autoComplete="given-name"
						value={firstName}
						editable={!action.busy}
						maxLength={256}
						className="rounded-xl bg-card p-3 text-foreground"
						onChangeText={(value) => {
							setFirstName(value);
							setSuccess(false);
						}}
					/>
				</AppView>
				<AppView className="gap-2">
					<AppText>{t("profile.lastName")}</AppText>
					<AppTextInput
						accessibilityLabel={t("profile.lastName")}
						autoComplete="family-name"
						value={lastName}
						editable={!action.busy}
						maxLength={256}
						className="rounded-xl bg-card p-3 text-foreground"
						onChangeText={(value) => {
							setLastName(value);
							setSuccess(false);
						}}
					/>
				</AppView>
				<AppView className="gap-2">
					<AppText>{t("profile.username")}</AppText>
					<AppTextInput
						accessibilityLabel={t("profile.username")}
						autoComplete="username"
						autoCapitalize="none"
						autoCorrect={false}
						value={username}
						editable={!action.busy}
						maxLength={256}
						className="rounded-xl bg-card p-3 text-foreground"
						onChangeText={(value) => {
							setUsername(value);
							setSuccess(false);
						}}
					/>
					<AppText className="text-muted-foreground">{t("profile.usernameHint")}</AppText>
				</AppView>
				{action.error ? <AppText accessibilityRole="alert">{t("profile.failed")}</AppText> : null}
				{success ? (
					<AppText accessibilityRole="alert">
						{t(success === "avatar" ? "profile.avatarSaved" : "profile.saved")}
					</AppText>
				) : null}
				<NativeButton label={t("profile.save")} disabled={!dirty || action.busy} onPress={save} />
			</AppScrollView>
		</ReadScreen>
	);
}
