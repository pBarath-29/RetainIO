"""
Real model-serving bridge for RetainIO's AI Retention Advisor.

Wraps the actual trained pipeline (models/churn_gradient_boosting.pkl, produced by
churn_model.ipynb) so the chatbot's Risk Analysis and SHAP Explanation tools call a real
model instead of echoing pre-authored demo numbers. Run standalone:

    uvicorn model_service.app:app --port 8000

The Node server calls this over HTTP and falls back to its existing demo-data behavior if
this service isn't running — see server.ts's get_risk_analysis / get_shap_explanation tools.
"""
import json
import os

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(BASE_DIR, "models", "churn_gradient_boosting.pkl")
THRESHOLD_PATH = os.path.join(BASE_DIR, "models", "churn_threshold.json")
CSV_PATH = os.path.join(BASE_DIR, "Datasets", "Churn.csv")
SENTIMENT_MODEL_PATH = os.path.join(BASE_DIR, "models", "sentiment_naive_bayes.pkl")
UPLIFT_MODEL_PATH = os.path.join(BASE_DIR, "models", "uplift_pooled_t_duration.pkl")
FUSION_MODEL_PATH = os.path.join(BASE_DIR, "models", "fusion_meta_classifier.pkl")

# late_fusion.ipynb's SENT_SCORE mapping — the fusion meta-classifier's second
# input is NOT the -1..1 score /predict/sentiment returns for display. It's this
# separate probability-weighted expectation: 1.0 = certainly Frustrated, 0.0 =
# certainly Satisfied. Same three probabilities, different weighted combination.
SENTIMENT_RISK_WEIGHTS = {"Frustrated": 1.0, "Neutral": 0.5, "Satisfied": 0.0}

# ── Face recognition ────────────────────────────────────────────────────────
# This service only turns an image into an embedding; it stores nothing. The
# vectors live in Postgres (face_samples) and server.ts owns the matching, so
# enrolled faces survive a redeploy instead of sitting on an ephemeral disk.
# The 0.4 cosine-distance match threshold lives there too.
FACE_SIZE = (160, 160)  # FaceNet's expected input size

NUM_FEATURES = [
    "Account_Age_Days", "Daily_Usage_Mins", "Support_Tickets_90Days",
    "API_Utilization_Rate", "Support_Ticket_Friction",
]
CAT_FEATURES = ["Login_Frequency", "Plan_Tier"]

app = FastAPI(title="RetainIO Model Bridge")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


class ChurnFeatures(BaseModel):
    Account_Age_Days: int
    Daily_Usage_Mins: int
    Support_Tickets_90Days: int
    API_Utilization_Rate: float
    Login_Frequency: str  # "Daily" | "Weekly" | "Rarely" (exact training vocabulary)
    Plan_Tier: str  # "Enterprise" | "Pro" | "Basic"


class SentimentInput(BaseModel):
    text: str


class SentimentProbabilities(BaseModel):
    Frustrated: float
    Neutral: float
    Satisfied: float


class FusionInput(BaseModel):
    churn_proba: float
    sentiment_probabilities: SentimentProbabilities


class UpliftFeatures(BaseModel):
    Account_Age_Days: int
    Daily_Usage_Mins: int
    Support_Tickets_90Days: int
    API_Utilization_Rate: float
    churn_proba: float
    sentiment_score: float
    fused_proba: float
    # MRR and Days_To_Renewal were removed when the model was retrained: under
    # standardised tier pricing MRR is a one-to-one relabelling of Plan_Tier, and
    # Days_To_Renewal is a calendar position rather than an account attribute --
    # measurably carrying no signal.
    Login_Frequency: str  # "Daily" | "Weekly" | "Rarely"
    Plan_Tier: str  # "Basic" | "Pro" | "Enterprise"
    risk_band: str  # "High" | "Medium" | "Low" — no " Risk" suffix, unlike the churn endpoint's risk_band
    # WHY the account is at risk. Decides the shape of the best offer: a price-led
    # account wants a short sharp discount, technical friction wants a long
    # sustained one. Without it the model cannot rank durations at all.
    Dominant_SHAP_Driver: str  # "price_sensitive" | "technical_friction"


def build_row(f: ChurnFeatures) -> pd.DataFrame:
    friction = f.Support_Tickets_90Days / (f.Daily_Usage_Mins + 1)
    return pd.DataFrame([{
        "Account_Age_Days": f.Account_Age_Days,
        "Daily_Usage_Mins": f.Daily_Usage_Mins,
        "Support_Tickets_90Days": f.Support_Tickets_90Days,
        "API_Utilization_Rate": f.API_Utilization_Rate,
        "Support_Ticket_Friction": friction,
        "Login_Frequency": f.Login_Frequency,
        "Plan_Tier": f.Plan_Tier,
    }])


