# OSINT Copilot extension protocol, version 1

This is the contract between the OSINT Copilot browser extension and the desktop app. It is normative: the app's implementation lives beside this file (`protocol.ts`, `signing.ts`, `validate.ts`, `pairing.ts`, `server.ts`), and the extension is built against this text. Two files of shared test vectors pin every construction:

- `vectors/protocol-vectors.json`: the strings each side signs and the MACs expected for them, including a file upload whose body is raw bytes (`octetRequests`, body given as `bodyHex`). A separate Python implementation of this document (`vectors/generate-protocol-vectors.py`) produced them, not the app.
- `vectors/entity-vectors.json`: manifest and entity inputs, each with the expected accept or reject. Where a vector gives the cleaned result (`value`, `url`, `text`, `bundleId`) or, for a manifest reject, the exact `detail`, both implementations must produce it.

Both implementations must reproduce every vector exactly. If you change anything in this document, bump `PROTO` and regenerate the vectors.

## 1. Threat model in one paragraph

Any process on the machine can connect to 127.0.0.1. Web pages can reach it too, subject to Chrome's Local Network Access rules and to DNS rebinding. Since Chrome 149, any extension with host access to 127.0.0.1 can set an arbitrary `Origin` header. So `Host` and `Origin` checks are cheap filters, and **authentication is an HMAC under a key that only a paired extension holds**. Responses are signed as well, so the extension can tell the app apart from a process that grabbed the port first. Every request, every response and the hello proof name the endpoint the extension dialled (§3), so a process squatting one port cannot relay to the app on another: what the extension signed for the squatter's port fails at the app, and what the app signs for its own port fails at the extension.

## 2. Transport

- Base URL: `http://127.0.0.1:<port>/v1`.
- The app binds `127.0.0.1` only, never `0.0.0.0`, `::` or `localhost`.
- The app binds the first free port from 23760, 23761, 23762, 23763 and 23764. It tries the port it bound last time first, and persists the port it binds. The pairing string carries the port, so the extension learns it at pairing time. If the app later moves to another port, the extension may probe the other four with `POST /v1/hello`. Each probe's proof is bound to the port probed (§7.2), so only the port the app itself holds can verify.
- The extension sends requests as service-worker `fetch` calls with `credentials: 'omit'`.
- Every error response carries `Connection: close`.

## 3. Encodings

| Thing | Encoding |
|---|---|
| Nonces, ids, secrets, keys on the wire, MACs | base64url **without padding** (RFC 4648 §5). Decoders must reject padding, `+`, `/` and non-canonical trailing bits. |
| 16 random bytes | exactly 22 base64url characters |
| 32 random bytes | exactly 43 base64url characters |
| SHA-256 digests | 64 **lowercase** hex characters |
| Timestamps (`X-OC-Ts`) | unix time in milliseconds as a decimal string, for example `1760000000000` |
| Strings that are signed | UTF-8 bytes. Lines are joined with a single `\n` (0x0A), with no trailing newline. |
| HMAC | HMAC-SHA256. The key is always **raw bytes**: the 32 decoded bytes of `pairSecret`, of `K`, or of `workspaceIdKey`. |
| `endpoint` (in signed strings) | `127.0.0.1:` followed by the decimal port the request was sent to, for example `127.0.0.1:23760`. The extension uses the port it dialled. The app uses the port it is bound to, **never** the `Host` header (which it accepts as `localhost:<port>` too). |

Within a string to sign, nonces, ids and digests appear as the text that travels on the wire (base64url or hex), not as decoded bytes.

## 4. Checks on every request, in order

The server applies these checks before any routing:

