import { ApiClientError, ApiClientNetworkError } from "@clawdi/shared/api";
import {
	cardContentClassName,
	cardDescriptionClassName,
	cardTitleClassName,
	pageHeaderClasses,
} from "@clawdi/shared/ui";
import {
	FRAMEWORK_BRAND_ICON_IDS,
	identityFor,
	PROVIDER_BRAND_ICON_IDS,
	relativeTime,
} from "@clawdi/shared/view";
import Archive from "lucide-react-native/icons/archive";
import MoreHorizontal from "lucide-react-native/icons/ellipsis";
import Folder from "lucide-react-native/icons/folder";
import KeyRound from "lucide-react-native/icons/key-round";
import Plus from "lucide-react-native/icons/plus";
import Search from "lucide-react-native/icons/search";
import Settings from "lucide-react-native/icons/settings";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { type ReactNode, useState } from "react";
import { FlatList } from "react-native";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { BrandIconTile } from "@/components/brand-icon-tile";
import {
	DashboardEmptyLine,
	DashboardSection,
	DashboardSectionHeader,
	DashboardSectionToolbar,
} from "@/components/dashboard/section";
import { EmptyState } from "@/components/empty-state";
import { frameworkBrandIcon } from "@/components/entity-brand-icons";
import {
	EntityAddCard,
	EntityCardActions,
	EntityCardChassis,
	EntityCardLink,
	EntityCardSkeleton,
	EntityChoiceCard,
	EntityHeader,
	EntityMeta,
	EntityRow,
	HeroCard,
	HeroCardSkeleton,
} from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { FilterChip } from "@/components/filter-chip";
import { HeaderActionGroup } from "@/components/header-action-group";
import { IconChip } from "@/components/icon-chip";
import { ListToolbar } from "@/components/list-toolbar";
import { MarkdownBody } from "@/components/markdown";
import { PageHeader, PageHeaderSkeleton } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { SectionLabel } from "@/components/section-label";
import { TimeTooltip } from "@/components/time-tooltip";
import { TruncatedText } from "@/components/truncated-text";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { AppSafeAreaView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { NativeSegments } from "@/platform/navigation/segmented-control";

const buttonVariants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const buttonSizes = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
const tones: StatusTone[] = ["success", "warning", "destructive", "info", "neutral"];
const noop = () => {};
const sampleName = "Atlas Research";
const markdown =
	"# Atlas Research\n\n## Shared context\n\nA project keeps **skills**, `keys`, and agent context together.\n\n### Notes\n\n- Review the weekly report\n- Keep [project context](https://clawdi.ai) current\n\n> Changes apply everywhere.\n\n```typescript\nconst project = 'Atlas Research';\n```\n\n| Resource | Count |\n| --- | ---: |\n| Skills | 12 |\n| Vaults | 2 |";

/** Technical component/variant labels are developer identifiers, not product copy. */
function GallerySection({ name, children }: { name: string; children: ReactNode }) {
	return (
		<WebView recipe={cardContentClassName}>
			<SectionLabel>{name}</SectionLabel>
			{children}
		</WebView>
	);
}
function Gallery() {
	const t = useI18n(),
		[filter, setFilter] = useState(false),
		[checked, setChecked] = useState(true),
		[choice, setChoice] = useState("projects"),
		[confirmed, setConfirmed] = useState(false);
	const identity = identityFor(sampleName),
		brand = frameworkBrandIcon("codex");
	const icon = (
		<IconChip tint={identity.colorClasses}>
			<Text>{identity.emoji}</Text>
		</IconChip>
	);
	const sections: { name: string; render: () => ReactNode }[] = [
		{
			name: "PageHeader / HeaderActionGroup",
			render: () => (
				<>
					<PageHeader
						title={t("projects.title")}
						description={t("projects.description")}
						headerActions={[{ id: "create", label: t("projects.create"), onPress: noop }]}
					/>
					<PageHeader
						icon={icon}
						title={sampleName}
						titleAdornment={
							<Badge variant="secondary">
								<Text>{t("projects.shared")}</Text>
							</Badge>
						}
						status={
							<StatusBadge withDot status="success">
								<Text>{t("sharing.active")}</Text>
							</StatusBadge>
						}
					/>
					<PageHeaderSkeleton icon />
					<PageHeaderSkeleton description={false} />
					<HeaderActionGroup>
						<Button variant="outline">
							<Text>{t("projects.edit")}</Text>
						</Button>
						<Button variant="ghost">
							<Text>{t("inventory.viewAll")}</Text>
						</Button>
					</HeaderActionGroup>
				</>
			),
		},
		{
			name: "Text / View / Card",
			render: () => (
				<>
					{(["default", "sm"] as const).map((size) => (
						<Card key={size} size={size}>
							<CardHeader>
								<CardTitle>{sampleName}</CardTitle>
								<CardDescription>{t("projects.description")}</CardDescription>
								<CardAction>
									<Badge variant="secondary">
										<Text>{size}</Text>
									</Badge>
								</CardAction>
							</CardHeader>
							<CardContent>
								<Text>{t("projects.agentsScope")}</Text>
							</CardContent>
							<CardFooter>
								<Button variant="outline">
									<Text>{t("projects.open")}</Text>
								</Button>
							</CardFooter>
						</Card>
					))}
				</>
			),
		},
		{
			name: "Button",
			render: () => (
				<>
					{buttonVariants.map((variant) => (
						<ListToolbar
							key={variant}
							filters={
								<>
									{buttonSizes.map((size) => (
										<Button
											key={size}
											size={size}
											variant={variant}
											accessibilityLabel={`${variant}/${size}`}
										>
											{size.startsWith("icon") ? (
												<Icon as={Plus} />
											) : (
												<Text>
													{variant}/{size}
												</Text>
											)}
										</Button>
									))}
									<Button variant={variant} disabled>
										<Text>{variant}</Text>
									</Button>
								</>
							}
						/>
					))}
				</>
			),
		},
		{
			name: "Badge / StatusBadge / StatusDot",
			render: () => (
				<>
					<ListToolbar
						filters={buttonVariants.map((variant) => (
							<Badge key={variant} variant={variant}>
								<Text>{variant}</Text>
							</Badge>
						))}
					/>
					{tones.map((status) => (
						<ListToolbar
							key={status}
							filters={
								<>
									<StatusBadge status={status}>
										<Text>{status}</Text>
									</StatusBadge>
									<StatusBadge status={status} withDot>
										<Text>{status}</Text>
									</StatusBadge>
									<StatusDot status={status} />
								</>
							}
						/>
					))}
				</>
			),
		},
		{
			name: "Input / Label / Textarea",
			render: () => (
				<>
					<Label>{t("projects.name")}</Label>
					<Input value={sampleName} />
					<Input placeholder={t("projects.name")} />
					<Input value={sampleName} editable={false} />
					<Input multiline defaultValue={t("projects.description")} />
				</>
			),
		},
		{
			name: "Avatar / Icon / IconChip / EntityIcon / BrandIconTile / AgentFrameworkIcon",
			render: () => (
				<>
					<ListToolbar
						filters={
							<>
								{(["sm", "default", "lg"] as const).map((size) => (
									<Avatar key={size} size={size} fallback="AR" />
								))}
								<Avatar src="https://assets.clawdi.ai/icons/telegram.png" fallback="AR" />
								<Icon as={Search} />
								{(["xs", "sm", "md", "lg"] as const).map((size) => (
									<IconChip key={size} size={size}>
										<Icon as={Folder} />
									</IconChip>
								))}
								{icon}
								{brand ? (
									<BrandIconTile
										icon={brand.icon}
										label={brand.label}
										boxClassName={webView(pageHeaderClasses.skeletonIcon)}
									/>
								) : null}
							</>
						}
					/>
					{(["sm", "md", "lg"] as const).map((size) => (
						<ListToolbar
							key={size}
							filters={
								<>
									{["telegram", "discord", "whatsapp", "slack", "unknown"].map((id) => (
										<EntityIcon key={id} kind="channel" id={id} size={size} />
									))}
									<EntityIcon kind="provider" id="unknown" size={size} />
									<EntityIcon kind="framework" id="unknown" size={size} />
								</>
							}
						/>
					))}
					<ListToolbar
						filters={
							<>
								{PROVIDER_BRAND_ICON_IDS.map((id) => (
									<EntityIcon key={id} kind="provider" id={id} />
								))}
								{FRAMEWORK_BRAND_ICON_IDS.map((id) => (
									<EntityIcon key={id} kind="framework" id={id} />
								))}
								<AgentFrameworkIcon
									agent="unknown"
									pixelSize={40}
									boxClassName={webView(pageHeaderClasses.skeletonIcon)}
								/>
								<AgentFrameworkIcon
									agent="unknown"
									fallback="monogram"
									label={sampleName}
									pixelSize={40}
									boxClassName={webView(pageHeaderClasses.skeletonIcon)}
								/>
							</>
						}
					/>
				</>
			),
		},
		{
			name: "Separator / Skeleton",
			render: () => (
				<>
					<Separator />
					<ListToolbar
						filters={
							<>
								<Separator orientation="vertical" />
								<Skeleton className={webView(pageHeaderClasses.skeletonIcon)} />
								<Skeleton className={webView(pageHeaderClasses.skeletonTitle)} />
							</>
						}
					/>
				</>
			),
		},
		{
			name: "Alert / EmptyState / ApiErrorPanel",
			render: () => (
				<>
					<Alert icon={Settings} title={t("projects.title")}>
						{t("projects.description")}
					</Alert>
					<Alert variant="destructive" icon={TriangleAlert} title={t("composite.errorTitle")}>
						{t("composite.serviceError")}
					</Alert>
					<EmptyState
						title={t("projects.empty")}
						description={t("projects.description")}
						action={
							<Button>
								<Text>{t("projects.create")}</Text>
							</Button>
						}
					/>
					<EmptyState
						variant="inset"
						title={t("projects.empty")}
						description={t("projects.description")}
					/>
					<EmptyState icon={<Icon as={Archive} />} title={t("projects.empty")} />
					<EmptyState icon={null} title={t("projects.empty")} />
					<ApiErrorPanel error={new ApiClientError(503)} onRetry={noop} />
					<ApiErrorPanel error={new ApiClientError(401)} onRetry={noop} onReauthenticate={noop} />
					<ApiErrorPanel error={new ApiClientNetworkError("offline")} title={t("agents.title")} />
				</>
			),
		},
		{
			name: "EntityCardChassis / EntityHeader / EntityMeta / EntityCardActions / EntityRow",
			render: () => (
				<>
					{(["resource", "compact"] as const).map((variant) => (
						<EntityCardChassis key={variant} variant={variant}>
							<EntityCardLink variant={variant} to="/dev/ui" ariaLabel={sampleName} />
							<EntityHeader
								icon={icon}
								title={sampleName}
								titleAdornment={
									<Badge>
										<Text>{t("projects.shared")}</Text>
									</Badge>
								}
								meta={[t("projects.owner"), "12 skills"]}
							/>
							<EntityMeta items={["12 skills", "2 vaults", "3 agents"]} wrap />
							<EntityCardActions visibility="always">
								<Button size="icon-sm" variant="ghost">
									<Icon as={MoreHorizontal} />
								</Button>
							</EntityCardActions>
						</EntityCardChassis>
					))}
					<EntityRow
						icon={<EntityIcon kind="framework" id="codex" />}
						title="Research Agent"
						meta={["Codex", "Atlas Research"]}
						status={
							<StatusBadge status="success">
								<Text>{t("sharing.active")}</Text>
							</StatusBadge>
						}
						link={{ to: "/dev/ui" }}
					/>
					<EntityRow
						icon={<EntityIcon kind="channel" id="telegram" />}
						title="Telegram"
						onClick={noop}
						actions={
							<Button variant="outline">
								<Text>{t("inventory.viewDetails")}</Text>
							</Button>
						}
					/>
					<EntityRow
						icon={
							<IconChip>
								<Icon as={KeyRound} />
							</IconChip>
						}
						title="OPENAI_API_KEY"
						disabled
						onClick={noop}
					/>
				</>
			),
		},
		{
			name: "HeroCard / EntityChoiceCard / EntityAddCard",
			render: () => (
				<>
					<HeroCard
						icon={icon}
						title={sampleName}
						badges={
							<Badge variant="secondary">
								<Text>{t("projects.shared")}</Text>
							</Badge>
						}
						description={t("projects.description")}
						footer={["12 skills", "2 vaults"]}
						actions={
							<Button variant="ghost" size="icon-sm">
								<Icon as={MoreHorizontal} />
							</Button>
						}
						link={{ to: "/dev/ui" }}
					/>
					<HeroCard
						title={sampleName}
						onClick={noop}
						footer={["3 agents", "12 skills"]}
						footerWrap
						actionsVisibility="always"
					/>
					{(["card", "compact"] as const).flatMap((variant) =>
						(["stacked", "trailing", "responsive"] as const).map((detailsPlacement) => (
							<EntityChoiceCard
								key={`${variant}/${detailsPlacement}`}
								variant={variant}
								detailsPlacement={detailsPlacement}
								icon={<EntityIcon kind="provider" id="openai" />}
								title="OpenAI"
								description={t("projects.description")}
								selected={filter}
								onClick={() => setFilter(!filter)}
								details={<Text>{detailsPlacement}</Text>}
								badge={
									<Badge variant="secondary">
										<Text>{variant}</Text>
									</Badge>
								}
							/>
						)),
					)}
					<EntityChoiceCard icon={icon} title={sampleName} selected={false} disabled />
					<EntityAddCard
						title={t("projects.create")}
						description={t("projects.description")}
						onClick={noop}
					/>
				</>
			),
		},
		{
			name: "EntityCardSkeleton / HeroCardSkeleton / RouteLoadingSkeleton",
			render: () => (
				<>
					{([0, 1, 2] as const).map((metaLines) => (
						<EntityCardSkeleton
							key={metaLines}
							iconSize={metaLines === 0 ? "sm" : "md"}
							metaLines={metaLines}
							statusDot
							titleBadge
							trailingBadge
							actions
						/>
					))}
					{([0, 1, 2] as const).map((footerItems) => (
						<HeroCardSkeleton
							key={footerItems}
							compact={footerItems === 0}
							footerItems={footerItems}
						/>
					))}
					<RouteLoadingSkeleton />
				</>
			),
		},
		{
			name: "SectionLabel / ListToolbar / FilterChip / Switch / NativeSegments / Checkbox",
			render: () => (
				<>
					<SectionLabel leading={icon} count={12}>
						{t("projects.title")}
					</SectionLabel>
					<ListToolbar
						filters={
							<>
								<FilterChip active={!filter} onClick={() => setFilter(false)}>
									{t("projects.all")}
								</FilterChip>
								<FilterChip active={filter} onClick={() => setFilter(true)}>
									{t("projects.shared")}
								</FilterChip>
							</>
						}
						actions={
							<Button variant="outline">
								<Text>{t("projects.create")}</Text>
							</Button>
						}
					/>
					<ListToolbar
						filters={
							<>
								<Switch checked={checked} onCheckedChange={setChecked} />
								<Switch checked={false} disabled />
								<Switch size="sm" checked={checked} onCheckedChange={setChecked} />
							</>
						}
					/>
					<NativeSegments
						value={choice}
						onChange={setChoice}
						options={[
							{ value: "projects", label: t("projects.title") },
							{ value: "skills", label: t("home.statsSkills") },
						]}
					/>
					<NativeSegments
						value={choice}
						onChange={setChoice}
						disabled
						options={[
							{ value: "projects", label: t("projects.title") },
							{ value: "skills", label: t("home.statsSkills") },
						]}
					/>
					<ListToolbar
						filters={
							<>
								<Checkbox
									checked={checked}
									onCheckedChange={setChecked}
									accessibilityLabel={t("projects.title")}
								/>
								<Checkbox
									checked={false}
									onCheckedChange={noop}
									disabled
									accessibilityLabel={t("home.statsSkills")}
								/>
								<Checkbox
									checked
									onCheckedChange={noop}
									disabled
									accessibilityLabel={t("sharing.vaults")}
								/>
							</>
						}
					/>
				</>
			),
		},
		{
			name: "Select / DropdownMenu",
			render: () => (
				<>
					<Select value={choice} onValueChange={setChoice}>
						<SelectTrigger>
							<SelectValue placeholder={t("projects.choose")} />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectLabel>{t("projects.title")}</SelectLabel>
								<SelectItem value="projects">{t("projects.title")}</SelectItem>
								<SelectItem value="skills">{t("home.statsSkills")}</SelectItem>
								<SelectSeparator />
								<SelectItem value="vaults" disabled>
									{t("sharing.vaults")}
								</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
					<Select disabled>
						<SelectTrigger size="sm">
							<SelectValue placeholder={t("projects.choose")} />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="projects">{t("projects.title")}</SelectItem>
						</SelectContent>
					</Select>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button variant="outline">
									<Icon as={MoreHorizontal} />
									<Text>{t("inventory.viewDetails")}</Text>
								</Button>
							}
						/>
						<DropdownMenuContent>
							<DropdownMenuGroup>
								<DropdownMenuLabel>{sampleName}</DropdownMenuLabel>
								<DropdownMenuItem onClick={noop}>{t("projects.edit")}</DropdownMenuItem>
								<DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
									{t("projects.shared")}
								</DropdownMenuCheckboxItem>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuRadioGroup value={choice} onValueChange={setChoice}>
								<DropdownMenuRadioItem value="projects">
									{t("projects.title")}
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem value="skills">
									{t("home.statsSkills")}
								</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>{t("inventory.viewDetails")}</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									<DropdownMenuItem>{t("projects.sharing")}</DropdownMenuItem>
								</DropdownMenuSubContent>
							</DropdownMenuSub>
							<DropdownMenuItem variant="destructive" onClick={noop}>
								{t("projects.archive")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			),
		},
		{
			name: "ConfirmAction",
			render: () => (
				<>
					<ConfirmAction
						title={t("projects.archive")}
						description={t("projects.archiveWarning")}
						destructive
						onConfirm={async () => {
							await Promise.resolve();
							setConfirmed(true);
						}}
					>
						<Button variant="destructive">
							<Text>{t("projects.archive")}</Text>
						</Button>
					</ConfirmAction>
					<ConfirmAction
						title={t("projects.edit")}
						description={t("projects.description")}
						secondaryAction={{ label: t("inventory.viewDetails"), onAction: noop }}
						onConfirm={() => Promise.reject(new Error("fixture"))}
					>
						<Button variant="outline">
							<Text>{t("projects.edit")}</Text>
						</Button>
					</ConfirmAction>
					{confirmed ? (
						<StatusBadge status="success">
							<Text>{t("composite.confirm")}</Text>
						</StatusBadge>
					) : null}
				</>
			),
		},
		{
			name: "DashboardSection / TruncatedText / TimeTooltip / Markdown",
			render: () => (
				<>
					{(["primary", "secondary", "quiet"] as const).map((priority) => (
						<DashboardSection key={priority} priority={priority}>
							<DashboardSectionHeader
								priority={priority}
								icon={Folder}
								title={t("projects.title")}
								count={12}
								description={t("projects.description")}
								actions={
									<Button variant="outline">
										<Text>{t("projects.create")}</Text>
									</Button>
								}
							/>
							<DashboardSectionToolbar>
								<Text>{t("projects.description")}</Text>
							</DashboardSectionToolbar>
							<DashboardEmptyLine title={t("projects.empty")} message={t("projects.description")} />
						</DashboardSection>
					))}
					<TruncatedText
						title={sampleName}
					>{`${sampleName} / ${sampleName} / ${sampleName}`}</TruncatedText>
					<TimeTooltip value="2026-10-05T12:00:00Z">
						<WebText recipe={cardDescriptionClassName}>
							{relativeTime("2026-10-05T12:00:00Z")}
						</WebText>
					</TimeTooltip>
					<MarkdownBody content={markdown} highlightQuery="project" />
				</>
			),
		},
	];
	return (
		<AppSafeAreaView className="flex-1">
			<FlatList
				data={sections}
				keyExtractor={(item) => item.name}
				contentContainerClassName={CENTERED_PAGE_WIDTH_CLASS.page}
				ListHeaderComponent={<WebText recipe={cardTitleClassName}>UI gallery</WebText>}
				renderItem={({ item }) => <GallerySection name={item.name}>{item.render()}</GallerySection>}
				ItemSeparatorComponent={Separator}
			/>
		</AppSafeAreaView>
	);
}
export default function DevUiRoute() {
	return <Gallery />;
}
