// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { defineConfig } from 'vitest/config';

// Node by default: the service worker's code has no DOM, and Node 22 supplies the
// WebCrypto, fetch and TextEncoder it uses. The content script's tests opt into jsdom
// per file (`// @vitest-environment jsdom`).
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