print("Loading churn model pipeline...")
pipe = joblib.load(MODEL_PATH)
clf = pipe.named_steps["clf"]
prep = pipe.named_steps["prep"]

with open(THRESHOLD_PATH) as fh:
    THRESHOLD = json.load(fh)["threshold"]

# Rebuild an equivalent SHAP background sample from the same raw training data the notebook
# used (Datasets/Churn.csv) — the notebook's own X_val_transformed isn't saved as an artifact,
# but it's cheaply reproducible from the same source. The CSV has a known data quirk (a stray
# duplicate header row) that makes pandas read every column as `object`; coerce + drop bad rows
# the same way churn_model.ipynb's own loading cell does.
print("Rebuilding SHAP background sample from Datasets/Churn.csv...")
raw_df = pd.read_csv(CSV_PATH)
raw_df = raw_df[raw_df["Churn"].astype(str).isin(["0", "1"])].reset_index(drop=True)
for col in ["Account_Age_Days", "Daily_Usage_Mins", "Support_Tickets_90Days", "API_Utilization_Rate"]:
    raw_df[col] = pd.to_numeric(raw_df[col], errors="coerce")
raw_df = raw_df.dropna(subset=["Account_Age_Days", "Daily_Usage_Mins", "Support_Tickets_90Days", "API_Utilization_Rate"]).reset_index(drop=True)
raw_df["Support_Ticket_Friction"] = raw_df["Support_Tickets_90Days"] / (raw_df["Daily_Usage_Mins"] + 1)

sample_df = raw_df[NUM_FEATURES + CAT_FEATURES].sample(n=min(100, len(raw_df)), random_state=42)
background = prep.transform(sample_df)

cat_feature_names = prep.named_transformers_["cat"].get_feature_names_out(CAT_FEATURES).tolist()
ALL_FEATURE_NAMES = NUM_FEATURES + cat_feature_names

explainer = shap.Explainer(clf, background, feature_names=ALL_FEATURE_NAMES)
print(f"Ready. Explainer type: {type(explainer).__name__}, threshold: {THRESHOLD}")

# Real sentiment model — a plain TfidfVectorizer -> MultinomialNB pipeline trained
# directly on review text (see models/fusion_config.json: best_sentiment_model).
# Unlike the churn pipeline it has no engineered numeric features to reconstruct;
# it takes the raw ticket/email text and nothing else. Trained on exactly 3
# classes — Frustrated / Neutral / Satisfied — not the 5-label set the frontend's
# SentimentType currently allows.
print("Loading sentiment model pipeline...")
sentiment_pipe = joblib.load(SENTIMENT_MODEL_PATH)
sentiment_classes = sentiment_pipe.named_steps["clf"].classes_
print(f"Ready. Sentiment classes: {list(sentiment_classes)}")

# Real uplift (causal CATE) model — a T-learner: one RandomForestRegressor per
# discount tier (0/5/10/15/20), each predicting retention probability under
# that tier from the same 12 structured features. CATE for a tier is simply
# that tier's predicted retention minus the tier-0 (no discount) baseline —
# no text classification involved; this is what server.ts's account-level
# uplift endpoint calls instead of the frontend's old hand-typed formula.
print("Loading uplift model bundle...")
uplift_bundle = joblib.load(UPLIFT_MODEL_PATH)
# The grid is 13 arms keyed "<pct>_<months>" ("0_0" is the control), since the model
# was retrained to rank a discount's DURATION as well as its depth.
#
# The notebook picks between a T-learner and an X-learner on validation Qini, so the
# bundle can be either shape and this has to read both. Hardcoding one meant the
# service broke silently the moment the notebook's comparison chose the other.
#
#   T-learner  {arm: regressor}                  CATE = mu_arm(x) - mu_control(x)
#   X-learner  {mu, propensity, tau1, tau0}      CATE = g*tau0 + (1-g)*tau1
uplift_models = uplift_bundle["model"]
UPLIFT_KIND = uplift_bundle["kind"]
uplift_preprocessor = uplift_bundle["preprocessor"]
UPLIFT_FEATURE_COLUMNS = uplift_bundle["feature_columns"]
def _parse_arm(a):
    """Arms are stored as "<pct>_<months>" labels by the notebook, and as (pct, months)
    tuples by the standalone training script. Accept either rather than assuming."""
    if isinstance(a, str):
        pct, months = a.split("_")
        return int(pct), int(months)
    return int(a[0]), int(a[1])


