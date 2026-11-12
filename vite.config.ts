/// <reference types="vitest" />
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Backend routes that the frontend calls. During `npm run dev` Vite serves
// the frontend, so these paths must be proxied to the FastAPI backend.
// src/apiProxy.test.js checks this list against the routes in src/bowser.
export const API_ROUTES = [
	'buffer_timeseries', 'catalog', 'chart_point', 'colorbar', 'config',
	'dataset_range', 'datasets', 'histogram', 'mode', 'multi_point',
	'picker', 'point', 'polygon_timeseries', 'profile', 'trend_analysis', 'upload_mask',
	'variables',
	// tile endpoints, overlays, and the newer routes
	'md', 'cog', 'overlay', 'export', 'upload_raster', 'wms_capabilities',
	'static', 'data', 'upload_data', 'files', 'assistant',
	// the cube's zarr files, for the GPU renderer (?render=gpu|auto)
	'zarr',
	// GNSS stations and files, the reference finder, context layers and zones
	'gnss', 'reference_candidates', 'context', 'infrastructure', 'site_context',
	'deformation_zones',
	// the Assistant's page channel and place search
	'page', 'geocode',
]

// A route is followed by a path, a query string or nothing.
const apiProxyPattern = `^/(${API_ROUTES.join('|')})([/?]|$)`

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
	// The GPU renderer's decoder worker loads its decompressors on demand (code-split).
	worker: {
		format: 'es',
		rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js' } },
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
	test: {
		environment: 'jsdom',
		include: ['src/**/*.test.{js,ts,tsx}'],
		setupFiles: ['src/test/setup.ts'],
	},
})
