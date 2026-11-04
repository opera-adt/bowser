/** Profile tool contract: the request a drawn line sends, and how responses are read. */
import { describe, expect, it } from 'vitest';
import { parseProfileResponse, profileRequest } from './profile';

const LINE: Array<[number, number]> = [[-117.67984, 33.96289], [-117.66939, 33.95429]];

describe('profileRequest', () => {
  it('posts the drawn line with the current dataset, time step, radius and interval', () => {
    const r = profileRequest(LINE, 'displacement', 5, 60, 30);
    expect(r.url.split('?')[0]).toBe('/profile');
    expect(r.init.method).toBe('POST');
    expect(JSON.parse(r.init.body as string)).toEqual({
      coords: LINE, dataset_name: 'displacement', time_index: 5,
      n_samples: 200, radius: 60, n_random: 5, sampling_interval: 30,
    });
  });
});

describe('profileRequest in catalog mode', () => {
  it('routes the profile to ?dataset=<id> like every other request', () => {
    window.history.replaceState({}, '', '/?dataset=prado-034-a-019');
    try {
      expect(profileRequest(LINE, 'displacement', 0, 0, 0).url).toBe('/profile?dataset=prado-034-a-019');
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });
});

describe('parseProfileResponse', () => {
  it('accepts a bare centre line', () => {
    expect(parseProfileResponse([{ dist: 0, value: 1 }])).toEqual({
      centre: [{ dist: 0, value: 1 }], median: null, samples: [], binned: false,
    });
  });

  it('accepts centre + median + samples and fills gaps', () => {
    expect(parseProfileResponse({ centre: [{ dist: 0, value: 1 }], binned: true, bin_width: 30 })).toEqual({
      centre: [{ dist: 0, value: 1 }], median: null, samples: [], binned: true, bin_width: 30,
    });
  });
});
