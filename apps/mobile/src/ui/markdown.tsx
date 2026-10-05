import { SEARCH_MARK_CLASS, splitSearchHighlight } from "@clawdi/shared/api";
import {
	type MarkdownNode,
	type MarkdownRoot,
	markdownExternalUrl,
	markdownReferenceUrls,
	parseDisplayMarkdown,
} from "@clawdi/shared/markdown";
import { cardClassName, markdownClasses as styles } from "@clawdi/shared/ui";
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
import { Separator } from "./separator";
import { TextClassContext } from "./text";
import { WebView, webBoth, webText, webView } from "./web-layout";

function Highlight({ text, query }: { text: string; query: string }) {
	return splitSearchHighlight(text, query).map((part, index) => (
		<AppText
			key={`${index}:${part.highlighted}`}
			className={part.highlighted ? webBoth(SEARCH_MARK_CLASS) : undefined}
		>
			{part.text}
		</AppText>
	));
}

export function Markdown({
	content,
	query: legacyQuery = "",
	highlightQuery,
}: {
	content: string;
	query?: string;
	highlightQuery?: string;
}) {
	const query = highlightQuery ?? legacyQuery;
	const t = useI18n();
	const scope = useAccountScope();
	const capture = useForegroundLease();
	const action = useAuthAction(scope.identity);
	const [limit, setLimit] = useState(12000);
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
	const tree = useMemo(() => parseDisplayMarkdown(shown), [shown]);
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
		<WebView recipe={webText(cardClassName)}>
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
					<AppText>{t("markdown.plainFallback")}</AppText>
					<AppText selectable className={webBoth(styles.paragraph)}>
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
		</WebView>
	);
}

export function MarkdownTree({
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
	const t = useI18n();
	const definitions = markdownReferenceUrls(tree);
	const text = (value: string) => <Highlight text={value} query={query} />;
	const link = (label: ReactNode, target: string | undefined): ReactNode =>
		target && markdownExternalUrl(target) ? (
			<AppText
				accessibilityRole="link"
				className={webBoth(styles.link)}
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
				// Native equivalent of the browser's implicit <strong> weight.
				return <AppText className="font-bold">{children}</AppText>;
			case "emphasis":
				return <AppText className="italic">{children}</AppText>;
			case "delete":
				return <AppText className="line-through">{children}</AppText>;
			case "inlineCode":
				return <AppText className={webBoth(styles.inlineCode)}>{text(node.value)}</AppText>;
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
				className={webBoth(styles.link)}
				onPress={() => preview(target, alt)}
			>
				[{imageLabel}: {alt}]
			</AppText>
		) : (
			link(`[${imageLabel}: ${alt}]`, target)
		);
	const blocks = (nodes: readonly MarkdownNode[]) =>
		nodes.map((node, index) => (
			<AppView key={node.position?.start.offset ?? index}>
				{block(node, index === nodes.length - 1)}
			</AppView>
		));
	const block = (node: MarkdownNode, isLast = false): ReactNode => {
		switch (node.type) {
			case "definition":
				return null;
			case "root":
				return <AppView className="flex-col">{blocks(node.children)}</AppView>;
			case "heading":
				return (
					<AppText
						selectable
						accessibilityRole="header"
						className={webBoth(
							node.depth === 1 ? styles.h1 : node.depth === 2 ? styles.h2 : styles.h3,
						)}
					>
						{inline(node)}
					</AppText>
				);
			case "paragraph":
				return (
					<AppText selectable className={webBoth(styles.paragraph, { last: isLast })}>
						{inline(node)}
					</AppText>
				);
			case "code":
				return (
					<AppView className={webView(styles.codeFrame)}>
						<AppView className={webView(styles.codeHeader)}>
							<AppText className={webText(styles.codeLanguage)}>
								{node.lang ?? t("composite.codeText")}
							</AppText>
						</AppView>
						<AppScrollView horizontal className={webView(styles.codeBody)}>
							<AppText selectable className={webText(styles.codeBody)}>
								{text(node.value)}
							</AppText>
						</AppScrollView>
					</AppView>
				);
			case "blockquote":
				return <WebView recipe={styles.blockquote}>{blocks(node.children)}</WebView>;
			case "thematicBreak":
				return <Separator />;
			case "list":
				return (
					<AppView className={webView(node.ordered ? styles.orderedList : styles.unorderedList)}>
						{node.children.map((item, index) => (
							<AppView key={index} className="flex-row" style={{ marginTop: 4 }}>
								<AppText className={webText(cardClassName)}>
									{item.checked !== null && item.checked !== undefined
										? item.checked
											? "☑"
											: "☐"
										: node.ordered
											? `${(node.start ?? 1) + index}. `
											: "• "}
								</AppText>
								<AppView className="flex-1">{blocks(item.children)}</AppView>
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
										<AppView
											key={column}
											className={webView(index === 0 ? styles.tableHeader : styles.tableCell)}
											style={{ width: 192 }}
										>
											<AppText
												selectable
												className={webText(index === 0 ? styles.tableHeader : styles.tableCell)}
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
					<AppView className="flex-col">
						<AppText className={webText(styles.h2)}>[{node.label ?? node.identifier}]</AppText>
						{blocks(node.children)}
					</AppView>
				);
			default:
				return (
					<AppText selectable className={webText(cardClassName)}>
						{inline(node)}
					</AppText>
				);
		}
	};
	return block(tree);
}

/** Stateless typography surface; link/image actions are owned by the caller. */
export function MarkdownBody({
	content,
	highlightQuery = "",
	onLink = () => {},
	onImage = () => {},
}: {
	content: string;
	highlightQuery?: string;
	onLink?: (url: string) => void;
	onImage?: (url: string, alt: string) => void;
}) {
	const t = useI18n();
	const tree = useMemo(() => parseDisplayMarkdown(content), [content]);
	return (
		<TextClassContext.Provider value={webText(cardClassName)}>
			{tree ? (
				<MarkdownTree
					tree={tree}
					query={highlightQuery}
					open={onLink}
					preview={onImage}
					imageLabel={t("markdown.image")}
				/>
			) : (
				<AppText selectable>{content}</AppText>
			)}
		</TextClassContext.Provider>
	);
}
