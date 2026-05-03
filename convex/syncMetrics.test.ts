import { describe, it, expect } from "vitest";
import {
  HEAVY_BATCH_THRESHOLD,
  dailyMetricsChunkSize,
  realtimeMetricsChunkSize,
  adUpsertChunkSize,
} from "./syncMetrics";

describe("dailyMetricsChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(dailyMetricsChunkSize(0)).toBe(100);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(100);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(100);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(25);
    expect(dailyMetricsChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(25);
  });
});

describe("realtimeMetricsChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(realtimeMetricsChunkSize(0)).toBe(200);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(200);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(200);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(50);
    expect(realtimeMetricsChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(50);
  });
});

describe("adUpsertChunkSize", () => {
  it("returns DEFAULT chunk at and below HEAVY_BATCH_THRESHOLD", () => {
    expect(adUpsertChunkSize(0)).toBe(200);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD - 1)).toBe(200);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD)).toBe(200);
  });
  it("returns HEAVY chunk above HEAVY_BATCH_THRESHOLD", () => {
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD + 1)).toBe(50);
    expect(adUpsertChunkSize(HEAVY_BATCH_THRESHOLD * 4)).toBe(50);
  });
});
