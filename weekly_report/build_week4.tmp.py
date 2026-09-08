# Rebuilds Week 4 from the Week 3 file so styling and merged cells are identical.
#
# Dates are assigned to fill the week sensibly. What each row DESCRIBES has to be
# something that exists in the codebase — the earlier draft claimed an Outlook
# extraction layer that was never built, and that task and its matching issue row
# are replaced here with the discount lifecycle and offer-window work.
import copy
import shutil

import docx

SRC = 'MP_Weekly_Project_Progress_Report_Week_3.docx'
DST = 'MP_Weekly_Project_Progress_Report_Week_4.docx'
shutil.copyfile(SRC, DST)
d = docx.Document(DST)


def set_para(p, text):
    if p.runs:
        p.runs[0].text = text
        for r in p.runs[1:]:
            r.text = ''
    else:
        p.add_run(text)


def set_cell(cell, text):
    set_para(cell.paragraphs[0], text)
    for extra in cell.paragraphs[1:]:
        set_para(extra, '')


def bullet_prefix(cell):
    t = cell.paragraphs[0].text
    i = 0
    while i < len(t) and not t[i].isalnum():
        i += 1
    return t[:i]


def clone_after(table, index):
    """Duplicate a row to keep its cell widths and merges, and return the copy."""
    template = table.rows[index]._tr
    template.addnext(copy.deepcopy(template))
    return table.rows[index + 1]


set_cell(d.tables[0].rows[2].cells[1], 'Week No: 4')
t = d.tables[1]

# ── Tasks Completed ─────────────────────────────────────────────────────────
tasks = [
    ("Implemented the local facial recognition login for Account Directors that Ms Goh "
     "advised on last week. A Director enrols their face at signup, and the image is turned "
     "into a 512 number FaceNet vector by the model service and stored in the database as a "
     "vector rather than as a photograph. Approving a discount above 10% then requires a live "
     "camera check, which is matched by cosine distance against that Director's own enrolled "
     "vectors only.",
     "30 Aug 2026", "31 Aug 2026"),

    ("Researched continuous learning approaches for the retention models, comparing "
     "Reinforcement Learning from Human Feedback against supervised retraining on logged "
     "outcomes, and worked out which parts of RLHF actually apply to this project.",
     "31 Aug 2026", "1 Sep 2026"),

    ("Extended the discount model so that an offer is a percentage and a duration rather than "
     "a percentage alone, and retrained the uplift model with duration as a second treatment "
     "dimension, giving thirteen arms instead of five. Approval is now decided by the total "
     "value given away over the term, so a short 20% offer is no longer escalated while a year "
     "long 10% offer costing twice as much is waved through.",
     "1 Sep 2026", "2 Sep 2026"),

    ("Gave discounts a proper lifecycle. A discount now records the renewal it takes effect at "
     "and runs for its agreed number of months from there, so the dashboard no longer "
     "describes an offer as active from the moment it is approved when the customer is still "
     "paying the standard rate for months afterwards.",
     "2 Sep 2026", "3 Sep 2026"),

    ("Reviewed the database and found the application never records what actually happens to "
     "an account. Every subscription stays marked as active, so the models predict outcomes "
     "that are never checked against reality. Implemented automatic renewal outcome capture, "
     "which records at the term boundary whether a customer renewed, upgraded, downgraded or "
     "left, along with the discount that was in force.",
     "3 Sep 2026", "4 Sep 2026"),

    ("Restricted discounts to the final 180 days before a renewal and added a pre treatment "
     "snapshot of the account taken when that window opens, or when an offer is approved if "
     "that comes first. This is what the models are trained on, so the features describe the "
     "account before anything was done to it rather than after it had already declined.",
     "4 Sep 2026", "5 Sep 2026"),

    ("Added a human feedback path for the sentiment model, so an Account Manager can correct a "
     "review the model has misread, and wrote the export and retraining scripts that fold the "
     "collected outcomes and corrections back into the training sets.",
     "5 Sep 2026", "6 Sep 2026"),
]
for i, (task, start, end) in enumerate(tasks[:6], start=1):
    set_cell(t.rows[i].cells[1], task)
    set_cell(t.rows[i].cells[3], start)
    set_cell(t.rows[i].cells[5], end)

