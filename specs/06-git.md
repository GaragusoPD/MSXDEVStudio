# Spec 06 — Git Integration

**Phase:** 2 · **Depends on:** 01, 05 · **Suggested model:** Sonnet 5

## Goal

VS Code-style source control for the open project: status, stage, commit, branches,
diff, push/pull. Nothing exotic — no rebase UI, no submodules, no stash UI.

## Approach

Shell out to the system `git` binary from a main-process `GitService`
(`child_process.execFile`, cwd = project root, `--porcelain`/`-z` formats). Do NOT
use isomorphic-git or nodegit. If `git` is missing, the Git panel shows an install
hint and everything else still works.

IPC channels (extend `src/shared/ipc.ts`): `git:status`, `git:stage`, `git:unstage`,
`git:discard` (confirm dialog — destructive), `git:commit`, `git:log`,
`git:branches`, `git:checkout`, `git:createBranch`, `git:push`, `git:pull`,
`git:diff` (returns old/new file contents for a path), `git:init`, `git:clone`.
Push `git:changed` events by re-running status after each mutation and on `.git`
index changes (watch `.git/HEAD` and `.git/index` only).

## UI (side panel, "Git" activity)

- No repo → "Initialize repository" button (`git init` + write a starter
  `.gitignore` from the project template — Spec 03 defines it).
- Changes view: Staged / Changes groups, per-file stage/unstage/discard, commit
  message box + Commit button (Ctrl+Enter). Amend checkbox.
- Branch name in status bar (from Spec 01 placeholder) → click opens branch picker
  (switch / create). Ahead/behind arrows with push/pull buttons.
- Clicking a changed file opens a Monaco **diff editor** tab (registry entry
  `git-diff`, read-only original vs working copy).
- History: simple linear log list (subject, author, relative date), click shows the
  commit's diff summary. No graph rendering.

## Auth

Push/pull run with the user's ambient git config (ssh-agent, credential helpers).
Surface stderr in the Output panel on failure — do not build any credential UI.

## Acceptance

- In a repo with modified/untracked/staged files, panel matches `git status` exactly.
- Stage → commit → log shows the commit; push to a remote with working ssh keys
  succeeds; failure shows stderr, not a crash.
- Diff view matches `git diff` for the same file.
- Non-repo projects: no errors anywhere, just the init prompt.
