import { join } from "node:path";

/** Resolves the user-owned directories shared by desktop scripting services. */
export const resolveScriptWorkspacePaths = (workspaceDir: string) =>
  ({
    dataDir: join(workspaceDir, "data"),
    packagesDir: join(workspaceDir, "packages"),
    scriptsDir: join(workspaceDir, "scripts"),
  }) as const;
