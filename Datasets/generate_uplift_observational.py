"""
Generates Datasets/uplift_observational.csv — the observational training data for
the discount-uplift T-learner.

Why this file exists
--------------------
The previous dataset had no generator in the repo, so its assumptions could not be
inspected or defended. It also had no notion of discount *duration*: the treatment
was a bare percentage, so the model could not rank "20% for 3 months" against
"10% for 12 months". This regenerates it with duration as part of the treatment.

The three assumptions that matter
---------------------------------
1. GOODWILL SATURATES IN DURATION. Most of the retention benefit of a discount is
   bought in its first few months; extending it buys progressively less. Modelled
   as 1 - exp(-months/tau).

2. A LONG DISCOUNT ANCHORS THE PRICE. The longer a customer pays the reduced rate,
   the more it becomes their reference price, and the worse the return to full
   rate lands at renewal. This penalty grows super-linearly in duration.

   (1) and (2) together are what give an *interior* optimum. Without (2), longer is
   always better, the model would recommend the maximum duration to everyone, and
   the whole duration dimension would be decorative. This is the load-bearing
   assumption of the design and should be stated as such in the write-up.

3. SEGMENTS DIFFER. A price-sensitive account responds strongly to a discount and
   anchors strongly; an account churning over technical friction barely responds to
   money at all — you cannot discount your way out of a broken integration. This is
   what makes the recommendation vary across the portfolio rather than collapsing to
   one answer.

Treatment assignment is deliberately CONFOUNDED — higher-risk accounts are more
likely to receive a discount, and a larger one, exactly as a real account team would
behave. That confounding is the reason an uplift model is needed rather than a naive
comparison of retained rates.

Not emitted, deliberately:
  MRR              — under standardised tier pricing it is a one-to-one relabelling
                     of Plan_Tier, so it carries no information the model does not
                     already have. Money is computed outside the model.
  Days_To_Renewal  — a calendar position rather than an account attribute: it changes
                     every day while the customer does nothing.
"""

import numpy as np
import pandas as pd

RNG = np.random.default_rng(20260902)
# A T-learner fits one model per arm, so the binding constraint is rows PER ARM,
# not rows overall. At 40,000 rows the twelve treated arms held ~1,500 binary
# outcomes each, which could not resolve CATE differences of a few percentage
# points - recovery of the true best arm came out below random. Generation is
# cheap, so the dataset is sized for the grid rather than the grid trimmed to fit.
N_ROWS = 180_000

DISCOUNT_PCTS = [0, 5, 10, 15, 20]
DISCOUNT_MONTHS = [3, 6, 12]          # 0 for the control arm
MONTHS_PER_TERM = 12

# Tier mix, roughly matching the previous dataset's proportions.
TIERS = ["Basic", "Pro", "Enterprise"]
TIER_P = [0.44, 0.35, 0.21]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


# ---------------------------------------------------------------- attributes
def make_accounts(n):
    tier = RNG.choice(TIERS, size=n, p=TIER_P)

    age = RNG.integers(1, 1101, size=n)
    usage = np.clip(RNG.gamma(shape=3.0, scale=12.0, size=n), 1, 123).round()
    tickets = RNG.poisson(2.4, size=n).clip(0, 11)
    api = np.clip(RNG.beta(2.2, 2.2, size=n), 0.0, 1.0)

    # Rarely-logging accounts skew to low usage, so derive it rather than sampling
    # independently — otherwise the model sees contradictory rows.
    login_score = usage / 60.0 + api * 0.5 + RNG.normal(0, 0.25, n)
    login = np.where(login_score > 0.95, "Daily", np.where(login_score > 0.45, "Weekly", "Rarely"))

    # Why this account is at risk. Drives how much money can help it.
    driver = RNG.choice(["technical_friction", "price_sensitive"], size=n, p=[0.54, 0.46])

    # Churn risk built from the attributes, so the covariates genuinely explain it.
    # Intercept and scale are tuned so the three risk bands come out roughly
    # balanced (~30/38/31). An earlier centring put 97% of rows in Low risk,
    # which starves the model of exactly the population it gets used on.
    z = (
        0.8
        + 1.9 * (tickets / 11.0)
        - 1.6 * (usage / 123.0)
        - 1.1 * api
        + 0.7 * (login == "Rarely")
        - 0.5 * (age / 1100.0)
    )
    churn = np.clip(sigmoid(z * 2.4) + RNG.normal(0, 0.05, n), 0.0, 1.0)

    # Sentiment risk weight: higher = more frustrated. Correlated with tickets.
    sentiment = np.clip(0.20 + 0.55 * (tickets / 11.0) + 0.35 * churn + RNG.normal(0, 0.12, n), 0.0, 1.0)

    # Fused score, mirroring the trained fusion meta-classifier's weighting.
    fused = np.clip(sigmoid(4.17 * churn + 1.67 * sentiment - 2.99), 0.0, 1.0)

    band = np.where(fused > 0.70, "High", np.where(fused > 0.30, "Medium", "Low"))

    return pd.DataFrame({
        "Account_Age_Days": age,
        "Daily_Usage_Mins": usage.astype(int),
        "Support_Tickets_90Days": tickets,
        "API_Utilization_Rate": api.round(3),
        "churn_proba": churn.round(3),
        "sentiment_score": sentiment.round(3),
        "fused_proba": fused.round(3),
        "Login_Frequency": login,
        "Plan_Tier": tier,
        "Dominant_SHAP_Driver": driver,
        "risk_band": band,
    })


