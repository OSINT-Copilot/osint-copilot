/**
 * The app's side of the extension channel, running under plain node: the real server,
 * pairing and inbox writer over a throwaway workspace, with the pairing confirm answered
 * yes and the licence granted.
 *
 * For tests that drive the extension's own code against the app, in vitest
 * (extension-interop.test.ts) and in a real browser (the extension package's
 * e2e/smoke.spec.ts). No electron import and no Tangent registry: the workspace is
 * registered in maps of our own through tangentInboxHost, which is the adapter index.ts
 * uses for Tangent's real maps.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import { ExtensionController } from '../extension/controller';
import { INBOX_FOLDER, PENDING } from './inbox-writer';
import { verifySealedManifest } from './manifest-mac';
import { tangentInboxHost, type WindowContents, type WindowLike } from './tangent-host';

export interface HarnessOptions {
    /** The investigation folder's name, which is what /v1/workspaces reports. */
    workspaceName?: string;
    /** Where the server binds; [0] (any free port) unless given. */
    ports?: number[];
}

export interface StoredBundle {
    bundleId: string;
    /** The stored manifest: the cleaned manifest, the server stamp and the mac. */
    stored: Record<string, unknown>;
    /** Whether the mac verifies under the app's manifestKey. */
    macOk: boolean;
}

export interface ExtensionHarness {
    controller: ExtensionController;
    port: number;
    /** Realpath of the temp workspace. */
    workspace: string;
    /** Every Origin the app asked the user to confirm, in order. */
    confirmed: string[];
    /** A fresh one-time pairing string, as the settings page would show it. */
    pairingString(): Promise<string>;
    /** Every bundle in the workspace's .osint-inbox/pending, with its mac checked. */
    pending(): Promise<StoredBundle[]>;
    stop(): Promise<void>;
}

export async function startExtensionHarness(options: HarnessOptions = {}): Promise<ExtensionHarness> {
    const dir = fs.realpathSync(await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'osint-ext-harness-')));
    const workspace = nodePath.join(dir, options.workspaceName ?? 'Case Alpha');
    await fsp.mkdir(workspace);

    // One window with the case open, so it lists as open and receives the change notice.
    const window: WindowContents = { isDestroyed: () => false, send: () => {} };
    const workspaceMap = new Map<string, unknown>([[workspace, null]]);
    const contentsMap = new Map<WindowContents, WindowLike>([[window, { assignedWorkspacePath: workspace }]]);
    const confirmed: string[] = [];

    const controller = await ExtensionController.open({
        userDataDir: nodePath.join(dir, 'userData'),
        encryptor: null,
        confirm: async ({ origin }) => {
            confirmed.push(origin);
            return true;
        },
        licensed: async () => true,
        host: tangentInboxHost({ workspaceMap, contentsMap, documentationPath: () => null }),
        appVersion: '0.0.0-harness',
        ports: options.ports ?? [0],
    });
    await controller.setEnabled(true);
    const port = controller.server.port;
    if (port === null) {
        await controller.stop();
        throw new Error(`extension server did not start: ${(await controller.status()).problem ?? 'unknown'}`);
    }

    return {
        controller,
        port,
        workspace,
        confirmed,
        pairingString: async () => (await controller.pairBegin()).pairingString,
        async pending() {
            const root = nodePath.join(workspace, INBOX_FOLDER, PENDING);
            let names: string[];
            try {
                names = await fsp.readdir(root);
            } catch {
                return [];
            }
            const key = controller.secrets.manifestKey();
            const out: StoredBundle[] = [];
            for (const bundleId of names.sort()) {
                const stored = JSON.parse(await fsp.readFile(nodePath.join(root, bundleId, 'manifest.json'), 'utf8'));
                out.push({ bundleId, stored, macOk: verifySealedManifest(key, stored) });
            }
            return out;
        },
        async stop() {
            await controller.stop();
            await fsp.rm(dir, { recursive: true, force: true });
        },
    };
}
