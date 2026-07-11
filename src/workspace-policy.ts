export interface WorkspaceIdentity {
  readonly id: string;
  readonly name: string;
}

export function workspaceAllowedByPolicy(
  workspace: WorkspaceIdentity,
  allowlist: readonly string[]
): boolean {
  if (allowlist.length === 0) return true;
  const identities = new Set([normalize(workspace.id), normalize(workspace.name)]);
  return allowlist.some((value) => identities.has(normalize(value)));
}

export function destinationAllowedByPolicy(
  workspace: WorkspaceIdentity,
  allowlist: readonly string[],
  denylist: readonly string[]
): boolean {
  if (!workspaceAllowedByPolicy(workspace, allowlist)) return false;
  const identities = new Set([normalize(workspace.id), normalize(workspace.name)]);
  return !denylist.some((value) => identities.has(normalize(value)));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
