import {
	type EntityCardVariant,
	entityCardClasses,
	ENTITY_CARD_ACTIONS_ALWAYS_CLASS as WEB_ENTITY_CARD_ACTIONS_ALWAYS_CLASS,
	ENTITY_CARD_ACTIONS_CLASS as WEB_ENTITY_CARD_ACTIONS_CLASS,
	ENTITY_CARD_BASE as WEB_ENTITY_CARD_BASE,
	ENTITY_CARD_CHASSIS_CLASS as WEB_ENTITY_CARD_CHASSIS_CLASS,
	ENTITY_CARD_STRETCHED_LINK_CLASS as WEB_ENTITY_CARD_STRETCHED_LINK_CLASS,
	ENTITY_CHOICE_GRID_CLASS as WEB_ENTITY_CHOICE_GRID_CLASS,
	ENTITY_GRID_CLASS as WEB_ENTITY_GRID_CLASS,
	ENTITY_STRETCHED_LINK_CLASS as WEB_ENTITY_STRETCHED_LINK_CLASS,
	HERO_GRID_CLASS as WEB_HERO_GRID_CLASS,
	HERO_STRETCHED_LINK_CLASS as WEB_HERO_STRETCHED_LINK_CLASS,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { type Href, router } from "expo-router";
import Check from "lucide-react-native/icons/check";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Plus from "lucide-react-native/icons/plus";
import type { ReactNode } from "react";
import { IconChip } from "@/components/icon-chip";
import { TruncatedText } from "@/components/truncated-text";
import { Content } from "@/components/ui/content";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Text, TextClassContext } from "@/components/ui/text";
import { AppPressable, AppView } from "@/components/ui/view";
import { webBoth, webText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { TouchTargetContext, touchTargetsFor } from "@/platform/touch-target";

/** Web entity-card family; grids are single-column phone stacks, links use Expo Router. */
const ENTITY_CARD_CHASSIS_CLASS = {
	resource: webView(WEB_ENTITY_CARD_CHASSIS_CLASS.resource),
	compact: webView(WEB_ENTITY_CARD_CHASSIS_CLASS.compact),
};

export const ENTITY_CARD_BASE = webView(WEB_ENTITY_CARD_BASE);

export const HERO_GRID_CLASS = webView(WEB_HERO_GRID_CLASS);
export const ENTITY_GRID_CLASS = webView(WEB_ENTITY_GRID_CLASS);
export const ENTITY_CHOICE_GRID_CLASS = webView(WEB_ENTITY_CHOICE_GRID_CLASS);
const ENTITY_CARD_STRETCHED_LINK_CLASS = {
	resource: webView(WEB_ENTITY_CARD_STRETCHED_LINK_CLASS.resource),
	compact: webView(WEB_ENTITY_CARD_STRETCHED_LINK_CLASS.compact),
};
const ENTITY_STRETCHED_LINK_CLASS = webView(WEB_ENTITY_STRETCHED_LINK_CLASS);
const HERO_STRETCHED_LINK_CLASS = webView(WEB_HERO_STRETCHED_LINK_CLASS);

const ENTITY_CARD_ACTIONS_CLASS = webView(WEB_ENTITY_CARD_ACTIONS_CLASS);
const ENTITY_CARD_ACTIONS_ALWAYS_CLASS = webView(WEB_ENTITY_CARD_ACTIONS_ALWAYS_CLASS);
function entityCardChassisClass({
	variant,
	interactive = false,
	className,
}: {
	variant: EntityCardVariant;
	interactive?: boolean;
	className?: string;
}) {
	return cn(
		ENTITY_CARD_CHASSIS_CLASS[variant],
		webView(entityCardClasses.chassis),
		interactive &&
			(variant === "resource"
				? webView(entityCardClasses.resourceInteractive)
				: webView(entityCardClasses.compactInteractive)),
		className,
	);
}
export function EntityCardChassis({
	variant,
	interactive,
	className,
	children,
}: {
	variant: EntityCardVariant;
	interactive?: boolean;
	as?: "div" | "article";
	className?: string;
	children: ReactNode;
}) {
	return (
		<AppView className={entityCardChassisClass({ variant, interactive, className })}>
			{children}
		</AppView>
	);
}
export function EntityCardActions({
	children,
	className,
	visibility = "responsive",
}: {
	children: ReactNode;
	className?: string;
	visibility?: "responsive" | "always";
}) {
	return (
		<TouchTargetContext.Provider
			value={touchTargetsFor(
				visibility === "responsive"
					? WEB_ENTITY_CARD_ACTIONS_CLASS
					: WEB_ENTITY_CARD_ACTIONS_ALWAYS_CLASS,
			)}
		>
			<AppView
				className={cn(
					ENTITY_CARD_ACTIONS_CLASS,
					visibility === "always" && ENTITY_CARD_ACTIONS_ALWAYS_CLASS,
					className,
				)}
			>
				{children}
			</AppView>
		</TouchTargetContext.Provider>
	);
}
export type EntityCardLinkOptions = {
	to: Href;
	params?: Record<string, string>;
	search?: Record<string, string>;
	hash?: string;
};
function navigate({ to, params, search, hash }: EntityCardLinkOptions) {
	if (typeof to !== "string") {
		router.push(to);
		return;
	}
	let pathname: string = to;
	for (const [name, value] of Object.entries(params ?? {}))
		pathname = pathname.replace(`$${name}`, encodeURIComponent(value));
	const query = new URLSearchParams(search).toString();
	router.push(
		`${pathname}${query ? `?${query}` : ""}${hash ? `#${encodeURIComponent(hash)}` : ""}` as Href,
	);
}
/** Overlay goes behind content; pointerEvents box-none on card content keeps controls independent. */
export function EntityCardLink({
	variant,
	ariaLabel,
	className,
	testID,
	...link
}: EntityCardLinkOptions & {
	variant: EntityCardVariant;
	ariaLabel: string;
	className?: string;
	testID?: string;
}) {
	return (
		<AppPressable
			testID={testID}
			accessibilityRole="link"
			accessibilityLabel={ariaLabel}
			className={cn(ENTITY_CARD_STRETCHED_LINK_CLASS[variant], className)}
			onPress={() => navigate(link)}
		/>
	);
}
function entityChoiceCardClass({
	variant = "card",
	selected = false,
	interactive = false,
	disabled = false,
	className,
}: {
	variant?: "card" | "compact";
	selected?: boolean;
	interactive?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	return cn(
		variant === "compact" ? webView(entityCardClasses.compactChoice) : ENTITY_CARD_BASE,
		webView(entityCardClasses.choiceRoot),
		variant === "compact"
			? webView(entityCardClasses.choiceCompactLayout)
			: webView(entityCardClasses.choiceLayout),
		selected
			? webView(entityCardClasses.choiceSelectedFill)
			: interactive &&
					(variant === "compact"
						? webView(entityCardClasses.compactChoiceInteractive)
						: webView(entityCardClasses.compactInteractive)),
		disabled && webView(entityCardClasses.disabled),
		className,
	);
}
export function EntityMeta({
	items,
	className,
	wrap = false,
}: {
	items: ReactNode | ReactNode[];
	className?: string;
	wrap?: boolean;
}) {
	const arr = (Array.isArray(items) ? items : [items]).filter(
		(item) => item !== null && item !== undefined && item !== false && item !== "",
	);
	if (!arr.length) return null;
	return (
		<TextClassContext.Provider value={cn(webText(entityCardClasses.meta), className)}>
			<AppView
				className={cn(
					webView(entityCardClasses.meta),
					wrap ? webView(entityCardClasses.metaWrap) : webView(entityCardClasses.metaTruncate),
					className,
				)}
			>
				{arr.map((item, index) => (
					<AppView
						key={`${typeof item === "string" || typeof item === "number" ? item : "node"}:${index}`}
						className={cn(
							cn(webView(entityCardClasses.metaItem), "flex-shrink"),
							wrap && webView(entityCardClasses.metaItemWrap),
						)}
					>
						{index > 0 && !wrap ? (
							<Text className={webBoth(entityCardClasses.metaSeparator)}>·</Text>
						) : null}
						{typeof item === "string" || typeof item === "number" ? (
							<TruncatedText className={className}>{item}</TruncatedText>
						) : (
							item
						)}
					</AppView>
				))}
			</AppView>
		</TextClassContext.Provider>
	);
}
export function EntityHeader({
	icon,
	title,
	titleAdornment,
	meta,
	align = "center",
	className,
	titleClassName,
	titleAttribute,
}: {
	icon: ReactNode;
	title: ReactNode;
	titleAdornment?: ReactNode;
	meta?: ReactNode | ReactNode[];
	align?: "center" | "start";
	className?: string;
	titleClassName?: string;
	titleAttribute?: string;
}) {
	return (
		<AppView
			className={cn(
				webView(entityCardClasses.header),
				align === "start"
					? webView(entityCardClasses.headerStart)
					: webView(entityCardClasses.headerCenter),
				className,
			)}
		>
			{icon}
			<AppView className={webView(entityCardClasses.body)}>
				<AppView className={webView(entityCardClasses.headerTitleRow)}>
					<AppView className={webView(entityCardClasses.body)}>
						<Content className={cn(webText(entityCardClasses.title), titleClassName)}>
							{typeof title === "string" || typeof title === "number" ? (
								<TruncatedText title={titleAttribute}>{title}</TruncatedText>
							) : (
								title
							)}
						</Content>
					</AppView>
					{titleAdornment ? (
						<AppView className={webView(entityCardClasses.shrink)}>{titleAdornment}</AppView>
					) : null}
				</AppView>
				{meta !== undefined ? <EntityMeta items={meta} /> : null}
			</AppView>
		</AppView>
	);
}
export function HeroCard({
	testID,
	icon,
	title,
	badges,
	description,
	footer,
	actions,
	actionsVisibility = "responsive",
	link,
	onClick,
	ariaLabel,
	className,
	titleClassName,
	titleAttribute,
	descriptionClassName,
	footerClassName,
	footerWrap = false,
	children,
}: {
	testID?: string;
	icon?: ReactNode;
	title: ReactNode;
	badges?: ReactNode;
	description?: ReactNode;
	footer?: ReactNode | ReactNode[];
	actions?: ReactNode;
	actionsVisibility?: "responsive" | "always";
	link?: EntityCardLinkOptions;
	onClick?: () => void;
	ariaLabel?: string;
	className?: string;
	titleClassName?: string;
	titleAttribute?: string;
	descriptionClassName?: string;
	footerClassName?: string;
	footerWrap?: boolean;
	children?: ReactNode;
}) {
	const t = useI18n();
	return (
		<EntityCardChassis
			variant="resource"
			interactive={Boolean(link || onClick)}
			className={cn(webView(entityCardClasses.heroFrame), className)}
		>
			{link ? (
				<EntityCardLink
					testID={testID}
					variant="resource"
					{...link}
					ariaLabel={ariaLabel ?? t("composite.open")}
				/>
			) : onClick ? (
				<AppPressable
					testID={testID}
					accessibilityRole="button"
					accessibilityLabel={ariaLabel ?? t("composite.open")}
					onPress={onClick}
					className={HERO_STRETCHED_LINK_CLASS}
				/>
			) : null}
			<AppView pointerEvents="box-none" className={webView(entityCardClasses.heroStack)}>
				{icon || actions ? (
					<AppView pointerEvents="box-none" className={webView(entityCardClasses.heroTop)}>
						{icon ? (
							<AppView pointerEvents="none" className={webView(entityCardClasses.shrink)}>
								{icon}
							</AppView>
						) : (
							<AppView />
						)}
						{actions ? (
							<EntityCardActions visibility={actionsVisibility}>{actions}</EntityCardActions>
						) : null}
					</AppView>
				) : null}
				<AppView pointerEvents="none" className={webView(entityCardClasses.heroBody)}>
					<AppView className={webView(entityCardClasses.titleRow)}>
						<AppView className={webView(entityCardClasses.body)}>
							<Content className={cn(webText(entityCardClasses.title), titleClassName)}>
								{typeof title === "string" || typeof title === "number" ? (
									<TruncatedText title={titleAttribute}>{title}</TruncatedText>
								) : (
									title
								)}
							</Content>
						</AppView>
						{badges ? (
							<AppView className={webView(entityCardClasses.heroBadges)}>{badges}</AppView>
						) : null}
					</AppView>
					{description ? (
						<Text
							numberOfLines={2}
							className={cn(webBoth(entityCardClasses.heroDescription), descriptionClassName)}
						>
							{description}
						</Text>
					) : null}
				</AppView>
				{children}
				{footer !== undefined ? (
					<AppView pointerEvents="none" className={webView(entityCardClasses.heroFooter)}>
						<EntityMeta
							items={footer}
							className={cn(webText(entityCardClasses.heroFooter), footerClassName)}
							wrap={footerWrap}
						/>
					</AppView>
				) : null}
			</AppView>
		</EntityCardChassis>
	);
}
export function EntityRow({
	icon,
	title,
	titleAdornment,
	meta,
	status,
	actions,
	trailing,
	link,
	ariaLabel,
	onClick,
	disabled,
	className,
}: {
	icon: ReactNode;
	title: ReactNode;
	titleAdornment?: ReactNode;
	meta?: ReactNode | ReactNode[];
	status?: ReactNode;
	actions?: ReactNode;
	trailing?: ReactNode;
	link?: EntityCardLinkOptions;
	ariaLabel?: string;
	onClick?: () => void;
	disabled?: boolean;
	className?: string;
}) {
	const t = useI18n();
	return (
		<EntityCardChassis
			variant="compact"
			interactive={Boolean(link || onClick)}
			className={cn(disabled && webView(entityCardClasses.disabled), className)}
		>
			{link && !disabled ? (
				<EntityCardLink
					variant="compact"
					{...link}
					ariaLabel={ariaLabel ?? (typeof title === "string" ? title : t("composite.open"))}
				/>
			) : onClick ? (
				<AppPressable
					accessibilityRole="button"
					accessibilityLabel={
						ariaLabel ?? (typeof title === "string" ? title : t("composite.open"))
					}
					disabled={disabled}
					onPress={onClick}
					className={ENTITY_STRETCHED_LINK_CLASS}
				/>
			) : null}
			<AppView pointerEvents="box-none" className={webView(entityCardClasses.row)}>
				<AppView pointerEvents="none" className={webView(entityCardClasses.body)}>
					<EntityHeader icon={icon} title={title} titleAdornment={titleAdornment} meta={meta} />
				</AppView>
				{status ? (
					<AppView pointerEvents="none" className={webView(entityCardClasses.shrink)}>
						{status}
					</AppView>
				) : null}
				{trailing ? (
					<AppView className={webView(entityCardClasses.shrink)}>{trailing}</AppView>
				) : null}
				{actions ? <EntityCardActions visibility="always">{actions}</EntityCardActions> : null}
				{link && !actions && !trailing ? (
					<Icon as={ChevronRight} className={webBoth(entityCardClasses.chevron)} />
				) : null}
			</AppView>
		</EntityCardChassis>
	);
}
export function EntityChoiceCard({
	icon,
	title,
	description,
	details,
	detailsPlacement = "stacked",
	badge,
	selected,
	onClick,
	href,
	disabled,
	variant = "card",
	className,
}: {
	icon: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	details?: ReactNode;
	detailsPlacement?: "stacked" | "trailing" | "responsive";
	badge?: ReactNode;
	selected?: boolean;
	onClick?: () => void;
	href?: Href;
	disabled?: boolean;
	variant?: "card" | "compact";
	className?: string;
}) {
	const content = (
		<>
			<AppView className={webView(entityCardClasses.shrink)}>{icon}</AppView>
			<AppView
				className={cn(
					webView(entityCardClasses.body),
					details && detailsPlacement === "trailing" && webView(entityCardClasses.skeletonRow),
					details &&
						detailsPlacement === "responsive" &&
						webView(entityCardClasses.choiceResponsiveDetails),
				)}
			>
				<AppView className={webView(entityCardClasses.body)}>
					<AppView className={webView(entityCardClasses.headerTitleRow)}>
						<AppView className={webView(entityCardClasses.body)}>
							<Content className={webText(entityCardClasses.title)}>
								{typeof title === "string" || typeof title === "number" ? (
									<TruncatedText>{title}</TruncatedText>
								) : (
									title
								)}
							</Content>
						</AppView>
						{badge ? (
							<AppView className={webView(entityCardClasses.shrink)}>{badge}</AppView>
						) : null}
					</AppView>
					{description ? (
						<Text
							numberOfLines={variant === "compact" ? 1 : undefined}
							className={cn(
								webBoth(entityCardClasses.choiceDescription),
								variant === "compact"
									? webText(entityCardClasses.compactChoiceDescription)
									: webText(entityCardClasses.fullChoiceDescription),
							)}
						>
							{description}
						</Text>
					) : null}
				</AppView>
				{details ? (
					<AppView
						className={cn(
							webView(entityCardClasses.heroBody),
							detailsPlacement === "trailing"
								? webView(entityCardClasses.choiceTrailingDetails)
								: detailsPlacement === "responsive"
									? webView(entityCardClasses.choiceResponsiveDetailsBody)
									: webView(entityCardClasses.choiceStackedDetails),
						)}
					>
						<Content className={webBoth(entityCardClasses.fullChoiceDescription)}>
							{details}
						</Content>
					</AppView>
				) : null}
			</AppView>
			{selected !== undefined ? (
				<AppView className={webView(entityCardClasses.choiceIndicator)}>
					{selected ? <Icon as={Check} className={webBoth(entityCardClasses.choiceCheck)} /> : null}
				</AppView>
			) : null}
		</>
	);
	const classes = entityChoiceCardClass({
		variant,
		selected,
		interactive: Boolean(onClick || href),
		disabled,
		className,
	});
	return href || onClick ? (
		<AppPressable
			accessibilityRole="button"
			accessibilityState={{ selected, disabled }}
			disabled={disabled}
			onPress={() => (href ? router.push(href) : onClick?.())}
			className={classes}
		>
			{content}
		</AppPressable>
	) : (
		<AppView className={classes}>{content}</AppView>
	);
}
export function EntityAddCard({
	title,
	description,
	onClick,
	href,
}: {
	title: string;
	description: string;
	onClick?: () => void;
	href?: Href;
}) {
	return (
		<EntityChoiceCard
			onClick={onClick}
			href={href}
			icon={
				<IconChip>
					<Icon as={Plus} />
				</IconChip>
			}
			title={title}
			description={description}
			className={webView(entityCardClasses.addSurface)}
		/>
	);
}

export function EntityCardSkeleton({
	iconSize = "md",
	align = "center",
	metaLines = 1,
	statusDot = false,
	titleBadge = false,
	trailingBadge = false,
	actions = false,
	className,
}: {
	iconSize?: "sm" | "md";
	align?: "center" | "start";
	metaLines?: 0 | 1 | 2;
	statusDot?: boolean;
	titleBadge?: boolean;
	trailingBadge?: boolean;
	actions?: boolean;
	className?: string;
}) {
	return (
		<AppView className={entityCardChassisClass({ variant: "compact", className })}>
			<AppView
				className={cn(
					webView(entityCardClasses.skeletonLayout),
					webView(
						align === "start"
							? entityCardClasses.skeletonAlignStart
							: entityCardClasses.skeletonAlignCenter,
					),
				)}
			>
				<Skeleton
					className={cn(
						webView(entityCardClasses.shrink),
						iconSize === "sm"
							? webView(entityCardClasses.smallSkeletonIcon)
							: webView(entityCardClasses.skeletonIcon),
					)}
				/>
				<AppView className={webView(entityCardClasses.body)}>
					<AppView className={webView(entityCardClasses.skeletonTitleRow)}>
						{statusDot ? <Skeleton className={webView(entityCardClasses.skeletonDot)} /> : null}
						{/* `h-lh` has no RN equivalent; h-5 is the text-sm line height. */}
						<Skeleton className={cn(webView(entityCardClasses.skeletonTitle), "h-5")} />
						{titleBadge ? <Skeleton className={webView(entityCardClasses.skeletonBadge)} /> : null}
					</AppView>
					{metaLines > 0 ? (
						<AppView className={webView(entityCardClasses.skeletonMetaLines)}>
							<Skeleton className={cn(webView(entityCardClasses.skeletonMeta), "h-5")} />
							{metaLines > 1 ? (
								<Skeleton className={cn(webView(entityCardClasses.skeletonSecondMeta), "h-5")} />
							) : null}
						</AppView>
					) : null}
				</AppView>
				{trailingBadge ? <Skeleton className={webView(entityCardClasses.skeletonBadge)} /> : null}
			</AppView>
			{actions ? (
				<AppView className={webView(entityCardClasses.skeletonActions)}>
					<Skeleton className={webView(entityCardClasses.skeletonPrimaryAction)} />
					<Skeleton className={webView(entityCardClasses.skeletonSecondaryAction)} />
					<Skeleton className={webView(entityCardClasses.skeletonMoreAction)} />
				</AppView>
			) : null}
		</AppView>
	);
}

/** Loading shape for top-level resource cards. */
export function HeroCardSkeleton({
	compact = false,
	iconSize = compact ? "sm" : "md",
	footerItems = 2,
	className,
}: {
	compact?: boolean;
	iconSize?: "sm" | "md";
	footerItems?: 0 | 1 | 2;
	className?: string;
}) {
	return (
		<AppView
			className={entityCardChassisClass({
				variant: "resource",
				className: cn(
					webView(entityCardClasses.heroSkeletonRoot),
					compact
						? webView(entityCardClasses.compactHeroSkeleton)
						: webView(entityCardClasses.heroSkeleton),
					className,
				),
			})}
			accessibilityElementsHidden
		>
			<Skeleton
				className={
					iconSize === "sm"
						? webView(entityCardClasses.compactHeroSkeletonIcon)
						: webView(entityCardClasses.skeletonIcon)
				}
			/>
			<AppView className={webView(entityCardClasses.heroSkeletonBody)}>
				{/* `h-lh` has no RN equivalent; heights match each line's type scale. */}
				<AppView className={webView(entityCardClasses.heroSkeletonTitleLine)}>
					<Skeleton className={cn(webView(entityCardClasses.heroSkeletonTitle), "h-5")} />
				</AppView>
				<AppView className={webView(entityCardClasses.heroSkeletonDescriptionLine)}>
					<Skeleton className={cn(webView(entityCardClasses.heroSkeletonDescription), "h-5")} />
				</AppView>
			</AppView>
			{footerItems > 0 ? (
				<AppView className={webView(entityCardClasses.heroSkeletonFooter)}>
					<Skeleton className={cn(webView(entityCardClasses.heroSkeletonFirstFact), "h-4")} />
					{footerItems > 1 ? (
						<Skeleton className={cn(webView(entityCardClasses.heroSkeletonSecondFact), "h-4")} />
					) : null}
				</AppView>
			) : null}
		</AppView>
	);
}
