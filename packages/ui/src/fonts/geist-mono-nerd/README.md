# GeistMono Nerd Font

These self-hosted faces come from the installed Arch Linux package
`otf-geist-mono-nerd` version `3.5.1-2`, distributed from
[Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/tree/v3.5.1/patched-fonts/GeistMono).
The family is `GeistMono Nerd Font`, including the patched Nerd Font symbols.
The accompanying `LICENSE` retains the SIL Open Font License 1.1 notice and
Vercel/basement.studio attribution.

The original OTF files were compressed with `woff2_compress`, preserving their
glyphs. `source.json` records the package, conversion and face mapping. All nine
weights, 100–900, include normal and italic faces. The shared UI stylesheet
imports `faces.css`; each consuming Vite app emits the same package-owned font
assets into its own build and downloads only the faces its rendered text uses.
No app needs a separate font import, remote font service or installed system font.

Each face also has a Latin subset selected by `unicode-range` for common text.
The full face remains the fallback for Nerd Font symbols and other glyphs. The
subsets were generated from the matching package OTFs with `pyftsubset` using
`--unicodes='U+0000-024F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD' --layout-features='*' --name-IDs='*' --name-languages='*' --notdef-glyph --notdef-outline --recommended-glyphs`,
then compressed with `woff2_compress`. Keep the CSS ranges and subsets aligned.
