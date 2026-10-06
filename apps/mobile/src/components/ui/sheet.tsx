import { sheetClasses as styles } from "@clawdi/shared/ui";
import { X } from "lucide-react-native";
import { type ReactNode, useContext } from "react";
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
import { WebContent, WebText, WebView, webView } from "@/components/ui/web-layout";

type SlotProps = { children?: ReactNode; className?: string };
export function Sheet(props: ModalRootProps) {
	return <ModalRoot {...props} />;
}
export function SheetTrigger(props: ModalControlProps) {
	return <ModalControl {...props} />;
}
export function SheetClose(props: ModalControlProps) {
	return <ModalControl close {...props} />;
}
function SheetPortal({ children }: SlotProps) {
	return children;
}
function SheetOverlay(_props: SlotProps) {
	return null;
}
/** Native Modal slides into Web's requested edge, bounded by safe areas. */
export function SheetContent({
	side = "right",
	children,
	className,
	showCloseButton = true,
}: SlotProps & { side?: "top" | "right" | "bottom" | "left"; showCloseButton?: boolean }) {
	const modal = useContext(ModalContext),
		t = useI18n();
	return (
		<ModalSurface
			side={side}
			recipe={styles.content}
			overlayRecipe={styles.overlay}
			state={{ [`data-[side=${side}]`]: true }}
			className={className}
		>
			<WebView
				recipe={styles.content
					.split(/\s+/)
					.filter((token) => token.startsWith("gap-"))
					.join(" ")}
				className="flex-1"
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
export function SheetHeader({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.header} className={className}>
			{children}
		</WebView>
	);
}
export function SheetFooter({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.footer} className={className}>
			{children}
		</WebView>
	);
}
export function SheetTitle({ children, className }: SlotProps) {
	return (
		<WebText recipe={styles.title} className={className} accessibilityRole="header">
			{children}
		</WebText>
	);
}
export function SheetDescription({ children, className }: SlotProps) {
	return (
		<WebView recipe={styles.description} className={className}>
			<WebContent recipe={styles.description}>{children}</WebContent>
		</WebView>
	);
}
