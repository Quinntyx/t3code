# Clawd

Bundled buddy, laid out exactly like a downloaded source: `buddy.json` plus one
VP9-with-alpha clip per state at 24 fps.

Art from the Clawd on Desk theme
([rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk),
`themes/clawd` + `assets/svg/`), whose states animate with CSS keyframes. Each
frame was drawn by seeking its Web Animations timeline and screenshotting with
alpha, using one shared content box so pose changes stay registered.

| File              | Source                        | Motion                          |
| ----------------- | ----------------------------- | ------------------------------- |
| `idle.webm`       | `clawd-idle-follow.svg`       | Breathing bob, blink, eye darts |
| `roam.webm`       | `clawd-mini-crabwalk.svg`     | Crabwalk                        |
| `thinking.webm`   | `clawd-working-thinking.svg`  | Thought bubble                  |
| `working.webm`    | `clawd-working-typing.svg`    | Types at a keyboard             |
| `working2.webm`   | `clawd-headphones-groove.svg` | Headphones, 2 busy sessions     |
| `working3.webm`   | `clawd-working-building.svg`  | Hard hat and hammer, 3+         |
| `juggling.webm`   | `clawd-headphones-groove.svg` | One live subagent               |
| `juggling2.webm`  | `clawd-working-juggling.svg`  | Three balls, 2+ subagents       |
| `waiting.webm`    | `clawd-notification.svg`      | Speech bubble                   |
| `sweeping.webm`   | `clawd-working-sweeping.svg`  | Sweeps while context compacts   |
| `carrying.webm`   | `clawd-working-carrying.svg`  | Carries a box at checkpoint     |
| `dozing.webm`     | `clawd-idle-doze.svg`         | Nods off                        |
| `sleeping.webm`   | `clawd-sleeping.svg`          | Splayed out asleep              |
| `yawning.webm`    | `clawd-idle-yawn.svg`         | Stretches into a yawn           |
| `collapsing.webm` | `clawd-collapse-sleep.svg`    | Melts into sleep                |
| `waking.webm`     | `clawd-wake.svg`              | Shakes awake                    |
| `success.webm`    | `clawd-happy.svg`             | Jump, sparkles, land            |
| `error.webm`      | `clawd-error.svg`             | Rain cloud, sweat drop          |
| `angry.webm`      | `clawd-react-annoyed.svg`     | Gritted teeth, steam            |
| `drag.webm`       | `clawd-react-drag.svg`        | Dangles while dragged           |

Clawd is Anthropic's Claude Code mascot, so the character belongs to Anthropic.
Treat this art as fan work rather than a T3 Code mark. Upstream reserves all
rights in it; it is bundled here on the same basis as the rest of the buddy art,
for a private, undistributed fork.
