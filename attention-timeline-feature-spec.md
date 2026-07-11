# Attention Timeline Feature Specification

## 1. Purpose

Build a side-panel timeline that estimates how student attention may change during a 50- or 75-minute college lecture.

The visualization should show:

- attention gradually declining while the instructor continues presenting without a meaningful change in activity;
- a temporary increase when the lecture is interrupted by an activity, poll, discussion, demonstration, video, break, or another nonlecture interaction;
- attention beginning to decline again after the intervention;
- uncertainty, especially later in a long uninterrupted lecture;
- the difference between a weak modality change, such as a passive video, and a strong interaction, such as retrieval practice or peer problem solving.

This feature is an instructional planning and reflection tool. It is not a medical, neurological, or biometric measurement system.

---

## 2. Product Language

### Recommended labels

Use one of these labels in the interface:

- **Estimated Attention**
- **Attention Forecast**
- **Estimated On-Task Likelihood**
- **Attention Support Timeline**

Recommended primary label:

> **Estimated Attention**

Recommended tooltip:

> A research-informed estimate based on time, instructional mode, and classroom events. It does not directly measure individual students.

### Avoid these claims

Do not label the output as:

- actual student attention;
- brain activity;
- engagement detection;
- proof that students are learning;
- an exact percentage of attentive students;
- a universal human attention span.

The displayed number is a model score or estimated probability, not a direct observation.

---

## 3. Core User Experience

### 3.1 Side-panel layout

Display time vertically from the beginning to the end of the class.

```text
Estimated
Attention

  80%       ● 00:00  Lecture begins
             \
  70%         \
               \
  60%           ◆ 12:00  Retrieval poll
                  \
  50%             \
                    ◆ 28:00  Pair activity
                     \
  40%                 ● 50:00  End
```

The actual interface should use a smooth line rather than ASCII characters.

### 3.2 Required visual elements

1. **Vertical time axis**
   - Start time at the top.
   - End time at the bottom.
   - Minute labels at regular intervals.
   - Presets for 50-minute and 75-minute classes.

2. **Attention curve**
   - Horizontal position represents estimated attention from 0 to 100.
   - The curve moves left as uninterrupted lecture time increases.
   - The curve moves right when a meaningful nonlecture event occurs.
   - The curve resumes moving left after the event.

3. **Current-time marker**
   - A visible marker moves downward as the lecture proceeds.
   - The current estimate is displayed next to the marker.

4. **Event blocks**
   - Lecture
   - Demonstration
   - Passive video
   - Interactive video
   - Poll or retrieval question
   - Discussion
   - Individual activity
   - Group activity
   - Break
   - Other nonlecture interaction

5. **Uncertainty band**
   - Draw a translucent band around the estimate.
   - Widen the band after approximately 30 effective minutes of uninterrupted passive presentation.

6. **Optional comparison line**
   - A dotted line shows the predicted trajectory if the entire session had been uninterrupted lecture.
   - A solid line shows the trajectory with the scheduled events.

### 3.3 Interaction behavior

The lecturer should be able to:

- select a 50- or 75-minute duration;
- add, remove, resize, and move timeline events;
- choose an event type;
- mark a video as passive or interactive;
- set a custom event strength;
- see the forecast update immediately;
- compare the planned lecture with an uninterrupted lecture;
- view an average estimated-attention score for the session;
- view the longest uninterrupted lecture segment;
- view the number and spacing of nonlecture interactions.

---

## 4. Behavioral Rules

### 4.1 Uninterrupted lecture

During a lecture or other passive presentation:

- estimated attention should decline continuously;
- the decline should be smooth rather than stepwise;
- the curve should not suddenly collapse at a fixed minute;
- there should be no universal 10-minute or 15-minute cutoff;
- uncertainty should grow as the model extrapolates farther into a long session.

Default uninterrupted-lecture targets:

| Elapsed uninterrupted lecture time | Approximate estimate |
|---:|---:|
| 0 minutes | 78% |
| 10 minutes | 67% |
| 20 minutes | 55% |
| 30 minutes | 42% |
| 50 minutes | 35% |
| 75 minutes | 27% |

These are model defaults, not measured classroom facts.

### 4.2 Activities and other resets

