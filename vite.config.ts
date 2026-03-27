import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
	plugins: [react()],
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
				entryFileNames: `[name].js`,
				assetFileNames: `[name].[ext]`
			}
		}
	},
})
