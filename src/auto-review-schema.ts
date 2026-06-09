export const AutoReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changes"],
  properties: {
    status: {
      type: "string",
      enum: ["approved", "changes_requested"],
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "requested_change"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          requested_change: { type: "string" },
        },
      },
    },
  },
} as const;
