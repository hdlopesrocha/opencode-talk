import { Rpc } from "@opencode/plugin/rpc";

/**
 * Shared contract between the telegram-bridge OpenCode plugin and the
 * Session API. Published as `./rpc` so external clients can import the
 * typed contract without pulling the plugin implementation.
 */
export const TelegramBridge = Rpc.define({
  id: "telegram-bridge",
  methods: {
    sendMessage: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionID", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { inboxID: { type: "string" } },
        required: ["inboxID"],
        additionalProperties: false,
      },
      errors: {
        not_found: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
      },
    },
    abort: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { interrupted: { type: "boolean" } },
        required: ["interrupted"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          title: { type: "string" },
          agent: { type: "string" },
        },
        required: ["sessionID", "title", "agent"],
        additionalProperties: false,
      },
      errors: {
        not_found: {
          type: "object",
          properties: { sessionID: { type: "string" } },
          required: ["sessionID"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    /** Compact human-readable progress label for remote clients. */
    activity: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          activity: { type: "string" },
          tool: { type: "string" },
        },
        required: ["sessionID", "activity"],
        additionalProperties: false,
      },
    },
    /** Lifecycle marker (started/completed/error/aborted). */
    lifecycle: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          state: { type: "string" },
          message: { type: "string" },
        },
        required: ["sessionID", "state"],
        additionalProperties: false,
      },
    },
    /**
     * Image upload from the agent (via the telegram_send_image tool).
     * `data` is base64-encoded bytes; the Session API stores them in its
     * media store and fans a session.message with attachments out to
     * clients. Kept out of `activity` so binary blobs never pollute text.
     */
    image: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          filename: { type: "string" },
          mimeType: { type: "string" },
          data: { type: "string" },
          caption: { type: "string" },
        },
        required: ["sessionID", "filename", "mimeType", "data"],
        additionalProperties: false,
      },
    },
  },
});
