"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";
import { githubApi } from "@/lib/api/github";
import { deployApi } from "@/lib/api/deploy";
import { getApiErrorMessage, getApiRequestScopeVersion } from "@/lib/api/client";
import { useDeployment } from "@/context/DeploymentContext";
import { useDefaultDomainType } from "@/context/CloudContext";
import { monorepoAppFromScan, normalizeAppRoot } from "@/context/deployment/monorepo-config";
import type { MonorepoAppConfig } from "@/context/deployment/types";
import { normalizeSubdomain } from "@/utils/subdomain";
import { buildTree, type TreeNode } from "@/components/permissions/path-tree";

function directoryPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isDirectory ? [node.path, ...directoryPaths(node.children)] : [],
  );
}

export function RepositoryAppPicker({
  onClose,
  onAdd,
  app,
}: {
  onClose: () => void;
  onAdd: (app: MonorepoAppConfig) => void;
  app?: MonorepoAppConfig;
}) {
  const { config } = useDeployment();
  const { t } = useI18n();
  const copy = t.importProject.monorepo.selection;
  const domainType = useDefaultDomainType();
  const [path, setPath] = useState(app?.rootDirectory || ".");
  const [directories, setDirectories] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [treeError, setTreeError] = useState("");
  const [retry, setRetry] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [candidate, setCandidate] = useState<MonorepoAppConfig | null>(null);
  const generation = useRef(0);
  const scope = useRef(getApiRequestScopeVersion());
  const canBrowse =
    !!config.owner && config.owner !== "local" && !config.localPath && !config.uploadSessionId;

  useEffect(() => {
    let cancelled = false;
    setCandidate(null);
    setScanning(false);
    setDirectories(null);
    setTreeError("");
    if (canBrowse)
      githubApi
        .getRepoTree(config.owner, config.repo, config.branch)
        .then((result) => {
          if (!cancelled && scope.current === getApiRequestScopeVersion())
            setDirectories(directoryPaths(buildTree(result.data)));
        })
        .catch((error) => {
          if (!cancelled && scope.current === getApiRequestScopeVersion())
            setTreeError(getApiErrorMessage(error, copy.browseError));
        });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [canBrowse, config.owner, config.repo, config.branch, retry, copy.browseError]);

  const changePath = (next: string) => {
    generation.current++;
    setScanning(false);
    setPath(next);
    setCandidate(null);
    setError("");
  };
  const inspect = async () => {
    const entered = path.trim();
    const root = normalizeAppRoot(entered);
    if (
      entered.startsWith("/") ||
      /^[A-Za-z]:/.test(entered) ||
      entered.includes("\\") ||
      entered.split("/").includes("..")
    ) {
      setError(copy.invalidPath);
      return;
    }
    if (
      config.monorepoApps?.some(
        (other) => other.id !== app?.id && normalizeAppRoot(other.rootDirectory) === root,
      )
    ) {
      setError(copy.alreadyAdded);
      return;
    }
    if (!app && (config.monorepoApps?.length ?? 0) >= 50) {
      setError(copy.appLimit);
      return;
    }
    const request = ++generation.current;
    setError("");
    setScanning(true);
    setCandidate(null);
    try {
      const response = await deployApi.prepare(
        config.localPath
          ? { source: "local", path: config.localPath, rootDirectory: root }
          : { owner: config.owner, repo: config.repo, branch: config.branch, rootDirectory: root },
      );
      if (request !== generation.current || scope.current !== getApiRequestScopeVersion()) return;
      if (response.error) throw new Error(response.error);
      if (normalizeAppRoot(response.rootDirectory || ".") !== root)
        throw new Error(copy.folderMismatch);
      if (response.projectType === "services") throw new Error(copy.composeFolder);
      const stem =
        normalizeSubdomain(root === "." ? config.repo : root.replaceAll("/", "-"))
          .slice(0, 63)
          .replace(/-+$/, "") || "app";
      let name = stem;
      for (
        let suffix = 2;
        config.monorepoApps?.some((other) => other.id !== app?.id && other.name === name);
        suffix++
      )
        name = `${stem.slice(0, 57)}-${suffix}`;
      const next = monorepoAppFromScan(
        { ...response, id: root, name, rootDirectory: root },
        config.projectName,
        domainType,
      );
      setCandidate({
        ...next,
        id: app?.id ?? next.id,
        name: app?.name ?? next.name,
        enabled: true,
        ...(app
          ? { envVars: app.envVars, publicEndpoints: app.publicEndpoints, exposed: app.exposed }
          : {}),
      });
    } catch (error) {
      if (request === generation.current && scope.current === getApiRequestScopeVersion())
        setError(getApiErrorMessage(error, copy.scanError));
    } finally {
      if (request === generation.current) setScanning(false);
    }
  };
  const parent = path === "." ? "." : path.split("/").slice(0, -1).join("/") || ".";
  const children =
    directories?.filter((dir) => (dir.split("/").slice(0, -1).join("/") || ".") === path) ?? [];

  return (
    <Modal
      isOpen
      onClose={onClose}
      width="560px"
      maxWidth="calc(100vw - 32px)"
      footer={
        <div className="flex justify-end gap-2 p-4">
          <Button variant="secondary" onClick={onClose}>
            {copy.cancel}
          </Button>
          {candidate ? (
            <Button
              onClick={() => {
                if (scope.current === getApiRequestScopeVersion()) onAdd(candidate);
              }}
            >
              {app ? copy.useFolder : copy.addApp}
            </Button>
          ) : (
            <Button onClick={() => void inspect()} disabled={scanning || !!config.uploadSessionId}>
              {scanning ? copy.scanning : copy.inspect}
            </Button>
          )}
        </div>
      }
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-app-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="space-y-4 p-5"
      >
        <div className="pe-8">
          <h2 id="repo-app-title" className="text-lg font-semibold">
            {app ? copy.chooseFolder : copy.addFromRepo}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.folderHint}</p>
        </div>
        <label className="block space-y-2">
          <span className="text-sm">{copy.appFolder}</span>
          <Input
            autoFocus
            variant="filled"
            dir="ltr"
            value={path}
            onChange={(event) => changePath(event.target.value)}
          />
        </label>
        {canBrowse && !candidate && (
          <div className="rounded-xl bg-background p-2 max-h-64 overflow-auto">
            {path !== "." && (
              <button
                className="flex w-full items-center gap-2 rounded-lg p-2 text-sm hover:bg-muted"
                onClick={() => changePath(parent)}
              >
                <Icon name="arrow-left" className="size-4" />
                {copy.parentFolder}
              </button>
            )}
            {treeError ? (
              <div role="alert" className="p-2 text-sm">
                {treeError}
                <Button variant="secondary" onClick={() => setRetry(retry + 1)}>
                  {copy.retry}
                </Button>
              </div>
            ) : directories === null ? (
              <p role="status" className="p-3 text-sm text-muted-foreground">
                {copy.loadingFolders}
              </p>
            ) : children.length ? (
              children.map((dir) => (
                <button
                  key={dir}
                  className="flex w-full items-center gap-2 rounded-lg p-2 text-start text-sm hover:bg-muted"
                  onClick={() => changePath(dir)}
                >
                  <Icon name="folder" className="size-4 text-muted-foreground" />
                  <span className="min-w-0 truncate">{dir.split("/").at(-1)}</span>
                  <Icon name="chevron-right" className="ms-auto size-4" />
                </button>
              ))
            ) : (
              <p className="p-3 text-sm text-muted-foreground">{copy.noSubfolders}</p>
            )}
          </div>
        )}
        {candidate && (
          <div className="space-y-2 rounded-xl bg-background p-4 text-sm">
            <p className="font-medium">{candidate.name}</p>
            <p className="text-muted-foreground">
              {candidate.framework} · {candidate.rootDirectory}
            </p>
            {[candidate.installCommand, candidate.buildCommand, candidate.startCommand]
              .filter(Boolean)
              .map((command, i) => (
                <p key={i} className="break-all font-mono text-xs">
                  {command}
                </p>
              ))}
            <p className="text-xs text-muted-foreground">{copy.reviewHint}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
