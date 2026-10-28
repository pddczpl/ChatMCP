## Summary

<!-- What changes, and why? Link the issue if there is one. -->

## How it was verified

<!-- List the commands you ran and their result. Say what you could NOT run. -->

```text
cd DATGOLD-HUB && node tests/run-all.mjs
cd DATGOLD-HUB/ui && npm run build && npm run test:unit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/Test-InstallerPayload.ps1   # installer or scripts/ changes only
```

## Checklist

- [ ] Every commit is signed off (`git commit -s`): I certify the [Developer Certificate of Origin 1.1](https://github.com/pddczpl/ChatMCP/blob/main/CONTRIBUTING.md#developer-certificate-of-origin-dco), and I agree that my contribution is licensed under the Apache License 2.0 (no CLA).
- [ ] I ran `node tests/run-all.mjs` in `DATGOLD-HUB` and the result is reported above.
- [ ] Documentation is updated where behavior changed (`docs/`, and the suite counts in `docs/DEVELOPMENT.md` if I added a `tests/verify-*.mjs` suite).
- [ ] New or upgraded redistributed dependencies are Apache-2.0 compatible and listed in `docs/LICENSE-SCAN.md`.
- [ ] Commit messages follow `type: lower-case subject` (`feat`, `fix`, `test`, `docs`, `chore`).

## AI assistance

- [ ] No AI tool helped with this change.
- [ ] An AI tool helped: tool/model and what it did: <!-- e.g. "Claude Code drafted the tests; I rewrote the parser" -->
- [ ] I reviewed and understand all of the AI-assisted code, I ran the tests myself, and the commits keep their `Co-Authored-By:` trailers.

Security vulnerabilities do not belong in a public pull request or issue: see [SECURITY.md](https://github.com/pddczpl/ChatMCP/blob/main/SECURITY.md).
