"""
Folds the real feedback collected by the app back into the models.

    python Datasets/retrain_with_outcomes.py            # retrain and overwrite
    python Datasets/retrain_with_outcomes.py --dry-run  # train and report, change nothing

Reads Datasets/feedback/*.csv (written by retainio/prisma/export-renewal-outcomes.ts),
appends those rows to a COPY of each model's original training set, refits using the same
pipeline and hyperparameters the notebooks used, and — only if the new model is not worse
on the untouched test split — replaces models/*.pkl.

Three commitments this script makes, and why:

1. THE ORIGINAL DATASETS ARE NEVER MODIFIED. Merging happens in memory. Losing the ability
   to reproduce the current model would be a bad trade for a handful of rows.

2. THE PREVIOUS MODEL IS BACKED UP before being replaced, to models/backup_<timestamp>/.
   Overwriting is what was asked for; making it irreversible was not.

3. A RETRAIN THAT MAKES A MODEL WORSE IS REFUSED. Nine renewals a year cannot improve a
   model fitted on thousands of rows, but they can degrade one — and since these models
   serve live predictions, a silent regression is the failure that matters. Each model is
   scored on the same held-out test split before and after.

THE HONEST LIMITATION, which belongs in the write-up: nine accounts produce roughly nine
renewals a year, and under auto-renewal nearly all carry the same label. Against 180,000
synthetic uplift rows that is about 1 in 20,000. This pipeline works; at this data volume
it cannot demonstrate an improvement, and the counts printed below say so plainly.
"""
import argparse
import json
import shutil
import sys
import warnings
from datetime import datetime, timedelta
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

SEED = 42
ROOT = Path(__file__).resolve().parent.parent
DATASETS = ROOT / "Datasets"
FEEDBACK = DATASETS / "feedback"
MODELS = ROOT / "models"

from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score, accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.utils.class_weight import compute_sample_weight


# Twice a year. See the cadence check in main() for why this is enforced rather than
# left to judgement.
RETRAIN_INTERVAL_DAYS = 182
PROVENANCE = MODELS / "retrain_provenance.json"


def last_run_at():
    """When models were last actually replaced. Dry runs and refusals do not count —
    only a run that changed what the app serves resets the clock."""
    if not PROVENANCE.exists():
        return None
    try:
        data = json.loads(PROVENANCE.read_text(encoding="utf-8"))
        if not any(r.get("written") for r in data.get("results", [])):
            return None
        return datetime.fromisoformat(data["run_at"])
    except Exception:
        return None


def load_feedback(name):
    path = FEEDBACK / name
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_csv(path)
    return df


def banner(title):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def report_mix(real, synthetic, label):
    total = real + synthetic
    share = (real / total * 100) if total else 0
    print(f"  {label}: {synthetic:,} synthetic + {real:,} real = {total:,}  ({share:.4f}% real)")
    return {"real": int(real), "synthetic": int(synthetic), "real_share_pct": round(share, 6)}


# ── Churn ───────────────────────────────────────────────────────────────────
# churn_model.ipynb: drop Name/Email/Review, derive Support_Ticket_Friction, 70/15/15
# stratified split at SEED=42, StandardScaler + OneHotEncoder, GradientBoosting(200) with
# balanced sample weights.
NUM_FEATURES = ["Account_Age_Days", "Daily_Usage_Mins", "Support_Tickets_90Days",
                "API_Utilization_Rate", "Support_Ticket_Friction"]
CAT_FEATURES = ["Login_Frequency", "Plan_Tier"]


