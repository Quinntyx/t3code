# Whale-chan

Unmodified VP9-with-alpha clips from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
(`dsh-pet/assets/webm/`), renamed by state:

| File            | Source                       |
| --------------- | ---------------------------- |
| `idle.webm`     | `待机呼吸休闲.webm`          |
| `thinking.webm` | `工作状态-思考冒泡.webm`     |
| `working.webm`  | `工作状态-忙碌点按.webm`     |
| `waiting.webm`  | `工作状态-原地踱步张望.webm` |
| `success.webm`  | `工作状态-雀跃庆祝.webm`     |
| `error.webm`    | `工作状态-垂头叹气冒汗.webm` |
| `angry.webm`    | `点击回应-傲娇生气.webm`     |

dsh-pet declares MIT, but the character design traces to 溟月, an OC by 上善无形 under
CC BY-NC-SA 4.0 (the maid variant by ZipZipPipe is also non-commercial). Treat the art as
non-commercial.

These seven clips cover only part of the buddy's state set. Whale-chan has no
doze-off, subagent, compaction or checkpoint art, so `resolveBuddyClip` falls
back to the nearest clip it does ship (walking `working`, `thinking`, and finally
`idle`). Adding more states means adding files here with matching slot names.
