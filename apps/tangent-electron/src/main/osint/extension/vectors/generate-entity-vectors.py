# Writes entity-vectors.json: the acceptance cases the app and the extension share.
# Expected results are written by hand from PROTOCOL.md, not computed by either side.
# Run from this folder: python3 generate-entity-vectors.py
import json

A, R = 'accept', 'reject'


def e(kind, value, expect, note, **kw):
    d = {"kind": kind, "value": value}
    d.update(kw)
    return {"note": note, "entity": d, "expect": expect}


entities = [
    e("email", "analyst@example.com", A, "plain address"),
    e("email", "First.Last+tag@sub.example.co.uk", A, "plus tag and subdomain"),
    e("email", "no-at-sign.example.com", R, "no @"),
    e("email", "a@b@example.com", R, "two @"),
    e("email", "a b@example.com", R, "whitespace"),
    e("email", "user@localhost", R, "no dot in the domain"),
    e("email", "@example.com", R, "empty local part"),
    e("domain", "example.com", A, "plain"),
    e("domain", "b\u00fccher.de", A, "IDN converts to punycode"),
    e("domain", "xn--bcher-kva.de", A, "already punycode"),
    e("domain", "localhost", R, "no dot"),
    e("domain", "example.com/path", R, "URL-shaped: belongs to the url kind"),
    e("domain", "a..com", R, "empty label"),
    e("domain", "exa mple.com", R, "whitespace"),
    e("url", "https://example.com/a?b=1", A, "https"),
    e("url", "http://example.com", A, "http"),
    e("url", "ftp://example.com/file", R, "not http(s)"),
    e("url", "javascript:alert(1)", R, "script scheme"),
    e("url", "example.com", R, "no scheme"),
    e("ip", "192.0.2.1", A, "IPv4"),
    e("ip", "2001:db8::1", A, "IPv6"),
    e("ip", "256.1.1.1", R, "octet out of range"),
    e("ip", "1.2.3", R, "three octets"),
    e("ip", "01.2.3.4", R, "leading zero is not dotted-decimal"),
    e("ip", "fe80::1%eth0", R, "IPv6 with a zone id"),
    e("phone", "+44 20 7946 0958", A, "international with spaces"),
    e("phone", "(555) 010-4477", A, "national with punctuation"),
    e("phone", "123", R, "three digits"),
    e("phone", "+123456789012345678901", R, "21 digits"),
    e("phone", "555-CALL-NOW", R, "letters"),
    e("phone", "12+34567", R, "plus not leading"),
    e("username", "john_doe", A, "plain"),
    e("username", "john", A, "with platform", platform="github"),
    e("username", "john doe", R, "whitespace"),
    e("username", "a" * 65, R, "65 characters"),
    e("username", "john", R, "platform with uppercase", platform="GitHub"),
    e("username", "john", R, "platform too long", platform="a" * 41),
    e("email", "a@example.com", R, "platform on a non-username", platform="github"),
    e("wallet", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", A, "btc Base58Check P2PKH", chain="btc"),
    e("wallet", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", A, "btc Base58Check P2SH", chain="btc"),
    e("wallet", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", R, "btc Base58Check checksum broken by one character", chain="btc"),
    e("wallet", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", A, "btc bech32 v0", chain="btc"),
    e("wallet", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", A, "btc bech32m v1", chain="btc"),
    e("wallet", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", R, "btc v0 with a bech32m checksum", chain="btc"),
    e("wallet", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", R, "btc bech32 checksum broken", chain="btc"),
    e("wallet", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", A, "eth EIP-55 checksummed", chain="eth"),
    e("wallet", "0xde709f2102306220921060314715629080e2fb77", A, "eth all lowercase (no checksum claimed)", chain="eth"),
    e("wallet", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", R, "eth mixed case failing EIP-55", chain="eth"),
    e("wallet", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA", R, "eth too short", chain="eth"),
    e("wallet", "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer", A, "other chain, no checksum", chain="other"),
    e("wallet", "short", R, "other chain under 8 characters", chain="other"),
    e("wallet", "has space in it", R, "other chain with spaces", chain="other"),
    e("wallet", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", R, "wallet without a chain"),
    e("wallet", "0xde709f2102306220921060314715629080e2fb77", R, "unknown chain", chain="sol"),
    e("email", "a@example.com", R, "chain on a non-wallet", chain="btc"),
    e("gps", "51.5,-0.1", R, "unknown entity kind"),
    e("email", "x" * 500 + "@example.com", A, "value of exactly 512 characters"),
    e("email", "x" * 501 + "@example.com", R, "value of 513 characters"),
    {"note": "context over 500 characters",
     "entity": {"kind": "email", "value": "a@example.com", "context": "c" * 501}, "expect": R},
    {"note": "unknown field",
     "entity": {"kind": "email", "value": "a@example.com", "confidence": 1}, "expect": R},
    {"note": "control characters and U+2028 are stripped, then the value is checked",
     "entity": {"kind": "email", "value": "a\u0000@exa\u2028mple.com"}, "expect": A, "value": "a@example.com"},
    {"note": "bidi overrides and isolates are stripped from a value",
     "entity": {"kind": "username", "value": "\u2066jo\u202ehn\u2069"}, "expect": A, "value": "john"},
]

base = {
    "v": 1,
    "bundleId": "0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e",
    "workspaceId": "AAAAAAAAAAAAAAAAAAAAAA",
    "page": {"url": "https://example.com/", "title": "Example"},
    "clientTime": "2025-10-09T08:53:20.000Z",
}


def m(note, expect, over=None, drop=None, **extra):
    d = json.loads(json.dumps(base))
    d.update(over or {})
    for k in (drop or []):
        d.pop(k, None)
    r = {"note": note, "manifest": d, "expect": expect}
    r.update(extra)
    return r


note = {"kind": "note", "note": {"text": "hello"}}
manifests = [
    m("note", A, note),
    m("entity", A, {"kind": "entity", "entity": {"kind": "domain", "value": "example.com"}}),
    m("credentials are stripped from page.url", A,
      {**note, "page": {"url": "https://user:pw@example.com/x", "title": ""}}, url="https://example.com/x"),
    m("note keeps newlines and drops other control characters", A,
      {"kind": "note", "note": {"text": "one\r\ntwo\u0007\u2029three"}}, text="one\ntwothree"),
    m("uppercase bundleId is lowercased", A,
      {**note, "bundleId": "0B7E7C1E-3F7A-4C56-9A3E-2D4F5B6C7D8E"}, bundleId="0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e"),
    m("capture is a later-phase kind", R, {"kind": "capture"}, detail="kind not supported by this app version"),
    m("unknown kind", R, {"kind": "bogus"},
      detail="kind: must be one of note, entity, capture, highlight, highlight.update, highlight.delete"),
    m("wrong version", R, {**note, "v": 2}, detail="v: must be 1"),
    m("bundleId not a v4 UUID", R, {**note, "bundleId": "0b7e7c1e-3f7a-1c56-9a3e-2d4f5b6c7d8e"},
      detail="bundleId: must be a UUID v4"),
    m("workspaceId that is a path", R, {**note, "workspaceId": "/home/analyst/case"},
      detail="workspaceId: must be a workspace id from /v1/workspaces"),
    m("page.url not http(s)", R, {**note, "page": {"url": "file:///etc/passwd", "title": ""}},
      detail="page.url: must be an http(s) URL"),
    m("page.url over 2048 characters", R, {**note, "page": {"url": "https://example.com/" + "a" * 2040, "title": ""}},
      detail="page.url: longer than 2048 characters"),
    m("page.title over 1024 characters", R, {**note, "page": {"url": "https://example.com/", "title": "t" * 1025}},
      detail="page.title: longer than 1024 characters"),
    m("note.text over 20000 characters", R, {"kind": "note", "note": {"text": "n" * 20001}},
      detail="note.text: longer than 20000 characters"),
    m("empty note", R, {"kind": "note", "note": {"text": "  \u0000 "}}, detail="note.text: must not be empty"),
    m("entity field on a note", R, {**note, "entity": {"kind": "email", "value": "a@example.com"}},
      detail="entity: unknown field"),
    m("unknown top-level field", R, {**note, "path": "/tmp"}, detail="path: unknown field"),
    m("note text loses bidi overrides", A,
      {"kind": "note", "note": {"text": "paid \u202etxt.exe"}}, text="paid txt.exe"),
    m("missing clientTime", R, note, drop=["clientTime"], detail="clientTime: must be a string"),
    m("clientTime with an offset", A, {**note, "clientTime": "2025-10-09T10:53:20+02:00"}),
    m("clientTime that Date.parse takes but is not ISO 8601", R, {**note, "clientTime": "March 7"},
      detail="clientTime: must be an ISO 8601 time"),
    m("clientTime that is a bare number", R, {**note, "clientTime": "1"},
      detail="clientTime: must be an ISO 8601 time"),
    m("entity failing its check names the field", R,
      {"kind": "entity", "entity": {"kind": "ip", "value": "999.1.1.1"}},
      detail="entity.value: not an IPv4 or IPv6 address"),
]

out = {
    "_comment": "Shared acceptance vectors for the extension and the app. 'entities' go through "
                "validateEntity, 'manifests' through validateManifest (the POST /v1/bundles body). Where "
                "given, 'value', 'url', 'text' and 'bundleId' are the cleaned result, and 'detail' is the "
                "exact 422 detail. Regenerate with generate-entity-vectors.py.",
    "entities": entities,
    "manifests": manifests,
}
with open("entity-vectors.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent="\t", ensure_ascii=True)
    f.write("\n")
