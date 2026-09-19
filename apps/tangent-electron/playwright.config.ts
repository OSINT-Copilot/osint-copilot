import path from 'path'
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
		},
		{
			name: 'Screenshots',
			testMatch: /.*tests-integration.*\.screenshot\.ts/,
			use: {
				workspace: path.resolve(path.join(
					__dirname, '../../test-files/ScreenshotWorkspace/My Workspace'
				)),
				resetWorkspace: 'test'
			}
		}
	],
	workers: 1
})