A nonlecture event should create a partial and temporary reset.

The model must not reset attention to 100%.

A reset should:

1. increase the estimate during the event or immediately after it;
2. slow the accumulation of passive lecture time while the event is occurring;
3. decay after the event ends;
4. allow the estimate to begin declining again when lecture resumes.

### 4.3 Videos

A video is not automatically equivalent to active learning.

Use two video types:

- **Passive video**: small temporary increase caused by a change in modality.
- **Interactive video**: larger increase because students must predict, answer, identify, discuss, annotate, or retrieve information.

Suggested examples:

| Event | Expected effect |
|---|---|
| Instructor starts a passive clip | Small temporary increase |
| Instructor asks students to predict before the clip | Moderate increase |
| Video pauses for a question | Moderate to strong increase |
| Students analyze evidence in the clip | Stronger and longer increase |

### 4.4 Breaks

During a true break:

- show the timeline section as a break rather than assigning an attention score;
- stop accumulating passive lecture time;
- apply a moderate post-break recovery when instruction resumes;
- do not assume that every student returns fully attentive.

### 4.5 Event hierarchy

The default ordering from weakest to strongest should be:

1. slide or topic change;
2. passive video;
3. instructor demonstration;
4. interactive video;
5. poll or retrieval question;
6. discussion;
7. individual problem solving;
8. peer or group problem solving;
9. true break.

---

## 5. Attention Model

## 5.1 Definitions

Let:

- `t` be elapsed clock time in minutes;
- `m(t)` be accumulated effective passive minutes;
- `P(t)` be the estimated on-task likelihood from 0 to 1;
- `B(m)` be the baseline logit for uninterrupted presentation;
- `E_j(t)` be the temporary boost from event `j`;
- `L(t)` be an optional adjustment based on actual live evidence.

The final estimate is:

```math
P(t) = sigmoid(B(m(t)) + sum(E_j(t)) + L(t))
```

where:

```math
sigmoid(x) = 1 / (1 + exp(-x))
```

Display the result as:

```math
AttentionScore(t) = 100 * P(t)
```

Round the displayed value to a whole number or one decimal place. Avoid false precision.

---

## 5.2 Effective passive minutes

Not every minute contributes equally to attention decline.

Calculate effective passive minutes as:

```math
m(t) = integral from 0 to t of modeWeight(s) ds
```

Use these initial mode weights:

| Mode | `modeWeight` |
|---|---:|
| Lecture or passive presentation | 1.00 |
| Passive video | 0.70 |
| Instructor demonstration | 0.65 |
| Interactive video | 0.30 |
| Poll or retrieval question | 0.15 |
| Individual activity | 0.15 |
| Peer or group activity | 0.10 |
| Discussion | 0.20 |
| Break | 0.00 |
| Other nonlecture interaction | 0.30 |

Interpretation:

- Ten minutes of uninterrupted lecture adds ten effective passive minutes.
- Ten minutes of interactive activity adds only one to three effective passive minutes, depending on the event type.
- A break adds no effective passive minutes.

These defaults should be configurable.

---

## 5.3 Baseline decline equation

Use a piecewise logistic baseline.

For the first 30 effective passive minutes:

```math
B(m) = 1.236 - 0.052m
```

After 30 effective passive minutes, continue the decline more slowly:

```math
B(m) = 1.236 - 0.052 * 30 - 0.015 * (m - 30)
```

Equivalent implementation:

```ts
function baselineLogit(effectiveMinutes: number): number {
  const firstThirty = Math.min(effectiveMinutes, 30);
  const afterThirty = Math.max(0, effectiveMinutes - 30);

  return 1.236 - 0.052 * firstThirty - 0.015 * afterThirty;
}
```

The first portion is a research-informed starting prior. The slower continuation after 30 minutes is a product heuristic that avoids unrealistic extrapolation in 50- and 75-minute classes.

---

## 5.4 Event boost equation

Each nonlecture event supplies a temporary boost in log-odds.

For an event with:

- start time `start_j`;
- end time `end_j`;
- strength `gamma_j`;
- post-event half-life `h_j`;

use:

```math
E_j(t) = 0, before the event
```

```math
E_j(t) = gamma_j, while the event is active
```

