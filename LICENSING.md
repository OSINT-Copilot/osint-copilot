# Licensing status

OSINT Copilot is licensed under Apache-2.0. See [LICENSE.txt](LICENSE.txt), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Premium licensing is currently dormant: all features are available without a key and the app
makes no licence-server request. The retained verification and subscription implementation is
documented at [docs/premium.md](docs/premium.md). It intentionally contains only the public
client contract; private service operations and maintainer-specific commands do not belong in
this repository.

The compiled Ed25519 verification key is public by design. The corresponding private signing
key must never be committed, packaged, logged, or copied into a release artifact.
