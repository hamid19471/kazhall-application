# Typefaces

Kazhal ships **two** faces, layered. Which one you see depends on whether a
commercial licence has been exercised — and the build works either way.

| | Face | Licence | In this repo? | How it loads |
| --- | --- | --- | --- | --- |
| **Baseline** | Vazirmatn | SIL OFL 1.1 | **Yes** — `vazirmatn/` | `next/font/local` in both root layouts |
| **Brand** | Yekan Bakh | commercial, all rights reserved | **No** — gitignored | plain `@font-face` → `/fonts/*.woff2` |

A clean clone builds and renders correct Persian on Vazirmatn. A licensed
deployment drops four files into `public/fonts/` and gets Yekan Bakh, with no
code change and no rebuild of the font pipeline.

---

## Why it is split this way

`next/font/local` resolves each `src[].path` at **compile time**, through the
module graph. A missing file is a build error, not a blank page. So the face
that cannot be committed cannot be loaded that way — with Yekan Bakh on
`next/font/local`, `apps/web` and `apps/store` simply would not build on a fresh
clone.

A **root-relative** `url()` in CSS is the opposite: no bundler resolves it, it
goes to the browser verbatim. Missing files cost a 404 and nothing else, and CSS
font matching moves on to the next family in the stack. That is the whole trick.

```
--kz-font-sans:
  "Yekan Bakh",              <- @font-face → /fonts/*.woff2, may 404
  var(--kz-font-vazirmatn),  <- next/font/local, ALWAYS present
  "IRANSansX", "Segoe UI", "Noto Sans Arabic", … ;
```

---

## Installing the brand face (licensees only)

1. Confirm a **webfont licence from fontiran.com covers your deploying
   domains**. That is a commercial question, not a technical one, and nothing in
   this repository grants it.
2. Put the four files in **both** apps' public directories:

   ```
   apps/web/public/fonts/     apps/store/public/fonts/
     YekanBakh-Regular.woff2    YekanBakh-Regular.woff2
     YekanBakh-SemiBold.woff2   YekanBakh-SemiBold.woff2
     YekanBakh-Bold.woff2       YekanBakh-Bold.woff2
     YekanBakh-Black.woff2      YekanBakh-Black.woff2
   ```

   Both directories are gitignored (`apps/*/public/fonts/`). Each app serves its
   own `public/`, so `/fonts/x.woff2` must exist under each one.
3. Set `NEXT_PUBLIC_BRAND_FONT=yekan-bakh` for both apps. This does **not** load
   the font — step 2 does. It only enables the `ss01` feature, which is safe
   under Yekan Bakh and destructive under Vazirmatn (see below).
4. Verify: the `<html>` element carries `data-brand-font="yekan-bakh"`, and
   DevTools → Network shows four `200`s for `/fonts/YekanBakh-*.woff2` rather
   than four `404`s.

Skipping step 3 is harmless — you get the brand face without digit
normalisation. Doing step 3 **without** step 2 is the one bad combination: ASCII
digits get rewritten to Persian under the baseline face.

---

## `ss01` — the one place the two faces disagree

Verified with fontTools against the actual binaries, not assumed:

| Input | Yekan Bakh `ss01` | Vazirmatn `ss01` |
| --- | --- | --- |
| Arabic-Indic `٠١٢٣` → Persian `۰۱۲۳` | yes | yes |
| **ASCII `0123`** | **left alone** | **→ `۰۱۲۳`, rewritten** |

Vazirmatn's `ss01` lookup carries 20 substitutions: the ten Arabic-Indic digits
*and* the ten ASCII digits. Yekan Bakh's carries only the first ten.

Enabling `ss01` unconditionally on `body` — which is what this project used to
do — would therefore turn every price, order number, SKU and phone number
Persian on any build running the baseline, while the licensed build left them
ASCII. Two builds, two different products.

So it is gated:

```css
:root[data-brand-font="yekan-bakh"] body {
  font-feature-settings: "ss01" on;
}
```

