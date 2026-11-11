# How Beluga works

Beluga is a core and the Mac app on top of it. The core (rooms, projects, agents, terminals) runs as a background daemon that the app bundles and talks to over a local WebSocket (`127.0.0.1`, a token in `~/.beluga/daemon.json` that only you can read). The app gets the state and a stream of changes, and calls one list of actions ([src/ipc/api.ts](../src/ipc/api.ts)). [docs/parity.md](parity.md) lists every action and where the app offers it.

```
 your computer                                       bob's computer
┌──────────────────────────────┐                   ┌──────────────────────────────┐
│ beluga                         │   encrypted       │ beluga                         │
│  projects · chat · files      │◄─── frames ──────►│  projects · chat · files      │
│  your agent (your login)      │ direct (P2P) or   │  bob's agent (bob's login)    │
│                               │ via Cloudflare    │                               │
│  room hub (relay)             │                   │                               │
└──────────────────────────────┘                   └──────────────────────────────┘
```

- **Each agent runs at home.** Today that is Claude: the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) drives each person's own Claude Code, with their own subscription and permissions. Workspace conversations stay on your computer.
- **No window needed.** The same daemon runs on a server, a home PC or a Mac mini with no app (`beluga setup`, then a systemd or launchd service). Phones reach it with their own device keys, as they reach a Mac. Browsers open the whole app from the daemon's web port (`127.0.0.1:7777`), through Tailscale, an SSH tunnel or a public link. The daemon's token never leaves the computer: each browser is let in once by a one-use join link and gets its own **web session**, a cookie you can revoke at any time (`beluga web sessions`). How to set it up: [docs/headless.md](headless.md); how the web port and its sessions work: [docs/web.md](web.md).
- **Room hub.** When you invite people, the host runs a small relay. Friends connect straight to it, peer to peer (Hyperswarm DHT with UDP hole-punching and Noise encryption). If their network blocks that, they fall back to a free Cloudflare quick tunnel that the invite also names. See [docs/p2p.md](p2p.md). The topology is a star through the host, not a mesh. The relay checks the invite secret, forwards messages, and keeps a short history for latecomers.
- **Sharing with friends, nobody hosting.** With the Beluga network on, a project you share with a friend goes over your Mac's own Noise link to theirs ([docs/network.md](network.md), "Sharing with friends"). It shows in their Projects with your avatar. Its worktrees run on your Mac, and your agent does the work; their messages to it wait in an outbox while your Mac is offline. Folders you share with friends show in their Files. Rooms still share the old way with people in them.
- **External agents.** Other agents (a Claude Code in your terminal, a hosted agent) control Beluga through an MCP server on its own port, off until you turn it on. Local clients use `127.0.0.1:7778`. Remote ones reach it only over HTTPS, through Tailscale Serve or a Cloudflare quick tunnel. Each is you on another screen, like the phone or a browser, with its own grant, name, Stop and Revoke. See [docs/external-agents.md](external-agents.md).
- **End-to-end encryption.** Every frame is sealed with AES-256-GCM, using keys derived from the invite secret with HKDF. Neither the tunnel nor the relay can read or forge messages. Direct connections are also encrypted underneath with Noise (forward secret), pinned to the host's key from the invite.
- **Limits.**
  - Up to 16 people per room and 120 messages per second per connection.
  - Messages up to 1 MB. Files are sent in 256 KB encrypted chunks, up to 200 MB.
  - Cloudflare quick tunnels have no uptime guarantee. Use ngrok or your own network if you need one.
- **Images** are decoded in a background thread and shrunk before they're drawn, so big photos never freeze the screen.
