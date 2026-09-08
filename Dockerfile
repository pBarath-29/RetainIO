# The FastAPI model service: churn, sentiment, fusion, uplift and face embedding.
#
# Built from the REPO ROOT, not from model_service/. app.py:24 sets BASE_DIR to its parent
# directory, so it loads models from <root>/models/ and reads <root>/Datasets/Churn.csv at
# import time. Building with model_service/ as the context would produce an image that
# crashes on the first line that touches a model.
#
# Python is pinned rather than left to a buildpack because the artefacts are pickled
# scikit-learn objects — see requirements.txt.
FROM python:3.9.13-slim

# libgomp is OpenMP, which scikit-learn's tree ensembles link against; it is not in the
# slim image and its absence shows up as an import error rather than anything obvious.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, and in their own layer: they change far less often than the code, so
# a rebuild after editing app.py skips reinstalling TensorFlow.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY model_service/ ./model_service/
COPY models/ ./models/

# Only Churn.csv. It is a startup dependency — app.py:129 samples 100 rows from it to
# rebuild the SHAP background — while the uplift CSVs beside it are training-only and would
# add roughly 20 MB to the image for nothing.
COPY Datasets/Churn.csv ./Datasets/Churn.csv

# Unbuffered so container logs appear as they happen rather than when a buffer fills, which
# matters when the only view of a failing boot is the platform's log tail.
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Shell form, because $PORT has to be expanded at runtime. app.py has no __main__ block and
# reads no PORT itself, so the port can only arrive this way. The default keeps the image
# runnable locally with plain `docker run`.
CMD uvicorn model_service.app:app --host 0.0.0.0 --port ${PORT:-8000}