and the attribute comes from `NEXT_PUBLIC_BRAND_FONT`. Default: off.

**Features that must stay off.** Yekan Bakh's `ss02` (`ک`→`ڪ`), `ss03`
(`ی`→`ے`) and `salt` are Urdu/decorative alternates that corrupt ordinary
Persian. Vazirmatn's `salt` is Latin-only decoration (`K`→`K.alt`, `g`→`g.alt`)
and is likewise unused. None of these is a generic "nicer Persian" switch.

---

## Vazirmatn — baseline, committed

**Licence: SIL Open Font License 1.1** — `vazirmatn/OFL.txt`, copied verbatim
from the upstream package, alongside `vazirmatn/AUTHORS.txt`. OFL permits
redistribution as part of a larger work, which is why these files may live in
this repository at all. The embedded name records agree: licence (id 13) reads
*"This Font Software is licensed under the SIL Open Font License, Version 1.1"*,
licence URL (id 14) `https://scripts.sil.org/OFL`, and `OS/2.fsType` is `0` —
installable embedding, no restriction.

**Provenance.** `vazirmatn@33.0.3` on npm, fetched from
`https://cdn.jsdelivr.net/npm/vazirmatn@33.0.3/fonts/webfonts/`. Not converted,
subsetted or re-generated here. Upstream: https://github.com/rastikerdar/vazirmatn

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `vazirmatn/Vazirmatn-Regular.woff2` | 50,684 | `e382101336c6eb32cfb31381c027d02d2e0354bad08f6a395d4088beb3db3d91` |
| `vazirmatn/Vazirmatn-SemiBold.woff2` | 51,032 | `6a39a3c25eb18503cad590527b95bb5d4062b889a7ebbd3f01b0488d239e0499` |
| `vazirmatn/Vazirmatn-Bold.woff2` | 51,020 | `836fae7d42d83faa249bc00e0099592be98a1fa260d22d82f269b6091e585627` |
| `vazirmatn/Vazirmatn-Black.woff2` | 50,568 | `e65a05523e6c0a434265913805746ebe6ed48af843e6126a936d06f69d7d47ad` |

All four are WOFF2, `Version 33.003`, 1,333 glyphs, 811 mapped codepoints,
2048 units/em, **static — `fvar` is absent from every one**. The upstream set
has nine statics plus a variable build; the five unused weights (Thin,
ExtraLight, Light, Medium, ExtraBold) are deliberately not vendored — nothing
renders them and they would add ~250KB of preload for no pixels.

**Script coverage**, verified against the binaries: Persian `سلام دنیا گچپژ ی ک`,
Arabic `العربیة إ ة ؤ ئ`, Persian digits `۰۱۲۳۴۵۶۷۸۹`, Arabic-Indic digits
`٠١٢٣٤٥٦٧٨٩`, ASCII `0123456789 ABCabc`, punctuation `،؛؟٫٬`, Rial sign `﷼` —
all present, none missing. `GSUB` carries the `arab` script with
`init`/`medi`/`fina`/`rlig`, so Persian and Arabic shape and join correctly, and
`tnum` is present so tabular figures work on receipts.

---

## Yekan Bakh — brand, NOT committed

**Licence — READ THIS FIRST. Yekan Bakh is commercial software, not an open
font.** No licence document ships beside the files; the only licence statement
that exists is embedded in the binaries themselves:

| Name record | Value |
| --- | --- |
| Copyright (id 0) | `Copyright (c) 2022 by Reza Bakhtiarifard. All rights reserved.` |
| Licence (id 13) | `To use this font, it is necessary to obtain the license from www.fontiran.com` |
| Licence URL (id 14) | `https://fontiran.com/licenses` |
| Designer (id 9) / Manufacturer (id 8) | `Reza Bakhtiarifard` |
| Vendor URL (id 11) | `https://www.fontiran.com/` |
| `OS/2.fsType` | `8` — editable embedding permitted |

