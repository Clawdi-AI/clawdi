import type { DeployComponents } from "@clawdi/shared/api";
import {
	billingTermLabel,
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	computeTierLabel,
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
	subscriptionCreateCopy,
} from "@clawdi/shared/view";
import { ChoiceSelect } from "@/components/dashboard/controls";
import { Label } from "@/components/ui/input";
import { AppView } from "@/components/ui/view";
import { NativeSegments } from "@/platform/navigation/segmented-control";

type Plan = DeployComponents["schemas"]["V2PlanResponse"];
type BillingOffer = DeployComponents["schemas"]["V2BillingOfferResponse"];
export type ComputePlanSlug = typeof COMPUTE_BASIC_SLUG | typeof COMPUTE_PERFORMANCE_SLUG;
export type FundingSource = "stripe" | "wallet";

export function planForSlug(plans: Plan[] | undefined, planSlug: ComputePlanSlug) {
	return planSlug === COMPUTE_PERFORMANCE_SLUG
		? resolvePerformancePlan(plans)
		: resolveBasicPlan(plans);
}

/** Web lists Basic's explicit offers only and Performance's derived ones too. */
export function offersForPlan(plan: Plan | undefined, planSlug: ComputePlanSlug): BillingOffer[] {
	if (!plan) return [];
	return planSlug === COMPUTE_BASIC_SLUG ? explicitPlanOffers(plan) : planOffers(plan);
}

/** Web's Compute plan Select. */
export function PlanField({
	label,
	value,
	plans,
	onChange,
	disabled,
	requirePlan = false,
}: {
	label: string;
	value: ComputePlanSlug;
	plans: Plan[] | undefined;
	onChange: (planSlug: ComputePlanSlug) => void;
	disabled?: boolean;
	/** Only offer plans the catalog lists, like Web's create dialog. */
	requirePlan?: boolean;
}) {
	const options = ([COMPUTE_BASIC_SLUG, COMPUTE_PERFORMANCE_SLUG] as const)
		.filter((slug) => !requirePlan || planForSlug(plans, slug))
		.map((slug) => ({ value: slug, label: computeTierLabel(slug) }));
	return (
		<AppView className="gap-1.5">
			<Label>{label}</Label>
			<ChoiceSelect
				value={value}
				options={options}
				onValueChange={onChange}
				disabled={disabled}
				className="w-full"
			/>
		</AppView>
	);
}

/** Web's TermSwitcher: one segment per offer, hidden for a single term. */
export function TermField({
	label,
	offers,
	value,
	onChange,
	disabled,
}: {
	label: string;
	offers: readonly BillingOffer[];
	value: number;
	onChange: (months: number) => void;
	disabled?: boolean;
}) {
	if (offers.length <= 1) return null;
	const sorted = [...offers].sort((a, b) => a.billing_term_months - b.billing_term_months);
	return (
		<AppView className="gap-1.5">
			<Label>{label}</Label>
			<NativeSegments
				value={String(value)}
				disabled={disabled}
				options={sorted.map((offer) => ({
					value: String(offer.billing_term_months),
					label:
						offer.discount_percent > 0
							? `${billingTermLabel(offer.billing_term_months)} −${offer.discount_percent}%`
							: billingTermLabel(offer.billing_term_months),
				}))}
				onChange={(next) => {
					const offer = sorted.find((item) => String(item.billing_term_months) === next);
					if (offer) onChange(offer.billing_term_months);
				}}
			/>
		</AppView>
	);
}

/** Web's Card | Wallet toggle, limited to the funding this build offers; one source hides it. */
export function FundingField({
	label,
	sources,
	value,
	onChange,
	disabled,
}: {
	label: string;
	sources: readonly FundingSource[];
	value: FundingSource;
	onChange: (fundingSource: FundingSource) => void;
	disabled?: boolean;
}) {
	if (sources.length <= 1) return null;
	return (
		<AppView className="gap-1.5">
			<Label>{label}</Label>
			<NativeSegments
				value={value}
				disabled={disabled}
				options={sources.map((source) => ({
					value: source,
					label: source === "wallet" ? subscriptionCreateCopy.wallet : subscriptionCreateCopy.card,
				}))}
				onChange={(next) => {
					if (next === "stripe" || next === "wallet") onChange(next);
				}}
			/>
		</AppView>
	);
}
