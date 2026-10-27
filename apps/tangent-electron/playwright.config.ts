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
	workers: 1,
	// On CI only, and two at most: these drive a real window, and upstream's Note Linking
	// races its own autocomplete there (it has carried a "Slush for CI" wait for years).
	// A retried test is reported as flaky, not as passed, so this hides nothing. Locally
	// a failure stays a failure, where it can be looked at.
	retries: process.env.CI ? 2 : 0
})
