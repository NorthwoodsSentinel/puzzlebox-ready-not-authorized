// ESLint flat config. Lint runs with --max-warnings 0 (AGENTS.md "Lint has no warning tier").
// Out of scope: installs, coverage output, and vendor/ (Cliff Hall's PuzzleBox, kept byte-identical to upstream;
// see AGENTS.md "The vendored Puzzle is never edited").
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
  globalIgnores(["**/node_modules/", "coverage/", "vendor/", ".scratch/"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
