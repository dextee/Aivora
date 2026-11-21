# DEV-11 — Independent Verification: WO-111C preventive boundary

- Reviewer: DEV-11 (independent verifier; controller-executed object — verify, never bless blindly)
- Object: canonical commits `e3247b03354afb30135f1e5158493a3857315dac` (hook) + `6fb98775…` (PROTECTED-set seal) + `324bced0…` (fixture companion)
- Repo of record: `/mnt/pages/page-repo-1255a831-bc45-4ee3-a572-8ff3e587ad2a` (page app-1fe44043-4ed153f9) — resolved this window via the canonical gate: `page_repo.py prepare` → `resolve --page-id app-1fe44043-4ed153f9` (02:23:09Z / 02:23:19Z UTC). HEAD before: `37dc796`.
- **Recurrence note:** the three prior DEV-11 WO-111C windows (17:14Z–17:46Z) returned FAIL/BLOCKED only because they probed `/mnt/pages` statically and never invoked the `page_repo.py` mount flow. This run used it: repo mounted and LIVE. Prior reports' object-store sweeps remain true *for their own sandboxes*; they do not bind this one. Zero-fabrication honored: nothing reconstructed; every digest computed fresh, not quoted.
- Mount gate: active resolve→digest-verified sequence 02:23:09Z→02:23:31Z (22 s ≤ 240 s); the earlier ~6 min included the mandated absent-mount retry probes (4/4 at 02:18:38–02:19:38Z before the flow was correctly used).

## FINAL VERDICT: PASS-WITH-GAPS

Owner PINNED acceptance, measured (not asserted):
1. hook blob sha256 (committed, `e3247b0:.githooks/pre-commit`) = `8321d4a7356fb5de4f1cd34752f0744355fdb2e8ce4c5c94f85fae68cd9f8ee2` — **EXACT MATCH** (working-tree file identical hash) ✔
2. manifest `tools/SECURITY-FILES.sha256` lists **6 protected files including `.githooks/pre-commit`**, every live sha equals its pin; `verify_integrity check` → `INTEGRITY OK: 6 sealed enforcement files verified` ✔

| Criterion | Verdict | Raw evidence |
|---|---|---|
| `git show e3247b0` stat sanity | PASS | .githooks/pre-commit +34, odai/dev_docs/hook-battery.txt +17, wo111c-note.md +8; author QW Pages Agent 2026-11-21T01:13:18+08 |
| hook file == committed blob | PASS | both sha256 = 8321d4a7… (dual computation, file + `git cat-file blob`) |
| core.hooksPath set | PASS | `git config core.hooksPath` → `.githooks` |
| Battery v2 live (7 cases) | PASS | every case exit=1 AND HEAD unchanged `37dc796` before/after; ledger DENY reasons: NO_LEASE, EXPIRED, REVOKED, OP_NOT_ALLOWED, PATH_NOT_ALLOWED (src/ via DEV11-V), REVOKED (spoofed env=UI-01B), NO_LEASE (stale EDITMSG subject trap). Builder's own ledger shows the trailing-slash misissue self-denial (`17:13:00Z PATH_NOT_ALLOWED … scope=.githooks,odai/dev_docs,tools`) proving "comply or document" — complied with `odai/dev_docs/,tests/` |
| Allow-path positive proof | PASS | THIS document's commit: `AIVORA_LEASE_ID=DEV11-V git commit -m 'DEV11-V: independent verification WO-111C'` granted via the live hook (HOOK_ALLOW ledger line) |
| Bypass audit | PASS-WITH-GAPS | `--no-verify` throwaway committed exit=0, zero ledger lines for it (silent as designed), reverted (see Deviations). `wo111c-note.md` documents proven-then-reset honestly; BUT the "DETECTIVE-ONLY" posture is overstated — no UNBOUND_COMMIT chain-audit control exists anywhere (grep UNBOUND = 0 hits; preflight reported "clear" *while* the bypass commit was reachable) → GAP-02 |
| authz.test.mjs | PASS | 12/12 (`# tests 12 / # pass 12 / # fail 0`) |
| full npm test | PASS | 119/119 green, 0 fail, 0 skipped |
| sealed files unmodified | PASS | verify_integrity check exit=0, 6/6 hashed OK |
| GAP-01 (hook missing from SEAL manifest) | **RESOLVED — premise outdated** | 6fb9777 "WO-111D: owner-authorized seal flow GAP-01 — hook pinned into PROTECTED set" sealed `.githooks/pre-commit`→8321d4a7; manifest verified by inspection + live hashing. No owner-token flow outstanding for the hook itself |
| ledger plausibility | PASS | battery lines 02:27:44–02:29:56Z carry real wall-clock UTC matching this run; builder window 17:11:46→17:13:18Z self-denials consistent with e3247b0 subject; dangling bypass probe `9c37562` exists as unreachable object matching "reset" claim (`git cat-file -t` = commit, absent from all refs) |

