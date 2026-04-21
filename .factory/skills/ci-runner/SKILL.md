---
name: ci-runner
description: Dispatches and validates a GitHub Actions workflow end-to-end. Used for the final ci-end-to-end-run feature — triggers debug-emulator.yml, ci.yml, and build-apk.yml on the mission branch, watches to completion, downloads artifacts, and inspects them for evidence that the biometric onboarding flow reached the main wallet.
---

# CI Runner

You are a specialized worker that executes and validates CI-driven end-to-end verification for the biometric-vault mission. You do not write app code. You drive GitHub Actions via `gh` CLI and analyze the resulting artifacts.

## Required skills (read in order at session start)

1. `mission-worker-base` — base setup (read `mission.md`, `AGENTS.md`, run init).
2. This skill — CI dispatch + artifact analysis procedure.

## Context you must load

- `mission.md` — mission goal
- `AGENTS.md` — boundaries (especially the CI validation guidance)
- `validation-contract.md` — all VAL-CI-\* assertions (semantic pass/fail conditions, required evidence)
- `.factory/library/user-testing.md` — CI emulator surface details
- `scripts/run-ci-emulator.sh` — the dispatch wrapper (must already exist; feature `run-ci-emulator-wrapper` adds it)
- `scripts/emulator-debug-flow.py` — the flow script whose screenshots/dumps you inspect
- `.github/workflows/debug-emulator.yml`, `ci.yml`, `build-apk.yml` — the workflows under validation

## Core principles

1. **Never retry blindly.** If a run fails, download artifacts, diagnose, and return a root-cause summary. Do not re-dispatch the same workflow unchanged.
2. **All assertions have evidence.** For each VAL-CI-\* assertion in your feature's `fulfills`, explicitly name the artifact / grep / gh-api output that proves it and include that in your handoff.
3. **Do not commit or push app code.** Your role is verification. If a fix is needed, surface it as a `discoveredIssue` for the orchestrator to schedule.
4. **Mission branch only.** Operate only on the active mission branch. Do not touch `master`.

## Work procedure

### 1. Preflight

- Confirm `gh auth status` is authenticated with `repo` scope.
- Confirm the mission branch has all prior features merged (no uncommitted changes unrelated to your feature).
- Confirm `scripts/run-ci-emulator.sh` exists and is executable; confirm `scripts/emulator-debug-flow.py` parses (`python3 -m py_compile`).
- Note the current commit sha (`git rev-parse HEAD`) — you'll match this against `github.sha` in the artifact name.

### 2. Dispatch debug-emulator.yml

Prefer the wrapper:

```bash
bash scripts/run-ci-emulator.sh
```

If the wrapper doesn't exist yet, fall back to:

```bash
git push -u origin <mission-branch>
gh workflow run debug-emulator.yml --ref <mission-branch>
gh run watch <run-id>
```

Capture the run ID and run URL. The wrapper should print both.

### 3. Validate workflow conclusion

```bash
gh run view <run-id> --json status,conclusion,url,headSha
```

- `conclusion` must be `success`.
- `headSha` must match the mission branch tip.
- If `conclusion: failure` (or `cancelled`), proceed to artifact analysis anyway — the artifacts often contain the actual failure cause. Then return a root-cause handoff without claiming assertion fulfillment.

### 4. Download artifacts

```bash
mkdir -p /tmp/ci-artifacts
gh run download <run-id> -D /tmp/ci-artifacts/
ls -la /tmp/ci-artifacts/
```

The artifact (name `emulator-debug-<sha>`) should contain, at minimum:
- `logcat-full.txt`
- `logcat-rn.txt`
- `logcat-startup.txt`
- `emulator-ui-artifacts/` directory with:
  - `welcome.png`
  - `biometric-setup.png`
  - `biometric-prompt.png`
  - `recovery-phrase.png`
  - `main-wallet.png`
  - `relaunch-unlock-prompt.png`
  - `after-relaunch.png`
  - matching `*.xml` (uiautomator dumps) for screens where the flow script dumps them

### 5. Validate artifacts

Run each check and note outcomes:

- **PNG integrity:**
  ```bash
  file /tmp/ci-artifacts/emulator-ui-artifacts/*.png
  ```
  Every listed PNG must be reported as `PNG image data`.

- **Wallet reached:** Either OCR (if `tesseract` is available) or structural assertion against the matching `window_dump.xml`:
  ```bash
  rg -l 'text="Identities"' /tmp/ci-artifacts/emulator-ui-artifacts/*.xml
  ```
  Expect hits for `main-wallet.xml` and `after-relaunch.xml` (or the next-closest dump captured by the flow script).

- **No fatal errors in RN logs:**
  ```bash
  rg -i 'FATAL|unhandled.?promise|AndroidRuntime:.*E' /tmp/ci-artifacts/logcat-rn.txt
  ```
  Any match tied to `vault`, `biometric`, `Keystore`, `enbox`, `HdIdentityVault`, or `JWE` is a failure. Unrelated system noise is fine.

