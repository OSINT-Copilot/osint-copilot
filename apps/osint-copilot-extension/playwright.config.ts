// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { defineConfig } from '@playwright/test';

// The browser smoke test: the built extension in a real Chromium against the app's real
// server. `npm run e2e` builds dist/ first. One worker: each test launches its own
// browser profile and app harness, and nothing is gained by racing them.
export default defineConfig({
	testDir: 'e2e',
	testMatch: /.*\.spec\.ts/,
	workers: 1,
	timeout: 90_000,
	reporter: 'list',
	outputDir: 'e2e/results',
});
