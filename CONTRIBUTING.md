# Contributing to gsynchro

Thank you for improving `gsynchro`.

## Before opening a pull request

1. Open an issue first for a bug, a behavior change, or a non-trivial feature, so the intended synchronization semantics can be discussed.
2. Fork the repository and create a focused branch from `main`.
3. Use Node.js 20 or later, then run:

   ```bash
   npm install
   npm run typecheck
   npm run build
   npm pack --dry-run
   ```

4. Update `README.md` and, for Linux mount changes, `docs/linux-rclone.md` whenever the user-visible behavior or setup changes.

## Pull requests

Describe the problem, the behavior before and after the change, and how you verified it. Keep unrelated formatting or refactoring out of the pull request. `gsynchro` deliberately synchronizes selected documentation and task files, not source trees: preserve that scope and its safety rules unless the change explicitly revisits them.

## Reporting security issues

Do not publish sensitive details in a public issue. Contact the maintainer through the email listed on the npm package page and include a minimal reproduction where possible.
