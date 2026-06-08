export type AutoReviewChange = {
  file: string;
  line: number;
  requested_change: string;
};

export type AutoReviewApproval = {
  status: "approved";
  changes: [];
};

export type AutoReviewChangesRequested = {
  status: "changes_requested";
  changes: AutoReviewChange[];
};

export type AutoReviewInvalidReason =
  | "empty_output"
  | "missing_json"
  | "invalid_json"
  | "invalid_status"
  | "approved_has_changes"
  | "missing_changes"
  | "invalid_change";

export type AutoReviewInvalid = {
  status: "invalid";
  reason: AutoReviewInvalidReason;
  message: string;
};

export type AutoReviewResult =
  | AutoReviewApproval
  | AutoReviewChangesRequested
  | AutoReviewInvalid;

export function parseAutoReviewResult(output: string): AutoReviewResult {
  const trimmed = output.trim();
  if (!trimmed) {
    return invalid("empty_output", "review output was empty");
  }

  const jsonText = extractJsonPayload(trimmed);
  if (!jsonText) {
    return invalid("missing_json", "review output did not contain a JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return invalid("invalid_json", "review output contained invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("invalid_json", "review output JSON must be an object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.status === "approved") {
    if (record.changes === undefined) {
      return { status: "approved", changes: [] };
    }
    if (!Array.isArray(record.changes) || record.changes.length > 0) {
      return invalid(
        "approved_has_changes",
        'approved review output must not include requested changes'
      );
    }
    return { status: "approved", changes: [] };
  }

  if (record.status !== "changes_requested") {
    return invalid(
      "invalid_status",
      'review output status must be "approved" or "changes_requested"'
    );
  }

  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    return invalid(
      "missing_changes",
      'changes_requested review output must include a non-empty "changes" array'
    );
  }

  const changes: AutoReviewChange[] = [];
  for (const entry of record.changes) {
    const change = parseChange(entry);
    if (!change) {
      return invalid(
        "invalid_change",
        "each requested change must include file, line, and requested_change"
      );
    }
    changes.push(change);
  }

  return { status: "changes_requested", changes };
}

export function isAutoReviewApproved(
  result: AutoReviewResult
): result is AutoReviewApproval {
  return result.status === "approved";
}

function parseChange(entry: unknown): AutoReviewChange | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const requestedChange =
    typeof record.requested_change === "string"
      ? record.requested_change.trim()
      : "";
  const line = record.line;

  if (!file || !requestedChange || !Number.isInteger(line) || (line as number) < 1) {
    return null;
  }

  return {
    file,
    line: line as number,
    requested_change: requestedChange,
  };
}

function invalid(
  reason: AutoReviewInvalidReason,
  message: string
): AutoReviewInvalid {
  return { status: "invalid", reason, message };
}

function extractJsonPayload(output: string): string | null {
  const fencedMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  if (output.startsWith("{") && output.endsWith("}")) {
    return output;
  }

  const objectStart = output.indexOf("{");
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < output.length; i++) {
    const char = output[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0) {
        return output.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}
