// Windows code signing, and a deliberate no-op while no certificate is configured.
//
// electron-builder calls this for every Windows binary it produces (electron-builder.json,
// `win.signtoolOptions.sign`). Upstream Tangent's build/jsign.js is left untouched beside
// this file: it signs with jsign against a YubiKey, which is Tangent's own hardware token
// and not something this fork can use.
//
// Unconfigured, this returns without signing, so an unsigned build is produced instead of a
// failed one. That is what CI does until the certificate exists. Unsigned installers still
// run; Windows SmartScreen warns about them until the download builds a reputation.
//
// Configured, it signs through AzureSignTool against a certificate in Azure Key Vault:
//
//   AZURE_KEY_VAULT_URL     https://<vault-name>.vault.azure.net
//   AZURE_CERT_NAME         the certificate's name in that vault
//   AZURE_CLIENT_ID         service principal with "sign" on the certificate
//   AZURE_CLIENT_SECRET
//   AZURE_TENANT_ID
//
// Azure Trusted Signing (the subscription service, rather than a certificate you hold) is
// a different mechanism: it signs through signtool with Microsoft's dlib, not AzureSignTool,
// so it needs its own branch here rather than these five variables.

const { execFileSync } = require('child_process')

const REQUIRED = [
	'AZURE_KEY_VAULT_URL',
	'AZURE_CERT_NAME',
	'AZURE_CLIENT_ID',
	'AZURE_CLIENT_SECRET',
	'AZURE_TENANT_ID',
]

exports.default = async function signWindows(config) {
	const missing = REQUIRED.filter(name => !process.env[name])

	if (missing.length === REQUIRED.length) {
		console.warn(`  • not signing ${config.path}: no Windows signing certificate is configured`)
		return
	}

	// Half-configured is a mistake, not a request for an unsigned build.
	if (missing.length > 0) {
		throw new Error(`Windows signing is configured, but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`)
	}

	execFileSync('AzureSignTool', [
		'sign',
		'-kvu', process.env.AZURE_KEY_VAULT_URL,
		'-kvc', process.env.AZURE_CERT_NAME,
		'-kvi', process.env.AZURE_CLIENT_ID,
		'-kvs', process.env.AZURE_CLIENT_SECRET,
		'-kvt', process.env.AZURE_TENANT_ID,
		// electron-builder asks for sha256 on the second pass of a dual-signed binary.
		'-fd', config.hash || 'sha256',
		'-tr', 'http://timestamp.digicert.com',
		'-td', 'sha256',
		config.path,
	], { stdio: 'inherit' })
}
