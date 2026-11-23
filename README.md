# Winamp Classic — 私人复刻版（kao）

基于 [rauchg/winamp-ui-sdk](https://github.com/rauchg/winamp-ui-sdk)（MIT，© 2026 Guillermo Rauch）的原版源码构建，视觉与交互与原版保持一致：银灰金属外壳、蓝色 LCD、File/Play/Options 菜单、圆形控制按钮、PL 播放列表、10 段 EQ 与频谱。

与上游的差异（仅功能层，不动皮肤）：
- 删除了上游 `public/tracks/` 的 5 首 Suno 演示歌曲（不在 MIT 许可内）；内置曲目改为一首由播放器实时合成的程序化演示曲（无音频文件）。
- 新增 IndexedDB 持久化：通过 Eject / File → Play File / 播放列表 +ADD / 拖拽导入的本地歌曲会存入浏览器 IndexedDB，刷新后自动恢复到播放列表。音频只存本地，不上传。
- 部署：Vercel（`vercel.json`：build = `npm run build`，输出 `public/`）。

以下为上游 README 原文：

---

# UI SDK + Winamp

Winamp 5 Modern recreated in pure **Web Components** (`light DOM`, zero framework runtime) with [`@ui-sdk/web`](https://ui-sdk.dev/docs/web-components) and [`@ui-sdk/core`](https://github.com/vercel-labs/ui), featuring a live 10-band Web Audio BiquadFilter equalizer, 60fps spectrum/oscilloscope LCD, elastic Full View, responsive mobile mode, WebMCP agent control, and 5 original Suno v6 tracks.

Live: https://winamp-ui-sdk.vercel.app

## UI SDK Primitives & Behaviors Used

| Primitive / Behavior | Where It's Used | What UI SDK Handles |
| --- | --- | --- |
| `definePrimitive` + `createParts` | `<winamp-window>`, `<winamp-titlebar>`, `<winamp-resize-handle>`, `<winamp-lcd>` | Custom light-DOM Web Components with reflected properties, ARIA roles, and automatic agent registration. |
| `createResize` + `live()` | 8 compass resize handles (`se` 5-line grip + edges/corners) & titlebar `"move"` | Zero-snap 2D elastic resize, titlebar dragging, arrow-key resize, `Escape` cancel, and 120Hz CSS variable streaming. |
| `createChange` + `createCommit` | Window state, Seek bar, Master Volume, Preamp & 10 EQ faders | Splits live `valuechange` scrubbing/DSP updates from drag-end `valuecommit` with input-source tracking. |
| `<ui-menubar>` + `<ui-menu>` | `File \| Play \| Options \| View \| Help` menus, checkboxes & radios | `createPopup` top-layer `:popover-open` positioning, `createSafeArea` hover-switching, `createTypeahead`, and dismissal. |
| `<ui-slider>` + `bindDrag` | Elastic Seek bar, Master Volume, Preamp, 10 EQ bands & LCD marquee | Document-tracked pointer drag (`buttons===0` hover recovery, `Escape` cancel, `rAF` coalescing) + native `<input type="range">` keyboard/AT support. |
| `<ui-toolbar>` + `<ui-button>` | `Prev`, `Play`, `Pause`, `Stop`, `Next`, `Eject` & window controls | `createRovingFocus` single-tab-stop arrow navigation over native `<button>` elements (`wrappedButton`). |
| `<ui-toggle>` + `<ui-toggle-group>` | `Repeat` (+ LED), `Shuffle 123` (+ LED), `Mute`, `CONFIG`, `EQ ON/AUTO`, `PL`/`ML` | Synced `aria-pressed` and `[data-pressed]` state hooks across standalone and grouped toggles. |
| `<ui-tabs>` | Config deck (`Equalizer \| Color Themes \| Agent`) & Workspace (`ML \| PL \| Lyrics \| AVS`) | Accessible tablist roving focus, panel switching, and `reveals: true` off-screen agent discovery. |
| `registerShortcut` (`shortcuts`) | `Z X C V B` transport, `R` Repeat, `S` Shuffle, `M` Mute, `⌘F` Full View | Scoped hotkeys that automatically stay inert inside search `<input>` fields. |
| `<ui-overlay-host>` + `toast()` | Status & `agent.act()` notifications | Zero-provider top-layer toast queue (`createOverlays`) with polite screen-reader announcements. |
| `createAgent` + `registerTools` | `window.winampAgent` + WebMCP | Exposes all 22+ components to `snapshot()`, `query()`, and `act()` with zero DOM scraping. |

## Development

```bash
pnpm install
pnpm run dev
pnpm run typecheck
pnpm run build
```

## License & Notes

- Source code is licensed under the [MIT License](./LICENSE).
- Bundled audio tracks in `public/tracks/` were generated on Suno (Premier tier, provenance tags preserved) and are provided for demo playback rather than under the MIT code license.
- Independent UI SDK technical demo; not affiliated with or endorsed by Winamp or Llama Group.