def retrain_churn(real_df, dry_run):
    banner("CHURN MODEL")
    # The notebook's own splits, saved to disk when it ran. Training on `train` and scoring
    # on `test` is what makes the before/after comparison meaningful: the model currently
    # in models/ never saw test_churn.csv either, so both are judged on the same unseen
    # rows. Building a fresh split here instead let the CURRENT model be scored partly on
    # its own training data, which made it look better than the retrain by ~12 points.
    train = pd.read_csv(DATASETS / "train_churn.csv")
    test = pd.read_csv(DATASETS / "test_churn.csv")
    n_synth = len(train)

    if not real_df.empty:
        add = real_df.drop(columns=[c for c in ["is_assumed"] if c in real_df.columns]).copy()
        add["Support_Ticket_Friction"] = add["Support_Tickets_90Days"] / (add["Daily_Usage_Mins"] + 1)
        train = pd.concat([train, add], ignore_index=True)
    mix = report_mix(len(train) - n_synth, n_synth, "training rows")
    print(f"  held-out test rows: {len(test):,} (unseen by both models)")

    X_train, y_train = train[NUM_FEATURES + CAT_FEATURES], train["Churn"].astype(int)
    X_test, y_test = test[NUM_FEATURES + CAT_FEATURES], test["Churn"].astype(int)

    pre = ColumnTransformer([
        ("num", StandardScaler(), NUM_FEATURES),
        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CAT_FEATURES),
    ])
    pipe = Pipeline([("prep", pre), ("clf", GradientBoostingClassifier(n_estimators=200, random_state=SEED))])
    pipe.fit(X_train, y_train, clf__sample_weight=compute_sample_weight("balanced", y_train))

    return finalise("churn_gradient_boosting.pkl", pipe, X_test, y_test, mix, dry_run)


def retrain_sentiment(real_df, dry_run):
    banner("SENTIMENT MODEL")
    train = pd.read_csv(DATASETS / "train_sentiment.csv")
    test = pd.read_csv(DATASETS / "test_sentiment.csv")
    n_synth = len(train)

    if not real_df.empty:
        add = real_df[["review_text", "sentiment"]].copy()
        add["text_length"] = add["review_text"].str.len()
        train = pd.concat([train, add], ignore_index=True)
    mix = report_mix(len(train) - n_synth, n_synth, "training rows")
    print(f"  held-out test rows: {len(test):,} (unseen by both models)")

    pipe = Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), max_features=5000,
                                  stop_words="english", sublinear_tf=True)),
        ("clf", MultinomialNB(alpha=0.1)),
    ])
    pipe.fit(train["review_text"], train["sentiment"])

    return finalise("sentiment_naive_bayes.pkl", pipe, test["review_text"], test["sentiment"],
                    mix, dry_run, multiclass=True)


def retrain_fusion(uplift_real, dry_run):
    banner("FUSION MODEL")
    # late_fusion.ipynb fits the meta-classifier on the VALIDATION fold, not the training
    # fold: those rows are out-of-sample for the churn model, so the probabilities it sees
    # are as over-confident as they will be in production. Reproduced here rather than
    # simplified, or the meta-model would learn to trust churn more than it should.
    churn_model = joblib.load(MODELS / "churn_gradient_boosting.pkl")
    sent_model = joblib.load(MODELS / "sentiment_naive_bayes.pkl")

    lookup = pd.read_csv(DATASETS / "Churn.csv", usecols=["Customer_ID", "Review"])
    val = pd.read_csv(DATASETS / "validation_churn.csv").merge(lookup, on="Customer_ID", how="left")
    test = pd.read_csv(DATASETS / "test_churn.csv").merge(lookup, on="Customer_ID", how="left")

    SENT_SCORE = {"Frustrated": 1.0, "Neutral": 0.5, "Satisfied": 0.0}

    def components(df):
        churn_p = churn_model.predict_proba(df[NUM_FEATURES + CAT_FEATURES])[:, 1]
        text = df["Review"].fillna("")
        class_scores = np.array([SENT_SCORE[c] for c in sent_model.classes_])
        sent_s = sent_model.predict_proba(text) @ class_scores
        return np.column_stack([churn_p, sent_s])

    meta_X_val, y_val = components(val), val["Churn"].astype(int).to_numpy()
    meta_X_test, y_test = components(test), test["Churn"].astype(int).to_numpy()
    n_synth = len(meta_X_val)

    n_real = 0
    if not uplift_real.empty:
        r = uplift_real[["churn_proba", "sentiment_score", "Retained"]].dropna()
        meta_X_val = np.vstack([meta_X_val, r[["churn_proba", "sentiment_score"]].to_numpy()])
        y_val = np.concatenate([y_val, (1 - r["Retained"]).astype(int).to_numpy()])
        n_real = len(r)
    mix = report_mix(n_real, n_synth, "meta-training rows (validation fold)")
    print(f"  held-out test rows: {len(meta_X_test):,} (unseen by both models)")

    clf = LogisticRegression(random_state=SEED, class_weight="balanced")
    clf.fit(meta_X_val, y_val)
    return finalise("fusion_meta_classifier.pkl", clf, meta_X_test, y_test, mix, dry_run)