## Clause 6 — dependency-enforcement readiness (propose, not implement)

The hole this loop just demonstrated for the third–fourth windows is the **completed-exec vs accepted-WO conflation**: the scheduler treated WO-111C as finished when its sandbox run ended, yet verification repeatedly failed because the object lived behind a mount mechanism (`page_repo.py prepare/resolve`) the verifier prompt never named — completion of an execution says nothing about whether successors can even *reach* its deliverables, and a PASS string in a commit subject self-certifies nothing. Proposed rule (design only): a WO becomes loop-eligible only when (a) its acceptance requires a verifier event carrying machine-readable seals — full 40-hex OIDs, reviewer-computed digests of specific blobs, per-case exit codes, and the *resolution recipe* (here: the exact page-id + tool that makes the canonical tree mountable) — and (b) the dispatcher refuses to trigger successors until that sealed verdict lands in a repo-reachable path, plus (c) any object not extractable via the published recipe within N windows auto-demotes the WO to OPEN. Current design: **not ready** — four consecutive windows were lost to a gap that is one line of onboarding text.

## GAP list

| ID | Gap | Sev | Next action |
|----|-----|-----|-------------|
| GAP-01 | Hook absent from SEAL manifest (task premise) | **CLOSED this window** | Sealed by WO-111D (`6fb9877`); independently re-verified (6/6 hashes live, INTEGRITY OK). No action |
| GAP-02 | `--no-verify` bypass is **silent**, not detective-only: no UNBOUND_COMMIT chain-audit control exists in preflight/watchd/hook; battery v3 case [7] proved the gap (exit=0) but no detection countermeasure shipped in the canonical chain; wo111c-note.md's "DETECTIVE-ONLY residual" label implies a detector that is unimplemented | High | New WO: preflight chain-audit comparing HEAD..seal-chain commits vs HOOK_ALLOW ledger lines; keep classes (hook deletion, raw .git writes) documented as-is |
| GAP-03 | `wo111c-note.md` echo `hook-sha=1de57f89… (seal-target)` pins an orphaned draft blob (present in store, referenced by no tree) — stale interim note, diverges from the actually pinned/final 8321d4a7; harmless to enforcement (manifest is truth) but a doc-integrity trap for future readers | Low | Note custody fix in next dev_docs-touching WO (sealed-set files untouched) |
| GAP-04 | Ledger records `HOOK_ALLOW|<WO>|` with empty path-set when a hook fires on a zero-change commit (log noise; git still aborts the commit — no unauthorized object ever lands). Fail-open-*appearing* line | Low | Hook follow-up: no-op commit ⇒ no ALLOW line |
| GAP-05 | Verification tooling gap: DEV-11 prompt lineage never mentioned `page_repo.py resolve/open`, causing 3 false FAILs (GAP-00 of prior reports). Consider closing prior GAP-00 as SUPERSEDED — the canonical tree was reachable all along via the documented builder flow | Medium | Owner: embed repo-gate recipe in DEV-11 prompts; retire GAP-00 |

