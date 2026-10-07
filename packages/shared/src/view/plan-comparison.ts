import type { DeployComponents } from "../api";
import { computePricePresentation } from "./compute-price";
import {
	commonExplicitBillingOffers,
	explicitPlanOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
} from "./compute-subscriptions";

type Plan = DeployComponents["schemas"]["V2PlanResponse"];
/** Web's comparable plans and shared billing term, independent of fetching or purchase actions. */
export function computePlanComparisonView(
	plans: Plan[],
	term: number,
	formatAmount?: (cents: number) => string,
) {
	const basic = resolveBasicPlan(plans),
		performance = resolvePerformancePlan(plans);
	const basicOffers = basic ? explicitPlanOffers(basic) : [];
	const performanceOffers = performance ? explicitPlanOffers(performance) : [];
	const commonOffers =
		basic && performance ? commonExplicitBillingOffers([basic, performance]) : [];
	const selectedTerm =
		commonOffers.find((offer) => offer.billing_term_months === term)?.billing_term_months ??
		commonOffers[0]?.billing_term_months ??
		null;
	const basicOffer =
		selectedTerm === null
			? null
			: (basicOffers.find((offer) => offer.billing_term_months === selectedTerm) ?? null);
	const performanceOffer =
		selectedTerm === null
			? null
			: (performanceOffers.find((offer) => offer.billing_term_months === selectedTerm) ?? null);
	return {
		basic,
		performance,
		basicOffers,
		performanceOffers,
		commonOffers,
		selectedTerm,
		basicOffer,
		performanceOffer,
		basicPrice: basicOffer ? computePricePresentation(basicOffer, basicOffers, formatAmount) : null,
		performancePrice: performanceOffer
			? computePricePresentation(performanceOffer, performanceOffers, formatAmount)
			: null,
		sharedPricingUnavailable: basic !== undefined && performance !== undefined && !selectedTerm,
	};
}