No claim is made here that Kazhal holds that licence. This is why the binaries
are gitignored rather than committed: publishing them to a Git remote would be
redistribution, and `fsType: 8` permits *embedding*, not that.

**The expected files**, recorded so a licensee can confirm they have the same
bytes this project was designed against:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `YekanBakh-Regular.woff2` | 32,244 | `a4950017a67f2cdc06c3daa0d98154f90f95842f3ad1bfb7eb5902ddcda5e46a` |
| `YekanBakh-SemiBold.woff2` | 32,500 | `4b4d27a3064afed3167c7708bb33382e8bf32fe4c4136df65f7e5cd07ed68727` |
| `YekanBakh-Bold.woff2` | 32,720 | `131fc6e7d1ff2037191fb4c71339bf181bb68c678fbe25da427e0c3e6db24d87` |
| `YekanBakh-Black.woff2` | 32,996 | `49f42cbc38e96804009aa580a7daf71974bd1b06ae3e8372a5ea53383f4b539f` |

All four are WOFF2 (TrueType outlines), `Version 2.000`, 554 glyphs, 482 mapped
codepoints, 1000 units/em, static — `fvar` is absent. Two further weights exist
upstream (Thin 100, Light 300) and are not used. Script coverage was verified
equivalent to the table above.

Historically these sat in `packages/ui/fonts/` and were loaded by
`next/font/local`. They may still be there on an existing working copy — the
ignore rule `packages/ui/fonts/*.woff2` keeps them out of Git, and nothing reads
them from that location any more. The loader reads `public/fonts/`.

---

## Weight mapping

Identical for both faces, which is what lets the overlay swap in without a
mapping table. The `usWeightClass` baked into each file is what it is declared
as, so the browser never synthesises a bold.

| CSS `font-weight` | Vazirmatn file | Yekan Bakh file | `usWeightClass` |
| --- | --- | --- | --- |
| `400` | `Vazirmatn-Regular.woff2` | `YekanBakh-Regular.woff2` | 400 |
| `600` | `Vazirmatn-SemiBold.woff2` | `YekanBakh-SemiBold.woff2` | 600 |
| `700` | `Vazirmatn-Bold.woff2` | `YekanBakh-Bold.woff2` | 700 |
| `900` | `Vazirmatn-Black.woff2` | `YekanBakh-Black.woff2` | 900 |

Two weights are *used* by components but have no file of their own in either
face. They are resolved by ordinary CSS font matching, not synthesised:

| Utility | Requested | Actually painted |
| --- | --- | --- |
| `font-medium` | 500 | 400 Regular (matching walks down from 500) |
| `font-extrabold` | 800 | 900 Black (matching walks up from 800) |

`font-medium` is therefore visually identical to `font-normal`. If the design
needs a distinct mid weight, that is a request for a real 500 file in both
faces, not a CSS change.

---

## Wiring

`apps/web/app/layout.tsx` and `apps/store/app/layout.tsx` each call
`localFont()` on the Vazirmatn files and publish the family as
`--kz-font-vazirmatn`. `next/font` is part of `next` itself, so this adds no
package and leaves `pnpm-lock.yaml` untouched — the same constraint that makes
`globals.css` reach into this package by relative path.

The two declarations are duplicated on purpose and **must stay identical**.
`next/font` is a compile-time transform that only accepts literal values, so the
weight table cannot be lifted into a shared module — passing a variable is a
build error. Change one, change both.

`packages/ui/src/styles/tokens.css` holds the four Yekan Bakh `@font-face` rules
and points `--kz-font-sans` and `--kz-font-numeric` at the layered stack.

`display: "swap"`, `preload: true`, and Next's `adjustFontFallback` (left at its
default) generate a metric-adjusted local fallback face for Vazirmatn, which is
what keeps layout shift down while the files load. The Yekan Bakh `@font-face`
rules carry `font-display: swap` to match; they get no `size-adjust`, since
hand-tuning one against a font that may not be installed would be guesswork.
