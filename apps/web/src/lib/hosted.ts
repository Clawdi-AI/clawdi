/**
 * Build-time flag for the hosted (cloud.clawdi.ai) instance.
 *
 * `process.env.NEXT_PUBLIC_*` is statically replaced by Next.js at
 * build time, so when this resolves to `false` the surrounding
 * `{IS_HOSTED && ...}` JSX gets dead-code-eliminated.
 *
 * **Module discipline for files under `apps/web/src/hosted/`:**
 *
 * Every component in `src/hosted/` MUST be side-effect-free at
 * module top level. The chunk graph still includes hosted modules
 * even when `IS_HOSTED` is false (only the JSX usage is stripped),
 * so a top-level `new ApiClient()` or
 * `process.env.NEXT_PUBLIC_DEPLOY_API_URL!` would throw at OSS
 * import time. Initialize lazily inside hooks / event handlers.
 *
 * Every hosted component MUST also set `data-hosted="true"` on its
 * root element. The CI test in `__tests__/oss-clean-ui.test.ts`
 * fails the build if any `data-hosted="true"` element renders with
 * `IS_HOSTED=false`.
 */
export const IS_HOSTED = process.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true";
