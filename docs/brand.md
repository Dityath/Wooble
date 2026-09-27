# Brand and design system

Wooble's visual direction is calm, modular, and clear. The product should help people read complex architecture without adding visual noise. This Markdown guide summarizes the project's brand source for contributors. Implementation tokens live in [`packages/ui/src/tokens.css`](../packages/ui/src/tokens.css); existing application styles and components show how they are applied.

## Voice

Use short, direct sentences. Introduce technical terms when they help someone make a decision or complete a task. Avoid unnecessary superlatives and unexplained jargon. A user should be able to move from a broad architecture view to a detailed technical field without switching tone.

## Logo and artwork

The three-module Wooble mark represents architecture elements that can be arranged and reused. Keep its proportions and orientation. Leave clear space around it, roughly the height of one module. Use a quiet, contrasting background. The app icon uses the mark without the wordmark or decorative effects at small sizes.

The SVG in [`apps/web/public/wooble-mark.svg`](../apps/web/public/wooble-mark.svg) is the repository's app mark. The [Wooble logo banner](assets/wooble-logo-banner.png) appears in the README. The web app also uses `wooble-auth-background.png` and `wooble-empty-canvas.png` for its authentication and empty states. Original Wooble artwork is dedicated to the public domain as described in [licensing](../LICENSING.md).

## Palette

| Role | Color | Hex |
| --- | --- | --- |
| Main surface | Ivory Cream | `#FAF7EF` |
| Border and alternate surface | Stone | `#DDD6C8` |
| Primary accent | Muted Moss | `#6B7F6E` |
| Warm accent | Soft Clay | `#C9A892` |
| Neutral divider | Mist Gray | `#E8E8E8` |
| Primary text | Charcoal Ink | `#1F1F1F` |

The source guide suggests a visual balance of about 60% surface, 20% neutral, 15% primary, and 5% accent. Use Charcoal Ink for small body text on light surfaces. Check contrast before using Muted Moss for small text.

## Typography and layout

General Sans is the preferred display face, Inter the body face, and JetBrains Mono the technical face. The app provides fallbacks; these fonts are not bundled by this repository. Use monospace for code, identifiers, and configuration rather than general prose. Keep body lines at a comfortable reading length.

The spacing rhythm is `4 / 8 / 16 / 24 / 32 / 48`. Radius choices are `6 / 10 / 14 / 18`. Favor a neutral 1px border over a strong shadow. Elevation should remain subtle for inspectors, popovers, and floating controls.

## Product UI rules

- Show essential labels and relationships on the canvas; reveal deeper metadata in the inspector or details view.
- Distinguish node and edge types subtly, with readable connection labels.
- Preserve the canvas context when opening the inspector.
- Establish hierarchy with spacing, size, and weight before adding color.
- Reuse the tokens and existing UI primitives before adding a new visual pattern.
