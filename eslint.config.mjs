/**
 * Deliberately NOT a full lint setup — exactly one rule.
 *
 * `react-hooks/rules-of-hooks` is here because a violation of it shipped to
 * production and cost real Sentry volume: `app/root.tsx`'s ErrorBoundary had
 * `useRouteError()` inside a try/catch, and when React probes a component to
 * build an error's component stack (it calls the function outside a render),
 * that hook throws by design — the catch reported it as if the app had broken.
 * Typecheck, build and vitest all pass on that code, so nothing in CI could
 * have caught it.
 *
 * Keeping the rule set at one rule is the point: this gate must never fail for
 * a style opinion, only for the hook-order class of bug. Add rules only if
 * they carry the same "would have caught a production incident" weight.
 */
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["app/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "react-hooks": reactHooks },
    // The codebase carries `eslint-disable` comments for rules this config
    // does not define (leftovers from an editor-side setup). Without this they
    // would each be reported as "rule not found" and the gate would be noise.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: false },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