```math
E_j(t) = gamma_j * 2 ^ (-(t - end_j) / h_j), after the event
```

For a break, apply the boost beginning at the end of the break rather than during the break.

### Default event settings

| Event type | `gamma` | Post-event half-life |
|---|---:|---:|
| Topic or slide change | 0.05 | 0.5 min |
| Passive video | 0.15 | 1.0 min |
| Demonstration | 0.20 | 2.0 min |
| Interactive video | 0.45 | 3.0 min |
| Poll or retrieval question | 0.35 | 2.0 min |
| Discussion | 0.55 | 4.0 min |
| Individual activity | 0.50 | 4.0 min |
| Peer or group activity | 0.65 | 5.0 min |
| Break | 0.70 | 6.0 min |
| Other nonlecture interaction | 0.35 | 3.0 min |

These are product defaults for prototyping. They are not universal biological constants.

---

## 5.5 Optional live-evidence adjustment

The first version can set:

```math
L(t) = 0
```

A later version may use anonymous classroom evidence such as:

- poll participation rate;
- response latency;
- voluntary self-reported on-task checks;
- retrieval-question completion;
- aggregated interaction with digital materials.

Do not use facial expression, eye tracking, or camera-based inference as the sole source of an individual attention judgment.

Any live adjustment should operate in log-odds and should be capped.

Suggested cap:

```ts
liveAdjustment = clamp(liveAdjustment, -0.5, 0.5);
```

---

## 5.6 Final equation

```math
P(t) = sigmoid(
  baselineLogit(m(t))
  + sum(eventBoost_j(t))
  + liveAdjustment(t)
)
```

Then:

```math
AttentionScore(t) = 100 * P(t)
```

Recommended output clamp:

```ts
AttentionScore = clamp(AttentionScore, 5, 95);
```

The clamp prevents the interface from implying certainty at 0% or 100%.

---

## 5.7 Average attention estimate

Calculate the session average using samples from the generated timeline.

```math
AverageAttention = sum(AttentionScore_i) / numberOfScoredSamples
```

Exclude break samples from the denominator because attention during a break is not being scored.

Display:

> Estimated instructional-time average: 63%

Do not display:

> Exactly 63% of students were attentive.

Also calculate:

- average during instructional time;
- lowest estimated point;
- longest uninterrupted lecture segment;
- total interaction time;
- percentage of class time spent in nonlecture modes;
- number of resets;
- average time between resets.

---

## 5.8 Uncertainty

The model should always expose uncertainty.

Suggested uncertainty width:

```ts
function uncertaintyWidth(effectiveMinutes: number): number {
  const baseWidth = 8;
  const extrapolationWidth = Math.max(0, effectiveMinutes - 30) * 0.35;
  return Math.min(20, baseWidth + extrapolationWidth);
}
```

For an estimate of 55 with a width of 10, display a band from 45 to 65.

Suggested confidence labels:

| Condition | Confidence label |
|---|---|
| Time-only estimate, 0 to 30 effective minutes | Moderate |
| Time-only estimate after 30 effective minutes | Low |
| Estimate supported by anonymous local evidence | Moderate |
| Individual-level claim without direct validation | Not allowed |

---

## 6. Recommended Data Model

```ts
export type SegmentType =
  | "lecture"
  | "passiveVideo"
  | "demonstration"
  | "interactiveVideo"
  | "poll"
  | "discussion"
  | "individualActivity"
  | "groupActivity"
  | "break"
  | "otherInteraction";

export interface LectureSegment {
  id: string;
  type: SegmentType;
  label: string;
  startMinute: number;
  endMinute: number;

  // Optional per-segment overrides.
  modeWeight?: number;
  gamma?: number;
  halfLifeMinutes?: number;
}

export interface LecturePlan {
  id: string;
  title: string;
  durationMinutes: number;
  startTime?: string;
  sampleIntervalSeconds?: number;
  segments: LectureSegment[];
}

export interface AttentionPoint {
  minute: number;
  score: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  effectivePassiveMinutes: number;
  activeSegmentId: string | null;
  activeSegmentType: SegmentType;
  confidence: "moderate" | "low";
}

export interface AttentionSummary {
  averageInstructionalScore: number;
  lowestScore: number;
  lowestScoreMinute: number;
  longestLectureSegmentMinutes: number;
  totalInteractionMinutes: number;
  percentInteractionTime: number;
  resetCount: number;
  averageMinutesBetweenResets: number | null;
}
```

