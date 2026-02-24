# Punkin Pi — Documentation Index

## Overview

Punkin Pi is a coding agent that manages its own context. The core ideas:

1. **Context is a program** — History of manipulations, not just a log
2. **Contractions are invertible** — Compress context, keep full content in store
3. **Codata I/O** — Tool results are handles (thunks), observe what you need
4. **Visible reasoning** — Model sees its own chain of thought

## Specs

Technical specifications for the architecture. Start here to understand the design.

| Spec | What It Covers |
|------|----------------|
| [specs/INDEX.md](specs/INDEX.md) | Specs overview and key concepts |
| [specs/design.md](specs/design.md) | Master design doc — context compaction, handles, invertibility |
| [specs/context-dsl.md](specs/context-dsl.md) | Context manipulation as versioned DSL program |
| [specs/codata-semantics.md](specs/codata-semantics.md) | Lazy I/O — observations not values |
| [specs/kage-no-bushin.md](specs/kage-no-bushin.md) | Shadow clones, hypotheticals, transactions |
| [specs/tool-interface-design.md](specs/tool-interface-design.md) | Intent-based, async, reference-based tools |
| [specs/metacog-hooks.md](specs/metacog-hooks.md) | Agent lifecycle hooks |
| [specs/shell-hooks.md](specs/shell-hooks.md) | Shell integration hooks |

## Docs

General documentation and reference material.

| Doc | What It Covers |
|-----|----------------|
| [docs/handle-tools.md](docs/handle-tools.md) | Handle tool usage guide |
| [docs/tool-type-signatures.md](docs/tool-type-signatures.md) | Tool type signatures |
| [docs/handoffs/](docs/handoffs/) | Session handoff documents |

## User Docs

User-facing documentation for the built application.

| Doc | What It Covers |
|-----|----------------|
| [builds/README.md](builds/README.md) | Main user documentation |
| [builds/docs/extensions.md](builds/docs/extensions.md) | Writing extensions |
| [builds/docs/themes.md](builds/docs/themes.md) | Themes |
| [builds/docs/skills.md](builds/docs/skills.md) | Skills |
| [builds/docs/keybindings.md](builds/docs/keybindings.md) | Keybindings |

## Packages

| Package | Description |
|---------|-------------|
| [packages/ai](packages/ai) | Multi-provider LLM API |
| [packages/agent](packages/agent) | Agent runtime |
| [packages/coding-agent](packages/coding-agent) | CLI coding agent |
| [packages/tui](packages/tui) | Terminal UI components |
| [packages/web-ui](packages/web-ui) | Web UI components |
| [packages/mom](packages/mom) | Slack bot |
| [packages/pods](packages/pods) | vLLM deployment |

## Key Files

| File | Purpose |
|------|---------|
| `~/.agent/agent.md` | User agent instructions (authoritative if present) |
| `~/.agent/skills/` | User skills |
| `~/.punkin/agent/sessions/` | Session storage |
| `build-local.sh` | Build standalone binary |

## Architecture Summary

```
User input
    │
    ▼
┌─────────────────────────────────────────────┐
│  Context (DSL program evaluation result)    │
│                                             │
│  inject → inject → contract → inject → ...  │
│                       │                     │
│                       ▼                     │
│              ┌─────────────┐                │
│              │    Store    │ (full content) │
│              └─────────────┘                │
└─────────────────────────────────────────────┘
    │
    ▼
Agent response (with visible reasoning)
```

- **Inject**: Add content to context
- **Contract**: Compress to skeletal form, store full content (invertible)
- **Expand**: Restore from store when needed
- **Branch/Merge**: Fork context for speculation, merge back

Contractions preserve *adequacy* — reasoning capability, not necessarily all information. But full content is always recoverable from the store.
