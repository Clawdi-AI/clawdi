import {
	cloneElement,
	createContext,
	type ReactElement,
	type ReactNode,
	useContext,
	useState,
} from "react";
import { KeyboardAvoidingView, Modal, Platform, type PressableProps } from "react-native";
import { Button, type ButtonProps } from "./button";
import { Content } from "./content";
import { TextClassContext } from "./text";
import { AppPressable, AppSafeAreaView, AppScrollView } from "./view";
import { resolveWebClasses, type WebClassState } from "./web-classes";

export const ModalContext = createContext({ open: false, setOpen: (_open: boolean) => {} });
export type ModalRootProps = {
	children: ReactNode;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
};
export function ModalRoot({ children, open, defaultOpen = false, onOpenChange }: ModalRootProps) {
	const [internal, setInternal] = useState(defaultOpen);
	return (
		<ModalContext.Provider
			value={{
				open: open ?? internal,
				setOpen: (next) => {
					setInternal(next);
					onOpenChange?.(next);
				},
			}}
		>
			{children}
		</ModalContext.Provider>
	);
}
export type ModalControlProps = Omit<ButtonProps, "children"> & {
	children?: ReactNode;
	render?: ReactElement<PressableProps>;
};
/** Web `render` is a native Pressable/Button element; clone its onPress instead of DOM onClick. */
export function ModalControl({
	render,
	close = false,
	onPress,
	children,
	...props
}: ModalControlProps & { close?: boolean }) {
	const modal = useContext(ModalContext);
	const press: PressableProps["onPress"] = (event) => {
		render?.props.onPress?.(event);
		onPress?.(event);
		if (!event.isDefaultPrevented()) modal.setOpen(!close);
	};
	if (render)
		return children === undefined
			? cloneElement(render, { ...props, onPress: press })
			: cloneElement(render, { ...props, onPress: press }, <Content>{children}</Content>);
	return (
		<Button {...props} onPress={press}>
			<Content>{children}</Content>
		</Button>
	);
}
/** Native Modal supplies the portal, focus/accessibility isolation and back dismissal.
 * CSS viewport centering becomes SafeAreaView layout; shared recipes style the actual surface. */
export function ModalSurface({
	children,
	recipe,
	overlayRecipe,
	state,
	className,
	dismissible = true,
	side,
}: {
	children: ReactNode;
	recipe: string;
	overlayRecipe: string;
	state?: WebClassState;
	className?: string;
	dismissible?: boolean;
	side?: "top" | "right" | "bottom" | "left";
}) {
	const modal = useContext(ModalContext);
	const classes = resolveWebClasses(recipe, state);
	const placement =
		side === "bottom"
			? "justify-end"
			: side === "top"
				? "justify-start"
				: side === "left"
					? "items-start"
					: side === "right"
						? "items-end"
						: "items-center justify-center px-4";
	// Native Modal owns viewport positioning; retain recipe size/radius/padding/tokens.
	const surface = classes.view
		.split(/\s+/)
		.filter(
			(token) =>
				!/^(?:fixed|absolute|top-|left-|right-|bottom-|inset-|z-|-?translate-)/.test(token),
		)
		.join(" ");
	const overlay = resolveWebClasses(overlayRecipe).view.replace(/\bfixed\b/g, "absolute");
	const dismiss = () => {
		if (dismissible) modal.setOpen(false);
	};
	return (
		<Modal
			transparent
			visible={modal.open}
			animationType="fade"
			onRequestClose={dismiss}
			statusBarTranslucent
		>
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : undefined}
				style={{ flex: 1 }}
			>
				<AppPressable accessibilityElementsHidden className={overlay} onPress={dismiss} />
				<AppSafeAreaView pointerEvents="box-none" className={`flex-1 ${placement}`}>
					<TextClassContext.Provider value={classes.text}>
						<AppScrollView
							accessibilityViewIsModal
							keyboardShouldPersistTaps="handled"
							className={`${surface} ${className ?? ""}`}
							style={{ flexGrow: 0, flexShrink: 1 }}
							contentContainerStyle={{ flexGrow: 1 }}
						>
							{children}
						</AppScrollView>
					</TextClassContext.Provider>
				</AppSafeAreaView>
			</KeyboardAvoidingView>
		</Modal>
	);
}
