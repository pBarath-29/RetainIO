import os, time, warnings, joblib
import pandas as pd, numpy as np
from dotenv import load_dotenv
from google import genai

warnings.filterwarnings('ignore')
load_dotenv()

client = genai.Client(api_key=os.environ['GEMINI_API_KEY'])

CLASSIFY_PROMPT = """You are classifying a customer support review into exactly one category.

Categories:
- technical: the review is about a bug, broken feature, integration issue, performance problem, or something not working as expected.
- price: the review is about cost, pricing, billing, discounts, or value for money.
- general: anything else (feature requests, praise, neutral questions, account admin, etc.)

Respond with ONLY one word: technical, price, or general.

Review: {review_text}"""

def classify_review(review_text: str) -> str:
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=CLASSIFY_PROMPT.format(review_text=review_text),
    )
    label = resp.text.strip().lower()
    return label if label in {"technical", "price", "general"} else "general"

def decide_action(review_category: str, cate: float, threshold: float = 0.174) -> str:
    helps = cate >= threshold
    if review_category == "technical":
        return "Discount + walkthrough" if helps else "Walkthrough only"
    if review_category == "price":
        return "Discount only" if helps else "Flag for human review"
    return "Discount only" if helps else "Do nothing"

# ---- Load real customer feature rows (uplift model's population) ----
loaded = joblib.load('models/uplift_pooled_x_realistic.pkl')
model, kind, preprocessor, X_COLS = loaded['model'], loaded['kind'], loaded['preprocessor'], loaded['feature_columns']
uplift_df = pd.read_csv('Datasets/uplift_observational.csv')

def t_cate(models, X, d):
    return models[d].predict(X) - models[0].predict(X)

def best_cate_for(row_df):
    X = preprocessor.transform(row_df[X_COLS])
    vals = [t_cate(model, X, d)[0] for d in [5, 10, 15, 20]]
    return max(vals)

# ---- Load real review text (separate dataset — no natural join between the two,
# so this pairing is illustrative: real reviews + real customer feature rows,
# just not the same underlying customers) ----
reviews_df = pd.read_csv('Datasets/Churn.csv')
sample_reviews = reviews_df.sample(n=8, random_state=7)['Review'].tolist()

# Sample 8 diverse customers from the uplift population
sample_customers = uplift_df.sample(n=8, random_state=7).reset_index(drop=True)

print(f"{'Review (truncated)':<55} {'Gemini category':<12} {'Best CATE':<10} {'Action'}")
print("-" * 120)
for i, review in enumerate(sample_reviews):
    if i > 0:
        time.sleep(13)  # stay under the free-tier 5-requests/minute limit
    category = classify_review(review)
    cust_row = sample_customers.iloc[[i]]
    cate = best_cate_for(cust_row)
    action = decide_action(category, cate)
    print(f"{review[:52]+'...':<55} {category:<12} {cate:<10.4f} {action}")
