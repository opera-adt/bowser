/**
 * Profile tool request and response, independent of the map library.
 * Pinned by profile.test.ts.
 */

export interface CentrePoint { dist: number; value: number }
export interface ProfileResponse {
  centre: CentrePoint[];
  median: CentrePoint[] | null;
  samples: CentrePoint[][];
  binned?: boolean;
  bin_width?: number;
}

/** The POST the profile tool sends for a drawn line of [lng, lat] vertices. */
export function profileRequest(
  lngLat: Array<[number, number]>,
  dataset: string,
  timeIndex: number,
  radius: number,
  samplingInterval: number,
): { url: string; init: RequestInit } {
  return {
    url: '/profile',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coords: lngLat,
        dataset_name: dataset,
        time_index: timeIndex,
        n_samples: 200,
        radius,
        n_random: 5,
        sampling_interval: samplingInterval,
      }),
    },
  };
}

/** Normalise both response shapes (bare centre line, or centre + median + samples). */
export function parseProfileResponse(json: unknown): ProfileResponse {
  if (Array.isArray(json)) return { centre: json, median: null, samples: [], binned: false };
  const j = json as Partial<ProfileResponse>;
  return {
    centre: j.centre ?? [],
    median: j.median ?? null,
    samples: j.samples ?? [],
    binned: j.binned ?? false,
    bin_width: j.bin_width,
  };
}