---

## 7. Default Configuration

```ts
export interface SegmentModelSettings {
  modeWeight: number;
  gamma: number;
  halfLifeMinutes: number;
  scoreVisibleDuringSegment: boolean;
}

export const DEFAULT_SEGMENT_SETTINGS: Record<
  SegmentType,
  SegmentModelSettings
> = {
  lecture: {
    modeWeight: 1.0,
    gamma: 0.0,
    halfLifeMinutes: 0,
    scoreVisibleDuringSegment: true,
  },
  passiveVideo: {
    modeWeight: 0.7,
    gamma: 0.15,
    halfLifeMinutes: 1,
    scoreVisibleDuringSegment: true,
  },
  demonstration: {
    modeWeight: 0.65,
    gamma: 0.2,
    halfLifeMinutes: 2,
    scoreVisibleDuringSegment: true,
  },
  interactiveVideo: {
    modeWeight: 0.3,
    gamma: 0.45,
    halfLifeMinutes: 3,
    scoreVisibleDuringSegment: true,
  },
  poll: {
    modeWeight: 0.15,
    gamma: 0.35,
    halfLifeMinutes: 2,
    scoreVisibleDuringSegment: true,
  },
  discussion: {
    modeWeight: 0.2,
    gamma: 0.55,
    halfLifeMinutes: 4,
    scoreVisibleDuringSegment: true,
  },
  individualActivity: {
    modeWeight: 0.15,
    gamma: 0.5,
    halfLifeMinutes: 4,
    scoreVisibleDuringSegment: true,
  },
  groupActivity: {
    modeWeight: 0.1,
    gamma: 0.65,
    halfLifeMinutes: 5,
    scoreVisibleDuringSegment: true,
  },
  break: {
    modeWeight: 0.0,
    gamma: 0.7,
    halfLifeMinutes: 6,
    scoreVisibleDuringSegment: false,
  },
  otherInteraction: {
    modeWeight: 0.3,
    gamma: 0.35,
    halfLifeMinutes: 3,
    scoreVisibleDuringSegment: true,
  },
};
```

---

## 8. Reference TypeScript Implementation

