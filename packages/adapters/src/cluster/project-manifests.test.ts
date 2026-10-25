import { describe, expect, it } from "vitest";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";
import {
  admitProjectManifests,
  applyProjectManifests,
  parseProjectManifests,
  projectManifestLabels,
} from "./project-manifests";

const owner = { projectId: "proj_1", runtimeId: "rt-1", namespace: "os-abc" };

const deployment = (name = "web", pod: Record<string, unknown> = {}) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name },
  spec: {
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: { containers: [{ name, image: "nginx:1.27" }], ...pod },
    },
  },
});

/** In-memory API server: 404 on misses, resourceVersion checks on PUT, label-selector lists. */
function fakeApi(seed: KubernetesObject[] = []) {
  const store = new Map<string, KubernetesObject>();
  const calls: string[] = [];
  let version = 1;
  const put = (path: string, object: KubernetesObject) =>
    store.set(path, {
      ...structuredClone(object),
      metadata: { ...object.metadata, uid: `uid-${version}`, resourceVersion: String(version++) },
    });
  for (const object of seed) put(object.metadata.name!, object);
  const api: KubernetesApi = {
    async request(method: string, path: string, body?: unknown) {
      calls.push(`${method} ${path}`);
      const [base, query] = path.split("?");
      if (method === "GET" && query) {
        const selector = new URLSearchParams(query).get("labelSelector")!;
        const wanted = selector.split(",").map((pair) => pair.split("="));
        const items = [...store.entries()]
          .filter(([key]) => key.startsWith(`${base}/`))
          .map(([, object]) => object)
          .filter((object) => wanted.every(([k, v]) => object.metadata.labels?.[k!] === v));
        return { items } as never;
      }
      if (method === "GET") {
        const object = store.get(path);
        if (!object) throw new KubernetesApiError(404, "not found");
        return structuredClone(object) as never;
      }
      if (method === "POST") {
        const object = body as KubernetesObject;
        put(`${path}/${object.metadata.name}`, object);
        return object as never;
      }
      if (method === "PUT") {
        const object = body as KubernetesObject;
        if (store.get(path)?.metadata.resourceVersion !== object.metadata.resourceVersion)
          throw new KubernetesApiError(409, "conflict");
        put(path, object);
        return object as never;
      }
      if (method === "DELETE") {
        store.delete(path);
        return {} as never;
      }
      throw new Error(`unexpected ${method}`);
    },
    watch: () => (async function* () {})(),
    logs: () => (async function* () {})(),
    dispose: async () => {},
  };
  return { api, store, calls };
}

describe("parseProjectManifests", () => {
  it("reads every document and skips empty ones", () => {
    const objects = parseProjectManifests(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n",
    );
    expect(objects.map((o) => o.kind)).toEqual(["ConfigMap", "Secret"]);
  });

  it("names the document that failed to parse", () => {
    expect(() => parseProjectManifests("kind: ConfigMap\n---\nkind: [unclosed\n")).toThrow(
      /Document 2 could not be parsed/,
    );
  });
});

describe("admitProjectManifests", () => {
  it.each([
    [
      "a cluster-scoped kind",
      { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: "x" } },
      /kind is not supported/,
    ],
    [
      "another namespace",
      { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x", namespace: "kube-system" } },
      /project's namespace/,
    ],
    [
      "a NodePort service",
      { apiVersion: "v1", kind: "Service", metadata: { name: "x" }, spec: { type: "NodePort" } },
      /only ClusterIP/,
    ],
    [
      "a reserved label",
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "x", labels: { "openship.io/project": "other" } },
      },
      /reserved label/,
    ],
    [
      "ownerReferences",
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "x",
          ownerReferences: [{ apiVersion: "v1", kind: "Secret", name: "s", uid: "u" }],
        },
      },
      /ownerReferences/,
    ],
    ["host networking", deployment("web", { hostNetwork: true }), /hostNetwork/],
    [
      "a hostPath volume",
      deployment("web", { volumes: [{ name: "h", hostPath: { path: "/" } }] }),
      /hostPath/,
    ],
    [
      "persistent storage",
      deployment("web", { volumes: [{ name: "d", persistentVolumeClaim: { claimName: "d" } }] }),
      /persistent volume claim/,
    ],
    [
      "a non-default service account",
      deployment("web", { serviceAccountName: "admin" }),
      /service account/,
    ],
    [
      "a privileged container",
      deployment("web", {
        containers: [{ name: "c", image: "x", securityContext: { privileged: true } }],
      }),
      /privileged/,
    ],
  ])("refuses %s", (_label, object, message) => {
    expect(() => admitProjectManifests([object as KubernetesObject], owner)).toThrow(message);
  });

  it("refuses the same object twice", () => {
    expect(() => admitProjectManifests([deployment(), deployment()], owner)).toThrow(
      /defined more than once/,
    );
  });

  it("pins objects to the project, stamps ownership and orders config before workloads", () => {
    const [config, workload] = admitProjectManifests(
      [
        deployment(),
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "settings" },
          status: { x: 1 },
        } as KubernetesObject,
      ],
      owner,
    );
    expect(config!.kind).toBe("ConfigMap");
    expect(config!.status).toBeUndefined();
    expect(workload!.metadata.namespace).toBe("os-abc");
    expect(workload!.metadata.labels).toMatchObject(projectManifestLabels(owner));
    expect(workload!.spec.template.spec.automountServiceAccountToken).toBe(false);
  });
});

