"""McNemar test: is the fusion model's improvement over the churn model alone real?

late_fusion.ipynb reports, on the 376-customer test set, F1 0.8195 for the churn model alone
(at its tuned threshold, 0.56) against 0.8284 for the fusion model (Stacking, at its tuned
threshold, 0.54). That notebook saves both sets of predictions, customer by customer, to
Datasets/late_fusion_predictions.csv, so this runs on exactly the predictions behind the
reported numbers. Nothing is refitted.

McNemar looks only at the customers the two models disagree about:
    b = churn model right, fusion wrong
    c = churn model wrong, fusion right
If fusion were no better, each disagreement would be equally likely to go either way, so
c ~ Binomial(b + c, 0.5). The exact two-sided binomial p-value is the result; the
continuity-corrected chi-square version is shown beside it.

McNemar compares how often each model is RIGHT on the same customers - accuracy - not F1. So a
paired bootstrap interval for the F1 difference is added, resampling customers with both
models' predictions kept together.

Before any of that, the saved predictions are re-created from the model files the app uses,
to confirm they still describe the production models.

    python fusion_mcnemar_test.py
"""
import json
import warnings
from datetime import date

import joblib
import numpy as np
import pandas as pd
from scipy.stats import binomtest, chi2
from sklearn.exceptions import InconsistentVersionWarning

# The churn pipeline was saved under a newer scikit-learn. Step 1 checks its predictions
# directly, which is a stronger check than the warning.
warnings.filterwarnings('ignore', category=InconsistentVersionWarning)

PREDICTIONS = 'Datasets/late_fusion_predictions.csv'
RESULTS = 'Datasets/late_fusion_mcnemar.json'
TAB_COLS = ['Account_Age_Days', 'Daily_Usage_Mins', 'Support_Tickets_90Days',
            'API_Utilization_Rate', 'Support_Ticket_Friction', 'Login_Frequency', 'Plan_Tier']
SENT_SCORE = {'Frustrated': 1.0, 'Neutral': 0.5, 'Satisfied': 0.0}
BOOTSTRAPS, SEED, ALPHA = 10_000, 42, 0.05

df = pd.read_csv(PREDICTIONS)
y = df['Actual_Churn'].to_numpy()
churn_thr = json.load(open('models/churn_threshold.json'))['threshold']
fusion_thr = json.load(open('models/fusion_config.json'))['threshold']

# ── 1. The saved predictions still describe the production models ───────────────────────────
test = pd.read_csv('Datasets/test_churn.csv')
assert (test['Customer_ID'].to_numpy() == df['Customer_ID'].to_numpy()).all(), 'test rows out of step'
churn_model = joblib.load('models/churn_gradient_boosting.pkl')
sent_model = joblib.load('models/sentiment_naive_bayes.pkl')
meta_model = joblib.load('models/fusion_meta_classifier.pkl')

churn_p = churn_model.predict_proba(test[TAB_COLS])[:, 1]
sent_s = sent_model.predict_proba(df['Review']) @ np.array([SENT_SCORE[c] for c in sent_model.classes_])
fusion_p = meta_model.predict_proba(np.column_stack([churn_p, sent_s]))[:, 1]

# The file stores probabilities to 4 decimal places, so agreement means within rounding.
checks = {
    'churn probabilities (to 4 dp)': float(np.abs(churn_p - df['Churn_Proba_Model']).max()) <= 5e-5 + 1e-9,
    'fusion probabilities (to 4 dp)': float(np.abs(fusion_p - df['Stacking (LR meta)_Proba']).max()) <= 5e-5 + 1e-9,
    f'churn predictions at {churn_thr}': bool(((churn_p >= churn_thr).astype(int) == df['Churn_Pred_Model']).all()),
    f'fusion predictions at {fusion_thr}': bool(((fusion_p >= fusion_thr).astype(int) == df['Stacking (LR meta)_Pred_Tuned']).all()),
    'fusion predictions at 0.5': bool(((fusion_p >= 0.5).astype(int) == df['Stacking (LR meta)_Pred_Default']).all()),
}
print('1. Saved predictions re-created from the production model files')
for what, ok in checks.items():
    print(f'   {"match" if ok else "MISMATCH"}  {what}')
if not all(checks.values()):
    raise SystemExit('The saved predictions no longer match the model files - re-run late_fusion.ipynb first.')


# ── 2. McNemar, and a paired bootstrap for F1 ───────────────────────────────────────────────
def f1_of(pred, truth):
    tp = ((pred == 1) & (truth == 1)).sum(-1)
    fp = ((pred == 1) & (truth == 0)).sum(-1)
    fn = ((pred == 0) & (truth == 1)).sum(-1)
    return 2 * tp / (2 * tp + fp + fn)


