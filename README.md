# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Brooo-ui/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Brooo-ui/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits to a tree of text files: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls, all or nothing, to the SPEC.md contract.

## Run it

```sh
node main.ts fix.patch   # apply a patch file; omit it (or pass -) to read the patch from stdin
```

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`), `--check`
(verify without writing), `--strict` (exact line matching only). See SPEC.md for the
full contract: three matching tiers, atomic all-or-nothing writes, and per-format
edge rules (wrong line numbers, CRLF files, missing trailing newlines, renames, moves).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
- `runner.ts`: kept as the kit has it. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: runs the public practice set on your own machine (`node check.ts <practice.json>`).
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hr01y5fg&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