# ---------------------------------------------------------------- treatment
def assign_treatment(df):
    """Observational, not randomised: riskier accounts attract bigger, longer
    discounts because that is what an account team actually does. This is the
    confounding the uplift model exists to correct for."""
    n = len(df)
    risk = df["fused_proba"].to_numpy()

    # Probability of any discount rises with risk.
    p_treat = np.clip(0.45 + 0.45 * risk, 0.0, 0.95)
    treated = RNG.random(n) < p_treat

    # Among treated, the size skews up with risk.
    pct = np.zeros(n, dtype=int)
    months = np.zeros(n, dtype=int)
    idx = np.flatnonzero(treated)
    for i in idx:
        w = np.array([1.0, 1.0, 1.0, 1.0]) + risk[i] * np.array([-0.55, -0.1, 0.45, 0.95])
        pct[i] = RNG.choice(DISCOUNT_PCTS[1:], p=np.clip(w, 0.05, None) / np.clip(w, 0.05, None).sum())
        wm = np.array([1.0, 1.0, 1.0]) + risk[i] * np.array([-0.35, 0.15, 0.55])
        months[i] = RNG.choice(DISCOUNT_MONTHS, p=np.clip(wm, 0.05, None) / np.clip(wm, 0.05, None).sum())

    df["discount_pct"] = pct
    df["discount_months"] = months
    return df


# ---------------------------------------------------------------- outcome
# Tuned so the best (pct, months) combination genuinely varies across segments
# rather than collapsing to the largest, longest discount for everyone.
#
# The key is that the two segments differ in the SHAPE of their response, not just
# its size. A multiplicative sensitivity term scales the curve without moving its
# peak, so it cannot change what the optimum is:
#
#   price_sensitive     money is the problem, so goodwill arrives fast (small tau)
#                       but the reduced rate becomes their reference price quickly,
#                       so anchoring bites hard -> a SHORT, DEEP discount wins
#
#   technical_friction  money is not the problem, so a discount only buys patience
#                       while the real fix lands; that takes sustained goodwill
#                       (large tau) and they anchor weakly -> a LONGER, SHALLOWER
#                       discount wins
TAU_BY_DRIVER = {"price_sensitive": 1.8, "technical_friction": 7.5}
ANCHOR_BY_DRIVER = {"price_sensitive": 1.30, "technical_friction": 0.22}

# Risk shifts the shape as well, not just its size:
#   URGENCY   a account on the brink needs the goodwill to land fast, so its
#             saturation constant shrinks - a short discount already does the work
#   EXPOSURE  and it has more to lose when the discount ends, so anchoring bites
#             harder the riskier the account
# Without these, the driver is binary and there are only two response shapes in
# the whole population; with them the optimum varies across the portfolio.
TAU_RISK_SHRINK = 0.65
ANCHOR_RISK_GROWTH = 1.5

PCT_SATURATION = 0.30   # depth saturates too: 20% is not four times as persuasive as 5%
ANCHOR_POWER = 1.6      # super-linear in duration
PCT_ANCHOR_POWER = 2.4  # a deep discount is missed sharply when it ends


def treatment_effect(df):
    pct = df["discount_pct"].to_numpy() / 20.0            # 0..1
    months_raw = df["discount_months"].to_numpy().astype(float)
    months = months_raw / MONTHS_PER_TERM
    risk = df["fused_proba"].to_numpy()
    price_led = (df["Dominant_SHAP_Driver"] == "price_sensitive").to_numpy()

    tau = np.where(price_led, TAU_BY_DRIVER["price_sensitive"], TAU_BY_DRIVER["technical_friction"])
    tau = np.maximum(tau * (1.0 - TAU_RISK_SHRINK * risk), 0.3)

    anchor_w = np.where(price_led, ANCHOR_BY_DRIVER["price_sensitive"], ANCHOR_BY_DRIVER["technical_friction"])
    anchor_w = anchor_w * (1.0 + ANCHOR_RISK_GROWTH * risk)

    # Money only helps an account whose problem is money.
    sensitivity = np.where(price_led, 1.0, 0.42)

    # Headroom: a nearly-safe account has little left to gain.
    headroom = risk * (1.0 - 0.35 * risk)

    goodwill = (1.0 - np.exp(-months_raw / tau)) * (1.0 - np.exp(-pct / PCT_SATURATION))
    anchoring = anchor_w * np.power(pct, PCT_ANCHOR_POWER) * np.power(months, ANCHOR_POWER)

    return 1.15 * sensitivity * headroom * (goodwill - anchoring)


def make_outcome(df):
    base = np.clip(0.97 - 0.86 * df["fused_proba"].to_numpy(), 0.02, 0.98)
    p = np.clip(base + treatment_effect(df), 0.01, 0.99)
    df["Retained"] = (RNG.random(len(df)) < p).astype(int)
    return df


def main():
    df = make_accounts(N_ROWS)
    df = assign_treatment(df)
    df = make_outcome(df)
    df.insert(0, "customer_id", [f"CUST-{i:06d}" for i in range(1, len(df) + 1)])

    out = "Datasets/uplift_observational.csv"
    df.to_csv(out, index=False)
    print(f"wrote {out}: {len(df):,} rows, {len(df.columns)} columns")
    print(f"arms: {df.groupby(['discount_pct','discount_months']).size().shape[0]}")


if __name__ == "__main__":
    main()