```ts
export type SegmentType =
  | "lecture"
  | "passiveVideo"
  | "demonstration"
  | "interactiveVideo"
  | "poll"
  | "discussion"
  | "individualActivity"
  | "groupActivity"
  | "break"
  | "otherInteraction";

export interface LectureSegment {
  id: string;
  type: SegmentType;
  label: string;
  startMinute: number;
  endMinute: number;
  modeWeight?: number;
  gamma?: number;
  halfLifeMinutes?: number;
}

export interface LecturePlan {
  durationMinutes: number;
  sampleIntervalSeconds?: number;
  segments: LectureSegment[];
}

export interface AttentionPoint {
  minute: number;
  score: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  effectivePassiveMinutes: number;
  activeSegmentId: string | null;
  activeSegmentType: SegmentType;
  confidence: "moderate" | "low";
}

interface SegmentSettings {
  modeWeight: number;
  gamma: number;
  halfLifeMinutes: number;
  scoreVisibleDuringSegment: boolean;
}

const SETTINGS: Record<SegmentType, SegmentSettings> = {
  lecture: {
    modeWeight: 1,
    gamma: 0,
    halfLifeMinutes: 0,
    scoreVisibleDuringSegment: true,
  },
  passiveVideo: {
    modeWeight: 0.7,
    gamma: 0.15,
    halfLifeMinutes: 1,
    scoreVisibleDuringSegment: true,
  },
  demonstration: {
    modeWeight: 0.65,
    gamma: 0.2,
    halfLifeMinutes: 2,
    scoreVisibleDuringSegment: true,
  },
  interactiveVideo: {
    modeWeight: 0.3,
    gamma: 0.45,
    halfLifeMinutes: 3,
    scoreVisibleDuringSegment: true,
  },
  poll: {
    modeWeight: 0.15,
    gamma: 0.35,
    halfLifeMinutes: 2,
    scoreVisibleDuringSegment: true,
  },
  discussion: {
    modeWeight: 0.2,
    gamma: 0.55,
    halfLifeMinutes: 4,
    scoreVisibleDuringSegment: true,
  },
  individualActivity: {
    modeWeight: 0.15,
    gamma: 0.5,
    halfLifeMinutes: 4,
    scoreVisibleDuringSegment: true,
  },
  groupActivity: {
    modeWeight: 0.1,
    gamma: 0.65,
    halfLifeMinutes: 5,
    scoreVisibleDuringSegment: true,
  },
  break: {
    modeWeight: 0,
    gamma: 0.7,
    halfLifeMinutes: 6,
    scoreVisibleDuringSegment: false,
  },
  otherInteraction: {
    modeWeight: 0.3,
    gamma: 0.35,
    halfLifeMinutes: 3,
    scoreVisibleDuringSegment: true,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function baselineLogit(effectiveMinutes: number): number {
  const safeMinutes = Math.max(0, effectiveMinutes);
  const firstThirty = Math.min(safeMinutes, 30);
  const afterThirty = Math.max(0, safeMinutes - 30);

  return 1.236 - 0.052 * firstThirty - 0.015 * afterThirty;
}

function getSettings(segment: LectureSegment): SegmentSettings {
  const defaults = SETTINGS[segment.type];

  return {
    modeWeight: segment.modeWeight ?? defaults.modeWeight,
    gamma: segment.gamma ?? defaults.gamma,
    halfLifeMinutes:
      segment.halfLifeMinutes ?? defaults.halfLifeMinutes,
    scoreVisibleDuringSegment: defaults.scoreVisibleDuringSegment,
  };
}

function eventBoostAtMinute(
  minute: number,
  segment: LectureSegment
): number {
  const settings = getSettings(segment);

  if (settings.gamma <= 0) {
    return 0;
  }

  // A break creates recovery when the break ends.
  if (segment.type === "break") {
    if (minute < segment.endMinute) {
      return 0;
    }

    if (settings.halfLifeMinutes <= 0) {
      return 0;
    }

    const minutesSinceEnd = minute - segment.endMinute;
    return (
      settings.gamma *
      Math.pow(2, -minutesSinceEnd / settings.halfLifeMinutes)
    );
  }

  if (minute < segment.startMinute) {
    return 0;
  }

  if (minute <= segment.endMinute) {
    return settings.gamma;
  }

  if (settings.halfLifeMinutes <= 0) {
    return 0;
  }

  const minutesSinceEnd = minute - segment.endMinute;
  return (
    settings.gamma *
    Math.pow(2, -minutesSinceEnd / settings.halfLifeMinutes)
  );
}

function uncertaintyWidth(effectiveMinutes: number): number {
  const baseWidth = 8;
  const extrapolationWidth =
    Math.max(0, effectiveMinutes - 30) * 0.35;

  return Math.min(20, baseWidth + extrapolationWidth);
}

function validatePlan(plan: LecturePlan): LectureSegment[] {
  if (
    !Number.isFinite(plan.durationMinutes) ||
    plan.durationMinutes <= 0
  ) {
    throw new RangeError("durationMinutes must be positive.");
  }

  const sorted = [...plan.segments].sort(
    (a, b) => a.startMinute - b.startMinute
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index];

    if (
      !Number.isFinite(segment.startMinute) ||
      !Number.isFinite(segment.endMinute) ||
      segment.startMinute < 0 ||
      segment.endMinute <= segment.startMinute ||
      segment.endMinute > plan.durationMinutes
    ) {
      throw new RangeError(`Invalid segment: ${segment.id}`);
    }

    if (
      index > 0 &&
      segment.startMinute < sorted[index - 1].endMinute
    ) {
      throw new RangeError(
        `Overlapping segments: ${sorted[index - 1].id} and ${segment.id}`
      );
    }
  }

  return sorted;
}

function fillLectureGaps(
  durationMinutes: number,
  segments: LectureSegment[]
): LectureSegment[] {
  const result: LectureSegment[] = [];
  let cursor = 0;
  let gapIndex = 0;

  for (const segment of segments) {
    if (segment.startMinute > cursor) {
      result.push({
        id: `auto-lecture-${gapIndex}`,
        type: "lecture",
        label: "Lecture",
        startMinute: cursor,
        endMinute: segment.startMinute,
      });
      gapIndex += 1;
    }

    result.push(segment);
    cursor = segment.endMinute;
  }

  if (cursor < durationMinutes) {
    result.push({
      id: `auto-lecture-${gapIndex}`,
      type: "lecture",
      label: "Lecture",
      startMinute: cursor,
      endMinute: durationMinutes,
    });
  }

  return result;
}

function segmentAtMinute(
  minute: number,
  segments: LectureSegment[]
): LectureSegment {
  const segment = segments.find(
    (candidate) =>
      minute >= candidate.startMinute &&
      minute < candidate.endMinute
  );

  return segment ?? segments[segments.length - 1];
}

export function generateAttentionTimeline(
  plan: LecturePlan,
  liveLogitAdjustment = 0
): AttentionPoint[] {
  const validated = validatePlan(plan);
  const segments = fillLectureGaps(plan.durationMinutes, validated);

  const intervalSeconds = plan.sampleIntervalSeconds ?? 5;
  const intervalMinutes = intervalSeconds / 60;

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError("sampleIntervalSeconds must be positive.");
  }

  const safeLiveAdjustment = clamp(liveLogitAdjustment, -0.5, 0.5);
  const points: AttentionPoint[] = [];
  let effectivePassiveMinutes = 0;

  for (
    let minute = 0;
    minute <= plan.durationMinutes + 1e-9;
    minute += intervalMinutes
  ) {
    const roundedMinute = Number(minute.toFixed(6));
    const activeSegment = segmentAtMinute(roundedMinute, segments);
    const activeSettings = getSettings(activeSegment);

    let eventBoost = 0;
    for (const segment of segments) {
      eventBoost += eventBoostAtMinute(roundedMinute, segment);
    }

    const logit =
      baselineLogit(effectivePassiveMinutes) +
      eventBoost +
      safeLiveAdjustment;

    const rawScore = 100 * sigmoid(logit);
    const score = clamp(rawScore, 5, 95);
    const width = uncertaintyWidth(effectivePassiveMinutes);

    const scoreVisible = activeSettings.scoreVisibleDuringSegment;

    points.push({
      minute: roundedMinute,
      score: scoreVisible ? Number(score.toFixed(1)) : null,
      lowerBound: scoreVisible
        ? Number(clamp(score - width, 0, 100).toFixed(1))
        : null,
      upperBound: scoreVisible
        ? Number(clamp(score + width, 0, 100).toFixed(1))
        : null,
      effectivePassiveMinutes: Number(
        effectivePassiveMinutes.toFixed(3)
      ),
      activeSegmentId: activeSegment.id,
      activeSegmentType: activeSegment.type,
      confidence:
        effectivePassiveMinutes <= 30 ? "moderate" : "low",
    });

    effectivePassiveMinutes +=
      activeSettings.modeWeight * intervalMinutes;
  }

  return points;
}
```

