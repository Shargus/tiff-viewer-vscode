# TIFF Viewer VS Code

View **TIFF**, **BigTIFF** and **GeoTIFF** images directly in VS Code, including files far larger than memory, with band composites for multi-band imagery such as Sentinel-1 and Sentinel-2.

This extension is built on [**TIFF/BigTIFF**](https://github.com/kiu-chan/tiff-bigtiff) by [kiu-chan](https://github.com/kiu-chan), which provides the viewer at its core: the fast, on-demand rendering of huge TIFF and BigTIFF files. TIFF Viewer VS Code started as a fork of it and adds tools for working with GeoTIFFs. See [Credits](#credits).

Open any `.tif`, `.tiff`, `.btf`, `.tf8` or `.tf2` file and it opens in the viewer.

## Features

- **Classic TIFF and BigTIFF** (64-bit offsets), little- and big-endian.
- **Huge images**: the image is shown as tiles, like a map. Only the tiles in view are read, at the level of detail the zoom needs: a rough overview first, then sharper tiles as they arrive. Multi-gigabyte files are never loaded whole, and tiles already shown are kept for panning and zooming back.
- **Gigapixel images without overviews** (e.g. whole-slide scans): the overview appears within about a second, zooming into any area shows it at full resolution almost immediately, and the zoomed-out view sharpens progressively, starting from the centre.
- **Fast JPEG**: JPEG tiles are decoded by the browser's native decoder, in parallel, and at 1/2, 1/4 or 1/8 size when that is all the zoom needs.
- **Pyramids / overviews** (e.g. Cloud Optimized GeoTIFF): the smallest level that is sharp enough is used automatically.
- **Multi-page** files: switch pages from the toolbar or with <kbd>PageUp</kbd> / <kbd>PageDown</kbd>.
- **Compression**: none, LZW, Deflate, JPEG, PackBits, Zstandard, WebP, LERC, and CCITT fax (modified Huffman RLE, Group 3, Group 4).
- **Pixel formats**: 1 to 64 bits per sample, unsigned and signed integers, 16/32/64-bit floating point, tiled or striped, chunky or planar.
- **Colour models**: grayscale (WhiteIsZero / BlackIsZero), RGB, palette, CMYK, YCbCr, CIE L\*a\*b\*, with alpha (associated or unassociated).
- **High bit depth and float data** are contrast-stretched: *min–max*, *2%–98%*, or the *full range* of the data type. NaN and GDAL NoData pixels are shown as transparent.
- **Band composites** for multi-band imagery such as Sentinel-2 and Sentinel-1: RGB composites and band math with colour maps, saved as presets that can apply automatically (see below).
- **Pixel readout**: the status bar shows the coordinates and the raw sample values under the cursor (and the composite's values).
- **Info panel**: format, byte order, dimensions, bit depth, compression, tiling, pyramid levels, and common tags (description, software, date, resolution, GeoTIFF EPSG code, …).
- Reloads automatically when the file changes on disk.

## Controls

| Action | Mouse / trackpad | Keyboard |
| --- | --- | --- |
| Zoom | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + wheel, pinch | <kbd>+</kbd> / <kbd>-</kbd> |
| Pan | Drag, scroll | Arrow keys (<kbd>Shift</kbd> for larger steps) |
| Fit to window | Double-click, **Fit** | <kbd>0</kbd> |
| Actual size (100%) | **1:1** | <kbd>1</kbd> |
| Next / previous page | Page selector | <kbd>PageDown</kbd> / <kbd>PageUp</kbd>, <kbd>]</kbd> / <kbd>[</kbd> |
| Info panel | **Info** | <kbd>I</kbd> |
| Composite panel | **Composite** | <kbd>B</kbd> |

## Band composites and presets

Pick a preset from the **Bands** menu in the toolbar, or click **Composite** to make your own:

- **RGB**: one expression per channel, e.g. red `B04 / 3000`, green `B03 / 3000`, blue `B02 / 3000`.
- **Single band**: one expression shown with a colour map, e.g. `(B08 - B04) / (B08 + B04)` with *RdYlGn*.

Each channel's **min** and **max** are the values shown as black and as full brightness (the default is 0 to 1, hence the division by 3000 above). Leave them empty to stretch automatically with the **Contrast** setting (min–max or 2%–98%). Pixels where every channel is NoData are transparent.

**Band names** in expressions:

- `b1` … `bN`: band numbers, always available.
- The file's band descriptions (as written by GDAL, rasterio, Google Earth Engine, …), e.g. `B04`, `B8A`, `VV`. The panel lists them; click one to insert it.
- Names a preset defines in `bands`, for files without descriptions (the built-in Sentinel-2 presets know the usual 4, 10, 12 and 13-band layouts).

**Expressions** support `+ - * / % ^`, comparisons `< <= > >= == !=` (1 or 0), and `abs sqrt exp log log10 log2 pow min max clamp where isnan round floor ceil sin cos tan atan2`, plus `pi`. For example `where(SCL == 9, 0, B04 / 3000)` blanks cloudy pixels, and `10 * log10(VV)` converts power to dB.

**Presets** are kept in a file in your home folder, **`~/.tiff-viewer-vscode/presets.jsonc`** (on Windows, `%USERPROFILE%\.tiff-viewer-vscode\presets.jsonc`). It is created when the extension first starts, with comments describing the format and an example, so you can edit it by hand, keep it under version control or copy it to another machine. Open it with **TIFF: Open Band Composite Presets File** from the Command Palette, or the link in the Composite panel; VS Code offers completion and validation while you edit it. Open viewers pick up changes as soon as the file is saved.

**Save as preset…** in the Composite panel asks for a name and whether to apply the preset automatically (to files with the same number of bands, or to file names matching a pattern), then adds it to the file, changing only that entry and keeping your comments. **Delete preset** removes it the same way. If the file has a syntax error, the viewer keeps the last valid presets and tells you the line.

With Remote-SSH, WSL or containers, the file is in the home folder of the machine the files are on.

```jsonc
{
  "presets": [
    {
      "name": "Sentinel-2 true colour",
      "red": "B04 / 3000", "green": "B03 / 3000", "blue": "B02 / 3000",
      "gamma": 1.2,
      "match": { "bands": 13 }                  // apply to every 13-band file
    },
    {
      "name": "S1 RTC (dB × 100)",               // int16 = round(10·log10(γ⁰) · 100)
      "red": "VV / 100", "green": "VH / 100", "blue": "(VV - VH) / 100",
      "range": [[-25, 0], [-30, -5], [0, 15]],  // one [min, max] per channel
      "match": { "fileName": ["*_a150.tif", "*_d069.tif"] }
    },
    {
      "name": "Elevation",
      "value": "b1", "range": "auto", "colormap": "terrain",
      "match": { "fileName": "dem*.tif" }
    }
  ]
}
```

Colour maps: `gray`, `viridis`, `magma`, `inferno`, `plasma`, `turbo`, `RdYlGn`, `RdBu`, `Spectral`, `terrain`; add `_r` to reverse one. A preset with the name of a built-in one replaces it. When a file opens, the viewer shows what you last chose for that file, otherwise the first preset whose `match` rule fits, otherwise the image's own colours.

## Using another editor for TIFF files

This viewer is registered as the default editor for TIFF files. To open a file with something else, right-click it and choose **Open With…**. To change the default, use the `workbench.editorAssociations` setting.

## Limitations

- Not supported: JPEG 2000 (e.g. some Aperio SVS), old-style JPEG (compression 6), LZMA, JPEG XL, and uncompressed chroma-subsampled YCbCr.
- Pyramid levels stored in SubIFDs (as in some OME-TIFF files) are not used; those images are rendered from full resolution.
- A sharp whole-image view of a huge image without pyramid levels needs every tile of the file, so zoomed all the way out it sharpens over a while (about 2 minutes for a 52-gigapixel, 9 GB slide); a rough overview is shown meanwhile. Zooming in only reads the area in view.

## Development

```sh
npm install
npm run build          # bundle into dist/
npm run typecheck
python3 test/make_fixtures.py   # needs numpy, tifffile, imagecodecs, Pillow
npm test               # decoder tests against the fixtures, then composite tests
npm run package        # build tiff-viewer-vscode-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Publishing

Pushing a version tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): it tests and packages the extension, then publishes it to the Visual Studio Marketplace (Trusted Publishing, no stored token) and to Open VSX (token in the `OVSX_PAT` repository secret).

```sh
npm version patch      # or minor / major: updates package.json and creates the tag
git push --follow-tags
```

### How it works

- `src/tiffEditor.ts`: the custom editor in the extension host. It serves byte ranges of the file with positional reads.
- `src/webview/main.ts`: the viewer UI: canvas, zoom/pan, the display tile pyramid, info panel.
- `src/webview/worker.ts`: a Web Worker that parses and decodes the TIFF with [geotiff.js](https://github.com/geotiffjs/geotiff.js), using a block-cached byte-range source (`messageSource.ts`). A few helper workers (same script) decompress tiles in parallel (`decodePool.ts`).
- `src/webview/lzw.ts`: fast TIFF LZW decoder (Deflate uses the platform's `DecompressionStream`).
- `src/presetStore.ts`: the presets file in `~/.tiff-viewer-vscode` (created, watched, and edited in place with `jsonc-parser`).
- `src/shared/expression.ts`, `presets.ts`, `colormaps.ts`, `src/webview/composite.ts`: band math (parsed and evaluated over whole tiles, since the webview forbids `eval`), presets, and composite colouring.
- `src/webview/tiff.ts`: page/pyramid discovery, chunked region reading with box-filter or nearest-neighbour downsampling, and colour conversion.
- `src/webview/ccitt.ts`: CCITT T.4 / T.6 fax decoder.
- `src/webview/jpeg.ts`: JPEG tile decoding with the browser's native decoder, optionally at reduced size (geotiff.js' decoder as fallback).

## Credits

TIFF Viewer VS Code is a fork of [TIFF/BigTIFF](https://github.com/kiu-chan/tiff-bigtiff) by [kiu-chan](https://github.com/kiu-chan), and most of what makes it work is their design and code. Many thanks to kiu-chan for building it and releasing it under the MIT licence.

From kiu-chan's TIFF/BigTIFF (version 0.1.0):

- the custom editor and the reading of byte ranges from files of any size;
- the display tile pyramid loaded on demand, with coarse levels first and progressive sharpening, which makes gigapixel images usable;
- TIFF and BigTIFF parsing, pyramid / overview and multi-page support, chunked region reading with box-filter or nearest-neighbour downsampling;
- native JPEG decoding (including reduced-size decoding), the CCITT fax decoder, and support for all the pixel formats and colour models listed above;
- contrast stretching, NoData transparency, the pixel readout and the info panel;
- the pyramid-of-tiles icon.

Added in TIFF Viewer VS Code:

- band composites and band math, colour maps, and presets kept in `~/.tiff-viewer-vscode/presets.jsonc`;
- band names from GDAL band descriptions;
- faster opening: a new LZW decoder, native Deflate, parallel tile decoding, sampled contrast statistics and a band-aware tile cache.

Both use [geotiff.js](https://github.com/geotiffjs/geotiff.js) to parse and decode TIFF files.

## License

[MIT](LICENSE). Original work copyright kiu-chan; changes in this fork copyright Shargus. Bundles [geotiff.js](https://github.com/geotiffjs/geotiff.js) (MIT) and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) (MIT).