1. **Host.** `Host` must equal exactly `127.0.0.1:<port>` or `localhost:<port>`, where `<port>` is the bound port. The comparison is case-sensitive. Otherwise the reply is `421 {"error":"bad_host"}`.
2. **OPTIONS.** An `OPTIONS` request gets `403 {"error":"forbidden"}`. **No response ever carries an `Access-Control-*` header.** A CORS preflight therefore always fails, and a web page cannot read any response.
3. *(Overall rate limit: 60 requests a second across all callers, otherwise `429 {"error":"rate_limited"}`.)*
4. **Protocol.** `X-OC-Proto` must be exactly `1`. Otherwise the reply is `400 {"error":"bad_proto"}`.
5. **Content type.** A `POST` to a path under `/v1/bundles/<anything>/files/` must have `Content-Type: application/octet-stream`; every other `POST` must have `Content-Type: application/json`. Parameters such as `; charset=utf-8` are allowed. Otherwise the reply is `400 {"error":"bad_content_type"}`. Neither type is CORS-safelisted, so a web page cannot send either without a preflight, and the preflight fails at step 2.
6. **Origin.** A `POST` must carry an `Origin` matching `^chrome-extension://[a-p]{32}$`. Otherwise the reply is `403 {"error":"bad_origin"}`. Once the client is known (§6, and §7.2 for hello), the Origin must also equal exactly the one recorded at pairing, or the reply is again `403 bad_origin`. A `GET` needs no Origin, because Chrome omits it. Origin is defence in depth, **not** authentication.

## 5. Pairing: `POST /v1/pair`

### 5.1 The pairing string

The app shows the following, for the user to paste into the extension:

```
ocpair1.<port>.<instanceId>.<pairSecret>
```

- `port`: decimal.
- `instanceId`: 16 random bytes, base64url. It is stable for the life of the app install.
- `pairSecret`: 32 random bytes, base64url.

The string is valid for **one use** and **5 minutes** after it is shown. Beginning a new pairing cancels the previous one, and so does cancelling in the app.

Vector: `pairingString`.

### 5.2 Request

The request carries the headers from §4, including an extension `Origin`, and has a body of at most 4 KB:

```json
{"pairingId": "...", "clientNonce": "...", "extVersion": "1.0.0", "proof": "..."}
```

| Field | Value |
|---|---|
| `pairingId` | the first 32 hex characters of `sha256(pairSecret raw bytes)` |
| `clientNonce` | 16 random bytes, base64url |
| `extVersion` | 1-32 characters from `[0-9A-Za-z.+-]` |
| `proof` | `b64url(HMAC(pairSecret, "OCPAIR1\n" + clientNonce))` |

Vectors: `pairingId`, `pairProof`.

### 5.3 Server behaviour

In order:

1. If no pairing is active (none begun, cancelled, used, or expired), the reply is `403 {"error":"pair_expired"}`. Nothing is read or computed.
2. Rate limit: 10 a minute, otherwise `429 {"error":"rate_limited"}`.
3. If `pairingId` does not match the active pairing, the reply is `403 pair_expired`.
4. If `clientNonce` or `extVersion` is malformed, the reply is `422 {"error":"invalid","detail":...}`.
5. If the proof is wrong, the reply is `401 {"error":"bad_signature"}`. The pairing stays active.
6. The pairing is now **consumed**, whatever happens next. The app shows a native confirm dialog that names the requesting Origin and `extVersion`.
   - If the user declines, the reply is `403 {"error":"pair_denied"}`.
   - If the pairing was cancelled while the dialog was open, the reply is `403 pair_expired`.
7. The app generates `clientId` (16 random bytes, base64url) and `serverNonce` (16 random bytes, base64url), then derives:

   ```
   K = HMAC(pairSecret, "oc-k1\n" + clientNonce + "\n" + serverNonce + "\n" + clientId)     (32 raw bytes)
   ```

   It stores `K` in its main-only secret store. Pairing the same Origin again **replaces** that Origin's previous client, whose `K` stops working.
8. The reply is `200`:

   ```json
   {"clientId": "...", "serverNonce": "...", "instanceId": "...", "serverProof": "..."}
   ```

   Here `serverProof = b64url(HMAC(pairSecret, "OCPAIR1S\n" + clientNonce + "\n" + serverNonce + "\n" + clientId))`.

The extension must verify `serverProof` and check that `instanceId` equals the one in the pairing string. It then derives `K` the same way, stores `clientId`, `K`, `instanceId` and the port, and **discards `pairSecret`**. The `/v1/pair` response is not signed with `X-OC-Sig`; `serverProof` authenticates it.

Vectors: `keyDerivation`, `pairServerProof`.