---

## 9. Example 50-Minute Plan

```json
{
  "durationMinutes": 50,
  "sampleIntervalSeconds": 5,
  "segments": [
    {
      "id": "opening",
      "type": "lecture",
      "label": "Opening explanation",
      "startMinute": 0,
      "endMinute": 12
    },
    {
      "id": "poll-1",
      "type": "poll",
      "label": "Retrieval poll",
      "startMinute": 12,
      "endMinute": 15
    },
    {
      "id": "lecture-2",
      "type": "lecture",
      "label": "Concept explanation",
      "startMinute": 15,
      "endMinute": 28
    },
    {
      "id": "activity-1",
      "type": "groupActivity",
      "label": "Pair problem",
      "startMinute": 28,
      "endMinute": 33
    },
    {
      "id": "lecture-3",
      "type": "lecture",
      "label": "Application explanation",
      "startMinute": 33,
      "endMinute": 43
    },
    {
      "id": "video-1",
      "type": "interactiveVideo",
      "label": "Video with prediction prompt",
      "startMinute": 43,
      "endMinute": 46
    },
    {
      "id": "close",
      "type": "lecture",
      "label": "Summary",
      "startMinute": 46,
      "endMinute": 50
    }
  ]
}
```

Expected visual behavior:

- steady decline from minute 0 to minute 12;
- visible lift during the retrieval poll;
- renewed decline from minute 15 to minute 28;
- larger lift during the pair problem;
- renewed decline after the pair problem;
- moderate lift during the interactive video;
- final decline during the summary.

