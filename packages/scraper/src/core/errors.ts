export class ScraperConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScraperConfigurationError";
  }
}

export class ScraperStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScraperStateError";
  }
}

/** Format only the message, never serialize arbitrary request/credential payloads. */
export function scraperErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === "string" ? error.message : "Error without a string message";
    }
    if (error !== null && typeof error === "object") {
      const message = Object.getOwnPropertyDescriptor(error, "message");
      if (message && "value" in message && typeof message.value === "string") return message.value;
      return "Unknown thrown object";
    }
    return String(error);
  } catch {
    // Thrown values can themselves have broken accessors or proxy traps.
    return "Unprintable thrown value";
  }
}
