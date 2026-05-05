import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  expressFactoryMock,
  appMock,
  routes,
  listenMock,
  feedCtorMock,
  addItemMock,
  getAllGroupsMock,
  getGroupBySourceIdMock,
  getPostsByGroupIdMock,
  buildFeedUrlMock,
  isLandingOrGroupUrlMock,
} = vi.hoisted(() => {
  const routeTable: Record<string, (req: any, res: any) => Promise<void> | void> = {};

  const listen = vi.fn((_port: number, cb?: () => void) => {
    cb?.();
    return {};
  });

  const app = {
    get: vi.fn((path: string, handler: (req: any, res: any) => Promise<void> | void) => {
      routeTable[path] = handler;
      return app;
    }),
    listen,
  };

  const expressFactory = vi.fn(() => app);

  return {
    expressFactoryMock: expressFactory,
    appMock: app,
    routes: routeTable,
    listenMock: listen,
    feedCtorMock: vi.fn(),
    addItemMock: vi.fn(),
    getAllGroupsMock: vi.fn(),
    getGroupBySourceIdMock: vi.fn(),
    getPostsByGroupIdMock: vi.fn(),
    buildFeedUrlMock: vi.fn(),
    isLandingOrGroupUrlMock: vi.fn(),
  };
});

vi.mock("express", () => ({
  default: expressFactoryMock,
}));

vi.mock("feed", () => ({
  Feed: class {
    constructor(options: unknown) {
      feedCtorMock(options);
    }

    addItem(item: unknown): void {
      addItemMock(item);
    }

    rss2(): string {
      return "<rss>mock</rss>";
    }
  },
}));

vi.mock("./db.js", () => ({
  getAllGroups: getAllGroupsMock,
  getGroupBySourceId: getGroupBySourceIdMock,
  getPostsByGroupId: getPostsByGroupIdMock,
}));

vi.mock("./utils.js", () => ({
  buildFeedUrl: buildFeedUrlMock,
  isLandingOrGroupUrl: isLandingOrGroupUrlMock,
}));

import "./index.js";

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {},
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    set: vi.fn((key: string, value: string) => {
      res.headers[key] = value;
      return res;
    }),
    send: vi.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
  };
  return res;
}

describe("feed-generator routes", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FEED_BASE_URL;

    for (const key of Object.keys(routes)) {
      delete routes[key];
    }

    appMock.get.mockImplementation((path: string, handler: (req: any, res: any) => Promise<void> | void) => {
      routes[path] = handler;
      return appMock;
    });

    expressFactoryMock.mockClear();
    listenMock.mockClear();

    // Re-register routes for each test by re-importing module graph.
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function bootstrap(): Promise<void> {
    await import("./index.js");
  }

  it("registers routes and starts listener", async () => {
    await bootstrap();

    expect(expressFactoryMock).toHaveBeenCalledTimes(1);
    expect(routes["/health"]).toBeTypeOf("function");
    expect(routes["/feeds"]).toBeTypeOf("function");
    expect(routes["/feed/:groupId"]).toBeTypeOf("function");
    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it("GET /health returns ok", async () => {
    await bootstrap();

    const res = makeRes();
    await routes["/health"]({}, res);

    expect(res.json).toHaveBeenCalledWith({ status: "ok" });
  });

  it("GET /feeds returns mapped feed metadata", async () => {
    await bootstrap();

    getAllGroupsMock.mockResolvedValue([
      { source_id: "group-1", name: "Group One" },
      { source_id: "group-2", name: "Group Two" },
    ]);

    const res = makeRes();
    await routes["/feeds"]({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { groupId: "group-1", name: "Group One", feedUrl: "/feed/group-1" },
      { groupId: "group-2", name: "Group Two", feedUrl: "/feed/group-2" },
    ]);
  });

  it("GET /feeds returns 500 when db call fails", async () => {
    await bootstrap();

    getAllGroupsMock.mockRejectedValue(new Error("db unavailable"));

    const res = makeRes();
    await routes["/feeds"]({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("GET /feed/:groupId returns 404 for unknown group", async () => {
    await bootstrap();

    getGroupBySourceIdMock.mockResolvedValue(null);

    const req = { params: { groupId: "missing" } };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(getGroupBySourceIdMock).toHaveBeenCalledWith("missing");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Group not found" });
  });

  it("GET /feed/:groupId generates RSS and filters landing/group links", async () => {
    await bootstrap();

    getGroupBySourceIdMock.mockResolvedValue({
      id: 99,
      source_id: "group-1",
      name: "Group One",
      url: "https://www.facebook.com/groups/12345",
    });

    getPostsByGroupIdMock.mockResolvedValue([
      {
        source_post_id: "p-1",
        author_name: "Alice",
        content_text: "Hello world",
        content_html: "<p>Hello world</p>",
        link: "https://www.facebook.com/groups/12345/posts/1",
        posted_at: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        source_post_id: "p-2",
        author_name: "Bob",
        content_text: "Skip me",
        content_html: "<p>Skip me</p>",
        link: "https://www.facebook.com/",
        posted_at: new Date("2026-01-02T00:00:00.000Z"),
      },
      {
        source_post_id: "p-3",
        author_name: null,
        content_text: "No link",
        content_html: "<p>No link</p>",
        link: null,
        posted_at: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);

    buildFeedUrlMock.mockReturnValue("https://host/feed/group-1");
    isLandingOrGroupUrlMock.mockImplementation((link: string) => link === "https://www.facebook.com/");

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "host"),
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(buildFeedUrlMock).toHaveBeenCalledWith("http://localhost:3100", "group-1");
    expect(getPostsByGroupIdMock).toHaveBeenCalledWith(99);
    expect(feedCtorMock).toHaveBeenCalledTimes(1);
    expect(addItemMock).toHaveBeenCalledTimes(2);
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p-1",
        link: "https://www.facebook.com/groups/12345/posts/1",
      })
    );
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p-3",
        link: "https://www.facebook.com/groups/12345",
      })
    );
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/rss+xml; charset=utf-8");
    expect(res.send).toHaveBeenCalledWith("<rss>mock</rss>");
  });

  it("GET /feed/:groupId returns 500 on unexpected error", async () => {
    await bootstrap();

    getGroupBySourceIdMock.mockRejectedValue(new Error("boom"));

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "host"),
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("GET /feed/:groupId uses trusted FEED_BASE_URL over request host", async () => {
    process.env.FEED_BASE_URL = "https://feeds.example.com";
    await bootstrap();

    getGroupBySourceIdMock.mockResolvedValue({
      id: 7,
      source_id: "group-1",
      name: "Group One",
      url: "https://www.facebook.com/groups/12345",
    });
    getPostsByGroupIdMock.mockResolvedValue([]);
    buildFeedUrlMock.mockReturnValue("https://feeds.example.com/feed/group-1");

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "evil.example.net"),
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(buildFeedUrlMock).toHaveBeenCalledWith("https://feeds.example.com", "group-1");
  });

  it("falls back to localhost and logs warning for invalid FEED_BASE_URL", async () => {
    process.env.FEED_BASE_URL = "::bad-url::";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await bootstrap();

    getGroupBySourceIdMock.mockResolvedValue({
      id: 7,
      source_id: "group-1",
      name: "Group One",
      url: "https://www.facebook.com/groups/12345",
    });
    getPostsByGroupIdMock.mockResolvedValue([]);
    buildFeedUrlMock.mockReturnValue("http://localhost:3100/feed/group-1");

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "evil.example.net"),
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid FEED_BASE_URL"));
    expect(buildFeedUrlMock).toHaveBeenCalledWith("http://localhost:3100", "group-1");
  });
});