---

## 10. Example 75-Minute Plan

```json
{
  "durationMinutes": 75,
  "sampleIntervalSeconds": 5,
  "segments": [
    {
      "id": "lecture-1",
      "type": "lecture",
      "label": "Introduction and explanation",
      "startMinute": 0,
      "endMinute": 18
    },
    {
      "id": "poll-1",
      "type": "poll",
      "label": "Prediction and retrieval poll",
      "startMinute": 18,
      "endMinute": 22
    },
    {
      "id": "lecture-2",
      "type": "lecture",
      "label": "Explanation and demonstration",
      "startMinute": 22,
      "endMinute": 35
    },
    {
      "id": "break-1",
      "type": "break",
      "label": "Ninety-second break",
      "startMinute": 35,
      "endMinute": 36.5
    },
    {
      "id": "lecture-3",
      "type": "lecture",
      "label": "Worked example",
      "startMinute": 36.5,
      "endMinute": 50
    },
    {
      "id": "group-1",
      "type": "groupActivity",
      "label": "Group problem",
      "startMinute": 50,
      "endMinute": 56
    },
    {
      "id": "lecture-4",
      "type": "lecture",
      "label": "Application and explanation",
      "startMinute": 56,
      "endMinute": 68
    },
    {
      "id": "poll-2",
      "type": "poll",
      "label": "Cumulative retrieval",
      "startMinute": 68,
      "endMinute": 72
    },
    {
      "id": "close",
      "type": "lecture",
      "label": "Summary and exit prompt",
      "startMinute": 72,
      "endMinute": 75
    }
  ]
}
```

---

## 11. Summary Metrics

Display a compact summary near the timeline.

Example:

```text
Estimated instructional-time average: 62%
Lowest estimated point: 41% at 49:30
Longest uninterrupted lecture segment: 18 minutes
Nonlecture interaction time: 18%
Attention-support events: 4
Average spacing between events: 14 minutes
Model confidence: Moderate early, low late
```

Optional recommendation logic:

```text
The longest uninterrupted lecture segment is 24 minutes.
Consider adding a retrieval question, discussion, demonstration,
or interactive video near minute 12 to 16.
```

Recommendations should be phrased as suggestions, not diagnoses.

---

## 12. Chart Rendering Requirements

### 12.1 Coordinate system

- Vertical coordinate: elapsed time.
- Horizontal coordinate: estimated attention score.
- Higher score appears farther to the right.
- Lower score appears farther to the left.

### 12.2 Curve behavior

For an uninterrupted lecture:

- the curve must be monotonic downward in score;
- the visual decline should be smooth;
- the curve should not oscillate without an event;
- the curve should remain within 5 to 95.

For an event:

- the curve should bend or move toward higher attention;
- the size of the movement depends on event strength;
- the effect should never jump to 100;
- the curve should resume declining when passive presentation resumes;
- the boost should decay gradually rather than disappear in one frame.

### 12.3 Break rendering

- Display the break as a distinct shaded block.
- Do not draw a precise attention line through the break.
- Resume the line at the end of the break with a partial recovery.

### 12.4 Accessibility

- Do not rely on color alone.
- Use icons, labels, line styles, and patterns.
- Provide text equivalents for all chart states.
- Support keyboard editing of event start and end times.
- Provide screen-reader text for the current estimate and event type.

Example accessible text:

> At minute 28, estimated attention is 52%, with a range of 43% to 61%. A five-minute group activity begins here.

---

## 13. Acceptance Criteria

### Baseline behavior

- [ ] A 50-minute uninterrupted lecture begins near 78% and ends near 35%.
- [ ] A 75-minute uninterrupted lecture begins near 78% and ends near 27%.
- [ ] The uninterrupted lecture line declines continuously.
- [ ] No fixed 10-minute or 15-minute cliff appears.
- [ ] The uncertainty band widens after 30 effective passive minutes.

