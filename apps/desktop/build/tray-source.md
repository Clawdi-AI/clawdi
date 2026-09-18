The tray PNGs are derived from apps/web/public/clawdi-logo-transparent.png.
Remove the red background by projecting each pixel onto the original red/cream
palette, use the cream coverage as alpha, and set RGB to black for macOS template
rendering. Crop to the original artwork's alpha bounds (alpha > 32), preserve
aspect ratio, and center in a 14/28px square with 2/4px transparent padding for
the 18/36px exports. No paths or features are redrawn. The full-resolution
tray-official-template.png remains unchanged as the source for both exports.

Windows and Linux use the same full-resolution official alpha, colored with
`#ca3d33`, the most frequent opaque red in the original logo. No background or
new paths are added. Crop with the same alpha > 32 bounds, preserve aspect ratio
with Lanczos3 scaling, then center on a transparent canvas:

| Asset | Canvas | Artwork box | Padding |
| --- | --- | --- | --- |
| trayWindows.png / trayWindows@2x.png | 16 / 32 px | 14 / 28 px | 1 / 2 px |
| trayLinux.png / trayLinux@2x.png | 22 / 44 px | 18 / 36 px | 2 / 4 px |

Electron loads the paired `@2x` PNG representation. macOS retains its existing
18/36 px black template assets and `setTemplateImage(true)`. The Desktop build
checks PNG headers/dimensions and copies all six runtime assets into `dist`.
