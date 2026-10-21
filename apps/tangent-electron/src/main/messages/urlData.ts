import { getLinkPreview } from 'link-preview-js'
import { ipcMain } from 'electron'
import Logger from 'js-logger'
import type { UrlData } from 'common/urlData'
import { getWindowHandle } from 'main/workspaces'
import chalk from 'chalk'
import { isExternalLink } from 'common/links'

const log = Logger.get('url-data')

// Taken from link-preview-js itself: it bundles its own cheerio, whose CheerioAPI type is
// not the same as the one this package installs.
type PreviewOptions = NonNullable<Parameters<typeof getLinkPreview>[1]>
type ResponseHandler = NonNullable<PreviewOptions['onResponse']>

type CacheItem = {
	age: Date,
	data: Promise<UrlData>
}
const previewCache = new Map<string, CacheItem>()

const oneDayInMs = 24 * 60 * 60 * 1000;

function getResponseHandlerURL(url: string): ResponseHandler | undefined {
	if (url.match(/wikipedia.org\/wiki/)) {
		return (response, doc) => {
			const page = response as { description?: string }
			if (!page.description) {
				page.description = doc('#mw-content-text p:not(.mw-empty-elt, table *)').first().text()
			}
			return response
		}
	}

	return undefined
}

function getOrCacheUrlData(url: string): Promise<UrlData> {
	const existing = previewCache.get(url)
	const now = new Date()
	if (existing && (now.getTime() - existing.age.getTime()) < oneDayInMs) {
		return existing.data
	}

	let promise: Promise<UrlData> = null

	if (isExternalLink(url)) {
		log.info('Loading preview for ' + chalk.grey(url))
		promise = getLinkPreview(url, {
			followRedirects: 'follow',
			headers: {
				// Helps with sites blocking automated traffic
				'user-agent': 'googlebot'
			},
			onResponse: getResponseHandlerURL(url)
		}).catch(error => {
			log.warn('Error while fetching data for ' + chalk.gray(url) + ': ' + chalk.red(error))
			previewCache.delete(url)
			return {
				mediaType: 'error',
				message: 'Preview ' + error
			}
		})
	}
	else {
		// TODO: actually determine local file type
		promise = Promise.resolve({
			url,
			mediaType: 'image',
			contentType: 'image/jpeg',
			favicons: [],
			charset: null
		})
	}

	previewCache.set(url, {
		age: now,
		data: promise
	})

	return promise
}


ipcMain.handle('getUrlData', (event, url: string) => {
	const windowHandle = getWindowHandle(event.sender)
	if (!windowHandle || !windowHandle.workspace) return null

	return getOrCacheUrlData(url)
})
