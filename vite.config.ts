import { defineConfig } from "vite"
// https://github.com/richardtallent/vite-plugin-singlefile
// Bundles JS/CSS into a single HTML file
// import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
	// plugins: [viteSingleFile()],
	// https://stackoverflow.com/a/69746868/4174466
	base: './',
	server: {
		proxy: {
			// Proxy all API routes to backend
			'^/(mode|datasets|colorbar|md|cog|point|chart_point)': {
				target: process.env.VITE_API_URL || 'http://localhost:8000',
				changeOrigin: true
			}
		}
	},
	build: {
		outDir: 'src/bowser/dist/',
		minify: false,
		cssMinify: false,
		rollupOptions: {
			output: {
				// https://github.com/vitejs/vite/issues/378
				entryFileNames: `[name].js`,
				assetFileNames: `[name].[ext]`
			}
		}
	},
})
