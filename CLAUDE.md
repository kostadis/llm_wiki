# llm_wiki — branching & workflow

This file is the source of truth for how the local git branching works in this checkout.
It is a fork of `nashsu/llm_wiki` (upstream); remote `origin` points upstream, remote
`fork` points to `kostadis/llm_wiki`.

## Remotes

- `origin` → `https://github.com/nashsu/llm_wiki` (upstream, the project that owns mainline releases)
- `fork`  → `https://github.com/kostadis/llm_wiki` (personal fork; all of Kostadis's work lives here)

## Branches

- **`kostadis-dev`** — **[PERSONAL ROLLING DEV BRANCH]** the one you work on day to day
  and push to `fork`. This is the default checkout for this repo. It is kept rebased on
  top of the current upstream release (`v0.6.7` / origin/main) so it contains both the
  full upstream history and all of Kostadis's custom work. Any PR/feature you want to
  land upstream should be branched *from* `kostadis-dev`, then opened against `origin/main`.

- **`dedup-embeddings-turbovecdb`** — feature branch for the embedding-based duplicate
  detection (turbovecdb). Currently identical to `kostadis-dev`; kept separate so it can
  be opened as a clean PR against upstream without carrying unrelated dev work.

## Working rule

- Always `git checkout kostadis-dev` before starting work.
- Commit and push to `kostadis-dev` → `fork` as you go (`git push fork kostadis-dev`).
- To keep `kostadis-dev` current with upstream, rebase it onto `origin/main`
  (`git fetch origin && git rebase origin/main`). Prefer rebase (not merge) so the
  branch history stays linear on top of upstream.
- When a feature is ready to share upstream: create a new branch off `kostadis-dev`,
  and open a PR from that branch against `nashsu/llm_wiki`'s main.
- Never force-push to a remote unless you are certain the only consumer is yourself
  (this is a personal fork — that's fine here).

## Backups

- `backup/`-prefixed branches preserve historical states before rebases
  (e.g. `backup/kostadis-dev-pre-v0.6.7`). Do not delete these casually; they are the
  safety net if a rebase goes wrong.

## Worktrees

- This repo uses git worktrees. `git worktree list` shows the current layout.
- The main worktree lives at `/home/kroussos/src/llmwiki/llm_wiki` and holds `kostadis-dev`.
- Worktrees have their own branch names (e.g. `wt-kostadis-dev`) and can point at older
  commits for historical reference; they are not part of the daily workflow.
