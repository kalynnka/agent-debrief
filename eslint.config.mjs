// The lint gate. `tsc --noEmit` is still the one that decides whether the code is
// correct; this catches what a type checker has no opinion about.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // The tests are CommonJS scripts run by `node`, not part of the compiled
    // extension, so they are linted as the plain JS they are — `require` is how
    // they are meant to be written, not a leftover.
    files: ["test/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
