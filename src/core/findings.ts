import type { DeliveryFindings, ReviewFinding } from "../types.js";

const CONFIDENCE = new Set<ReviewFinding["confidence"]>([
  "reproduced",
  "static-inference",
  "needs-confirmation",
]);

export function parseReviewFindings(text: string | null): DeliveryFindings {
  if (text === null || text.trim() === "") {
    return {
      verified: false,
      items: [],
      note: "No assistant message was available to parse for findings.",
    };
  }

  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = blocks.at(-1)?.[1]?.trim();
  if (raw === undefined || raw === "") {
    return {
      verified: false,
      items: [],
      note: "No fenced ```json findings block was found in the final reply.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      verified: false,
      items: [],
      note: "The findings JSON block could not be parsed; the reply may be truncated.",
    };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { findings?: unknown }).findings)
      ? ((parsed as { findings: unknown[] }).findings)
      : null;
  if (list === null) {
    return {
      verified: false,
      items: [],
      note: "The findings JSON must be an array or an object with a findings array.",
    };
  }

  const items: ReviewFinding[] = [];
  let rejected = 0;
  for (const entry of list.slice(0, 100)) {
    const finding = asFinding(entry);
    if (finding === null) {
      rejected += 1;
      continue;
    }
    items.push(finding);
  }

  return {
    verified: rejected === 0 && items.length === Math.min(list.length, 100),
    items,
    note:
      rejected === 0
        ? `Parsed ${items.length} structured finding(s).`
        : `Rejected ${rejected} finding(s) with missing fields or an invalid confidence value.`,
  };
}

function asFinding(value: unknown): ReviewFinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const location = record.location;
  const trigger = record.trigger;
  const evidence = record.evidence;
  const confidence = record.confidence;
  if (
    typeof location !== "string" ||
    location.trim() === "" ||
    typeof trigger !== "string" ||
    trigger.trim() === "" ||
    typeof evidence !== "string" ||
    evidence.trim() === "" ||
    typeof confidence !== "string" ||
    !CONFIDENCE.has(confidence as ReviewFinding["confidence"])
  ) {
    return null;
  }
  return {
    location: location.trim().slice(0, 500),
    trigger: trigger.trim().slice(0, 4000),
    evidence: evidence.trim().slice(0, 8000),
    confidence: confidence as ReviewFinding["confidence"],
  };
}
