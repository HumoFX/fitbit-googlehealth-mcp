# Logo assets

Three marks in the same teal (`#0E7C7B`), white knockout, 512×512 with a
squircle corner radius:

| File | Mark |
|---|---|
| `logo-bridge.svg` | pulse spanning two nodes — health data crossing a bridge, the thing this server actually is |
| `logo-pulse.svg` | plain heartbeat line |
| `logo-heart.svg` | heart with the pulse cut through it |

Each ships as SVG plus rasterised PNGs: `-512.png` for READMEs and social
cards, `-120.png` for the Google OAuth consent screen, which requires a
square image at exactly that size.

Regenerate the PNGs after editing an SVG:

```bash
sips -s format png --resampleWidth 512 assets/logo-bridge.svg --out assets/logo-bridge-512.png
sips -s format png --resampleWidth 120 assets/logo-bridge.svg --out assets/logo-bridge-120.png
```
