# Security policy

## Supported versions

Only the latest minor release of `@bmfk/api` gets security fixes.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a
public issue.

Please include the affected version, what an attacker can do, and steps or code to reproduce it.

## What happens next

| Step | Target |
|---|---|
| Acknowledgement | 2 working days |
| Assessment and severity (CVSS) | 5 working days |
| Fix released — critical or high | 30 days at most |
| Fix released — medium or low | next planned release |

Every fix is listed in `CHANGELOG.md` under **Security**, with its advisory once it is published.

## How releases are made

- Every change goes through a pull request reviewed by someone other than its author; `main` is protected.
- CI runs type checks, the test suite and `npm audit` on every pull request.
- Packages are published only from CI, with npm provenance, so each release can be traced to its commit
  and workflow run. An SBOM (CycloneDX) is attached to every GitHub release.
