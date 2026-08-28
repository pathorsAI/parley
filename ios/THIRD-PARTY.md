# Third-party notices — Parley for iOS

Parley for iOS is Apache-2.0. It embeds the following third-party material.

## McBopomofo lexicon data

The 注音 keyboard's candidate dictionary
(`ParleyKit/Sources/ParleyKit/Resources/zhuyin-dict.txt`) is generated from the
open-source lexicon data of the **McBopomofo** input method:

- Source: <https://github.com/openvanilla/McBopomofo>, `Source/Data/`
- Files used: `BPMFBase.txt` (single-character 注音 readings) and `phrase.occ`
  (corpus occurrence counts, used only for ordering)
- License: **MIT** — `LICENSE.txt` at the repository root, "Copyright (c)
  2011-2026 Mengjuei Hsieh et al."

`BPMFMappings.txt` is deliberately **not** used. It is the file McBopomofo's own
data README describes as simplified from libtabe's `tsi.src`, so it carries a
second license's provenance — and it holds multi-character phrases, which this
keyboard does not convert (see `docs/design/ios-voice-keyboard.md`).

Regenerate with `node scripts/gen-zhuyin-dict.mjs`. The script pins the download
to a commit and stamps it into the resource's header, so the committed file names
exactly what it was built from.

```
MIT License

Copyright (c) 2011-2026 Mengjuei Hsieh et al.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

DM Sans and Alexandria (`App/Parley/Resources/Fonts/`) ship under the **SIL Open
Font License 1.1**.