## 6. Signed requests

Every endpoint except `/v1/pair` and `/v1/hello` is signed.

### 6.1 Headers

| Header | Value |
|---|---|
| `X-OC-Proto` | `1` |
| `X-OC-Client` | `clientId` |
| `X-OC-Ts` | now, in unix ms |
| `X-OC-Nonce` | 16 fresh random bytes, base64url. Never reuse one. |
| `X-OC-Body-Sha256` | hex SHA-256 of the exact body bytes. With no body, this is the SHA-256 of the empty string: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |
| `X-OC-Sig` | see below |
| `Content-Type` | `application/json` (POST), or `application/octet-stream` for a file upload (§7.5). It is not part of the string to sign. |
| `Content-Length` | the body's length in **bytes** (POST) |

### 6.2 String to sign

```
"OC1\n" + endpoint + "\n" + METHOD + "\n" + pathWithQuery + "\n" + ts + "\n" + nonce + "\n" + clientId + "\n" + contentLength + "\n" + bodySha256Hex
```

- `endpoint` is as in §3: `127.0.0.1:<port>` for the port the request is sent to.
- `METHOD` is upper case: `GET` or `POST`.
- `pathWithQuery` is the request-target exactly as it goes on the wire, for example `/v1/status`. Use only paths and queries that `fetch` sends unchanged: no characters that it would percent-encode.
- `contentLength` is the decimal `Content-Length` header value, or `0` when the header is absent.
- `X-OC-Sig = b64url(HMAC(K, stringToSign))`

Send bodies with a `Content-Length`: a string or `Uint8Array` body to `fetch` does this. A chunked body has no `Content-Length`, is therefore signed as `0`, and is rejected (`413`) as soon as it carries a byte. A `GET` has no body.

Vectors: `requests` (a POST with multi-byte UTF-8, and a GET) and `octetRequests` (a file upload whose body is bytes that are not UTF-8; signed exactly the same way).

### 6.3 Server verification order

The signature is verified **before any body byte is read**, using the declared `Content-Length` and `X-OC-Body-Sha256`.

| # | Condition | Reply |
|---|---|---|
| 1 | `X-OC-Client` or `X-OC-Nonce` missing or malformed, or `clientId` unknown or revoked | `401 unauthenticated` (unsigned) |
| 2 | POST whose `Origin` differs from the one recorded at pairing | `403 bad_origin` (unsigned) |
| 3 | Other signing headers missing or malformed | `401 unauthenticated` (unsigned) |
| 4 | MAC mismatch (compared in constant time), including a request signed for another port | `401 bad_signature` (unsigned) |
| | *From here on, every reply is signed (§6.4).* | |
| 5 | `abs(now - ts) > 60 000 ms` | `401 clock_skew` |
| 6 | Nonce already seen for this client in the last 120 s | `401 replay` |
| 7 | Declared length over the cap: 256 KB for a JSON POST, 0 for GET, and for a file upload the cap for that file name (§8.3) | `413 too_large`, with nothing read |
| 8 | The body is read up to the declared length. More bytes than declared means an overrun: what was read is discarded. | `413 too_large` |
| 9 | SHA-256 of the body differs from `X-OC-Body-Sha256` | `422 hash_mismatch` |

Only after all of these does routing run: `404 not_found` for an unknown path, and `405 method_not_allowed` for a known path with the wrong method.

A file upload (§7.5) is the one exception to reading the whole body before routing: after step 7 its remaining checks are made from the headers, and only then is the body streamed to disk, hashed as it arrives (steps 8 and 9 happen during the stream). The signature is still verified before any body byte is read.

### 6.4 Response signatures

