import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { viteSingleFile } from "vite-plugin-singlefile";
import tsconfigPaths from "vite-tsconfig-paths";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// Inject build metadata (date + version) at the top of <head> in the final
// single-file index.html, plus expose the version on window as __ver.
// `enforce: "post"` + `order: "post"` make this run AFTER vite-plugin-singlefile
// inlines all assets, so the markers survive in the produced file.
const buildMetaPlugin = (): Plugin => ({
	name: "inject-build-meta",
	apply: "build",
	enforce: "post",
	transformIndexHtml: {
		order: "post",
		handler(html) {
			const date = new Date().toISOString();
			const inject = `\n\t<!-- Build: ${date} | Version: ${pkg.version} -->\n\t<script>var __ver = ${JSON.stringify(pkg.version)};</script>`;
			return html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
		},
	},
});

// https://vitejs.dev/config/
export default defineConfig({
	base: "./",
	plugins: [react(), viteSingleFile(), tsconfigPaths(), buildMetaPlugin()],
	server: {
		open: true,
		//host: '127.0.0.1', //your ip address
		port: 3001,
	},
});