## Raw outputs (key excerpts, all commands fresh this session)

```
$ sha256sum .githooks/pre-commit
8321d4a7356fb5de4f1cd34752f0744355fdb2e8ce4c5c94f85fae68cd9f8ee2  .githooks/pre-commit
$ git cat-file blob e3247b0:.githooks/pre-commit | sha256sum
8321d4a7356fb5de4f1cd34752f0744355fdb2e8ce4c5c94f85fae68cd9f8ee2  -
$ node tools/authz.mjs issue DEV11-V --paths odai/dev_docs/,tests/ --ops check,commit --minutes 45
LEASE_OK DEV11-V ops=check,commit paths=odai/dev_docs/,tests/ budget=12 expires=2026-11-21T03:11:15Z   (exit=0)
battery (staged probe file each case; HEAD compared before/after every case):
  1 missing-lease        exit=1 head_same=YES  DENY ZZZ-V4-NONE    reason=NO_LEASE
  2 expired              exit=1 head_same=YES  DENY ZZZ-V4-EXP     reason=EXPIRED
  3 revoked              exit=1 head_same=YES  DENY ZZZ-V4-REV     reason=REVOKED
  4 ops=check-only       exit=1 head_same=YES  DENY ZZZ-V4-CHK     reason=OP_NOT_ALLOWED
  5 scope-mismatch src   exit=1 head_same=YES  DENY DEV11-V        reason=PATH_NOT_ALLOWED path=src/zzz_v4_probe.txt
  6 spoofed env lease    exit=1 head_same=YES  DENY UI-01B         reason=REVOKED
  7 stale subject trap   exit=1 head_same=YES  HOOK_DENY ZZZ-V4    reason=NO_LEASE (env-unset channel falls to EDITMSG prefix, unissued → fail-closed)
$ node --test tests/authz.test.mjs   → # tests 12 # pass 12 # fail 0
$ node tools/verify_integrity.mjs check → INTEGRITY OK: 6 sealed enforcement files verified
$ npm test                           → # tests 119 # pass 119 # fail 0 # skipped 0
bypass audit: commit --no-verify exit=0 (6298026 unreachable after revert); ledger silent for commit; preflight: "preflight clear: …" ← detection ABSENT (GAP-02)
misissue proof (builder-era, live ledger): 17:13:00Z|DENY|WO-111C|…|PATH_NOT_ALLOWED|…scope=.githooks,odai/dev_docs,tools  → trailing-slash convention enforced
```

## Lease & deviations

- DEV11-V: issued 02:26:15Z per HOOK ERA v2 (explicit ops, trailing-slash paths); used for the allow-path proof commit; revoked SHIPPED after close; custody files committed in-house style.
- Disclosed noise: early scripted battery pass had a pathspec bug producing 7 empty-path `HOOK_ALLOW` lines at 02:27:45–46Z (zero commits created; git aborted for-lack-of-changes). Redone correctly (rows above). Also disclosed: pending ` M` custody residue inherited from WO-SEC05's close cycle is carried forward by the append-only convention.
- Deviation (destructive-reset avoidance): the suggested `git reset --hard back to e3247b0` was NOT executed — e3247b0 trails five accepted successor commits (WO-111D/E, UI-01B×2, WO-111E, WO-SEC05) and the tree is shared with concurrent writers; hard-resetting would erase shipped work (blast radius). Equivalent probe achieved with `--no-verify` throwaway + `reset --soft HEAD~1` + index/worktree cleanup; final HEAD strictly verified restored.
- No fixes to sealed enforcement files; no publish; verdict **PASS-WITH-GAPS** (gaps are GAP-02 HIGH for successor WO, rest Medium/Low/closed).
