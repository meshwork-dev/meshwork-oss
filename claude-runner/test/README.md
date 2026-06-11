# claude-runner test suite

Run from `claude-runner/`:

```bash
npm test
```

## Requirements

- **Docker** — the integration tests start a throwaway Postgres container
  (`postgres:16-alpine`, name `meshwork-runner-test-pg`, random host port).
  If a container from a previous test run is still up it is reused; each run
  creates (and drops) its own fresh database inside it.
  When Docker is unavailable the integration tests **skip** with a clear
  message; the unit tests (`test/unit.test.mjs`) still run.
- No real Claude CLI is ever executed: `config.claude.command` is pointed at a
  stub script that exits immediately, and `HOME` is redirected to an empty
  temp dir so the runner never reads or refreshes your real
  `~/.claude/.credentials.json`.

## Notes

- `runner.js` only reads its configuration from `claude-runner/config.json`,
  so the harness temporarily writes a test config there. A pre-existing
  `config.json` is backed up to `config.json.test-backup` and restored on
  teardown. Avoid running the suite at the same time as a production runner
  started from this same directory.
- Cleanup of the Postgres container (optional, it is reused across runs):
  `docker rm -f meshwork-runner-test-pg`
- Override image/container via `TEST_PG_IMAGE` / `TEST_PG_CONTAINER`.
