# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Styles and effects

On web and desktop, **Style & effects** in **Settings → Appearance** layers an optional visual
style on top of any color palette without changing your colors. It defaults to **None**, which
keeps the standard interface. Style choices and setting overrides are saved separately on each
device or browser, and **Reset settings** restores the active style and palette to their defaults.

Choose the built-in **Liquid Glass** style to enable glass surfaces and layout effects:

- **Refractive glass** bends the conversation and lists behind frosted surfaces such as the
  composer, toolbars, and menus. Sliders tune **Edge blur**, **Center blur**, **Saturation**,
  **Refraction**, **Dispersion**, and **Glare**, with a live **Glass preview** in settings.
  Refractive glass requires desktop or a Chromium browser.
- **Floating panels** detaches the sidebar, right panel, and terminal drawer into floating glass
  cards with a margin from the window edges, moving the sidebar and panel toggles into corner
  bubbles.
- **Ambient shimmer** drifts subtle theme-colored bands behind the workspace using WebGL. It is
  paused while Reduce Motion is enabled in your operating system.

These effects can increase GPU and battery use. Published environment styles and v2 palettes that
declare custom settings show their controls in the same section.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Window controls

In the desktop app, turn on **Hide window controls** under **Settings → Appearance → Window** to
hide the minimize, maximize, and close buttons. Restart T3 Code to apply the change.

## Buddy

Pick a buddy under **Settings → Appearance → Buddy** to add an animated companion that floats
above the app. Clawd and Whale-chan ship with T3 Code, in the same format as a downloaded buddy
— a `buddy.json` manifest beside its clips.

It reacts to the agent in the thread you have open: thinking, running tools, juggling when
subagents are working, waiting on an approval or answer, sweeping while the context compacts,
carrying when a checkpoint lands, and finishing or failing a turn. Two or three threads running
at once get busier clips. Leave the app alone and it drifts from a bored wander into a doze and
then sleep, and wakes when you come back.

Drag it anywhere on screen; it dangles while you drag, and you can click it to tease it. The
choice and position are saved on each device. Buddies are not available in the mobile app, and
Safari may show them on a solid background.

### Buddy sources

More buddies can come from git repositories instead of the app. A source is one folder per
buddy, each holding a `buddy.json` manifest and its `.webm` clips. Add a repository under
**Settings → Appearance → Buddy → Buddy sources**; T3 Code clones it with the same connections
and credentials it uses for projects, then lists every buddy it finds.

Sources are re-pulled when you open T3 Code, and **Reload** pulls immediately. A buddy from a
source can be renamed, updated or removed there without reinstalling the app. Removing a source
drops its buddies from the picker; the clone stays on disk until the server removes it.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a T3 Code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

### Custom CSS

For a change that colors cannot make, open **Custom CSS** in the theme editor. The CSS is saved with
the theme, applies after T3 Code's own styles on web and desktop, and is included in exports. Use
`.dark` or `:root:not(.dark)` to target one appearance.

Custom CSS cannot load files. `@import`, `image-set()`, and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. This keeps an imported theme from sending what is on your screen
to another site. For a full-size image, use a [background image](#background-image).

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`.

If a rule hides something you need, run `t3 theme set t3-chat` on the server to switch to a
built-in theme, or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to pick
another theme.

### Ask an agent

An agent on the same machine as the server can restyle T3 Code for you using `t3_theme_read` and
`t3_theme_set`. Ask it to change the look, for example "make T3 Code's chat header taller" or
"give T3 Code a solarized theme". It publishes an [environment theme](#environment-themes) or
style with colors, CSS, settings, or effects, and web and desktop clients of that server switch to
it. It can also switch styles independently of the palette and change light, dark, or system mode.
The thread must run in Full access. Ask the agent to set a built-in theme or clear the style to
undo it.

## Environment themes

Environment themes, styles, and defaults come from the server serving your web app or the desktop
app's main local environment. With the desktop app's local environment off, they come from the
[background service](./background-service.md) on the same machine while the app is connected to
it. app.t3.codes and other connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it, or select a published style under **Style & effects**. **Duplicate** makes an independent copy
of a palette you can edit. A saved custom theme with the same ID takes precedence. If the server
stops publishing the selected theme, T3 Code falls back to its standard theme; if a published style
is removed, clients fall back to **None**.

Run this on the server to set a default palette or style and switch connected clients to it:

```bash
t3 theme set nightfall
t3 theme set --style liquid-glass
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme or style afterward sticks until the next `t3 theme set`. Run the command
again to reapply it, even if the name is unchanged.

`t3 theme clear` removes the default palette (`t3 theme clear --style` removes the default style)
without changing anyone's current choice. `t3 theme show` lists the default and published themes
and styles.

### Publish a theme

Save a theme exported from T3 Code into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating it.
Do not use `system`, `light`, `dark`, or a built-in theme or style ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view. An optional `css` string adds [custom CSS](#custom-css).

Version 2 files (`"version": 2`) separate palettes (`"kind": "palette"`, the default) from
overlay styles (`"kind": "style"`), which apply CSS, settings, and effects on top of any palette
without changing colors. Both kinds can declare:

- `settings`: up to 32 declarative controls (`boolean`, bounded `number`, `select`, or hex `color`,
  with optional `description` and `when` visibility conditions) rendered automatically under
  **Settings → Appearance → Style & effects**. Resolved values are exposed on `:root` as
  `--theme-setting-<key>` (palette) or `--theme-style-setting-<key>` (style), and booleans and
  selects also set matching `data-theme-setting-<key>` / `data-theme-style-setting-<key>`
  attributes.
- `effects`: declarative `liquidGlass`, `floatingPanels`, and `ambientShimmer` parameters bound to
  literals or `{ "setting": "<key>" }` references. An active style overrides palette declarations
  per effect.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

### Background image

A published theme can have a full-size background image. Ask an agent, for example "use
~/Pictures/wallpaper.jpg as T3 Code's background", or save a JPEG, PNG, or WebP file of up to
16 MB beside the theme file: `nightfall.jpg` beside `nightfall.json`. The theme's CSS decides
where the image shows:

```css
[data-workspace-area="conversation"] {
  background: var(--theme-background-image) center / cover no-repeat;
}
```

Delete the image file to remove it.
