import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: {
    options: { typeAware: true },
    rules: {
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "one-var": ["error", "never"],
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-type-assertion": "error",
    },
  },
});
