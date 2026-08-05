import { describe, expect, it } from 'vitest';
import { getPlanDetails } from '@/app/user/utils/plan';

// The prices, product ids and purchasable-product list this used to assert came
// from the Stripe catalogue, which this deployment does not have. What remains
// is the static copy the profile page renders: names, features, limits, and the
// fallback to free for an unrecognised plan.

describe('getPlanDetails', () => {
  it('names each plan', () => {
    expect(getPlanDetails('free').name).toBe('Free Plan');
    expect(getPlanDetails('plus').name).toBe('Plus Plan');
    expect(getPlanDetails('pro').name).toBe('Pro Plan');
    expect(getPlanDetails('purchase').name).toBe('Lifetime Plan');
  });

  it('reports the plan and its billing type', () => {
    expect(getPlanDetails('pro')).toMatchObject({ plan: 'pro', type: 'subscription' });
    expect(getPlanDetails('purchase')).toMatchObject({ plan: 'purchase', type: 'purchase' });
  });

  it('describes what each plan includes', () => {
    const free = getPlanDetails('free');
    const labels = free.features.map((f) => f.label);
    expect(labels).toContain('Cross-Platform Sync');
    expect(labels).toContain('AI Read Aloud');
    expect(Object.keys(free.limits ?? {}).length).toBeGreaterThan(0);
  });

  it('labels the interval, defaulting to monthly', () => {
    expect(getPlanDetails('plus').interval).toBe('month');
    expect(getPlanDetails('plus', 'year').interval).toBe('year');
    // A one-time purchase has no billing interval to label.
    expect(getPlanDetails('purchase').interval).toBe('lifetime');
  });

  it('falls back to free for an unrecognised plan', () => {
    expect(getPlanDetails('nonsense' as never).plan).toBe('free');
  });
});
