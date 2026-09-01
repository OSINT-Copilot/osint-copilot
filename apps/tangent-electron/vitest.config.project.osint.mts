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
			globals: true,
			setupFiles: [path.join(osint, 'tests/setup.ts')],
			include: [
				'src/osint/tests/**/*.test.[jt]s'
			],
			alias: {
				// Tests run against the mock, not the shim, while the mock is progressively
				// inverted into re-exports of the shim. See tests/obsidian-mock.ts.
				'obsidian': path.join(osint, 'tests/obsidian-mock.ts'),
				// Node-side host implementation: tests exercise the real fs/exec code.
				'host-impl': path.join(__dirname, 'src/main/osint/impl.ts'),
				'../main': path.join(osint, 'main.ts'),
			},
		},
	})
)
