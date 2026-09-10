The tray PNGs are derived from apps/web/public/clawdi-logo-transparent.png.
Remove the red background by projecting each pixel onto the original red/cream
palette, use the cream coverage as alpha, and set RGB to black for macOS template
rendering. Crop to the original artwork's alpha bounds (alpha > 32), preserve
aspect ratio, and center in a 14/28px square with 2/4px transparent padding for
the 18/36px exports. No paths or features are redrawn. The full-resolution
tray-official-template.png remains unchanged as the source for both exports.
