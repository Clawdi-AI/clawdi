export const SYNC_MODULES = ["sessions", "skills", "memories"] as const;
export type SyncModule = (typeof SYNC_MODULES)[number];

export const MEMORY_PROVIDERS = ["mem0", "cognee", "builtin"] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];
