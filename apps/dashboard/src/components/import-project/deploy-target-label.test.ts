import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DeployTargetSummary } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { describeBuildStrategy, resolveBuildLocation } from "./deploy-target-label";

vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

const dp = baseDictionary.importProject.deploymentProcessing;

describe("build location", () => {
  it("reports a Docker server build as running on the server even when This Machine was picked", () => {
    const config = { deployTarget: "server", buildStrategy: "local", runtimeMode: "docker" };
    expect(resolveBuildLocation(config)).toBe("target");
    expect(resolveBuildLocation({ deployTarget: "server", buildStrategy: "local" })).toBe("target");
    expect(describeBuildStrategy(config, baseDictionary)).toBe(dp.strategyServer);
  });

  it("keeps a local build where the runtime really builds on this machine", () => {
    const bare = { deployTarget: "server", buildStrategy: "local", runtimeMode: "bare" };
    expect(resolveBuildLocation(bare)).toBe("local");
    expect(describeBuildStrategy(bare, baseDictionary)).toBe(dp.strategyLocal);
    expect(
      resolveBuildLocation({
        deployTarget: "local",
        buildStrategy: "local",
        runtimeMode: "docker",
      }),
    ).toBe("local");
  });

  it("labels a server deployment's build location by its runtime in the target summary", () => {
    const summary = (runtimeMode: "docker" | "bare") =>
      renderToStaticMarkup(
        createElement(DeployTargetSummary, {
          deployTarget: "server",
          buildStrategy: "local",
          runtimeMode,
          serverName: "box-1",
        }),
      );
    expect(summary("docker")).not.toContain(baseDictionary.deploy.summary.buildLocal);
    expect(summary("bare")).toContain(baseDictionary.deploy.summary.buildLocal);
  });
});
