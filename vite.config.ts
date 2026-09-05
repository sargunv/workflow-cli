import { defineConfig } from "vite-plus";
export default defineConfig({
  lint: {
    options: { typeAware: true },
    rules: {
      "typescript/no-explicit-any": "error",
      "typescript/no-unsafe-type-assertion": "error",
    },
  },
});
