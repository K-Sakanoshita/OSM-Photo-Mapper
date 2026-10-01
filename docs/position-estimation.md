# Position Estimation

## Objective

Estimate the location of a photographed real-world feature without requiring AR.

The position estimator should return a candidate position and supporting evidence, not an assertion that the coordinate is correct.

## Inputs

### GPS track

Record continuous position samples during the survey where the browser permits it.

Each sample should include:

- coordinate
- timestamp
- reported accuracy
- speed when available
- heading when available

Using a track rather than a single GPS sample makes it possible to reduce transient GPS jumps and interpolate the mapper's likely position at capture time.

### Capture direction

When device-orientation data is available, associate heading with the photo.

Heading should be treated as uncertain because magnetometer readings can be affected by:

- device calibration
- nearby metal
- buildings
- how the phone is held

### Image-derived direction

Object position inside the image can refine the bearing relative to the camera direction.

For example, an object near the right edge of the image should not be projected along the optical centerline.

### Distance estimate

Image analysis may provide a rough distance estimate.

This should be considered a weak measurement unless a reliable geometric cue is available.

### Multiple observations

If the same object appears in photos taken from different positions, estimate the object location from the intersection / optimization of the observation rays.

This can significantly improve positioning without requiring the user to deliberately perform a two-point measurement.

### Existing OSM data

Query nearby OSM objects matching the likely feature class.

Use existing data for two different purposes:

1. **duplicate detection** — an observation may refer to an already mapped object;
2. **position evidence** — an existing object may be a plausible match.

Do not snap automatically solely because a nearby object has the same tag.

## Suggested scoring model

Each generated feature candidate can keep multiple hypotheses:

```text
Candidate A
  estimated coordinate
  position confidence
  tag confidence
  observations[]
  nearby OSM matches[]
  warnings[]
```

Position confidence and tag confidence should remain separate.

A feature can have:

- high tag confidence but low position confidence;
- low tag confidence but high position confidence.

This distinction should be visible during review.

## Geographic constraints

Feature-specific rules may improve candidate ranking.

Examples:

- playground equipment should normally be inside or near a playground / park;
- a vending machine may plausibly be near a building edge or pedestrian access area;
- a bench should not be blindly snapped onto a carriageway.

These constraints should influence ranking, not silently rewrite coordinates.

## Final authority

The mapper remains responsible for the final location.

Every candidate pin must be draggable before upload.
