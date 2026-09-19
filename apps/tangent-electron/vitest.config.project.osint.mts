import path from 'path'
import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.mjs'

const osint = path.join(__dirname, 'src/osint')

export default mergeConfig(
	sharedConfig,
	defineProject({
		test: {
			name: 'osint',
			environment: 'jsdom',
			setupFiles: [path.join(osint, 'tests/setup.ts')],
			include: [
				'src/osint/tests/**/*.test.[jt]s'
			],
			alias: {
				// Tests run against the mock, not the shim. See tests/obsidian-mock.ts.
				'obsidian': path.join(osint, 'tests/obsidian-mock.ts'),
				// Node-side host implementation (platform, cli, extract): tests exercise the
				// real exec and extraction code.
				'host-impl': path.join(__dirname, 'src/main/osint/impl.ts'),
			},
		},
	})
)
