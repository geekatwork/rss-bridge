# Security Policy

## Supported versions

Security fixes target the current `main` branch. Older commits, images and local
modifications are not maintained separately. Deployments do not update
automatically when a fix merges.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/geekatwork/rss-bridge/security/advisories/new).
Do not open a public issue or pull request containing exploit details.

Include the affected commit/image, affected component, impact and minimal
reproduction using synthetic data. Never include live cookies, tokens,
passwords, private scraped content or database dumps. Report an exposed
credential without repeating its value, and revoke or rotate it immediately.

The maintainer will assess the report privately and coordinate a fix and
disclosure with the reporter. There is no guaranteed response or release
timeline. Please agree on disclosure timing before publishing details; once
remediation is available, a GitHub security advisory can describe impact and
upgrade guidance.

## Repository safeguards

Secret scanning, push protection, Dependabot vulnerability alerts, security
updates and private reporting are enabled. These do not guarantee detection
of every secret or vulnerability; dependency updates require review and merge.

`main` requires a pull request, up-to-date `build` and `smoke` checks from GitHub
Actions, and resolved review conversations. Protection applies to
administrators; force pushes and branch deletion are disabled.

Sensitive paths have [CODEOWNERS](.github/CODEOWNERS). Mandatory approval and
code-owner review are deferred until an additional eligible reviewer is
available: the sole owner cannot approve their own pull requests. Story #7
therefore retains this acceptance gap.

Actions use read-only workflow permissions and cannot approve pull requests.
Only GitHub-owned actions are allowed, and all outside collaborators require
approval before their workflows run. Before approving a contribution, inspect
its workflow and executable changes; approval is not a safety guarantee.
