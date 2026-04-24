---
description: Bump version, build, sign, notarize, and publish RadioVault to GitHub Releases
---

Release a new version of RadioVault. This will:
1. Bump the version in package.json
2. Build the macOS arm64 DMG and zip
3. Sign with Apple Developer ID
4. Notarize with Apple
5. Upload to GitHub Releases (treydoe1/radiovault)

## Steps

1. Read the current version from package.json
2. Determine the new version:
   - If the user provided a version argument like "1.2.0", use that
   - If the user said "patch", bump the patch number (e.g., 1.1.0 -> 1.1.1)
   - If the user said "minor", bump the minor number (e.g., 1.1.0 -> 1.2.0)
   - If the user said "major", bump the major number (e.g., 1.1.0 -> 2.0.0)
   - If no argument, bump the patch number by default
3. Update the version in package.json
4. Run the build: `export GH_TOKEN=$(gh auth token) && npm run publish`
5. Report the result: version number, release URL, and DMG path

## Important
- Do NOT commit or push git changes -- just build and publish
- The build command takes a few minutes (signing + notarization)
- If the build fails, revert the version bump in package.json