Every response after step 4 of §6.3 (the request's MAC has verified) carries a signature. That includes errors:

```
X-OC-Sig = b64url(HMAC(K, "OC1R\n" + endpoint + "\n" + statusCode + "\n" + requestNonce + "\n" + sha256Hex(responseBodyBytes)))
```

`endpoint` is as in §3. `statusCode` is decimal, for example `200` or `401`. `requestNonce` is the `X-OC-Nonce` the extension sent. **The extension must ignore any response to a signed request whose signature is missing or fails**, and treat it as a network error. Replies from steps 1-4 are deliberately unsigned: the app signs nothing for a caller that has not proved it holds `K`, because anyone who knows a `clientId` could otherwise obtain an authentic terminal error for a nonce of their choosing.

Vector: `responses`.

## 7. Endpoints

### 7.1 `GET /v1/status` (signed)

```json
{"licensed": true, "receiving": true, "pendingCount": 0}
```

### 7.2 `POST /v1/hello` (not signed with headers)

The extension calls this before sending any page data: after pairing, at service-worker start-up, and whenever it is unsure which process holds the port.

The request carries the headers from §4, including the paired Origin, and has a body of at most 4 KB: `{"clientId": "...", "clientNonce": "..."}` where `clientNonce` is 16 fresh random bytes, base64url.

| Condition | Reply |
|---|---|
| Unknown `clientId` | `401 unauthenticated` |
| Origin is not the one recorded | `403 bad_origin` |
| More than 10 a minute for this `clientId` | `429 rate_limited` |
| Malformed `clientNonce` | `422 invalid` |

Otherwise the reply is `200`:

```json
{"instanceId": "...", "serverNonce": "...", "serverProof": "...", "proto": {"min": 1, "max": 1}, "appVersion": "0.13.1"}
```

Here `serverProof = b64url(HMAC(K, "OCHELLO1\n" + endpoint + "\n" + clientNonce + "\n" + serverNonce + "\n" + instanceId))`, with `endpoint` as in §3. The extension verifies it against the port it sent the hello to, and checks `instanceId` against the stored one, before trusting the port. A proof relayed from the app's real port names that port and fails. The server records the client's `lastSeenAt`.

Vector: `helloProof`.

### 7.3 `GET /v1/workspaces` (signed)

```json
{"workspaces": [{"id": "...", "name": "Case A", "open": true}]}
```

- `id = b64url(HMAC(workspaceIdKey, realpath)).slice(0, 22)`. `workspaceIdKey` is a random 32-byte key that never leaves the app, so ids are stable but reveal nothing about paths.
- `name` is the folder's basename.
- `open` says whether any window has the workspace open.

The documentation workspace is never listed. **No endpoint accepts a filesystem path.**

Vector: `workspaceId`.

### 7.4 `POST /v1/bundles` (signed)

The body is a manifest (§8) of at most 256 KB. The kinds `note` and `entity` commit within this one request. A `capture` is created here and completed by §7.5 and §7.6.

| Result | Reply |
|---|---|
| Stored | `200 {"status":"accepted","bundleId":"...","receivedAt":"<ISO 8601>"}` |
| A capture, staged and waiting for its files | `200 {"status":"created","bundleId":"...","missing":["page.mhtml", ...]}`. `missing` lists the declared files not yet received, in the order `page.mhtml`, `viewport.png`, `page.pdf`. |
| This `bundleId` was already received; nothing new is stored | `200 {"status":"duplicate","bundleId":"...","receivedAt":"<ISO 8601 of the first>"}` |
| Malformed JSON | `400 bad_json` |
| Fails validation | `422 {"error":"invalid","detail":"<field path>: <reason>"}` |
| Any other kind | `422 {"error":"invalid","detail":"kind not supported by this app version"}` |
| A capture `bundleId` that is staged with other files, another page, or by another client | `422 {"error":"invalid","detail":"bundleId: already used for a different capture"}` |
| Unknown `workspaceId` | `404 unknown_workspace` |
| Unlicensed | `403 unlicensed` |
| The workspace's inbox budget is full. For a capture, the sum of the declared file sizes is **reserved** at this point and counts against the budget until the capture is committed or its staging is swept, so the reply comes before any file is sent. | `507 budget_exceeded` |
| More than 20 a minute for this client | `429 rate_limited` |

`bundleId` is the idempotency key. Retrying a bundle, for example after a network error or an unverifiable response, must reuse its `bundleId`.

Sending a capture's manifest again while it is still staged (for example after the extension or the app restarted mid-upload) is how the extension resumes: the reply is `created` again, with the files still `missing`. Once the capture is committed, the reply is `duplicate`.

### 7.5 `POST /v1/bundles/<bundleId>/files/<name>` (signed, octet-stream)

Sends one declared file of a staged capture. `<bundleId>` is the lowercase UUID from the manifest and `<name>` is `page.mhtml`, `viewport.png` or `page.pdf`. The body is the file's bytes, `Content-Type: application/octet-stream`, and the request is signed exactly as in §6: `Content-Length` and `X-OC-Body-Sha256` are the file's size and hex SHA-256, and the signature covers them.

The app refuses from the headers alone, reading nothing, in this order: a `<name>` that is not one of the three (`422 invalid`); a length over that name's cap (`413 too_large`); no staged capture with this id from this client (`404 unknown_bundle`; one already committed is `409 conflict`); a `<name>` the manifest did not declare (`422 invalid`); a `Content-Length` other than the declared `size`, or an `X-OC-Body-Sha256` other than the declared `sha256` (`422 invalid`).

It then streams the body to `<name>.part` (created exclusively), hashing as it goes, and renames it to `<name>` only if all of these hold. Otherwise the partial file is deleted.

| Result | Reply |
|---|---|
| Stored | `200 {"received":true}` |
| This file was already received (the same declared size and digest) | `200 {"received":true}`, without reading the body again |
| More bytes than declared | `413 too_large` |
| The bytes hash to something else | `422 hash_mismatch` |
| The content is not what the name says: `page.mhtml` must begin with MIME headers whose `Content-Type` is `multipart/related` with a `boundary`; `viewport.png` must begin with the PNG signature; `page.pdf` with `%PDF-` | `422 invalid` |
| The same file is being received on another connection | `409 conflict` |
| Unlicensed | `403 unlicensed` |

A body that sends no bytes for 30 seconds is abandoned: the app closes the connection without a reply and deletes the partial file, and the name is free again at once. The extension sends the file again as a new request.

### 7.6 `POST /v1/bundles/<bundleId>/commit` (signed)

The body is JSON `{}`. The app hashes every declared file again (a file changed on disk since it was received is deleted and counts as missing), writes the stored manifest last, and moves the capture from staging to `pending/` in one step.

| Result | Reply |
|---|---|
| Committed | `200 {"status":"accepted","bundleId":"...","receivedAt":"<ISO 8601 of the create>"}` |
| Already committed | `200 {"status":"duplicate","bundleId":"...","receivedAt":"..."}` |
| A declared file is missing | `409 {"error":"incomplete","detail":["viewport.png", ...]}` |
| A file is still being received | `409 conflict` |
| No staged capture with this id from this client | `404 unknown_bundle` |
| Unlicensed | `403 unlicensed` |

File uploads and commits share a limit of 120 a minute per client, apart from the 20 a minute for `/v1/bundles`.

## 8. Manifest v1

```json
{
  "v": 1,
  "bundleId": "<UUID v4>",
  "workspaceId": "<id from /v1/workspaces>",
  "kind": "note" | "entity" | "capture",
  "page": {"url": "https://...", "title": "..."},
  "clientTime": "<ISO 8601 date-time, advisory only>",
  "note": {"text": "..."},
  "entity": {"kind": "...", "value": "...", "chain": "...", "platform": "...", "context": "..."},
  "capture": {"files": {"page.mhtml": {"size": 123, "sha256": "..."}, "viewport.png": {...}, "page.pdf": {...}}}
}
```

- `note` is present exactly when `kind` is `note`, `entity` exactly when it is `entity`, and `capture` exactly when it is `capture`.
- Unknown fields are rejected at every level.
- Later versions add the kinds `highlight`, `highlight.update` and `highlight.delete`. This app version rejects them with the detail shown in §7.4.

### 8.1 Cleaning and limits

**Reject rather than truncate.** Every violation is `422 invalid`, and `detail` names the field path, for example `page.url: longer than 2048 characters`.

- Every single-line string has the following removed: C0 controls (U+0000 to U+001F), DEL and C1 (U+007F to U+009F), U+2028 and U+2029, and the bidi embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069). It is then trimmed. Zero-width characters (for example U+200C and U+200D) are kept, because emoji and some scripts need them.
- `note.text` first folds CRLF and lone CR into LF. It keeps LF and removes every other character in that set, then is trimmed.
- Limits are checked **after** cleaning.

