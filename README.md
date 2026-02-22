# Punkin Pi

An AI coding agent with DCP (Dynamic Compaction Protocol) for context management.

## Packages

| Package | Description |
|---------|-------------|
| **[@punkin-pi/ai](packages/ai)** | Unified multi-provider LLM API |
| **[@punkin-pi/agent-core](packages/agent)** | Agent runtime with tool calling |
| **[@punkin-pi/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@punkin-pi/mom](packages/mom)** | Slack bot delegation |
| **[@punkin-pi/tui](packages/tui)** | Terminal UI library |
| **[@punkin-pi/web-ui](packages/web-ui)** | Web components for AI chat |
| **[@punkin-pi/pods](packages/pods)** | vLLM deployment CLI |

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# From repo
./punkin-test.sh

# Or after build
./builds/punkin
```

## Development

```bash
npm run build        # Build all packages
npm run check        # Lint, format, type check
./build-local.sh     # Build standalone binary to builds/
```

## Config

Config lives in `~/.punkin/agent/`:
- `AGENTS.md` — agent instructions
- `skills/` — skill definitions
- `settings.json` — user settings

## DCP

See [dcp/DESIGN.md](dcp/DESIGN.md) for the Dynamic Compaction Protocol spec.

## License

MIT
