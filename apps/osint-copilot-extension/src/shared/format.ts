// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/** Bytes as megabytes, for the panel's text: one decimal under 10 MB, whole above. */
export function mb(bytes: number): string {
	const n = bytes / (1024 * 1024);
	return n < 0.1 ? '<0.1' : n < 10 ? n.toFixed(1) : String(Math.round(n));
}
