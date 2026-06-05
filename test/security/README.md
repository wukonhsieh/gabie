# Security Tests

Run with:

```bash
npm run test:security
```

This script intentionally runs only `test/security/*.test.ts`. Use `npm test` for the full Vitest suite.

## Test files

| File | Tests | What it covers |
|------|-------|----------------|
| `bash-injection.test.ts` | 29 | Bash deny-list blocks `rm -rf /`, `sudo`, fork bomb, `shutdown`, network tools (`curl`/`wget`/`nc`, etc.); dangerous cases are checked without executing them |
| `path-traversal.test.ts` | 26 | `../` escapes, absolute paths, null bytes blocked for all file tools; low-level `wsWriteFile`/`wsReadFile`/`wsDeleteFile` guards |
| `ssrf.test.ts` | 14 | `file://` / `ftp://` blocked; localhost, private IPv4, metadata, IPv6, decimal/hex loopback blocked before `fetch`; outbound `fetch` is mocked |
| `llm-adversarial.test.ts` | 9 (skipped) | Auto-skips without `LLM_URL`; when set: tests path traversal, bash injection, prompt injection, exfiltration through a real model |

## Adversarial LLM tests

Start the MLX server, then:

```bash
LLM_URL=http://127.0.0.1:11434/v1 LLM_MODEL=<model-id> npm run test:security
```

## Network and shell safety

- Dangerous `run_bash` cases are tested at the deny-list guard level, so they do not spawn a shell.
- Benign workspace commands (`ls`, `echo`, `mkdir`, `node --version`) intentionally execute through `bash -lc` in a temporary workspace.
- `ssrf.test.ts` mocks `globalThis.fetch`, so it does not perform real web requests.
- `llm-adversarial.test.ts` calls a real LLM only when `LLM_URL` is set.
