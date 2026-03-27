# EleDrive

Electron + Vue 3 + Vite base framework (manually scaffolded).

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

Artifacts are output to `release/`.

## Structure

- `electron/main.mjs` - Electron main process
- `electron/preload.mjs` - Preload bridge
- `src/` - Vue renderer app

## Next Steps

Implement driver package download, extract, and local installer flow.