UPLIFT_ARMS = [_parse_arm(a) for a in uplift_bundle["arms"]]
UPLIFT_TREATED_ARMS = [a for a in UPLIFT_ARMS if a != (0, 0)]
print(f"Ready. Uplift kind: {uplift_bundle['kind']}, {len(UPLIFT_ARMS)} arms, {len(UPLIFT_FEATURE_COLUMNS)} features")

# Real fusion meta-classifier — a 2-input LogisticRegression: [churn_proba,
# sentiment_risk_score]. Confirmed by reproducing late_fusion_predictions.csv's
# stored "Stacking (LR meta)_Proba" column exactly from these two inputs in
# this feature order.
print("Loading fusion meta-classifier...")
fusion_clf = joblib.load(FUSION_MODEL_PATH)
print("Ready.")


@app.get("/health")
def health():
    return {"status": "ok", "threshold": THRESHOLD}


@app.post("/predict/churn")
def predict_churn(features: ChurnFeatures):
    row = build_row(features)
    proba = float(pipe.predict_proba(row)[0][1])
    if proba >= THRESHOLD:
        band = "High Risk"
    elif proba >= THRESHOLD * 0.5:
        band = "Medium Risk"
    else:
        band = "Low Risk"
    return {"churn_proba": round(proba, 4), "risk_band": band, "threshold": THRESHOLD}


@app.post("/explain/churn")
def explain_churn(features: ChurnFeatures):
    row = build_row(features)
    transformed = prep.transform(row)

    call_kwargs = {"check_additivity": False} if isinstance(explainer, shap.explainers.Tree) else {}
    result = explainer(transformed, **call_kwargs)
    values = np.array(result.values)[0]

    # Raw SHAP values are in the model's log-odds margin space (not calibrated percentage
    # points) and vary wildly in scale across features. Rescale each as its share of total
    # |SHAP| across all 11 features, matching the 5-30-ish "impact score" range the rest of
    # this app's (hand-authored) ShapFactor.impact numbers already use, so the SHAP tab's
    # bar-width calculation (which clips around impact=33) still shows meaningful relative
    # differences instead of every top feature maxing out the bar.
    total_abs = float(np.sum(np.abs(values))) or 1.0
    factors = [
        {
            "feature": name,
            "impact": round(float(val) / total_abs * 100, 1),
            "direction": "risk_increase" if val > 0 else "risk_decrease",
        }
        for name, val in zip(ALL_FEATURE_NAMES, values)
    ]
    # Returns ALL features, not a fixed top-N slice: every feature has a real
    # SHAP value, so truncating here would throw away real signal the caller
    # can't get back. Sorted strongest-first so any consumer that only wants
    # the headline drivers can just take the first N itself (the dashboard's
    # SHAP tab does exactly that, with a user-controlled count).
    factors.sort(key=lambda x: abs(x["impact"]), reverse=True)
    return {"factors": factors}


@app.post("/predict/sentiment")
def predict_sentiment(payload: SentimentInput):
    proba = sentiment_pipe.predict_proba([payload.text])[0]
    classification = sentiment_pipe.predict([payload.text])[0]
    probabilities = {cls: round(float(p), 4) for cls, p in zip(sentiment_classes, proba)}

    # Collapses the 3-class probabilities into the -1..1 float the rest of the
    # app already expects for sentimentScore: how much more "Satisfied" mass
    # there is than "Frustrated" mass, so a confident Neutral still lands near 0.
    score = probabilities.get("Satisfied", 0.0) - probabilities.get("Frustrated", 0.0)

    # Same weighted-risk formula /predict/fusion uses on its own copy of these
    # probabilities (see sentiment_risk_score there) — returned here too so
    # callers that only need sentiment (no churn features on hand yet, e.g.
    # seeding) can still get the real risk number instead of approximating it.
    risk_weight = sum(probabilities.get(cls, 0.0) * w for cls, w in SENTIMENT_RISK_WEIGHTS.items())

    return {
        "classification": classification,
        "probabilities": probabilities,
        "score": round(score, 4),
        "risk_weight": round(risk_weight, 4),
    }