describe("applyProjectManifests", () => {
  const base = "/apis/apps/v1/namespaces/os-abc/deployments";

  it("creates, leaves identical objects alone and replaces changed ones", async () => {
    const { api, store, calls } = fakeApi();
    expect(
      (await applyProjectManifests(api, admitProjectManifests([deployment()], owner), owner))
        .created,
    ).toEqual(["Deployment/web"]);

    calls.length = 0;
    const again = await applyProjectManifests(
      api,
      admitProjectManifests([deployment()], owner),
      owner,
    );
    expect(again.unchanged).toEqual(["Deployment/web"]);
    expect(calls.filter((c) => c.startsWith("PUT"))).toEqual([]);

    const changed = deployment("web", { containers: [{ name: "web", image: "nginx:1.28" }] });
    expect(
      (await applyProjectManifests(api, admitProjectManifests([changed], owner), owner)).updated,
    ).toEqual(["Deployment/web"]);
    expect(store.get(`${base}/web`)!.spec.template.spec.containers[0].image).toBe("nginx:1.28");
  });

  it("keeps the cluster IP the API server assigned when a Service changes", async () => {
    const { api, store } = fakeApi();
    const service = (port: number) => ({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web" },
      spec: { ports: [{ port }] },
    });
    await applyProjectManifests(api, admitProjectManifests([service(80)], owner), owner);
    const path = "/api/v1/namespaces/os-abc/services/web";
    store.get(path)!.spec.clusterIP = "10.43.0.7";
    await applyProjectManifests(api, admitProjectManifests([service(8080)], owner), owner);
    expect(store.get(path)!.spec).toMatchObject({
      clusterIP: "10.43.0.7",
      ports: [{ port: 8080 }],
    });
  });

  it("never replaces an object that the manifests did not create", async () => {
    // Openship's own app Service carries the project labels but not the manifest label.
    const { api, store } = fakeApi();
    store.set("/api/v1/namespaces/os-abc/services/app", {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "app",
        resourceVersion: "1",
        labels: {
          "app.kubernetes.io/managed-by": "openship",
          "openship.io/project": "proj_1",
          "openship.io/runtime": "rt-1",
        },
      },
    });
    const takeover = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "app" },
      spec: { ports: [{ port: 1 }] },
    };
    await expect(
      applyProjectManifests(api, admitProjectManifests([takeover], owner), owner),
    ).rejects.toMatchObject({
      code: "CLUSTER_MANIFEST_CONFLICT",
    });
    expect(store.get("/api/v1/namespaces/os-abc/services/app")!.spec).toBeUndefined();
  });

  it("deletes manifest objects that are no longer declared, and only those", async () => {
    const { api, store } = fakeApi();
    await applyProjectManifests(
      api,
      admitProjectManifests([deployment("web"), deployment("worker")], owner),
      owner,
    );
    store.set(`${base}/app`, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "app", resourceVersion: "1", labels: { "openship.io/project": "proj_1" } },
    });

    const result = await applyProjectManifests(
      api,
      admitProjectManifests([deployment("web")], owner),
      owner,
    );
    expect(result.deleted).toEqual(["Deployment/worker"]);
    expect([...store.keys()].filter((k) => k.startsWith(base)).sort()).toEqual([
      `${base}/app`,
      `${base}/web`,
    ]);
  });
});