### Event behavior

- [ ] Adding a passive video creates a small temporary increase.
- [ ] Adding an interactive video creates a larger increase than a passive video.
- [ ] Adding a poll creates a moderate temporary increase.
- [ ] Adding a group activity creates a stronger and longer increase.
- [ ] Adding a break hides the score during the break and creates a partial post-break recovery.
- [ ] The score never resets automatically to 100%.
- [ ] The score begins declining again when lecture resumes.

### Editing behavior

- [ ] Moving an event updates the curve immediately.
- [ ] Resizing an event updates effective passive time and event duration.
- [ ] Deleting an event restores the uninterrupted-lecture decline for that interval.
- [ ] Gaps in the schedule are automatically treated as lecture.
- [ ] Overlapping segments are rejected or resolved explicitly.

### Summary behavior

- [ ] The app calculates average instructional-time attention.
- [ ] Break samples are excluded from the average.
- [ ] The app reports the longest uninterrupted lecture segment.
- [ ] The app reports total interaction time.
- [ ] The app reports the number and spacing of reset events.

### Language and ethics

- [ ] The interface describes the result as an estimate.
- [ ] The interface states that the model does not directly measure individuals.
- [ ] The feature is not used by itself for grading, attendance, discipline, or accommodations.
- [ ] A passive video is not presented as equivalent to active learning.

---

## 14. Unit Test Targets

```ts
// Approximate baseline expectations.
expect(scoreAtUninterruptedMinute(0)).toBeCloseTo(77.5, 0);
expect(scoreAtUninterruptedMinute(10)).toBeCloseTo(67.2, 0);
expect(scoreAtUninterruptedMinute(20)).toBeCloseTo(54.9, 0);
expect(scoreAtUninterruptedMinute(30)).toBeCloseTo(42.0, 0);
expect(scoreAtUninterruptedMinute(50)).toBeCloseTo(34.9, 0);
expect(scoreAtUninterruptedMinute(75)).toBeCloseTo(26.9, 0);
```

Additional tests:

```ts
// A group activity should create a stronger lift than a passive video.
expect(groupActivityLift).toBeGreaterThan(passiveVideoLift);

// A boost should decay after the event ends.
expect(scoreOneMinuteAfterEvent).toBeGreaterThan(
  scoreFiveMinutesAfterEvent
);

// A break should have no displayed score while active.
expect(pointDuringBreak.score).toBeNull();

// The score should remain bounded.
expect(Math.min(...scores)).toBeGreaterThanOrEqual(5);
expect(Math.max(...scores)).toBeLessThanOrEqual(95);

// An uninterrupted lecture should decline monotonically.
for (let index = 1; index < scores.length; index += 1) {
  expect(scores[index]).toBeLessThanOrEqual(scores[index - 1]);
}
```

---

## 15. Future Calibration

The default model should be treated as version 1.0.

Future calibration can use anonymous, course-level data such as:

- voluntary thought probes;
- poll response rates;
- retrieval performance;
- student self-reports;
- course type;
- class size;
- time of day;
- instructional modality;
- repeated observations across the semester.

A later model may estimate separate parameters for:

- course;
- instructor;
- discipline;
- session length;
- in-person versus online instruction;
- first-year versus advanced courses.

Use local data to adjust the prior, not to claim that a student is inattentive.

---

## 16. Research Positioning

The feature is based on several defensible ideas from attention and learning research:

- task-unrelated thought tends to become more common as time-on-task increases;
- there is no universal minute at which attention expires;
- active participation, retrieval, discussion, and task changes can support re-engagement;
- an intervention should be modeled as a partial and temporary lift, not a complete reset;
- passive video is weaker than interactive video;
- attention, engagement, and learning are related but not identical;
- time alone cannot determine the actual state of an individual student.

The equation and event defaults are intended for product prototyping. They should remain configurable and should be recalibrated as better local or experimental data become available.

---

## 17. One-Sentence Coding Brief

> Build a vertical lecture timeline that shows estimated attention gradually declining during uninterrupted presentation, temporarily increasing during activities, videos, discussions, polls, demonstrations, or breaks, and then declining again as passive lecture resumes, using the equations and configurable defaults in this specification.
