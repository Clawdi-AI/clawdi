// Provide stub values for env vars marked required in `lib/env.ts` so
// `bun test` can import modules that touch the validated `env` without
// hitting a Zod failure. The values are placeholders — tests don't
// actually call the corresponding services.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy_for_unit_tests";
