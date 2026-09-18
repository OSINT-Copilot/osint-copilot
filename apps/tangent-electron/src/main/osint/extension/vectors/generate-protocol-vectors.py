# Writes protocol-vectors.json. An independent generator: it computes every expected
# value straight from the PROTOCOL.md text with Python's hashlib/hmac, so the TypeScript
# implementation is checked against a second implementation, not against itself.
# Run from this folder: python3 generate-protocol-vectors.py > protocol-vectors.json
import base64, hashlib, hmac, json, sys

def b64u(b): return base64.urlsafe_b64encode(b).decode().rstrip('=')
def mac(key, s): return hmac.new(key, s.encode('utf-8'), hashlib.sha256).digest()
def sha(b): return hashlib.sha256(b).hexdigest()

pair_secret = bytes(range(0x00, 0x20))
client_nonce = b64u(bytes(range(0xa0, 0xb0)))
server_nonce = b64u(bytes(range(0xb0, 0xc0)))
client_id = b64u(bytes(range(0xc0, 0xd0)))
instance_id = b64u(bytes(range(0xd0, 0xe0)))
req_nonce = b64u(bytes(range(0xe0, 0xf0)))
ws_key = bytes(range(0x40, 0x60))
port = 23760
# Every request, response and hello proof is bound to the address the extension dialled.
endpoint = "127.0.0.1:" + str(port)

pairing_id = sha(pair_secret)[:32]
pair_proof_s = "OCPAIR1\n" + client_nonce
pair_proof = b64u(mac(pair_secret, pair_proof_s))
kd_s = "oc-k1\n" + client_nonce + "\n" + server_nonce + "\n" + client_id
K = mac(pair_secret, kd_s)
sp_s = "OCPAIR1S\n" + client_nonce + "\n" + server_nonce + "\n" + client_id
server_proof = b64u(mac(pair_secret, sp_s))
hello_s = "OCHELLO1\n" + endpoint + "\n" + client_nonce + "\n" + server_nonce + "\n" + instance_id
hello_proof = b64u(mac(K, hello_s))

def request(method, path, ts, nonce, body):
    bl = len(body)
    bh = sha(body)
    s = "OC1\n" + endpoint + "\n" + method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + client_id + "\n" + str(bl) + "\n" + bh
    return {"endpoint": endpoint, "method": method, "pathWithQuery": path, "ts": ts, "nonce": nonce, "clientId": client_id,
            "body": body.decode('utf-8'), "contentLength": str(bl), "bodySha256": bh,
            "stringToSign": s, "signature": b64u(mac(K, s))}

def octet_request(path, ts, nonce, body):
    # A file upload: the body is raw bytes, given as hex because it need not be UTF-8.
    # Signed exactly like any other request; Content-Type is not part of the string.
    r = request("POST", path, ts, nonce, b"")
    bl = len(body)
    bh = sha(body)
    s = "OC1\n" + endpoint + "\nPOST\n" + path + "\n" + ts + "\n" + nonce + "\n" + client_id + "\n" + str(bl) + "\n" + bh
    del r["body"]
    r.update({"contentType": "application/octet-stream", "bodyHex": body.hex(), "contentLength": str(bl),
              "bodySha256": bh, "stringToSign": s, "signature": b64u(mac(K, s))})
    return r

def response(status, nonce, body):
    bh = sha(body)
    s = "OC1R\n" + endpoint + "\n" + str(status) + "\n" + nonce + "\n" + bh
    return {"endpoint": endpoint, "status": status, "requestNonce": nonce, "body": body.decode('utf-8'), "bodySha256": bh,
            "stringToSign": s, "signature": b64u(mac(K, s))}

manifest = ('{"v":1,"bundleId":"0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e","workspaceId":"AAAAAAAAAAAAAAAAAAAAAA",'
            '"kind":"note","page":{"url":"https://example.com/a?b=1","title":"Café — example"},'
            '"clientTime":"2025-10-09T08:53:20.000Z","note":{"text":"line one\\nline two"}}').encode('utf-8')

realpath = "/home/analyst/Investigations/Case été"
out = {
    "_comment": "Generated independently (Python hashlib/hmac, generate-protocol-vectors.py) from PROTOCOL.md. Raw byte inputs are given as hex; everything on the wire is base64url without padding. Strings are UTF-8.",
    "inputs": {
        "pairSecretHex": pair_secret.hex(), "pairSecret": b64u(pair_secret),
        "clientNonce": client_nonce, "serverNonce": server_nonce, "clientId": client_id,
        "instanceId": instance_id, "port": port, "endpoint": endpoint,
    },
    "pairingString": "ocpair1." + str(port) + "." + instance_id + "." + b64u(pair_secret),
    "pairingId": pairing_id,
    "pairProof": {"stringToSign": pair_proof_s, "proof": pair_proof},
    "keyDerivation": {"stringToSign": kd_s, "keyHex": K.hex(), "key": b64u(K)},
    "pairServerProof": {"stringToSign": sp_s, "proof": server_proof},
    "helloProof": {"stringToSign": hello_s, "proof": hello_proof},
    "requests": [
        request("POST", "/v1/bundles", "1760000000000", req_nonce, manifest),
        request("GET", "/v1/status", "1760000000123", b64u(bytes(range(0xf0, 0x100))), b""),
    ],
    "octetRequests": [
        octet_request("/v1/bundles/0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e/files/viewport.png", "1760000000456",
                      b64u(bytes(range(0x10, 0x20))), bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) + bytes(range(0x00, 0x100))),
    ],
    "responses": [
        response(200, req_nonce, b'{"status":"accepted","bundleId":"0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e","receivedAt":"2025-10-09T08:53:20.500Z"}'),
        response(401, req_nonce, b'{"error":"replay"}'),
    ],
    "workspaceId": {"keyHex": ws_key.hex(), "realpath": realpath,
                    "id": b64u(mac(ws_key, realpath))[:22]},
}
json.dump(out, sys.stdout, indent='\t', ensure_ascii=True)
print()
