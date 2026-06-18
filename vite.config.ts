import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Backend routes that the frontend calls. During `npm run dev` Vite serves
// the frontend, so these paths must be proxied to the FastAPI backend.
// Keep in sync with the @app.{get,post,...} routes in src/bowser/main.py.
const API_ROUTES = [
	'buffer_timeseries', 'catalog', 'chart_point', 'colorbar', 'config',
	'dataset_range', 'datasets', 'histogram', 'mode', 'multi_point',
	'picker', 'point', 'profile', 'trend_analysis', 'upload_mask',
	'variables',
	// tile endpoints, overlays, and the newer routes
	'md', 'cog', 'overlay', 'export', 'upload_raster', 'wms_capabilities',
	'static',
]

const apiProxyPattern = `^/(${API_ROUTES.join('|')})(/|$)`

export default defineConfig({
	plugins: [react()],
	base: './',
	server: {
		proxy: {
			[apiProxyPattern]: {
				target: process.env.VITE_API_URL || 'http://localhost:8000',
				changeOrigin: true,
			},
		},
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
