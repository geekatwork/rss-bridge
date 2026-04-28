# GitHub Publication Plan

## Goal

Publish this repository as a public project that can be cloned and run with minimal setup.

## Phase 1: Security and Hygiene

1. Confirm secrets are not committed:
- .env
- cookie JSON files
- any access tokens in docs or scripts

2. Verify ignore rules cover:
- .env
- node_modules/
- dist/
- cookies/**/*.json

3. Run a final scan before push:
- search for obvious token patterns
- check git status for accidental sensitive files

## Phase 2: Repository Readiness

1. Ensure docs are current:
- root README with quick start
- packages/scraper/ARCHITECTURE.md
- packages/feed-generator/README.md
- TEST_PLAN.md

2. Ensure base metadata exists:
- LICENSE
- CONTRIBUTING.md (optional but recommended)
- SECURITY.md (recommended)

3. Validate builds and tests locally:
- npm run test:all

## Phase 3: Initialize and Push

1. Initialize and commit (if needed):
- git init
- git branch -M main
- git add .
- git commit -m "Initial public release"

2. Create GitHub repository:
- Name: rss-bridge
- Visibility: Public
- Do not initialize with README (repo already has one)

3. Connect and push:
- git remote add origin git@github.com:<your-user>/rss-bridge.git
- git push -u origin main

## Phase 4: Public Availability Hardening

1. Enable GitHub features:
- Issues
- Discussions (optional)
- Pull requests

2. Add repository details:
- Description
- Topics (rss, scraper, docker, postgres, typescript)
- Homepage (optional)

3. Configure branch protection (recommended):
- require PR reviews for main
- require status checks after CI is added

## Phase 5: CI and Release

1. Add CI workflow to run:
- npm ci
- npm run test:build
- npm run test:smoke

2. Tag first version:
- git tag v1.0.0
- git push origin v1.0.0

3. Publish release notes with:
- architecture overview
- env configuration
- known limitations

## Definition of Done

Project is considered publicly available when:

1. Repository is public and cloneable.
2. README setup works on a clean machine.
3. test:all passes locally and in CI.
4. No secrets are present in git history or tracked files.
