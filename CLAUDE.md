# CLAUDE.md

Follow [AGENTS.md](./AGENTS.md). This file holds only what is specific to Claude Code (`claude`).

- Skills live in `.claude/skills/<name>/` only: Claude Code is the only writer here, and the Codex reviewer reads `AGENTS.md`, not skills.
- Use `.claude/skills/local-tool-safety` before local tool, Windows/WSL, connector, mail, cloud, SQL, or outbound work.
- Subagents: Sonnet by default, Opus only where judgment quality needs it, Haiku only for near-mechanical work under the AGENTS.md rule. The main loop reviews what they return.
