import { fetch } from "expo/fetch";
import { useEffect, useState } from "react";
import { Image } from "react-native";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useForegroundLease } from "@/platform/use-foreground-lease";
import { loadImageSource } from "@/platform/image-source";
import { NativeButton } from "@/platform/native-controls";
import { AppText, AppView } from "@/components/ui/primitives";

export function ImagePreview({ url, alt, close }: { url: string; alt: string; close: () => void }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const [source, setSource] = useState<{ uri: string; ratio: number } | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const visible = capture();
		if (!visible()) return;
		const controller = new AbortController();
		const scopeSignal = scope.signal;
		const abort = () => controller.abort();
		if (scopeSignal.aborted) abort();
		else scopeSignal.addEventListener("abort", abort, { once: true });
		// Bound preview waiting; native metadata work itself has no cancellation API.
		const timer = setTimeout(() => {
			abort();
			if (visible() && scope.isCurrent()) setFailed(true);
		}, 30000);
		void (async () => {
			try {
				const uri = await loadImageSource(url, fetch, controller.signal);
				const { width, height } = await Image.getSize(uri);
				if (
					!Number.isFinite(width) ||
					!Number.isFinite(height) ||
					width <= 0 ||
					height <= 0 ||
					width > 4096 ||
					height > 4096 ||
					width * height > 8_000_000
				)
					throw new Error("Image unavailable");
				if (!controller.signal.aborted && visible() && scope.isCurrent())
					setSource({ uri, ratio: width / height });
			} catch {
				if (!controller.signal.aborted && visible() && scope.isCurrent()) setFailed(true);
			} finally {
				clearTimeout(timer);
			}
		})();
		return () => {
			clearTimeout(timer);
			abort();
			scopeSignal.removeEventListener("abort", abort);
		};
	}, [url, scope, capture]);
	return (
		<AppView className="gap-2">
			{failed ? (
				<AppText accessibilityRole="alert">{t("markdown.imageFailed")}</AppText>
			) : source ? (
				<Image
					accessibilityLabel={alt || t("markdown.image")}
					source={{ uri: source.uri }}
					resizeMode="contain"
					style={{ width: "100%", aspectRatio: source.ratio, maxHeight: 600 }}
					onError={() => {
						setSource(null);
						setFailed(true);
					}}
				/>
			) : (
				<AppText>{t("markdown.imageLoading")}</AppText>
			)}
			<NativeButton label={t("markdown.closeImage")} onPress={close} />
		</AppView>
	);
}
