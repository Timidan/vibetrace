import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { registryPlugin } from "./vite-registry-plugin";

export default defineConfig({
  plugins: [tailwindcss(), registryPlugin()],
  server: {
    port: 5173
  }
});
