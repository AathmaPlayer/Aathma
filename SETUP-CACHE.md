# better-sqlite3 setup for Aathma Player

## Install karo

```bash
npm install better-sqlite3
npm install --save-dev electron-rebuild
```

## Electron ke liye rebuild karo (REQUIRED)

better-sqlite3 ek native module hai — Electron ke specific Node version ke
against compile karna padta hai. Yeh step skip mat karo:

```bash
npx electron-rebuild -f -w better-sqlite3
```

## package.json mein add karo (automatic rebuild on npm install)

```json
{
  "scripts": {
    "start": "electron .",
    "rebuild": "electron-rebuild -f -w better-sqlite3",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  }
}
```

## .gitignore

```
.aathma-cache/
node_modules/
```

## Verify karo

App start karne ke baad console mein yeh dikhna chahiye:
```
[cache] SQLite ready → D:\Player\Git\Aathma\.aathma-cache\aathma-meta.db
[cache] 393 hits / 0 misses / 393 total   ← 2nd launch pe
```

## Troubleshoot

Agar "NODE_MODULE_VERSION mismatch" error aaye:
```bash
npx electron-rebuild -f -w better-sqlite3 --force
```

Agar rebuild fail ho (Python/MSVC missing):
```bash
npm install --global --production windows-build-tools
npx electron-rebuild -f -w better-sqlite3
```