| Field | Rule |
|---|---|
| `v` | exactly `1` |
| `bundleId` | UUID v4. Case-insensitive on input; the app stores it lowercased. |
| `workspaceId` | 22 base64url characters |
| `page.url` | at most 2048 characters, `http:` or `https:` only. Any username and password are removed. |
| `page.title` | at most 1024 characters; may be empty |
| `clientTime` | at most 64 characters: `YYYY-MM-DDThh:mm`, optional `:ss` and `.` plus 1-9 fraction digits, then `Z` or `+hh:mm`/`-hh:mm` (as `toISOString` writes). `T` and `Z` are upper case. It must also parse as a date. |
| `note.text` | 1-20 000 characters |
| `entity.kind` | `email`, `phone`, `username`, `domain`, `url`, `ip` or `wallet` |
| `entity.value` | 1-512 characters, and passes its kind's check (§8.2) |
| `entity.chain` | required for `wallet`, and forbidden otherwise: `btc`, `eth` or `other` |
| `entity.platform` | optional, `username` only: 1-40 characters of `[a-z0-9.-]` |
| `entity.context` | optional, at most 500 characters |

### 8.2 Entity checks

These are acceptance checks only. The app computes identifier keys itself, so the extension should send the value as selected, not normalised.

| Kind | Accepted when |
|---|---|
| `email` | no whitespace, exactly one `@`, a non-empty local part, and a domain that contains a dot and neither starts nor ends with one |
| `domain` | none of whitespace, `/ \ ? # @ :`. IDNA conversion (`url.domainToASCII`) gives a host that contains a dot, is at most 253 characters, and has labels of 1-63 characters (one trailing dot allowed). |
| `url` | parses as an `http:` or `https:` URL |
| `ip` | IPv4 dotted-decimal (no leading zeros) or IPv6, without a zone id (`%eth0`) |
| `phone` | only `0-9`, space, `( ) . -`, with an optional leading `+`, and 4-20 digits in total. This is not a claim of valid E.164. |
| `username` | 1-64 characters, no whitespace |
| `wallet` + `btc` | Base58Check (25 bytes: version `0x00`, `0x05`, `0x6f` or `0xc4`, then a 4-byte double-SHA-256 checksum), **or** a SegWit address with hrp `bc` or `tb`. A SegWit address is single case. Witness v0 uses the bech32 checksum and a 20- or 32-byte program; v1 and later use bech32m. |
| `wallet` + `eth` | `0x` followed by 40 hex digits. If mixed case, it must match the EIP-55 checksum, which uses **Keccak-256**, not FIPS SHA3-256. |
| `wallet` + `other` | 8-128 characters of `[A-Za-z0-9:_-]` |

