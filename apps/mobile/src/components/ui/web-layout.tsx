import { cn } from "cn";
import type { LucideIcon } from "lucide-react-native";
import { type ComponentProps, type ReactNode, useContext } from "react";
import { Content } from "@/components/ui/content";
import { Icon } from "@/components/ui/icon";
import { Text, TextClassContext } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { resolveWebClasses, type WebClassState } from "@/lib/web-classes";

export const webView = (classes: string, state?: WebClassState) =>
	resolveWebClasses(classes, state).view;
export const webText = (classes: string, state?: WebClassState) =>
	resolveWebClasses(classes, state).text;
export const webBoth = (classes: string, state?: WebClassState) => {
	const resolved = resolveWebClasses(classes, state);
	return cn(resolved.view, resolved.text);
};
/** DOM text inheritance, layout and state translation from shared Web recipes. */
export function WebView({
	recipe,
	state,
	className,
	...props
}: ComponentProps<typeof AppView> & { recipe: string; state?: WebClassState }) {
	const inherited = useContext(TextClassContext);
	const classes = resolveWebClasses(cn(recipe, className), state);
	return (
		<TextClassContext.Provider value={cn(inherited, classes.text)}>
			<AppView className={classes.view} {...props} />
		</TextClassContext.Provider>
	);
}
export function WebText({
	recipe,
	state,
	className,
	...props
}: ComponentProps<typeof Text> & { recipe: string; state?: WebClassState }) {
	return <Text className={cn(webBoth(recipe, state), className)} {...props} />;
}
export function WebContent({ recipe, children }: { recipe: string; children?: ReactNode }) {
	return <Content className={webBoth(recipe)}>{children}</Content>;
}
export function WebIcon({ as, recipe }: { as: LucideIcon; recipe: string }) {
	return <Icon as={as} className={webBoth(recipe)} />;
}
