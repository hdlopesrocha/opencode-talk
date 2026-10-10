import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Project site: https://hdlopesrocha.github.io/opencode-talk/
export default defineConfig({
  plugins: [vue()],
  base: "/opencode-talk/",
});