Vectors: `entity-vectors.json`.

### 8.3 Captures

`capture.files` declares the files that will follow (§7.5). The names are fixed; the app never takes a filename from the extension.

| File | Required | Cap | Content |
|---|---|---|---|
| `page.mhtml` | yes | 50 MB (52 428 800 bytes) | the page as `chrome.pageCapture.saveAsMHTML` wrote it |
| `viewport.png` | no | 25 MB (26 214 400 bytes) | what the analyst saw (`captureVisibleTab`) |
| `page.pdf` | no | 50 MB | the original bytes of a PDF tab |

Each entry is `{"size": <whole number of bytes, at least 1, at most the cap>, "sha256": "<64 lowercase hex>"}` and has no other fields. Violations are `422 invalid` with the field path, for example `capture.files.viewport.png.size: larger than 26214400 bytes`.

## 9. Errors

Every error body is JSON `{"error": "<code>", "detail"?: "<text>"}`.

| Status | Codes |
|---|---|
| 400 | `bad_proto`, `bad_content_type`, `bad_json` |
| 401 | `unauthenticated`, `bad_signature`, `clock_skew`, `replay` |
| 403 | `forbidden`, `bad_origin`, `pair_expired`, `pair_denied`, `unlicensed` |
| 404 | `not_found`, `unknown_workspace`, `unknown_bundle` |
| 405 | `method_not_allowed` |
| 409 | `conflict`, `incomplete` (whose `detail` is an array of file names) |
| 413 | `too_large` |
| 421 | `bad_host` |
| 422 | `invalid`, `hash_mismatch` |
| 429 | `rate_limited` |
| 500 | `internal` |
| 507 | `budget_exceeded` |