@app.post("/predict/uplift")
def predict_uplift(features: UpliftFeatures):
    """Scores every (percentage, duration) combination and returns the whole grid.

    The model does not predict a discount. It predicts retention probability under
    each arm; the recommendation is whichever arm has the greatest lift over doing
    nothing. Returning the full grid lets the caller apply its own cost rule to the
    same numbers rather than trusting a single opaque answer.
    """
    row = pd.DataFrame([features.model_dump()])[UPLIFT_FEATURE_COLUMNS]
    transformed = uplift_preprocessor.transform(row)

    if UPLIFT_KIND == "x":
        baseline = float(uplift_models["mu"]["0_0"].predict(transformed)[0])
    else:
        baseline = float(uplift_models["0_0"].predict(transformed)[0])

    def cate_for(arm: str) -> float:
        if UPLIFT_KIND == "x":
            g = float(uplift_models["propensity"][arm].predict_proba(transformed)[0, 1])
            t1 = float(uplift_models["tau1"][arm].predict(transformed)[0])
            t0 = float(uplift_models["tau0"][arm].predict(transformed)[0])
            return g * t0 + (1 - g) * t1
        return float(uplift_models[arm].predict(transformed)[0]) - baseline

    grid = []
    for pct, months in UPLIFT_TREATED_ARMS:
        cate = cate_for(f"{pct}_{months}")
        grid.append({
            "discount_pct": pct,
            "discount_months": months,
            "predicted_retention": round(baseline + cate, 4),
            "cate": round(cate, 4),
        })

    best = max(grid, key=lambda g: g["cate"])
    return {
        "baseline_retention": round(baseline, 4),
        "grid": grid,
        "best_pct": best["discount_pct"],
        "best_months": best["discount_months"],
        "best_cate": best["cate"],
    }


@app.post("/predict/fusion")
def predict_fusion(payload: FusionInput):
    probs = payload.sentiment_probabilities
    sentiment_risk_score = (
        probs.Frustrated * SENTIMENT_RISK_WEIGHTS["Frustrated"]
        + probs.Neutral * SENTIMENT_RISK_WEIGHTS["Neutral"]
        + probs.Satisfied * SENTIMENT_RISK_WEIGHTS["Satisfied"]
    )
    row = np.array([[payload.churn_proba, sentiment_risk_score]])
    fusion_proba = float(fusion_clf.predict_proba(row)[0][1])
    return {
        "fusion_proba": round(fusion_proba, 4),
        "sentiment_risk_score": round(sentiment_risk_score, 4),
    }



# ── Face embedding ──────────────────────────────────────────────────────────
# Stateless, like every other endpoint here: give it an image, get back the
# 512-d FaceNet vector. It stores nothing and knows nothing about users —
# persistence and identity are the Node server's job (face_samples table), so
# enrolled faces survive redeploys instead of living on an ephemeral disk.
#
# The detector/embedder load lazily on first use rather than at import, so a
# broken keras_facenet/opencv install can't stop the churn, sentiment, fusion
# and uplift endpoints above from serving.

class FaceEmbedInput(BaseModel):
    image: str  # "data:image/png;base64,..." straight from the browser


_face = {"detector": None, "embedder": None, "error": None}


def _load_face_engine():
    """Build the detector/embedder once. Returns None on success, else an error string."""
    if _face["embedder"] is not None:
        return None
    if _face["error"] is not None:
        return _face["error"]
    try:
        import cv2
        from keras_facenet import FaceNet
        print("Loading face recognition engine (FaceNet + OpenCV)...")
        _face["detector"] = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        _face["embedder"] = FaceNet()
        print("Ready. Face embedder loaded.")
        return None
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as a message
        _face["error"] = f"Face engine unavailable: {exc}"
        print(_face["error"])
        return _face["error"]


def _decode_image(data_url: str):
    import base64
    import cv2
    encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
    arr = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _extract_face(image):
    """Detect the largest face and return a normalized RGB crop, or None."""
    import cv2
    if image is None:
        return None
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    boxes = _face["detector"].detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=6, minSize=(100, 100)
    )
    if len(boxes) == 0:
        return None
    x, y, w, h = max(boxes, key=lambda b: b[2] * b[3])
    crop = cv2.cvtColor(image[y:y + h, x:x + w], cv2.COLOR_BGR2RGB)
    return cv2.resize(crop, FACE_SIZE)


@app.post("/face/embed")
def face_embed(payload: FaceEmbedInput):
    err = _load_face_engine()
    if err:
        return {"ok": False, "error": err}

    face = _extract_face(_decode_image(payload.image))
    if face is None:
        return {"ok": False, "error": "No face detected — face the camera and try again."}

    embedding = _face["embedder"].embeddings([face])[0]
    # keras_facenet compares these with scipy's cosine distance; server.ts
    # reimplements that same formula over the stored vectors.
    return {"ok": True, "embedding": [float(v) for v in embedding]}
