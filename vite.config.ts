import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: {
    options: { typeAware: true },
    plugins: ["typescript", "unicorn", "oxc", "import"],
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "one-var": ["error", "never"],
      "import/no-duplicates": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-type-assertion": "error",
    },
  },
});
