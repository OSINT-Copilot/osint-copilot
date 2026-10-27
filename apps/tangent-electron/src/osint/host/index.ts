export type * from './types';
/**
 * `host-impl` is resolved per build target:
 *   renderer -> ./impl.tangent.ts         forwards to window.api.osint
 *   vitest   -> main/osint/impl.ts        the Node implementation, in-process parts only
 * Mapped in tsconfig.json paths (which webpack follows) and vitest.config.project.osint.mts.
 */
export { host } from 'host-impl';
