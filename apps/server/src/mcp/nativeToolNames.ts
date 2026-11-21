import { HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ConnectorsToolkit } from "./toolkits/connectors/tools.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { IssuesToolkit } from "./toolkits/issues/tools.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit } from "./toolkits/device/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";
import { MessageToolkit } from "./toolkits/message/tools.ts";
import { ToolSearchToolkit } from "./toolkits/toolSearch/tools.ts";

/** Every name the toolkits register, read without building them: a proxy must not take one. */
export const nativeToolNames: ReadonlySet<string> = new Set(
  [
    HtmlRenderToolkit,
    HtmlPreviewToolkit,
    PreviewStandardToolkit,
    PreviewSnapshotToolkit,
    OrchestratorToolkit,
    ThreadToolkit,
    ConnectorsToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    EnvironmentToolkit,
    ThemeToolkit,
    PreviewControlsToolkit,
    WorktreeToolkit,
    PullRequestsToolkit,
    IssuesToolkit,
    DeviceStandardToolkit,
    DeviceScreenshotToolkit,
    MessageToolkit,
    ToolSearchToolkit,
  ].flatMap((toolkit) => Object.keys(toolkit.tools)),
);