- **No PIN-era leakage:**
  ```bash
  rg -F -e 'Create a PIN' -e 'Confirm your PIN' -e 'Set PIN' -e 'Unlock wallet' -e 'Wallet vault could not be opened with this PIN.' /tmp/ci-artifacts/logcat-*.txt /tmp/ci-artifacts/emulator-ui-artifacts/*.xml
  ```
  Expect zero matches.

- **No mnemonic sub-sequences:** The BIP-39 wordlist is deterministic. Either run a small script that tokenizes each logcat line and checks for ≥3 consecutive BIP-39 words, or (simpler) confirm no 24-item space-separated string of lowercase alphabetic tokens of length 3-8 appears:
  ```bash
  rg -n '(\b[a-z]{3,8}\b[[:space:]]+){23}\b[a-z]{3,8}\b' /tmp/ci-artifacts/logcat-*.txt
  ```

- **No long hex blobs (heuristic for leaked secret/seed):**
  ```bash
  rg -n '\b[0-9a-f]{40,}\b' /tmp/ci-artifacts/logcat-*.txt
  ```
  Expect zero matches.

- **Workflow stdout sanitization:** Pull the gh logs for the run and run the same PIN / mnemonic / hex greps:
  ```bash
  gh run view <run-id> --log > /tmp/ci-artifacts/workflow-log.txt
  rg -F -e 'Create a PIN' -e 'Confirm your PIN' /tmp/ci-artifacts/workflow-log.txt
  rg -n '\b[0-9a-f]{40,}\b' /tmp/ci-artifacts/workflow-log.txt
  ```

### 6. Validate sibling workflows

```bash
gh run list --workflow=ci.yml --branch <mission-branch> --limit 1 --json conclusion,headSha,url
gh run list --workflow=build-apk.yml --branch <mission-branch> --limit 1 --json conclusion,headSha,url
```

Both must have `conclusion: success` on a sha at or newer than your feature's commit. If they haven't run yet, dispatch them:

```bash
gh workflow run ci.yml --ref <mission-branch>
gh workflow run build-apk.yml --ref <mission-branch>
gh run watch <id>
```

### 7. Update `features.json`

Mark your feature `completed` only if ALL the above checks pass.

### 8. Produce handoff

Return a handoff with this shape:

```json
{
  "successState": "success" | "partial" | "failure",
  "featureId": "ci-end-to-end-run",
  "summary": "1-3 sentences on the runs dispatched and their outcomes",
  "assertionsFulfilled": ["VAL-CI-..."],
  "assertionsNotYetFulfilled": [
    { "id": "VAL-CI-NNN", "reason": "...", "suggestedNextStep": "..." }
  ],
  "ciRuns": [
    {
      "workflow": "debug-emulator.yml",
      "runId": "<id>",
      "url": "<gh run url>",
      "conclusion": "success|failure|cancelled",
      "headSha": "<sha>"
    },
    { "workflow": "ci.yml", "runId": "...", "url": "...", "conclusion": "...", "headSha": "..." },
    { "workflow": "build-apk.yml", "runId": "...", "url": "...", "conclusion": "...", "headSha": "..." }
  ],
  "artifactFindings": {
    "pngsPresent": ["welcome.png","biometric-setup.png","biometric-prompt.png","recovery-phrase.png","main-wallet.png","relaunch-unlock-prompt.png","after-relaunch.png"],
    "pngsMissing": [],
    "walletReached": true,
    "walletReachedEvidence": "rg 'text=\"Identities\"' main-wallet.xml → 1 match; after-relaunch.xml → 1 match",
    "fatalLogLines": [],
    "pinStringMatches": [],
    "mnemonicMatches": [],
    "hexBlobMatches": []
  },
  "discoveredIssues": [ ... ],
  "whatWasLeftUndone": [ ... ],
  "returnToOrchestrator": true | false,
  "notes": "..."
}
```

Rules:

- If any artifact check fails, `successState` MUST be `failure` or `partial`. Never claim `success` with pending or negative evidence.
- If CI was red, still download artifacts and produce a detailed root-cause `discoveredIssues` entry so the orchestrator can create a fix feature.
- If a sibling workflow (`ci.yml`, `build-apk.yml`) is on an older sha, say so — do not assume freshness.
- Never dismiss unexplained leakage matches. If a hex blob appears and you cannot explain it, report it as blocking.

## Failure modes to watch for

- `reactivecircus/android-emulator-runner@v2` occasionally fails on boot with "emulator could not be started". This is infrastructure-level — retry ONCE with the same sha before concluding.
- `adb -e emu finger touch 1` is a no-op if no fingerprint is enrolled. If `biometric-prompt.png` shows the system prompt but `main-wallet.png` is a black screen, the enrollment step in `emulator-debug-flow.py` regressed. Surface this as a blocking issue against the script.
- `uiautomator dump` can deadlock on animations. The flow script should `disable-animations: true` on the runner. If dumps are missing, that's a script issue.
- Artifact naming: if the artifact is named something other than `emulator-debug-<sha>`, `VAL-CI-033` fails — report.
