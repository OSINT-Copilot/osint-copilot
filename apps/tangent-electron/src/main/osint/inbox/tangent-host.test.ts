import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { tangentInboxHost, type WindowContents, type WindowLike } from './tangent-host'

/**
 * Which windows hear that an inbox changed. Matched by realpath, so a window on a sibling
 * that shares a prefix hears nothing, and one that opened the workspace through a symlink
 * hears it all the same.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-host-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function contents(destroyed = false) {
	return { isDestroyed: () => destroyed, send: vi.fn<(channel: string) => void>() }
}

describe('tangentInboxHost.notify', () => {
	it('tells only the live windows whose workspace really is the root', () => {
		const a = path.join(dir, 'cases', 'a')
		const ab = path.join(dir, 'cases', 'ab')
		fs.mkdirSync(a, { recursive: true })
		fs.mkdirSync(ab, { recursive: true })
		const link = path.join(dir, 'link-to-a')
		fs.symlinkSync(a, link, 'dir')

		const onA = contents()
		const onLink = contents()
		const onLoaded = contents()
		const onSibling = contents()
		const closed = contents(true)
		const empty = contents()
		const contentsMap = new Map<WindowContents, WindowLike>([
			[onA, { assignedWorkspacePath: a }],
			[onLink, { assignedWorkspacePath: link }],
			[onLoaded, { workspace: { rootPath: a } }],
			[onSibling, { assignedWorkspacePath: ab }],
			[closed, { assignedWorkspacePath: a }],
			[empty, {}],
		])
		const host = tangentInboxHost({ workspaceMap: new Map([[a, {}], [ab, {}]]), contentsMap, documentationPath: () => null })

		host.notify(a, 'osint:inbox.changed')

		expect(onA.send).toHaveBeenCalledWith('osint:inbox.changed')
		expect(onLink.send).toHaveBeenCalledWith('osint:inbox.changed')
		expect(onLoaded.send).toHaveBeenCalledWith('osint:inbox.changed')
		// Once per window, even when both of its paths match.
		expect(onA.send).toHaveBeenCalledTimes(1)
		expect(onSibling.send).not.toHaveBeenCalled()
		expect(closed.send).not.toHaveBeenCalled()
		expect(empty.send).not.toHaveBeenCalled()
		expect(host.knownRoots()).toEqual([a, ab])
	})
})
