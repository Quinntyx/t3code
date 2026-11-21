import * as NodeModule from "node:module";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  selectWorkspaceDetail,
  workspaceDetailRouter,
} from "../features/layout/workspace/workspace-detail-selection";

const harness = vi.hoisted(() => ({
  os: "android",
  navigation: undefined as unknown,
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.os;
    },
  },
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: require("@react-navigation/routers").StackActions,
    useNavigation: () => harness.navigation,
    useRoute: () => ({ params: undefined }),
  };
});
vi.mock("../state/entities", () => ({ useProjects: () => [], useThreadShell: () => null }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/issueTrackers", () => ({ issueTrackerEnvironment: { connections: {} } }));
vi.mock("../state/pull-requests", () => ({ composerPullRequests: { preview: {} } }));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => () => Promise.resolve({ _tag: "Failure" }),
}));
vi.mock("../state/use-thread-pr", () => ({
  withKnownPullRequestSummary: <Params,>(params: Params) => params,
}));
vi.mock("../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => Promise.resolve(false) }));
vi.mock("../lib/pullRequestNavigation", () => ({
  nativePullRequestDestination: () => ({
    environmentId: "env",
    projectId: "p",
    repository: "o/r",
    number: 2,
  }),
  pullRequestCandidateForIssueLink: () => null,
}));

import { useNavigateToPullRequest } from "./useOpenPullRequest";

const require = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = require("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function setup({ replace = false, drillIn = false, os = "android" } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.os = os;
  const base = StackRouter({});
  const router = { ...base, ...workspaceDetailRouter(base) };
  const options = {
    routeNames: ["Home", "PullRequest", "GitOverview"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = base.getInitialState(options);
  type Action = Parameters<typeof router.getStateForAction>[1];
  const dispatch = (action: Action) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = base.getRehydratedState(next, options);
  };
  const first = {
    name: "PullRequest",
    params: { environmentId: "env", projectId: "p", repository: "o/r", number: 1 },
  } as const;
  dispatch(selectWorkspaceDetail(first) as unknown as Action);
  harness.navigation = { dispatch, getState: () => state };
  let open!: ReturnType<typeof useNavigateToPullRequest>;
  function Probe() {
    const navigate = useNavigateToPullRequest({ replace, drillIn });
    useLayoutEffect(() => {
      open = navigate;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    async open() {
      await act(async () => {
        await open("https://github.com/o/r/pull/2", null);
      });
    },
    get state() {
      return state;
    },
    back: () => dispatch(StackActions.pop()),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it.each(["android", "ios"])(
  "pushes the destination PR on top of the current route (%s)",
  async (os) => {
    using screen = setup({ os });
    await screen.open();
    expect(screen.state.routes.map((route) => route.name)).toEqual([
      "Home",
      "PullRequest",
      "PullRequest",
    ]);
    expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 2 });
    screen.back();
    expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 1 });
  },
);

it("retains the source PR for Back when drillIn is passed", async () => {
  using screen = setup({ drillIn: true });
  await screen.open();
  expect(screen.state.routes.map((route) => route.name)).toEqual([
    "Home",
    "PullRequest",
    "PullRequest",
  ]);
  screen.back();
  expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 1 });
});

it("replaces the current route when replace is true", async () => {
  using screen = setup({ replace: true });
  await screen.open();
  expect(screen.state.routes.map((route) => route.name)).toEqual(["Home", "PullRequest"]);
  expect(screen.state.routes.at(-1)?.params).toMatchObject({ number: 2 });
});
