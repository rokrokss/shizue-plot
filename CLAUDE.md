@AGENTS.md

## Claude Code

- Before you spawn subagents for implementation, move the lead session into a
  worktree with EnterWorktree. Subagents inherit its directory. A subagent
  that calls EnterWorktree from the repo root is rejected. When a subagent needs
  its own isolation, spawn it with the Agent tool's `isolation: "worktree"`.
  Use that only when parallel tasks would conflict over the same files, because
  changes spread across worktrees are tedious to gather.
- Worktrees branch from local HEAD (`worktree.baseRef: "head"`), so work that
  isn't committed in main isn't there. Commit first if the task depends on it.
  Read main's live state through absolute paths into the main checkout.
- Run long commands with `run_in_background` and wait for the completion notice.
- Run at most two subagents at a time, and tell each one not to spawn its own.
  The machine ran out of memory with eight.
