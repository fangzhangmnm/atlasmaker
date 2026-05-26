# AtlasMaker

> An infinite reference board where viewports double as texture atlases.
> Built for 3D artists who are tired of bouncing between PureRef, an image editor, and a file manager just to update one texture.

- **🔗 Try it**: https://fangzhangmnm.github.io/atlasmaker/
- **📦 Source**: https://github.com/fangzhangmnm/atlasmaker

## The idea

You know the drill. You're texturing in Blender. You alt-tab to PureRef to check the reference. You alt-tab again to Photoshop to crop something. You save out `tmp_file.png`. You alt-tab to Explorer. You re-import. You repeat this fifty times a day.

AtlasMaker collapses that whole loop into one window:

- An **infinite canvas** for your reference — paste screenshots, drag images around, zoom forever.
- A **viewport** is a framed rectangle on that same canvas. It has its own output resolution and pixel-perfect / smooth filtering. Whatever you place under a viewport *is* its content.
- Hit export, and the viewport gives you a clean PNG at the resolution you asked for — ready to drop into Blender as a texture.

Reference and texture stop being two different things in two different apps. They live on the same board, and you compose them like you compose a moodboard.

## What works today

This is an early build. Today you can:

- Paste images from the clipboard (screenshots, browser drag, anything in your OS paste buffer).
- Pan and zoom the canvas — middle-mouse / space to drag, wheel to zoom.
- Drag images to arrange them.
- Drop a viewport with the rectangle tool, set its output resolution and interpolation mode.
- Export a viewport to PNG.
- Light / dark theme. Works offline (PWA, installable).

## What's coming

The viewport idea has plenty of room. On the roadmap:

- **Direct push to Blender** — a tiny Blender add-on will let AtlasMaker update a texture in your open `.blend` with one click. No file manager, no re-import.
- **Crop, perspective correction, color adjust** on individual images, non-destructively.
- **Edge / corner snapping** between viewports for tileable atlases.
- **OneDrive sync** — your board follows you between PC, iPad, and headset.
- **Persistence** — right now a refresh wipes the canvas. (Treat it as a scratchpad for the moment.)

## Controls

| | |
| - | - |
| Paste image | `Ctrl+V` |
| Move object | Left-drag |
| Resize | Drag any of 8 handles — corners keep aspect, edges stretch |
| Rotate | Drag the round handle above the selection (hold `Shift` to snap 15°) |
| Multi-select | Drag a marquee on empty board; `Shift+click` to toggle |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) |
| Duplicate | `Ctrl+D` |
| Z-order | `Ctrl+]` / `Ctrl+[` step; add `Shift` for top / bottom |
| Pan | Middle-drag, or hold `Space` and drag, or `H` then drag |
| Zoom | Mouse wheel (cursor is the anchor; hold `Ctrl` for coarser) |
| New viewport | `R` then drag a rectangle (or click for a default 512×512) |
| Fit all to screen | `0` |
| Delete selection | `X`, `Delete`, or `Backspace` |
| Deselect | `Esc` |

## Running locally

```bash
python -m http.server 8000
# open http://localhost:8000/
```

A static server is required — `file://` won't work (modules and the service worker need an origin).

## Family

AtlasMaker is part of a small family of art-tool PWAs aimed at killing the friction around texture painting in Blender. Its siblings include [WebPaint](https://github.com/fangzhangmnm/webpaint) (an iPad-first painting app) and a Blender add-on (coming) that listens for pushes from both of them.

---

Made with care by [fangzhangmnm](https://github.com/fangzhangmnm). Co-authored by Claude.
