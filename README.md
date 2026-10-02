# Music Bot (private, free-tier friendly)

discord.js v14 + Shoukaku (Lavalink v4), CommonJS.
Audio is done by public Lavalink nodes.

## Features
- Prefix, slash, and allowed no-prefix commands
- Owner grants no-prefix with /np add @user
- Components V2 now-playing controls
- Queue, loop, shuffle, volume, seek and moderation-style controls
- Firestore settings persistence
- Multi-node failover
- Track source failover
- Auto-leave when alone or queue is empty

## Setup
1. Enable Message Content Intent in the Discord Developer Portal.
2. Copy .env.example to .env and fill in DISCORD_TOKEN, OWNER_ID and FIREBASE_KEY.
3. Run npm install, then npm start.

## Render
Build: npm install
Start: node index.js
Add the environment variables from .env.example.