def finalise(filename, new_model, X_test, y_test, mix, dry_run, multiclass=False):
    """Score the new model against the one in use, and replace only if it holds up."""
    target = MODELS / filename
    old = joblib.load(target) if target.exists() else None

    def score(m):
        if m is None:
            return None
        pred = m.predict(X_test)
        out = {"accuracy": accuracy_score(y_test, pred),
               "f1": f1_score(y_test, pred, average="macro" if multiclass else "binary")}
        if not multiclass and hasattr(m, "predict_proba"):
            out["roc_auc"] = roc_auc_score(y_test, m.predict_proba(X_test)[:, 1])
        return out

    before, after = score(old), score(new_model)
    print(f"\n  {'metric':<10} {'current':>10} {'retrained':>10}   change")
    for k in after:
        b = before.get(k) if before else None
        delta = f"{after[k] - b:+.4f}" if b is not None else "n/a"
        print(f"  {k:<10} {(f'{b:.4f}' if b is not None else '—'):>10} {after[k]:>10.4f}   {delta}")

    # A tolerance, not a strict floor: refits shift by tiny amounts for reasons unrelated
    # to the new rows, and blocking on noise would make the pipeline unusable.
    regressed = before is not None and (after["f1"] < before["f1"] - 0.01)
    if regressed:
        print(f"\n  REFUSED: macro-F1 dropped by more than 0.01. {filename} left untouched.")
        print(f"  These models serve live predictions; a silent regression is the failure that matters.")
        return {"model": filename, "written": False, "reason": "regression", "mix": mix,
                "before": before, "after": after}

    if dry_run:
        print(f"\n  dry run — {filename} not written")
        return {"model": filename, "written": False, "reason": "dry-run", "mix": mix,
                "before": before, "after": after}

    if old is not None:
        backup_dir = MODELS / f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        backup_dir.mkdir(exist_ok=True)
        shutil.copy2(target, backup_dir / filename)
        print(f"\n  previous model backed up to models/{backup_dir.name}/{filename}")
    joblib.dump(new_model, target)
    print(f"  written: models/{filename}")
    return {"model": filename, "written": True, "mix": mix, "before": before, "after": after}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="train and report without writing any file")
    ap.add_argument("--force", action="store_true", help="retrain before the 6-month interval has elapsed")
    args = ap.parse_args()

    # Retraining is a SCHEDULED, twice-a-year operation, not something to run whenever a
    # correction lands. Two reasons it is enforced here rather than left to discipline:
    #
    #   Statistical — roughly nine renewals a year means a month's feedback is one or two
    #   rows. Refitting on that produces a model indistinguishable from the last one while
    #   still carrying the risk of a bad refit reaching live predictions.
    #
    #   Operational — every run replaces the models the app is serving from. Rare, planned
    #   changes can be reviewed; frequent ones stop being looked at.
    last = last_run_at()
    if last and not args.force and not args.dry_run:
        elapsed = (datetime.now() - last).days
        if elapsed < RETRAIN_INTERVAL_DAYS:
            due = last + timedelta(days=RETRAIN_INTERVAL_DAYS)
            print(f"\nLast retrain: {last:%d %b %Y} ({elapsed} days ago)")
            print(f"Next due:     {due:%d %b %Y} ({RETRAIN_INTERVAL_DAYS - elapsed} days away)")
            print("\nModels retrain every 6 months. Nothing has been changed.")
            print("  --dry-run   see what a retrain would do, without writing")
            print("  --force     retrain now anyway")
            sys.exit(0)

    if not FEEDBACK.exists():
        print("No Datasets/feedback/ directory. Run:")
        print("  cd retainio && npx tsx prisma/export-renewal-outcomes.ts")
        sys.exit(1)

    churn_real = load_feedback("churn_real.csv")
    sent_real = load_feedback("sentiment_real.csv")
    uplift_real = load_feedback("uplift_real.csv")

    print(f"\nFeedback collected: {len(churn_real)} renewal(s), {len(sent_real)} sentiment label(s)")
    if not churn_real.empty and "is_assumed" in churn_real:
        n_assumed = int(churn_real["is_assumed"].sum())
        print(f"  of those renewals, {n_assumed} were ASSUMED (auto-renewed, nobody confirmed)")

    results = [
        retrain_churn(churn_real, args.dry_run),
        retrain_sentiment(sent_real, args.dry_run),
        retrain_fusion(uplift_real, args.dry_run),
    ]

    banner("UPLIFT MODEL")
    if uplift_real.empty:
        print("  no real rows yet — nothing to merge")
    else:
        merged = DATASETS / "uplift_observational_with_real.csv"
        synth = pd.read_csv(DATASETS / "uplift_observational.csv")
        synth["is_real"] = 0
        real = uplift_real.drop(columns=[c for c in ["is_assumed"] if c in uplift_real.columns]).copy()
        real["is_real"] = 1
        combined = pd.concat([synth, real], ignore_index=True)
        report_mix(len(real), len(synth), "training rows")
        # uplift_model.ipynb trains on this file whenever it exists, so writing it IS a change:
        # a dry run that left one behind would alter what the next notebook run learns from.
        if args.dry_run:
            print(f"\n  dry run - Datasets/{merged.name} not written")
        else:
            combined.to_csv(merged, index=False)
            print(f"\n  written: Datasets/{merged.name}")

        # The notebook trains one model per arm and drops any real row whose arm is not on its
        # grid, so name those renewals here: usually an offer made before the form was limited
        # to the grid, or a 0% offer stored with a duration - a second copy of the control arm,
        # which is 0% with NO duration.
        grid = json.loads((MODELS / "uplift_config.json").read_text())
        pcts, months = real["discount_pct"], real["discount_months"]
        on_grid = ((pcts == 0) & (months == 0)) | (
            pcts.isin(grid["treatment_pcts"]) & months.isin(grid["treatment_months"]))
        if (~on_grid).any():
            arms = sorted(set(zip(pcts[~on_grid], months[~on_grid])))
            print(f"\n  WARNING: {int((~on_grid).sum())} real row(s) are off the model's grid and the")
            print("  notebook will drop them: " + ", ".join(f"{p}% for {m} months" for p, m in arms))
    print("\n  The uplift model fits one model per treatment arm, with its own propensity model,")
    print("  and uplift_model.ipynb IS that training code. Reimplementing it here would create a")
    print("  second definition free to drift from the first, so this script prepares the merged")
    print("  dataset and the notebook remains the one trainer - it reads the merged file")
    print("  automatically whenever it exists.")

    banner("SUMMARY")
    for r in results:
        state = "written" if r["written"] else f"not written ({r['reason']})"
        print(f"  {r['model']:<34} {state}")
    print("\n  Real data is a rounding error against the synthetic sets, so predictions are")
    print("  expected to be effectively unchanged. That is the arithmetic, not a fault: the")
    print("  deliverable is a working pipeline, not a demonstrated improvement.")

    # This file is also how the six-month rule knows when the models were last replaced
    # (last_run_at). A dry run overwrote it, erasing that record, so the next real run went
    # ahead however recently the models had been retrained. A dry run now leaves it alone.
    if args.dry_run:
        print("\n  dry run - models/retrain_provenance.json left as it was\n")
        return
    (MODELS / "retrain_provenance.json").write_text(json.dumps({
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "next_due": (datetime.now() + timedelta(days=RETRAIN_INTERVAL_DAYS)).date().isoformat(),
        "retrain_interval_days": RETRAIN_INTERVAL_DAYS,
        "results": results,
    }, indent=2, default=float), encoding="utf-8")
    print(f"\n  provenance written to models/retrain_provenance.json\n")


if __name__ == "__main__":
    main()
