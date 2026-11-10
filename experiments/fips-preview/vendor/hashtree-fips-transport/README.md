# Pinned Hashtree TCP/FIPS client transport

These two source files are vendored from `@hashtree/fips-transport` **0.5.0**, published in the pinned [hashtree-ts-runtime-v0.5.38 release artifact](https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.38/hashtree-fips-transport-0.5.0.tgz). They retain the upstream API and MIT license (see `LICENSE`). The experiment's lockfile supplies the matching `@fips/tcp` 0.2.3 and `@hashtree/core` 0.4.0 dependencies. No dependency files are rewritten during installation.

Only `tcpBlobTransport.ts` is changed. In `fetchFromPeer`, a valid MISSING response or complete SHA-256-verified body closes gracefully. Failed attempts abort the TCP stream. A graceful close after a read timeout leaves an unread receive buffer and the provider's queued response alive; a retry then competes with that abandoned stream. The existing TCP endpoint's abort sends RST and releases the local tuple, and the existing provider handles that RST. Server file reads already in progress may still finish before their next write observes the closed stream.

This patch fixes failed-read cleanup. It does not add retries, increase deadlines, change concurrency, alter verification, or guarantee throughput over a constrained mesh link. `uploadRateLimiter.ts` is unchanged and included because the transport imports it. No discovery, browser-provider, or unrelated package source is vendored.

Original packaged file SHA-256 values, before the patch:

| File | SHA-256 |
| --- | --- |
| `src/tcpBlobTransport.ts` | `38b383f198061481ec823ba97ce5208b6e9ebe278c5036cd3e755f71947a33d9` |
| `src/uploadRateLimiter.ts` | `290f25b2ef889a25dafa235cbaecf6e258dfd9d19d6103137605af75bf71de35` |
| `LICENSE` | `d43b5e99d9d0e73f69edac17b4167b5f973bb4920edc77f344c1091c4ec1b86c` |

Run `bun test timeout-cleanup.test.ts` from `experiments/fips-preview`. It uses real local FipsNodes and TCP streams with deterministic body-packet loss, checks repeated failed reads release buffered streams on both ends, then verifies recovery bytes. It also checks valid missing and successful responses. The cleanup test failed against the original source and passed with this patch; no public network is required.

When upgrading the upstream dependency, compare this focused change with the new implementation and remove the vendored copy once upstream provides equivalent cleanup.
