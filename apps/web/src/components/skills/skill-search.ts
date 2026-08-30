import { searchExcerpt } from "@/lib/search-highlight";

interface SearchableSkill {
	skill_key: string;
	name: string;
	description?: string | null;
}

export function skillSearchSupportingText(skill: SearchableSkill, query: string): string {
	const phrase = query.trim().toLowerCase();
	if (phrase && skill.skill_key.toLowerCase().includes(phrase)) {
		return `Key: ${skill.skill_key}`;
	}
	const description = skill.description?.trim();
	if (description && phrase && description.toLowerCase().includes(phrase)) {
		return searchExcerpt(description, query, 160);
	}
	return description || `Key: ${skill.skill_key}`;
}
