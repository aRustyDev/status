# Temporary npm attestation recovery

The npm registry's attestation endpoints for `@better-forge/contracts@0.2.0`,
`@better-forge/db@0.2.0`, and `@better-forge/ui@0.4.0` currently respond with
HTTP 200 and `OK\r\n` instead of their advertised attestation JSON. This breaks
`npm audit signatures`. Remove this workaround when the registry returns the
original bundles again.

The checked-in JSON contains the original DSSE signatures, signing certificates
or public-key identifiers, and Rekor inclusion evidence. Their npm publish and
SLSA payloads were reconstructed from public package metadata and the release
workflow identity in the signed certificates; each payload's SHA-256 matches the
corresponding public Rekor entry. The entries can be found by querying
`https://rekor.sigstore.dev/api/v1/index/retrieve` using the package's SHA-512.
The bundles have been verified with npm's Sigstore verifier.

The preload supplies the recovered JSON only to pacote's fetch of those three
exact HTTPS URLs, after a fresh live response exactly matches the broken bytes.
It requires the lockfile and live registry version, integrity, and advertised
provenance metadata to match the pinned values and requires exactly one publish
and one SLSA statement with the expected subject. All other requests and
responses pass through. npm's normal audit still verifies the registry signatures,
subjects, publisher keys, Sigstore signatures, certificate chains and log proofs.
Transport errors, altered metadata, invalid signatures, and all other unexpected
responses still fail the audit.

These snapshots cannot detect a newly added or withdrawn attestation that is not
reflected in the registry's advertised provenance metadata. They are a temporary
availability workaround, not a substitute for restoring the registry endpoint.
