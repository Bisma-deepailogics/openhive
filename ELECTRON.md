# Orbit desktop installers

The Electron app is a secure desktop client for `https://www.openhivedemo.com`.
Backend credentials remain on the deployed server and are not copied into employee installers.

## Build and test

```bash
npm ci
npm run electron:dev
```

Build installers:

```bash
npm run electron:build:mac
npm run electron:build:win
```

Artifacts are written to `dist-electron/`:

- `Orbit-0.1.0-mac-arm64.dmg` for Apple Silicon Macs
- `Orbit-0.1.0-mac-x64.dmg` for Intel Macs
- `Orbit-0.1.0-win-x64.exe` for 64-bit Windows

These local builds are unsigned. Windows SmartScreen and macOS Gatekeeper can therefore show a
warning. For warning-free company distribution, configure an Apple Developer ID certificate and
a Windows code-signing certificate in CI before release.

Set `ORBIT_URL` when launching Electron to test another deployment:

```bash
ORBIT_URL=http://localhost:3000 npm run electron:dev
```