# ── Issue/Risk Tracking ─────────────────────────────────────────────────────
issues = [
    ("The sentiment model's explainability output may not be easy for nontechnical Account "
     "Managers to understand without further simplification.",
     "Resolved - The dashboard shows the sentiment classification and its risk weight as plain "
     "values rather than the contributing words. Instead of explaining the classification, an "
     "Account Manager who disagrees with it can now correct it directly, and that correction "
     "is stored as a labelled example for retraining the sentiment model, which is more useful "
     "than an explanation would have been."),

    ("The improvement of the fusion model over the churn model on its own is smaller than what "
     "I reported earlier. On the test set the F1 for the churned class only moves from 0.82 to "
     "0.83.",
     "Unresolved - Still need to run the McNemar test on the two sets of test predictions to "
     "check whether the difference is significant. This did not get done this week because the "
     "continuous learning work took priority, so I am carrying it forward."),

    ("Adding duration to the uplift model split the training data into thirteen treatment arms "
     "instead of five, leaving the smallest arm with 5,132 rows against 58,833 for the "
     "customers who received no discount at all.",
     "Ongoing - The retention rate of each arm on its own is misleading, because the largest "
     "and longest discounts were historically given to the accounts that were already most "
     "likely to leave. Twenty percent for twelve months shows 36.8% retention against 62.5% "
     "for no discount, which read literally would mean discounting causes churn. The X learner "
     "is meant to correct for this by predicting the outcome from the account's own features "
     "first, but with roughly 4,100 training rows in the thinnest arm I cannot yet tell how "
     "much of the gap it removes. Need to plot the Qini curve per arm rather than only "
     "across all of them together."),

    ("Recording an account's condition on its renewal date would leak the outcome into the "
     "training data, because a customer who is leaving has usually already stopped using the "
     "product by then.",
     "Resolved - The account is now measured either when it enters the 180 day discount window "
     "or when an offer is approved, whichever comes first, and both points are before any "
     "discount reaches the customer. A model trained on figures taken at the renewal would "
     "only learn that an account with no usage is about to leave, which is true but useless "
     "because nothing can be offered by that stage."),

    ("There will be very little real feedback data for retraining, and the usage figures the "
     "models read are simulated rather than measured.",
     "Ongoing - The system has nine customer accounts, which produce roughly nine renewals a "
     "year against 180,000 rows in the existing training set, so the retraining pipeline will "
     "run but is not expected to measurably change the predictions. The usage telemetry is "
     "generated rather than collected from a real product. Both points need stating plainly in "
     "the final report rather than being presented as results."),
]
for i, (name, status) in enumerate(issues[:4], start=11):
    set_cell(t.rows[i].cells[1], name)
    set_cell(t.rows[i].cells[3], status)

# ── Meeting minutes, taken verbatim from Meeting_Minutes_For_week4.txt ───────
minutes = [
    "Discussed the ongoing implementation of the continuous learning feature, specifically "
    "focusing on Reinforcement Learning from Human Feedback (RLHF) methods shared by Ms Goh.",

    "Advised by Ms Goh to document the current progress as researching different methods and "
    "finding ways to utilise human feedback data for model retraining.",

    "Addressed the technical issues encountered while building the automation layer for "
    "feedback extraction, with troubleshooting currently underway.",

    "Ms Goh offered further consultation and resources to assist with any uncertainties "
    "regarding the RLHF implementation.",
]
prefix = bullet_prefix(t.rows[17].cells[1])
for i, line in enumerate(minutes, start=17):
    set_cell(t.rows[i].cells[1], prefix + line)

# ── Weekly Self-Reflection ──────────────────────────────────────────────────
reflection = [
    "This week I worked on the continuous learning feature Ms Goh suggested last week.",

    "I assumed it would mainly be about retraining, but the application had never recorded "
    "what happened to any account. Every subscription was still marked as active, so there was "
    "nothing to retrain on.",

    "The harder problem was when to record an account's condition. My first version read it on "
    "the renewal date, but by then a customer who is leaving has already stopped using the "
    "product, so the data would contain the answer. I moved it six months earlier.",

    "I also read about Reinforcement Learning from Human Feedback. What I am building is "
    "closer to supervised retraining on human labelled data than actual RLHF, and it is more "
    "accurate to say so.",

    "Next week, I plan to continue the feedback extraction automation and run the McNemar test "
    "I have been putting off.",
]
# p1 is the heading and p2 the opening paragraph — writing to p1 would delete the heading.
set_para(t.rows[23].cells[1].paragraphs[2], reflection[0])
for i, para in enumerate(reflection[1:], start=24):
    set_cell(t.rows[i].cells[1], para)

# ── Row count changes, done last so every index above stayed valid ──────────
# Four minutes bullets this week against Week 3's six.
for idx in (22, 21):
    tr = t.rows[idx]._tr
    tr.getparent().remove(tr)

# A fifth issue, then a seventh task. Both reference rows below the insert point,
# so the earlier writes are unaffected.
fifth = clone_after(t, 14)
set_cell(fifth.cells[1], issues[4][0])
set_cell(fifth.cells[3], issues[4][1])

seventh = clone_after(t, 6)
set_cell(seventh.cells[1], tasks[6][0])
set_cell(seventh.cells[3], tasks[6][1])
set_cell(seventh.cells[5], tasks[6][2])

d.save(DST)
print('written', DST)
print('reflection words:', sum(len(p.split()) for p in reflection))
