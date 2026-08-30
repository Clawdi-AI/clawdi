import { searchExcerpt, searchTerms } from "@/lib/search-highlight";

interface SearchableSkill {
	skill_key: string;
	name: string;
	description?: string | null;
}

export function skillSearchSupportingText(skill: SearchableSkill, query: string): string {
	const terms = searchTerms(query).map((term) => term.toLocaleLowerCase());
	const title = skill.name.toLocaleLowerCase();
	const supportingTerms = terms.filter((term) => !title.includes(term));
	const relevantTerms = supportingTerms.length > 0 ? supportingTerms : terms;
	if (relevantTerms.some((term) => skill.skill_key.toLocaleLowerCase().includes(term))) {
		return `Key: ${skill.skill_key}`;
	}
	const description = skill.description?.trim();
	if (description && relevantTerms.some((term) => description.toLocaleLowerCase().includes(term))) {
		return searchExcerpt(description, query, 160);
	}
	return description || `Key: ${skill.skill_key}`;
}