## 10. Rate limits

| Scope | Limit |
|---|---|
| All requests | 60 a second |
| `/v1/pair` | 10 a minute (counted only while a pairing is active) |
| `/v1/hello` | 10 a minute per `clientId` |
| `/v1/bundles` | 20 a minute per `clientId` |
| `/v1/bundles/<id>/files/<name>` and `/v1/bundles/<id>/commit`, together | 120 a minute per `clientId` |

## 11. What the app stores

| File | Contents |
|---|---|
| `userData/osint-extension.json` | `{port, instanceId, enabled, clients: [{clientId, origin, extVersion, createdAt, lastSeenAt}]}`. No keys. |
| `userData/osint-extension.secrets` | per-client `K`, `workspaceIdKey` and the inbox `manifestKey`. Encrypted with the OS keychain (Electron `safeStorage`), mode 0600. Where no keychain is available, it is plain JSON, mode 0600, and the settings page shows a warning. |
| `<workspace>/.osint-inbox/` | received bundles (§12). Written only by the app's main process. |

The secrets file has no IPC channel, and the renderer's secret resolver cannot reach it.

## 12. What the app does with a bundle (informative)

Nothing in this section changes the wire format; it says what the replies in §7.4 mean on disk.

The app checks, in order: the manifest (§8, again, in the module that writes), the licence (`403 unlicensed`), the `workspaceId` (`404 unknown_workspace`), whether this `bundleId` was already received (`200 duplicate`), and the inbox budget (`507 budget_exceeded`). The duplicate check comes before the budget so that a retry of a stored bundle hears that it was stored even when the inbox has since filled. A refusal writes nothing.

An accepted bundle lands in the chosen workspace at `.osint-inbox/pending/<bundleId>/manifest.json`. It is written into `.osint-inbox/.staging/<bundleId>/` first (exclusive create, fsync) and the folder is then renamed into `pending/` whole, so a reader never sees half a bundle. Staging folders older than an hour are the remains of a write that died, and are removed when the server starts and when a workspace's inbox is first used.

The stored manifest is the cleaned manifest plus `server: {receivedAt, clientId, origin, extVersion}`, stamped by the app, plus `mac = b64url(HMAC(manifestKey, canonicalJSON(everything but mac)))`. `canonicalJSON` sorts object keys recursively and has no whitespace. `manifestKey` never leaves the app. Before the app applies a bundle it re-verifies the MAC and re-validates the manifest; a bundle that fails is moved to `.osint-inbox/rejected/` with a `reason.json` and is not applied.

A bundle then moves to `done/`, `rejected/` or `removed/`. A `bundleId` found in any of `pending/`, `done/`, `rejected/` or `removed/` is a duplicate. The budget is 2 GB of files under `.osint-inbox/` per workspace; the app never deletes a bundle to make room.

The app's own file APIs for the investigation (`osint:vault.*`) refuse every path under `.osint-inbox/`, whatever its case, so the app's renderer cannot forge a bundle or edit its journal.

### 12.1 Captures

A capture is created in `.osint-inbox/.staging/<bundleId>/` as `upload.json`: the cleaned manifest and the stamp, sealed like a stored manifest. It records who may add files and reserves the declared bytes against the budget; a staging folder counts at its declared size, not at what has arrived, so two captures cannot both be promised the same free space. Each file arrives beside it (§7.5). Staging untouched for an hour is swept like any other.

At commit, `manifest.json` is written last. Its `server` stamp gains `files: {<name>: {size, sha256}}`, computed by the app from the stored bytes, and the MAC covers it with everything else, so a file swapped afterwards no longer matches the sealed digest. The folder is then renamed into `pending/`.

After the commit the app derives, one capture at a time, into the same `pending/<bundleId>/` folder. It first re-hashes `page.mhtml`; an archive that no longer matches the sealed digest is moved to `rejected/` and not derived.

