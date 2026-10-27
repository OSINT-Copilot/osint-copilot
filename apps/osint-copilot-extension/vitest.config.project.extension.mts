// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { defineProject } from 'vitest/config';

// A project, so the repository's root `npx vitest run` (what CI runs) picks these tests
// up with the app's; vitest.config.mts runs just this one from here (`npm test`).
//
// Node by default: the service worker's code has no DOM, and Node 22 supplies the
// WebCrypto, fetch and TextEncoder it uses. The content script's tests opt into jsdom
// per file (`// @vitest-environment jsdom`).
export default defineProject({
	test: {
		name: 'osint-copilot-extension',
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
