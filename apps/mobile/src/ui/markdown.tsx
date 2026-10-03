import { splitSearchHighlight } from "@clawdi/shared/api";
import {
	type MarkdownNode,
	type MarkdownRoot,
	markdownExternalUrl,
	markdownReferenceUrls,
	parseDisplayMarkdown,
} from "@clawdi/shared/markdown";
import { useFocusEffect } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { ImagePreview } from "./image-preview";
import { NativeButton } from "./native-controls";
import { AppScrollView, AppText, AppView } from "./primitives";

function Highlight({ text, query }: { text: string; query: string }) {
	return splitSearchHighlight(text, query).map((part, index) => (
		<AppText
			key={`${index}:${part.highlighted}`}
			className={part.highlighted ? "bg-warning text-foreground" : undefined}
		>
			{part.text}
		</AppText>
	));
}

export function Markdown({ content, query = "" }: { content: string; query?: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [limit, setLimit] = useState(12000);
	const [raw, setRaw] = useState(false);
	const [image, setImage] = useState<{
		url: string;
		alt: string;
		owner: typeof scope;
		content: string;
	} | null>(null);
	useFocusEffect(useCallback(() => () => setImage(null), []));
	useEffect(() => {
		setImage(null);
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") setImage(null);
		});
		return () => listener.remove();
	}, [scope, content]);
	const shown = content.slice(0, limit);
	const tree = useMemo(() => (raw ? null : parseDisplayMarkdown(shown)), [raw, shown]);
	const open = (value: string) => {
		const url = markdownExternalUrl(value);
		if (!url || action.busy) return;
		const foreground = capture();
		const signal = scope.signal;
		Alert.alert(t("markdown.openLink"), url, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("markdown.openLink"),
				onPress: () => {
					void action.run(async (current) => {
						if (!current() || !foreground() || signal.aborted || !scope.isCurrent()) return;
						await openBrowserAsync(url);
					});
				},
			},
		]);
	};
	const preview = (value: string, alt: string) => {
		const url = markdownExternalUrl(value);
		if (!url?.startsWith("https:")) {
			open(value);
			return;
		}
		const foreground = capture();
		const signal = scope.signal;
		Alert.alert(t("markdown.previewImage"), `${t("markdown.imagePrivacy")}\n${url}`, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("markdown.previewImage"),
				onPress: () => {
					if (foreground() && !signal.aborted && scope.isCurrent())
						setImage({ url, alt, owner: scope, content });
				},
			},
			{
				text: t("markdown.openLink"),
				onPress: () => {
					if (foreground() && !signal.aborted && scope.isCurrent()) open(url);
				},
			},
		]);
	};
	return (
		<AppView className="gap-3">
			<NativeButton
				label={t(raw ? "markdown.formatted" : "markdown.source")}
				onPress={() => {
					setRaw(!raw);
					setImage(null);
				}}
			/>
			{tree ? (
				<MarkdownTree
					tree={tree}
					query={query}
					open={open}
					preview={preview}
					imageLabel={t("markdown.image")}
				/>
			) : (
				<>
					{!raw ? <AppText>{t("markdown.plainFallback")}</AppText> : null}
					<AppText selectable className="text-base leading-6 text-foreground">
						<Highlight text={shown} query={query} />
					</AppText>
				</>
			)}
			{image && image.owner === scope && image.content === content ? (
				<ImagePreview
					key={image.url}
					url={image.url}
					alt={image.alt}
					close={() => setImage(null)}
				/>
			) : null}
			{action.error ? (
				<AppText accessibilityRole="alert">{t("markdown.openFailed")}</AppText>
			) : null}
			{content.length > limit ? (
				<NativeButton
					label={t("timeline.moreText")}
					onPress={() => setLimit((value) => value + 12000)}
				/>
			) : null}
		</AppView>
	);
}

