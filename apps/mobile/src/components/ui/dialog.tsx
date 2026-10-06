import { dialogClasses as styles } from "@clawdi/shared/ui";
import { cn } from "cn";
import { X } from "lucide-react-native";
import { type ReactNode, useContext } from "react";
import type { ScrollViewProps } from "react-native";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
	ModalContext,
	ModalControl,
	type ModalControlProps,
	ModalRoot,
	type ModalRootProps,
	ModalSurface,
} from "@/components/ui/modal";
import { WebText, WebView, webView } from "@/components/ui/web-layout";

type SlotProps = { children?: ReactNode; className?: string };
export function Dialog(props: ModalRootProps) {
	return <ModalRoot {...props} />;
}
export function DialogTrigger(props: ModalControlProps) {
	return <ModalControl {...props} />;
}
export function DialogClose(props: ModalControlProps) {
	return <ModalControl close {...props} />;
}
/** Native Modal owns portal/backdrop; these compatibility slots don't add another layer. */
export function DialogPortal({ children }: SlotProps) {
	return children;
}
export function DialogOverlay(_props: SlotProps) {
	return null;
}
export function DialogContent({
	children,
	className,
	showCloseButton = true,
	style,
}: SlotProps & { showCloseButton?: boolean; style?: ScrollViewProps["style"] }) {
	const t = useI18n(),
		modal = useContext(ModalContext);
	return (
		<ModalSurface
			recipe={styles.content}
			overlayRecipe={styles.overlay}
			className={className}
			style={style}
		>
			<WebView
				recipe={cn(styles.content, className)
					.split(/\s+/)
					.filter((token) => token.startsWith("gap-"))
					.join(" ")}
			>
				{children}
			</WebView>
			{showCloseButton ? (
				<Button
					variant="ghost"
					size="icon-sm"
					className={webView(styles.closeAction)}
					accessibilityLabel={t("composite.close")}
					onPress={() => modal.setOpen(false)}
				>
					<Icon as={X} />
				</Button>
			) : null}
		</ModalSurface>
	);
}
export function DialogHeader({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.header} className={className}>
			{children}
		</WebView>
	);
}
export function DialogFooter({
	children,
	className,
	showCloseButton,
}: SlotProps & { showCloseButton?: boolean }) {
	const t = useI18n();
	return (
		<WebView recipe={styles.footer} className={className}>
			{children}
			{showCloseButton ? <DialogClose variant="outline">{t("composite.close")}</DialogClose> : null}
		</WebView>
	);
}
export function DialogTitle({ children, className }: SlotProps) {
	return (
		<WebText recipe={styles.title} accessibilityRole="header" className={className}>
			{children}
		</WebText>
	);
}
export function DialogDescription({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.description} className={className}>
			{typeof children === "string" ? (
				<WebText recipe={styles.description}>{children}</WebText>
			) : (
				children
			)}
		</WebView>
	);
}
