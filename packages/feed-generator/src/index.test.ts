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
  checkDatabaseMock,
  getDatabaseHealthMock,
  buildFeedUrlMock,
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
    checkDatabaseMock: vi.fn(),
    getDatabaseHealthMock: vi.fn(),
    buildFeedUrlMock: vi.fn(),
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

vi.mock("./database.js", () => ({
  checkDatabase: checkDatabaseMock,
  getDatabaseHealth: getDatabaseHealthMock,
}));

vi.mock("./utils.js", () => ({
  buildFeedUrl: buildFeedUrlMock,
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
    checkDatabaseMock.mockResolvedValue(true);
    getDatabaseHealthMock.mockReturnValue({ status: "ok", lastError: null, lastSuccessAt: null });

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

    expect(res.statusCode).toBe(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "ok", database: { status: "ok", lastError: null, lastSuccessAt: null },
    });
  });

  it("GET /health reports database failure and subsequent recovery", async () => {
    await bootstrap();
    checkDatabaseMock.mockResolvedValueOnce(false);
    getDatabaseHealthMock.mockReturnValueOnce({ status: "degraded", lastError: "Query read timeout", lastSuccessAt: null });
    const failed = makeRes();
    await routes["/health"]({}, failed);
    expect(failed.statusCode).toBe(503);
    expect(failed.body.database.lastError).toBe("Query read timeout");

    const recovered = makeRes();
    await routes["/health"]({}, recovered);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body.status).toBe("ok");
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

  it("GET /feed/:groupId renders the eligible post window", async () => {
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
    ]);

    buildFeedUrlMock.mockReturnValue("https://host/feed/group-1");

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "host"),
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(buildFeedUrlMock).toHaveBeenCalledWith("http://localhost:3100", "group-1");
    expect(getPostsByGroupIdMock).toHaveBeenCalledWith(99, "https://www.facebook.com/groups/12345");
    expect(feedCtorMock).toHaveBeenCalledTimes(1);
    expect(addItemMock).toHaveBeenCalledTimes(1);
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "p-1",
        link: "https://www.facebook.com/groups/12345/posts/1",
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

  it("GET /feed/:groupId uses trusted FEED_BASE_URL with port and proxy prefix over request headers", async () => {
    process.env.FEED_BASE_URL = "https://feeds.example.com:8443/rss/base/";
    await bootstrap();

    getGroupBySourceIdMock.mockResolvedValue({
      id: 7,
      source_id: "group-1",
      name: "Group One",
      url: "https://www.facebook.com/groups/12345",
    });
    getPostsByGroupIdMock.mockResolvedValue([]);
    const expectedUrl = "https://feeds.example.com:8443/rss/base/feed/group-1";
    buildFeedUrlMock.mockReturnValue(expectedUrl);

    const req = {
      params: { groupId: "group-1" },
      protocol: "https",
      get: vi.fn(() => "evil.example.net"),
      headers: { host: "evil.example.net", "x-forwarded-host": "evil.example.net", "x-forwarded-proto": "http" },
    };
    const res = makeRes();

    await routes["/feed/:groupId"](req, res);

    expect(buildFeedUrlMock).toHaveBeenCalledWith("https://feeds.example.com:8443/rss/base", "group-1");
    expect(feedCtorMock).toHaveBeenCalledWith(expect.objectContaining({ id: expectedUrl, link: expectedUrl }));
    expect(req.get).not.toHaveBeenCalled();
  });

  it.each([
    "::bad-url::", "ftp://example.com", "https://user:password@example.com",
    "https://example.com?query=1", "https://example.com#fragment",
  ])("falls back to localhost and logs warning for invalid FEED_BASE_URL %s", async (configured) => {
    process.env.FEED_BASE_URL = configured;
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
    warnSpy.mockRestore();
  });
});