function MarkdownTree({
	tree,
	query,
	open,
	preview,
	imageLabel,
}: {
	tree: MarkdownRoot;
	query: string;
	open: (url: string) => void;
	preview: (url: string, alt: string) => void;
	imageLabel: string;
}) {
	const definitions = markdownReferenceUrls(tree);
	const text = (value: string) => <Highlight text={value} query={query} />;
	const link = (label: ReactNode, target: string | undefined): ReactNode =>
		target && markdownExternalUrl(target) ? (
			<AppText
				accessibilityRole="link"
				className="text-primary underline"
				onPress={() => open(target)}
			>
				{label}
			</AppText>
		) : (
			<AppText>
				{label}
				{target ? ` (${target})` : ""}
			</AppText>
		);
	const inline = (node: MarkdownNode): ReactNode => {
		const children =
			"children" in node
				? node.children.map((child, index) => <AppText key={index}>{inline(child)}</AppText>)
				: null;
		switch (node.type) {
			case "text":
				return text(node.value);
			case "break":
				return "\n";
			case "strong":
				return <AppText className="font-bold">{children}</AppText>;
			case "emphasis":
				return <AppText className="italic">{children}</AppText>;
			case "delete":
				return <AppText className="line-through">{children}</AppText>;
			case "inlineCode":
				return <AppText className="font-mono bg-background">{text(node.value)}</AppText>;
			case "link":
				return link(children, node.url);
			case "linkReference":
				return link(children, definitions.get(node.identifier.toLowerCase()));
			case "image":
				return imageLink(node.alt ?? "", node.url);
			case "imageReference":
				return imageLink(node.alt ?? "", definitions.get(node.identifier.toLowerCase()));
			case "footnoteReference":
				return `[${node.label ?? node.identifier}]`;
			default:
				return "value" in node ? text(node.value) : children;
		}
	};
	const imageLink = (alt: string, target: string | undefined) =>
		target && markdownExternalUrl(target) ? (
			<AppText
				accessibilityRole="button"
				className="text-primary underline"
				onPress={() => preview(target, alt)}
			>
				[{imageLabel}: {alt}]
			</AppText>
		) : (
			link(`[${imageLabel}: ${alt}]`, target)
		);
	const blocks = (nodes: readonly MarkdownNode[]) =>
		nodes.map((node, index) => (
			<AppView key={node.position?.start.offset ?? index}>{block(node)}</AppView>
		));
	const block = (node: MarkdownNode): ReactNode => {
		switch (node.type) {
			case "definition":
				return null;
			case "root":
				return <AppView className="gap-3">{blocks(node.children)}</AppView>;
			case "heading":
				return (
					<AppText
						selectable
						accessibilityRole="header"
						className={
							node.depth <= 2
								? "text-xl font-bold text-foreground"
								: "text-lg font-semibold text-foreground"
						}
					>
						{inline(node)}
					</AppText>
				);
			case "paragraph":
				return (
					<AppText selectable className="text-base leading-6 text-foreground">
						{inline(node)}
					</AppText>
				);
			case "code":
				return (
					<AppView className="gap-2 rounded-xl bg-background p-3">
						<AppText className="text-sm text-muted">{node.lang ?? ""}</AppText>
						<AppScrollView horizontal>
							<AppText selectable className="font-mono text-foreground">
								{text(node.value)}
							</AppText>
						</AppScrollView>
					</AppView>
				);
			case "blockquote":
				return (
					<AppView className="gap-2 border-l-2 border-muted pl-3">{blocks(node.children)}</AppView>
				);
			case "thematicBreak":
				return <AppView className="h-px bg-muted" />;
			case "list":
				return (
					<AppView className="gap-2">
						{node.children.map((item, index) => (
							<AppView key={index} className="flex-row gap-2">
								<AppText className="text-foreground">
									{item.checked !== null && item.checked !== undefined
										? item.checked
											? "☑"
											: "☐"
										: node.ordered
											? `${(node.start ?? 1) + index}.`
											: "•"}
								</AppText>
								<AppView className="flex-1 gap-2">{blocks(item.children)}</AppView>
							</AppView>
						))}
					</AppView>
				);
			case "table":
				return (
					<AppScrollView horizontal>
						<AppView>
							{node.children.map((row, index) => (
								<AppView key={index} className="flex-row">
									{row.children.map((cell, column) => (
										<AppView key={column} className="w-48 border border-muted p-2">
											<AppText
												selectable
												className={index === 0 ? "font-bold text-foreground" : "text-foreground"}
												style={{ textAlign: node.align?.[column] ?? "left" }}
											>
												{inline(cell)}
											</AppText>
										</AppView>
									))}
								</AppView>
							))}
						</AppView>
					</AppScrollView>
				);
			case "footnoteDefinition":
				return (
					<AppView className="gap-2">
						<AppText className="font-semibold text-foreground">
							[{node.label ?? node.identifier}]
						</AppText>
						{blocks(node.children)}
					</AppView>
				);
			default:
				return (
					<AppText selectable className="text-foreground">
						{inline(node)}
					</AppText>
				);
		}
	};
	return block(tree);
}
