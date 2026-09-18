// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { defineConfig } from 'vitest/config';

// Node, not jsdom: the code under test is the service worker's, which has no DOM, and
// Node 22 supplies the WebCrypto, fetch and TextEncoder it uses.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
