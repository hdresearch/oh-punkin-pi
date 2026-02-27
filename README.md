# Punkin Pi

A coding agent that manages its own context.

> **Versioning**: This fork uses [PVP](https://pvp.haskell.org/) (A.B.C.D) — A.B is major, C is minor, D is patch.

## What It Does

- **Handles**: Large outputs become references, not context bloat. Surgical access via `handle_lines`, `handle_grep`, etc.
- **Visible Reasoning**: Model sees its own chain of thought from prior turns. Sharper, more consistent.
- **Context as Program**: History of manipulations is a DSL. Contractions are invertible. Nothing is lost.
- **Codata I/O**: Tool results are observations, not values. Materialize what you need.

## Quick Start

```bash
npm install
npm run build
./builds/punkin
```

## Packages

| Package | Description |
|---------|-------------|
| [@punkin-pi/ai](packages/ai) | Multi-provider LLM API |
| [@punkin-pi/agent](packages/agent) | Agent runtime with tool calling |
| [@punkin-pi/coding-agent](packages/coding-agent) | Interactive coding agent CLI |
| [@punkin-pi/tui](packages/tui) | Terminal UI library |
| [@punkin-pi/web-ui](packages/web-ui) | Web components for AI chat |
| [@punkin-pi/mom](packages/mom) | Slack bot delegation |
| [@punkin-pi/pods](packages/pods) | vLLM deployment CLI |

## Documentation

See [INDEX.md](INDEX.md) for full documentation map.

- **[specs/](specs/)** — Technical specifications
- **[docs/](docs/)** — General documentation
- **[builds/docs/](builds/docs/)** — User-facing docs (extensions, themes, skills)

## Config

User config lives in `~/.agent/` (priority) or `~/.punkin/agent/`:

- `AGENTS.md` or `agent.md` — Agent instructions
- `skills/` — Skill definitions  
- `settings.toml` — User settings

## Development

```bash
npm run build        # Build all packages
npm run check        # Lint, format, type check
./build-local.sh     # Build standalone binary
```

## Testing

### One-shot / fast 1-turn testing

Use `--print` (`-p`) for a non-interactive single-turn run — no TUI, exits immediately after the response. Handy for quick stack verification:

```bash
node packages/coding-agent/dist/cli.js --print "say hi in exactly 5 words"
# or after installing:
punkin --print "say hi in exactly 5 words"
```

The full stack runs (settings load, prompt templates + hashes.toml, turn brackets, model call) and output goes straight to stdout. Fast feedback loop for testing config changes.

## License

MIT
