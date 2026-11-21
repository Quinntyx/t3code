import type { ReactNode } from "react";

/**
 * Stack guides run down each parent's left edge from its title line. The root's guide curves out
 * of its icon; a nested parent's guide drops from the arm that reaches it, so the two form a T.
 * Arms curve off the guide into each child's title line. Later siblings carry the straight line.
 */
const rootGuideClassName =
  "[&>ul>li:first-child:not(:last-child)]:relative [&>ul>li:first-child:not(:last-child)]:after:pointer-events-none [&>ul>li:first-child:not(:last-child)]:after:absolute [&>ul>li:first-child:not(:last-child)]:after:top-4.75 [&>ul>li:first-child:not(:last-child)]:after:bottom-0 [&>ul>li:first-child:not(:last-child)]:after:left-0 [&>ul>li:first-child:not(:last-child)]:after:w-2 [&>ul>li:first-child:not(:last-child)]:after:rounded-tl-md [&>ul>li:first-child:not(:last-child)]:after:stack-guide-corner";

const nestedGuideClassName =
  "[&>ul>li:first-child:not(:last-child)]:relative [&>ul>li:first-child:not(:last-child)]:after:pointer-events-none [&>ul>li:first-child:not(:last-child)]:after:absolute [&>ul>li:first-child:not(:last-child)]:after:top-4.75 [&>ul>li:first-child:not(:last-child)]:after:bottom-0 [&>ul>li:first-child:not(:last-child)]:after:left-0 [&>ul>li:first-child:not(:last-child)]:after:w-px [&>ul>li:first-child:not(:last-child)]:after:bg-sidebar-stack-guide";

export const sidebarStackClassName = `list-none rounded-(--sidebar-row-radius) ${rootGuideClassName}`;

const sidebarStackBranchClassName = `relative ml-2 list-none before:pointer-events-none before:absolute before:-top-0.5 before:-left-2 before:h-5.5 before:w-4 before:rounded-bl-md before:stack-guide-elbow not-last:after:absolute not-last:after:-top-0.5 not-last:after:bottom-0 not-last:after:-left-2 not-last:after:w-px not-last:after:bg-sidebar-stack-guide ${nestedGuideClassName}`;

export function SidebarStackBranch(props: { children: ReactNode }) {
  return (
    <li data-stack-branch className={sidebarStackBranchClassName}>
      <ul role="presentation" className="flex flex-col">
        {props.children}
      </ul>
    </li>
  );
}
