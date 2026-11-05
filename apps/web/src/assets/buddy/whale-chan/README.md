# Whale-chan

Bundled buddy, laid out exactly like a downloaded source: `buddy.json` plus one
VP9-with-alpha clip per state at 24 fps.

Art from the Whale-chan theme in
[rullerzhou-afk/clawd-themes](https://github.com/rullerzhou-afk/clawd-themes)
(`whale-chan-1.0.2.clawd-theme.zip`, SHA-256
`1e37403b21570f5d6850caade7ec48e3d97da3f9d5223071461e6c202ad7e0d8`). Upstream
ships animated WebP at 438–732 px square; each composition is normalized to one
480×480 transparent frame the way the theme fits them into a single display box.

| File              | Source                                  |
| ----------------- | --------------------------------------- |
| `idle.webm`       | `whale-chan-idle.webp`                  |
| `roam.webm`       | `whale-chan-bus.webp`                   |
| `thinking.webm`   | `whale-chan-thinking.webp`              |
| `working.webm`    | `whale-chan-working.webp`               |
| `working2.webm`   | `whale-chan-rice.webp`                  |
| `working3.webm`   | `whale-chan-rain.webp`                  |
| `juggling.webm`   | `whale-chan-rice.webp`                  |
| `juggling2.webm`  | `whale-chan-rice.webp`                  |
| `waiting.webm`    | `whale-chan-notify.webp`                |
| `sweeping.webm`   | `whale-chan-tail.webp`                  |
| `carrying.webm`   | `whale-chan-pool.webp`                  |
| `dozing.webm`     | `whale-chan-sleep-dozing-loop.webp`     |
| `sleeping.webm`   | `whale-chan-sleep-cloud-loop.webp`      |
| `yawning.webm`    | `whale-chan-sleep-idle-to-dozing.webp`  |
| `collapsing.webm` | `whale-chan-sleep-dozing-to-cloud.webp` |
| `waking.webm`     | `whale-chan-sleep-cloud-to-idle.webp`   |
| `success.webm`    | `whale-chan-done.webp`                  |
| `error.webm`      | `whale-chan-error.webp`                 |
| `angry.webm`      | `whale-chan-poke.webp`                  |
| `drag.webm`       | `whale-chan-drag.webp`                  |

Upstream has one juggling asset for any subagent count, so `juggling2` reuses it.
The left-facing bus and mini-mode clips are unused: T3 Code's buddy never docks
to a screen edge.

The character is 溟月, an OC by 上善无形; upstream credits ZipZipPipe as well.
New animation by 鹿鹿 (rullerzhou-afk) is CC BY-NC-SA 4.0. This is an unofficial,
non-commercial fan work, unaffiliated with and not endorsed by DeepSeek.
