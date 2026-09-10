# RetainIO Retention & Discount Policy

## Discount Approval Thresholds

Every discount runs for a stated number of months of the customer's upcoming 12-month term,
beginning at their next renewal. A discount is therefore always recorded as a percentage AND
a duration — "10% for 5 months", never just "10%".

Approval is decided by what an offer gives away, not by its headline percentage. An Account
Manager may directly approve any offer whose total give-away is up to 10% of the account's
annual contract value. Anything larger requires Account Director approval, which mandates a
live biometric facial verification scan before execution.

The give-away is `monthly rate x discount percentage x months`. On a 60,000/year Enterprise
account that permits up to 6,000 — so 10% for 12 months and 20% for 6 months are both exactly
at the limit, because they cost the same. The previous rule gated on percentage alone, which
waved through a year-long 10% while stopping a two-month 15% that cost less than half as much.

Standard rates are 5,000/month for Enterprise, 2,500 for Pro and 1,000 for Basic.

No discount may be stacked on top of an already-active discount for the same account — a new
discount can only be applied once the prior one is removed or has run its months.

## Contract Terms And Renewal Timing

All customer contracts run on a 12-month term. Renewals are staggered across the portfolio
rather than falling on a common date, so at any point some accounts are weeks from renewal and
others are most of a year away. Urgency and risk are separate things: a 90%-risk account
renewing in ten months is a worse problem than a 60%-risk account renewing next week, but the
second one needs attention first.

A discount does not start on the day it is approved, and it does not take effect immediately.
It starts at the customer's next renewal date and covers the first N months of that upcoming
term, after which the account returns to the standard rate for the remainder of the term. An
account approved for a discount today with a renewal eight months away pays the standard rate
for those eight months first.

Worked example, Enterprise at 5,000/month with a 10% discount for 5 months:
5 months at 4,500 plus 7 months at 5,000 is 57,500 across the term, against a 60,000 list
price — a give-away of 2,500.

Because a discount is priced across the whole term, a monthly figure alone never describes what
an offer costs. Always state the term total and the give-away, not the reduced monthly rate.

## Choosing A Discount Duration

Duration is not a formality attached to a percentage. It is half of what an offer costs and
half of what it achieves, and the right duration differs by why the account is at risk.

**Price-led accounts do better with a short, deeper discount.** When money is the actual
objection, the goodwill lands almost immediately — the customer sees the concession and the
relationship resets. Extending it past that adds cost without adding much benefit.

**Technically frustrated accounts do better with a longer, shallower discount.** Money is not
their problem, so a discount does not fix anything; it buys patience while the real fix is
delivered. That patience has to last as long as the engineering work does, which is why a
three-month gesture rarely helps here and a walkthrough or escalation must accompany it.

**Two effects work against each other, which is why the longest discount is rarely the best
one.** The goodwill a discount buys saturates: most of it is bought in the first months. But
the longer a customer pays a reduced rate, the more that rate becomes the price they consider
normal — so the return to full rate at renewal lands harder the longer the discount ran. Past a
point, extending a discount costs margin *and* makes the next renewal more difficult.

The uplift model scores every combination of percentage and duration for a specific account and
recommends the strongest. The reasoning above is why its answer varies between accounts rather
than always recommending the largest, longest offer — take its recommendation, and use these
principles to explain it to the customer and to your Director.

## The Offer Window

A DISCOUNT can only be offered in the final 180 days before a customer's renewal. Outside that
window the percentage field is closed and the system will refuse a discount, whatever the
account's risk score says.

A product walkthrough is not restricted. It can be offered at any point in the contract, and
outside the discount window it is the lever available. That difference is deliberate: the
window exists because a discount spends money, and neither of the reasons below applies to an
intervention that costs nothing.

Two reasons, and the second one is easy to overlook.

The business reason: eleven months out you do not yet know whether an account is in trouble.
Usage dips and recovers, a bad quarter is followed by a good one, and a discount granted on a
temporary wobble is money given away for nothing. Waiting until the renewal is in sight means
the decision is made on a settled picture rather than a passing one.

The measurement reason: the moment an account enters this window, the system freezes a record
of what it looked like — usage, login frequency, support tickets, API utilisation, and the
three model scores. That frozen record is what the models are later trained on, paired with
whether the account actually renewed. Because no discount can exist before the window opens,
that measurement is guaranteed to describe the account BEFORE anything was done to it, for
every account alike. If offers could be made at any time, some accounts would be measured
before their discount and others after, and the two groups would no longer be comparable.

When an offer is approved, the record is re-taken at that moment instead. That is still before
the customer is affected — a discount does not take effect until the renewal — but it captures
what the approver was actually looking at when they decided.

If a customer says they are leaving, downgrading or upgrading BEFORE the window opens, the
record is taken at that moment rather than waiting for the window. Otherwise an account that
gave notice ten months out would not be measured until six months out — by which time it has
spent months acting on its decision, and the record would describe an account already winding
down, or ramping up, instead of the account as it stood when it decided. Once taken this way,
the record is kept even if a discount is later offered to change their mind, so that offer is
judged against the account as it was when they announced. Changing the intent, or cancelling
it, keeps the original record.

An account whose window has not opened yet is not an oversight. It is a deliberate hold, and
the form will say when the window opens — while still letting a walkthrough be arranged in the
meantime.

So for an account at real risk ten months from renewal, the answer is not "wait". It is to
offer the walkthrough now and revisit the discount when the window opens. An account whose
problem is a broken integration was never going to be fixed by money anyway.

## Why Risk Is Not Measured At The Renewal

It would be simpler to record an account's condition on the day its contract ended. The system
deliberately does not.

By the renewal date, a customer who is leaving has usually already stopped using the product.
Their usage is near zero and their login frequency has collapsed — not because those things
predicted the churn, but because they are part of it. A model trained on figures captured at
that point learns that an account with no usage is about to leave. That is perfectly true and
completely useless: by the time usage reaches zero there is nothing left to offer.

Measuring six months out catches the account while something can still be done. In practice
the difference is large. An account might sit at 35 minutes a day and moderate risk when its
window opens, and at 17 minutes a day and high risk by the renewal. The first figure is the one
worth learning from, because it is the one a manager could still have acted on.

## Walkthrough Offers

A product walkthrough session may be offered independently of a discount, or bundled together
with one. Walkthrough-only offers do not require Director approval regardless of account risk,
since no revenue commitment is involved. When a discount request that includes a walkthrough is
escalated to a Director, the walkthrough is approved or rejected as part of the same decision —
it cannot be approved separately from the discount it was bundled with.

## When To Use A Discount Versus A Walkthrough

If the customer's stated issue is about price, billing, or competitor cost comparisons, a
discount is the appropriate lever. If the customer's stated issue is a technical or product
problem — bugs, integration failures, performance — a discount alone rarely resolves the
underlying dissatisfaction; a walkthrough or engineering escalation should be prioritized,
alongside a discount only if the churn-risk model still predicts meaningful benefit from one.
If the signals disagree — for example the customer explicitly cites price but the model doesn't
predict a discount will help, or the customer describes a technical issue but the model does
predict discount benefit — escalate to a human for judgment rather than defaulting to either
lever automatically.

## Audit & Compliance

Every discount execution, request, approval, and rejection must be logged in the Audit Trail
with the approving user, verification method, and timestamp. Rejected discount requests must
include a director remark explaining the rejection reason. No retention action of any kind
should be taken on an account without a corresponding audit log entry.