rng = np.random.default_rng(SEED)
boot = rng.integers(0, len(y), size=(BOOTSTRAPS, len(y)))


def compare(name_a, pred_a, name_b, pred_b):
    a_ok, b_ok = pred_a == y, pred_b == y
    b = int((a_ok & ~b_ok).sum())            # A right, B wrong
    c = int((~a_ok & b_ok).sum())            # A wrong, B right
    n = b + c
    p_exact = float(binomtest(c, n, 0.5).pvalue) if n else 1.0
    stat = (abs(b - c) - 1) ** 2 / n if n else 0.0
    p_chi2 = float(chi2.sf(stat, 1)) if n else 1.0

    d_f1 = f1_of(pred_b[boot], y[boot]) - f1_of(pred_a[boot], y[boot])
    lo, hi = np.percentile(d_f1, [2.5, 97.5])
    return {
        'model_a': name_a, 'model_b': name_b,
        'accuracy_a': round(float(a_ok.mean()), 4), 'accuracy_b': round(float(b_ok.mean()), 4),
        'f1_a': round(float(f1_of(pred_a, y)), 4), 'f1_b': round(float(f1_of(pred_b, y)), 4),
        'both_right': int((a_ok & b_ok).sum()), 'both_wrong': int((~a_ok & ~b_ok).sum()),
        'only_a_right': b, 'only_b_right': c,
        'mcnemar_exact_p': round(p_exact, 4),
        'mcnemar_chi2_cc': round(float(stat), 4), 'mcnemar_chi2_cc_p': round(p_chi2, 4),
        'f1_difference': round(float(f1_of(pred_b, y) - f1_of(pred_a, y)), 4),
        'f1_difference_95ci': [round(float(lo), 4), round(float(hi), 4)],
        'share_of_bootstraps_where_b_has_higher_f1': round(float((d_f1 > 0).mean()), 4),
        'significant_at_0.05': p_exact < ALPHA,
    }


churn_pred = df['Churn_Pred_Model'].to_numpy()
comparisons = [
    compare(f'Churn model alone (threshold {churn_thr})', churn_pred,
            f'Fusion, Stacking (threshold {fusion_thr})', df['Stacking (LR meta)_Pred_Tuned'].to_numpy()),
    compare(f'Churn model alone (threshold {churn_thr})', churn_pred,
            'Fusion, Stacking (threshold 0.5)', df['Stacking (LR meta)_Pred_Default'].to_numpy()),
]

print(f'\n2. McNemar test on the {len(y)} test customers ({int(y.sum())} churned), '
      f'with a {BOOTSTRAPS:,}-resample paired bootstrap for F1')
for r in comparisons:
    print(f'\n   {r["model_a"]}  vs  {r["model_b"]}')
    print(f'     accuracy {r["accuracy_a"]:.4f} vs {r["accuracy_b"]:.4f}      F1 {r["f1_a"]:.4f} vs {r["f1_b"]:.4f}')
    print(f'     both right {r["both_right"]}, both wrong {r["both_wrong"]}, '
          f'only the churn model right {r["only_a_right"]}, only fusion right {r["only_b_right"]}')
    print(f'     McNemar exact p = {r["mcnemar_exact_p"]:.4f}   '
          f'(chi-square with continuity correction {r["mcnemar_chi2_cc"]:.3f}, p = {r["mcnemar_chi2_cc_p"]:.4f})')
    print(f'     F1 difference {r["f1_difference"]:+.4f}, 95% CI [{r["f1_difference_95ci"][0]:+.4f}, '
          f'{r["f1_difference_95ci"][1]:+.4f}]; fusion ahead in '
          f'{r["share_of_bootstraps_where_b_has_higher_f1"]:.0%} of resamples')
    verdict = ('SIGNIFICANT at 0.05' if r['significant_at_0.05'] else
               'NOT significant at 0.05 - the difference is within what chance alone produces')
    print(f'     -> {verdict}')

json.dump({
    'run_on': date.today().isoformat(),
    'test_customers': int(len(y)), 'churned': int(y.sum()),
    'predictions_file': PREDICTIONS,
    'predictions_match_production_models': checks,
    'bootstrap_resamples': BOOTSTRAPS, 'seed': SEED,
    'comparisons': comparisons,
}, open(RESULTS, 'w'), indent=2)
print(f'\nSaved: {RESULTS}')
