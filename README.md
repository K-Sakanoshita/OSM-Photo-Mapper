# OSM Photo Mapper

OSM Photo Mapper is a photo-assisted field mapping tool for OpenStreetMap.

The intended workflow is simple:

1. Walk around and take photos continuously.
2. Record GPS, timestamp, heading, and other available sensor data with each photo.
3. Press **Map photos** after the survey.
4. Analyze the photos to detect map features and suggest OSM tags.
5. Estimate each feature's position from GPS, camera direction, estimated distance, surrounding photos, and nearby OSM data.
6. Review the generated pins on a map and in a list.
7. Drag pins to correct positions and edit tags, including names when needed.
8. Review the complete changeset and upload it to OpenStreetMap.

## Design principles

- **Human review is mandatory.** The app must not silently upload AI-generated edits.
- **Capture first, map later.** Field work should focus on observation and photography rather than editing.
- **One photo is not necessarily one feature.** Multiple photos may refer to the same real-world object, and one photo may contain multiple objects.
- **Reuse existing OSM objects where appropriate.** Nearby OSM data should be checked to avoid duplicates.
- **Location estimation and tag inference are separate concerns.**
- **Unknown is a valid result.** Low-confidence attributes should remain unset rather than guessed.

## Proposed processing pipeline

```text
Photo capture
  |
  +-- GPS / accuracy
  +-- timestamp
  +-- heading
  +-- optional movement track
  |
  v
Batch analysis
  |
  +-- feature detection
  +-- OSM tag suggestions
  +-- same-object grouping across photos
  +-- distance / direction estimation
  +-- nearby OSM lookup
  |
  v
Candidate map features
  |
  +-- estimated position
  +-- suggested tags
  +-- duplicate / existing-object candidate
  +-- confidence / review flags
  |
  v
Human review
  |
  +-- map pin dragging
  +-- tag editing
  +-- name entry
  +-- exclude false positives
  |
  v
OSM changeset upload
```

## MVP scope

The first version should focus on visually identifiable, node-oriented POIs such as:

- benches
- vending machines
- playground equipment
- information boards
- drinking water
- toilets
- AEDs
- bicycle parking
- waste baskets

The MVP should not attempt to automatically map complex geometry, routes, boundaries, or relations.

## Planned technology direction

- PWA / mobile-first web application
- MapLibre GL JS
- Geolocation API and continuous GPS track recording
- Device orientation where available
- IndexedDB for local survey storage
- server-side image analysis
- OpenStreetMap API with OAuth for reviewed uploads

The exact image-analysis API is intentionally kept behind an abstraction so that the implementation is not tightly coupled to one provider.

## Status

Early design / prototype stage.
