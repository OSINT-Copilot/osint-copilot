// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: ['vitest.config.project.*'],
	},
});
