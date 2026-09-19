import { defineConfig } from '@playwright/test'
import type { TangentOptions } from './tests-integration/tangent'

export default defineConfig<TangentOptions>({
	projects: [
		{
			name: 'Tests',
			testMatch: /.*tests-integration.*\.test\.(ts)/,
		},
		{
			// Builds demo/Operation Northgate: see tests-integration/demo/make-demo.demo.ts.
			name: 'Demo',
			testMatch: /.*tests-integration.*\.demo\.ts/,
		},
		{
			name: 'Benchmarks',
			testMatch: /.*tests-integration.*\.bench\.(ts)/,
		}
	],
	workers: 1
})
