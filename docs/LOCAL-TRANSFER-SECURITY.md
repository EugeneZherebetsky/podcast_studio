# Local transfer security: feasibility and review gate

Status: **blocked; no Wi-Fi pairing or LAN listener is implemented or approved for use.** USB export/import remains independent. T17 and T19 remain open.

## TLS feasibility

The mobile workspace declares Expo 58.0.24, React Native 0.88.1 and expo-file-system 58.0.13. The [Expo SDK 58 fetch documentation](https://docs.expo.dev/versions/v58.0.0/sdk/expo/#expofetch-api) describes a standard Fetch API, installed as global `fetch` on Android. The [file-system documentation](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) documents downloads but does not document a per-request certificate verification or runtime pin option. The declared mobile dependencies include no dedicated certificate-pinning module. We have not established an installed API that verifies a PC-specific runtime fingerprint during the TLS handshake, before a pairing code or bearer credential is transmitted. Absence from these APIs is not a claim that Android cannot implement it natively.

[Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config#CertificatePinning) documents declarative XML public-key (SPKI SHA-256) pins and packaged custom trust anchors, not provisioning a different PC's pin at runtime. These pins are public-key hashes, not necessarily a full-certificate fingerprint. Trusting an arbitrary self-signed certificate, disabling certificate verification, using cleartext, or checking a fingerprint only after sending a secret is not an acceptable substitute. The owner approved an Android native module and expo-secure-store; independent security review and device verification remain required.

## Existing exposure is not a transfer design

The desktop server defaults to loopback. Its existing legacy pairing and remote bearer-token logic must not be reused or exposed as the new listener: a valid legacy device token can access the broader desktop API if it is reachable remotely, and legacy pairing is not an authenticated encrypted channel. Do not bind that server to a LAN interface, forward it through a proxy, or treat its current pairing as secure Wi-Fi transfer. No phone progress or vocabulary is to be uploaded.

## Prerequisites for a reviewed implementation

See the [transfer threat model](LOCAL-TRANSFER-THREAT-MODEL.md) for assets and abuse cases, and the [proposed protocol](LOCAL-TRANSFER-PROTOCOL.md) for the ceremony and remaining implementation gates.

- Establish and verify PC identity on the phone **before** sending pairing codes or reusable credentials, including mismatched, substituted and rotated certificate cases. Specify how the initial fingerprint is authenticated out of band and how recovery works.
- Use a separate, opt-in listener, off by default, not a proxy to the desktop API. Limit it to the explicitly reviewed pairing and episode-read/download operations; do not register job, settings, deletion, legacy sync or other desktop routes.
- Define explicit PC approval for each device, denial, expiry, revocation and key storage. Authorize each episode request, avoid logging credentials, and prevent redirects from carrying secrets elsewhere.
- Define and verify home-network admission beyond merely checking private IP ranges, including multiple interfaces, VPNs, IPv4/IPv6, proxies, network changes and firewall behavior. No router forwarding or public exposure.
- Review package staging and integrity verification against the existing shared contract; no schema or package-format change without owner approval. Retain local progress on failure.
- Before enabling LAN access, obtain safety review and demonstrate unauthorized, revoked, wrong-server, cross-network and broad-API rejection, plus device acceptance/rejection and offline download/playback checks. Do not claim completion without device checks.
- Independent review identified unresolved blockers: per-OS effective firewall and ingress proof; rollback-resistant revocation and explicit rotation/re-pair recovery; QR-observer impersonation and product acceptance or a stronger ceremony; and measured, scannable whole-QR encoding. See the protocol for fail-closed conditions and Android TLS, SecureStore and API 37 permission device gates.
