import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type DelegationPermissionChoice = "directory" | "target-project";
export type DelegationApprovalDuration = "run" | "session";
export type DelegationApprovalDecision = {
  permission: DelegationPermissionChoice;
  duration: DelegationApprovalDuration;
};

export type DelegationApprovalRequest = {
  requestId: string;
  requester: string;
  target: string;
  access: "read" | "read-write";
  directoryEffect: string;
  targetProjectEffect: string;
};

/** Two independent radio groups. Selection is inert until Allow is activated. */
export class DelegationApprovalDialog implements Component {
  permission: DelegationPermissionChoice = "directory";
  duration: DelegationApprovalDuration = "run";
  private focus: 0 | 1 | 2 = 0;
  private action: 0 | 1 = 0;

  readonly request: DelegationApprovalRequest;
  private readonly onDone: (decision: DelegationApprovalDecision | undefined) => void;
  private readonly onChange: () => void;

  constructor(
    request: DelegationApprovalRequest,
    onDone: (decision: DelegationApprovalDecision | undefined) => void,
    onChange: () => void = () => {},
  ) {
    this.request = request;
    this.onDone = onDone;
    this.onChange = onChange;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.onDone(undefined);
    if (matchesKey(data, Key.tab)) {
      this.focus = ((this.focus + 1) % 3) as 0 | 1 | 2;
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.choose();
      return;
    }
    if (matchesKey(data, Key.enter) && this.focus === 2) {
      if (this.action === 0) {
        this.onDone({ permission: this.permission, duration: this.duration });
      } else this.onDone(undefined);
    }
  }

  private move(delta: number): void {
    if (this.focus === 0) this.permission = delta < 0 ? "directory" : "target-project";
    else if (this.focus === 1) this.duration = delta < 0 ? "run" : "session";
    else this.action = delta < 0 ? 0 : 1;
    this.onChange();
  }

  private choose(): void {
    if (this.focus === 2) return;
    this.move(1);
  }

  render(width: number): string[] {
    const selected = (yes: boolean) => (yes ? "◉" : "○");
    const cursor = (group: number) => (this.focus === group ? "> " : "  ");
    const lines = [
      "Subagent permission request",
      `Requesting agent: ${this.request.requester}`,
      `Target directory: ${this.request.target}`,
      `Requested access: ${this.request.access === "read-write" ? "read and write" : "read only"}`,
      "",
      "Permissions",
      `${cursor(0)}${selected(this.permission === "directory")} Add requested directory access`,
      `    ${this.request.directoryEffect}`,
      `${cursor(0)}${selected(this.permission === "target-project")} Use the target project's normal agent permissions`,
      `    ${this.request.targetProjectEffect}`,
      "",
      "Apply this approval",
      `${cursor(1)}${selected(this.duration === "run")} This subagent run, including its descendants`,
      `${cursor(1)}${selected(this.duration === "session")} Remember for this session, including its subagents`,
      "",
      `${cursor(2)}${this.action === 0 ? "[ Allow ]" : "  Allow  "}  ${this.action === 1 ? "[ Cancel ]" : "  Cancel  "}`,
      "Tab changes group · arrows select · Enter submits · Esc cancels",
    ];
    return lines.flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""])
      .map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}
}
