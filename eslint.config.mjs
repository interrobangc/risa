import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".loops/", "loops/codex-review.fixtures/", "ci/verdict.fixtures/"] },
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
];