- `page.markdown`: the archive's first `text/html` part, converted to markdown in a separate process that is killed after 60 seconds. The markdown is inert: images become plain links (`[image: alt](url)`), any `![` is escaped, every `://` except in a link target the converter wrote is escaped as `:\/\/` (so no bare URL is left for the app to embed, alone on a line or after `!`), anything that could open an HTML tag is written as `&lt;`, only `http(s)`, `mailto` and relative links are kept, and scripts, styles, frames, objects, embeds and SVG are dropped. It is never named `.md` inside the inbox.
- `fullpage.png`: the archive rendered off-screen with JavaScript off, in a throwaway session that cancels every request except the archive's own `file://` URL and its `cid:` and `data:` parts, with navigation, redirects and new windows refused.
- `derived.json`: `{v: 1, bundleId, status: "done" | "failed", archiveSha256, markdown?: {file, sha256}, fullpage: {file, sha256} | {error}, contentLocation, urlMismatch, title, errors, derivedAt, mac}`. `archiveSha256` is the digest of the `page.mhtml` it was derived from. `contentLocation` is the archive's `Snapshot-Content-Location` (else the document part's `Content-Location`), or null; `urlMismatch` is true when it is not `page.url` (ignoring the fragment and credentials) or is unknown. `mac = b64url(HMAC(manifestKey, "OCDERIVED1\n" + canonicalJSON(everything but mac)))`. A failure is recorded here, never thrown; `status` is `failed` when no markdown could be made.

A pending capture is handed to the renderer only once its `derived.json` verifies, and with it. One committed but never derived (the app stopped in between), or whose `derived.json` does not verify, is derived again when the server starts and whenever the inbox is listed.

**Placing.** The window applying the inbox asks main to place a derived capture. Main checks the stored manifest's MAC, `derived.json`'s MAC and that its `archiveSha256` is the sealed digest of `page.mhtml`, then **copies** (the bundle keeps its own files until it moves to `done/`) into the investigation:

| From the bundle | To |
|---|---|
| `page.mhtml` | `OSINTCopilot/Evidence/<stem>.mhtml` |
| `fullpage.png` | `OSINTCopilot/Evidence/<stem>.png` |
| `viewport.png` | `OSINTCopilot/Evidence/<stem>.viewport.png` |
| `page.pdf` | `OSINTCopilot/Evidence/<stem>.pdf` |
| `page.markdown` | `OSINTCopilot/Evidence/<stem>.md` |

`<stem>` is `[a-z0-9-]` from `page.title` (else the archived title, else the host), at most 60 characters, then `-` and the first 8 hex digits of the archive's sha256. Every file is first hashed while it is copied into a temporary file in the bundle folder, and only when all of them match their sealed digests (from the manifest for what the extension sent, from `derived.json` for what main made) are they linked into place, each with an exclusive create; a placement that fails part way removes the files it created, so a capture is placed whole or not at all. A sent file that no longer matches moves the capture to `rejected/`; a derived file that no longer matches is derived again. `OSINTCopilot` and `OSINTCopilot/Evidence` are resolved one component at a time and must really be inside the workspace and outside `.osint-inbox/`; a symlink leading elsewhere is refused and nothing is placed. A name already holding the same bytes is reused (the identical page captured twice is one piece of evidence); holding anything else, or a symlink, `-2`, `-3`, ... is tried. Before creating each file main records its name under the step `placement` in `state.json` (a step the renderer may not write), so a placement repeated after a crash reports the files it made as its own (`created`) and ones it found as reused.

The renderer then makes one Evidence entity keyed `evidence:<archive sha256>` (a second capture of the same bytes merges into it), with a source for the live URL and one for `vault://<the .mhtml>` whose rationale gives the digest, and a section in the page's Sources note listing the files. Removing the item trashes only the files its placement created, and none that another applied item or the surviving Evidence entity still names. Because a capture still pending may have journaled a placement that reused those files, the renderer asks main to place again every time it applies a capture, rather than trusting the journaled placement: files trashed meanwhile are placed anew, and then count as the capture's own.
