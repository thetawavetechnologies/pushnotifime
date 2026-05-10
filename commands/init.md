---
name: init
description: Bootstrap PushNotifi in the current project — install the pushnotifime SDK, write .env.example with the required keys, and print the dashboard URL for the user to fetch their values.
---

# /pushnotifi init

Bootstrap PushNotifi in the current project. Idempotent — safe to run more than once.

## Steps (execute in order)

1. **Detect package manager.** Check, in order: `pnpm-lock.yaml` → use `pnpm`. `yarn.lock` → use `yarn`. `package-lock.json` → use `npm`. Otherwise default to `npm`. Do not change the lockfile format.

2. **Verify Node version.** Run `node --version`. If the major version is < 18, stop and tell the user: "PushNotifi SDK requires Node 18+ for global fetch. Upgrade Node before continuing."

3. **Install the SDK.** Run the install with the detected package manager:
   - `npm install pushnotifime`
   - `pnpm add pushnotifime`
   - `yarn add pushnotifime`

4. **Write `.env.example`.** Append (do not overwrite — read the existing file first and only add missing keys) the following lines:

   ```env
   # PushNotifi.me — get these from https://pushnotifi.me/dashboard
   PUSHNOTIFI_USER_KEY=
   PUSHNOTIFI_GROUP_KEY=
   # Optional — omit to use the account default application
   # PUSHNOTIFI_APPLICATION_KEY=
   # Optional — per-user inbound webhook token (shell/CI shortcut)
   # PUSHNOTIFI_WEBHOOK_TOKEN=
   ```

5. **Update `.gitignore`.** If `.env` is not already ignored, append `.env` and `.env.*` plus a `!.env.example` exception. Do not duplicate existing patterns.

6. **Print next-step instructions to the user**, exactly:

   > PushNotifi installed.
   >
   > 1. Open https://pushnotifi.me/dashboard and copy your API key into `PUSHNOTIFI_USER_KEY`.
   > 2. Create or pick a group and copy its `g…` send-to key into `PUSHNOTIFI_GROUP_KEY`.
   > 3. Run `/pushnotifi test` to send a test notification to your phone.

## Failure modes the command must handle

- **No `package.json` in cwd:** stop and tell the user "/pushnotifi init must be run at the root of a Node project (no package.json found)." Do not create one.
- **Network failure during install:** report the package manager's exit code and stderr verbatim; do not retry silently.
- **`.env.example` write permission denied:** report the path and the OS error; do not attempt sudo.

## What this command does NOT do

- Never reads or writes `.env` (only `.env.example`).
- Never sends a real notification (that is `/pushnotifi test`).
- Never logs or echoes any environment variable values.
