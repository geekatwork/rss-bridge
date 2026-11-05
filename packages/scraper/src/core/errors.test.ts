import { describe, expect, it } from "vitest";
import { RecoverablePageError } from "./SiteScraper.js";
import { ScraperConfigurationError, ScraperStateError, scraperErrorMessage } from "./errors.js";

describe("scraper errors", () => {
  it("preserves error type, message and original cause without making fatal errors recoverable", () => {
    const cause = new Error("Original failure");
    for (const ErrorClass of [ScraperConfigurationError, ScraperStateError, RecoverablePageError]) {
      const error = new ErrorClass("Failure", { cause });
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(ErrorClass.name);
      expect(error.message).toBe("Failure");
      expect(error.cause).toBe(cause);
      expect(error instanceof RecoverablePageError).toBe(ErrorClass === RecoverablePageError);
    }
  });

  it.each([
    [new Error("Error message"), "Error message"],
    ["Thrown string", "Thrown string"],
    [undefined, "undefined"],
    [null, "null"],
    [42, "42"],
    [false, "false"],
    [Symbol("failure"), "Symbol(failure)"],
    [{ message: "Transport failure", request: { credential: "synthetic" } }, "Transport failure"],
    [Object.create(null), "Unknown thrown object"],
  ])("formats thrown value %# defensively", (value, expected) => {
    expect(scraperErrorMessage(value)).toBe(expected);
  });

  it("does not traverse circular objects or invoke their getters/toString", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(scraperErrorMessage(circular)).toBe("Unknown thrown object");
    const hostile = {
      get message() { throw new Error("Getter must not run"); },
      toString() { throw new Error("toString must not run"); },
    };
    expect(scraperErrorMessage(hostile)).toBe("Unknown thrown object");
  });

  it("does not throw while reporting malformed errors or proxy traps", () => {
    const error = new Error();
    Object.defineProperty(error, "message", { get() { throw new Error("Broken accessor"); } });
    expect(scraperErrorMessage(error)).toBe("Unprintable thrown value");
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("Broken proxy"); } });
    expect(scraperErrorMessage(proxy)).toBe("Unprintable thrown value");
  });
});
